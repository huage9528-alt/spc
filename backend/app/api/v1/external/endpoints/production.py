"""生产对外接口

为外部系统（如 MES / 报工系统）提供生产排产计划查询。
基于 ProductionSchedulePlan 表（按 department + plan_date + order_no + product_code 组织）。
默认只返回当前生效版本（is_active = True）。
"""

from datetime import date, datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.production.schedule_plan import ProductionSchedulePlan
from app.schemas.common import ResponseModel

from ..common import ExternalPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="/schedule-plans", tags=["生产"])


class SchedulePlansListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（订单号 / 产品编码 / 型号 模糊匹配）")
    department: Optional[str] = Field(None, description="部门精确匹配")
    status: Optional[str] = Field(None, description="计划状态，多选逗号分隔，如 planned,confirmed")
    order_no: Optional[str] = Field(None, description="订单号精确匹配")
    product_code: Optional[str] = Field(None, description="产品编码精确匹配")
    plan_date_start: Optional[date] = Field(None, description="排产日期范围起 YYYY-MM-DD")
    plan_date_end: Optional[date] = Field(None, description="排产日期范围止 YYYY-MM-DD")
    include_inactive: Optional[str] = Field(None, description="是否包含历史版本，1/true 为是；默认只返回生效版本")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间的记录（ISO 8601）")


class SchedulePlanOut(BaseModel):
    """生产排产计划（对外精简字段集）"""
    id: int = Field(..., description="主键")
    department: Optional[str] = Field(None, description="部门/车间")
    plan_date: Optional[date] = Field(None, description="排产日期")
    order_no: Optional[str] = Field(None, description="订单号")
    line_no: Optional[str] = Field(None, description="行号")
    product_code: Optional[str] = Field(None, description="产品编码")
    model_code: Optional[str] = Field(None, description="产品型号")
    quantity: Optional[float] = Field(None, description="排产数量")
    owner: Optional[str] = Field(None, description="负责人")
    start_date: Optional[date] = Field(None, description="计划开始日期")
    end_date: Optional[date] = Field(None, description="计划结束日期")
    priority: Optional[str] = Field(None, description="优先级")
    status: Optional[str] = Field(None, description="计划状态")
    upph: Optional[float] = Field(None, description="UPPH 人均时产量")
    plan_version: Optional[int] = Field(None, description="计划版本")
    is_active: Optional[bool] = Field(None, description="是否当前生效版本")
    confirmed_by: Optional[str] = Field(None, description="确认人")
    confirmed_at: Optional[datetime] = Field(None, description="确认时间")
    updated_at: Optional[datetime] = Field(None, description="更新时间（增量同步锚点）")


@router.get("/list", response_model=ResponseModel[ExternalPage[SchedulePlanOut]],
            summary="生产排产计划列表", description="endpoint_code: schedule_plans.list")
@register_external(
    "schedule_plans.list", "生产排产计划列表", method="GET", path="/schedule-plans/list",
    description="生产排产计划列表查询，支持关键字、部门、状态、订单号、排产日期范围、增量同步（默认只返回生效版本）",
    tags=["生产"],
)
@log_external_call("schedule_plans.list")
async def schedule_plans_list(
    request: Request,
    q: Annotated[SchedulePlansListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("schedule_plans.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    include_inactive = q.include_inactive in ("1", "true", "True")

    query = select(ProductionSchedulePlan)
    count_query = select(func.count()).select_from(ProductionSchedulePlan)
    if not include_inactive:
        query = query.where(ProductionSchedulePlan.is_active == True)
        count_query = count_query.where(ProductionSchedulePlan.is_active == True)

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            ProductionSchedulePlan.order_no.ilike(like_expr),
            ProductionSchedulePlan.product_code.ilike(like_expr),
            ProductionSchedulePlan.model_code.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.department:
        query = query.where(ProductionSchedulePlan.department == q.department)
        count_query = count_query.where(ProductionSchedulePlan.department == q.department)

    if q.status:
        statuses = [s.strip() for s in q.status.split(",") if s.strip()]
        if len(statuses) == 1:
            query = query.where(ProductionSchedulePlan.status == statuses[0])
            count_query = count_query.where(ProductionSchedulePlan.status == statuses[0])
        elif statuses:
            query = query.where(ProductionSchedulePlan.status.in_(statuses))
            count_query = count_query.where(ProductionSchedulePlan.status.in_(statuses))

    if q.order_no:
        query = query.where(ProductionSchedulePlan.order_no == q.order_no)
        count_query = count_query.where(ProductionSchedulePlan.order_no == q.order_no)

    if q.product_code:
        query = query.where(ProductionSchedulePlan.product_code == q.product_code)
        count_query = count_query.where(ProductionSchedulePlan.product_code == q.product_code)

    if q.plan_date_start:
        query = query.where(ProductionSchedulePlan.plan_date >= q.plan_date_start)
        count_query = count_query.where(ProductionSchedulePlan.plan_date >= q.plan_date_start)
    if q.plan_date_end:
        query = query.where(ProductionSchedulePlan.plan_date <= q.plan_date_end)
        count_query = count_query.where(ProductionSchedulePlan.plan_date <= q.plan_date_end)

    if q.updated_after:
        query = query.where(ProductionSchedulePlan.updated_at >= q.updated_after)
        count_query = count_query.where(ProductionSchedulePlan.updated_at >= q.updated_after)

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(
            ProductionSchedulePlan.plan_date.desc(),
            ProductionSchedulePlan.id.desc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).scalars().all()

    items = [{
        "id": r.id,
        "department": r.department,
        "plan_date": r.plan_date.isoformat() if r.plan_date else None,
        "order_no": r.order_no,
        "line_no": r.line_no,
        "product_code": r.product_code,
        "model_code": r.model_code,
        "quantity": float(r.quantity) if r.quantity is not None else None,
        "owner": r.owner,
        "start_date": r.start_date.isoformat() if r.start_date else None,
        "end_date": r.end_date.isoformat() if r.end_date else None,
        "priority": r.priority,
        "status": r.status,
        "upph": float(r.upph) if r.upph is not None else None,
        "plan_version": r.plan_version,
        "is_active": r.is_active,
        "confirmed_by": r.confirmed_by,
        "confirmed_at": r.confirmed_at.isoformat() if r.confirmed_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}
