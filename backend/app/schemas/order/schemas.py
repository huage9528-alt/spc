"""订单交付中心 — Schema定义"""

from typing import Optional, List
from datetime import date, datetime
from pydantic import BaseModel


# ── SaleOrder ──
class SaleOrderOut(BaseModel):
    id: int
    order_no: str
    line_no: Optional[str] = None
    customer: Optional[str] = None
    customer_code: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    order_qty: Optional[float] = None
    order_amount: Optional[float] = None
    completed_qty: Optional[float] = None
    promised_date: Optional[date] = None
    planned_start_date: Optional[date] = None
    batch_no: Optional[str] = None
    department: Optional[str] = None
    audit_date: Optional[date] = None
    owner: Optional[str] = None
    status: str = "open"
    erp_id: Optional[int] = None
    erp_status: Optional[int] = None
    risk_level: Optional[str] = None
    extra_data: Optional[dict] = None
    data_source: Optional[str] = None
    order_nature: Optional[str] = None
    order_date: Optional[date] = None
    # ── 点检新增字段 ──
    delivery_completed_date: Optional[date] = None
    customer_grade: Optional[str] = None
    shipping_plan: Optional[date] = None
    customer_inspection_date: Optional[date] = None
    inspection_result: Optional[str] = None
    packaging_status: Optional[str] = None
    bom_return_date: Optional[date] = None
    material_ready_date: Optional[date] = None
    shipping_status_desc: Optional[str] = None
    procurement_status: Optional[str] = None
    material_dates: Optional[dict] = None
    front_process_date: Optional[date] = None
    first_article_date: Optional[date] = None
    assembly_start_date: Optional[date] = None
    assembly_complete_date: Optional[date] = None
    is_closed: int = 0
    remark: Optional[str] = None
    # ── 风险评估字段 ──
    risk_score: Optional[float] = None
    risk_factors: Optional[dict] = None
    risk_assessed_at: Optional[datetime] = None
    field_synced_at: Optional[dict] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class SaleOrderLineOut(BaseModel):
    id: int
    erp_line_id: Optional[str] = None
    order_no: str
    line_no: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    product_model: Optional[str] = None
    order_qty: Optional[float] = None
    order_amount: Optional[float] = None
    promised_date: Optional[date] = None
    planned_start_date: Optional[date] = None
    batch_no: Optional[str] = None
    bom_no: Optional[str] = None
    bom_id: Optional[int] = None
    labor_price_amount: Optional[float] = None
    status: str = "open"

    model_config = {"from_attributes": True}


class SaleOrderListOut(SaleOrderOut):
    product_count: int = 0
    line_count: int = 0
    shortage_count: int = 0
    kit_rate: Optional[float] = None
    kit_status: Optional[str] = None
    kit_risk_level: Optional[str] = None
    kit_total_materials: int = 0
    kit_received_materials: int = 0
    shipping_plan_change_count: int = 0


class ShippingPlanHistoryItem(BaseModel):
    id: int
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    operator: Optional[str] = None
    operated_at: Optional[str] = None


class SaleOrderUpdate(BaseModel):
    customer: Optional[str] = None
    customer_code: Optional[str] = None
    department: Optional[str] = None
    owner: Optional[str] = None
    status: Optional[str] = None
    completed_qty: Optional[float] = None
    order_amount: Optional[float] = None
    risk_level: Optional[str] = None
    order_nature: Optional[str] = None
    order_date: Optional[date] = None
    planned_start_date: Optional[date] = None
    delivery_completed_date: Optional[date] = None
    customer_grade: Optional[str] = None
    shipping_plan: Optional[date] = None
    customer_inspection_date: Optional[date] = None
    inspection_result: Optional[str] = None
    packaging_status: Optional[str] = None
    bom_return_date: Optional[date] = None
    material_ready_date: Optional[date] = None
    shipping_status_desc: Optional[str] = None
    procurement_status: Optional[str] = None
    material_dates: Optional[dict] = None
    front_process_date: Optional[date] = None
    first_article_date: Optional[date] = None
    assembly_start_date: Optional[date] = None
    assembly_complete_date: Optional[date] = None
    is_closed: Optional[int] = None
    remark: Optional[str] = None


