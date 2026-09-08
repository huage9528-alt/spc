"""基础数据与集成中心 — Schema定义"""

from typing import Optional, List
from datetime import datetime, date
from decimal import Decimal
from pydantic import BaseModel


# ── Auth ──
class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserInfo(BaseModel):
    id: int
    username: str
    display_name: Optional[str] = None
    role_code: Optional[str] = None
    role_name: Optional[str] = None
    permissions: Optional[dict] = None
    supplier_name: Optional[str] = None
    supplier_code: Optional[str] = None
    is_active: bool = True
    font_size_scale: Optional[str] = None
    ui_preferences: Optional[dict] = None
    is_default_password: bool = True
    login_version: int = 0
    position_name: Optional[str] = None
    wecom_user_id: Optional[str] = None

    model_config = {"from_attributes": True}


class LoginRequest(BaseModel):
    username: str
    password: str


# ── AuditLog ──
class AuditLogOut(BaseModel):
    id: int
    table_name: str
    record_id: int
    action: str
    field_name: Optional[str] = None
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    operator: Optional[str] = None
    operated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ── Customer ──
class CustomerBase(BaseModel):
    customer_code: str
    customer_name: str
    customer_short: Optional[str] = None
    customer_level: Optional[str] = None
    industry_type: Optional[str] = None
    credit_code: Optional[str] = None
    status: int = 1


class CustomerCreate(CustomerBase):
    pass


class CustomerUpdate(BaseModel):
    customer_name: Optional[str] = None
    customer_short: Optional[str] = None
    customer_level: Optional[str] = None
    industry_type: Optional[str] = None
    credit_code: Optional[str] = None
    status: Optional[int] = None


class CustomerOut(CustomerBase):
    id: int
    create_time: datetime
    update_time: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ── Supplier ──
class SupplierBase(BaseModel):
    supplier_code: str
    supplier_name: str
    supplier_short: Optional[str] = None
    supplier_type: Optional[str] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    fax: Optional[str] = None
    address: Optional[str] = None
    erp_supply_id: Optional[int] = None
    payment_terms: Optional[str] = None
    status: int = 1


class SupplierCreate(SupplierBase):
    pass


class SupplierUpdate(BaseModel):
    supplier_name: Optional[str] = None
    supplier_short: Optional[str] = None
    supplier_type: Optional[str] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    fax: Optional[str] = None
    address: Optional[str] = None
    erp_supply_id: Optional[int] = None
    payment_terms: Optional[str] = None
    status: Optional[int] = None


class SupplierOut(SupplierBase):
    id: int
    create_time: datetime
    update_time: Optional[datetime] = None

    model_config = {"from_attributes": True}


class SupplierMatchRequest(BaseModel):
    names: List[str]


class SupplierMatchItem(BaseModel):
    input_name: str
    supplier_id: int
    supplier_name: str
    supplier_code: Optional[str] = None
    supplier_short: Optional[str] = None
    erp_supply_id: Optional[int] = None
    ambiguous: bool = False


class SupplierMatchResult(BaseModel):
    matched: List[SupplierMatchItem]
    unmatched: List[str]


# ── Material ──
class MaterialBase(BaseModel):
    erp_material_id: int
    parent_id: Optional[int] = None
    material_code: str
    material_name: str
    spec_model: Optional[str] = None
    material_type: str
    unit_of_measure: str
    brand: Optional[str] = None
    is_purchase: int = 0
    is_produce: int = 0
    status: int = 1
    erp_sync_flag: int = 0
    is_deleted: int = 0
    material_property: Optional[int] = None
    supplier_id: Optional[int] = None
    order_unit_price: Optional[Decimal] = None
    last_outbound_date: Optional[date] = None


class MaterialCreate(MaterialBase):
    pass


class MaterialUpdate(BaseModel):
    parent_id: Optional[int] = None
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    material_type: Optional[str] = None
    unit_of_measure: Optional[str] = None
    brand: Optional[str] = None
    is_purchase: Optional[int] = None
    is_produce: Optional[int] = None
    status: Optional[int] = None
    erp_sync_flag: Optional[int] = None
    is_deleted: Optional[int] = None
    material_property: Optional[int] = None
    supplier_id: Optional[int] = None
    order_unit_price: Optional[Decimal] = None
    last_outbound_date: Optional[date] = None


