"""通用通知 API — 当前用户的消息中心"""

from typing import Optional

import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select, func, update, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import AsyncSessionLocal, get_db
from app.core.dependencies import get_current_user
from app.core.security import PermissionChecker
from app.models.basicdata.announcement import Notification
from app.schemas.common import ResponseModel
from pydantic import BaseModel
from app.services.notification.notification_broker import subscribe_stream, compute_unread_counts, publish_unread_update

router = APIRouter()


class CreateNotificationRequest(BaseModel):
    title: str
    content: str
    type: str = "system"
    priority: str = "normal"


def _get_user_id(current_user: dict) -> int:
    return int(current_user.get("user_id") or current_user.get("sub"))


# 展示用类型标签（与前端分类导航一致）
TYPE_LABELS = {
    "announcement": "公告",
    "feedback": "问题反馈",
    "feedback_alert": "反馈提醒",
    "system": "系统",
    "price_change": "调价单",
    "supplier_claim": "索赔单",
    "stock_check_audit": "盘点抽检",
    "stock_check_appeal": "复议待裁决",
    "material_alert": "物料提醒",
    "exception_alert": "异常提醒",
    "approval_timeout": "审批超时",
}


def _display_title(notif_type: str, title: str) -> str:
    """标题统一带 [类型] 前缀；已带前缀（历史/创建点自带）不重复加。"""
    if title.startswith("["):
        return title
    return f"[{TYPE_LABELS.get(notif_type, notif_type)}]{title}"


# ---------- 创建通知 ----------
@router.post("", response_model=ResponseModel)
async def create_notification(
    request: CreateNotificationRequest,
    current_user: dict = Depends(PermissionChecker("topbar.notifications", "read")),
    db: AsyncSession = Depends(get_db),
):
    uid = _get_user_id(current_user)
    notification = Notification(
        user_id=uid,
        title=request.title,
        content=request.content,
        type=request.type,
        priority=request.priority,
        sender_id=uid,
        sender_name=current_user.get("username"),
        is_read=False,
    )
    db.add(notification)
    await db.commit()
    await db.refresh(notification)
    # commit 后 SSE 推送未读计数（Redis 失败静默丢弃）
    await publish_unread_update(db, uid)
    return ResponseModel(data={"id": notification.id})


# ---------- 通知列表 ----------
@router.get("", response_model=ResponseModel)
async def list_notifications(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    type: Optional[str] = None,
    exclude_types: Optional[str] = None,
    is_read: Optional[bool] = None,
    current_user: dict = Depends(PermissionChecker("topbar.notifications", "read")),
    db: AsyncSession = Depends(get_db),
):
    uid = _get_user_id(current_user)
    base = [Notification.user_id == uid]
    if type:
        base.append(Notification.type == type)
    if exclude_types:
        exclude_list = [t.strip() for t in exclude_types.split(",") if t.strip()]
        if exclude_list:
            base.append(Notification.type.notin_(exclude_list))
    if is_read is not None:
        base.append(Notification.is_read == is_read)

    total = (await db.execute(select(func.count(Notification.id)).where(and_(*base)))).scalar() or 0

    q = (
        select(Notification)
        .where(and_(*base))
        .order_by(Notification.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(q)).scalars().all()

    return ResponseModel(data={
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [
            {
                "id": r.id,
                "type": r.type,
                "title": _display_title(r.type, r.title),
                "content": r.content,
                "ref_type": r.ref_type,
                "ref_id": r.ref_id,
                "sender_id": r.sender_id,
                "sender_name": r.sender_name,
                "priority": r.priority,
                "is_read": r.is_read,
                "read_at": r.read_at.strftime("%Y-%m-%d %H:%M") if r.read_at else None,
                "created_at": r.created_at.strftime("%Y-%m-%d %H:%M") if r.created_at else None,
            }
            for r in rows
        ],
    })


# ---------- 未读数量（按类型分组） ----------
@router.get("/unread-count", response_model=ResponseModel)
async def unread_count(
    current_user: dict = Depends(PermissionChecker("topbar.notifications", "read")),
    db: AsyncSession = Depends(get_db),
):
    uid = _get_user_id(current_user)
    counts = await compute_unread_counts(db, uid)
    return ResponseModel(data=counts)


# ---------- 标记单条已读 ----------
@router.post("/{notif_id}/read", response_model=ResponseModel)
async def mark_read(
    notif_id: int,
    current_user: dict = Depends(PermissionChecker("topbar.notifications", "read")),
    db: AsyncSession = Depends(get_db),
):
    uid = _get_user_id(current_user)
    result = await db.execute(
        select(Notification).where(and_(Notification.id == notif_id, Notification.user_id == uid))
    )
    notif = result.scalar_one_or_none()
    if not notif:
        raise HTTPException(status_code=404, detail="通知不存在")
    if not notif.is_read:
        notif.is_read = True
        notif.read_at = func.now()
        await db.commit()
    await publish_unread_update(db, uid)
    return ResponseModel(data={"id": notif_id})


# ---------- 全部已读 ----------
@router.post("/read-all", response_model=ResponseModel)
async def mark_all_read(
    type: Optional[str] = None,
    current_user: dict = Depends(PermissionChecker("topbar.notifications", "read")),
    db: AsyncSession = Depends(get_db),
):
    uid = _get_user_id(current_user)
    conditions = [Notification.user_id == uid, Notification.is_read == False]  # noqa: E712
    if type:
        conditions.append(Notification.type == type)
    await db.execute(
        update(Notification)
        .where(and_(*conditions))
        .values(is_read=True, read_at=func.now())
    )
    await db.commit()
    await publish_unread_update(db, uid)
    return ResponseModel(data={"ok": True})


# ---------- SSE 实时流 ----------
@router.get("/stream")
async def stream_notifications(
    request: Request,
    token: str = Query(..., description="JWT token (EventSource 无法设 header)"),
):
    """通知 SSE 实时流。首帧 snapshot(未读计数)，后续 unread 事件，15s 心跳。

    鉴权用短命会话,不挂 Depends(get_db):流可活几小时,不能占住池连接。
    """
    async with AsyncSessionLocal() as db:
        current_user = await get_current_user(token=token, db=db)
    uid = _get_user_id(current_user)

    async def gen():
        try:
            async for chunk in subscribe_stream(uid):
                if await request.is_disconnected():
                    break
                yield chunk
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
