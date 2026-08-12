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


# ============ 前道管理（以生产任务单为主体） ============

class FrontProcessTaskOut(BaseModel):
    """前道管理列表行：任务单字段(只读) + 手工字段 + sale_order 关联字段"""
    # 任务单标识（用作主键/编辑键）
    task_id: Optional[int] = None
    task_no: Optional[str] = None
    # 任务单只读字段
    workshop: Optional[str] = None
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    sale_order_no: Optional[str] = None
    task_qty: Optional[float] = None
    planned_start_date: Optional[date] = None
    planned_end_date: Optional[date] = None
    actual_start_date: Optional[date] = None
    actual_end_date: Optional[date] = None
    is_closed: Optional[int] = None
    # sale_order 关联字段
    customer_code: Optional[str] = None
    customer: Optional[str] = None
    order_date: Optional[date] = None
    promised_date: Optional[date] = None
    product_name: Optional[str] = None
    product_model: Optional[str] = None
    # 手工填写字段
    shell_status: Optional[str] = None
    frame_status: Optional[str] = None
    handle_status: Optional[str] = None
    bracket_status: Optional[str] = None
    remark: Optional[str] = None
    status: str = "pending"

    model_config = {"from_attributes": True}


class FrontProcessRecordUpdate(BaseModel):
    """前道管理编辑表单：仅允许更新手工填写字段"""
    shell_status: Optional[str] = None
    frame_status: Optional[str] = None
    handle_status: Optional[str] = None
    bracket_status: Optional[str] = None
    remark: Optional[str] = None
    status: Optional[str] = None


# ============ 生产日报表（ERP/OA 同步，只读） ============

class ProductionDailyReportCreate(BaseModel):
    """生产日报表手工录入字段（data_source 固定为 manual）"""
    report_date: date
    workshop: str = Field(..., min_length=1, max_length=128, description="车间")
    sale_order_no: Optional[str] = Field(None, max_length=64)
    production_order_no: Optional[str] = Field(None, max_length=64)
    specification: Optional[str] = Field(None, max_length=128)
    bom_no: Optional[str] = Field(None, max_length=64)
    material_code: Optional[str] = Field(None, max_length=64)
    process: Optional[str] = Field(None, max_length=64)
    color: Optional[str] = Field(None, max_length=64)
    completed_qty: Optional[float] = Field(None, ge=0)
    work_hours: Optional[float] = Field(None, ge=0)
    total_wages: Optional[float] = Field(None, ge=0)


class ProductionDailyReportUpdate(BaseModel):
    """生产日报表手工录入更新（仅 manual 行允许）"""
    report_date: Optional[date] = None
    workshop: Optional[str] = Field(None, min_length=1, max_length=128)
    sale_order_no: Optional[str] = Field(None, max_length=64)
    production_order_no: Optional[str] = Field(None, max_length=64)
    specification: Optional[str] = Field(None, max_length=128)
    bom_no: Optional[str] = Field(None, max_length=64)
    material_code: Optional[str] = Field(None, max_length=64)
    process: Optional[str] = Field(None, max_length=64)
    color: Optional[str] = Field(None, max_length=64)
    completed_qty: Optional[float] = Field(None, ge=0)
    work_hours: Optional[float] = Field(None, ge=0)
    total_wages: Optional[float] = Field(None, ge=0)


class ProductionDailyReportOut(BaseModel):
    """生产日报表列表行"""
    id: Optional[int] = None
    oa_id: Optional[str] = None
    oa_detail_id: Optional[int] = None
    report_date: Optional[date] = None
    sale_order_no: Optional[str] = None
    production_order_no: Optional[str] = None
    specification: Optional[str] = None
    bom_no: Optional[str] = None
    material_code: Optional[str] = None
    process: Optional[str] = None
    color: Optional[str] = None
    completed_qty: Optional[float] = None
    workshop: Optional[str] = None
    work_hours: Optional[float] = None
    total_wages: Optional[float] = None
    data_source: Optional[str] = None
    erp_updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ============ 车间日报表单据（泛微OA样式，主表+3子表） ============

class WorkshopDailyReportLeaveIn(BaseModel):
    """请假人员明细（录入）"""
    leave_date: Optional[date] = None
    employee_name: Optional[str] = Field(None, max_length=64)
    emp_code: Optional[str] = Field(None, max_length=32)
    leave_hours: Optional[float] = Field(None, ge=0)


class WorkshopDailyReportWorkIn(BaseModel):
    """出勤人员·工时明细（录入，实际工时=正班+加班 自动算）"""
    work_date: Optional[date] = None
    employee_name: Optional[str] = Field(None, max_length=64)
    emp_code: Optional[str] = Field(None, max_length=32)
    total_hours: Optional[float] = Field(None, ge=0)
    leave_hours: Optional[float] = Field(None, ge=0)
    normal_hours: Optional[float] = Field(None, ge=0)
    overtime_hours: Optional[float] = Field(None, ge=0)
    hourly_wage: Optional[float] = Field(None, ge=0)
    amount: Optional[float] = Field(None, ge=0)
    modulus: Optional[int] = Field(None, ge=1)
    daily_attendance: Optional[str] = Field(None, max_length=255)