class SaleOrderLineCreate(BaseModel):
    line_no: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    product_model: Optional[str] = None
    order_qty: Optional[float] = None
    order_amount: Optional[float] = None
    promised_date: Optional[date] = None
    planned_start_date: Optional[date] = None
    batch_no: Optional[str] = None
    bom_no: Optional[str] = None
    bom_id: Optional[int] = None


class OrderCreate(BaseModel):
    sale_order: SaleOrderOut
    lines: List[SaleOrderLineCreate] = []


# ── MaterialDemand ──
class MaterialDemandOut(BaseModel):
    id: int
    order_no: str
    line_no: Optional[str] = None
    material_code: str
    material_name: Optional[str] = None
    material_property: Optional[int] = None
    material_type_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit: Optional[str] = None
    req_qty: Optional[float] = None
    req_date: Optional[date] = None
    allocated_qty: float = 0
    shortage_qty: float = 0
    shortage_flag: bool = False

    model_config = {"from_attributes": True}


# ── Binding & PO detail ──
class PODetail(BaseModel):
    po_no: str
    material_code: str
    supplier_code: Optional[str] = None
    supplier_name: Optional[str] = None
    material_type_name: Optional[str] = None
    material_name: Optional[str] = None
    po_qty: Optional[float] = None
    po_price: Optional[float] = None
    po_date: Optional[date] = None
    po_status: str
    eta: Optional[date] = None
    original_eta: Optional[date] = None
    actual_arrival_date: Optional[date] = None
    owner: Optional[str] = None
    remark: Optional[str] = None
    data_source: Optional[str] = None

    model_config = {"from_attributes": True}


class BindingOut(BaseModel):
    id: int
    order_no: str
    line_no: Optional[str] = None
    material_code: str
    po_no: Optional[str] = None
    bound_qty: Optional[float] = None
    bind_status: str
    bind_source: str
    po_detail: Optional[PODetail] = None
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ── RiskIssue (in order detail context) ──
class RiskIssueOut(BaseModel):
    id: int
    issue_no: str
    issue_type: str
    risk_level: str
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    material_code: Optional[str] = None
    po_no: Optional[str] = None
    description: Optional[str] = None
    owner: Optional[str] = None
    action_taken: Optional[str] = None
    commit_date: Optional[date] = None
    status: str
    closed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ── RunOrder ──
class RunOrderOut(BaseModel):
    id: Optional[int] = None
    customer_code: Optional[str] = None
    order_no: str
    order_qty: Optional[float] = None
    order_type: Optional[str] = None
    contract_date: Optional[date] = None
    delivery_date: Optional[date] = None
    run_date: Optional[date] = None
    run_days: Optional[int] = None
    order_amount: Optional[float] = None
    packaging_not_released: Optional[str] = None
    po_placed_date: Optional[date] = None
    material_ready_date: Optional[date] = None
    procurement_cycle: Optional[int] = None
    completed_date: Optional[date] = None
    shipped_date: Optional[date] = None
    order_status: Optional[str] = None
    delay_reason: Optional[str] = None
    remark: Optional[str] = None
    is_domestic: bool = False
    is_synced: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class RunOrderCreate(BaseModel):
    customer_code: Optional[str] = None
    order_no: str
    order_qty: Optional[float] = None
    order_type: Optional[str] = None
    contract_date: Optional[date] = None
    delivery_date: Optional[date] = None
    run_date: Optional[date] = None
    run_days: Optional[int] = None
    order_amount: Optional[float] = None
    packaging_not_released: Optional[str] = None
    po_placed_date: Optional[date] = None
    material_ready_date: Optional[date] = None
    procurement_cycle: Optional[int] = None
    completed_date: Optional[date] = None
    shipped_date: Optional[date] = None
    order_status: Optional[str] = None
    delay_reason: Optional[str] = None
    remark: Optional[str] = None
    is_domestic: Optional[bool] = False


