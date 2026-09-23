"""齐套结果 / 缺料明细 / 需求对象 对外接口（AEOS 只读接入）"""

from datetime import date, datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.material.kitting import KittingResult, KittingShortage
from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.schemas.common import ResponseModel
from app.services.material.kitting_calc_service import (
    KITTING_RESULT_SYNC_TYPES,
    freshness_of,
    load_source_as_of,
    min_as_of,
)

from ..common import ExternalDataPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="/material-kitting", tags=["物料齐套"])


async def _page_meta(db: AsyncSession) -> dict:
    source_as_of = await load_source_as_of(db, KITTING_RESULT_SYNC_TYPES)
    data_as_of = min_as_of(source_as_of)
    confidence, stale = freshness_of(data_as_of)
    return {
        "data_as_of": data_as_of.isoformat() if data_as_of else None,
        "data_confidence": confidence,
        "stale": stale,
    }


class KittingResultsQuery(PageParamsMixin):
    demand_type: Optional[str] = Field(None, description="需求对象类型，v1 仅 SALES_ORDER")
    demand_no: Optional[str] = Field(None, description="需求对象编号（订单号）精确匹配")
    demand_line_no: Optional[str] = Field(None, description="需求对象行号精确匹配")
    kit_status: Optional[str] = Field(None, description="齐套状态，逗号分隔多选：FULL/PARTIAL/SHORTAGE/BLOCKED/PENDING")
    risk_level: Optional[str] = Field(None, description="风险等级，逗号分隔多选：green/yellow/red")
    required_date_start: Optional[date] = Field(None, description="需求日期起 YYYY-MM-DD（含）")
    required_date_end: Optional[date] = Field(None, description="需求日期止 YYYY-MM-DD（含）")
    allocation_run_id: Optional[str] = Field(None, description="计算批次 ID 精确匹配")
    is_deleted: Optional[bool] = Field(None, description="是否返回已删除结果（默认仅未删除）")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间（ISO 8601）")
    request_id: Optional[str] = Field(None, description="调用方请求 ID（回显）")


class KittingResultOut(BaseModel):
    demand_type: str
    demand_no: str
    demand_line_no: Optional[str] = None
    customer_code: Optional[str] = None
    product_code: Optional[str] = None
    required_date: Optional[date] = None
    kit_status: str
    kit_rate_by_item: Optional[float] = None
    kit_rate_by_qty: Optional[float] = None
    estimated_kit_date: Optional[date] = None
    shortage_item_count: int
    shortage_amount: Optional[float] = None
    affected_order_amount: Optional[float] = None
    risk_level: Optional[str] = None
    key_material_shortage: int
    bom_id: Optional[str] = None
    bom_version: Optional[str] = None
    allocation_run_id: str
    calculation_version: str
    calculated_at: Optional[datetime] = None
    data_as_of: Optional[datetime] = None
    expired: bool = False
    updated_at: Optional[datetime] = None
    is_deleted: int = 0


@router.get("/results", response_model=ResponseModel[ExternalDataPage[KittingResultOut]],
            summary="齐套结果列表", description="endpoint_code: kitting.results")
