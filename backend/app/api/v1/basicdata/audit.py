"""审计日志 API"""

from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.models.basicdata.audit_log import AuditLog
from app.schemas.common import ResponseModel

router = APIRouter()

SORTABLE_COLUMNS = {
    'operated_at': AuditLog.operated_at,
    'operator': AuditLog.operator,
    'action': AuditLog.action,
    'table_name': AuditLog.table_name,
    'record_id': AuditLog.record_id,
    'field_name': AuditLog.field_name,
}


def _append_filters(query, *, keyword: Optional[str] = None, action: Optional[str] = None,
                    table_name: Optional[str] = None, record_id: Optional[int] = None,
                    operator: Optional[str] = None):
    """追加审计日志通用筛选条件（列表 / 统计共用）"""
    if keyword:
        like = f"%{keyword}%"
        query = query.where(
            or_(
                AuditLog.operator.ilike(like),
                AuditLog.table_name.ilike(like),
                AuditLog.field_name.ilike(like),
            )
        )
    if action:
        actions = [a.strip() for a in action.split(",") if a.strip()]
        if actions:
            query = query.where(AuditLog.action.in_(actions))
    if table_name:
        tables = [t.strip() for t in table_name.split(",") if t.strip()]
        if tables:
            query = query.where(AuditLog.table_name.in_(tables))
    if record_id is not None:
        query = query.where(AuditLog.record_id == record_id)
    if operator:
        operators = [o.strip() for o in operator.split(",") if o.strip()]
        if operators:
            query = query.where(AuditLog.operator.in_(operators))
    return query


@router.get("/logs", response_model=ResponseModel[dict])
async def list_audit_logs(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    keyword: str = Query(default="", description="搜索操作人/表名/字段"),
    sort_by: Optional[str] = Query(None, description="排序字段"),
    sort_order: Optional[str] = Query(None, description="排序方向 asc/desc"),
    action: Optional[str] = Query(None, description="操作类型筛选，逗号分隔"),
    table_name: Optional[str] = Query(None, description="表名筛选，逗号分隔"),
    record_id: Optional[int] = Query(None, description="记录ID筛选（如单条数据的操作历史）"),
    operator: Optional[str] = Query(None, description="操作人筛选，逗号分隔"),
    current_user: dict = Depends(PermissionChecker("audit", "read")),
    db: AsyncSession = Depends(get_db),
):
    """获取审计日志列表"""
    query = _append_filters(
        select(AuditLog), keyword=keyword, action=action,
        table_name=table_name, record_id=record_id, operator=operator,
    )

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    # 排序
    order_clauses = []
    if sort_by and sort_by in SORTABLE_COLUMNS:
        col = SORTABLE_COLUMNS[sort_by]
        if sort_order == 'desc':
            order_clauses.append(col.desc().nullslast())
        else:
            order_clauses.append(col.asc().nullslast())
    if not order_clauses:
        order_clauses = [AuditLog.operated_at.desc()]

    query = query.order_by(*order_clauses)
    query = query.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    logs = result.scalars().all()

    items = [
        {
            "id": log.id,
            "table_name": log.table_name,
            "record_id": log.record_id,
            "action": log.action,
            "field_name": log.field_name,
            "old_value": log.old_value,
            "new_value": log.new_value,
            "operator": log.operator,
            "operated_at": log.operated_at.strftime("%Y-%m-%d %H:%M:%S") if log.operated_at else None,
        }
        for log in logs
    ]

    return ResponseModel(data={
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
    })


@router.get("/logs/stats", response_model=ResponseModel[dict])
async def audit_log_stats(
    keyword: str = Query(default="", description="搜索操作人/表名/字段"),
    action: Optional[str] = Query(None, description="操作类型筛选，逗号分隔"),
    table_name: Optional[str] = Query(None, description="表名筛选，逗号分隔"),
    record_id: Optional[int] = Query(None, description="记录ID筛选"),
    operator: Optional[str] = Query(None, description="操作人筛选，逗号分隔"),
    current_user: dict = Depends(PermissionChecker("audit", "read")),
    db: AsyncSession = Depends(get_db),
):
    """审计日志统计：匹配条件下的总量 / 今日量 / 按动作分组计数（与列表同筛选口径）"""
    base = _append_filters(
        select(AuditLog.id), keyword=keyword, action=action,
        table_name=table_name, record_id=record_id, operator=operator,
    )
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0

    today_q = base.where(func.date(AuditLog.operated_at) == func.current_date())
    today_total = (await db.execute(select(func.count()).select_from(today_q.subquery()))).scalar() or 0

    group_q = _append_filters(
        select(AuditLog.action, func.count()),
        keyword=keyword, action=action, table_name=table_name,
        record_id=record_id, operator=operator,
    ).group_by(AuditLog.action)
    rows = (await db.execute(group_q)).all()
    action_counts = {row[0]: row[1] for row in rows}

    return ResponseModel(data={
        "total": total,
        "today": today_total,
        "action_counts": action_counts,
    })
