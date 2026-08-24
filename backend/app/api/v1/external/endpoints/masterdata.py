"""基础主数据对外接口

为外部系统提供客户 / 供应商 / 物料 / 产品 主数据查询。
区别于内部 /api/v1/* 的复杂逻辑，对外只暴露精简字段集与常用筛选条件，
且字段集合独立于表结构变更。
"""

from datetime import date, datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.customer import Customer
from app.models.basicdata.supplier import Supplier
from app.models.basicdata.material import Material
from app.models.basicdata.product import Product
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.schemas.common import ResponseModel

from ..common import ExternalPage, IntCsv, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="", tags=["主数据"])


# ═══════════════════════════════════════════
# 客户
# ═══════════════════════════════════════════

class CustomersListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（客户编码 / 客户名称 / 简称 模糊匹配）")
    customer_level: Optional[str] = Field(None, description="客户等级，多选逗号分隔")
    industry_type: Optional[str] = Field(None, description="所属行业")
    status: IntCsv = Field(None, description="状态，多选逗号分隔（1-启用 0-禁用），如 1,0")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 update_time >= 此时间的记录（ISO 8601）")


class CustomerOut(BaseModel):
    """客户主数据（对外精简字段集）"""
    id: int = Field(..., description="主键")
    customer_code: Optional[str] = Field(None, description="客户编码")
    customer_name: Optional[str] = Field(None, description="客户名称")
    customer_short: Optional[str] = Field(None, description="客户简称")
    customer_level: Optional[str] = Field(None, description="客户等级")
    industry_type: Optional[str] = Field(None, description="所属行业")
    credit_code: Optional[str] = Field(None, description="统一社会信用代码")
    status: Optional[int] = Field(None, description="状态（1-启用 0-禁用）")
    update_time: Optional[datetime] = Field(None, description="更新时间（增量同步锚点）")


@router.get("/customers/list", response_model=ResponseModel[ExternalPage[CustomerOut]],
            summary="客户列表", description="endpoint_code: customers.list")
