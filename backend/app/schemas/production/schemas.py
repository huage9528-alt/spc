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
    task_no: Optional[str] = None
    department: str
    plan_date: date
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    product_code: Optional[str] = None
    model_code: Optional[str] = None
    quantity: Optional[float] = None
    planned_qty: Optional[float] = None  # v2 Q8：本段计划负责数量
    owner: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    priority: str
    status: str
    upph: Optional[float] = None
    manpower: Optional[int] = None
    daily_work_hours: Optional[float] = None
    remark: Optional[str] = None
    bom_no: Optional[str] = None
    schedule_bucket: Optional[str] = None
    schedule_bucket_label: Optional[str] = None
    scheduling_reason: Optional[str] = None
    customer_due_date: Optional[date] = None
    target_ready_date: Optional[date] = None
    ready_offset_days: int = 2
    total_hours: Optional[float] = None
    available_production_days: Optional[int] = None
    required_daily_hours: Optional[float] = None
    recommended_daily_hours: Optional[float] = None
    capacity_load_status: Optional[str] = None
    capacity_load_status_label: Optional[str] = None
    sunday_rest_allowed: Optional[bool] = None
    needs_sunday_work: Optional[bool] = None
    needs_move_earlier: Optional[bool] = None
    move_earlier_days: Optional[int] = None
    work_hour_summary: Optional[str] = None
    delay_days: Optional[int] = None
    delivery_status: Optional[str] = None
    latest_reschedule_at: Optional[datetime] = None
    daily_breakdown: Optional[list] = None  # [{"date": "2026-07-23", "hours": 7.57, "qty": 1548}, ...]
    
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
    planned_qty: Optional[float] = None  # v2 Q8：本段计划负责数量
    owner: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    priority: str = "normal"
    status: str = "planned"
    upph: Optional[float] = None
    manpower: Optional[int] = None
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
    manpower: Optional[int] = None
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
    bom_no: Optional[str] = None
    product_code: Optional[str] = None
    product_model: Optional[str] = None
    order_qty: Optional[float] = None
    promised_date: Optional[date] = None
    risk_level: Optional[str] = None
    status: Optional[str] = None
    upph: Optional[float] = None
    has_schedule: bool = False
    schedule_bucket: Optional[str] = None
    schedule_bucket_label: Optional[str] = None
    scheduling_status: str = "pending"
    scheduling_status_label: str = "待确认"
    display_status: str = "pending"
    display_status_label: str = "待确认"
    scheduling_reason_code: Optional[str] = None
    scheduling_reason: Optional[str] = None
    scheduling_reason_details: List[str] = Field(default_factory=list)
    is_missing_upph: bool = False
    target_ready_date: Optional[date] = None
    ready_offset_days: int = 2
    total_hours: Optional[float] = None
    available_production_days: Optional[int] = None
    required_daily_hours: Optional[float] = None
    recommended_daily_hours: Optional[float] = None
    capacity_load_status: Optional[str] = None
    capacity_load_status_label: Optional[str] = None
    sunday_rest_allowed: Optional[bool] = None
    needs_sunday_work: Optional[bool] = None
    needs_move_earlier: Optional[bool] = None
    move_earlier_days: Optional[int] = None
    work_hour_summary: Optional[str] = None


class TodoWorkbenchItemOut(BaseModel):
    id: Optional[int] = None
    todo_source: str
    todo_kind: str
    todo_status_label: str
    todo_action_label: Optional[str] = None
    todo_due_date: Optional[date] = None
    order_no: str
    line_no: str
    customer: Optional[str] = None
    bom_no: Optional[str] = None
    product_code: Optional[str] = None
    product_model: Optional[str] = None
    model_code: Optional[str] = None
    order_qty: Optional[float] = None
    quantity: Optional[float] = None
    promised_date: Optional[date] = None
    source_promised_date: Optional[date] = None
    risk_level: Optional[str] = None
    status: Optional[str] = None
    owner: Optional[str] = None
    upph: Optional[float] = None
    current_upph: Optional[float] = None
    source_upph: Optional[float] = None
    has_schedule: bool = False
    schedule_bucket: Optional[str] = None
    schedule_bucket_label: Optional[str] = None
    scheduling_status: Optional[str] = None
    scheduling_status_label: Optional[str] = None
    display_status: Optional[str] = None
    display_status_label: Optional[str] = None
    scheduling_reason_code: Optional[str] = None
    scheduling_reason: Optional[str] = None
    scheduling_reason_details: List[str] = Field(default_factory=list)
    is_missing_upph: bool = False
    target_ready_date: Optional[date] = None
    ready_offset_days: int = 2
    total_hours: Optional[float] = None
    available_production_days: Optional[int] = None
    required_daily_hours: Optional[float] = None
    recommended_daily_hours: Optional[float] = None
    capacity_load_status: Optional[str] = None
    capacity_load_status_label: Optional[str] = None
    sunday_rest_allowed: Optional[bool] = None
    needs_sunday_work: Optional[bool] = None
    needs_move_earlier: Optional[bool] = None
    move_earlier_days: Optional[int] = None
    work_hour_summary: Optional[str] = None
    plan_date: Optional[date] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    plan_version: Optional[int] = None
    previous_plan_id: Optional[int] = None
    impact_level: Optional[str] = None
    impact_score: Optional[float] = None
    impact_reason: Optional[str] = None
    needs_reschedule: bool = False
    reschedule_reason: Optional[str] = None
    planned_days_needed: Optional[int] = None
    current_days_needed: Optional[int] = None
    upph_delta: Optional[float] = None
    upph_delta_ratio: Optional[float] = None