class WorkshopDailyReportTaskIn(BaseModel):
    """选择K3任务单明细（录入）"""
    sale_order_no: Optional[str] = Field(None, max_length=64)
    production_order_no: Optional[str] = Field(None, max_length=64)
    public_material: Optional[str] = Field(None, max_length=255)
    specification: Optional[str] = Field(None, max_length=128)
    batch_qty: Optional[float] = Field(None, ge=0)
    bom_no: Optional[str] = Field(None, max_length=64)
    material_code: Optional[str] = Field(None, max_length=64)
    process: Optional[str] = Field(None, max_length=64)
    process_remark: Optional[str] = Field(None, max_length=255)
    color: Optional[str] = Field(None, max_length=64)
    color_temp: Optional[str] = Field(None, max_length=64)
    product_unit_price: Optional[float] = Field(None, ge=0)
    unit_price: Optional[float] = Field(None, ge=0)
    completed_qty: Optional[float] = Field(None, ge=0)
    amount: Optional[float] = Field(None, ge=0)
    exception_amount: Optional[float] = Field(None, ge=0)
    allocated_unit_price: Optional[float] = Field(None, ge=0)
    allocated_amount: Optional[float] = Field(None, ge=0)


class WorkshopDailyReportCreate(BaseModel):
    """车间日报表 新建"""
    report_date: date
    report_type: Optional[str] = Field(None, max_length=32)
    department: Optional[str] = Field(None, max_length=128)
    group_name: Optional[str] = Field(None, max_length=128)
    workshop: Optional[str] = Field(None, max_length=128)
    plan_qty: Optional[float] = Field(None, ge=0)
    work_hours: Optional[float] = Field(None, ge=0)
    leader: Optional[str] = Field(None, max_length=64)
    repairer: Optional[str] = Field(None, max_length=64)
    material_handler: Optional[str] = Field(None, max_length=64)
    completed_qty: Optional[float] = Field(None, ge=0)
    temp_personnel: Optional[str] = Field(None, max_length=255)
    temp_people_count: Optional[int] = Field(None, ge=0)
    temp_count: Optional[int] = Field(None, ge=0)
    temp_amount: Optional[float] = Field(None, ge=0)
    remark: Optional[str] = Field(None, max_length=2000)
    leave_items: Optional[List[WorkshopDailyReportLeaveIn]] = Field(default_factory=list)
    work_items: Optional[List[WorkshopDailyReportWorkIn]] = Field(default_factory=list)
    task_items: Optional[List[WorkshopDailyReportTaskIn]] = Field(default_factory=list)


class WorkshopDailyReportUpdate(BaseModel):
    """车间日报表 更新"""
    report_date: Optional[date] = None
    report_type: Optional[str] = Field(None, max_length=32)
    department: Optional[str] = Field(None, max_length=128)
    group_name: Optional[str] = Field(None, max_length=128)
    workshop: Optional[str] = Field(None, max_length=128)
    plan_qty: Optional[float] = Field(None, ge=0)
    work_hours: Optional[float] = Field(None, ge=0)
    leader: Optional[str] = Field(None, max_length=64)
    repairer: Optional[str] = Field(None, max_length=64)
    material_handler: Optional[str] = Field(None, max_length=64)
    completed_qty: Optional[float] = Field(None, ge=0)
    temp_personnel: Optional[str] = Field(None, max_length=255)
    temp_people_count: Optional[int] = Field(None, ge=0)
    temp_count: Optional[int] = Field(None, ge=0)
    temp_amount: Optional[float] = Field(None, ge=0)
    remark: Optional[str] = Field(None, max_length=2000)
    leave_items: Optional[List[WorkshopDailyReportLeaveIn]] = None
    work_items: Optional[List[WorkshopDailyReportWorkIn]] = None
    task_items: Optional[List[WorkshopDailyReportTaskIn]] = None


class WorkshopDailyReportLeaveOut(BaseModel):
    id: Optional[int] = None
    report_id: Optional[int] = None
    leave_date: Optional[date] = None
    employee_name: Optional[str] = None
    emp_code: Optional[str] = None
    leave_hours: Optional[float] = None

    model_config = {"from_attributes": True}


class WorkshopDailyReportWorkOut(BaseModel):
    id: Optional[int] = None
    report_id: Optional[int] = None
    work_date: Optional[date] = None
    employee_name: Optional[str] = None
    emp_code: Optional[str] = None
    total_hours: Optional[float] = None
    leave_hours: Optional[float] = None
    normal_hours: Optional[float] = None
    overtime_hours: Optional[float] = None
    actual_hours: Optional[float] = None
    hourly_wage: Optional[float] = None
    amount: Optional[float] = None
    modulus: Optional[int] = None
    daily_attendance: Optional[str] = None

    model_config = {"from_attributes": True}