@register_external(
    "kitting.results", "齐套结果列表", method="GET", path="/material-kitting/results",
    description="销售订单行齐套结果（状态/齐套率/预计齐套日期/缺料汇总），支持增量同步",
    tags=["物料齐套"],
)
@log_external_call("kitting.results")
async def kitting_results_list(
    request: Request,
    q: Annotated[KittingResultsQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("kitting.results")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)
    meta = await _page_meta(db)

    query = select(KittingResult)
    count_query = select(func.count()).select_from(KittingResult)
    conditions = []
    if q.demand_type:
        conditions.append(KittingResult.demand_type == q.demand_type)
    if q.demand_no:
        conditions.append(KittingResult.demand_no == q.demand_no)
    if q.demand_line_no:
        conditions.append(KittingResult.demand_line_no == q.demand_line_no)
    if q.kit_status:
        conditions.append(KittingResult.kit_status.in_([s.strip() for s in q.kit_status.split(",") if s.strip()]))
    if q.risk_level:
        conditions.append(KittingResult.risk_level.in_([s.strip() for s in q.risk_level.split(",") if s.strip()]))
    if q.required_date_start:
        conditions.append(KittingResult.required_date >= q.required_date_start)
    if q.required_date_end:
        conditions.append(KittingResult.required_date <= q.required_date_end)
    if q.allocation_run_id:
        conditions.append(KittingResult.allocation_run_id == q.allocation_run_id)
    conditions.append(KittingResult.is_deleted == (1 if q.is_deleted else 0))
    if q.updated_after:
        conditions.append(KittingResult.updated_at >= q.updated_after)
    for cond in conditions:
        query = query.where(cond)
        count_query = count_query.where(cond)

    total = (await db.execute(count_query)).scalar() or 0
    rows = (
        await db.execute(
            query.order_by(KittingResult.updated_at.desc(), KittingResult.id.asc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).scalars().all()

    items = [
        {
            "demand_type": r.demand_type,
            "demand_no": r.demand_no,
            "demand_line_no": r.demand_line_no,
            "customer_code": r.customer_code,
            "product_code": r.product_code,
            "required_date": r.required_date,
            "kit_status": r.kit_status,
            "kit_rate_by_item": float(r.kit_rate_by_item) if r.kit_rate_by_item is not None else None,
            "kit_rate_by_qty": float(r.kit_rate_by_qty) if r.kit_rate_by_qty is not None else None,
            "estimated_kit_date": r.estimated_kit_date,
            "shortage_item_count": r.shortage_item_count,
            "shortage_amount": float(r.shortage_amount) if r.shortage_amount is not None else None,
            "affected_order_amount": float(r.affected_order_amount) if r.affected_order_amount is not None else None,
            "risk_level": r.risk_level,
            "key_material_shortage": r.key_material_shortage,
            "bom_id": r.bom_id,
            "bom_version": r.bom_version,
            "allocation_run_id": r.allocation_run_id,
            "calculation_version": r.calculation_version,
            "calculated_at": r.calculated_at,
            "data_as_of": r.data_as_of,
            "expired": bool(meta["stale"]),
            "updated_at": r.updated_at,
            "is_deleted": r.is_deleted,
        }
        for r in rows
    ]
    return {"items": items, "total": total, "page": page, "page_size": page_size, **meta, "request_id": q.request_id}


class KittingShortagesQuery(PageParamsMixin):
    demand_no: Optional[str] = Field(None, description="需求对象编号（订单号）精确匹配")
    material_code: Optional[str] = Field(None, description="物料编码精确匹配")
    is_key_material: Optional[bool] = Field(None, description="仅关键料缺料")
    alert_status: Optional[str] = Field(None, description="预警状态，逗号分隔多选（v1 恒 OPEN）")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间（ISO 8601）")
    is_deleted: Optional[bool] = Field(None, description="是否返回已删除结果（默认仅未删除）")
    request_id: Optional[str] = Field(None, description="调用方请求 ID（回显）")


class KittingShortageOut(BaseModel):
    demand_type: str
    demand_no: str
    demand_line_no: Optional[str] = None
    material_code: str
    material_name: Optional[str] = None
    required_qty: Optional[float] = None
    available_qty: Optional[float] = None
    future_supply_qty: Optional[float] = None
    shortage_qty: Optional[float] = None
    required_date: Optional[date] = None
    estimated_available_date: Optional[date] = None
    shortage_days: Optional[int] = None
    shortage_reason: Optional[str] = None
    supply_source: Optional[str] = None
    supplier_code: Optional[str] = None
    supplier_name: Optional[str] = None
    is_key_material: int
    owner_department: Optional[str] = None
    owner: Optional[str] = None
    alert_status: str
    allocation_run_id: str
    updated_at: Optional[datetime] = None
    is_deleted: int = 0


@router.get("/shortages", response_model=ResponseModel[ExternalDataPage[KittingShortageOut]],
            summary="缺料明细列表", description="endpoint_code: kitting.shortages")
@register_external(
    "kitting.shortages", "缺料明细列表", method="GET", path="/material-kitting/shortages",
    description="缺料明细（净缺口/预计可用日期/缺料原因/责任部门），支持增量同步",
    tags=["物料齐套"],
)
@log_external_call("kitting.shortages")
async def kitting_shortages_list(
    request: Request,
    q: Annotated[KittingShortagesQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("kitting.shortages")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)
    meta = await _page_meta(db)

    query = select(KittingShortage)
    count_query = select(func.count()).select_from(KittingShortage)
    conditions = []
    if q.demand_no:
        conditions.append(KittingShortage.demand_no == q.demand_no)
    if q.material_code:
        conditions.append(KittingShortage.material_code == q.material_code)
    if q.is_key_material is not None:
        conditions.append(KittingShortage.is_key_material == (1 if q.is_key_material else 0))
    if q.alert_status:
        conditions.append(KittingShortage.alert_status.in_([s.strip() for s in q.alert_status.split(",") if s.strip()]))
    conditions.append(KittingShortage.is_deleted == (1 if q.is_deleted else 0))
    if q.updated_after:
        conditions.append(KittingShortage.updated_at >= q.updated_after)
    for cond in conditions:
        query = query.where(cond)
        count_query = count_query.where(cond)

    total = (await db.execute(count_query)).scalar() or 0
    rows = (
        await db.execute(
            query.order_by(KittingShortage.updated_at.desc(), KittingShortage.id.asc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).scalars().all()

    items = [
        {
            "demand_type": r.demand_type,
            "demand_no": r.demand_no,
            "demand_line_no": r.demand_line_no,
            "material_code": r.material_code,
            "material_name": r.material_name,
            "required_qty": float(r.required_qty) if r.required_qty is not None else None,
            "available_qty": float(r.available_qty) if r.available_qty is not None else None,
            "future_supply_qty": float(r.future_supply_qty) if r.future_supply_qty is not None else None,
            "shortage_qty": float(r.shortage_qty) if r.shortage_qty is not None else None,
            "required_date": r.required_date,
            "estimated_available_date": r.estimated_available_date,
            "shortage_days": r.shortage_days,
            "shortage_reason": r.shortage_reason,
            "supply_source": r.supply_source,
            "supplier_code": r.supplier_code,
            "supplier_name": r.supplier_name,
            "is_key_material": r.is_key_material,
            "owner_department": r.owner_department,
            "owner": r.owner,
            "alert_status": r.alert_status,
            "allocation_run_id": r.allocation_run_id,
            "updated_at": r.updated_at,
            "is_deleted": r.is_deleted,
        }
        for r in rows
    ]
    return {"items": items, "total": total, "page": page, "page_size": page_size, **meta, "request_id": q.request_id}


class KittingDemandsQuery(PageParamsMixin):
    order_no: Optional[str] = Field(None, description="订单号精确匹配")
    customer_code: Optional[str] = Field(None, description="客户编码精确匹配")
    product_code: Optional[str] = Field(None, description="产品编码精确匹配")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间（ISO 8601）")
    is_deleted: Optional[bool] = Field(None, description="是否返回已删除订单（默认仅未删除）")
    request_id: Optional[str] = Field(None, description="调用方请求 ID（回显）")


class KittingDemandOut(BaseModel):
    demand_type: str = "SALES_ORDER"
    demand_no: str
    demand_line_no: Optional[str] = None
    customer_code: Optional[str] = None
    customer_name: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    demand_qty: Optional[float] = None
    completed_qty: Optional[float] = None
    remaining_qty: Optional[float] = None
    required_date: Optional[date] = None
    promised_date: Optional[date] = None
    priority: Optional[int] = None
    status: Optional[str] = None
    owner: Optional[str] = None
    bom_id: Optional[str] = None
    bom_no: Optional[str] = None
    updated_at: Optional[datetime] = None
    is_deleted: int = 0


@router.get("/demands", response_model=ResponseModel[ExternalDataPage[KittingDemandOut]],
            summary="需求对象列表", description="endpoint_code: kitting.demands")
@register_external(
    "kitting.demands", "需求对象列表", method="GET", path="/material-kitting/demands",
    description="齐套需求对象（销售订单行：数量/需求日期/优先级/状态），支持增量同步",
    tags=["物料齐套"],
)
@log_external_call("kitting.demands")
async def kitting_demands_list(
    request: Request,
    q: Annotated[KittingDemandsQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("kitting.demands")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)
    source_as_of = await load_source_as_of(db, ("orders", "order_details"))
    data_as_of = min_as_of(source_as_of)
    confidence, stale = freshness_of(data_as_of)

    query = (
        select(SaleOrderLine, SaleOrder)
        .join(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)
    )
    count_query = select(func.count()).select_from(SaleOrderLine).join(
        SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id
    )
    conditions = []
    if q.is_deleted:
        conditions.append(
            or_(
                SaleOrder.is_deleted == 1,
                SaleOrder.is_closed == 1,
                SaleOrderLine.status == "closed",
            )
        )
    else:
        conditions.extend(
            [
                SaleOrder.is_closed == 0,
                SaleOrder.is_deleted == 0,
                SaleOrderLine.status != "closed",
            ]
        )
    if q.order_no:
        conditions.append(SaleOrderLine.order_no == q.order_no)
    if q.customer_code:
        conditions.append(SaleOrder.customer_code == q.customer_code)
    if q.product_code:
        conditions.append(SaleOrderLine.product_code == q.product_code)
    if q.updated_after:
        conditions.append(SaleOrderLine.updated_at >= q.updated_after)
    for cond in conditions:
        query = query.where(cond)
        count_query = count_query.where(cond)

    total = (await db.execute(count_query)).scalar() or 0
    rows = (
        await db.execute(
            query.order_by(SaleOrderLine.updated_at.desc(), SaleOrderLine.id.asc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()

    priority_map = {"red": 1, "yellow": 2, "green": 3}
    items = []
    for line, order in rows:
        qty = float(line.order_qty) if line.order_qty is not None else None
        completed = float(order.completed_qty) if order.completed_qty is not None else None
        items.append(
            {
                "demand_type": "SALES_ORDER",
                "demand_no": line.order_no,
                "demand_line_no": line.line_no,
                "customer_code": order.customer_code,
                "customer_name": order.customer,
                "product_code": line.product_code,
                "product_name": line.product_name,
                "demand_qty": qty,
                "completed_qty": completed,
                "remaining_qty": (qty - completed) if (qty is not None and completed is not None) else qty,
                "required_date": order.material_ready_date or order.shipping_plan or line.promised_date,
                "promised_date": line.promised_date or order.promised_date,
                "priority": priority_map.get(order.risk_level or ""),
                "status": order.status,
                "owner": order.owner,
                "bom_id": str(line.bom_id) if line.bom_id is not None else None,
                "bom_no": line.bom_no,
                "updated_at": line.updated_at,
                "is_deleted": 1 if (order.is_deleted or order.is_closed or line.status == "closed") else 0,
            }
        )
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "data_as_of": data_as_of.isoformat() if data_as_of else None,
        "data_confidence": confidence,
        "stale": stale,
        "request_id": q.request_id,
    }
