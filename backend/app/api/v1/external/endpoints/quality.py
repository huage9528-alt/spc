"""质量异常 / 质量追溯 对外接口（AEOS 只读接入）

数据源仅 quality_issue 现有字段：契约中无来源的字段（issue_type / severity /
inspection_result / line_no / material_code / batch_no / supplier_code /
blocking / blocking_reason）恒返回 null，不虚构；字段映射、枚举与追溯规则见
docs/superpowers/specs/2026-09-22-spc-quality-external-api-design.md。
"""

from datetime import date, datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.bom import Bom
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.exception.quality_issue import QualityIssue
from app.models.order.sale_order import SaleOrderLine
from app.schemas.common import ResponseModel
from app.services.material.kitting_calc_service import freshness_of

from ..common import ExternalDataPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="/quality-issues", tags=["品质异常"])
router_trace = APIRouter(prefix="/quality-trace", tags=["品质追溯"])


def _freshness_meta(data_as_of: Optional[datetime]) -> dict:
    """空集返回 unknown/false（不是过期数据）；有数据复用 6h/24h 阈值。"""
    if data_as_of is None:
        return {"data_as_of": None, "data_confidence": "unknown", "stale": False}
    confidence, stale = freshness_of(data_as_of)
    return {"data_as_of": data_as_of.isoformat(), "data_confidence": confidence, "stale": stale}


def serialize_quality_issue(issue: QualityIssue) -> dict:
    """契约字段（无来源恒 null）+ SPC 原生字段；列表与追溯共用。"""
    occurred_at = issue.submit_date.isoformat() if issue.submit_date else (
        issue.created_at.isoformat() if issue.created_at else None
    )
    return {
        "id": issue.id,
        "issue_no": issue.issue_no,
        "issue_type": None,
        "title": issue.description,
        "severity": None,
        "status": issue.status,
        "inspection_result": None,
        "order_no": issue.order_no,
        "line_no": None,
        "product_code": issue.product_code,
        "material_code": None,
        "batch_no": None,
        "supplier_code": None,
        "sample_qty": issue.sample_qty,
        "defect_qty": issue.defect_qty,
        "affected_qty": issue.batch_qty,
        "blocking": None,
        "blocking_reason": None,
        "owner_org": issue.responsible_dept,
        "owner": issue.responsible_person,
        "occurred_at": occurred_at,
        "updated_at": issue.updated_at.isoformat() if issue.updated_at else None,
        "defect_type": issue.defect_type,
        "process": issue.process,
        "product_name": issue.product_name,
        "submit_dept": issue.submit_dept,
        "submitter": issue.submitter,
        "workflow_status": issue.workflow_status,
        "batch_qty": issue.batch_qty,
        "created_at": issue.created_at.isoformat() if issue.created_at else None,
    }


class QualityIssueOut(BaseModel):
    """质量异常（契约字段 + SPC 原生字段）"""

    id: int
    issue_no: str
    issue_type: Optional[str] = None
    title: Optional[str] = None
    severity: Optional[str] = None
    status: Optional[str] = None
    inspection_result: Optional[str] = None
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    product_code: Optional[str] = None
    material_code: Optional[str] = None
    batch_no: Optional[str] = None
    supplier_code: Optional[str] = None
    sample_qty: Optional[int] = None
    defect_qty: Optional[int] = None
    affected_qty: Optional[int] = None
    blocking: Optional[bool] = None
    blocking_reason: Optional[str] = None
    owner_org: Optional[str] = None
    owner: Optional[str] = None
    occurred_at: Optional[str] = None
    updated_at: Optional[str] = None
    defect_type: Optional[str] = None
    process: Optional[str] = None
    product_name: Optional[str] = None
    submit_dept: Optional[str] = None
    submitter: Optional[str] = None
    workflow_status: Optional[str] = None
    batch_qty: Optional[int] = None
    created_at: Optional[str] = None