class WorkshopDailyReportTaskOut(BaseModel):
    id: Optional[int] = None
    report_id: Optional[int] = None
    seq: Optional[int] = None
    sale_order_no: Optional[str] = None
    production_order_no: Optional[str] = None
    public_material: Optional[str] = None
    specification: Optional[str] = None
    batch_qty: Optional[float] = None
    bom_no: Optional[str] = None
    material_code: Optional[str] = None
    process: Optional[str] = None
    process_remark: Optional[str] = None
    color: Optional[str] = None
    color_temp: Optional[str] = None
    product_unit_price: Optional[float] = None
    unit_price: Optional[float] = None
    completed_qty: Optional[float] = None
    amount: Optional[float] = None
    exception_amount: Optional[float] = None
    allocated_unit_price: Optional[float] = None
    allocated_amount: Optional[float] = None

    model_config = {"from_attributes": True}


class WorkshopDailyReportOut(BaseModel):
    """车间日报表 完整单据（含子表明细）"""
    id: Optional[int] = None
    report_no: Optional[str] = None
    title: Optional[str] = None
    report_type: Optional[str] = None
    department: Optional[str] = None
    group_name: Optional[str] = None
    workshop: Optional[str] = None
    report_date: Optional[date] = None
    plan_qty: Optional[float] = None
    work_hours: Optional[float] = None
    leader: Optional[str] = None
    repairer: Optional[str] = None
    material_handler: Optional[str] = None
    completed_qty: Optional[float] = None
    temp_personnel: Optional[str] = None
    temp_people_count: Optional[int] = None
    temp_count: Optional[int] = None
    temp_amount: Optional[float] = None
    remark: Optional[str] = None
    reporter: Optional[str] = None
    attendance_count: Optional[int] = None
    attendance_actual: Optional[int] = None
    leave_count: Optional[int] = None
    leave_hours_total: Optional[float] = None
    work_wages_total: Optional[float] = None
    grand_total_wages: Optional[float] = None
    modulus_total: Optional[int] = None
    data_source: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    leave_items: Optional[List[WorkshopDailyReportLeaveOut]] = Field(default_factory=list)
    work_items: Optional[List[WorkshopDailyReportWorkOut]] = Field(default_factory=list)
    task_items: Optional[List[WorkshopDailyReportTaskOut]] = Field(default_factory=list)

    model_config = {"from_attributes": True}


# ============ 工价审核数据（ERP 同步，只读） ============

class LaborPriceAuditOut(BaseModel):
    """工价审核列表行"""
    id: Optional[int] = None
    oa_id: Optional[str] = None
    doc_no: Optional[str] = None
    apply_date: Optional[date] = None
    valid_flag: Optional[int] = None
    department_id: Optional[int] = None
    material_id: Optional[int] = None
    material_code: Optional[str] = None
    labor_price_code: Optional[str] = None
    labor_price_amount: Optional[float] = None
    bom_id: Optional[int] = None
    bom_code: Optional[str] = None
    data_source: Optional[str] = None
    erp_updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


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
    kit_rate: Optional[float] = None
    kit_risk_level: Optional[str] = None
    shortage_material_count: Optional[int] = None
    latest_material_eta: Optional[date] = None


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
    kit_rate: Optional[float] = None
    kit_risk_level: Optional[str] = None
    shortage_material_count: Optional[int] = None
    latest_material_eta: Optional[date] = None
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
    manpower: Optional[int] = None  # 班组人数(默认走基础条件, 可手动覆盖)
    daily_work_hours: Optional[float] = None
    include_sunday: Optional[bool] = None  # 周日是否排产(默认走基础条件, 可手动覆盖)
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
    manpower: Optional[int] = None  # 班组人数(可空, 默认走基础条件)


class BatchAutoScheduleRequest(BaseModel):
    department: str = "生产"
    plan_date: Optional[date] = None
    daily_work_hours: Optional[float] = None
    owner: Optional[str] = None
    manpower: Optional[int] = None  # 批量统一人数(可被 item.manpower 覆盖)
    include_sunday: Optional[bool] = None  # 批量统一周日排产(可被 item 覆盖)
    items: List[BatchAutoScheduleItemIn]


class BaseConditionItemIn(BaseModel):
    schedule_bucket: str
    default_manpower: int = Field(ge=1, le=200)
    daily_work_hours: float = Field(ge=1, le=24)
    include_sunday: bool = False


class BaseConditionSaveRequest(BaseModel):
    items: List[BaseConditionItemIn]


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


class BoardCapacityItem(BaseModel):
    """某计划在某日的真实产能占槽记录（看板周视图用）。"""
    plan_id: int
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    department: Optional[str] = None
    schedule_bucket: Optional[str] = None
    hours: float


class BoardCapacityCell(BaseModel):
    """某 (date, department, schedule_bucket) 的真实日占用 + 占槽明细。

    看板周视图泳道以此为唯一来源：
      - total_hours = 该日该工段所有 active 占槽的 sum(hours)
      - items      = 当天每个计划在该工段的占槽明细
      - 不会出现「跨天 long 单在中间日被错误计入」的情况
    """
    date: date
    department: str
    schedule_bucket: str
    total_hours: float
    max_daily_hours: float
    items: List[BoardCapacityItem] = []


class BoardCapacityResponse(BaseModel):
    cells: List[BoardCapacityCell] = []
