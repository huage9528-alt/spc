"""问题反馈 API

- 任意登录用户可提交反馈
- 普通用户仅能查看/编辑自己的反馈
- admin 可查看全部、回复、删除
"""
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.core.security import PermissionChecker
from app.models.basicdata.announcement import Notification
from app.models.basicdata.feedback import Feedback
from app.schemas.common import ResponseModel
from app.schemas.basicdata.feedback import (
    FeedbackCreate,
    FeedbackListOut,
    FeedbackOut,
    FeedbackReply,
    FeedbackStatusUpdate,
    FeedbackUpdate,
)
from app.services.common.file_service import FileService
from app.services.notification.notification_broker import publish_unread_update

logger = logging.getLogger(__name__)

_FEEDBACK_TYPE_LABELS = {"issue": "问题", "suggestion": "建议", "inquiry": "咨询"}
_SEVERITY_LABELS = {"high": "高", "medium": "中", "low": "低"}
_STATUS_LABELS = {"pending": "待处理", "processing": "处理中", "resolved": "已解决", "closed": "已关闭"}

router = APIRouter()


def _is_admin(user: dict) -> bool:
    return (user or {}).get("role") == "admin"


def _has_perm(user: dict, action: str) -> bool:
    """是否有 basicdata.feedback 资源的指定动作权限（admin 自动通过）"""
    if not user:
        return False
    if _is_admin(user):
        return True
    perms = user.get("permissions") or {}
    if not isinstance(perms, dict):
        return False

    resources = ("basicdata.feedback", "masterdata.feedback")
    for resource in resources:
        actions = perms.get(resource) or []
        if isinstance(actions, list) and action in actions:
            return True

    for resource in resources:
        parent = resource.split(".", 1)[0]
        actions = perms.get(parent) or []
        if isinstance(actions, list) and action in actions:
            return True
    return False


def _can_handle(user: dict) -> bool:
    """是否有「处理问题反馈」权限（admin 自动通过）。

    优先判新权限 basicdata.feedback.handle 的 handle 动作；
    兼容旧权限：basicdata.feedback 的 update 动作（避免自定义角色误伤）。
    """
    if not user:
        return False
    if _is_admin(user):
        return True
    perms = user.get("permissions") or {}
    if not isinstance(perms, dict):
        return False
    for resource in ("basicdata.feedback.handle", "masterdata.feedback.handle"):
        actions = perms.get(resource) or []
        if isinstance(actions, list) and "handle" in actions:
            return True
    return _has_perm(user, "update")


def _get_user_id(user: dict) -> int:
    return int(user.get("user_id") or user["sub"])


def _to_dicts(attachments) -> list[dict]:
    if not attachments:
        return []
    out = []
    for a in attachments:
        if isinstance(a, dict):
            out.append(a)
        elif hasattr(a, "model_dump"):
            out.append(a.model_dump())
    return out


async def _insert_handler_notifications(db: AsyncSession, fb: Feedback) -> list[int]:
    """向所有「有反馈处理权限」的活跃用户插入 feedback_alert 通知行，返回被通知的 user_id 列表。

    处理人按权限判定（镜像 _has_perm 'update'），不硬编码角色名：
    - admin 自动通过；
    - 其余角色在 sys_role.permissions JSONB 合并 ROLE_PERMISSION_ADDITIONS 后，
      含 basicdata.feedback / masterdata.feedback / 父级 basicdata 的 update 动作即视为处理人。
    这样在 RoleManagement 调整权限矩阵后，通知接收人自动跟随。
    严重度 high → priority important（触发加载时 toast），其余 normal。排除提交人本人。
    """
    from app.core.permissions import merge_role_permission_additions
    rows = await db.execute(text("""
        SELECT u.id, r.role_code, r.permissions
        FROM sys_user u
        JOIN sys_role r ON u.role_id = r.id
        WHERE u.is_active = TRUE
    """))
    handler_ids: list[int] = []
    for uid, role_code, raw_perms in rows:
        if uid is None:
            continue
        perms = merge_role_permission_additions(
            role_code, raw_perms if isinstance(raw_perms, dict) else {}
        )
        if _can_handle({"role": role_code, "permissions": perms}):
            handler_ids.append(int(uid))
    if fb.submitter_id and fb.submitter_id in handler_ids:
        handler_ids = [u for u in handler_ids if u != fb.submitter_id]
    if not handler_ids:
        return []

    priority = "important" if fb.severity == "high" else "normal"
    title = f"[问题反馈]{fb.title}"
    content = fb.description or ""

    for hid in handler_ids:
        db.add(Notification(
            user_id=hid,
            type="feedback",
            title=title,
            content=content,
            ref_type="feedback",
            ref_id=fb.id,
            priority=priority,
            is_read=False,
        ))
    await db.flush()
    return handler_ids