class QualityIssuesListQuery(PageParamsMixin):
    issue_no: Optional[str] = Field(None, description="质量异常编号精确匹配")
    order_no: Optional[str] = Field(None, description="订单号精确匹配")
    product_code: Optional[str] = Field(None, description="产品编码精确匹配")
    status: Optional[str] = Field(None, description="状态，逗号分隔多选：open/in_progress/closed")
    defect_type: Optional[str] = Field(None, description="缺陷类型精确匹配")
    submit_dept: Optional[str] = Field(None, description="提出部门精确匹配")
    occurred_start: Optional[date] = Field(None, description="发生日期起 YYYY-MM-DD（过滤 submit_date）")
    occurred_end: Optional[date] = Field(None, description="发生日期止 YYYY-MM-DD（过滤 submit_date）")
    updated_after: Optional[datetime] = Field(
        None, description="增量同步，仅返回 updated_at >= 此时间的记录（ISO 8601）"
    )
    request_id: Optional[str] = Field(None, description="调用方请求 ID（回显）")


def _quality_conditions(q: QualityIssuesListQuery) -> list:
    conditions = [QualityIssue.is_deleted == False]
    if q.issue_no:
        conditions.append(QualityIssue.issue_no == q.issue_no)
    if q.order_no:
        conditions.append(QualityIssue.order_no == q.order_no)
    if q.product_code:
        conditions.append(QualityIssue.product_code == q.product_code)
    if q.status:
        statuses = [s.strip() for s in q.status.split(",") if s.strip()]
        if statuses:
            conditions.append(QualityIssue.status.in_(statuses))
    if q.defect_type:
        conditions.append(QualityIssue.defect_type == q.defect_type)
    if q.submit_dept:
        conditions.append(QualityIssue.submit_dept == q.submit_dept)
    if q.occurred_start:
        conditions.append(QualityIssue.submit_date >= q.occurred_start)
    if q.occurred_end:
        conditions.append(QualityIssue.submit_date <= q.occurred_end)
    if q.updated_after:
        conditions.append(QualityIssue.updated_at >= q.updated_after)
    return conditions


@router.get("/list", response_model=ResponseModel[ExternalDataPage[QualityIssueOut]],
            summary="质量异常列表", description="endpoint_code: quality_issues.list")