class TodoSnapshotRefreshRequest(BaseModel):
    year: Optional[int] = None
    month: Optional[int] = None
    keyword: Optional[str] = None
    risk_level: Optional[str] = None
    limit: int = Field(200, ge=1, le=500)


class TodoSnapshotRefreshResponse(BaseModel):
    matched_total: int
    stale_total: int
    refreshed_total: int
    skipped_total: int = 0
    month_scope: str


class AutoScheduleRequest(BaseModel):
    order_no: str
    line_no: str
    department: str = "生产"
    plan_date: Optional[date] = None
    upph: Optional[float] = None
    manpower: Optional[int] = None  # 班组人数(默认走配置, 可手动覆盖)
    daily_work_hours: Optional[float] = None
    owner: Optional[str] = None
    confirm_risky: bool = False  # v2 阶段 4：周日生产/前挪需人工确认，前端二次提交时传 true


class AutoScheduleResponse(BaseModel):
    success: bool
    message: str
    schedule_plan: Optional[ProductionSchedulePlanOut] = None
    calculation_result: Optional[dict] = None
    needs_confirm: bool = False  # v2 阶段 4：True 表示需要人工确认（周日/前挪），前端应弹确认框


class ProductionSimulationRequest(BaseModel):
    department: str = "生产"
    quantity: float = Field(..., gt=0)
    upph: float = Field(..., gt=0)
    promised_date: date
    consider_existing_plans: bool = True


class ProductionSimulationResponse(BaseModel):
    department: str = "生产"
    schedule_bucket: str = "lean"
    schedule_bucket_label: str = "精益"
    quantity: float
    upph: float
    promised_date: date
    target_ready_date: Optional[date] = None
    total_hours: Optional[float] = None
    days_needed: int
    recommended_daily_hours: float
    capacity_load_status: Optional[str] = None
    capacity_load_status_label: Optional[str] = None
    sunday_rest_allowed: Optional[bool] = None
    needs_sunday_work: Optional[bool] = None
    needs_move_earlier: Optional[bool] = None
    move_earlier_days: Optional[int] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    plan_date: Optional[date] = None
    warning: Optional[str] = None
    work_hour_summary: Optional[str] = None
    explanation_steps: List[str] = Field(default_factory=list)


class BatchAutoScheduleItemIn(BaseModel):
    order_no: str
    line_no: str
    upph: Optional[float] = None
    manpower: Optional[int] = None  # 班组人数(可空, 默认走配置)


class BatchAutoScheduleRequest(BaseModel):
    department: str = "生产"
    plan_date: Optional[date] = None
    daily_work_hours: Optional[float] = None
    owner: Optional[str] = None
    manpower: Optional[int] = None  # 批量统一人数(可被 item.manpower 覆盖)
    items: List[BatchAutoScheduleItemIn]


class BatchAutoScheduleItemOut(BaseModel):
    order_no: str
    line_no: str
    success: bool
    plan_id: Optional[int] = None
    message: str
    warning: Optional[str] = None


class BatchAutoScheduleResponse(BaseModel):
    total: int
    success_count: int
    failed_count: int
    delay_warning_count: int = 0
    items: List[BatchAutoScheduleItemOut]


class UpphImpactPlanOut(BaseModel):
    """UPPH变更影响的排产计划项"""
    id: int
    department: str
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    schedule_bucket: Optional[str] = None
    schedule_bucket_label: Optional[str] = None
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


class ScheduleChangeEventOut(BaseModel):
    event_id: str
    id: int
    event_type: str
    event_type_label: str
    department: str
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    schedule_bucket: Optional[str] = None
    schedule_bucket_label: Optional[str] = None
    product_code: Optional[str] = None
    model_code: Optional[str] = None
    quantity: Optional[float] = None
    owner: Optional[str] = None
    status: str
    plan_version: int = 1
    plan_date: date
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    source_promised_date: Optional[date] = None
    current_promised_date: Optional[date] = None
    source_order_qty: Optional[float] = None
    current_order_qty: Optional[float] = None
    source_upph: Optional[float] = None
    current_upph: Optional[float] = None
    before_value_text: Optional[str] = None
    after_value_text: Optional[str] = None
    change_summary: Optional[str] = None
    impact_level: str
    impact_score: float = 0
    impact_reason: str
    needs_reschedule: bool = False
    reschedule_reason: Optional[str] = None
    process_status: str = "pending"
    process_status_label: str = "待处理"
    process_operator: Optional[str] = None
    process_at: Optional[datetime] = None
    planned_days_needed: Optional[int] = None
    current_days_needed: Optional[int] = None
    upph_delta: Optional[float] = None
    upph_delta_ratio: Optional[float] = None


