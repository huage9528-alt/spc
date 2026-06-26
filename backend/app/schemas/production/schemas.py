"""生产协同中心 — Schema定义"""

from typing import Optional, List
from datetime import date, datetime
from pydantic import BaseModel, Field


# ============ 工序进度（统一模型） ============

class ProcessProgressOut(BaseModel):
    id: int
    process_type: str
    seq_no: Optional[int] = None
    plan_date: Optional[date] = None
    order_no: Optional[str] = None
    product_code: Optional[str] = None
    line_no: Optional[str] = None
    model_code: Optional[str] = None
    color_spec: Optional[str] = None
    qty: Optional[float] = None
    planned_qty: Optional[float] = None
    kit_qty: Optional[float] = None
    online_date: Optional[date] = None
    daily_plan_qty: Optional[float] = None
    daily_complete_qty: Optional[float] = None
    completion_rate: Optional[str] = None
    work_hours: Optional[float] = None
    remark: Optional[str] = None
    # 前道
    customer_code: Optional[str] = None
    sale_order_no: Optional[str] = None
    order_date: Optional[str] = None
    by_style: Optional[int] = None
    shell_status: Optional[str] = None
    frame_status: Optional[str] = None
    handle_status: Optional[str] = None
    bracket_status: Optional[str] = None
    product_name: Optional[str] = None
    delivery_date: Optional[date] = None
    # 贴片
    material_long_code: Optional[str] = None
    material_name: Optional[str] = None
    material_confirm: Optional[str] = None
    unit_price: Optional[float] = None
    daily_amount: Optional[float] = None
    complete_time: Optional[str] = None
    hour_capacity: Optional[float] = None
    demand_time: Optional[str] = None
    total_plan_complete: Optional[float] = None
    # 精益
    next_process: Optional[str] = None
    # 组装/包装
    assembly_group: Optional[str] = None
    warehouse_in_qty: Optional[float] = None
    # 状态
    status: str
    data_source: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class ProcessProgressCreate(BaseModel):
    process_type: str
    seq_no: Optional[int] = None
    plan_date: Optional[date] = None
    order_no: Optional[str] = None
    product_code: Optional[str] = None
    line_no: Optional[str] = None
    model_code: Optional[str] = None
    color_spec: Optional[str] = None
    qty: Optional[float] = None
    planned_qty: Optional[float] = None
    kit_qty: Optional[float] = None
    online_date: Optional[date] = None
    daily_plan_qty: Optional[float] = None
    daily_complete_qty: Optional[float] = None
    completion_rate: Optional[str] = None
    work_hours: Optional[float] = None
    remark: Optional[str] = None
    customer_code: Optional[str] = None
    sale_order_no: Optional[str] = None
    order_date: Optional[str] = None
    by_style: Optional[int] = None
    shell_status: Optional[str] = None
    frame_status: Optional[str] = None
    handle_status: Optional[str] = None
    bracket_status: Optional[str] = None
    product_name: Optional[str] = None
    delivery_date: Optional[date] = None
    material_long_code: Optional[str] = None
    material_name: Optional[str] = None
    material_confirm: Optional[str] = None
    unit_price: Optional[float] = None
    daily_amount: Optional[float] = None
    complete_time: Optional[str] = None
    hour_capacity: Optional[float] = None
    demand_time: Optional[str] = None
    total_plan_complete: Optional[float] = None
    next_process: Optional[str] = None
    assembly_group: Optional[str] = None
    warehouse_in_qty: Optional[float] = None
    status: str = 'pending'


class ProcessProgressUpdate(BaseModel):
    plan_date: Optional[date] = None
    order_no: Optional[str] = None
    product_code: Optional[str] = None
    line_no: Optional[str] = None
    model_code: Optional[str] = None
    color_spec: Optional[str] = None
    qty: Optional[float] = None
    planned_qty: Optional[float] = None
    kit_qty: Optional[float] = None
    online_date: Optional[date] = None
    daily_plan_qty: Optional[float] = None
    daily_complete_qty: Optional[float] = None
    completion_rate: Optional[str] = None
    work_hours: Optional[float] = None
    remark: Optional[str] = None
    customer_code: Optional[str] = None
    sale_order_no: Optional[str] = None
    order_date: Optional[str] = None
    by_style: Optional[int] = None
    shell_status: Optional[str] = None
    frame_status: Optional[str] = None
    handle_status: Optional[str] = None
    bracket_status: Optional[str] = None
    product_name: Optional[str] = None
    delivery_date: Optional[date] = None
    material_long_code: Optional[str] = None
    material_name: Optional[str] = None
    material_confirm: Optional[str] = None
    unit_price: Optional[float] = None
    daily_amount: Optional[float] = None
    complete_time: Optional[str] = None
    hour_capacity: Optional[float] = None
    demand_time: Optional[str] = None
    total_plan_complete: Optional[float] = None
    next_process: Optional[str] = None
    assembly_group: Optional[str] = None
    warehouse_in_qty: Optional[float] = None
    status: Optional[str] = None


# ============ Production schedule plans ============

