"""异常与质量中心 — 异常总池聚合 + 闭环跟踪服务"""

from datetime import date
from collections import defaultdict
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.exception.risk_issue import RiskIssue
from app.models.exception.quality_issue import QualityIssue
from app.models.production.process_exception import ProcessException
from app.schemas.exception.schemas import (
    ExceptionPoolItem,
    ClosureTrackingData,
    ClosureStatusCount,
    ClosureByTypeItem,
    ClosureByPersonItem,
    ClosureDetailItem,
)


UNASSIGNED_OWNER = "未分配"


def _owner_filter(column, owner: str):
    if owner == UNASSIGNED_OWNER:
        return or_(column.is_(None), column == "")
    return column == owner


async def get_exception_pool(
    db: AsyncSession,
    source_type: str | None = None,
    status: str | None = None,
    owner: str | None = None,
    keyword: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[ExceptionPoolItem], int]:
    """聚合查询所有异常源，返回统一分页结果"""
    items: list[ExceptionPoolItem] = []
    today = date.today()

    # --- RiskIssue ---
    if not source_type or source_type == "risk_issue":
        q = select(RiskIssue)
        if status:
            q = q.where(RiskIssue.status == status)
        if owner:
            q = q.where(RiskIssue.owner.ilike(f'%{owner}%'))
        if keyword:
            like = f'%{keyword}%'
            q = q.where(
                RiskIssue.description.ilike(like)
                | RiskIssue.issue_no.ilike(like)
                | RiskIssue.order_no.ilike(like)
            )
        result = await db.execute(q.order_by(RiskIssue.created_at.desc()))
        for r in result.scalars().all():
            items.append(ExceptionPoolItem(
                source_type="risk_issue",
                source_id=r.id,
                source_no=r.issue_no,
                title=r.description,
                status=r.status,
                severity=r.risk_level,
                owner=r.owner,
                order_no=r.order_no,
                created_at=r.created_at,
            ))

    # --- QualityIssue ---
    if not source_type or source_type == "quality_issue":
        q = select(QualityIssue).where(QualityIssue.is_deleted == False)
        if status:
            q = q.where(QualityIssue.status == status)
        if owner:
            q = q.where(QualityIssue.responsible_person.ilike(f'%{owner}%'))
        if keyword:
            like = f'%{keyword}%'
            q = q.where(
                QualityIssue.description.ilike(like)
                | QualityIssue.issue_no.ilike(like)
                | QualityIssue.order_no.ilike(like)
            )
        result = await db.execute(q.order_by(QualityIssue.created_at.desc()))
        for r in result.scalars().all():
            items.append(ExceptionPoolItem(
                source_type="quality_issue",
                source_id=r.id,
                source_no=r.issue_no,
                title=r.description,
                status=r.status,
                severity=None,
                owner=r.responsible_person,
                order_no=r.order_no,
                created_at=r.created_at,
            ))

    # --- ProcessException ---
    if not source_type or source_type == "process_exception":
        q = select(ProcessException)
        if status:
            q = q.where(ProcessException.status == status)
        if owner:
            q = q.where(ProcessException.responsible_person.ilike(f'%{owner}%'))
        if keyword:
            like = f'%{keyword}%'
            q = q.where(
                ProcessException.description.ilike(like)
                | ProcessException.exception_no.ilike(like)
                | ProcessException.order_no.ilike(like)
            )
        result = await db.execute(q.order_by(ProcessException.created_at.desc()))
        for r in result.scalars().all():
            items.append(ExceptionPoolItem(
                source_type="process_exception",
                source_id=r.id,
                source_no=r.exception_no,
                title=r.description,
                status=r.status,
                severity=r.severity,
                owner=r.responsible_person,
                order_no=r.order_no,
                created_at=r.created_at,
            ))

    # Sort all items by created_at desc
    items.sort(key=lambda x: x.created_at or date.min, reverse=True)

    total = len(items)
    start = (page - 1) * page_size
    page_items = items[start:start + page_size]

    return page_items, total


