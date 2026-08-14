"""生产协同中心 — 报工 API（针对排产计划报工 → 虚拟仓 → 自动日报草稿）"""

import json
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func, update, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.models.basicdata.warehouse import Warehouse
from app.models.production.schedule_plan import ProductionSchedulePlan
from app.models.production.product_process_capacity import ProductProcessCapacity, parse_capacity_metadata
from app.models.production.production_report import ProductionReport
from app.models.production.workshop_daily_report import WorkshopDailyReport, WorkshopDailyReportTask
from app.schemas.common import ResponseModel, PageResult

router = APIRouter()

# 虚拟仓 code 前缀（报工入库限定 manual 仓）
VIRTUAL_WH_CODE_PREFIX = "M"


class ReportCreate(BaseModel):
    schedule_plan_id: int
    report_date: date
    report_qty: float = Field(..., gt=0)
    warehouse_id: int
    work_hours: float | None = None
    team: str | None = None
    remark: str | None = None


class ReportOut(BaseModel):
    id: int
    schedule_plan_id: int
    report_date: date | None = None
    department: str | None = None
    order_no: str | None = None
    product_code: str | None = None
    process_type: str | None = None
    report_qty: float | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    work_hours: float | None = None
    unit_price: float | None = None
    amount: float | None = None
    planned_qty: float | None = None
    is_overflow: bool = False
    reporter: str | None = None
    team: str | None = None
    remark: str | None = None
    reported_at: datetime | None = None

    model_config = {"from_attributes": True}


def _find_wage_rate(capacity: ProductProcessCapacity | None) -> float | None:
    """从产能记录元数据取工价 gjje"""
    if capacity is None:
        return None
    meta = parse_capacity_metadata(capacity.remark)
    gjje = meta.get("gjje")
    try:
        return round(float(gjje), 4) if gjje else None
    except (TypeError, ValueError):
        return None


async def _get_wage_for_plan(db: AsyncSession, plan: ProductionSchedulePlan) -> float | None:
    """按产品取工价：精益计划取该产品精益车间全部 gjje 之和；其他按工序匹配。"""
    if not plan.product_code:
        return None
    stmt = select(ProductProcessCapacity).where(
        ProductProcessCapacity.product_code == plan.product_code
    )
    caps = (await db.execute(stmt)).scalars().all()
    if not caps:
        return None

    if plan.source_process_type == "lean":
        # 精益：取精益车间记录 gjje 之和（与精益综合UPPH口径一致）
        total = 0.0
        for cap in caps:
            meta = parse_capacity_metadata(cap.remark)
            if meta.get("oa_workshop_name") == "精益车间":
                try:
                    total += float(meta.get("gjje") or 0)
                except (TypeError, ValueError):
                    pass
        return round(total, 4) if total > 0 else None

    # 其他：按工序匹配
    for cap in caps:
        if cap.process_type == plan.source_process_type:
            return _find_wage_rate(cap)
    return None


async def _update_inventory(db: AsyncSession, plan: ProductionSchedulePlan, wh: Warehouse, qty: float):
    """报工入库：写 scm_inventory（manual 行，ERP 不覆盖）"""
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from app.models.basicdata.inventory import Inventory

    stmt = pg_insert(Inventory).values(
        material_id=0,
        material_code=plan.product_code or "",
        material_name="",
        wh_id=wh.wh_id or 0,
        wh_code=wh.wh_code,
        wh_name=wh.wh_name,
        location_id=None,
        qty_on_hand=qty,
        locked_qty=0,
        balance_qty=qty,
        qty_in_transit=0,
        unit_price=0,
        data_source="manual",
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[Inventory.material_id, Inventory.wh_id, Inventory.location_id],
        set_={
            "qty_on_hand": Inventory.qty_on_hand + qty,
            "balance_qty": Inventory.balance_qty + qty,
            "updated_at": func.now(),
        },
    )
    await db.execute(stmt)


@router.get("/virtual-warehouses", response_model=ResponseModel[list])
async def list_virtual_warehouses(
    current_user: dict = Depends(PermissionChecker("production.daily_report", "read")),
    db: AsyncSession = Depends(get_db),
):
    """报工可选虚拟仓（线边仓/成品仓，data_source=manual）"""
    stmt = select(Warehouse).where(
        Warehouse.data_source == "manual",
        Warehouse.is_deleted == 0,
        Warehouse.is_enabled == 1,
    ).order_by(Warehouse.id)
    rows = (await db.execute(stmt)).scalars().all()
    return ResponseModel(data=[
        {"id": w.id, "wh_code": w.wh_code, "wh_name": w.wh_name} for w in rows
    ])