class ProductionSchedulePlanOut(BaseModel):
    id: int
    department: str
    plan_date: date
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    product_code: Optional[str] = None
    model_code: Optional[str] = None
    quantity: Optional[float] = None
    owner: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    priority: str
    status: str
    upph: Optional[float] = None
    daily_work_hours: Optional[float] = None
    remark: Optional[str] = None
    customer_due_date: Optional[date] = None
    delay_days: Optional[int] = None
    delivery_status: Optional[str] = None
    latest_reschedule_at: Optional[datetime] = None
    
    plan_version: int = 1
    is_active: bool = True
    source_promised_date: Optional[date] = None
    source_order_qty: Optional[float] = None
    source_product_code: Optional[str] = None
    source_product_model: Optional[str] = None
    source_upph: Optional[float] = None
    source_process_type: Optional[str] = None
    needs_reschedule: bool = False
    reschedule_reason: Optional[str] = None
    previous_plan_id: Optional[int] = None
    sync_batch_no: Optional[str] = None
    locked_by: Optional[str] = None
    locked_at: Optional[datetime] = None
    confirmed_by: Optional[str] = None
    confirmed_at: Optional[datetime] = None

    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class ProductionSchedulePlanCreate(BaseModel):
    department: str
    plan_date: date
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    product_code: Optional[str] = None
    model_code: Optional[str] = None
    quantity: Optional[float] = None
    owner: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    priority: str = "normal"
    status: str = "planned"
    upph: Optional[float] = None
    daily_work_hours: Optional[float] = None
    remark: Optional[str] = None
    
    plan_version: int = 1
    is_active: bool = True
    source_promised_date: Optional[date] = None
    source_order_qty: Optional[float] = None
    source_product_code: Optional[str] = None
    source_product_model: Optional[str] = None
    source_upph: Optional[float] = None
    source_process_type: Optional[str] = None
    needs_reschedule: bool = False
    reschedule_reason: Optional[str] = None
    previous_plan_id: Optional[int] = None
    sync_batch_no: Optional[str] = None


class ProductionSchedulePlanUpdate(BaseModel):
    department: Optional[str] = None
    plan_date: Optional[date] = None
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    product_code: Optional[str] = None
    model_code: Optional[str] = None
    quantity: Optional[float] = None
    owner: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    upph: Optional[float] = None
    daily_work_hours: Optional[float] = None
    remark: Optional[str] = None
    
    is_active: Optional[bool] = None
    needs_reschedule: Optional[bool] = None
    reschedule_reason: Optional[str] = None
    locked_by: Optional[str] = None
    locked_at: Optional[datetime] = None
    confirmed_by: Optional[str] = None
    confirmed_at: Optional[datetime] = None


# ============ 一键排产相关 ============

class OrderForSchedulingOut(BaseModel):
    order_no: str
    line_no: str
    customer: Optional[str] = None
    product_code: Optional[str] = None
    product_model: Optional[str] = None
    order_qty: Optional[float] = None
    promised_date: Optional[date] = None
    risk_level: Optional[str] = None
    status: Optional[str] = None
    upph: Optional[float] = None
    has_schedule: bool = False


class AutoScheduleRequest(BaseModel):
    order_no: str
    line_no: str
    department: str = "生产"
    plan_date: Optional[date] = None
    upph: Optional[float] = None
    daily_work_hours: Optional[float] = None
    owner: Optional[str] = None


class AutoScheduleResponse(BaseModel):
    success: bool
    message: str
    schedule_plan: Optional[ProductionSchedulePlanOut] = None
    calculation_result: Optional[dict] = None


class UpphImpactPlanOut(BaseModel):
    """UPPH变更影响的排产计划项"""
    id: int
    department: str
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    product_code: Optional[str] = None
    model_code: Optional[str] = None
    quantity: Optional[float] = None
    owner: Optional[str] = None
    status: str
    plan_date: date
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    source_promised_date: Optional[date] = None
    source_upph: Optional[float] = None
    current_upph: float
    upph_delta: float
    upph_delta_ratio: float
    planned_total_hours: Optional[float] = None
    current_total_hours: Optional[float] = None
    planned_days_needed: Optional[int] = None
    current_days_needed: Optional[int] = None
    impact_level: str
    impact_score: float
    impact_reason: str
    needs_reschedule: bool = False
    reschedule_reason: Optional[str] = None


class BatchRescheduleRequest(BaseModel):
    """批量重排请求"""
    plan_ids: List[int]
    all_or_none: bool = Field(
        False,
        description="全成功全回滚模式：True表示任一条失败则全部回滚；False表示成功几条算几条",
    )

class BatchRescheduleItemOut(BaseModel):
    """批量重排单条结果"""
    plan_id: int
    new_plan_id: Optional[int] = None
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    success: bool
    message: str


class BatchRescheduleResponse(BaseModel):
    """批量重排响应"""
    total: int
    success_count: int
    failed_count: int
    # 新增：交期影响统计
    delay_warning_count: int = 0  # 产生新延期预警的条数
    items: List[BatchRescheduleItemOut]