class RunOrderUpdate(BaseModel):
    customer_code: Optional[str] = None
    order_qty: Optional[float] = None
    order_type: Optional[str] = None
    contract_date: Optional[date] = None
    delivery_date: Optional[date] = None
    run_date: Optional[date] = None
    run_days: Optional[int] = None
    order_amount: Optional[float] = None
    packaging_not_released: Optional[str] = None
    po_placed_date: Optional[date] = None
    material_ready_date: Optional[date] = None
    procurement_cycle: Optional[int] = None
    completed_date: Optional[date] = None
    shipped_date: Optional[date] = None
    order_status: Optional[str] = None
    delay_reason: Optional[str] = None
    remark: Optional[str] = None
    is_domestic: Optional[bool] = None


class RunOrderListOut(BaseModel):
    total: int
    page: int
    page_size: int
    items: List[RunOrderOut]


# ── OrderDetail ──
class OrderDetailOut(SaleOrderOut):
    lines: List[SaleOrderLineOut] = []
    material_demands: List[MaterialDemandOut] = []
    bindings: List[BindingOut] = []
    shortage_count: int = 0
    in_transit_count: int = 0
    latest_eta: Optional[date] = None
    issues: List[RiskIssueOut] = []


class ProductMaterialItemOut(BaseModel):
    material_code: str
    material_name: Optional[str] = None
    material_property: Optional[int] = None
    material_property_label: Optional[str] = None
    material_type: Optional[str] = None
    spec_model: Optional[str] = None
    unit: Optional[str] = None
    req_qty: Optional[float] = None
    req_date: Optional[date] = None
    allocated_qty: float = 0
    shortage_qty: float = 0
    shortage_flag: bool = False
    status: str
    status_label: str
    po_no: Optional[str] = None
    supplier_name: Optional[str] = None
    po_qty: Optional[float] = None
    received_qty: Optional[float] = None
    eta: Optional[date] = None
    first_eta: Optional[date] = None
    latest_eta: Optional[date] = None
    actual_arrival_date: Optional[date] = None
    inspection_date: Optional[date] = None
    po_count: int = 0
    is_stagnant: bool = False
    stagnant_qty: Optional[float] = None
    is_closed: int = 0


class BomDetailItemOut(BaseModel):
    material_id: Optional[str] = None
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit: Optional[str] = None
    material_type: Optional[str] = None
    material_property: Optional[int] = None
    line_no: Optional[str] = None
    standard_qty: Optional[float] = None
    aux_qty: Optional[float] = None
    config_type: Optional[str] = None
    lead_offset_days: Optional[int] = None
    back_flush: Optional[int] = None
    scrap_rate: Optional[float] = None
    oper_sn: Optional[str] = None
    process_id: Optional[str] = None
    warehouse_id: Optional[str] = None
    valid_date: Optional[date] = None
    invalid_date: Optional[date] = None
    kit_flag: Optional[int] = None
    req_qty: Optional[float] = None
    level: int = 1
    bom_id: Optional[str] = None
    parent_material_id: Optional[int] = None
    has_sub_bom: bool = False
    children: List["BomDetailItemOut"] = []


class OrderProductMaterialsOut(BaseModel):
    line_no: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    product_model: Optional[str] = None
    bom_no: Optional[str] = None
    bom_id: Optional[str] = None
    order_qty: Optional[float] = None
    promised_date: Optional[date] = None
    total_materials: int = 0
    not_ordered_count: int = 0
    shortage_count: int = 0
    overdue_count: int = 0
    arrived_count: int = 0
    kit_rate: float = 0
    materials: List[BomDetailItemOut] = []
