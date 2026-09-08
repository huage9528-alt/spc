"""公告管理 API"""

from typing import Optional
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, and_, case
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.core.audit import log_audit
from app.models.basicdata.announcement import Announcement, Notification
from app.models.basicdata.user import SysUser
from app.schemas.common import ResponseModel

router = APIRouter()

SORTABLE_COLUMNS = {
    'title': Announcement.title,
    'type': Announcement.type,
    'priority': Announcement.priority,
    'is_published': Announcement.is_published,
    'created_by': Announcement.created_by,
    'published_at': Announcement.published_at,
    'created_at': Announcement.created_at,
}


# ---------- Schemas ----------
class AnnouncementCreate(BaseModel):
    title: str
    content: Optional[str] = None
    type: str = "notice"
    priority: str = "normal"


class AnnouncementUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    type: Optional[str] = None
    priority: Optional[str] = None


# ---------- 公告列表 ----------
@router.get("", response_model=ResponseModel)
async def list_announcements(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    type: Optional[str] = None,
    is_published: Optional[bool] = None,
    keyword: Optional[str] = None,
    sort_by: Optional[str] = Query(None, description="排序字段"),
    sort_order: Optional[str] = Query(None, description="排序方向 asc/desc"),
    priority: Optional[str] = Query(None, description="优先级筛选，逗号分隔"),
    created_by: Optional[str] = Query(None, description="创建人筛选，逗号分隔"),
    current_user: dict = Depends(PermissionChecker("announcements", "read")),
    db: AsyncSession = Depends(get_db),
):
    q = select(Announcement)
    count_q = select(func.count(Announcement.id))

    if type:
        types = [t.strip() for t in type.split(",") if t.strip()]
        if types:
            q = q.where(Announcement.type.in_(types))
            count_q = count_q.where(Announcement.type.in_(types))
    if is_published is not None:
        q = q.where(Announcement.is_published == is_published)
        count_q = count_q.where(Announcement.is_published == is_published)
    if keyword:
        like = f"%{keyword}%"
        q = q.where(Announcement.title.ilike(like))
        count_q = count_q.where(Announcement.title.ilike(like))
    if priority:
        priorities = [p.strip() for p in priority.split(",") if p.strip()]
        if priorities:
            q = q.where(Announcement.priority.in_(priorities))
            count_q = count_q.where(Announcement.priority.in_(priorities))
    if created_by:
        creators = [c.strip() for c in created_by.split(",") if c.strip()]
        if creators:
            q = q.where(Announcement.created_by.in_(creators))
            count_q = count_q.where(Announcement.created_by.in_(creators))

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
        order_clauses = [Announcement.created_at.desc()]

    q = q.order_by(*order_clauses).offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(q)).scalars().all()

    # 每行附带：通知人数 / 已读人数（notification 表按公告聚合）
    read_map: dict[int, tuple[int, int]] = {}
    ids = [r.id for r in rows]
    if ids:
        agg_rows = (await db.execute(
            select(
                Notification.ref_id,
                func.count(),
                func.sum(case((Notification.is_read == True, 1), else_=0)),  # noqa: E712
            ).where(
                and_(Notification.ref_type == "announcement", Notification.ref_id.in_(ids))
            ).group_by(Notification.ref_id)
        )).all()
        read_map = {row[0]: (row[1] or 0, row[2] or 0) for row in agg_rows}

    return ResponseModel(data={
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [
            {
                "id": r.id,
                "title": r.title,
                "content": r.content,
                "type": r.type,
                "priority": r.priority,
                "is_published": r.is_published,
                "published_at": r.published_at.strftime("%Y-%m-%d %H:%M") if r.published_at else None,
                "created_by": r.created_by,
                "created_at": r.created_at.strftime("%Y-%m-%d %H:%M") if r.created_at else None,
                "updated_at": r.updated_at.strftime("%Y-%m-%d %H:%M") if r.updated_at else None,
                "notified_count": read_map.get(r.id, (0, 0))[0],
                "read_count": read_map.get(r.id, (0, 0))[1],
            }
            for r in rows
        ],
    })


