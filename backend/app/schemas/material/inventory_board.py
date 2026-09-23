"""库存看板 — Pydantic Schemas"""

from datetime import date
from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel


class InventoryBoardKpi(BaseModel):
    material_count: int
    total_qty: Decimal
    total_value: Decimal
    warehouse_count: int


class WarehouseStockRow(BaseModel):
    warehouse_id: int
    warehouse_name: str
    material_count: int
    total_qty: Decimal
    total_value: Decimal


class CategoryStockRow(BaseModel):
    category: str
    material_count: int
    total_qty: Decimal
    total_value: Decimal


class AgingBucket(BaseModel):
    bucket: str
    material_count: int
    total_qty: Decimal
    total_value: Decimal


class LowStockRow(BaseModel):
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    warehouse_name: Optional[str] = None
    qty_on_hand: Decimal
    unit: Optional[str] = None


class StockCheckBoardKpi(BaseModel):
    active_checks: int
    month_completion_rate: float
    month_profit_qty: Decimal
    month_loss_qty: Decimal


class ActiveCheckRow(BaseModel):
    check_id: int
    check_no: str
    status: str
    total_materials: int
    checked_materials: int
    completion_rate: float
    check_date: date
    age_days: int
    created_by: Optional[str] = None
    order_no: Optional[str] = None


class StockCheckTrendPoint(BaseModel):
    date: date
    checks_completed: int
    diff_items_count: int
    total_diff_qty: Decimal


class RecentDiffRow(BaseModel):
    check_no: str
    check_date: date
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit: Optional[str] = None
    system_qty: Decimal
    actual_qty: Optional[Decimal] = None
    diff_qty: Optional[Decimal] = None


class InventoryOverviewResponse(BaseModel):
    kpi: InventoryBoardKpi
    by_warehouse: List[WarehouseStockRow]
    by_category: List[CategoryStockRow]
    aging: List[AgingBucket]
    low_stock: List[LowStockRow]
    warehouses: List[dict]  # 用于筛选条下拉 [{id, name}]
    categories: List[str]  # 用于筛选条下拉（distinct material_type）


class CoverageWarehouseRow(BaseModel):
    """盘点覆盖 — 单仓已盘 / 未盘（行 = 物料×仓库）"""

    wh_id: Optional[int] = None
    wh_name: str
    total: int
    checked: int
    unchecked: int
    rate: float


class CheckCoverageResponse(BaseModel):
    """盘点覆盖 — 全仓合计 + 按仓库明细"""

    recent_days: int
    total: int
    checked: int
    unchecked: int
    rate: float
    warehouses: List[CoverageWarehouseRow]
