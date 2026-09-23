"""库存可用量对外接口（按物料聚合，AEOS 只读接入）

available = Σ (qty_on_hand − locked_qty)（现存 − 锁定，全仓汇总；本账套 K3 FQtyLock/FBal 恒 0，实际等于现存）。
注意：不暴露任何单价/成本字段。
"""

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.basicdata.inventory import Inventory
from app.schemas.common import ResponseModel
from app.services.material.kitting_calc_service import freshness_of, load_source_as_of, min_as_of

from ..common import ExternalDataPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="/inventory", tags=["库存"])


class InventoryAvailabilityQuery(PageParamsMixin):
    material_code: Optional[str] = Field(None, description="物料编码精确匹配")
    keyword: Optional[str] = Field(None, description="关键字（物料编码/名称 模糊匹配）")
    wh_code: Optional[str] = Field(None, description="仓库编码精确匹配（先按仓过滤再按物料聚合）")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间（ISO 8601）")
    request_id: Optional[str] = Field(None, description="调用方请求 ID（回显）")


class InventoryAvailabilityOut(BaseModel):
    material_code: str
    material_name: Optional[str] = None
    on_hand_qty: Optional[float] = None
    locked_qty: Optional[float] = None
    available_qty: Optional[float] = None
    qty_in_transit: Optional[float] = None


@router.get("/availability", response_model=ResponseModel[ExternalDataPage[InventoryAvailabilityOut]],
            summary="库存可用量（按物料）", description="endpoint_code: inventory.availability")
@register_external(
    "inventory.availability", "库存可用量", method="GET", path="/inventory/availability",
    description="按物料聚合的可用库存（现存/锁定/可用/在途），不含单价等敏感字段",
    tags=["库存"],
)
@log_external_call("inventory.availability")
async def inventory_availability_list(
    request: Request,
    q: Annotated[InventoryAvailabilityQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("inventory.availability")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    conditions = [Inventory.material_code.isnot(None)]
    if q.material_code:
        conditions.append(Inventory.material_code == q.material_code)
    if q.keyword:
        like_expr = f"%{q.keyword}%"
        conditions.append(
            or_(Inventory.material_code.ilike(like_expr), Inventory.material_name.ilike(like_expr))
        )
    if q.wh_code:
        conditions.append(Inventory.wh_code == q.wh_code)

    agg = (
        select(
            Inventory.material_code.label("material_code"),
            func.max(Inventory.material_name).label("material_name"),
            func.sum(Inventory.qty_on_hand).label("on_hand_qty"),
            func.sum(Inventory.locked_qty).label("locked_qty"),
            (func.sum(Inventory.qty_on_hand) - func.sum(Inventory.locked_qty)).label("available_qty"),
            func.sum(Inventory.qty_in_transit).label("qty_in_transit"),
            func.max(Inventory.updated_at).label("last_updated"),
        )
        .where(*conditions)
        .group_by(Inventory.material_code)
        .subquery()
    )

    base = select(agg)
    if q.updated_after:
        base = base.where(agg.c.last_updated >= q.updated_after)

    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
    rows = (
        await db.execute(
            base.order_by(agg.c.material_code.asc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()

    items = [
        {
            "material_code": r.material_code,
            "material_name": r.material_name,
            "on_hand_qty": float(r.on_hand_qty) if r.on_hand_qty is not None else None,
            "locked_qty": float(r.locked_qty) if r.locked_qty is not None else None,
            "available_qty": float(r.available_qty) if r.available_qty is not None else None,
            "qty_in_transit": float(r.qty_in_transit) if r.qty_in_transit is not None else None,
        }
        for r in rows
    ]

    source_as_of = await load_source_as_of(db, ("inventory",))
    data_as_of = min_as_of(source_as_of)
    confidence, stale = freshness_of(data_as_of)
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
