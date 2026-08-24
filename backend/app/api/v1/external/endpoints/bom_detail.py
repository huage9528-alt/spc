"""BOM明细 对外接口

为外部系统提供 BOM明细列表查询，支持按 BOM ID、物料ID 筛选。
"""

from datetime import date, datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.bom import Bom
from app.models.basicdata.bom_detail import BomDetail
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.basicdata.material import Material
from app.schemas.common import ResponseModel

from ..common import ExternalPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="/bom-details", tags=["主数据"])


class BomDetailsListQuery(PageParamsMixin):
    bom_id: Optional[str] = Field(None, description="BOM ID 精确匹配")
    material_id: Optional[str] = Field(None, description="BOM 明细中的物料 ID 精确匹配")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 update_time >= 此时间的记录（ISO 8601）")


class BomDetailOut(BaseModel):
    """BOM 明细行（对外字段集）"""
    id: int = Field(..., description="主键")
    bom_id: Optional[str] = Field(None, description="BOM ID")
    bom_no: Optional[str] = Field(None, description="BOM 编号，取自 BOM 主表")
    line_no: Optional[str] = Field(None, description="行号")
    material_id: Optional[int] = Field(None, description="物料 ID")
    material_code: Optional[str] = Field(None, description="物料编码，取自物料主数据")
    material_name: Optional[str] = Field(None, description="物料名称")
    standard_qty: Optional[float] = Field(None, description="标准用量")
    aux_qty: Optional[float] = Field(None, description="辅助用量")
    material_type: Optional[str] = Field(None, description="物料类型")
    config_type: Optional[str] = Field(None, description="配置类型")
    lead_offset_days: Optional[int] = Field(None, description="提前期偏移天数")
    back_flush: Optional[int] = Field(None, description="是否倒冲（0-否 1-是）")
    scrap_rate: Optional[float] = Field(None, description="损耗率")
    oper_sn: Optional[str] = Field(None, description="工序号")
    process_id: Optional[str] = Field(None, description="工艺路线 ID")
    warehouse_id: Optional[str] = Field(None, description="仓库 ID")
    location_id: Optional[str] = Field(None, description="库位 ID")
    valid_date: Optional[date] = Field(None, description="生效日期")
    invalid_date: Optional[date] = Field(None, description="失效日期")
    unit_id: Optional[str] = Field(None, description="单位 ID")
    customer_bom_code: Optional[str] = Field(None, description="客户 BOM 编码")
    aux_attr_id: Optional[str] = Field(None, description="辅助属性 ID")
    material_size: Optional[str] = Field(None, description="物料尺寸")
    kit_flag: Optional[int] = Field(None, description="是否套件（0-否 1-是）")
    data_source: Optional[str] = Field(None, description="数据来源")
    create_time: Optional[datetime] = Field(None, description="创建时间")
    update_time: Optional[datetime] = Field(None, description="更新时间（增量同步锚点）")


@router.get("/list", response_model=ResponseModel[ExternalPage[BomDetailOut]],
            summary="BOM明细列表", description="endpoint_code: bom_details.list")
@register_external(
    "bom_details.list",
    "BOM明细列表",
    method="GET",
    path="/bom-details/list",
    description="BOM明细列表查询，支持按BOM ID、物料ID、增量同步",
    tags=["主数据"],
)
@log_external_call("bom_details.list")
async def bom_details_list(
    request: Request,
    q: Annotated[BomDetailsListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("bom_details.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(
        BomDetail,
        Material.material_code,
        Material.material_name,
        Bom.bom_no,
    ).outerjoin(
        Material, BomDetail.material_id == Material.erp_material_id
    ).outerjoin(
        Bom, BomDetail.bom_id == Bom.bom_id
    )

    count_query = select(func.count()).select_from(BomDetail)

    if q.bom_id:
        query = query.where(BomDetail.bom_id == q.bom_id)
        count_query = count_query.where(BomDetail.bom_id == q.bom_id)

    if q.material_id:
        query = query.where(BomDetail.material_id == q.material_id)
        count_query = count_query.where(BomDetail.material_id == q.material_id)

    if q.updated_after:
        query = query.where(BomDetail.update_time >= q.updated_after)
        count_query = count_query.where(BomDetail.update_time >= q.updated_after)

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(BomDetail.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )

    rows = (await db.execute(query)).all()

    items = [{
        "id": row.BomDetail.id,
        "bom_id": row.BomDetail.bom_id,
        "bom_no": row.bom_no,
        "line_no": row.BomDetail.line_no,
        "material_id": row.BomDetail.material_id,
        "material_code": row.material_code,
        "material_name": row.material_name,
        "standard_qty": float(row.BomDetail.standard_qty) if row.BomDetail.standard_qty is not None else None,
        "aux_qty": float(row.BomDetail.aux_qty) if row.BomDetail.aux_qty is not None else None,
        "material_type": row.BomDetail.material_type,
        "config_type": row.BomDetail.config_type,
        "lead_offset_days": row.BomDetail.lead_offset_days,
        "back_flush": row.BomDetail.back_flush,
        "scrap_rate": float(row.BomDetail.scrap_rate) if row.BomDetail.scrap_rate is not None else None,
        "oper_sn": row.BomDetail.oper_sn,
        "process_id": row.BomDetail.process_id,
        "warehouse_id": row.BomDetail.warehouse_id,
        "location_id": row.BomDetail.location_id,
        "valid_date": row.BomDetail.valid_date.isoformat() if row.BomDetail.valid_date else None,
        "invalid_date": row.BomDetail.invalid_date.isoformat() if row.BomDetail.invalid_date else None,
        "unit_id": row.BomDetail.unit_id,
        "customer_bom_code": row.BomDetail.customer_bom_code,
        "aux_attr_id": row.BomDetail.aux_attr_id,
        "material_size": row.BomDetail.material_size,
        "kit_flag": row.BomDetail.kit_flag,
        "data_source": row.BomDetail.data_source,
        "create_time": row.BomDetail.create_time.isoformat() if row.BomDetail.create_time else None,
        "update_time": row.BomDetail.update_time.isoformat() if row.BomDetail.update_time else None,
    } for row in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}