@register_external(
    "customers.list",
    "客户列表",
    method="GET",
    path="/customers/list",
    description="客户主数据列表查询，支持关键字、客户等级、行业、状态、增量同步",
    tags=["主数据"],
)
@log_external_call("customers.list")
async def customers_list(
    request: Request,
    q: Annotated[CustomersListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("customers.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(Customer)
    count_query = select(func.count()).select_from(query.subquery())

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            Customer.customer_code.ilike(like_expr),
            Customer.customer_name.ilike(like_expr),
            Customer.customer_short.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = select(func.count()).select_from(query.subquery())

    if q.customer_level:
        levels = [s.strip() for s in q.customer_level.split(",") if s.strip()]
        if len(levels) == 1:
            query = query.where(Customer.customer_level == levels[0])
        elif levels:
            query = query.where(Customer.customer_level.in_(levels))
        count_query = select(func.count()).select_from(query.subquery())

    if q.industry_type:
        query = query.where(Customer.industry_type == q.industry_type)
        count_query = select(func.count()).select_from(query.subquery())

    if q.status:
        query = query.where(Customer.status.in_(q.status))
        count_query = select(func.count()).select_from(query.subquery())

    if q.updated_after:
        query = query.where(Customer.update_time >= q.updated_after)
        count_query = select(func.count()).select_from(query.subquery())

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(Customer.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).scalars().all()

    items = [{
        "id": r.id,
        "customer_code": r.customer_code,
        "customer_name": r.customer_name,
        "customer_short": r.customer_short,
        "customer_level": r.customer_level,
        "industry_type": r.industry_type,
        "credit_code": r.credit_code,
        "status": r.status,
        "update_time": r.update_time.isoformat() if r.update_time else None,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ═══════════════════════════════════════════
# 供应商
# ═══════════════════════════════════════════

class SuppliersListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（供应商编码 / 名称 / 简称 模糊匹配）")
    supplier_type: Optional[str] = Field(None, description="供应商类型精确匹配")
    status: IntCsv = Field(None, description="状态，多选逗号分隔（1-启用 0-禁用），如 1,0")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 update_time >= 此时间的记录（ISO 8601）")


class SupplierOut(BaseModel):
    """供应商主数据（对外精简字段集，联系电话脱敏）"""
    id: int = Field(..., description="主键")
    supplier_code: Optional[str] = Field(None, description="供应商编码")
    supplier_name: Optional[str] = Field(None, description="供应商名称")
    supplier_short: Optional[str] = Field(None, description="供应商简称")
    supplier_type: Optional[str] = Field(None, description="供应商类型")
    contact_person: Optional[str] = Field(None, description="联系人")
    contact_phone: Optional[str] = Field(None, description="联系电话（脱敏）")
    payment_terms: Optional[str] = Field(None, description="付款条件")
    status: Optional[int] = Field(None, description="状态（1-启用 0-禁用）")
    update_time: Optional[datetime] = Field(None, description="更新时间（增量同步锚点）")


@router.get("/suppliers/list", response_model=ResponseModel[ExternalPage[SupplierOut]],
            summary="供应商列表", description="endpoint_code: suppliers.list")
@register_external(
    "suppliers.list",
    "供应商列表",
    method="GET",
    path="/suppliers/list",
    description="供应商主数据列表查询，支持关键字、类型、状态、增量同步（联系电话脱敏）",
    tags=["主数据"],
)
@log_external_call("suppliers.list")
async def suppliers_list(
    request: Request,
    q: Annotated[SuppliersListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("suppliers.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(Supplier)
    count_query = select(func.count()).select_from(query.subquery())

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            Supplier.supplier_code.ilike(like_expr),
            Supplier.supplier_name.ilike(like_expr),
            Supplier.supplier_short.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = select(func.count()).select_from(query.subquery())

    if q.supplier_type:
        query = query.where(Supplier.supplier_type == q.supplier_type)
        count_query = select(func.count()).select_from(query.subquery())

    if q.status:
        query = query.where(Supplier.status.in_(q.status))
        count_query = select(func.count()).select_from(query.subquery())

    if q.updated_after:
        query = query.where(Supplier.update_time >= q.updated_after)
        count_query = select(func.count()).select_from(query.subquery())

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(Supplier.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).scalars().all()

    def _mask_phone(v):
        if not v or len(v) < 7:
            return v
        return v[:3] + "****" + v[-4:]

    items = [{
        "id": r.id,
        "supplier_code": r.supplier_code,
        "supplier_name": r.supplier_name,
        "supplier_short": r.supplier_short,
        "supplier_type": r.supplier_type,
        "contact_person": r.contact_person,
        "contact_phone": _mask_phone(r.contact_phone),
        "payment_terms": r.payment_terms,
        "status": r.status,
        "update_time": r.update_time.isoformat() if r.update_time else None,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ═══════════════════════════════════════════
# 物料
# ═══════════════════════════════════════════

class MaterialsListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（物料编码 / 名称 / 规格型号 模糊匹配）")
    material_type: Optional[str] = Field(None, description="物料分类精确匹配")
    is_purchase: Optional[int] = Field(None, description="是否可采购 (0/1)")
    is_produce: Optional[int] = Field(None, description="是否可生产 (0/1)")
    status: IntCsv = Field(None, description="状态，多选逗号分隔（1-启用 0-禁用），如 1,0")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 update_time >= 此时间的记录（ISO 8601）")


class MaterialOut(BaseModel):
    """物料主数据（对外精简字段集）"""
    id: int = Field(..., description="主键")
    erp_material_id: Optional[int] = Field(None, description="物料ERP内部ID")
    material_code: Optional[str] = Field(None, description="物料编码")
    material_name: Optional[str] = Field(None, description="物料名称")
    spec_model: Optional[str] = Field(None, description="规格型号")
    material_type: Optional[str] = Field(None, description="物料分类")
    unit_of_measure: Optional[str] = Field(None, description="计量单位")
    brand: Optional[str] = Field(None, description="品牌")
    is_purchase: Optional[int] = Field(None, description="是否可采购（1-是 0-否）")
    is_produce: Optional[int] = Field(None, description="是否可生产（1-是 0-否）")
    status: Optional[int] = Field(None, description="状态（1-启用 0-禁用）")
    supplier_id: Optional[int] = Field(None, description="供应商ID（ERP内部）")
    supplier_name: Optional[str] = Field(None, description="供应商名称")
    order_unit_price: Optional[float] = Field(None, description="订单单价")
    last_outbound_date: Optional[date] = Field(None, description="最近出库日期")
    update_time: Optional[datetime] = Field(None, description="更新时间（增量同步锚点）")


@router.get("/materials/list", response_model=ResponseModel[ExternalPage[MaterialOut]],
            summary="物料列表", description="endpoint_code: materials.list")
@register_external(
    "materials.list",
    "物料列表",
    method="GET",
    path="/materials/list",
    description="物料主数据列表查询，支持关键字、物料分类、采购/生产属性、状态、增量同步",
    tags=["主数据"],
)
@log_external_call("materials.list")
async def materials_list(
    request: Request,
    q: Annotated[MaterialsListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("materials.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    # 默认排除已删除物料；左连接供应商取名称（保留无供应商的物料）
    # 注：Material.supplier_id 存储的是 ERP 供应商内部ID，需关联 Supplier.erp_supply_id
    query = (
        select(Material, Supplier.supplier_name)
        .outerjoin(Supplier, Material.supplier_id == Supplier.erp_supply_id)
        .where(Material.is_deleted == 0)
    )
    count_query = select(func.count()).select_from(query.subquery())

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            Material.material_code.ilike(like_expr),
            Material.material_name.ilike(like_expr),
            Material.spec_model.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = select(func.count()).select_from(query.subquery())

    if q.material_type:
        query = query.where(Material.material_type == q.material_type)
        count_query = select(func.count()).select_from(query.subquery())

    if q.is_purchase is not None:
        query = query.where(Material.is_purchase == q.is_purchase)
        count_query = select(func.count()).select_from(query.subquery())

    if q.is_produce is not None:
        query = query.where(Material.is_produce == q.is_produce)
        count_query = select(func.count()).select_from(query.subquery())

    if q.status:
        query = query.where(Material.status.in_(q.status))
        count_query = select(func.count()).select_from(query.subquery())

    if q.updated_after:
        query = query.where(Material.update_time >= q.updated_after)
        count_query = select(func.count()).select_from(query.subquery())

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(Material.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).all()

    items = [{
        "id": m.id,
        "erp_material_id": m.erp_material_id,
        "material_code": m.material_code,
        "material_name": m.material_name,
        "spec_model": m.spec_model,
        "material_type": m.material_type,
        "unit_of_measure": m.unit_of_measure,
        "brand": m.brand,
        "is_purchase": m.is_purchase,
        "is_produce": m.is_produce,
        "status": m.status,
        "supplier_id": m.supplier_id,
        "supplier_name": supplier_name,
        "order_unit_price": float(m.order_unit_price) if m.order_unit_price is not None else None,
        "last_outbound_date": m.last_outbound_date.isoformat() if m.last_outbound_date else None,
        "update_time": m.update_time.isoformat() if m.update_time else None,
    } for m, supplier_name in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ═══════════════════════════════════════════
# 产品
# ═══════════════════════════════════════════

class ProductsListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（产品编码模糊匹配）")
    product_line: Optional[str] = Field(None, description="产品线精确匹配")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 update_time >= 此时间的记录（ISO 8601）")


class ProductOut(BaseModel):
    """产品主数据（对外精简字段集）"""
    id: int = Field(..., description="主键")
    product_code: Optional[str] = Field(None, description="产品编码")
    product_line: Optional[str] = Field(None, description="产品线")
    tech_version: Optional[str] = Field(None, description="技术版本")
    bom_version: Optional[str] = Field(None, description="BOM版本")
    default_warehouse: Optional[str] = Field(None, description="默认仓库")
    warranty_days: Optional[int] = Field(None, description="质保天数")
    upph: Optional[float] = Field(None, description="UPPH人均时产量")
    update_time: Optional[datetime] = Field(None, description="更新时间（增量同步锚点）")


@router.get("/products/list", response_model=ResponseModel[ExternalPage[ProductOut]],
            summary="产品列表", description="endpoint_code: products.list")
@register_external(
    "products.list",
    "产品列表",
    method="GET",
    path="/products/list",
    description="产品主数据列表查询，支持关键字、产品线、增量同步",
    tags=["主数据"],
)
@log_external_call("products.list")
async def products_list(
    request: Request,
    q: Annotated[ProductsListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("products.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(Product)
    count_query = select(func.count()).select_from(query.subquery())

    if q.keyword:
        query = query.where(Product.product_code.ilike(f"%{q.keyword}%"))
        count_query = select(func.count()).select_from(query.subquery())

    if q.product_line:
        query = query.where(Product.product_line == q.product_line)
        count_query = select(func.count()).select_from(query.subquery())

    if q.updated_after:
        query = query.where(Product.update_time >= q.updated_after)
        count_query = select(func.count()).select_from(query.subquery())

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(Product.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).scalars().all()

    items = [{
        "id": r.id,
        "product_code": r.product_code,
        "product_line": r.product_line,
        "tech_version": r.tech_version,
        "bom_version": r.bom_version,
        "default_warehouse": r.default_warehouse,
        "warranty_days": r.warranty_days,
        "upph": float(r.upph) if r.upph is not None else None,
        "update_time": r.update_time.isoformat() if r.update_time else None,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}
