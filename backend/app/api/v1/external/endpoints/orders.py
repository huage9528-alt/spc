"""订单对外接口

为外部系统定制的订单查询接口。基于 SaleOrder 表（按 order_no + line_no 唯一），
提供外部常用的查询参数和精简字段集，区别于内部 /api/v1/orders 的复杂查询逻辑。
"""

from datetime import date, datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.models.production.labor_price_audit import ProductionLaborPriceAudit
from app.schemas.common import ResponseModel

from ..common import ExternalPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="/orders", tags=["订单"])
router_details = APIRouter(prefix="/order-details", tags=["订单"])


class OrdersListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（订单号 / 客户 / 产品名 模糊匹配）")
    status: Optional[str] = Field(None, description="订单状态，多选逗号分隔，如 open,closed")
    customer_code: Optional[str] = Field(None, description="客户编码精确匹配")
    risk_level: Optional[str] = Field(None, description="风险等级，多选逗号分隔，如 red,yellow")
    promised_date_start: Optional[date] = Field(None, description="合同交期范围起 YYYY-MM-DD")
    promised_date_end: Optional[date] = Field(None, description="合同交期范围止 YYYY-MM-DD")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间的记录（ISO 8601）")


class OrderOut(BaseModel):
    """销售订单行（对外精简字段集）"""
    id: int = Field(..., description="主键")
    order_no: Optional[str] = Field(None, description="订单号")
    line_no: Optional[str] = Field(None, description="订单行号")
    customer: Optional[str] = Field(None, description="客户名称")
    customer_code: Optional[str] = Field(None, description="客户编码")
    product_code: Optional[str] = Field(None, description="产品编码")
    product_name: Optional[str] = Field(None, description="产品名称")
    order_qty: Optional[float] = Field(None, description="订单数量")
    completed_qty: Optional[float] = Field(None, description="完工数量")
    order_amount: Optional[float] = Field(None, description="订单金额")
    status: Optional[str] = Field(None, description="订单状态")
    risk_level: Optional[str] = Field(None, description="风险等级")
    promised_date: Optional[date] = Field(None, description="合同交期")
    planned_start_date: Optional[date] = Field(None, description="计划开工日期")
    owner: Optional[str] = Field(None, description="负责人")
    updated_at: Optional[datetime] = Field(None, description="最后更新时间（增量同步锚点）")


@router.get("/list", response_model=ResponseModel[ExternalPage[OrderOut]],
            summary="订单列表", description="endpoint_code: orders.list")
