"""供应链驾驶舱 — Schema定义"""

from typing import Optional, List
from datetime import date, datetime
from pydantic import BaseModel


# ===== 基础 =====

class RiskSummary(BaseModel):
    red_count: int = 0
    yellow_count: int = 0
    green_count: int = 0
    total_count: int = 0


class OrderRiskRow(BaseModel):
    order_no: str
    line_no: Optional[str] = None
    customer: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    order_qty: Optional[float] = None
    promised_date: Optional[date] = None
    planned_start_date: Optional[date] = None
    owner: Optional[str] = None
    status: Optional[str] = None
    risk_level: Optional[str] = None
    shortage_count: int = 0
    in_transit_count: int = 0
    latest_eta: Optional[date] = None

    model_config = {"from_attributes": True}


class RiskDistribution(BaseModel):
    risk_level: str
    issue_type: str
    count: int


class DashboardData(BaseModel):
    risk_summary: RiskSummary
    recent_issues: List[dict] = []


# ===== 今日总览 =====

class TodayOverview(BaseModel):
    """今日应交订单、风险订单、欠料订单、待关闭异常、超时任务"""
    due_today: int = 0
    due_today_red: int = 0
    due_today_yellow: int = 0
    shortage_orders: int = 0
    pending_close_issues: int = 0
    overdue_tasks: int = 0
    in_transit_po: int = 0
    eta_overdue_po: int = 0
    total_orders: int = 0
    red_orders: int = 0
    yellow_orders: int = 0
    blue_orders: int = 0
    green_orders: int = 0


class TodayDueOrder(BaseModel):
    order_no: str
    line_no: Optional[str] = None
    customer: Optional[str] = None
    product_name: Optional[str] = None
    order_qty: Optional[float] = None
    promised_date: Optional[date] = None
    risk_level: Optional[str] = None
    owner: Optional[str] = None
    risk_score: Optional[float] = None
    risk_factors: Optional[dict] = None
    risk_assessed_at: Optional[datetime] = None


# ===== 14天滚动风险 =====

class RollingRiskDay(BaseModel):
    """单日风险快照"""
    date: date
    due_count: int = 0
    red_count: int = 0
    yellow_count: int = 0
    blue_count: int = 0
    orders: List[TodayDueOrder] = []


class RollingRiskData(BaseModel):
    """14天滚动风险数据"""
    days: List[RollingRiskDay] = []
    total_due: int = 0
    total_red: int = 0
    total_yellow: int = 0
    total_blue: int = 0


# ===== 订单风险分布 =====

class RiskDimensionItem(BaseModel):
    """风险分布维度项"""
    name: str
    red_count: int = 0
    yellow_count: int = 0
    blue_count: int = 0
    green_count: int = 0
    total_count: int = 0


class RiskFactorDistributionItem(BaseModel):
    """风险因子维度分布"""
    factor: str
    factor_label: str
    red_count: int = 0
    yellow_count: int = 0
    blue_count: int = 0
    green_count: int = 0
    total_count: int = 0
    avg_score: float = 0.0


class OrderRiskDistributionData(BaseModel):
    """按客户/产品/责任部门/工序等维度分析风险"""
    by_customer: List[RiskDimensionItem] = []
    by_product: List[RiskDimensionItem] = []
    by_owner: List[RiskDimensionItem] = []
    by_department: List[RiskDimensionItem] = []
    by_risk_level: List[RiskDimensionItem] = []
    by_factor: List[RiskFactorDistributionItem] = []


# ===== 闭环达成看板 =====

class ClosureAchievement(BaseModel):
    """异常闭环达成统计"""
    new_issues: int = 0
    closed_issues: int = 0
    overdue_issues: int = 0
    escalated_issues: int = 0
    repeated_issues: int = 0
    closure_rate: float = 0.0
    on_time_rate: float = 0.0
    by_type: List[RiskDimensionItem] = []
    by_owner: List[RiskDimensionItem] = []
    trend: List[dict] = []


# ===== 采购看板（大屏 - 7日备料白板） =====

class BoardItem(BaseModel):
    """白板单行记录：日期 | 单号 | 型号 | 库存 | MRP数量 | 到料 | 采购 | 责任人"""
    id: int
    board_date: Optional[date] = None
    doc_no: Optional[str] = None
    material_code: str
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    qty: Optional[float] = None
    received_qty: Optional[float] = None
    stock_qty: Optional[float] = None
    mrp_qty: Optional[float] = None
    is_ready: bool = False
    shortage_qty: Optional[float] = None
    is_shortage: bool = False
    is_overdue: bool = False
    overdue_days: int = 0
    owner: Optional[str] = None
    responsible: Optional[str] = None
    workstation: Optional[str] = None
    remark: Optional[str] = None


class ProcurementBoardData(BaseModel):
    """7日备料看板数据"""
    items: List[BoardItem] = []
    last_updated: datetime


# ===== 出货计划看板 =====

class ShipmentBoardItem(BaseModel):
    """出货计划看板单行：日期 | 单号 | 客户 | 产品 | 数量 | 交期 | 风险"""
    id: int
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    shipping_plan: Optional[date] = None
    is_overdue: bool = False
    overdue_days: int = 0
    customer: Optional[str] = None
    customer_code: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    order_qty: Optional[float] = None
    completed_qty: Optional[float] = None
    promised_date: Optional[date] = None
    risk_level: Optional[str] = None
    owner: Optional[str] = None
    shipping_status_desc: Optional[str] = None
    status: Optional[str] = None
    is_done: bool = False
    completed_date: Optional[date] = None


class ShipmentBoardData(BaseModel):
    """出货计划看板数据"""
    items: List[ShipmentBoardItem] = []
    last_updated: datetime
