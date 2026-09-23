"""物料占用分析 — 响应模型"""

from datetime import date
from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel


class OccupancyOrderRow(BaseModel):
    """按物料视角：单条订单产品行的占用结果"""

    order_no: str
    line_no: str
    customer: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    promised_date: Optional[date] = None
    order_qty: Decimal = Decimal("0")
    completed_qty: Decimal = Decimal("0")
    open_qty: Decimal = Decimal("0")
    unit_qty: Decimal = Decimal("0")
    scrap_rate: Optional[Decimal] = None
    demand_qty: Decimal = Decimal("0")
    available_qty: Decimal = Decimal("0")
    allocated_qty: Decimal = Decimal("0")
    shortage_qty: Decimal = Decimal("0")
    status: str


class MaterialOccupancyResponse(BaseModel):
    material_code: str
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit_of_measure: Optional[str] = None
    material_property: Optional[int] = None
    stock_qty: Decimal = Decimal("0")
    transit_qty: Decimal = Decimal("0")
    order_count: int = 0
    total_demand_qty: Decimal = Decimal("0")
    total_allocated_qty: Decimal = Decimal("0")
    total_shortage_qty: Decimal = Decimal("0")
    rows: List[OccupancyOrderRow] = []
    skipped_lines: int = 0


class OccupancyMaterialRow(BaseModel):
    """按订单视角：单条物料在本订单的占用结果"""

    level: int
    material_id: int
    material_code: str
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit_of_measure: Optional[str] = None
    scrap_rate: Optional[Decimal] = None
    unit_qty: Decimal = Decimal("0")
    demand_qty: Decimal = Decimal("0")
    stock_qty: Decimal = Decimal("0")
    prior_allocated_qty: Decimal = Decimal("0")
    available_qty: Decimal = Decimal("0")
    allocated_qty: Decimal = Decimal("0")
    shortage_qty: Decimal = Decimal("0")
    status: str


class OrderLineOccupancy(BaseModel):
    line_no: str
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    promised_date: Optional[date] = None
    order_qty: Decimal = Decimal("0")
    completed_qty: Decimal = Decimal("0")
    open_qty: Decimal = Decimal("0")
    bom_id: Optional[str] = None
    rows: List[OccupancyMaterialRow] = []


class OrderOccupancyResponse(BaseModel):
    order_no: str
    customer: Optional[str] = None
    skipped_lines: int = 0
    shortage_material_count: int = 0
    lines: List[OrderLineOccupancy] = []


class MaterialSearchItem(BaseModel):
    material_code: str
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit_of_measure: Optional[str] = None