class ProductionScheduleOperationLogOut(BaseModel):
    """排产操作日志出参"""
    id: int
    plan_id: Optional[int]
    plan_version: Optional[int]
    order_no: Optional[str]
    line_no: Optional[str]
    operation_type: str
    operator: str
    operation_at: datetime
    remark: Optional[str]
    affected_plan_ids: Optional[str]
    previous_version_id: Optional[int]

    model_config = {"from_attributes": True}


class EmptyStateOut(BaseModel):
    """列表空态说明"""
    code: str
    message: str

    model_config = {"from_attributes": True}


class MissingUpphListOut(BaseModel):
    """缺少UPPH列表响应"""
    items: List["MissingUpphProductOut"]
    empty_state: Optional[EmptyStateOut] = None

    model_config = {"from_attributes": True}


class MissingUpphProductOut(BaseModel):
    """缺少UPPH的产品"""
    product_code: Optional[str] = None
    product_model: Optional[str] = None
    order_count: int = 0
    total_quantity: Optional[float] = None
    latest_promised_date: Optional[date] = None
    first_order_no: Optional[str] = None

    model_config = {"from_attributes": True}


# ============ 工序异常 ============

class ProcessExceptionOut(BaseModel):
    id: int
    exception_no: str
    process_type: Optional[str] = None
    order_no: Optional[str] = None
    model_code: Optional[str] = None
    exception_type: Optional[str] = None
    severity: Optional[str] = None
    description: Optional[str] = None
    responsible_dept: Optional[str] = None
    responsible_person: Optional[str] = None
    status: str
    resolved_at: Optional[date] = None
    remark: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class ProcessExceptionCreate(BaseModel):
    process_type: Optional[str] = None
    order_no: Optional[str] = None
    model_code: Optional[str] = None
    exception_type: str
    severity: Optional[str] = None
    description: str
    responsible_dept: Optional[str] = None
    responsible_person: Optional[str] = None
    status: str = 'open'
    remark: Optional[str] = None


class ProcessExceptionUpdate(BaseModel):
    process_type: Optional[str] = None
    order_no: Optional[str] = None
    model_code: Optional[str] = None
    exception_type: Optional[str] = None
    severity: Optional[str] = None
    description: Optional[str] = None
    responsible_dept: Optional[str] = None
    responsible_person: Optional[str] = None
    status: Optional[str] = None
    resolved_at: Optional[date] = None
    remark: Optional[str] = None


# ============ 生产总览聚合 ============

class ProcessTypeStatItem(BaseModel):
    process_type: str
    total: int
    completed: int
    in_progress: int
    overdue: int
    abnormal: int


class ProductProcessItem(BaseModel):
    product_code: Optional[str] = None
    model_code: Optional[str] = None
    color_spec: Optional[str] = None
    qty: Optional[float] = None
    front_process_status: Optional[str] = None
    smt_status: Optional[str] = None
    lean_status: Optional[str] = None
    assembly_status: Optional[str] = None
    packaging_status: Optional[str] = None
    current_process: Optional[str] = None
    block_reason: Optional[str] = None


class OrderProcessItem(BaseModel):
    order_no: str
    products: List[ProductProcessItem] = []
    current_process: Optional[str] = None
    block_reason: Optional[str] = None


class ProductionOverviewData(BaseModel):
    process_stats: List[ProcessTypeStatItem]
    orders: List[OrderProcessItem]
    total_orders: int
    blocked_orders: int


# ============ 变更追踪与产能 ============

class SaleOrderLineChangeLogOut(BaseModel):
    id: int
    order_no: str
    line_no: str
    change_type: str
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    is_processed: int
    created_at: datetime
    processed_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class ProductProcessCapacityOut(BaseModel):
    id: int
    oa_detail_id: Optional[str] = None
    bom_code: Optional[str] = None
    product_code: str
    product_name: Optional[str] = None
    process_type: str
    upph: float
    source: Optional[str] = None
    sync_batch_no: Optional[str] = None
    last_sync_time: Optional[datetime] = None
    is_active: bool = True
    remark: Optional[str] = None
    updated_at: datetime

    model_config = {"from_attributes": True}


class ProductProcessCapacityCreate(BaseModel):
    oa_detail_id: Optional[str] = None
    bom_code: Optional[str] = None
    product_code: str
    product_name: Optional[str] = None
    process_type: str
    upph: float
    source: Optional[str] = None
    sync_batch_no: Optional[str] = None
    last_sync_time: Optional[datetime] = None
    is_active: bool = True
    remark: Optional[str] = None


class ProductProcessCapacityUpdate(BaseModel):
    oa_detail_id: Optional[str] = None
    bom_code: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    process_type: Optional[str] = None
    upph: Optional[float] = None
    source: Optional[str] = None
    sync_batch_no: Optional[str] = None
    last_sync_time: Optional[datetime] = None
    is_active: Optional[bool] = None
    remark: Optional[str] = None


class ProductProcessCapacitySyncResult(BaseModel):
    sync_batch_no: str
    fetched: int
    created: int
    updated: int
    reactivated: int = 0
    deactivated: int = 0
    skipped: int = 0
    affected_schedule_plans_marked: int = 0