async def _insert_submitter_progress_notification(
    db: AsyncSession, fb: Feedback, actor_user: dict, action_desc: str
) -> Optional[int]:
    """处理进度变化时通知提交人;提交人=操作人本人时跳过。返回提交人 user_id 或 None。"""
    if not fb.submitter_id:
        return None
    if int(fb.submitter_id) == _get_user_id(actor_user):
        return None
    priority = "important" if fb.severity == "high" else "normal"
    db.add(Notification(
        user_id=fb.submitter_id,
        type="feedback",
        title=f"[问题反馈]您的反馈「{fb.title}」处理进度有更新",
        content=action_desc,
        ref_type="feedback",
        ref_id=fb.id,
        priority=priority,
        is_read=False,
    ))
    await db.flush()
    return fb.submitter_id


# ---------- 列表 ----------
@router.get("", response_model=ResponseModel[dict])
async def list_feedback(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    type: Optional[str] = None,
    severity: Optional[str] = None,
    status: Optional[str] = None,
    keyword: Optional[str] = None,
    sort_by: Optional[str] = Query(None, description="排序字段"),
    sort_order: Optional[str] = Query(None, description="排序方向 asc/desc"),
    submitter_name: Optional[str] = Query(None, description="提交人筛选，逗号分隔"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    SORTABLE = {
        'title': Feedback.title,
        'type': Feedback.type,
        'severity': Feedback.severity,
        'status': Feedback.status,
        'page_path': Feedback.page_path,
        'submitter_name': Feedback.submitter_name,
        'created_at': Feedback.created_at,
        'replied_by': Feedback.replied_by,
    }

    conds = []
    if not _can_handle(current_user):
        conds.append(Feedback.submitter_id == current_user.get("user_id"))
    if type:
        types = [t.strip() for t in type.split(",") if t.strip()]
        if types:
            conds.append(Feedback.type.in_(types))
    if severity:
        severities = [s.strip() for s in severity.split(",") if s.strip()]
        if severities:
            conds.append(Feedback.severity.in_(severities))
    if status:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        if statuses:
            conds.append(Feedback.status.in_(statuses))
    if keyword:
        like = f"%{keyword}%"
        conds.append(or_(
            Feedback.title.ilike(like),
            Feedback.page_path.ilike(like),
            Feedback.submitter_name.ilike(like),
            Feedback.replied_by.ilike(like),
        ))
    if submitter_name:
        submitters = [s.strip() for s in submitter_name.split(",") if s.strip()]
        if submitters:
            conds.append(Feedback.submitter_name.in_(submitters))

    base = select(Feedback).where(and_(*conds)) if conds else select(Feedback)
    total = (await db.execute(
        select(func.count()).select_from(base.subquery())
    )).scalar() or 0

    # 排序
    order_clauses = []
    if sort_by and sort_by in SORTABLE:
        col = SORTABLE[sort_by]
        if sort_order == 'desc':
            order_clauses.append(col.desc().nullslast())
        else:
            order_clauses.append(col.asc().nullslast())
    if not order_clauses:
        order_clauses = [Feedback.created_at.desc()]

    rows = (await db.execute(
        base.order_by(*order_clauses)
        .offset((page - 1) * page_size).limit(page_size)
    )).scalars().all()

    # 统计卡
    stat_q = select(Feedback.status, func.count()).group_by(Feedback.status)
    if not _can_handle(current_user):
        stat_q = stat_q.where(Feedback.submitter_id == current_user.get("user_id"))
    stat_rows = (await db.execute(stat_q)).all()
    by_status = {s: int(c) for s, c in stat_rows}
    stats = {
        "total": int(total),
        "pending": by_status.get("pending", 0),
        "processing": by_status.get("processing", 0),
        "resolved": by_status.get("resolved", 0),
        "closed": by_status.get("closed", 0),
    }

    return ResponseModel(data={
        "items": [FeedbackOut.model_validate(r).model_dump() for r in rows],
        "total": int(total),
        "page": page,
        "page_size": page_size,
        "stats": stats,
    })


# ---------- 详情 ----------
@router.get("/{feedback_id}", response_model=ResponseModel[FeedbackOut])
async def get_feedback(
    feedback_id: int,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    fb = (await db.execute(
        select(Feedback).where(Feedback.id == feedback_id)
    )).scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")
    if not _can_handle(current_user) and fb.submitter_id != current_user.get("user_id"):
        raise HTTPException(status_code=403, detail="无权查看")
    return ResponseModel(data=FeedbackOut.model_validate(fb))


# ---------- 创建 ----------
@router.post("", response_model=ResponseModel[FeedbackOut])
async def create_feedback(
    body: FeedbackCreate,
    current_user: dict = Depends(PermissionChecker("topbar.feedback", "read")),
    db: AsyncSession = Depends(get_db),
):
    attachments = _to_dicts(body.attachments)
    fb = Feedback(
        type=body.type or "issue",
        severity=body.severity or "low",
        page_path=body.page_path,
        title=body.title,
        description=body.description,
        attachments=attachments or None,
        status="pending",
        submitter_id=_get_user_id(current_user),
        submitter_name=current_user.get("username") or "",
    )
    db.add(fb)
    await db.flush()

    # 关联文件资产
    if attachments:
        svc = FileService(db)
        await svc.attach([a.get("key") for a in attachments], "feedback", str(fb.id))

    # 通知处理人（插 notification 行；失败只记日志，不影响反馈提交）
    handler_ids: list[int] = []
    try:
        handler_ids = await _insert_handler_notifications(db, fb)
    except Exception as e:
        logger.warning(f"[feedback] 插入处理人通知失败 feedback_id={fb.id}: {e}")

    await db.commit()
    await db.refresh(fb)

    # commit 后 SSE 推送未读计数（计数反映已提交数据；Redis 失败静默丢弃）
    if handler_ids:
        try:
            for hid in handler_ids:
                await publish_unread_update(db, hid)
        except Exception as e:
            logger.warning(f"[feedback] SSE 推送失败 feedback_id={fb.id}: {e}")

    return ResponseModel(data=FeedbackOut.model_validate(fb))


# ---------- 提交人更新（仅 pending） ----------
@router.put("/{feedback_id}", response_model=ResponseModel[FeedbackOut])
async def update_feedback(
    feedback_id: int,
    body: FeedbackUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    fb = (await db.execute(
        select(Feedback).where(Feedback.id == feedback_id)
    )).scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")

    can_handle = _can_handle(current_user)
    if not can_handle:
        if fb.submitter_id != current_user.get("user_id"):
            raise HTTPException(status_code=403, detail="无权编辑")
        if fb.status != "pending":
            raise HTTPException(status_code=400, detail="已处理的反馈不能修改")

    old_keys = {a.get("key") for a in (fb.attachments or []) if isinstance(a, dict) and a.get("key")}

    if body.type is not None:
        fb.type = body.type
    if body.severity is not None:
        fb.severity = body.severity
    if body.page_path is not None:
        fb.page_path = body.page_path
    if body.title is not None:
        fb.title = body.title
    if body.description is not None:
        fb.description = body.description
    if body.attachments is not None:
        new_attachments = _to_dicts(body.attachments)
        new_keys = {a.get("key") for a in new_attachments if a.get("key")}
        fb.attachments = new_attachments or None
        svc = FileService(db)
        to_attach = list(new_keys - old_keys)
        to_detach = list(old_keys - new_keys)
        if to_attach:
            await svc.attach(to_attach, "feedback", str(fb.id))
        if to_detach:
            await svc.detach(to_detach)

    await db.commit()
    await db.refresh(fb)
    return ResponseModel(data=FeedbackOut.model_validate(fb))


# ---------- 管理员回复 ----------
@router.post("/{feedback_id}/reply", response_model=ResponseModel[FeedbackOut])
async def reply_feedback(
    feedback_id: int,
    body: FeedbackReply,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not _can_handle(current_user):
        raise HTTPException(status_code=403, detail="无权处理反馈")

    fb = (await db.execute(
        select(Feedback).where(Feedback.id == feedback_id)
    )).scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")

    if not body.reply and not body.status:
        raise HTTPException(status_code=400, detail="回复内容和状态至少填一项")

    if body.reply:
        fb.reply = body.reply
        fb.replied_by = current_user.get("username")
        fb.replied_at = datetime.now()
    if body.status:
        fb.status = body.status
    elif body.reply and fb.status == "pending":
        fb.status = "resolved"

    # 通知提交人处理进度(失败只记日志,不影响回复)
    notified_uid: Optional[int] = None
    try:
        parts = []
        if body.reply:
            parts.append(f"处理人 {current_user.get('username')} 回复:{body.reply}")
        if body.status:
            parts.append(f"状态更新为「{_STATUS_LABELS.get(body.status, body.status)}」")
        if not parts:
            parts.append("处理进度有更新")
        notified_uid = await _insert_submitter_progress_notification(
            db, fb, current_user, ";".join(parts)
        )
    except Exception as e:
        logger.warning(f"[feedback] 插入提交人进度通知失败 feedback_id={fb.id}: {e}")

    await db.commit()
    await db.refresh(fb)
    if notified_uid:
        try:
            await publish_unread_update(db, notified_uid)
        except Exception as e:
            logger.warning(f"[feedback] SSE 推送失败 feedback_id={fb.id}: {e}")
    return ResponseModel(data=FeedbackOut.model_validate(fb))


# ---------- 状态变更（admin 任意 / 提交人有限） ----------
@router.patch("/{feedback_id}/status", response_model=ResponseModel[FeedbackOut])
async def update_status(
    feedback_id: int,
    body: FeedbackStatusUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    allowed = {"pending", "processing", "resolved", "closed"}
    if body.status not in allowed:
        raise HTTPException(status_code=400, detail="非法状态")

    fb = (await db.execute(
        select(Feedback).where(Feedback.id == feedback_id)
    )).scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")

    if _can_handle(current_user):
        fb.status = body.status
    else:
        # 提交人：仅可在 resolved 后 close，或 closed 后重开为 pending
        if fb.submitter_id != current_user.get("user_id"):
            raise HTTPException(status_code=403, detail="无权变更")
        if body.status == "closed" and fb.status != "resolved":
            raise HTTPException(status_code=400, detail="只有已解决的反馈才能关闭")
        if body.status == "pending" and fb.status != "closed":
            raise HTTPException(status_code=400, detail="只有已关闭的反馈才能重开")
        if body.status not in ("closed", "pending"):
            raise HTTPException(status_code=403, detail="无权变更为该状态")
        fb.status = body.status

    # 通知提交人处理进度(仅处理人操作时;提交人自己 close/重开不通知)
    notified_uid: Optional[int] = None
    if _can_handle(current_user):
        try:
            notified_uid = await _insert_submitter_progress_notification(
                db, fb, current_user,
                f"处理人 {current_user.get('username')} 将状态更新为「{_STATUS_LABELS.get(body.status, body.status)}」",
            )
        except Exception as e:
            logger.warning(f"[feedback] 插入提交人进度通知失败 feedback_id={fb.id}: {e}")

    await db.commit()
    await db.refresh(fb)
    if notified_uid:
        try:
            await publish_unread_update(db, notified_uid)
        except Exception as e:
            logger.warning(f"[feedback] SSE 推送失败 feedback_id={fb.id}: {e}")
    return ResponseModel(data=FeedbackOut.model_validate(fb))


# ---------- 删除（管理员） ----------
@router.delete("/{feedback_id}", response_model=ResponseModel[dict])
async def delete_feedback(
    feedback_id: int,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not _has_perm(current_user, "delete"):
        raise HTTPException(status_code=403, detail="无权删除反馈")

    fb = (await db.execute(
        select(Feedback).where(Feedback.id == feedback_id)
    )).scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")

    # 解引用附件
    keys = [a.get("key") for a in (fb.attachments or []) if isinstance(a, dict) and a.get("key")]
    if keys:
        svc = FileService(db)
        await svc.detach(keys)

    await db.delete(fb)
    await db.commit()
    return ResponseModel(data={"deleted": feedback_id})