@router.get("/plans", response_model=ResponseModel[PageResult[dict]])
async def list_reportable_plans(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    report_date: date | None = Query(None, description="报工日期(默认今天，筛该日计划)"),
    keyword: str | None = Query(None, description="订单号/产品编码搜索"),
    department: str | None = Query(None),
    current_user: dict = Depends(PermissionChecker("production.daily_report", "read")),
    db: AsyncSession = Depends(get_db),
):
    """可报工的排产计划：默认今天 + 未完成（completed<planned），按日期升序最近优先"""
    filters = [ProductionSchedulePlan.is_active == True, ProductionSchedulePlan.status == "planned"]
    target_date = report_date or date.today()
    filters.append(ProductionSchedulePlan.plan_date == target_date)
    # 未完成：completed_qty < planned_qty（含 planned_qty 为空时视为未完成）
    filters.append(
        or_(
            ProductionSchedulePlan.completed_qty.is_(None),
            ProductionSchedulePlan.planned_qty.is_(None),
            ProductionSchedulePlan.completed_qty < ProductionSchedulePlan.planned_qty,
        )
    )
    if department:
        filters.append(ProductionSchedulePlan.department == department)
    if keyword:
        like = f"%{keyword}%"
        filters.append(or_(
            ProductionSchedulePlan.order_no.ilike(like),
            ProductionSchedulePlan.product_code.ilike(like),
        ))
    total = (await db.execute(
        select(func.count()).select_from(ProductionSchedulePlan).where(*filters)
    )).scalar()
    stmt = (
        select(ProductionSchedulePlan)
        .where(*filters)
        .order_by(ProductionSchedulePlan.plan_date.asc(), ProductionSchedulePlan.department, ProductionSchedulePlan.id.asc())
        .offset((page - 1) * page_size).limit(page_size)
    )
    rows = (await db.execute(stmt)).scalars().all()
    items = [{
        "id": p.id,
        "department": p.department,
        "plan_date": p.plan_date,
        "order_no": p.order_no,
        "product_code": p.product_code,
        "model_code": p.model_code,
        "quantity": float(p.quantity) if p.quantity else 0,
        "planned_qty": float(p.planned_qty) if p.planned_qty else 0,
        "completed_qty": float(p.completed_qty) if p.completed_qty else 0,
        "process_type": p.source_process_type,
        "start_date": p.start_date,
        "end_date": p.end_date,
        "upph": float(p.upph) if p.upph else 0,
    } for p in rows]
    return ResponseModel(data=PageResult(total=total or 0, page=page, page_size=page_size, items=items))


@router.post("", response_model=ResponseModel[ReportOut])
async def create_report(
    payload: ReportCreate,
    current_user: dict = Depends(PermissionChecker("production.daily_report", "create")),
    db: AsyncSession = Depends(get_db),
):
    """报工录入：选排产计划→报量→选仓→保存。工价快照，超额标记。"""
    plan = (await db.execute(
        select(ProductionSchedulePlan).where(ProductionSchedulePlan.id == payload.schedule_plan_id)
    )).scalar_one_or_none()
    if plan is None:
        raise HTTPException(status_code=404, detail="排产计划不存在")

    wh = (await db.execute(
        select(Warehouse).where(Warehouse.id == payload.warehouse_id)
    )).scalar_one_or_none()
    if wh is None or wh.data_source != "manual":
        raise HTTPException(status_code=400, detail="入库仓必须是虚拟仓(线边仓/成品仓)")

    unit_price = await _get_wage_for_plan(db, plan)
    amount = round(payload.report_qty * (unit_price or 0), 2) if unit_price else None
    planned_qty = float(plan.planned_qty or plan.quantity or 0)
    is_overflow = payload.report_qty > planned_qty

    record = ProductionReport(
        schedule_plan_id=plan.id,
        report_date=payload.report_date,
        department=plan.department,
        order_no=plan.order_no,
        line_no=plan.line_no,
        product_code=plan.product_code,
        process_type=plan.source_process_type,
        report_qty=payload.report_qty,
        warehouse_id=wh.id,
        warehouse_name=wh.wh_name,
        work_hours=payload.work_hours,
        unit_price=unit_price,
        amount=amount,
        planned_qty=planned_qty,
        is_overflow=is_overflow,
        reporter=current_user.get("username"),
        team=payload.team,
        remark=payload.remark,
        reported_at=datetime.now(),
    )
    db.add(record)

    # 更新排产计划累计完成量（Q20）
    plan.completed_qty = round(float(plan.completed_qty or 0) + float(payload.report_qty), 2)

    # 入虚拟仓库存
    await _update_inventory(db, plan, wh, payload.report_qty)

    await db.flush()
    await db.refresh(record)
    return ResponseModel(data=ReportOut.model_validate(record))


