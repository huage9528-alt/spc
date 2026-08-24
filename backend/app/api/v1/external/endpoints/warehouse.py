"""仓储对外接口

为外部系统（如 WMS / ERP）提供仓库 / 库位 主数据查询。
基于 Warehouse（scm_warehouse）与 Location（scm_location）表。
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
from app.models.basicdata.warehouse import Warehouse
from app.models.basicdata.location import Location
from app.schemas.common import ResponseModel

from ..common import ExternalPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

wh_router = APIRouter(prefix="/warehouses", tags=["仓储"])
loc_router = APIRouter(prefix="/locations", tags=["仓储"])


# ═══════════════════════════════════════════
# 仓库
# ═══════════════════════════════════════════

class WarehousesListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（仓库编码 / 仓库名称 模糊匹配）")
    wh_type: Optional[str] = Field(None, description="仓库类型精确匹配")
    wh_attribute: Optional[str] = Field(None, description="仓库属性精确匹配（10-良品 11-在检 12-不良）")
    is_enabled: Optional[int] = Field(None, description="是否启用 0/1")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间的记录（ISO 8601）")


class WarehouseOut(BaseModel):
    """仓库主数据（对外精简字段集）"""
    id: int = Field(..., description="主键")
    wh_id: Optional[int] = Field(None, description="ERP 仓库 id")
    parent_wh_id: Optional[int] = Field(None, description="父仓库 id")
    wh_code: Optional[str] = Field(None, description="仓库编码")
    wh_name: Optional[str] = Field(None, description="仓库名称")
    wh_type: Optional[str] = Field(None, description="仓库类型")
    wh_attribute: Optional[str] = Field(None, description="仓库属性")
    plan_area: Optional[str] = Field(None, description="规划面积")
    is_workshop: Optional[int] = Field(None, description="是否车间仓")
    is_enabled: Optional[int] = Field(None, description="是否启用")
    updated_at: Optional[datetime] = Field(None, description="最后更新时间（增量同步锚点）")


@wh_router.get("/list", response_model=ResponseModel[ExternalPage[WarehouseOut]],
               summary="仓库列表", description="endpoint_code: warehouses.list")
@register_external(
    "warehouses.list", "仓库列表", method="GET", path="/warehouses/list",
    description="仓库主数据列表查询，支持关键字、仓库类型、仓库属性、启用状态、增量同步",
    tags=["仓储"],
)
@log_external_call("warehouses.list")
async def warehouses_list(
    request: Request,
    q: Annotated[WarehousesListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("warehouses.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    # 默认排除已删除仓库
    query = select(Warehouse).where(Warehouse.is_deleted != 1)
    count_query = (
        select(func.count()).select_from(Warehouse).where(Warehouse.is_deleted != 1)
    )

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            Warehouse.wh_code.ilike(like_expr),
            Warehouse.wh_name.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.wh_type:
        query = query.where(Warehouse.wh_type == q.wh_type)
        count_query = count_query.where(Warehouse.wh_type == q.wh_type)

    if q.wh_attribute:
        query = query.where(Warehouse.wh_attribute == q.wh_attribute)
        count_query = count_query.where(Warehouse.wh_attribute == q.wh_attribute)

    if q.is_enabled is not None:
        query = query.where(Warehouse.is_enabled == q.is_enabled)
        count_query = count_query.where(Warehouse.is_enabled == q.is_enabled)

    if q.updated_after:
        query = query.where(Warehouse.updated_at >= q.updated_after)
        count_query = count_query.where(Warehouse.updated_at >= q.updated_after)

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(Warehouse.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).scalars().all()

    items = [{
        "id": r.id,
        "wh_id": r.wh_id,
        "parent_wh_id": r.parent_wh_id,
        "wh_code": r.wh_code,
        "wh_name": r.wh_name,
        "wh_type": r.wh_type,
        "wh_attribute": r.wh_attribute,
        "plan_area": r.plan_area,
        "is_workshop": r.is_workshop,
        "is_enabled": r.is_enabled,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ═══════════════════════════════════════════
# 库位
# ═══════════════════════════════════════════

class LocationsListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（库位编码 / 库位名称 / 库位全称 模糊匹配）")
    parent_id: Optional[int] = Field(None, description="父库位 ID 精确匹配")
    detail_flag: Optional[int] = Field(None, description="明细标识 0/1")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间的记录（ISO 8601）")


class LocationOut(BaseModel):
    """库位主数据（对外精简字段集）"""
    id: int = Field(..., description="主键")
    location_id: Optional[int] = Field(None, description="ERP 库位 id")
    location_group_id: Optional[int] = Field(None, description="库位组 id")
    location_code: Optional[str] = Field(None, description="库位编码")
    location_name: Optional[str] = Field(None, description="库位名称")
    location_full_name: Optional[str] = Field(None, description="库位全称")
    depth: Optional[int] = Field(None, description="层级深度")
    detail_flag: Optional[int] = Field(None, description="明细标识")
    parent_id: Optional[int] = Field(None, description="父库位 id")
    updated_at: Optional[datetime] = Field(None, description="最后更新时间（增量同步锚点）")


@loc_router.get("/list", response_model=ResponseModel[ExternalPage[LocationOut]],
                summary="库位列表", description="endpoint_code: locations.list")
@register_external(
    "locations.list", "库位列表", method="GET", path="/locations/list",
    description="库位主数据列表查询，支持关键字、父库位、明细标识、增量同步",
    tags=["仓储"],
)
@log_external_call("locations.list")
async def locations_list(
    request: Request,
    q: Annotated[LocationsListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("locations.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    # 默认排除已删除库位
    query = select(Location).where(Location.is_deleted != 1)
    count_query = (
        select(func.count()).select_from(Location).where(Location.is_deleted != 1)
    )

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            Location.location_code.ilike(like_expr),
            Location.location_name.ilike(like_expr),
            Location.location_full_name.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.parent_id is not None:
        query = query.where(Location.parent_id == q.parent_id)
        count_query = count_query.where(Location.parent_id == q.parent_id)

    if q.detail_flag is not None:
        query = query.where(Location.detail_flag == q.detail_flag)
        count_query = count_query.where(Location.detail_flag == q.detail_flag)

    if q.updated_after:
        query = query.where(Location.updated_at >= q.updated_after)
        count_query = count_query.where(Location.updated_at >= q.updated_after)

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(Location.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).scalars().all()

    items = [{
        "id": r.id,
        "location_id": r.location_id,
        "location_group_id": r.location_group_id,
        "location_code": r.location_code,
        "location_name": r.location_name,
        "location_full_name": r.location_full_name,
        "depth": r.depth,
        "detail_flag": r.detail_flag,
        "parent_id": r.parent_id,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}
