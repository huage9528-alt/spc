"""审批中心 - 统一待我审批 / 审批配置 API。

待审批列表由 approval_registry 注册的各业务流程 provider 聚合而成（新流程只需注册）；
审批链配置只允许操作「已注册」的 biz_type，避免与其它模块的配置页产生双写路径。
"""

import json
import logging
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Body, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.core.security import PermissionChecker
from app.schemas.common import ResponseModel
from app.services.common import approval_providers  # noqa: F401 — 导入即触发各业务流程注册
from app.services.common.approval_chain import validate_nodes
from app.services.common.approval_metrics import (
    approved_stats,
    enrich_pending_item,
    parse_dt,
    pending_stats,
    submitted_stats,
)
from app.services.common.approval_registry import (
    ApprovalActionRequest,
    get_pending_providers,
    get_provider,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# 我已审批 / 我发起的默认时间窗（未显式传日期时限定，避免全历史扫描）
DEFAULT_MY_WINDOW_DAYS = 90
MAX_BATCH_SIZE = 50


def _match_keyword(item: dict, keyword: str) -> bool:
    kw = (keyword or "").strip().lower()
    if not kw:
        return True
    haystack = " ".join(str(item.get(k) or "") for k in ("no", "title", "summary", "applicant", "current_node"))
    return kw in haystack.lower()


def _in_date_range(value, date_from: Optional[date], date_to: Optional[date]) -> bool:
    dt = parse_dt(value)
    if not dt:
        return not (date_from or date_to)
    if date_from and dt.date() < date_from:
        return False
    if date_to and dt.date() > date_to:
        return False
    return True


def _resolve_window(date_from: Optional[date], date_to: Optional[date]) -> tuple[Optional[date], Optional[date]]:
    if date_from or date_to:
        return date_from, date_to
    return date.today() - timedelta(days=DEFAULT_MY_WINDOW_DAYS), None


def _paginate(items: list[dict], page: int, page_size: int) -> list[dict]:
    start = (page - 1) * page_size
    return items[start:start + page_size]


def _sort_key(value):
    """统一排序键：provider 可能返回 datetime 或 ISO 字符串，混用直接比较会 TypeError。"""
    return parse_dt(value) or datetime.min


def _clean_comment(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _is_today(value) -> bool:
    dt = parse_dt(value)
    return bool(dt and dt.date() == date.today())


def _clean_bool(value, *, default: bool) -> bool:
    """请求体布尔值容错：字符串 "false" / "0" 不能被 bool() 当成 True。"""
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() not in ("", "false", "0", "no", "off")
    return bool(value)


def _clean_version(value) -> Optional[int]:
    """expected_version 来自请求体，非法值应判为参数错误而不是让引擎 int() 抛 500。"""
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return -1  # 哨兵：不可能与任何真实 version 相等，交由引擎返回乐观锁冲突


@router.get("/pending", response_model=ResponseModel)
async def list_pending_approvals(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    biz_type: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    overdue_only: bool = Query(False),
    wait_level: Optional[str] = Query(None, pattern="^(soon|overdue)$"),
    today_only: bool = Query(False),
    current_user: dict = Depends(get_current_user),
    _: dict = Depends(PermissionChecker("approval.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    """聚合全部已注册流程的待我审批条目（各 biz 内部已按审批节点权限过滤），支持筛选与分页。

    stats 始终是「全部待办」口径（与业务类型筛选无关），供统计卡与 chips 计数使用；
    biz_type 只影响 items/total。
    """
    items: list[dict] = []
    for provider in get_pending_providers():
        for it in await provider.fetch(db, current_user["username"], current_user["role"]):
            items.append(enrich_pending_item(it))
    items.sort(key=lambda x: _sort_key(x.get("submitted_at")), reverse=True)

    stats = pending_stats(items)
    filtered = [
        it for it in items
        if (not biz_type or it.get("biz_type") == biz_type)
        and _match_keyword(it, keyword)
        and _in_date_range(it.get("submitted_at"), date_from, date_to)
        and (not overdue_only or it.get("wait_level") == "overdue")
        and (not wait_level or it.get("wait_level") == wait_level)
        and (not today_only or _is_today(it.get("submitted_at")))
    ]
    return ResponseModel(data={
        "items": _paginate(filtered, page, page_size),
        "total": len(filtered),
        "page": page,
        "page_size": page_size,
        "stats": stats,
    })


@router.get("/approved", response_model=ResponseModel)
async def list_my_approved(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    biz_type: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    action: Optional[str] = Query(None, pattern="^(approve|reject)$"),
    current_user: dict = Depends(get_current_user),
    _: dict = Depends(PermissionChecker("approval.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    """我已审批：跨业务聚合本人做出的通过/驳回记录（默认近 90 天）。"""
    win_from, win_to = _resolve_window(date_from, date_to)
    items: list[dict] = []
    for provider in get_pending_providers():
        if biz_type and provider.biz_type != biz_type:
            continue
        if not provider.fetch_approved:
            continue
        items.extend(await provider.fetch_approved(db, current_user["username"]))
    items = [
        it for it in items
        if _match_keyword(it, keyword)
        and _in_date_range(it.get("acted_at"), win_from, win_to)
        and (not action or it.get("my_action") == action)
    ]
    items.sort(key=lambda x: _sort_key(x.get("acted_at")), reverse=True)
    return ResponseModel(data={
        "items": _paginate(items, page, page_size),
        "total": len(items),
        "page": page,
        "page_size": page_size,
        "stats": approved_stats(items),
    })


@router.get("/submitted", response_model=ResponseModel)
async def list_my_submitted(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    biz_type: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    status: Optional[str] = Query(None, pattern="^(pending|approved|rejected|recalled)$"),
    current_user: dict = Depends(get_current_user),
    _: dict = Depends(PermissionChecker("approval.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    """我发起的：跨业务聚合本人提交的单据及整体状态（默认近 90 天）。"""
    win_from, win_to = _resolve_window(date_from, date_to)
    items: list[dict] = []
    for provider in get_pending_providers():
        if biz_type and provider.biz_type != biz_type:
            continue
        if not provider.fetch_submitted:
            continue
        items.extend(await provider.fetch_submitted(db, current_user["username"]))
    items = [
        it for it in items
        if _match_keyword(it, keyword)
        and _in_date_range(it.get("submitted_at"), win_from, win_to)
        and (not status or it.get("status") == status)
    ]
    items.sort(key=lambda x: _sort_key(x.get("submitted_at")), reverse=True)
    return ResponseModel(data={
        "items": _paginate(items, page, page_size),
        "total": len(items),
        "page": page,
        "page_size": page_size,
        "stats": submitted_stats(items),
    })


@router.get("/configs", response_model=ResponseModel)
async def list_approval_configs(
    _: dict = Depends(PermissionChecker("approval.config", "read")),
    db: AsyncSession = Depends(get_db),
):
    """审批链列表：已注册的业务流程 ∪（其）approval_config 配置行。"""
    rows = await db.execute(text(
        "SELECT biz_type, biz_name, nodes, is_active, updated_by, updated_at FROM approval_config"
    ))
    existing: dict[str, dict] = {}
    for r in rows:
        d = dict(r._mapping)
        if isinstance(d.get("nodes"), str):
            d["nodes"] = json.loads(d.get("nodes") or "[]")
        if isinstance(d.get("updated_at"), datetime):
            d["updated_at"] = d["updated_at"].isoformat()
        existing[d["biz_type"]] = d

    items = []
    for provider in get_pending_providers():
        row = existing.pop(provider.biz_type, {
            "biz_type": provider.biz_type, "biz_name": provider.biz_name,
            "nodes": [], "is_active": True, "updated_by": None, "updated_at": None,
        })
        row["condition_field_options"] = provider.condition_field_options or []
        try:
            # 系统视角（admin 旁路）统计该业务在途待办数，供「在途 N 单沿用旧快照」提示
            row["pending_count"] = len(await provider.fetch(db, "", "admin"))
        except Exception:
            logger.warning("统计在途待办失败 biz=%s", provider.biz_type)
            row["pending_count"] = None
        items.append(row)
    return ResponseModel(data={"items": items})


@router.get("/configs/{biz_type}", response_model=ResponseModel)
async def get_approval_config(
    biz_type: str,
    _: dict = Depends(PermissionChecker("approval.config", "read")),
    db: AsyncSession = Depends(get_db),
):
    provider = get_provider(biz_type)
    if not provider:
        return ResponseModel(code=1, message="该业务流程未接入审批中心")
    row = await db.execute(text(
        "SELECT biz_type, biz_name, nodes, is_active, updated_by, updated_at FROM approval_config WHERE biz_type = :bt LIMIT 1"
    ), {"bt": biz_type})
    r = row.fetchone()
    if not r:
        return ResponseModel(data={"biz_type": biz_type, "nodes": [], "is_active": True,
                                   "condition_field_options": provider.condition_field_options or []})
    d = dict(r._mapping)
    if isinstance(d.get("nodes"), str):
        d["nodes"] = json.loads(d.get("nodes") or "[]")
    if isinstance(d.get("updated_at"), datetime):
        d["updated_at"] = d["updated_at"].isoformat()
    d["condition_field_options"] = provider.condition_field_options or []
    return ResponseModel(data=d)


@router.put("/configs/{biz_type}", response_model=ResponseModel)
async def save_approval_config(
    biz_type: str,
    data: dict = Body(...),
    current_user: dict = Depends(get_current_user),
    _: dict = Depends(PermissionChecker("approval.config", "update")),
    db: AsyncSession = Depends(get_db),
):
    provider = get_provider(biz_type)
    if not provider:
        return ResponseModel(code=1, message="该业务流程未接入审批中心")
    nodes = data.get("nodes", [])
    allowed = [o.get("value") for o in (provider.condition_field_options or []) if o.get("value")]
    err = validate_nodes(nodes, allowed_condition_fields=allowed)
    if err:
        return ResponseModel(code=1, message=err)
    biz_name = data.get("biz_name") or provider.biz_name
    is_active = _clean_bool(data.get("is_active"), default=True)
    row = await db.execute(text("SELECT id FROM approval_config WHERE biz_type = :bt LIMIT 1"), {"bt": biz_type})
    if row.fetchone():
        await db.execute(text("""
            UPDATE approval_config SET biz_name = :bn, nodes = :nodes, is_active = :ia,
                                       updated_by = :ub, updated_at = NOW()
            WHERE biz_type = :bt
        """), {"bn": biz_name, "nodes": json.dumps(nodes), "ia": is_active,
               "ub": current_user["username"], "bt": biz_type})
    else:
        await db.execute(text("""
            INSERT INTO approval_config (biz_type, biz_name, nodes, is_active, updated_by)
            VALUES (:bt, :bn, :nodes, :ia, :ub)
        """), {"bt": biz_type, "bn": biz_name, "nodes": json.dumps(nodes),
               "ia": is_active, "ub": current_user["username"]})
    return ResponseModel(data={"biz_type": biz_type, "nodes": nodes, "is_active": is_active}, message="保存成功")


@router.get("/users", response_model=ResponseModel)
async def list_user_options(
    keyword: Optional[str] = Query(None),
    _: dict = Depends(PermissionChecker("approval.config", "read")),
    db: AsyncSession = Depends(get_db),
):
    """审批链编辑器「指定人员」下拉数据源（审批域自有权限，不依赖用户管理读权限）。"""
    conditions = ["u.is_active = TRUE"]
    params: dict = {"lim": 50}
    if keyword:
        conditions.append("(u.username ILIKE :kw OR COALESCE(u.display_name, u.username) ILIKE :kw)")
        params["kw"] = f"%{keyword}%"
    rows = await db.execute(text(f"""
        SELECT u.id, u.username, COALESCE(u.display_name, u.username) AS display_name, r.role_name
        FROM sys_user u
        LEFT JOIN sys_role r ON r.id = u.role_id
        WHERE {' AND '.join(conditions)}
        ORDER BY u.id
        LIMIT :lim
    """), params)
    return ResponseModel(data={"items": [dict(r._mapping) for r in rows]})


@router.get("/roles", response_model=ResponseModel)
async def list_role_options(
    _: dict = Depends(PermissionChecker("approval.config", "read")),
    db: AsyncSession = Depends(get_db),
):
    """审批链编辑器角色下拉数据源（审批域自有权限，不依赖「角色管理」读权限）。"""
    rows = await db.execute(text("SELECT role_code, role_name FROM sys_role ORDER BY id"))
    return ResponseModel(data={"items": [{"role_code": r[0], "role_name": r[1]} for r in rows]})


async def _run_action(biz_type: str, item_id: int, action: str, data: dict, user: dict, db: AsyncSession) -> ResponseModel:
    provider = get_provider(biz_type)
    handler = getattr(provider, action, None) if provider else None
    if not handler:
        return ResponseModel(code=1, message="该业务不支持在审批中心内审批，请前往业务系统处理")
    payload = data if isinstance(data, dict) else {}
    result = await handler(db, ApprovalActionRequest(
        entity_id=item_id,
        approver=user["username"],
        approver_role=user["role"],
        comment=_clean_comment(payload.get("comment")),
        expected_version=_clean_version(payload.get("expected_version")),
    ))
    if not result.get("success"):
        return ResponseModel(code=1, message=result.get("message") or "操作失败")
    return ResponseModel(data=result, message="已通过" if action == "approve" else "已驳回")


@router.get("/items/{biz_type}/{item_id}", response_model=ResponseModel)
async def get_item_preview(
    biz_type: str,
    item_id: int,
    current_user: dict = Depends(get_current_user),
    _: dict = Depends(PermissionChecker("approval.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    """审批抽屉详情：关键字段 + 审批进度 + 审批记录 + 是否可操作。"""
    provider = get_provider(biz_type)
    if not provider or not provider.preview:
        return ResponseModel(code=1, message="该业务流程未接入审批中心")
    data = await provider.preview(db, current_user["username"], current_user["role"], item_id)
    if not data:
        return ResponseModel(code=1, message="单据不存在")
    return ResponseModel(data=data)


@router.post("/items/{biz_type}/{item_id}/approve", response_model=ResponseModel)
async def approve_item(
    biz_type: str,
    item_id: int,
    data: dict = Body(default={}),
    current_user: dict = Depends(get_current_user),
    _: dict = Depends(PermissionChecker("approval.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    return await _run_action(biz_type, item_id, "approve", data, current_user, db)


@router.post("/items/{biz_type}/{item_id}/reject", response_model=ResponseModel)
async def reject_item(
    biz_type: str,
    item_id: int,
    data: dict = Body(default={}),
    current_user: dict = Depends(get_current_user),
    _: dict = Depends(PermissionChecker("approval.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    return await _run_action(biz_type, item_id, "reject", data, current_user, db)


@router.post("/batch-approve", response_model=ResponseModel)
async def batch_approve(
    data: dict = Body(...),
    current_user: dict = Depends(get_current_user),
    _: dict = Depends(PermissionChecker("approval.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    """批量通过：逐条 SAVEPOINT 隔离，失败/不支持的业务逐条报告，不影响其它单据。"""
    requested = data.get("items") or [] if isinstance(data, dict) else []
    if not requested:
        return ResponseModel(code=1, message="请先选择待审批单据")
    if len(requested) > MAX_BATCH_SIZE:
        return ResponseModel(code=1, message=f"单次批量审批最多 {MAX_BATCH_SIZE} 条")
    comment = _clean_comment(data.get("comment"))
    passed: list[dict] = []
    failed: list[dict] = []
    skipped: list[dict] = []
    for it in requested:
        if not isinstance(it, dict):
            failed.append({"biz_type": None, "id": None, "reason": "请求条目格式不正确"})
            continue
        biz_type, item_id = it.get("biz_type"), it.get("id")
        provider = get_provider(biz_type) if biz_type else None
        if not provider or not provider.approve:
            skipped.append({"biz_type": biz_type, "id": item_id, "reason": "该业务不支持在审批中心内审批"})
            continue
        try:
            entity_id = int(item_id)
        except (TypeError, ValueError):
            failed.append({"biz_type": biz_type, "id": item_id, "reason": "单据 ID 不正确"})
            continue
        savepoint = await db.begin_nested()
        try:
            result = await provider.approve(db, ApprovalActionRequest(
                entity_id=entity_id,
                approver=current_user["username"],
                approver_role=current_user["role"],
                comment=comment,
                expected_version=_clean_version(it.get("expected_version")),
            ))
        except Exception as exc:  # 单条异常不拖垮整批（SAVEPOINT 回滚后外层事务仍可用）
            logger.warning("批量审批异常 biz=%s id=%s: %s", biz_type, item_id, exc)
            await savepoint.rollback()
            failed.append({"biz_type": biz_type, "id": item_id, "reason": "系统异常，请稍后重试"})
            continue
        if result.get("success"):
            await savepoint.commit()
            passed.append({"biz_type": biz_type, "id": item_id, "finished": bool(result.get("finished"))})
        else:
            # 失败路径必须回滚：引擎在乐观锁失败前可能已写入审批日志，否则会留下「未生效的审批记录」
            await savepoint.rollback()
            failed.append({"biz_type": biz_type, "id": item_id, "reason": result.get("message") or "操作失败"})
    return ResponseModel(data={"passed": passed, "failed": failed, "skipped": skipped})