@register_external(
    "orders.list", "订单列表", method="GET", path="/orders/list",
    description="销售订单行列表查询，支持关键字、状态、客户、风险等级、合同交期范围、增量同步",
    tags=["订单"],
)
@log_external_call("orders.list")
async def orders_list(
    request: Request,
    q: Annotated[OrdersListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("orders.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)
    query = select(SaleOrder)
    count_query = select(func.count()).select_from(SaleOrder)

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            SaleOrder.order_no.ilike(like_expr),
            SaleOrder.customer.ilike(like_expr),
            SaleOrder.product_name.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.status:
        statuses = [s.strip() for s in q.status.split(",") if s.strip()]
        if len(statuses) == 1:
            query = query.where(SaleOrder.status == statuses[0])
            count_query = count_query.where(SaleOrder.status == statuses[0])
        elif statuses:
            query = query.where(SaleOrder.status.in_(statuses))
            count_query = count_query.where(SaleOrder.status.in_(statuses))

    if q.customer_code:
        query = query.where(SaleOrder.customer_code == q.customer_code)
        count_query = count_query.where(SaleOrder.customer_code == q.customer_code)

    if q.risk_level:
        levels = [s.strip() for s in q.risk_level.split(",") if s.strip()]
        if len(levels) == 1:
            query = query.where(SaleOrder.risk_level == levels[0])
            count_query = count_query.where(SaleOrder.risk_level == levels[0])
        elif levels:
            query = query.where(SaleOrder.risk_level.in_(levels))
            count_query = count_query.where(SaleOrder.risk_level.in_(levels))

    if q.promised_date_start:
        query = query.where(SaleOrder.promised_date >= q.promised_date_start)
        count_query = count_query.where(SaleOrder.promised_date >= q.promised_date_start)
    if q.promised_date_end:
        query = query.where(SaleOrder.promised_date <= q.promised_date_end)
        count_query = count_query.where(SaleOrder.promised_date <= q.promised_date_end)

    if q.updated_after:
        query = query.where(SaleOrder.updated_at >= q.updated_after)
        count_query = count_query.where(SaleOrder.updated_at >= q.updated_after)

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(SaleOrder.promised_date.asc().nullslast(), SaleOrder.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    result = await db.execute(query)
    rows = result.scalars().all()

    items = []
    for r in rows:
        items.append({
            "id": r.id,
            "order_no": r.order_no,
            "line_no": r.line_no,
            "customer": r.customer,
            "customer_code": r.customer_code,
            "product_code": r.product_code,
            "product_name": r.product_name,
            "order_qty": float(r.order_qty) if r.order_qty is not None else None,
            "completed_qty": float(r.completed_qty) if r.completed_qty is not None else None,
            "order_amount": float(r.order_amount) if r.order_amount is not None else None,
            "status": r.status,
            "risk_level": r.risk_level,
            "promised_date": r.promised_date.isoformat() if r.promised_date else None,
            "planned_start_date": r.planned_start_date.isoformat() if r.planned_start_date else None,
            "owner": r.owner,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        })

    return {"items": items, "total": total, "page": page, "page_size": page_size}


class OrderDetailsListQuery(PageParamsMixin):
    order_no: Optional[str] = Field(None, description="订单号精确匹配（拉取某订单的全部明细行）")
    keyword: Optional[str] = Field(None, description="关键字（订单号 / 产品名 / 产品型号 模糊匹配）")
    product_code: Optional[str] = Field(None, description="产品编码精确匹配")
    status: Optional[str] = Field(None, description="明细行状态，多选逗号分隔，如 open,closed")
    bom_no: Optional[str] = Field(None, description="BOM编号精确匹配")
    promised_date_start: Optional[date] = Field(None, description="合同交期范围起 YYYY-MM-DD")
    promised_date_end: Optional[date] = Field(None, description="合同交期范围止 YYYY-MM-DD")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间的记录（ISO 8601）")


class OrderDetailOut(BaseModel):
    """销售订单明细行（对外精简字段集）"""
    id: int = Field(..., description="主键")
    sale_order_id: Optional[int] = Field(None, description="所属订单 id")
    order_no: Optional[str] = Field(None, description="订单号")
    erp_line_id: Optional[str] = Field(None, description="ERP 行 id")
    line_no: Optional[str] = Field(None, description="订单行号")
    product_code: Optional[str] = Field(None, description="产品编码")
    product_name: Optional[str] = Field(None, description="产品名称")
    product_model: Optional[str] = Field(None, description="产品型号")
    order_qty: Optional[float] = Field(None, description="订单数量")
    order_amount: Optional[float] = Field(None, description="订单金额")
    promised_date: Optional[date] = Field(None, description="合同交期")
    planned_start_date: Optional[date] = Field(None, description="计划开工日期")
    batch_no: Optional[str] = Field(None, description="批次号")
    bom_no: Optional[str] = Field(None, description="BOM 编号")
    bom_id: Optional[int] = Field(None, description="BOM id")
    labor_price_amount: Optional[float] = Field(None, description="工价金额（按 BOM 汇总）")
    status: Optional[str] = Field(None, description="明细行状态")
    customer: Optional[str] = Field(None, description="客户名称（取自订单头）")
    customer_code: Optional[str] = Field(None, description="客户编码（取自订单头）")
    created_at: Optional[datetime] = Field(None, description="创建时间")
    updated_at: Optional[datetime] = Field(None, description="最后更新时间")


@router_details.get("/list", response_model=ResponseModel[ExternalPage[OrderDetailOut]],
                    summary="订单明细列表", description="endpoint_code: order_details.list")
@register_external(
    "order_details.list", "订单明细列表", method="GET", path="/order-details/list",
    description="销售订单明细行列表查询，支持按订单号、产品、BOM、状态、合同交期范围、增量同步",
    tags=["订单"],
)
@log_external_call("order_details.list")
async def order_details_list(
    request: Request,
    q: Annotated[OrderDetailsListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("order_details.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(
        SaleOrderLine,
        SaleOrder.customer,
        SaleOrder.customer_code,
    ).outerjoin(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)

    count_query = select(func.count()).select_from(SaleOrderLine)

    if q.order_no:
        query = query.where(SaleOrderLine.order_no == q.order_no)
        count_query = count_query.where(SaleOrderLine.order_no == q.order_no)

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            SaleOrderLine.order_no.ilike(like_expr),
            SaleOrderLine.product_name.ilike(like_expr),
            SaleOrderLine.product_model.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.product_code:
        query = query.where(SaleOrderLine.product_code == q.product_code)
        count_query = count_query.where(SaleOrderLine.product_code == q.product_code)

    if q.status:
        statuses = [s.strip() for s in q.status.split(",") if s.strip()]
        if len(statuses) == 1:
            query = query.where(SaleOrderLine.status == statuses[0])
            count_query = count_query.where(SaleOrderLine.status == statuses[0])
        elif statuses:
            query = query.where(SaleOrderLine.status.in_(statuses))
            count_query = count_query.where(SaleOrderLine.status.in_(statuses))

    if q.bom_no:
        query = query.where(SaleOrderLine.bom_no == q.bom_no)
        count_query = count_query.where(SaleOrderLine.bom_no == q.bom_no)

    if q.promised_date_start:
        query = query.where(SaleOrderLine.promised_date >= q.promised_date_start)
        count_query = count_query.where(SaleOrderLine.promised_date >= q.promised_date_start)
    if q.promised_date_end:
        query = query.where(SaleOrderLine.promised_date <= q.promised_date_end)
        count_query = count_query.where(SaleOrderLine.promised_date <= q.promised_date_end)

    if q.updated_after:
        query = query.where(SaleOrderLine.updated_at >= q.updated_after)
        count_query = count_query.where(SaleOrderLine.updated_at >= q.updated_after)

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(SaleOrderLine.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).all()

    bom_no_to_normalized: dict[str, str] = {}
    normalized_codes: set[str] = set()
    for row in rows:
        bn = row.SaleOrderLine.bom_no
        if bn:
            normalized = bn[2:] if bn.startswith(("P-", "Y-")) else bn
            bom_no_to_normalized[bn] = normalized
            normalized_codes.add(normalized)
    labor_price_map: dict[str, float] = {}
    if normalized_codes:
        lp_result = await db.execute(
            select(ProductionLaborPriceAudit.bom_code, ProductionLaborPriceAudit.labor_price_amount).where(
                ProductionLaborPriceAudit.bom_code.in_(normalized_codes),
                ProductionLaborPriceAudit.labor_price_amount.isnot(None),
            )
        )
        for lp_row in lp_result.all():
            if lp_row[1] is not None:
                labor_price_map[lp_row[0]] = labor_price_map.get(lp_row[0], 0.0) + float(lp_row[1])

    items = []
    for row in rows:
        line = row.SaleOrderLine
        items.append({
            "id": line.id,
            "sale_order_id": line.sale_order_id,
            "order_no": line.order_no,
            "erp_line_id": line.erp_line_id,
            "line_no": line.line_no,
            "product_code": line.product_code,
            "product_name": line.product_name,
            "product_model": line.product_model,
            "order_qty": float(line.order_qty) if line.order_qty is not None else None,
            "order_amount": float(line.order_amount) if line.order_amount is not None else None,
            "promised_date": line.promised_date.isoformat() if line.promised_date else None,
            "planned_start_date": line.planned_start_date.isoformat() if line.planned_start_date else None,
            "batch_no": line.batch_no,
            "bom_no": line.bom_no,
            "bom_id": line.bom_id,
            "labor_price_amount": labor_price_map.get(bom_no_to_normalized.get(line.bom_no, "")),
            "status": line.status,
            "customer": row.customer,
            "customer_code": row.customer_code,
            "created_at": line.created_at.isoformat() if line.created_at else None,
            "updated_at": line.updated_at.isoformat() if line.updated_at else None,
        })

    return {"items": items, "total": total, "page": page, "page_size": page_size}
