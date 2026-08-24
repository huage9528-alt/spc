"""采购对外接口

为外部系统（如 WMS / 财务系统）提供采购订单/到料计划查询。
基于 PurchaseOrder 表（po_no + detail_id 唯一）。
"""

from datetime import date, datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.material.purchase_order import PurchaseOrder
from app.schemas.common import ResponseModel

from ..common import ExternalPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="/purchase-orders", tags=["采购"])


class PurchaseOrdersListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（PO号 / 物料名称 / 订单号 模糊匹配）")
    po_status: Optional[str] = Field(None, description="PO 状态，多选逗号分隔")
    supplier_code: Optional[str] = Field(None, description="供应商编码精确匹配")
    order_no: Optional[str] = Field(None, description="关联销售订单号精确匹配")
    material_code: Optional[str] = Field(None, description="物料编码精确匹配")
    eta_start: Optional[date] = Field(None, description="ETA 日期范围起 YYYY-MM-DD")
    eta_end: Optional[date] = Field(None, description="ETA 日期范围止 YYYY-MM-DD")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间的记录（ISO 8601）")


class PurchaseOrderOut(BaseModel):
    """采购订单/到料计划（对外精简字段集）"""
    id: int = Field(..., description="主键")
    po_no: Optional[str] = Field(None, description="PO号")
    detail_id: Optional[int] = Field(None, description="明细行 id")
    order_no: Optional[str] = Field(None, description="关联销售订单号")
    material_code: Optional[str] = Field(None, description="物料编码")
    material_name: Optional[str] = Field(None, description="物料名称")
    spec_model: Optional[str] = Field(None, description="规格型号")
    material_type_name: Optional[str] = Field(None, description="物料分类")
    supplier_code: Optional[str] = Field(None, description="供应商编码")
    supplier_name: Optional[str] = Field(None, description="供应商名称")
    po_qty: Optional[float] = Field(None, description="PO数量")
    received_qty: Optional[float] = Field(None, description="已收数量")
    po_price: Optional[float] = Field(None, description="PO单价")
    unit: Optional[str] = Field(None, description="单位")
    po_date: Optional[date] = Field(None, description="PO日期")
    po_status: Optional[str] = Field(None, description="PO状态")
    eta: Optional[date] = Field(None, description="预计到货日")
    actual_arrival_date: Optional[date] = Field(None, description="实际到货日")
    inspection_date: Optional[date] = Field(None, description="检验日期")
    owner: Optional[str] = Field(None, description="负责人")
    is_closed: Optional[int] = Field(None, description="是否关闭")
    updated_at: Optional[datetime] = Field(None, description="最后更新时间（增量同步锚点）")


@router.get("/list", response_model=ResponseModel[ExternalPage[PurchaseOrderOut]],
            summary="采购订单列表", description="endpoint_code: purchase_orders.list")
@register_external(
    "purchase_orders.list", "采购订单列表", method="GET", path="/purchase-orders/list",
    description="采购订单/到料计划列表查询，支持关键字、PO 状态、供应商、ETA 范围、增量同步",
    tags=["采购"],
)
@log_external_call("purchase_orders.list")
async def purchase_orders_list(
    request: Request,
    q: Annotated[PurchaseOrdersListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("purchase_orders.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)
    query = select(PurchaseOrder)
    count_query = select(func.count()).select_from(PurchaseOrder)

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            PurchaseOrder.po_no.ilike(like_expr),
            PurchaseOrder.material_name.ilike(like_expr),
            PurchaseOrder.order_no.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.po_status:
        statuses = [s.strip() for s in q.po_status.split(",") if s.strip()]
        if len(statuses) == 1:
            query = query.where(PurchaseOrder.po_status == statuses[0])
            count_query = count_query.where(PurchaseOrder.po_status == statuses[0])
        elif statuses:
            query = query.where(PurchaseOrder.po_status.in_(statuses))
            count_query = count_query.where(PurchaseOrder.po_status.in_(statuses))

    if q.supplier_code:
        query = query.where(PurchaseOrder.supplier_code == q.supplier_code)
        count_query = count_query.where(PurchaseOrder.supplier_code == q.supplier_code)

    if q.order_no:
        query = query.where(PurchaseOrder.order_no == q.order_no)
        count_query = count_query.where(PurchaseOrder.order_no == q.order_no)

    if q.material_code:
        query = query.where(PurchaseOrder.material_code == q.material_code)
        count_query = count_query.where(PurchaseOrder.material_code == q.material_code)

    if q.eta_start:
        query = query.where(PurchaseOrder.eta >= q.eta_start)
        count_query = count_query.where(PurchaseOrder.eta >= q.eta_start)
    if q.eta_end:
        query = query.where(PurchaseOrder.eta <= q.eta_end)
        count_query = count_query.where(PurchaseOrder.eta <= q.eta_end)

    if q.updated_after:
        query = query.where(PurchaseOrder.updated_at >= q.updated_after)
        count_query = count_query.where(PurchaseOrder.updated_at >= q.updated_after)

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(PurchaseOrder.po_date.desc().nullslast(), PurchaseOrder.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).scalars().all()

    items = [{
        "id": r.id,
        "po_no": r.po_no,
        "detail_id": r.detail_id,
        "order_no": r.order_no,
        "material_code": r.material_code,
        "material_name": r.material_name,
        "spec_model": r.spec_model,
        "material_type_name": r.material_type_name,
        "supplier_code": r.supplier_code,
        "supplier_name": r.supplier_name,
        "po_qty": float(r.po_qty) if r.po_qty is not None else None,
        "received_qty": float(r.received_qty) if r.received_qty is not None else None,
        "po_price": float(r.po_price) if r.po_price is not None else None,
        "unit": r.unit,
        "po_date": r.po_date.isoformat() if r.po_date else None,
        "po_status": r.po_status,
        "eta": r.eta.isoformat() if r.eta else None,
        "actual_arrival_date": r.actual_arrival_date.isoformat() if r.actual_arrival_date else None,
        "inspection_date": r.inspection_date.isoformat() if r.inspection_date else None,
        "owner": r.owner,
        "is_closed": r.is_closed,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}
