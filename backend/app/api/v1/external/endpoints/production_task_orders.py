"""生产任务单对外接口

为外部系统定制的 OA 生产任务单查询接口。基于 ProductionTaskOrder 表。
支持分页、关键字、车间、类型、状态、增量同步。
"""
from datetime import date, datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.production.production_task_order import ProductionTaskOrder
from app.schemas.common import ResponseModel

from ..common import ExternalPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="/production-task-orders", tags=["生产"])


class TaskOrdersListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（任务单号 / 物料名称 模糊匹配）")
    workshop: Optional[str] = Field(None, description="生产车间精确匹配")
    task_type: Optional[str] = Field(None, description="类型精确匹配")
    is_closed: Optional[int] = Field(None, description="是否关闭 0/1")
    audit_status: Optional[int] = Field(None, description="审核状态 0=未审核 1=已审核")
    mrp_flag: Optional[int] = Field(None, description="MRP 标志 0/1")
    sale_order_no: Optional[str] = Field(None, description="销售订单号精确匹配")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间的记录（ISO 8601）")


class TaskOrderOut(BaseModel):
    """生产任务单（对外精简字段集）"""
    id: int = Field(..., description="主键")
    task_id: Optional[int] = Field(None, description="OA 任务单 ID")
    task_no: Optional[str] = Field(None, description="任务单号")
    workshop: Optional[str] = Field(None, description="车间")
    material_code: Optional[str] = Field(None, description="物料编码")
    material_name: Optional[str] = Field(None, description="物料名称")
    planned_start_date: Optional[date] = Field(None, description="计划开始日期")
    planned_end_date: Optional[date] = Field(None, description="计划结束日期")
    actual_start_date: Optional[date] = Field(None, description="实际开始日期")
    actual_end_date: Optional[date] = Field(None, description="实际结束日期")
    task_qty: Optional[float] = Field(None, description="任务数量")
    repair_qty: Optional[float] = Field(None, description="返修数量")
    actual_qty: Optional[float] = Field(None, description="实际完成数量")
    task_type: Optional[str] = Field(None, description="类型")
    sale_order_no: Optional[str] = Field(None, description="销售订单号")
    sale_order_id: Optional[int] = Field(None, description="销售订单 id")
    start_flag: Optional[int] = Field(None, description="开工标志")
    is_closed: Optional[int] = Field(None, description="是否关闭")
    audit_status: Optional[int] = Field(None, description="审核状态 0=未审核 1=已审核")
    mrp_flag: Optional[int] = Field(None, description="MRP 标志")
    audit_user_id: Optional[int] = Field(None, description="审核人 id")
    request_user_id: Optional[int] = Field(None, description="申请人 id")
    supplier_id: Optional[int] = Field(None, description="供应商 id")
    erp_updated_at: Optional[datetime] = Field(None, description="ERP 侧更新时间")
    updated_at: Optional[datetime] = Field(None, description="更新时间（增量同步锚点）")


@router.get("/list", response_model=ResponseModel[ExternalPage[TaskOrderOut]],
            summary="生产任务单列表", description="endpoint_code: production_task_orders.list")
@register_external(
    "production_task_orders.list", "生产任务单列表", method="GET", path="/production-task-orders/list",
    description="OA 生产任务单列表查询，支持关键字、车间、类型、状态、增量同步",
    tags=["生产"],
)
@log_external_call("production_task_orders.list")
async def production_task_orders_list(
    request: Request,
    q: Annotated[TaskOrdersListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("production_task_orders.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(ProductionTaskOrder)
    count_query = select(func.count()).select_from(ProductionTaskOrder)

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            ProductionTaskOrder.task_no.ilike(like_expr),
            ProductionTaskOrder.material_name.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.workshop:
        query = query.where(ProductionTaskOrder.workshop == q.workshop)
        count_query = count_query.where(ProductionTaskOrder.workshop == q.workshop)

    if q.task_type:
        query = query.where(ProductionTaskOrder.task_type == q.task_type)
        count_query = count_query.where(ProductionTaskOrder.task_type == q.task_type)

    if q.is_closed is not None:
        query = query.where(ProductionTaskOrder.is_closed == q.is_closed)
        count_query = count_query.where(ProductionTaskOrder.is_closed == q.is_closed)

    if q.audit_status is not None:
        query = query.where(ProductionTaskOrder.audit_status == q.audit_status)
        count_query = count_query.where(ProductionTaskOrder.audit_status == q.audit_status)

    if q.mrp_flag is not None:
        query = query.where(ProductionTaskOrder.mrp_flag == q.mrp_flag)
        count_query = count_query.where(ProductionTaskOrder.mrp_flag == q.mrp_flag)

    if q.sale_order_no:
        query = query.where(ProductionTaskOrder.sale_order_no == q.sale_order_no)
        count_query = count_query.where(ProductionTaskOrder.sale_order_no == q.sale_order_no)

    if q.updated_after:
        query = query.where(ProductionTaskOrder.updated_at >= q.updated_after)
        count_query = count_query.where(ProductionTaskOrder.updated_at >= q.updated_after)

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(ProductionTaskOrder.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).scalars().all()

    items = [{
        "id": r.id,
        "task_id": r.task_id,
        "task_no": r.task_no,
        "workshop": r.workshop,
        "material_code": r.material_code,
        "material_name": r.material_name,
        "planned_start_date": r.planned_start_date.isoformat() if r.planned_start_date else None,
        "planned_end_date": r.planned_end_date.isoformat() if r.planned_end_date else None,
        "actual_start_date": r.actual_start_date.isoformat() if r.actual_start_date else None,
        "actual_end_date": r.actual_end_date.isoformat() if r.actual_end_date else None,
        "task_qty": float(r.task_qty) if r.task_qty is not None else None,
        "repair_qty": float(r.repair_qty) if r.repair_qty is not None else None,
        "actual_qty": float(r.actual_qty) if r.actual_qty is not None else None,
        "task_type": r.task_type,
        "sale_order_no": r.sale_order_no,
        "sale_order_id": r.sale_order_id,
        "start_flag": r.start_flag,
        "is_closed": r.is_closed,
        "audit_status": r.audit_status,
        "mrp_flag": r.mrp_flag,
        "audit_user_id": r.audit_user_id,
        "request_user_id": r.request_user_id,
        "supplier_id": r.supplier_id,
        "erp_updated_at": r.erp_updated_at.isoformat() if r.erp_updated_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}
