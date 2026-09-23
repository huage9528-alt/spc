"""异常与质量中心 — Schema定义"""

from typing import Optional, List
from datetime import date, datetime
from pydantic import BaseModel


# ============ RiskIssue (风险问题，已有) ============

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


class RiskIssueCreate(BaseModel):
    issue_type: str
    risk_level: str
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    material_code: Optional[str] = None
    po_no: Optional[str] = None
    description: Optional[str] = None
    owner: Optional[str] = None


class RiskIssueUpdate(BaseModel):
    risk_level: Optional[str] = None
    description: Optional[str] = None
    owner: Optional[str] = None
    action_taken: Optional[str] = None
    commit_date: Optional[date] = None
    status: Optional[str] = None


# ============ QualityIssue (品质异常) ============

class QualityIssueOut(BaseModel):
    id: int
    erp_quality_id: Optional[str] = None
    issue_no: str
    status: str
    workflow_status: str = '创建'
    remark: Optional[str] = None
    submit_dept: Optional[str] = None
    submit_date: Optional[date] = None
    submitter: Optional[str] = None
    order_no: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    process: Optional[str] = None
    defect_type: Optional[str] = None
    root_cause: Optional[str] = None
    description: Optional[str] = None
    responsible_person: Optional[str] = None
    responsible_dept: Optional[str] = None
    batch_qty: Optional[int] = None
    sample_qty: Optional[int] = None
    defect_qty: Optional[int] = None
    improvement_countermeasures: Optional[str] = None
    improvement_countermeasures_date: Optional[date] = None
    temporary_countermeasure: Optional[str] = None
    temporary_countermeasure_date: Optional[date] = None
    preliminary_analysis: Optional[str] = None
    preliminary_analysis_person: Optional[str] = None
    root_cause_analysis_person: Optional[str] = None
    audit_comment: Optional[str] = None
    auditor: Optional[str] = None
    quality_manager_approval: Optional[str] = None
    general_manager_approval: Optional[str] = None
    missed_inspector: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class QualityIssueCreate(BaseModel):
    erp_quality_id: Optional[str] = None
    submit_dept: Optional[str] = None
    submit_date: Optional[date] = None
    submitter: Optional[str] = None
    order_no: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    process: Optional[str] = None
    defect_type: Optional[str] = None
    root_cause: Optional[str] = None
    description: Optional[str] = None
    responsible_person: Optional[str] = None
    responsible_dept: Optional[str] = None
    batch_qty: Optional[int] = None
    sample_qty: Optional[int] = None
    defect_qty: Optional[int] = None
    improvement_countermeasures: Optional[str] = None
    improvement_countermeasures_date: Optional[date] = None
    temporary_countermeasure: Optional[str] = None
    temporary_countermeasure_date: Optional[date] = None
    preliminary_analysis: Optional[str] = None
    preliminary_analysis_person: Optional[str] = None
    root_cause_analysis_person: Optional[str] = None
    audit_comment: Optional[str] = None
    auditor: Optional[str] = None
    quality_manager_approval: Optional[str] = None
    general_manager_approval: Optional[str] = None
    missed_inspector: Optional[str] = None
    status: Optional[str] = 'open'
    workflow_status: Optional[str] = '创建'
    remark: Optional[str] = None


class QualityIssueUpdate(BaseModel):
    erp_quality_id: Optional[str] = None
    submit_dept: Optional[str] = None
    submit_date: Optional[date] = None
    submitter: Optional[str] = None
    order_no: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    process: Optional[str] = None
    defect_type: Optional[str] = None
    root_cause: Optional[str] = None
    description: Optional[str] = None
    responsible_person: Optional[str] = None
    responsible_dept: Optional[str] = None
    batch_qty: Optional[int] = None
    sample_qty: Optional[int] = None
    defect_qty: Optional[int] = None
    improvement_countermeasures: Optional[str] = None
    improvement_countermeasures_date: Optional[date] = None
    temporary_countermeasure: Optional[str] = None
    temporary_countermeasure_date: Optional[date] = None
    preliminary_analysis: Optional[str] = None
    preliminary_analysis_person: Optional[str] = None
    root_cause_analysis_person: Optional[str] = None
    audit_comment: Optional[str] = None
    auditor: Optional[str] = None
    quality_manager_approval: Optional[str] = None
    general_manager_approval: Optional[str] = None
    missed_inspector: Optional[str] = None
    status: Optional[str] = None
    workflow_status: Optional[str] = None
    remark: Optional[str] = None


# ============ ExceptionPool (异常总池聚合) ============

class ExceptionPoolItem(BaseModel):
    source_type: str  # risk_issue / issue_log / change_log / quality_issue / process_exception
    source_id: int
    source_no: str
    title: Optional[str] = None
    status: str
    severity: Optional[str] = None  # risk_level or severity
    owner: Optional[str] = None
    order_no: Optional[str] = None
    created_at: Optional[datetime] = None


# ============ ClosureTracking (闭环跟踪) ============

class ClosureStatusCount(BaseModel):
    status: str
    count: int


class ClosureByTypeItem(BaseModel):
    source_type: str
    open_count: int
    in_progress_count: int
    closed_count: int
    overdue_count: int


class ClosureByPersonItem(BaseModel):
    owner: str
    open_count: int
    in_progress_count: int
    closed_count: int
    overdue_count: int


class ClosureDetailItem(BaseModel):
    source_type: str
    source_id: int
    source_no: str
    title: Optional[str] = None
    status: str
    owner: Optional[str] = None
    order_no: Optional[str] = None
    created_at: Optional[datetime] = None


class ClosureTrackingData(BaseModel):
    status_counts: List[ClosureStatusCount]
    by_type: List[ClosureByTypeItem]
    by_person: List[ClosureByPersonItem]
    total_open: int
    total_in_progress: int
    total_closed: int
    total_overdue: int


# ============ RiskRule (已有，保留) ============

class RiskRuleOut(BaseModel):
    id: int
    rule_code: str
    rule_name: str
    rule_type: str
    condition_json: Optional[dict] = None
    risk_level: str
    is_active: bool = True
    version: int = 1
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class RiskRuleCreate(BaseModel):
    rule_code: str
    rule_name: str
    rule_type: str
    condition_json: Optional[dict] = None
    risk_level: str
    is_active: bool = True


class RiskRuleUpdate(BaseModel):
    rule_name: Optional[str] = None
    rule_type: Optional[str] = None
    condition_json: Optional[dict] = None
    risk_level: Optional[str] = None
    is_active: Optional[bool] = None