class MaterialOut(MaterialBase):
    id: int
    data_source: Optional[str] = None
    create_time: Optional[datetime] = None
    update_time: Optional[datetime] = None
    supplier_name: Optional[str] = None

    model_config = {"from_attributes": True}


class MaterialTreeNode(BaseModel):
    id: int
    erp_material_id: int
    parent_id: Optional[int] = None
    material_code: str
    material_name: str
    spec_model: Optional[str] = None
    material_type: str
    unit_of_measure: str
    brand: Optional[str] = None
    is_purchase: int = 0
    is_produce: int = 0
    status: int = 1
    material_property: Optional[int] = None
    supplier_id: Optional[int] = None
    order_unit_price: Optional[Decimal] = None
    last_outbound_date: Optional[date] = None
    data_source: Optional[str] = None
    erp_sync_flag: int = 0
    children: List["MaterialTreeNode"] = []

    model_config = {"from_attributes": True}


# ── SKU ──
class SKUBase(BaseModel):
    sku_code: str
    material_id: int
    sku_name: str
    attr_json: Optional[str] = None
    barcode: Optional[str] = None
    gross_weight: Optional[Decimal] = None
    net_weight: Optional[Decimal] = None
    volume: Optional[Decimal] = None


class SKUCreate(SKUBase):
    pass


class SKUUpdate(BaseModel):
    material_id: Optional[int] = None
    sku_name: Optional[str] = None
    attr_json: Optional[str] = None
    barcode: Optional[str] = None
    gross_weight: Optional[Decimal] = None
    net_weight: Optional[Decimal] = None
    volume: Optional[Decimal] = None


class SKUOut(SKUBase):
    id: int
    create_time: datetime

    model_config = {"from_attributes": True}


# ── Product ──
class ProductBase(BaseModel):
    product_code: str
    product_line: Optional[str] = None
    tech_version: Optional[str] = None
    bom_version: Optional[str] = None
    default_warehouse: Optional[str] = None
    warranty_days: Optional[int] = None


class ProductCreate(ProductBase):
    pass


class ProductUpdate(BaseModel):
    product_line: Optional[str] = None
    tech_version: Optional[str] = None
    bom_version: Optional[str] = None
    default_warehouse: Optional[str] = None
    warranty_days: Optional[int] = None


class ProductOut(ProductBase):
    id: int
    create_time: datetime
    update_time: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ── Warehouse ──
class WarehouseBase(BaseModel):
    wh_id: Optional[int] = None
    parent_wh_id: Optional[int] = None
    wh_code: str
    wh_name: str
    wh_type: Optional[str] = None
    address: Optional[str] = None
    manager_id: Optional[int] = None
    is_enabled: int = 1


class WarehouseCreate(WarehouseBase):
    pass


class WarehouseUpdate(BaseModel):
    wh_id: Optional[int] = None
    parent_wh_id: Optional[int] = None
    wh_name: Optional[str] = None
    wh_type: Optional[str] = None
    address: Optional[str] = None
    manager_id: Optional[int] = None
    is_enabled: Optional[int] = None


class WarehouseOut(WarehouseBase):
    id: int
    create_time: datetime

    model_config = {"from_attributes": True}


# ── Location ──
class LocationBase(BaseModel):
    location_id: int
    location_group_id: Optional[int] = None
    location_code: Optional[str] = None
    location_name: Optional[str] = None
    location_full_name: Optional[str] = None
    depth: Optional[int] = 0
    detail_flag: Optional[int] = 0
    parent_id: Optional[int] = None
    is_deleted: Optional[int] = 0
    system_type: Optional[int] = 0
    data_source: Optional[str] = None


class LocationCreate(LocationBase):
    pass


class LocationUpdate(BaseModel):
    location_group_id: Optional[int] = None
    location_code: Optional[str] = None
    location_name: Optional[str] = None
    location_full_name: Optional[str] = None
    depth: Optional[int] = None
    detail_flag: Optional[int] = None
    parent_id: Optional[int] = None
    is_deleted: Optional[int] = None
    system_type: Optional[int] = None


