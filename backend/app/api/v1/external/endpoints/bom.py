"""BOM 对外接口

为外部系统提供 BOM 列表查询，支持按物料代码筛选。
"""

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.bom import Bom
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.basicdata.material import Material
from app.schemas.common import ResponseModel

from ..common import ExternalPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="/boms", tags=["主数据"])


class BomsListQuery(PageParamsMixin):
    material_code: Optional[str] = Field(None, description="物料代码精确匹配（关联 scm_material 表）")
    bom_no: Optional[str] = Field(None, description="BOM编号模糊匹配")
    bom_version: Optional[str] = Field(None, description="BOM版本号精确匹配")
    bom_type: Optional[str] = Field(None, description="BOM类型精确匹配")
    use_status: Optional[str] = Field(None, description="使用状态精确匹配")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 update_time >= 此时间的记录（ISO 8601）")


class BomOut(BaseModel):
    """BOM（对外精简字段集）"""
    bom_id: Optional[str] = Field(None, description="BOM ID")
    bom_no: Optional[str] = Field(None, description="BOM 编号")
    material_id: Optional[int] = Field(None, description="物料 ID")
    material_code: Optional[str] = Field(None, description="物料编码（未按物料筛选时为 null）")
    material_name: Optional[str] = Field(None, description="物料名称（未按物料筛选时为 null）")
    parent_bom_id: Optional[str] = Field(None, description="父 BOM ID")
    bom_version: Optional[str] = Field(None, description="BOM 版本号")
    bom_type: Optional[str] = Field(None, description="BOM 类型")
    base_qty: Optional[float] = Field(None, description="BOM 基础用量")
    unit_id: Optional[str] = Field(None, description="单位 ID")
    use_status: Optional[str] = Field(None, description="使用状态")
    disabled_status: Optional[int] = Field(None, description="禁用状态（0-否 1-是）")
    void_flag: Optional[int] = Field(None, description="作废标志（0-否 1-是）")
    update_time: Optional[datetime] = Field(None, description="更新时间（增量同步锚点）")


@router.get("/list", response_model=ResponseModel[ExternalPage[BomOut]],
            summary="BOM列表", description="endpoint_code: boms.list")
@register_external(
    "boms.list",
    "BOM列表",
    method="GET",
    path="/boms/list",
    description="BOM列表查询，支持按物料代码、BOM编号、版本号、类型、使用状态、增量同步",
    tags=["主数据"],
)
@log_external_call("boms.list")
async def boms_list(
    request: Request,
    q: Annotated[BomsListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("boms.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(Bom)
    need_join_material = False

    if q.material_code:
        need_join_material = True

    if need_join_material:
        query = query.join(Material, Bom.material_id == Material.erp_material_id)

    count_query = select(func.count()).select_from(query.subquery())

    if q.material_code:
        query = query.where(Material.material_code == q.material_code)
        count_query = select(func.count()).select_from(query.subquery())

    if q.bom_no:
        query = query.where(Bom.bom_no.ilike(f"%{q.bom_no}%"))
        count_query = select(func.count()).select_from(query.subquery())

    if q.bom_version:
        query = query.where(Bom.bom_version == q.bom_version)
        count_query = select(func.count()).select_from(query.subquery())

    if q.bom_type:
        query = query.where(Bom.bom_type == q.bom_type)
        count_query = select(func.count()).select_from(query.subquery())

    if q.use_status:
        query = query.where(Bom.use_status == q.use_status)
        count_query = select(func.count()).select_from(query.subquery())

    if q.updated_after:
        query = query.where(Bom.update_time >= q.updated_after)
        count_query = select(func.count()).select_from(query.subquery())

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(Bom.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )

    if need_join_material:
        rows = (await db.execute(query)).all()
        items = [{
            "bom_id": row.Bom.bom_id,
            "bom_no": row.Bom.bom_no,
            "material_id": row.Bom.material_id,
            "material_code": row.Material.material_code,
            "material_name": row.Material.material_name,
            "parent_bom_id": row.Bom.parent_bom_id,
            "bom_version": row.Bom.bom_version,
            "bom_type": row.Bom.bom_type,
            "base_qty": float(row.Bom.base_qty) if row.Bom.base_qty is not None else None,
            "unit_id": row.Bom.unit_id,
            "use_status": row.Bom.use_status,
            "disabled_status": row.Bom.disabled_status,
            "void_flag": row.Bom.void_flag,
            "update_time": row.Bom.update_time.isoformat() if row.Bom.update_time else None,
        } for row in rows]
    else:
        rows = (await db.execute(query)).scalars().all()
        items = [{
            "bom_id": r.bom_id,
            "bom_no": r.bom_no,
            "material_id": r.material_id,
            "material_code": None,
            "material_name": None,
            "parent_bom_id": r.parent_bom_id,
            "bom_version": r.bom_version,
            "bom_type": r.bom_type,
            "base_qty": float(r.base_qty) if r.base_qty is not None else None,
            "unit_id": r.unit_id,
            "use_status": r.use_status,
            "disabled_status": r.disabled_status,
            "void_flag": r.void_flag,
            "update_time": r.update_time.isoformat() if r.update_time else None,
        } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}
