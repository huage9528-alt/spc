"""库存对外接口

为外部系统（如 WMS / ERP / 财务系统）提供即时库存明细查询。
基于 Inventory 表（scm_inventory，material_id + wh_id + location_id 唯一）。
对外只暴露精简字段集与常用筛选条件，字段集合独立于表结构变更。
"""

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.basicdata.inventory import Inventory
from app.schemas.common import ResponseModel

from ..common import ExternalPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="/inventory", tags=["库存"])


class InventoryListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（物料编码 / 物料名称 / 仓库名称 模糊匹配）")
    material_code: Optional[str] = Field(None, description="物料编码精确匹配")
    wh_code: Optional[str] = Field(None, description="仓库编码精确匹配")
    batch_no: Optional[str] = Field(None, description="批次号精确匹配")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间的记录（ISO 8601）")


class InventoryOut(BaseModel):
    """即时库存明细（对外精简字段集）"""
    id: int = Field(..., description="主键")
    material_id: Optional[int] = Field(None, description="物料 id")
    material_code: Optional[str] = Field(None, description="物料编码")
    material_name: Optional[str] = Field(None, description="物料名称")
    wh_id: Optional[int] = Field(None, description="仓库 id")
    wh_code: Optional[str] = Field(None, description="仓库编码")
    wh_name: Optional[str] = Field(None, description="仓库名称")
    location_id: Optional[int] = Field(None, description="库位 id")
    location_name: Optional[str] = Field(None, description="库位名称")
    qty_on_hand: Optional[float] = Field(None, description="在库数量")
    locked_qty: Optional[float] = Field(None, description="锁定数量")
    balance_qty: Optional[float] = Field(None, description="可用数量")
    qty_in_transit: Optional[float] = Field(None, description="在途数量")
    unit_price: Optional[float] = Field(None, description="单价")
    ending_balance: Optional[float] = Field(None, description="期末金额")
    batch_no: Optional[str] = Field(None, description="批次号")
    updated_at: Optional[datetime] = Field(None, description="最后更新时间（增量同步锚点）")


@router.get("/list", response_model=ResponseModel[ExternalPage[InventoryOut]],
            summary="库存列表", description="endpoint_code: inventory.list")
@register_external(
    "inventory.list", "库存列表", method="GET", path="/inventory/list",
    description="即时库存明细查询（物料×仓库×库位），支持关键字、物料/仓库/批次筛选、增量同步",
    tags=["库存"],
)
@log_external_call("inventory.list")
async def inventory_list(
    request: Request,
    q: Annotated[InventoryListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("inventory.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)
    query = select(Inventory)
    count_query = select(func.count()).select_from(Inventory)

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            Inventory.material_code.ilike(like_expr),
            Inventory.material_name.ilike(like_expr),
            Inventory.wh_name.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.material_code:
        query = query.where(Inventory.material_code == q.material_code)
        count_query = count_query.where(Inventory.material_code == q.material_code)

    if q.wh_code:
        query = query.where(Inventory.wh_code == q.wh_code)
        count_query = count_query.where(Inventory.wh_code == q.wh_code)

    if q.batch_no:
        query = query.where(Inventory.batch_no == q.batch_no)
        count_query = count_query.where(Inventory.batch_no == q.batch_no)

    if q.updated_after:
        query = query.where(Inventory.updated_at >= q.updated_after)
        count_query = count_query.where(Inventory.updated_at >= q.updated_after)

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(Inventory.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).scalars().all()

    items = [{
        "id": r.id,
        "material_id": r.material_id,
        "material_code": r.material_code,
        "material_name": r.material_name,
        "wh_id": r.wh_id,
        "wh_code": r.wh_code,
        "wh_name": r.wh_name,
        "location_id": r.location_id,
        "location_name": r.location_name,
        "qty_on_hand": float(r.qty_on_hand) if r.qty_on_hand is not None else None,
        "locked_qty": float(r.locked_qty) if r.locked_qty is not None else None,
        "balance_qty": float(r.balance_qty) if r.balance_qty is not None else None,
        "qty_in_transit": float(r.qty_in_transit) if r.qty_in_transit is not None else None,
        "unit_price": float(r.unit_price) if r.unit_price is not None else None,
        "ending_balance": float(r.ending_balance) if r.ending_balance is not None else None,
        "batch_no": r.batch_no,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}
