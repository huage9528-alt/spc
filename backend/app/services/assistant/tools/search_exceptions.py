"""Tool: 搜索异常 / 品质异常"""

from typing import Any, Dict

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.exception.risk_issue import RiskIssue
from app.models.exception.quality_issue import QualityIssue
from app.services.assistant.tool_registry import register_tool

PARAMETERS = {
    "type": "object",
    "properties": {
        "keyword": {
            "type": "string",
            "description": "搜索关键词",
        },
        "order_no": {
            "type": "string",
            "description": "关联的订单号",
        },
        "risk_level": {
            "type": "string",
            "description": "风险等级",
        },
        "status": {
            "type": "string",
            "description": "状态筛选，如 open, closed",
        },
        "exception_type": {
            "type": "string",
            "enum": ["risk", "quality"],
            "description": "异常类别: risk=风险问题, quality=品质异常。不指定则查全部。",
        },
        "limit": {
            "type": "integer",
            "description": "返回条数上限，默认20",
        },
    },
    "required": [],
}


@register_tool(
    name="search_exceptions",
    description="搜索异常与质量中心数据，包括风险问题、品质异常。支持按关键词、订单号、风险等级、状态、异常类别等条件查询。返回完整的异常信息。",
    parameters=PARAMETERS,
    display_name="异常与质量查询",
)
async def search_exceptions(db: AsyncSession, params: Dict[str, Any]) -> Dict[str, Any]:
    exception_type = params.get("exception_type")
    keyword = params.get("keyword")
    order_no = params.get("order_no")
    risk_level = params.get("risk_level")
    status = params.get("status")
    limit = params.get("limit", 20)

    items = []
    total = 0

    # --- 风险问题 ---
    if not exception_type or exception_type == "risk":
        q = select(RiskIssue)
        cq = select(func.count(RiskIssue.id))
        filters = []
        if keyword:
            like = f"%{keyword}%"
            filters.append(RiskIssue.description.ilike(like) | RiskIssue.issue_no.ilike(like))
        if order_no:
            filters.append(RiskIssue.order_no.ilike(f"%{order_no}%"))
        if risk_level:
            filters.append(RiskIssue.risk_level == risk_level)
        if status:
            filters.append(RiskIssue.status == status)
        for f in filters:
            q = q.where(f)
            cq = cq.where(f)
        cnt = (await db.execute(cq)).scalar() or 0
        total += cnt
        q = q.order_by(RiskIssue.created_at.desc()).limit(limit)
        rows = (await db.execute(q)).scalars().all()
        for r in rows:
            items.append({
                "type": "risk_issue",
                "title": f"风险问题 {r.issue_no}",
                "subtitle": r.description[:80] if r.description else "",
                "url": "/issues",
                "tags": [t for t in [r.risk_level, r.status, r.issue_type] if t],
                # 完整字段
                "issue_no": r.issue_no,
                "issue_type": r.issue_type,
                "risk_level": r.risk_level,
                "order_no": r.order_no,
                "line_no": r.line_no,
                "material_code": r.material_code,
                "po_no": r.po_no,
                "description": r.description,
                "owner": r.owner,
                "action_taken": r.action_taken,
                "commit_date": str(r.commit_date) if r.commit_date else None,
                "status": r.status,
                "closed_at": str(r.closed_at) if r.closed_at else None,
                "created_at": str(r.created_at) if r.created_at else None,
            })

    # --- 品质异常 ---
    if not exception_type or exception_type == "quality":
        q = select(QualityIssue)
        cq = select(func.count(QualityIssue.id))
        filters = [QualityIssue.is_deleted == False]
        if keyword:
            like = f"%{keyword}%"
            filters.append(QualityIssue.description.ilike(like) | QualityIssue.issue_no.ilike(like) | QualityIssue.product_name.ilike(like))
        if order_no:
            filters.append(QualityIssue.order_no.ilike(f"%{order_no}%"))
        if status:
            filters.append(QualityIssue.status == status)
        for f in filters:
            q = q.where(f)
            cq = cq.where(f)
        cnt = (await db.execute(cq)).scalar() or 0
        total += cnt
        q = q.order_by(QualityIssue.created_at.desc()).limit(limit)
        rows = (await db.execute(q)).scalars().all()
        for r in rows:
            items.append({
                "type": "quality_issue",
                "title": f"品质异常 {r.issue_no}",
                "subtitle": f"{r.product_name or ''} | {r.defect_type or ''} | {r.description[:60] if r.description else ''}",
                "url": "/quality-issues",
                "tags": [t for t in [r.status, r.defect_type] if t],
                # 完整字段
                "issue_no": r.issue_no,
                "status": r.status,
                "remark": r.remark,
                "submit_dept": r.submit_dept,
                "submit_date": str(r.submit_date) if r.submit_date else None,
                "submitter": r.submitter,
                "order_no": r.order_no,
                "product_code": r.product_code,
                "product_name": r.product_name,
                "process": r.process,
                "defect_type": r.defect_type,
                "root_cause": r.root_cause,
                "description": r.description,
                "responsible_person": r.responsible_person,
                "responsible_dept": r.responsible_dept,
                "batch_qty": r.batch_qty,
                "sample_qty": r.sample_qty,
                "defect_qty": r.defect_qty,
                "improvement_countermeasures": r.improvement_countermeasures,
                "improvement_countermeasures_date": str(r.improvement_countermeasures_date) if r.improvement_countermeasures_date else None,
                "temporary_countermeasure": r.temporary_countermeasure,
                "temporary_countermeasure_date": str(r.temporary_countermeasure_date) if r.temporary_countermeasure_date else None,
                "preliminary_analysis": r.preliminary_analysis,
                "preliminary_analysis_person": r.preliminary_analysis_person,
                "root_cause_analysis_person": r.root_cause_analysis_person,
                "audit_comment": r.audit_comment,
                "auditor": r.auditor,
                "created_at": str(r.created_at) if r.created_at else None,
            })

    return {"total": total, "items": items}