class LocationOut(LocationBase):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Process ──
class ProcessBase(BaseModel):
    process_code: str
    process_name: str
    process_group: Optional[str] = None
    standard_hour: Optional[Decimal] = None
    work_center: Optional[str] = None
    is_qc_point: int = 0
    description: Optional[str] = None


class ProcessCreate(ProcessBase):
    pass


class ProcessUpdate(BaseModel):
    process_name: Optional[str] = None
    process_group: Optional[str] = None
    standard_hour: Optional[Decimal] = None
    work_center: Optional[str] = None
    is_qc_point: Optional[int] = None
    description: Optional[str] = None


class ProcessOut(ProcessBase):
    id: int

    model_config = {"from_attributes": True}


# ── Organization ──
class OrganizationBase(BaseModel):
    org_code: str
    org_name: str
    org_type: str
    parent_id: Optional[int] = None
    leader_id: Optional[int] = None
    oa_org_id: Optional[str] = None
    status: int = 1
    data_source: Optional[str] = None


class OrganizationCreate(OrganizationBase):
    pass


class OrganizationUpdate(BaseModel):
    org_name: Optional[str] = None
    org_type: Optional[str] = None
    parent_id: Optional[int] = None
    leader_id: Optional[int] = None
    oa_org_id: Optional[str] = None
    status: Optional[int] = None
    data_source: Optional[str] = None


class OrganizationOut(OrganizationBase):
    id: int

    model_config = {"from_attributes": True}


class OrganizationTreeNode(BaseModel):
    id: int
    org_code: str
    org_name: str
    org_type: str
    parent_id: Optional[int] = None
    leader_id: Optional[int] = None
    leader_name: Optional[str] = None
    oa_org_id: Optional[str] = None
    status: int = 1
    data_source: Optional[str] = None
    children: List["OrganizationTreeNode"] = []

    model_config = {"from_attributes": True}


class OrganizationWithLeaderOut(OrganizationOut):
    leader_name: Optional[str] = None

    model_config = {"from_attributes": True}


# ── Employee ──
class PositionBase(BaseModel):
    position_code: Optional[str] = None
    oa_position_id: Optional[str] = None
    position_name: str
    status: int = 1
    data_source: Optional[str] = None


class PositionOut(PositionBase):
    id: int
    create_time: datetime

    model_config = {"from_attributes": True}


class EmployeeBase(BaseModel):
    emp_code: str
    emp_name: str
    org_id: Optional[int] = None
    position_id: Optional[int] = None
    manager_oa_user_id: Optional[str] = None
    erp_user_id: Optional[int] = None
    position: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    status: int = 1


class EmployeeCreate(EmployeeBase):
    pass


class EmployeeUpdate(BaseModel):
    emp_name: Optional[str] = None
    org_id: Optional[int] = None
    position_id: Optional[int] = None
    manager_oa_user_id: Optional[str] = None
    erp_user_id: Optional[int] = None
    position: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    status: Optional[int] = None


class EmployeeOut(EmployeeBase):
    id: int
    create_time: datetime
    position_name: Optional[str] = None
    manager_name: Optional[str] = None

    model_config = {"from_attributes": True}


# ── SubjectBalance (科目余额) ──
class SubjectBalanceBase(BaseModel):
    subject_category: Optional[str] = None
    subject_id: int
    subject_name: Optional[str] = None
    subject_code: Optional[str] = None
    item_code: str = ""
    item_name: Optional[str] = None
    parent_subject_id: Optional[int] = None
    fiscal_year: int
    fiscal_month: int
    credit_amount_month: Decimal = Decimal("0")
    credit_amount_year: Decimal = Decimal("0")


class SubjectBalanceOut(SubjectBalanceBase):
    id: int
    data_source: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# 科目树节点(按 subject 聚合，一个科目一行)
class SubjectNodeOut(BaseModel):
    subject_id: int
    subject_category: Optional[str] = None
    subject_name: Optional[str] = None
    subject_code: Optional[str] = None
    parent_subject_id: Optional[int] = None
    item_code: str = ""
    item_name: Optional[str] = None
    period_count: int = 0
    has_children: bool = False
    child_count: int = 0
    latest_year: Optional[int] = None
    latest_month: Optional[int] = None
    credit_amount_month: Decimal = Decimal("0")
    credit_amount_year: Decimal = Decimal("0")

    model_config = {"from_attributes": True}
