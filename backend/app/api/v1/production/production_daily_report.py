"""生产协同中心 — 生产日报表 API（ERP/OA 同步 + 手工录入）"""

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional
from datetime import date
from uuid import uuid4

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.models.production.production_daily_report import ProductionDailyReport
from app.schemas.common import ResponseModel, PageResult
from app.schemas.production.schemas import (
    ProductionDailyReportOut,
    ProductionDailyReportCreate,
    ProductionDailyReportUpdate,
)

router = APIRouter()


@router.get("", response_model=ResponseModel[PageResult[ProductionDailyReportOut]])
async def list_daily_reports(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    report_date_from: Optional[date] = Query(None, description="日期起"),
    report_date_to: Optional[date] = Query(None, description="日期止"),
    workshop: Optional[str] = Query(None, description="车间筛选"),
    keyword: Optional[str] = Query(None, description="生产订单号/销售订单号/物料代码模糊搜索"),
    current_user: dict = Depends(PermissionChecker("production.daily_report", "read")),
    db: AsyncSession = Depends(get_db),
):
    filters = []
    if report_date_from:
        filters.append(ProductionDailyReport.report_date >= report_date_from)
    if report_date_to:
        filters.append(ProductionDailyReport.report_date <= report_date_to)
    if workshop:
        filters.append(ProductionDailyReport.workshop == workshop)
    if keyword:
        like = f"%{keyword}%"
        filters.append(
            or_(
                ProductionDailyReport.production_order_no.ilike(like),
                ProductionDailyReport.sale_order_no.ilike(like),
                ProductionDailyReport.material_code.ilike(like),
            )
        )

    count_stmt = select(func.count()).select_from(ProductionDailyReport)
    if filters:
        count_stmt = count_stmt.where(*filters)
    total = (await db.execute(count_stmt)).scalar()

    query = (
        select(ProductionDailyReport)
        .where(*filters)
        .order_by(
            ProductionDailyReport.report_date.desc().nullslast(),
            ProductionDailyReport.id.desc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    result = await db.execute(query)
    items = [ProductionDailyReportOut.model_validate(r) for r in result.scalars().all()]

    return ResponseModel(data=PageResult(total=total or 0, page=page, page_size=page_size, items=items))


def _manual_row(payload: ProductionDailyReportCreate) -> ProductionDailyReport:
    """构造手工录入行：data_source=manual，oa_id 使用防冲突的本地唯一键，
    与 ERP 同步键 (oa_id) 隔离，且不会被 _bulk_upsert 覆盖。"""
    return ProductionDailyReport(
        oa_id=f"manual-{uuid4().hex}",
        oa_detail_id=None,
        report_date=payload.report_date,
        sale_order_no=payload.sale_order_no,
        production_order_no=payload.production_order_no,
        specification=payload.specification,
        bom_no=payload.bom_no,
        material_code=payload.material_code,
        process=payload.process,
        color=payload.color,
        completed_qty=payload.completed_qty,
        workshop=payload.workshop,
        work_hours=payload.work_hours,
        total_wages=payload.total_wages,
        data_source="manual",
    )


@router.post("", response_model=ResponseModel[ProductionDailyReportOut])
async def create_daily_report(
    payload: ProductionDailyReportCreate,
    current_user: dict = Depends(PermissionChecker("production.daily_report", "create")),
    db: AsyncSession = Depends(get_db),
):
    """新增一条手工日报记录"""
    row = _manual_row(payload)
    db.add(row)
    await db.flush()
    await db.refresh(row)
    return ResponseModel(data=ProductionDailyReportOut.model_validate(row))


@router.post("/batch", response_model=ResponseModel[list])
async def create_daily_reports_batch(
    payload: list[ProductionDailyReportCreate],
    current_user: dict = Depends(PermissionChecker("production.daily_report", "create")),
    db: AsyncSession = Depends(get_db),
):
    """批量新增手工日报记录（同一表单多行一次提交）"""
    if not payload:
        return ResponseModel(data=[])
    rows = [_manual_row(p) for p in payload]
    db.add_all(rows)
    await db.flush()
    for r in rows:
        await db.refresh(r)
    return ResponseModel(data=[ProductionDailyReportOut.model_validate(r) for r in rows])


@router.put("/{report_id}", response_model=ResponseModel[ProductionDailyReportOut])
async def update_daily_report(
    report_id: int,
    payload: ProductionDailyReportUpdate,
    current_user: dict = Depends(PermissionChecker("production.daily_report", "update")),
    db: AsyncSession = Depends(get_db),
):
    """更新手工录入的日报记录（ERP 同步行禁止编辑）"""
    result = await db.execute(select(ProductionDailyReport).where(ProductionDailyReport.id == report_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="日报记录不存在")
    if row.data_source != "manual":
        raise HTTPException(status_code=400, detail="仅手工录入的日报记录允许编辑")

    update_data = payload.model_dump(exclude_unset=True)
    for k, v in update_data.items():
        setattr(row, k, v)
    await db.flush()
    await db.refresh(row)
    return ResponseModel(data=ProductionDailyReportOut.model_validate(row))


@router.delete("/{report_id}", response_model=ResponseModel[dict])
async def delete_daily_report(
    report_id: int,
    current_user: dict = Depends(PermissionChecker("production.daily_report", "delete")),
    db: AsyncSession = Depends(get_db),
):
    """删除手工录入的日报记录（ERP 同步行禁止删除）"""
    result = await db.execute(select(ProductionDailyReport).where(ProductionDailyReport.id == report_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="日报记录不存在")
    if row.data_source != "manual":
        raise HTTPException(status_code=400, detail="仅手工录入的日报记录允许删除")

    await db.delete(row)
    await db.flush()
    return ResponseModel(data={"id": report_id})