# ---------- 公告统计 ----------
@router.get("/stats", response_model=ResponseModel[dict])
async def announcement_stats(
    current_user: dict = Depends(PermissionChecker("announcements", "read")),
    db: AsyncSession = Depends(get_db),
):
    """公告统计：发布态 / 类型 / 优先级 / 近 30 天发布与平均已读率"""
    total = (await db.execute(select(func.count(Announcement.id)))).scalar() or 0
    published = (await db.execute(
        select(func.count(Announcement.id)).where(Announcement.is_published == True)  # noqa: E712
    )).scalar() or 0
    draft = total - published

    by_type_rows = (await db.execute(
        select(Announcement.type, func.count()).group_by(Announcement.type)
    )).all()
    by_priority_rows = (await db.execute(
        select(Announcement.priority, func.count()).group_by(Announcement.priority)
    )).all()

    cutoff = datetime.utcnow() - timedelta(days=30)
    recent_published = (await db.execute(
        select(func.count(Announcement.id)).where(
            and_(Announcement.is_published == True, Announcement.published_at >= cutoff)  # noqa: E712
        )
    )).scalar() or 0

    recent_rows = (await db.execute(
        select(Notification.is_read).join(
            Announcement,
            and_(Announcement.id == Notification.ref_id, Notification.ref_type == "announcement"),
        ).where(Announcement.published_at >= cutoff)
    )).all()
    notified = len(recent_rows)
    read_count = sum(1 for (is_read,) in recent_rows if is_read)
    avg_read_rate = round(read_count * 100 / notified, 1) if notified else 0

    return ResponseModel(data={
        "total": total,
        "published": published,
        "draft": draft,
        "by_type": {row[0]: row[1] for row in by_type_rows},
        "by_priority": {row[0]: row[1] for row in by_priority_rows},
        "recent30": {
            "published": recent_published,
            "notified": notified,
            "read": read_count,
            "avg_read_rate": avg_read_rate,
        },
    })


# ---------- 创建公告 ----------
@router.post("", response_model=ResponseModel)
async def create_announcement(
    body: AnnouncementCreate,
    current_user: dict = Depends(PermissionChecker("announcements", "create")),
    db: AsyncSession = Depends(get_db),
):
    ann = Announcement(
        title=body.title,
        content=body.content,
        type=body.type,
        priority=body.priority,
        created_by=current_user.get("username", ""),
    )
    db.add(ann)
    await db.flush()
    await log_audit(db, "announcement", ann.id, "create", operator=current_user.get("username", ""))
    await db.commit()
    await db.refresh(ann)
    return ResponseModel(data={"id": ann.id})


# ---------- 编辑公告 ----------
@router.put("/{ann_id}", response_model=ResponseModel)
async def update_announcement(
    ann_id: int,
    body: AnnouncementUpdate,
    current_user: dict = Depends(PermissionChecker("announcements", "update")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Announcement).where(Announcement.id == ann_id))
    ann = result.scalar_one_or_none()
    if not ann:
        raise HTTPException(status_code=404, detail="公告不存在")

    update_data = body.model_dump(exclude_unset=True)
    for k, v in update_data.items():
        setattr(ann, k, v)

    await log_audit(db, "announcement", ann.id, "update", operator=current_user.get("username", ""),
                    old_obj=ann, update_data=update_data)
    await db.commit()
    return ResponseModel(data={"id": ann.id})


# ---------- 删除公告 ----------
@router.delete("/{ann_id}", response_model=ResponseModel)
async def delete_announcement(
    ann_id: int,
    current_user: dict = Depends(PermissionChecker("announcements", "delete")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Announcement).where(Announcement.id == ann_id))
    ann = result.scalar_one_or_none()
    if not ann:
        raise HTTPException(status_code=404, detail="公告不存在")

    await db.execute(
        Notification.__table__.delete().where(
            and_(Notification.ref_type == "announcement", Notification.ref_id == ann_id)
        )
    )
    await db.delete(ann)
    await log_audit(db, "announcement", ann_id, "delete", operator=current_user.get("username", ""))
    await db.commit()
    return ResponseModel(data={"id": ann_id})


# ---------- 发布公告 ----------
@router.post("/{ann_id}/publish", response_model=ResponseModel)
async def publish_announcement(
    ann_id: int,
    current_user: dict = Depends(PermissionChecker("announcements", "update")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Announcement).where(Announcement.id == ann_id))
    ann = result.scalar_one_or_none()
    if not ann:
        raise HTTPException(status_code=404, detail="公告不存在")
    if ann.is_published:
        raise HTTPException(status_code=400, detail="公告已发布")

    now = datetime.utcnow()
    ann.is_published = True
    ann.published_at = now

    user_rows = (await db.execute(
        select(SysUser.id).where(SysUser.is_active == True)  # noqa: E712
    )).scalars().all()

    for uid in user_rows:
        notif = Notification(
            user_id=uid,
            type="announcement",
            title=ann.title,
            content=(ann.content or "")[:500],
            ref_type="announcement",
            ref_id=ann.id,
            priority=ann.priority,
        )
        db.add(notif)

    await log_audit(db, "announcement", ann.id, "update", field_name="is_published",
                    old_value="false", new_value="true", operator=current_user.get("username", ""))
    await db.commit()
    return ResponseModel(data={"id": ann.id, "notified_users": len(user_rows)})