@router.get("", response_model=ResponseModel[PageResult[ReportOut]])
async def list_reports(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    report_date_from: date | None = Query(None),
    report_date_to: date | None = Query(None),
    keyword: str | None = Query(None),
    current_user: dict = Depends(PermissionChecker("production.daily_report", "read")),
    db: AsyncSession = Depends(get_db),
):
    """报工记录查询（追溯）"""
    filters = []
    if report_date_from:
        filters.append(ProductionReport.report_date >= report_date_from)
    if report_date_to:
        filters.append(ProductionReport.report_date <= report_date_to)
    if keyword:
        like = f"%{keyword}%"
        filters.append(or_(
            ProductionReport.order_no.ilike(like),
            ProductionReport.product_code.ilike(like),
            ProductionReport.warehouse_name.ilike(like),
        ))
    total = (await db.execute(
        select(func.count()).select_from(ProductionReport).where(*filters)
    )).scalar()
    stmt = (
        select(ProductionReport)
        .where(*filters)
        .order_by(ProductionReport.report_date.desc(), ProductionReport.id.desc())
        .offset((page - 1) * page_size).limit(page_size)
    )
    rows = (await db.execute(stmt)).scalars().all()
    items = [ReportOut.model_validate(r) for r in rows]
    return ResponseModel(data=PageResult(total=total or 0, page=page, page_size=page_size, items=items))


# ============ 日报草稿自动生成 ============

@router.get("/daily-report-draft", response_model=ResponseModel[dict])
async def generate_daily_report_draft(
    report_date: date = Query(...),
    department: str | None = Query(None),
    current_user: dict = Depends(PermissionChecker("production.daily_report", "read")),
    db: AsyncSession = Depends(get_db),
):
    """按 车间+日期 汇总报工，生成日报草稿（auto 标记，人工确认后转正式）"""
    filters = [ProductionReport.report_date == report_date]
    if department:
        filters.append(ProductionReport.department == department)
    rows = (await db.execute(
        select(ProductionReport).where(*filters).order_by(ProductionReport.department, ProductionReport.id)
    )).scalars().all()
    if not rows:
        raise HTTPException(status_code=404, detail="该日期无报工记录，无法生成日报")

    # 按 车间+产品 聚合
    groups: dict[tuple, dict] = {}
    for r in rows:
        key = (r.department or "", r.product_code or "")
        g = groups.setdefault(key, {
            "department": r.department,
            "product_code": r.product_code,
            "qty": 0.0,
            "amount": 0.0,
            "reports": 0,
        })
        g["qty"] += float(r.report_qty or 0)
        g["amount"] += float(r.amount or 0)
        g["reports"] += 1

    summary = [{
        "department": g["department"],
        "product_code": g["product_code"],
        "completed_qty": round(g["qty"], 2),
        "amount": round(g["amount"], 2),
        "report_count": g["reports"],
    } for g in groups.values()]

    total_qty = round(sum(g["qty"] for g in groups.values()), 2)
    total_amount = round(sum(g["amount"] for g in groups.values()), 2)

    # 检查是否已有该日期+车间的正式日报
    exist_stmt = select(WorkshopDailyReport.id).where(
        WorkshopDailyReport.report_date == report_date
    )
    if department:
        exist_stmt = exist_stmt.where(WorkshopDailyReport.workshop == department)
    existing = (await db.execute(exist_stmt)).scalar_one_or_none()

    return ResponseModel(data={
        "report_date": report_date,
        "department": department,
        "draft": summary,
        "total_qty": total_qty,
        "total_amount": total_amount,
        "existing_daily_report_id": existing,
        "note": "此为报工自动汇总草稿，需人工确认后写入正式日报",
    })