async def get_closure_tracking(
    db: AsyncSession,
    source_type: str | None = None,
    status: str | None = None,
    owner: str | None = None,
    sort_by: str | None = None,
    sort_order: str = "asc",
) -> ClosureTrackingData:
    """闭环跟踪统计：跨所有异常源统计状态分布、超时数、按类型/责任人分布"""
    today = date.today()
    status_counts: dict[str, int] = defaultdict(int)
    by_type: dict[str, dict] = defaultdict(lambda: {"open": 0, "in_progress": 0, "closed": 0, "overdue": 0})
    by_person: dict[str, dict] = defaultdict(lambda: {"open": 0, "in_progress": 0, "closed": 0, "overdue": 0})

    # --- RiskIssue ---
    should_query_risk = not source_type or source_type == "risk_issue"
    if should_query_risk:
        q = select(RiskIssue)
        if status:
            q = q.where(RiskIssue.status == status)
        if owner:
            q = q.where(RiskIssue.owner.ilike(f'%{owner}%'))
        result = await db.execute(q)
        for r in result.scalars().all():
            s = r.status
            status_counts[s] += 1
            by_type["risk_issue"][s] = by_type["risk_issue"].get(s, 0) + 1
            overdue = s != "closed" and r.commit_date and r.commit_date < today
            if overdue:
                by_type["risk_issue"]["overdue"] = by_type["risk_issue"].get("overdue", 0) + 1
            own = r.owner or "未分配"
            if not owner or own == owner or owner in own:
                by_person[own][s] = by_person[own].get(s, 0) + 1
                if overdue:
                    by_person[own]["overdue"] = by_person[own].get("overdue", 0) + 1

    # --- QualityIssue ---
    should_query_quality = not source_type or source_type == "quality_issue"
    if should_query_quality:
        q = select(QualityIssue).where(QualityIssue.is_deleted == False)
        if status:
            q = q.where(QualityIssue.status == status)
        if owner:
            q = q.where(QualityIssue.responsible_person.ilike(f'%{owner}%'))
        result = await db.execute(q)
        for r in result.scalars().all():
            s = r.status
            status_counts[s] += 1
            by_type["quality_issue"][s] = by_type["quality_issue"].get(s, 0) + 1
            overdue = s != "closed" and r.submit_date and r.submit_date < today
            if overdue:
                by_type["quality_issue"]["overdue"] = by_type["quality_issue"].get("overdue", 0) + 1
            own = r.responsible_person or "未分配"
            if not owner or own == owner or owner in own:
                by_person[own][s] = by_person[own].get(s, 0) + 1
                if overdue:
                    by_person[own]["overdue"] = by_person[own].get("overdue", 0) + 1

    # --- ProcessException ---
    should_query_process = not source_type or source_type == "process_exception"
    if should_query_process:
        q = select(ProcessException)
        if status:
            q = q.where(ProcessException.status == status)
        if owner:
            q = q.where(ProcessException.responsible_person.ilike(f'%{owner}%'))
        result = await db.execute(q)
        for r in result.scalars().all():
            s = r.status
            status_counts[s] += 1
            by_type["process_exception"][s] = by_type["process_exception"].get(s, 0) + 1
            overdue = s != "closed" and r.resolved_at is None
            if overdue:
                by_type["process_exception"]["overdue"] = by_type["process_exception"].get("overdue", 0) + 1
            own = r.responsible_person or "未分配"
            if not owner or own == owner or owner in own:
                by_person[own][s] = by_person[own].get(s, 0) + 1
                if overdue:
                    by_person[own]["overdue"] = by_person[own].get("overdue", 0) + 1

    sc_list = [ClosureStatusCount(status=s, count=c) for s, c in sorted(status_counts.items())]

    reverse = sort_order.lower() == "desc"

    def _type_item(source: str, counts: dict) -> ClosureByTypeItem:
        return ClosureByTypeItem(
            source_type=source,
            open_count=counts.get("open", 0),
            in_progress_count=counts.get("in_progress", 0),
            closed_count=counts.get("closed", 0),
            overdue_count=counts.get("overdue", 0),
        )

    def _person_item(person: str, counts: dict) -> ClosureByPersonItem:
        return ClosureByPersonItem(
            owner=person,
            open_count=counts.get("open", 0),
            in_progress_count=counts.get("in_progress", 0),
            closed_count=counts.get("closed", 0),
            overdue_count=counts.get("overdue", 0),
        )

    bt_list = [_type_item(st, d) for st, d in by_type.items()]
    bp_list = [_person_item(p, d) for p, d in by_person.items()]
    sortable_fields = {
        "source_type",
        "owner",
        "open_count",
        "in_progress_count",
        "closed_count",
        "overdue_count",
    }
    sort_field = sort_by if sort_by in sortable_fields else "open_count"
    bt_list.sort(key=lambda x: getattr(x, sort_field, x.source_type), reverse=reverse)
    bp_list.sort(key=lambda x: getattr(x, sort_field, x.owner), reverse=reverse)

    return ClosureTrackingData(
        status_counts=sc_list,
        by_type=bt_list,
        by_person=bp_list,
        total_open=status_counts.get("open", 0),
        total_in_progress=status_counts.get("in_progress", 0),
        total_closed=status_counts.get("closed", 0),
        total_overdue=sum(d.get("overdue", 0) for d in by_type.values()),
    )


async def get_closure_person_details(
    db: AsyncSession,
    owner: str,
    source_type: str | None = None,
    status: str | None = None,
) -> list[ClosureDetailItem]:
    """按责任人查询闭环跟踪明细，用于前端展开行查看异常列表。"""
    details: list[ClosureDetailItem] = []

    if not owner:
        return details

    if not source_type or source_type == "risk_issue":
        q = select(RiskIssue).where(_owner_filter(RiskIssue.owner, owner))
        if status:
            q = q.where(RiskIssue.status == status)
        result = await db.execute(q.order_by(RiskIssue.created_at.desc()))
        for r in result.scalars().all():
            details.append(ClosureDetailItem(
                source_type="risk_issue",
                source_id=r.id,
                source_no=r.issue_no,
                title=r.description,
                status=r.status,
                owner=r.owner,
                order_no=r.order_no,
                created_at=r.created_at,
            ))

    if not source_type or source_type == "quality_issue":
        q = select(QualityIssue).where(
            _owner_filter(QualityIssue.responsible_person, owner),
            QualityIssue.is_deleted == False,
        )
        if status:
            q = q.where(QualityIssue.status == status)
        result = await db.execute(q.order_by(QualityIssue.created_at.desc()))
        for r in result.scalars().all():
            details.append(ClosureDetailItem(
                source_type="quality_issue",
                source_id=r.id,
                source_no=r.issue_no,
                title=r.description,
                status=r.status,
                owner=r.responsible_person,
                order_no=r.order_no,
                created_at=r.created_at,
            ))

    if not source_type or source_type == "process_exception":
        q = select(ProcessException).where(_owner_filter(ProcessException.responsible_person, owner))
        if status:
            q = q.where(ProcessException.status == status)
        result = await db.execute(q.order_by(ProcessException.created_at.desc()))
        for r in result.scalars().all():
            details.append(ClosureDetailItem(
                source_type="process_exception",
                source_id=r.id,
                source_no=r.exception_no,
                title=r.description,
                status=r.status,
                owner=r.responsible_person,
                order_no=r.order_no,
                created_at=r.created_at,
            ))

    details.sort(key=lambda x: x.created_at or date.min, reverse=True)
    return details