class ChangeEventStatusUpdateRequest(BaseModel):
    event_ids: List[str] = Field(default_factory=list)
    process_status: str = Field(pattern="^(watching|resolved|pending)$")
    remark: Optional[str] = None


class ChangeEventStatusUpdateItemOut(BaseModel):
    event_id: str
    plan_id: int
    process_status: str
    process_status_label: str
    success: bool = True
    message: Optional[str] = None


class ChangeEventStatusUpdateResponse(BaseModel):
    total: int
    success_count: int
    failed_count: int
    items: List[ChangeEventStatusUpdateItemOut] = Field(default_factory=list)


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


class DeleteSchedulePlanBackfillItemOut(BaseModel):
    plan_id: int
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    current_plan_date: Optional[date] = None
    suggested_plan_date: Optional[date] = None
    current_start_date: Optional[date] = None
    current_end_date: Optional[date] = None
    schedule_bucket: Optional[str] = None
    schedule_bucket_label: Optional[str] = None


class DeleteSchedulePlanResultOut(BaseModel):
    deleted: int
    reason: Optional[str] = None
    release_plan_date: Optional[date] = None
    earliest_backfill_date: Optional[date] = None
    release_bucket: Optional[str] = None
    release_bucket_label: Optional[str] = None
    affected_count: int = 0
    affected_plan_ids: List[int] = Field(default_factory=list)
    items: List[DeleteSchedulePlanBackfillItemOut] = Field(default_factory=list)
    backfill_executed: bool = False
    backfill_success_count: int = 0
    backfill_failed_count: int = 0
    timings_ms: Optional[dict] = None


class DeleteSchedulePlanPreviewOut(BaseModel):
    plan_id: int
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    reason: Optional[str] = None
    release_plan_date: Optional[date] = None
    earliest_backfill_date: Optional[date] = None
    release_bucket: Optional[str] = None
    release_bucket_label: Optional[str] = None
    affected_count: int = 0
    affected_plan_ids: List[int] = Field(default_factory=list)
    items: List[DeleteSchedulePlanBackfillItemOut] = Field(default_factory=list)
    in_frozen: bool = False  # v2 阶段 2：是否在冷冻区（前端据此提示破冻）


class DeleteSchedulePlanConfirmRequest(BaseModel):
    reason: Optional[str] = None
    execute_backfill: bool = False
    break_frozen_reason: Optional[str] = None  # v2 阶段 2：破冻理由（冷冻区必填）


class DeleteBackfillExecuteItemIn(BaseModel):
    plan_id: int
    suggested_plan_date: date


class DeleteBackfillExecuteRequest(BaseModel):
    items: List[DeleteBackfillExecuteItemIn] = Field(default_factory=list)
    remark: Optional[str] = None


class DeleteBackfillExecuteItemOut(BaseModel):
    old_plan_id: int
    new_plan_id: Optional[int] = None
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    old_plan_date: Optional[date] = None
    new_plan_date: Optional[date] = None
    success: bool = True
    message: Optional[str] = None


class DeleteBackfillExecuteResponse(BaseModel):
    total: int
    success_count: int
    failed_count: int
    items: List[DeleteBackfillExecuteItemOut] = Field(default_factory=list)


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
    is_frozen_break: bool = False  # v2 阶段 2：是否破冻操作

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
    oa_workshop_id: Optional[str] = None
    oa_workshop_name: Optional[str] = None
    process_type: str
    gjje: Optional[float] = None
    manpower: Optional[float] = None
    hour_price: Optional[float] = None
    oa_raw_upph: Optional[float] = None
    formula_upph: Optional[float] = None
    manual_upph: Optional[float] = None
    upph_source: Optional[str] = None
    upph: float
    is_schedulable: bool = True
    exclude_reason: Optional[str] = None
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
    upph: Optional[float] = None
    manpower: Optional[float] = None
    hour_price: Optional[float] = None
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
    manpower: Optional[float] = None
    hour_price: Optional[float] = None
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


class UpphFormulaConfigOut(BaseModel):
    id: int
    workshop_name: str
    process_type: str
    manpower: float
    hour_price: float
    is_active: bool = True
    remark: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class UpphFormulaConfigCreate(BaseModel):
    workshop_name: str
    process_type: str
    manpower: float
    hour_price: float
    is_active: bool = True
    remark: Optional[str] = None


class UpphFormulaConfigUpdate(BaseModel):
    workshop_name: Optional[str] = None
    process_type: Optional[str] = None
    manpower: Optional[float] = None
    hour_price: Optional[float] = None
    is_active: Optional[bool] = None
    remark: Optional[str] = None


class UpphFormulaRecalculateResult(BaseModel):
    recalculated: int = 0
    updated: int = 0
    affected_schedule_plans_marked: int = 0