@register_external(
    "quality_issues.list", "质量异常列表", method="GET", path="/quality-issues/list",
    description="品质异常查询（状态 open/in_progress/closed）；无数据源字段返回 null，不虚构",
    tags=["品质异常"],
)
@log_external_call("quality_issues.list")
async def quality_issues_list(
    request: Request,
    q: Annotated[QualityIssuesListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("quality_issues.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)
    conditions = _quality_conditions(q)

    total = (await db.execute(select(func.count(QualityIssue.id)).where(*conditions))).scalar() or 0
    data_as_of = (
        await db.execute(select(func.max(QualityIssue.updated_at)).where(*conditions))
    ).scalar()

    rows = (
        await db.execute(
            select(QualityIssue)
            .where(*conditions)
            .order_by(QualityIssue.submit_date.desc().nullslast(), QualityIssue.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).scalars().all()

    return {
        "items": [serialize_quality_issue(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        **_freshness_meta(data_as_of),
        "request_id": q.request_id,
    }


class QualityTraceListQuery(PageParamsMixin):
    order_no: Optional[str] = Field(None, description="追溯锚点：订单号")
    product_code: Optional[str] = Field(None, description="追溯锚点：产品编码")
    batch_no: Optional[str] = Field(None, description="追溯锚点：批次号")
    supplier_code: Optional[str] = Field(None, description="暂不支持（质量异常未关联供应商），传即 422")
    request_id: Optional[str] = Field(None, description="调用方请求 ID（回显）")


@router_trace.get("/list", response_model=ResponseModel[ExternalDataPage[dict]],
                  summary="质量追溯", description="endpoint_code: quality_trace.list")
@register_external(
    "quality_trace.list", "质量追溯", method="GET", path="/quality-trace/list",
    description="按订单号/产品编码/批次号追溯质量异常、订单行与 BOM 节点；批次锚点下质量异常为同订单推断关联（via_batch_order）",
    tags=["品质追溯"],
)
@log_external_call("quality_trace.list")
async def quality_trace_list(
    request: Request,
    q: Annotated[QualityTraceListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("quality_trace.list")),
):
    if q.supplier_code:
        raise HTTPException(
            status_code=422,
            detail="supplier_code 追溯暂不支持（质量异常未关联供应商），请使用 order_no / product_code / batch_no",
        )
    if q.order_no:
        anchor, anchor_value = "order_no", q.order_no
    elif q.product_code:
        anchor, anchor_value = "product_code", q.product_code
    elif q.batch_no:
        anchor, anchor_value = "batch_no", q.batch_no
    else:
        raise HTTPException(status_code=422, detail="至少提供 order_no / product_code / batch_no 之一")

    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    line_column = {
        "order_no": SaleOrderLine.order_no,
        "product_code": SaleOrderLine.product_code,
        "batch_no": SaleOrderLine.batch_no,
    }[anchor]
    lines = (
        await db.execute(select(SaleOrderLine).where(line_column == anchor_value))
    ).scalars().all()

    if anchor == "order_no":
        issue_where = [QualityIssue.order_no == anchor_value]
        issue_relation = "order_no"
    elif anchor == "product_code":
        issue_where = [QualityIssue.product_code == anchor_value]
        issue_relation = "product_code"
    else:
        order_nos = sorted({ln.order_no for ln in lines if ln.order_no})
        issue_where = [QualityIssue.order_no.in_(order_nos)] if order_nos else []
        issue_relation = "via_batch_order"
    issues: list = []
    if issue_where:
        issues = (
            await db.execute(
                select(QualityIssue).where(QualityIssue.is_deleted == False, *issue_where)
            )
        ).scalars().all()

    bom_ids = {str(ln.bom_id) for ln in lines if ln.bom_id is not None}
    bom_nos = set()
    for ln in lines:
        if ln.bom_no:
            bom_nos.add(ln.bom_no)
            if ln.bom_no.startswith(("P-", "Y-")):
                bom_nos.add(ln.bom_no[2:])
    boms: list = []
    if bom_ids or bom_nos:
        bom_where = []
        if bom_ids:
            bom_where.append(Bom.bom_id.in_(bom_ids))
        if bom_nos:
            bom_where.append(Bom.bom_no.in_(bom_nos))
        seen: set = set()
        for bom in (await db.execute(select(Bom).where(or_(*bom_where)))).scalars().all():
            if bom.bom_id not in seen:
                seen.add(bom.bom_id)
                boms.append(bom)

    nodes: list = []
    for issue in sorted(issues, key=lambda x: (x.submit_date or date.min, x.id), reverse=True):
        node = {"object_type": "quality_issue", "object_id": issue.issue_no, "relation": issue_relation}
        node.update(serialize_quality_issue(issue))
        nodes.append(node)
    for line in sorted(lines, key=lambda x: (x.order_no or "", x.line_no or "")):
        nodes.append({
            "object_type": "order_line",
            "object_id": f"{line.order_no}:{line.line_no}",
            "relation": anchor,
            "order_no": line.order_no,
            "line_no": line.line_no,
            "product_code": line.product_code,
            "product_name": line.product_name,
            "order_qty": float(line.order_qty) if line.order_qty is not None else None,
            "batch_no": line.batch_no,
            "bom_no": line.bom_no,
            "bom_id": line.bom_id,
            "promised_date": line.promised_date.isoformat() if line.promised_date else None,
            "status": line.status,
            "updated_at": line.updated_at.isoformat() if line.updated_at else None,
        })
    for bom in sorted(boms, key=lambda x: x.bom_no or ""):
        nodes.append({
            "object_type": "bom",
            "object_id": bom.bom_id,
            "relation": "order_line",
            "bom_id": bom.bom_id,
            "bom_no": bom.bom_no,
            "bom_version": bom.bom_version,
            "bom_type": bom.bom_type,
            "parent_bom_id": bom.parent_bom_id,
        })

    updated_candidates = [i.updated_at for i in issues if i.updated_at] + [
        ln.updated_at for ln in lines if ln.updated_at
    ]
    data_as_of = max(updated_candidates) if updated_candidates else None

    total = len(nodes)
    start = (page - 1) * page_size
    return {
        "items": nodes[start:start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
        **_freshness_meta(data_as_of),
        "request_id": q.request_id,
    }
