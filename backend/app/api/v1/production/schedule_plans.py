"""Production schedule plan API."""

import copy
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Optional, List
import json
import dataclasses
import math
import logging
from time import perf_counter

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import case, func, or_, select, and_, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.database import AsyncSessionLocal, get_db
from app.core.security import PermissionChecker, decode_access_token, oauth2_scheme
from app.core.token_blacklist import TOKEN_BLACKLIST_PREFIX, get_redis_client
from app.models.basicdata.user import SysRole, SysUser
from app.models.production.order_schedule_snapshot import ProductionOrderScheduleSnapshot
from app.models.production.schedule_plan import ProductionSchedulePlan
from app.models.production.schedule_operation_log import ProductionScheduleOperationLog
from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.models.production.product_process_capacity import ProductProcessCapacity, parse_capacity_metadata
from app.models.rules.node_standard import NodeStandard
from app.schemas.common import PageResult, ResponseModel
from app.schemas.production.schemas import (
    ProductionSchedulePlanCreate,
    ProductionSchedulePlanOut,
    ProductionSchedulePlanUpdate,
    OrderForSchedulingOut,
    TodoWorkbenchItemOut,
    TodoSnapshotRefreshRequest,
    TodoSnapshotRefreshResponse,
    AutoScheduleRequest,
    AutoScheduleResponse,
    ProductionSimulationRequest,
    ProductionSimulationResponse,
    BatchAutoScheduleRequest,
    BatchAutoScheduleResponse,
    BatchAutoScheduleItemOut,
    SaleOrderLineChangeLogOut,
    UpphImpactPlanOut,
    ScheduleChangeEventOut,
    ChangeEventStatusUpdateRequest,
    ChangeEventStatusUpdateItemOut,
    ChangeEventStatusUpdateResponse,
    BatchRescheduleRequest,
    BatchRescheduleResponse,
    BatchRescheduleItemOut,
    DeleteSchedulePlanPreviewOut,
    DeleteSchedulePlanConfirmRequest,
    DeleteSchedulePlanResultOut,
    DeleteBackfillExecuteRequest,
    DeleteBackfillExecuteResponse,
    DeleteBackfillExecuteItemOut,
    ProductionScheduleOperationLogOut,
    MissingUpphProductOut,
    MissingUpphListOut,
    EmptyStateOut,
)
from app.services.production.config_service import ProductionScheduleConfigService
from app.services.production.assembly_roll_schedule_service import AssemblyRollScheduleService
from app.services.production.plan_delete_backfill_service import PlanDeleteAndBackfillService
from app.services.production.production_change_service import ProductionChangeService
from app.services.production.schedule_simulation_service import ScheduleSimulationService
from app.services.production.upph_calculation_service import UpphCalculationService

router = APIRouter()
logger = logging.getLogger(__name__)

READ_PERMISSION_CACHE_TTL_SECONDS = 5
_production_schedule_read_permission_cache: dict[str, tuple[datetime, dict]] = {}
WRITE_PERMISSION_CACHE_TTL_SECONDS = 5
_production_schedule_write_permission_cache: dict[str, tuple[datetime, dict]] = {}
TOKEN_BLACKLIST_RESULT_CACHE_TTL_SECONDS = 30
TOKEN_BLACKLIST_UNAVAILABLE_BACKOFF_SECONDS = 60
_token_blacklist_result_cache: dict[str, tuple[datetime, bool]] = {}
_token_blacklist_unavailable_until: Optional[datetime] = None


def _get_cached_production_schedule_read_user(token: str) -> Optional[dict]:
    cached = _production_schedule_read_permission_cache.get(token)
    if not cached:
        return None
    cached_at, payload = cached
    if (datetime.now() - cached_at).total_seconds() > READ_PERMISSION_CACHE_TTL_SECONDS:
        _production_schedule_read_permission_cache.pop(token, None)
        return None
    return dict(payload)


def _set_cached_production_schedule_read_user(token: str, payload: dict) -> None:
    _production_schedule_read_permission_cache[token] = (datetime.now(), dict(payload))


def _get_cached_production_schedule_write_user(token: str) -> Optional[dict]:
    cached = _production_schedule_write_permission_cache.get(token)
    if not cached:
        return None
    cached_at, payload = cached
    if (datetime.now() - cached_at).total_seconds() > WRITE_PERMISSION_CACHE_TTL_SECONDS:
        _production_schedule_write_permission_cache.pop(token, None)
        return None
    return dict(payload)


def _set_cached_production_schedule_write_user(token: str, payload: dict) -> None:
    _production_schedule_write_permission_cache[token] = (datetime.now(), dict(payload))


def _get_cached_token_blacklist_result(jti: str) -> Optional[bool]:
    cached = _token_blacklist_result_cache.get(jti)
    if not cached:
        return None
    cached_at, payload = cached
    if (datetime.now() - cached_at).total_seconds() > TOKEN_BLACKLIST_RESULT_CACHE_TTL_SECONDS:
        _token_blacklist_result_cache.pop(jti, None)
        return None
    return payload


def _set_cached_token_blacklist_result(jti: str, is_blacklisted: bool) -> None:
    _token_blacklist_result_cache[jti] = (datetime.now(), is_blacklisted)


async def _is_token_blacklisted_fast(jti: str) -> tuple[bool, dict[str, object]]:
    global _token_blacklist_unavailable_until

    blacklist_started_at = perf_counter()
    cached = _get_cached_token_blacklist_result(jti)
    if cached is not None:
        return cached, {
            "source": "memory_cache",
            "duration_ms": round((perf_counter() - blacklist_started_at) * 1000, 2),
        }

    if _token_blacklist_unavailable_until and datetime.now() < _token_blacklist_unavailable_until:
        return False, {
            "source": "unavailable_backoff",
            "duration_ms": round((perf_counter() - blacklist_started_at) * 1000, 2),
        }

    client = await get_redis_client()
    if not client:
        _token_blacklist_unavailable_until = datetime.now() + timedelta(seconds=TOKEN_BLACKLIST_UNAVAILABLE_BACKOFF_SECONDS)
        return False, {
            "source": "client_unavailable",
            "duration_ms": round((perf_counter() - blacklist_started_at) * 1000, 2),
        }

    try:
        result = await client.exists(f"{TOKEN_BLACKLIST_PREFIX}{jti}")
        is_blacklisted = result > 0
        _set_cached_token_blacklist_result(jti, is_blacklisted)
        return is_blacklisted, {
            "source": "redis",
            "duration_ms": round((perf_counter() - blacklist_started_at) * 1000, 2),
        }
    except Exception:
        _token_blacklist_unavailable_until = datetime.now() + timedelta(seconds=TOKEN_BLACKLIST_UNAVAILABLE_BACKOFF_SECONDS)
        return False, {
            "source": "redis_error_backoff",
            "duration_ms": round((perf_counter() - blacklist_started_at) * 1000, 2),
        }
    finally:
        try:
            await client.aclose()
        except Exception:
            pass


async def _check_production_schedule_permission_fast(
    token: str,
    db: AsyncSession,
    action: str = "read",
) -> tuple[dict, dict[str, object]]:
    checker = PermissionChecker("production.schedule_plans", action)
    timings: dict[str, object] = {}

    decode_started_at = perf_counter()
    payload = decode_access_token(token)
    timings["decode_access_token"] = round((perf_counter() - decode_started_at) * 1000, 2)

    token_jti = payload.get("jti")
    token_login_version = payload.get("login_version", 0)
    if token_jti:
        is_blacklisted, blacklist_meta = await _is_token_blacklisted_fast(token_jti)
        timings["token_blacklist"] = blacklist_meta
        if is_blacklisted:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="您的账号已在其他设备登录，请重新登录",
                headers={"X-Force-Logout": "true"},
            )

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无效的认证凭据")

    if payload.get("share", False):
        share_started_at = perf_counter()
        result = await checker(token=token, db=db)
        timings["share_permission_checker"] = round((perf_counter() - share_started_at) * 1000, 2)
        return result, timings

    user_query_started_at = perf_counter()
    user_row = (
        await db.execute(
            select(SysUser, SysRole.role_code, SysRole.permissions)
            .outerjoin(SysRole, SysUser.role_id == SysRole.id)
            .where(SysUser.id == int(user_id))
        )
    ).one_or_none()
    timings["user_permission_query"] = round((perf_counter() - user_query_started_at) * 1000, 2)
    user = user_row[0] if user_row else None
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在或已禁用")

    role = user_row[1] or payload.get("role", "")
    permissions = user_row[2]
    payload["role"] = role
    payload["username"] = user.username
    payload["supplier_name"] = user.supplier_name

    db_login_version = user.login_version or 0
    if token_login_version != db_login_version:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="您的账号已在其他设备登录，请重新登录",
            headers={"X-Force-Logout": "true"},
        )

    if role == "admin":
        return payload, timings

    if not permissions:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="用户角色配置异常")
    if not isinstance(permissions, dict):
        permissions = {}
    permission_merge_started_at = perf_counter()
    permissions = checker._role_permission_additions(role, permissions)
    timings["merge_role_permissions"] = round((perf_counter() - permission_merge_started_at) * 1000, 2)

    permission_eval_started_at = perf_counter()
    for resource in checker._resource_candidates():
        allowed_actions = permissions.get(resource, [])
        if checker.action in allowed_actions:
            timings["permission_eval"] = round((perf_counter() - permission_eval_started_at) * 1000, 2)
            return payload, timings
    for resource in checker._resource_candidates():
        if "." not in resource:
            continue
        parent = resource.split(".")[0]
        parent_actions = permissions.get(parent, [])
        if checker.action in parent_actions:
            timings["permission_eval"] = round((perf_counter() - permission_eval_started_at) * 1000, 2)
            return payload, timings

    timings["permission_eval"] = round((perf_counter() - permission_eval_started_at) * 1000, 2)
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=f"缺少 {checker.resource}.{checker.action} 权限",
    )


async def _check_production_schedule_read_permission_fast(
    token: str,
    db: AsyncSession,
) -> tuple[dict, dict[str, object]]:
    return await _check_production_schedule_permission_fast(token, db, "read")


async def _get_production_schedule_read_context(
    token: str = Depends(oauth2_scheme),
):
    dependency_started_at = perf_counter()
    async with AsyncSessionLocal() as db:
        permission_started_at = perf_counter()
        current_user = _get_cached_production_schedule_read_user(token)
        cache_hit = current_user is not None
        permission_breakdown: dict[str, object] = {}
        if current_user is None:
            current_user, permission_breakdown = await _check_production_schedule_read_permission_fast(token, db)
            _set_cached_production_schedule_read_user(token, current_user)
        dependency_timings_ms = {
            "permission_cache_hit": cache_hit,
            "permission_checker": round((perf_counter() - permission_started_at) * 1000, 2),
            "permission_breakdown": permission_breakdown,
            "total": round((perf_counter() - dependency_started_at) * 1000, 2),
        }
        try:
            yield {
                "current_user": current_user,
                "db": db,
                "dependency_timings_ms": dependency_timings_ms,
            }
        except Exception:
            await db.rollback()
            raise


async def _get_production_schedule_write_context(
    token: str = Depends(oauth2_scheme),
):
    dependency_started_at = perf_counter()
    async with AsyncSessionLocal() as db:
        permission_started_at = perf_counter()
        current_user = _get_cached_production_schedule_write_user(token)
        cache_hit = current_user is not None
        permission_breakdown: dict[str, object] = {}
        if current_user is None:
            current_user, permission_breakdown = await _check_production_schedule_permission_fast(token, db, "delete")
            _set_cached_production_schedule_write_user(token, current_user)
        dependency_timings_ms = {
            "permission_cache_hit": cache_hit,
            "permission_checker": round((perf_counter() - permission_started_at) * 1000, 2),
            "permission_breakdown": permission_breakdown,
            "total": round((perf_counter() - dependency_started_at) * 1000, 2),
        }
        try:
            yield {
                "current_user": current_user,
                "db": db,
                "dependency_timings_ms": dependency_timings_ms,
            }
        except Exception:
            await db.rollback()
            raise

SCHEDULE_BUCKET_LABELS = {
    "lean": "精益",
    "assembly": "装配-组装",
    "packaging": "装配-包装",
    "mixed": "组装+包装",
    "pending": "待确认",
}

SCHEDULING_STATUS_LABELS = {
    "ready": "可排产",
    "pending": "待确认",
    "scheduled": "已排产",
}

ORDER_POOL_DISPLAY_STATUS_LABELS = {
    "ready": "可排",
    "pending": "待确认",
    "excluded": "不排",
    "scheduled": "已排",
}

ORDER_POOL_REASON_SHORT_LABELS = {
    "already_scheduled": "已排产",
    "zero_quantity": "数量无效",
    "non_schedulable_workshop": "命中其他车间，不参与自动排产",
    "lean_missing_upph": "已命中精益，但缺有效UPPH",
    "missing_upph": "已命中产能，但缺有效UPPH",
    "assembly_rule_pending": "组装段待确认",
    "packaging_rule_pending": "包装段待确认",
    "mixed_bucket_pending": "组装+包装待确认",
    "bucket_unclassified": "工序未识别，暂未归类",
    "no_capacity_match": "未命中产能，请检查BOM/产品编码",
    "lean_ready": "满足排产条件",
    "ready": "满足排产条件",
}

TODO_WORKBENCH_PRIORITY = {
    "reschedule": 1,
    "ready": 2,
    "pending": 3,
}

RESCHEDULE_MAP_CACHE_TTL_SECONDS = 15
TODO_WORKBENCH_CACHE_TTL_SECONDS = 15
SCHEDULE_PLAN_LIST_CACHE_TTL_SECONDS = 15
DELETE_PREVIEW_CACHE_TTL_SECONDS = 60
_effective_reschedule_map_cache: dict[tuple, tuple[datetime, dict[int, dict[str, object]]]] = {}
_todo_workbench_cache: dict[tuple, tuple[datetime, PageResult]] = {}
_schedule_plan_list_cache: dict[tuple, tuple[datetime, PageResult]] = {}
_delete_preview_cache: dict[int, tuple[datetime, dict]] = {}
_order_snapshot_table_ready = False

CHANGE_EVENT_TYPE_LABELS = {
    "upph_change": "UPPH变化",
    "bucket_change": "排产段变化",
    "due_date_change": "交期变化",
    "quantity_change": "数量变化",
}

CHANGE_EVENT_PROCESS_STATUS_LABELS = {
    "pending": "待处理",
    "watching": "暂不处理",
    "resolved": "已处理",
}


def _invalidate_schedule_runtime_caches() -> None:
    _effective_reschedule_map_cache.clear()
    _todo_workbench_cache.clear()
    _schedule_plan_list_cache.clear()
    _delete_preview_cache.clear()
    _production_schedule_read_permission_cache.clear()


def _get_runtime_page_cache(
    cache: dict[tuple, tuple[datetime, PageResult]],
    cache_key: tuple,
    *,
    ttl_seconds: int,
) -> Optional[PageResult]:
    cached = cache.get(cache_key)
    if not cached:
        return None
    cached_at, payload = cached
    if (datetime.now() - cached_at).total_seconds() > ttl_seconds:
        cache.pop(cache_key, None)
        return None
    return payload


def _set_runtime_page_cache(
    cache: dict[tuple, tuple[datetime, PageResult]],
    cache_key: tuple,
    payload: PageResult,
) -> None:
    cache[cache_key] = (datetime.now(), payload)


def _get_cached_delete_preview(record_id: int) -> Optional[dict]:
    cached = _delete_preview_cache.get(record_id)
    if not cached:
        return None
    cached_at, payload = cached
    if (datetime.now() - cached_at).total_seconds() > DELETE_PREVIEW_CACHE_TTL_SECONDS:
        _delete_preview_cache.pop(record_id, None)
        return None
    return copy.deepcopy(payload)


def _set_cached_delete_preview(record_id: int, payload: dict) -> None:
    _delete_preview_cache[record_id] = (datetime.now(), copy.deepcopy(payload))


def _pop_cached_delete_preview(record_id: int) -> Optional[dict]:
    payload = _get_cached_delete_preview(record_id)
    _delete_preview_cache.pop(record_id, None)
    return payload


def _build_effective_reschedule_cache_key(plans: List[ProductionSchedulePlan]) -> tuple:
    signature = []
    for plan in plans:
        signature.append((
            int(plan.id or 0),
            plan.updated_at.isoformat() if getattr(plan, "updated_at", None) else None,
            str(plan.source_process_type or ""),
            str(plan.source_promised_date or ""),
            str(plan.source_order_qty or ""),
            str(plan.source_upph or ""),
            bool(plan.needs_reschedule),
            str(plan.reschedule_reason or ""),
        ))
    return tuple(signature)


def _get_cached_effective_reschedule_map(plans: List[ProductionSchedulePlan]) -> Optional[dict[int, dict[str, object]]]:
    cache_key = _build_effective_reschedule_cache_key(plans)
    cached = _effective_reschedule_map_cache.get(cache_key)
    if not cached:
        return None
    cached_at, payload = cached
    if (datetime.now() - cached_at).total_seconds() > RESCHEDULE_MAP_CACHE_TTL_SECONDS:
        _effective_reschedule_map_cache.pop(cache_key, None)
        return None
    return payload


def _set_cached_effective_reschedule_map(
    plans: List[ProductionSchedulePlan],
    payload: dict[int, dict[str, object]],
) -> None:
    cache_key = _build_effective_reschedule_cache_key(plans)
    _effective_reschedule_map_cache[cache_key] = (datetime.now(), payload)


def _serialize_debug_capacity_record(capacity: ProductProcessCapacity) -> dict[str, object]:
    metadata = parse_capacity_metadata(capacity.remark)
    return {
        "id": int(capacity.id or 0),
        "oa_detail_id": capacity.oa_detail_id,
        "bom_code": capacity.bom_code,
        "product_code": capacity.product_code,
        "process_type": capacity.process_type,
        "upph": float(capacity.upph or 0),
        "is_active": bool(capacity.is_active),
        "last_sync_time": capacity.last_sync_time.isoformat() if capacity.last_sync_time else None,
        "workshop_name": metadata.get("oa_workshop_name"),
        "oa_main_id": metadata.get("oa_main_id"),
        "is_schedulable": bool(metadata.get("is_schedulable", True)),
        "exclude_reason": metadata.get("exclude_reason"),
    }


def _build_scheduled_snapshot_state_payload() -> dict[str, object]:
    return {
        "scheduling_status": "scheduled",
        "scheduling_status_label": SCHEDULING_STATUS_LABELS["scheduled"],
        "display_status": "scheduled",
        "display_status_label": ORDER_POOL_DISPLAY_STATUS_LABELS["scheduled"],
        "scheduling_reason_code": "already_scheduled",
        "scheduling_reason": "已存在有效排产计划",
        "scheduling_reason_details_json": _serialize_snapshot_details([
            "该订单已进入已排计划，如需调整请走重排流程",
        ]),
        "snapshot_updated_at": datetime.now(),
    }


def _build_schedule_debug_report(
    *,
    bom_no: Optional[str],
    snapshot: Optional[ProductionOrderScheduleSnapshot],
    active_plan: Optional[ProductionSchedulePlan],
    serialized_capacities: list[dict[str, object]],
    schedule_context: dict[str, object],
    split_rules: dict[str, object],
) -> dict[str, object]:
    schedulable_capacities = [item for item in serialized_capacities if item.get("is_schedulable")]
    excluded_capacities = [item for item in serialized_capacities if not item.get("is_schedulable")]
    final_bucket = str(schedule_context.get("schedule_bucket") or "pending")
    final_bucket_label = SCHEDULE_BUCKET_LABELS.get(final_bucket, final_bucket)
    selected_main_id = split_rules.get("selected_main_id")
    findings: list[str] = []
    developer_hints: list[str] = []

    if serialized_capacities:
        findings.append(
            f"BOM {bom_no or '-'} 命中 {len(serialized_capacities)} 条本地产能记录，其中可排产 {len(schedulable_capacities)} 条、排除 {len(excluded_capacities)} 条。"
        )
    else:
        findings.append(f"BOM {bom_no or '-'} 未命中本地产能记录，当前无法从本地产能表直接取得有效 UPPH。")

    if selected_main_id:
        findings.append(f"BOM 拆分当前选中的泛微主表为 {selected_main_id}。")
    elif bom_no:
        findings.append("当前未选中可用于装配拆分的泛微主表。")

    if split_rules.get("split_rule_ready"):
        findings.append(
            f"拆分规则已就绪，最终排产段判定为 {split_rules.get('schedule_bucket') or final_bucket_label}。"
        )
    else:
        findings.append(f"最终排产段暂判为 {final_bucket_label}。")

    if excluded_capacities:
        excluded_summary = "；".join(
            [
                f"{item.get('id')}/{item.get('workshop_name') or '-'}: {item.get('exclude_reason') or '已排除'}"
                for item in excluded_capacities[:5]
            ]
        )
        findings.append(f"已排除记录：{excluded_summary}")
        developer_hints.append("先检查被排除记录的车间是否属于精益车间或装配车间。")

    if split_rules.get("split_rule_ready") and split_rules.get("matched_buckets"):
        developer_hints.append("如需核对装配拆分，请优先关注 selected_main_id、stage_price_totals 和 stage_rules。")
    if final_bucket == "pending":
        developer_hints.append("当前结果为待确认，优先核查 BOM 是否命中有效产能、拆分主表是否选中、公式配置是否完整。")

    snapshot_bucket = getattr(snapshot, "schedule_bucket_snapshot", None)
    snapshot_upph = getattr(snapshot, "upph_snapshot", None)
    active_plan_bucket = _normalize_plan_source_bucket(getattr(active_plan, "source_process_type", None)) if active_plan else None

    if snapshot_bucket and snapshot_bucket != final_bucket:
        developer_hints.append(
            f"快照当前仍是 {SCHEDULE_BUCKET_LABELS.get(snapshot_bucket, snapshot_bucket)}，与实时判定 {final_bucket_label} 不一致，建议刷新快照。"
        )
    if active_plan_bucket and active_plan_bucket != final_bucket:
        developer_hints.append(
            f"有效计划来源排产段为 {SCHEDULE_BUCKET_LABELS.get(active_plan_bucket, active_plan_bucket)}，与当前实时判定 {final_bucket_label} 不一致，需关注是否重排。"
        )

    return {
        "final_conclusion": {
            "schedule_bucket": final_bucket,
            "schedule_bucket_label": final_bucket_label,
            "total_upph": schedule_context.get("total_upph"),
            "matched_buckets": schedule_context.get("matched_buckets") or [],
            "split_rule_ready": bool(split_rules.get("split_rule_ready")),
            "selected_main_id": selected_main_id,
        },
        "capacity_summary": {
            "matched_capacity_count": len(serialized_capacities),
            "schedulable_capacity_count": len(schedulable_capacities),
            "excluded_capacity_count": len(excluded_capacities),
            "workshop_names": schedule_context.get("workshop_names") or [],
            "schedulable_workshop_names": schedule_context.get("schedulable_workshop_names") or [],
            "non_schedulable_reasons": schedule_context.get("non_schedulable_reasons") or [],
        },
        "bom_split_summary": {
            "selected_main_id": selected_main_id,
            "matched_buckets": split_rules.get("matched_buckets") or [],
            "schedule_bucket": split_rules.get("schedule_bucket"),
            "schedule_bucket_label": SCHEDULE_BUCKET_LABELS.get(split_rules.get("schedule_bucket"), split_rules.get("schedule_bucket")),
            "stage_price_totals": split_rules.get("stage_price_totals") or {},
            "stage_rules": split_rules.get("stage_rules") or {},
        },
        "snapshot_compare": {
            "exists": bool(snapshot),
            "schedule_bucket_snapshot": snapshot_bucket,
            "schedule_bucket_label": getattr(snapshot, "schedule_bucket_label", None),
            "upph_snapshot": float(snapshot_upph or 0) if snapshot_upph is not None else None,
            "display_status": getattr(snapshot, "display_status", None),
        },
        "active_plan_compare": {
            "exists": bool(active_plan),
            "plan_id": int(active_plan.id or 0) if active_plan else None,
            "source_process_type": getattr(active_plan, "source_process_type", None) if active_plan else None,
            "normalized_source_bucket": active_plan_bucket,
            "upph": float(active_plan.upph or 0) if active_plan and active_plan.upph is not None else None,
            "needs_reschedule": bool(active_plan.needs_reschedule) if active_plan else False,
        },
        "findings": findings,
        "developer_hints": developer_hints,
    }


async def _ensure_operation_log_table(db: AsyncSession) -> bool:
    """确保排产操作日志表存在，避免缺表导致日志链路失效。"""
    bind = db.bind
    if bind is None:
        return False
    try:
        async with bind.begin() as conn:
            await conn.run_sync(ProductionScheduleOperationLog.__table__.create, checkfirst=True)
        return True
    except Exception:
        return False


async def _ensure_order_snapshot_table(db: AsyncSession) -> bool:
    global _order_snapshot_table_ready
    if _order_snapshot_table_ready:
        return True
    try:
        bind = db.bind
        if bind is None:
            return False
        async with bind.begin() as conn:
            await conn.run_sync(ProductionOrderScheduleSnapshot.__table__.create, checkfirst=True)
    except Exception:
        return False
    _order_snapshot_table_ready = True
    return True


def _serialize_snapshot_details(details: list[str]) -> str:
    return json.dumps(details or [], ensure_ascii=True)


def _deserialize_snapshot_details(raw_value: Optional[str]) -> list[str]:
    if not raw_value:
        return []
    try:
        parsed = json.loads(raw_value)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed if item is not None]


async def _log_schedule_operation(
    db: AsyncSession,
    operation_type: str,
    operator: str,
    *,
    plan_id: Optional[int] = None,
    plan_version: Optional[int] = None,
    order_no: Optional[str] = None,
    line_no: Optional[str] = None,
    remark: Optional[str] = None,
    affected_plan_ids: Optional[List[int]] = None,
    previous_version_id: Optional[int] = None,
) -> Optional[ProductionScheduleOperationLog]:
    """记录排产操作日志（日志表缺失时不影响主业务事务）"""
    import json

    try:
        if not await _ensure_operation_log_table(db):
            return None
        async with db.begin_nested():
            log_item = ProductionScheduleOperationLog(
                plan_id=plan_id,
                plan_version=plan_version,
                order_no=order_no,
                line_no=line_no,
                operation_type=operation_type,
                operator=operator,
                remark=remark,
                affected_plan_ids=json.dumps(affected_plan_ids) if affected_plan_ids else None,
                previous_version_id=previous_version_id,
            )
            db.add(log_item)
            await db.flush([log_item])
            return log_item
    except Exception:
        return None


def _parse_change_event_id(event_id: str) -> tuple[Optional[int], Optional[str]]:
    if not event_id or ":" not in event_id:
        return None, None


def _normalize_plan_source_bucket(bucket: Optional[str]) -> str:
    normalized = str(bucket or "").strip()
    if normalized in SCHEDULE_BUCKET_LABELS:
        return normalized
    # 兼容老计划未回填 source_process_type 的情况，按历史约定归到精益。
    return "lean"


def _build_bucket_change_reason(
    *,
    source_bucket: str,
    current_bucket: str,
    schedule_context: Optional[dict],
    current_reason: Optional[str],
) -> str:
    source_label = SCHEDULE_BUCKET_LABELS.get(source_bucket, source_bucket or "-")
    current_label = SCHEDULE_BUCKET_LABELS.get(current_bucket, current_bucket or "-")
    reason_parts = [f"排产段 {source_label} -> {current_label}"]

    workshop_names = list((schedule_context or {}).get("workshop_names") or [])
    if workshop_names:
        reason_parts.append(f"当前命中车间 {' / '.join(workshop_names)}")

    matched_bucket_labels = [
        SCHEDULE_BUCKET_LABELS.get(item, item)
        for item in ((schedule_context or {}).get("matched_buckets") or [])
        if item
    ]
    if matched_bucket_labels:
        reason_parts.append(f"当前命中阶段 {' / '.join(matched_bucket_labels)}")

    if current_reason:
        reason_parts.append(f"当前判定：{current_reason}")

    details = list((schedule_context or {}).get("non_schedulable_reasons") or [])
    if details:
        reason_parts.extend(details[:2])
    return "；".join(reason_parts)


def _resolve_effective_current_bucket_for_plan(
    *,
    source_bucket: str,
    schedule_context: Optional[dict],
) -> str:
    current_bucket = str((schedule_context or {}).get("schedule_bucket") or "pending")
    if current_bucket not in SCHEDULE_BUCKET_LABELS:
        current_bucket = "pending"

    if current_bucket == "mixed" and source_bucket in {"assembly", "packaging"}:
        matched_buckets = {
            str(item).strip()
            for item in ((schedule_context or {}).get("matched_buckets") or [])
            if str(item).strip()
        }
        if source_bucket in matched_buckets:
            return source_bucket

    return current_bucket


def _pick_preferred_reschedule_event(
    items: List[ScheduleChangeEventOut],
) -> Optional[ScheduleChangeEventOut]:
    actionable = [item for item in items if item.needs_reschedule]
    if not actionable:
        return None
    actionable.sort(
        key=lambda item: (
            0 if item.process_status == "pending" else 1,
            IMPACT_PRIORITY_MAP.get(item.impact_level, 99),
            -(item.impact_score or 0),
            item.event_type,
        )
    )
    return actionable[0]


async def _build_effective_reschedule_map(
    db: AsyncSession,
    plans: List[ProductionSchedulePlan],
    impact_config: Optional[dict] = None,
) -> dict[int, dict[str, object]]:
    if not plans:
        return {}
    cached_payload = _get_cached_effective_reschedule_map(plans)
    if cached_payload is not None:
        return cached_payload
    change_events = await _build_schedule_change_event_items(db, plans, impact_config=impact_config)
    grouped: dict[int, List[ScheduleChangeEventOut]] = {}
    for item in change_events:
        grouped.setdefault(int(item.id), []).append(item)

    result: dict[int, dict[str, object]] = {}
    for plan in plans:
        if not plan.id:
            continue
        plan_events = grouped.get(int(plan.id), [])
        preferred = _pick_preferred_reschedule_event(plan_events)
        if preferred and preferred.process_status == "pending":
            result[int(plan.id)] = {
                "needs_reschedule": True,
                "reschedule_reason": preferred.reschedule_reason or preferred.change_summary or "计划发生变化，建议重排",
                "impact_reason": preferred.impact_reason,
                "event_type": preferred.event_type,
                "schedule_bucket": preferred.schedule_bucket,
                "schedule_bucket_label": preferred.schedule_bucket_label,
                "impact_level": preferred.impact_level,
                "impact_score": preferred.impact_score,
            }
            continue

        has_non_pending_actionable = any(item.needs_reschedule for item in plan_events)
        if has_non_pending_actionable:
            result[int(plan.id)] = {
                "needs_reschedule": False,
                "reschedule_reason": None,
                "impact_reason": None,
                "event_type": None,
                "schedule_bucket": _normalize_plan_source_bucket(plan.source_process_type),
                "schedule_bucket_label": SCHEDULE_BUCKET_LABELS.get(_normalize_plan_source_bucket(plan.source_process_type)),
                "impact_level": None,
                "impact_score": None,
            }
            continue

        source_bucket = _normalize_plan_source_bucket(plan.source_process_type)
        result[int(plan.id)] = {
            "needs_reschedule": bool(plan.needs_reschedule),
            "reschedule_reason": plan.reschedule_reason or ("计划发生变化，建议重排" if plan.needs_reschedule else None),
            "impact_reason": plan.reschedule_reason if plan.needs_reschedule else None,
            "event_type": None,
            "schedule_bucket": source_bucket,
            "schedule_bucket_label": SCHEDULE_BUCKET_LABELS.get(source_bucket),
            "impact_level": None,
            "impact_score": None,
        }
    _set_cached_effective_reschedule_map(plans, result)
    return result
    plan_id_text, event_type = event_id.split(":", 1)
    try:
        return int(plan_id_text), event_type
    except ValueError:
        return None, None


async def _build_change_event_status_map(
    db: AsyncSession,
    plan_ids: List[int],
) -> dict[tuple[int, str], dict[str, object]]:
    if not plan_ids:
        return {}
    if not await _ensure_operation_log_table(db):
        return {}
    result = await db.execute(
        select(ProductionScheduleOperationLog)
        .where(
            ProductionScheduleOperationLog.plan_id.in_(plan_ids),
            ProductionScheduleOperationLog.operation_type == "change_event_status",
        )
        .order_by(ProductionScheduleOperationLog.operation_at.desc(), ProductionScheduleOperationLog.id.desc())
    )
    status_map: dict[tuple[int, str], dict[str, object]] = {}
    for log in result.scalars().all():
        try:
            payload = json.loads(log.remark or "{}")
        except Exception:
            continue
        event_type = str(payload.get("event_type") or "")
        process_status = str(payload.get("process_status") or "")
        if not log.plan_id or not event_type or process_status not in CHANGE_EVENT_PROCESS_STATUS_LABELS:
            continue
        key = (int(log.plan_id), event_type)
        if key in status_map:
            continue
        status_map[key] = {
            "process_status": process_status,
            "process_status_label": CHANGE_EVENT_PROCESS_STATUS_LABELS[process_status],
            "process_operator": log.operator,
            "process_at": log.operation_at,
        }
    return status_map

IMPACT_PRIORITY_MAP = {
    "high": 0,
    "medium": 1,
    "low": 2,
}

READY_OFFSET_DAYS = 2
LEAN_STANDARD_DAILY_HOURS = 8.5
LEAN_MAX_DAILY_HOURS = 12.0

SCHEDULE_BUCKET_WORK_HOUR_CODES = {
    "lean": "daily_work_hours_lean",
    "assembly": "daily_work_hours_assembly",
    "packaging": "daily_work_hours_packaging",
    "mixed": "daily_work_hours_mixed",
    "pending": "daily_work_hours_pending",
}

LEAN_CAPACITY_LOAD_LABELS = {
    "normal": "正常",
    "overtime": "需加班",
    "sunday_production": "周日生产",
    "move_earlier": "需前挪",
}


def _get_order_line_bom_code(order_line) -> Optional[str]:
    # 订单侧字段名是 bom_no，这里统一映射到 UPPH 匹配语义 bom_code。
    return getattr(order_line, "bom_no", None) or getattr(order_line, "bom_code", None)


def _build_delete_preview_response(
    *,
    record: ProductionSchedulePlan,
    remark: Optional[str],
    preview_result: dict,
) -> dict:
    return {
        "plan_id": record.id,
        "order_no": record.order_no,
        "line_no": record.line_no,
        "reason": remark,
        "release_plan_date": preview_result.get("release_plan_date"),
        "earliest_backfill_date": preview_result.get("earliest_backfill_date"),
        "release_bucket": preview_result.get("release_bucket"),
        "release_bucket_label": SCHEDULE_BUCKET_LABELS.get(preview_result.get("release_bucket")),
        "affected_count": preview_result.get("affected_count") or 0,
        "affected_plan_ids": preview_result.get("affected_plan_ids") or [],
        "items": [
            {
                **item,
                "schedule_bucket_label": SCHEDULE_BUCKET_LABELS.get(item.get("schedule_bucket")),
            }
            for item in (preview_result.get("items") or [])
        ],
    }


async def _build_order_scheduling_items(
    db: AsyncSession,
    *,
    page: int,
    page_size: int,
    year: Optional[int],
    month: Optional[int],
    keyword: Optional[str],
    risk_level: Optional[str],
    only_unscheduled: bool,
    schedule_bucket: Optional[str],
    scheduling_status: Optional[str],
) -> tuple[list[OrderForSchedulingOut], int, dict]:
    today = date.today()
    target_year = year or today.year
    target_month = month or today.month

    first_day = date(target_year, target_month, 1)
    if target_month == 12:
        last_day = date(target_year + 1, 1, 1) - timedelta(days=1)
    else:
        last_day = date(target_year, target_month + 1, 1) - timedelta(days=1)

    conditions = [
        SaleOrderLine.promised_date >= first_day,
        SaleOrderLine.promised_date <= last_day,
        SaleOrderLine.status != "closed",
    ]

    if keyword:
        like = f"%{keyword}%"
        conditions.append(
            or_(
                SaleOrderLine.order_no.ilike(like),
                SaleOrderLine.product_code.ilike(like),
            )
        )

    subq = (
        select(
            SaleOrderLine.order_no,
            SaleOrderLine.line_no,
            func.max(SaleOrderLine.id).label("max_id")
        )
        .where(*conditions)
        .group_by(SaleOrderLine.order_no, SaleOrderLine.line_no)
        .subquery()
    )

    result = await db.execute(
        select(SaleOrderLine, SaleOrder.customer, SaleOrder.risk_level)
        .join(
            subq,
            and_(
                SaleOrderLine.order_no == subq.c.order_no,
                SaleOrderLine.line_no == subq.c.line_no,
                SaleOrderLine.id == subq.c.max_id,
            )
        )
        .outerjoin(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)
        .order_by(SaleOrderLine.promised_date.asc(), SaleOrderLine.order_no.asc(), SaleOrderLine.line_no.asc())
    )
    rows = result.all()
    split_rules_map = await _build_split_rules_map(
        db,
        [_get_order_line_bom_code(row.SaleOrderLine) for row in rows],
    )

    order_nos = [row.SaleOrderLine.order_no for row in rows]
    line_nos = [row.SaleOrderLine.line_no for row in rows]
    scheduled_set = set()
    if order_nos and line_nos:
        schedule_result = await db.execute(
            select(ProductionSchedulePlan.order_no, ProductionSchedulePlan.line_no)
            .where(
                ProductionSchedulePlan.order_no.in_(order_nos),
                ProductionSchedulePlan.line_no.in_(line_nos),
                ProductionSchedulePlan.is_active == True,
            )
        )
        for order_no, line_no in schedule_result.all():
            scheduled_set.add(f"{order_no}_{line_no}")

    upph_service = UpphCalculationService(db)
    simulation_service = ScheduleSimulationService(db)
    schedule_context_cache: dict[tuple[Optional[str], Optional[str]], dict] = {}
    items: List[OrderForSchedulingOut] = []
    stats = {
        "ready": 0,
        "pending": 0,
        "excluded": 0,
        "scheduled": 0,
        "missing_upph": 0,
    }
    for row in rows:
        order_line = row.SaleOrderLine
        customer = row.customer
        current_risk_level = row.risk_level
        if risk_level and current_risk_level != risk_level:
            continue

        has_schedule = f"{order_line.order_no}_{order_line.line_no}" in scheduled_set
        if only_unscheduled and has_schedule:
            continue
        bom_no = _get_order_line_bom_code(order_line)
        cache_key = (order_line.product_code, bom_no)
        if cache_key not in schedule_context_cache:
            schedule_context_cache[cache_key] = await upph_service.summarize_schedule_context(
                product_code=order_line.product_code,
                bom_code=bom_no,
                preloaded_split_rules=split_rules_map.get(str(bom_no).strip()) if bom_no else None,
            )
        schedule_context = schedule_context_cache[cache_key]
        current_schedule_bucket = schedule_context.get("schedule_bucket")
        lean_workhour_plan = {}
        current_bucket_upph = float(schedule_context.get("total_upph") or 0)
        if current_schedule_bucket in {"assembly", "packaging"}:
            current_bucket_upph = float(
                ((schedule_context.get("stage_rules") or {}).get(current_schedule_bucket, {}) or {}).get("upph") or 0
            )
        if current_schedule_bucket in {"lean", "assembly", "packaging"}:
            lean_workhour_plan = simulation_service.build_bucket_workhour_plan(
                quantity=float(order_line.order_qty or 0),
                upph=current_bucket_upph,
                promised_date=order_line.promised_date,
                schedule_bucket=current_schedule_bucket,
            )
        scheduling_state = _resolve_order_scheduling_state(
            schedule_context,
            has_schedule=has_schedule,
        )
        display_state = _resolve_order_display_state(
            order_qty=float(order_line.order_qty or 0),
            scheduling_state=scheduling_state,
        )
        scheduling_reason_details = list(display_state.get("details") or [])
        if lean_workhour_plan.get("work_hour_summary"):
            scheduling_reason_details.append(lean_workhour_plan["work_hour_summary"])
        display_status = str(display_state["status"])
        if schedule_bucket and current_schedule_bucket != schedule_bucket:
            continue
        if scheduling_status:
            if scheduling_status == "workbench":
                if display_status not in {"ready", "pending"}:
                    continue
            elif display_status != scheduling_status:
                continue

        stats[display_status] += 1
        if bool(display_state.get("is_missing_upph")):
            stats["missing_upph"] += 1

        items.append(OrderForSchedulingOut(
            order_no=order_line.order_no,
            line_no=order_line.line_no,
            customer=customer,
            bom_no=bom_no,
            product_code=order_line.product_code,
            product_model=order_line.product_model,
            order_qty=float(order_line.order_qty or 0),
            promised_date=order_line.promised_date,
            risk_level=current_risk_level,
            status=order_line.status,
            upph=float(schedule_context.get("total_upph") or 0),
            has_schedule=has_schedule,
            schedule_bucket=current_schedule_bucket,
            schedule_bucket_label=SCHEDULE_BUCKET_LABELS.get(current_schedule_bucket),
            scheduling_status=str(scheduling_state["status"]),
            scheduling_status_label=str(scheduling_state["status_label"]),
            display_status=display_status,
            display_status_label=str(display_state["status_label"]),
            scheduling_reason_code=display_state.get("reason_code"),
            scheduling_reason=display_state.get("reason"),
            scheduling_reason_details=scheduling_reason_details,
            is_missing_upph=bool(display_state.get("is_missing_upph")),
            target_ready_date=lean_workhour_plan.get("target_ready_date"),
            ready_offset_days=lean_workhour_plan.get("ready_offset_days") or READY_OFFSET_DAYS,
            total_hours=lean_workhour_plan.get("total_hours"),
            available_production_days=lean_workhour_plan.get("available_production_days"),
            required_daily_hours=lean_workhour_plan.get("required_daily_hours"),
            recommended_daily_hours=lean_workhour_plan.get("recommended_daily_hours"),
            capacity_load_status=lean_workhour_plan.get("capacity_load_status"),
            capacity_load_status_label=lean_workhour_plan.get("capacity_load_status_label"),
            sunday_rest_allowed=lean_workhour_plan.get("sunday_rest_allowed"),
            needs_sunday_work=lean_workhour_plan.get("needs_sunday_work"),
            needs_move_earlier=lean_workhour_plan.get("needs_move_earlier"),
            move_earlier_days=lean_workhour_plan.get("move_earlier_days"),
            work_hour_summary=lean_workhour_plan.get("work_hour_summary"),
        ))
    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    return items[start:end], total, stats


def _resolve_order_scheduling_state(
    schedule_context: Optional[dict],
    *,
    has_schedule: bool,
) -> dict[str, object]:
    if has_schedule:
        return {
            "status": "scheduled",
            "status_label": SCHEDULING_STATUS_LABELS["scheduled"],
            "reason_code": "already_scheduled",
            "reason": "已存在有效排产计划",
            "details": ["该订单已进入已排计划，如需调整请走重排流程"],
        }

    if not schedule_context:
        return {
            "status": "pending",
            "status_label": SCHEDULING_STATUS_LABELS["pending"],
            "reason_code": "no_capacity_match",
            "reason": "未匹配到产能记录",
            "details": ["当前订单未命中任何产品工序产能数据，请先检查 BOM/产品编码与产能资料"],
        }

    total_upph = float(schedule_context.get("total_upph") or 0)
    bucket = schedule_context.get("schedule_bucket")
    has_any_capacity = bool(schedule_context.get("has_any_capacity"))
    has_schedulable_capacity = bool(schedule_context.get("has_schedulable_capacity"))
    matched_capacity_count = int(schedule_context.get("matched_capacity_count") or 0)
    positive_upph_count = int(schedule_context.get("positive_upph_count") or 0)
    workshop_names = list(schedule_context.get("workshop_names") or [])
    non_schedulable_reasons = list(schedule_context.get("non_schedulable_reasons") or [])
    lean_main_count = int(schedule_context.get("lean_main_count") or 0)
    stage_rules = schedule_context.get("stage_rules") or {}
    split_rule_ready = bool(schedule_context.get("split_rule_ready"))

    details: list[str] = []
    if workshop_names:
        details.append(f"命中车间：{' / '.join(workshop_names)}")
    if matched_capacity_count > 0:
        details.append(f"命中产能记录 {matched_capacity_count} 条")
    if lean_main_count > 0:
        details.append(f"精益按 OA 主表去重后共 {lean_main_count} 张主表")
    if total_upph > 0:
        details.append(f"当前汇总 UPPH {total_upph:.2f}")
    if stage_rules.get("assembly", {}).get("upph"):
        details.append(f"组装 UPPH {float(stage_rules['assembly']['upph']):.2f}")
    if stage_rules.get("packaging", {}).get("upph"):
        details.append(f"包装 UPPH {float(stage_rules['packaging']['upph']):.2f}")

    if bucket == "lean":
        if total_upph <= 0:
            if positive_upph_count <= 0:
                details.append("精益产能记录存在，但没有可用 UPPH")
            return {
                "status": "pending",
                "status_label": SCHEDULING_STATUS_LABELS["pending"],
                "reason_code": "lean_missing_upph",
                "reason": "已命中精益产能，但缺少有效UPPH",
                "details": details,
            }
        return {
            "status": "ready",
            "status_label": SCHEDULING_STATUS_LABELS["ready"],
            "reason_code": "lean_ready",
            "reason": "已命中精益产能，满足排产条件",
            "details": details,
        }

    if bucket in {"assembly", "packaging"}:
        if split_rule_ready and float(stage_rules.get(bucket, {}).get("upph") or 0) > 0:
            details.append("当前阶段将按明细单价汇总后计算 UPPH")
            return {
                "status": "ready",
                "status_label": SCHEDULING_STATUS_LABELS["ready"],
                "reason_code": f"{bucket}_rule_pending",
                "reason": "已命中装配规则，满足排产条件",
                "details": details,
            }
        details.append("当前阶段缺少有效单价或公式配置，暂不能自动排产")
        return {
            "status": "pending",
            "status_label": SCHEDULING_STATUS_LABELS["pending"],
            "reason_code": f"{bucket}_rule_pending",
            "reason": "已命中装配产能，但当前缺少有效 UPPH",
            "details": details,
        }

    if bucket == "mixed":
        if split_rule_ready and all(float(stage_rules.get(item, {}).get("upph") or 0) > 0 for item in ("assembly", "packaging")):
            details.append("同一订单将按组装/包装两段滚动排产")
            details.append("包装默认承接组装前一日释放量")
            return {
                "status": "ready",
                "status_label": SCHEDULING_STATUS_LABELS["ready"],
                "reason_code": "mixed_bucket_pending",
                "reason": "已识别组装+包装拆分规则，满足排产条件",
                "details": details,
            }
        details.append("同一订单同时命中组装和包装，但拆分单价或公式配置仍不完整")
        return {
            "status": "pending",
            "status_label": SCHEDULING_STATUS_LABELS["pending"],
            "reason_code": "mixed_bucket_pending",
            "reason": "装配产能同时命中组装/包装，但当前拆分 UPPH 不完整",
            "details": details,
        }

    if bucket == "pending":
        if has_any_capacity and not has_schedulable_capacity and non_schedulable_reasons:
            details.extend(non_schedulable_reasons)
            return {
                "status": "pending",
                "status_label": SCHEDULING_STATUS_LABELS["pending"],
                "reason_code": "non_schedulable_workshop",
                "reason": "已命中其他车间产能，当前不参与自动排产",
                "details": details,
            }
        if has_any_capacity:
            return {
                "status": "pending",
                "status_label": SCHEDULING_STATUS_LABELS["pending"],
                "reason_code": "bucket_unclassified",
                "reason": "已命中产能记录，但车间/工序尚未完成排产归类",
                "details": details,
            }
        return {
            "status": "pending",
            "status_label": SCHEDULING_STATUS_LABELS["pending"],
            "reason_code": "no_capacity_match",
            "reason": "未匹配到可用产能记录",
            "details": details or ["当前订单未命中任何产品工序产能数据"],
        }

    if total_upph <= 0:
        return {
            "status": "pending",
            "status_label": SCHEDULING_STATUS_LABELS["pending"],
            "reason_code": "missing_upph",
            "reason": "缺少有效UPPH，暂不能自动排产",
            "details": details,
        }

    return {
        "status": "ready",
        "status_label": SCHEDULING_STATUS_LABELS["ready"],
        "reason_code": "ready",
        "reason": "满足排产条件",
        "details": details,
    }


def _resolve_order_display_state(
    *,
    order_qty: float,
    scheduling_state: dict[str, object],
) -> dict[str, object]:
    status = str(scheduling_state.get("status") or "pending")
    reason_code = str(scheduling_state.get("reason_code") or "")
    reason = str(scheduling_state.get("reason") or "")
    details = list(scheduling_state.get("details") or [])
    short_reason = ORDER_POOL_REASON_SHORT_LABELS.get(reason_code, reason or "-")

    if status == "scheduled":
        return {
            "status": "scheduled",
            "status_label": ORDER_POOL_DISPLAY_STATUS_LABELS["scheduled"],
            "reason_code": reason_code,
            "reason": short_reason,
            "details": details,
            "is_missing_upph": False,
        }

    if order_qty <= 0:
        return {
            "status": "excluded",
            "status_label": ORDER_POOL_DISPLAY_STATUS_LABELS["excluded"],
            "reason_code": "zero_quantity",
            "reason": ORDER_POOL_REASON_SHORT_LABELS["zero_quantity"],
            "details": ["订单数量小于等于0，当前不参与自动排产"],
            "is_missing_upph": False,
        }

    if reason_code == "non_schedulable_workshop":
        return {
            "status": "excluded",
            "status_label": ORDER_POOL_DISPLAY_STATUS_LABELS["excluded"],
            "reason_code": reason_code,
            "reason": short_reason,
            "details": details,
            "is_missing_upph": False,
        }

    is_missing_upph = reason_code in {"lean_missing_upph", "missing_upph"}
    if status == "ready":
        return {
            "status": "ready",
            "status_label": ORDER_POOL_DISPLAY_STATUS_LABELS["ready"],
            "reason_code": reason_code,
            "reason": short_reason,
            "details": details,
            "is_missing_upph": False,
        }

    return {
        "status": "pending",
        "status_label": ORDER_POOL_DISPLAY_STATUS_LABELS["pending"],
        "reason_code": reason_code,
        "reason": short_reason,
        "details": details,
        "is_missing_upph": is_missing_upph,
    }


def _is_snapshot_stale(
    snapshot: Optional[ProductionOrderScheduleSnapshot],
    order_line: SaleOrderLine,
) -> bool:
    if not snapshot:
        return True
    if int(snapshot.sale_order_line_id or 0) != int(order_line.id):
        return True
    snapshot_updated = getattr(snapshot, "sale_order_line_updated_at", None)
    order_updated = getattr(order_line, "updated_at", None)
    if snapshot_updated != order_updated:
        return True
    current_bom_no = _get_order_line_bom_code(order_line)
    if current_bom_no and not getattr(snapshot, "bom_no", None):
        return True
    if getattr(snapshot, "schedule_bucket_snapshot", None) is None:
        return True
    if getattr(snapshot, "schedule_bucket_label", None) is None:
        return True
    if getattr(snapshot, "display_status", None) is None:
        return True
    if getattr(snapshot, "display_status_label", None) is None:
        return True
    return False


async def _load_order_snapshot_map_by_keys(
    db: AsyncSession,
    keys: set[tuple[str, str]],
) -> dict[tuple[str, str], ProductionOrderScheduleSnapshot]:
    if not keys:
        return {}
    result = await db.execute(
        select(ProductionOrderScheduleSnapshot).where(
            tuple_(
                ProductionOrderScheduleSnapshot.order_no,
                ProductionOrderScheduleSnapshot.line_no,
            ).in_(list(keys))
        )
    )
    return {
        (item.order_no, item.line_no): item
        for item in result.scalars().all()
    }


async def _load_order_snapshot_map(
    db: AsyncSession,
    rows: list,
) -> dict[tuple[str, str], ProductionOrderScheduleSnapshot]:
    keys = {
        (row.SaleOrderLine.order_no, row.SaleOrderLine.line_no)
        for row in rows
        if row.SaleOrderLine.order_no and row.SaleOrderLine.line_no
    }
    return await _load_order_snapshot_map_by_keys(db, keys)


async def _query_snapshot_source_rows_by_keys(
    db: AsyncSession,
    keys: set[tuple[str, str]],
) -> list:
    if not keys:
        return []
    latest_line_subq = (
        select(
            SaleOrderLine.order_no,
            SaleOrderLine.line_no,
            func.max(SaleOrderLine.id).label("max_id"),
        )
        .where(tuple_(SaleOrderLine.order_no, SaleOrderLine.line_no).in_(list(keys)))
        .group_by(SaleOrderLine.order_no, SaleOrderLine.line_no)
        .subquery()
    )
    result = await db.execute(
        select(SaleOrderLine, SaleOrder.customer, SaleOrder.risk_level)
        .join(
            latest_line_subq,
            and_(
                SaleOrderLine.order_no == latest_line_subq.c.order_no,
                SaleOrderLine.line_no == latest_line_subq.c.line_no,
                SaleOrderLine.id == latest_line_subq.c.max_id,
            )
        )
        .outerjoin(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)
    )
    return list(result.all())


async def _mark_snapshots_scheduled_by_keys(
    db: AsyncSession,
    keys: set[tuple[str, str]],
) -> int:
    if not keys:
        return 0
    snapshot_map = await _load_order_snapshot_map_by_keys(db, keys)
    scheduled_payload = _build_scheduled_snapshot_state_payload()
    updated_count = 0
    for key in keys:
        snapshot = snapshot_map.get(key)
        if not snapshot:
            continue
        dirty = False
        for field, value in scheduled_payload.items():
            if getattr(snapshot, field, None) != value:
                setattr(snapshot, field, value)
                dirty = True
        if dirty:
            updated_count += 1
    if updated_count:
        await db.flush()
    return updated_count


async def _sync_snapshot_schedule_state_for_keys(
    db: AsyncSession,
    keys: set[tuple[str, str]],
) -> None:
    if not keys:
        return
    await _ensure_order_snapshot_table(db)
    source_rows = await _query_snapshot_source_rows_by_keys(db, keys)
    if source_rows:
        await _refresh_order_schedule_snapshots(db, source_rows, force_refresh=True)

    active_plan_rows = (
        await db.execute(
            select(ProductionSchedulePlan.order_no, ProductionSchedulePlan.line_no)
            .where(
                ProductionSchedulePlan.is_active == True,
                tuple_(ProductionSchedulePlan.order_no, ProductionSchedulePlan.line_no).in_(list(keys)),
            )
        )
    ).all()
    active_plan_keys = {
        (str(order_no), str(line_no))
        for order_no, line_no in active_plan_rows
        if order_no and line_no
    }
    if active_plan_keys:
        updated_count = await _mark_snapshots_scheduled_by_keys(db, active_plan_keys)
        if updated_count:
            await db.commit()


async def _sync_month_scheduled_snapshot_flags(
    db: AsyncSession,
    *,
    first_day: date,
    last_day: date,
) -> int:
    await _ensure_order_snapshot_table(db)
    rows = (
        await db.execute(
            select(ProductionOrderScheduleSnapshot.order_no, ProductionOrderScheduleSnapshot.line_no)
            .join(
                ProductionSchedulePlan,
                and_(
                    ProductionOrderScheduleSnapshot.order_no == ProductionSchedulePlan.order_no,
                    ProductionOrderScheduleSnapshot.line_no == ProductionSchedulePlan.line_no,
                )
            )
            .where(
                ProductionSchedulePlan.is_active == True,
                ProductionOrderScheduleSnapshot.promised_date >= first_day,
                ProductionOrderScheduleSnapshot.promised_date <= last_day,
                or_(
                    ProductionOrderScheduleSnapshot.scheduling_status != "scheduled",
                    ProductionOrderScheduleSnapshot.display_status != "scheduled",
                    ProductionOrderScheduleSnapshot.scheduling_reason_code != "already_scheduled",
                ),
            )
        )
    ).all()
    active_plan_keys = {
        (str(order_no), str(line_no))
        for order_no, line_no in rows
        if order_no and line_no
    }
    if not active_plan_keys:
        return 0
    updated_count = await _mark_snapshots_scheduled_by_keys(db, active_plan_keys)
    if updated_count:
        await db.commit()
    return updated_count


async def _refresh_order_schedule_snapshots(
    db: AsyncSession,
    rows: list,
    *,
    force_refresh: bool = False,
) -> dict[tuple[str, str], ProductionOrderScheduleSnapshot]:
    if not rows:
        return {}

    await _ensure_order_snapshot_table(db)
    snapshot_map = await _load_order_snapshot_map(db, rows)
    stale_rows = rows if force_refresh else [
        row for row in rows
        if _is_snapshot_stale(
            snapshot_map.get((row.SaleOrderLine.order_no, row.SaleOrderLine.line_no)),
            row.SaleOrderLine,
        )
    ]
    if not stale_rows:
        return snapshot_map

    split_rules_map = await _build_split_rules_map(
        db,
        [_get_order_line_bom_code(row.SaleOrderLine) for row in stale_rows],
    )
    upph_service = UpphCalculationService(db)
    simulation_service = ScheduleSimulationService(db)
    schedule_context_cache: dict[tuple[Optional[str], Optional[str]], dict] = {}

    for row in stale_rows:
        order_line = row.SaleOrderLine
        customer = getattr(row, "customer", None)
        risk_level = getattr(row, "risk_level", None)
        bom_no = _get_order_line_bom_code(order_line)
        cache_key = (order_line.product_code, bom_no)
        if cache_key not in schedule_context_cache:
            schedule_context_cache[cache_key] = await upph_service.summarize_schedule_context(
                product_code=order_line.product_code,
                bom_code=bom_no,
                preloaded_split_rules=split_rules_map.get(str(bom_no).strip()) if bom_no else None,
            )
        schedule_context = schedule_context_cache[cache_key]
        current_schedule_bucket = schedule_context.get("schedule_bucket")
        lean_workhour_plan = {}
        current_bucket_upph = float(schedule_context.get("total_upph") or 0)
        if current_schedule_bucket in {"assembly", "packaging"}:
            current_bucket_upph = float(
                ((schedule_context.get("stage_rules") or {}).get(current_schedule_bucket, {}) or {}).get("upph") or 0
            )
        if current_schedule_bucket in {"lean", "assembly", "packaging"}:
            lean_workhour_plan = simulation_service.build_bucket_workhour_plan(
                quantity=float(order_line.order_qty or 0),
                upph=current_bucket_upph,
                promised_date=order_line.promised_date,
                schedule_bucket=current_schedule_bucket,
            )
        scheduling_state = _resolve_order_scheduling_state(
            schedule_context,
            has_schedule=False,
        )
        display_state = _resolve_order_display_state(
            order_qty=float(order_line.order_qty or 0),
            scheduling_state=scheduling_state,
        )
        scheduling_reason_details = list(display_state.get("details") or [])
        if lean_workhour_plan.get("work_hour_summary"):
            scheduling_reason_details.append(lean_workhour_plan["work_hour_summary"])

        payload = {
            "sale_order_line_id": int(order_line.id),
            "sale_order_line_updated_at": order_line.updated_at,
            "customer": customer,
            "risk_level": risk_level,
            "bom_no": bom_no,
            "product_code": order_line.product_code,
            "product_model": order_line.product_model,
            "order_qty": float(order_line.order_qty or 0),
            "promised_date": order_line.promised_date,
            "upph_snapshot": float(schedule_context.get("total_upph") or 0),
            "schedule_bucket_snapshot": current_schedule_bucket,
            "schedule_bucket_label": SCHEDULE_BUCKET_LABELS.get(current_schedule_bucket),
            "scheduling_status": str(scheduling_state.get("status") or "pending"),
            "scheduling_status_label": str(scheduling_state.get("status_label") or SCHEDULING_STATUS_LABELS["pending"]),
            "display_status": str(display_state.get("status") or "pending"),
            "display_status_label": str(display_state.get("status_label") or ORDER_POOL_DISPLAY_STATUS_LABELS["pending"]),
            "scheduling_reason_code": display_state.get("reason_code"),
            "scheduling_reason": display_state.get("reason"),
            "scheduling_reason_details_json": _serialize_snapshot_details(scheduling_reason_details),
            "is_missing_upph": bool(display_state.get("is_missing_upph")),
            "target_ready_date": lean_workhour_plan.get("target_ready_date"),
            "ready_offset_days": int(lean_workhour_plan.get("ready_offset_days") or READY_OFFSET_DAYS),
            "total_hours": lean_workhour_plan.get("total_hours"),
            "available_production_days": lean_workhour_plan.get("available_production_days"),
            "required_daily_hours": lean_workhour_plan.get("required_daily_hours"),
            "recommended_daily_hours": lean_workhour_plan.get("recommended_daily_hours"),
            "capacity_load_status": lean_workhour_plan.get("capacity_load_status"),
            "capacity_load_status_label": lean_workhour_plan.get("capacity_load_status_label"),
            "sunday_rest_allowed": lean_workhour_plan.get("sunday_rest_allowed"),
            "needs_sunday_work": lean_workhour_plan.get("needs_sunday_work"),
            "needs_move_earlier": lean_workhour_plan.get("needs_move_earlier"),
            "move_earlier_days": lean_workhour_plan.get("move_earlier_days"),
            "work_hour_summary": lean_workhour_plan.get("work_hour_summary"),
            "snapshot_updated_at": datetime.now(),
        }

        snapshot = snapshot_map.get((order_line.order_no, order_line.line_no))
        if snapshot:
            for field, value in payload.items():
                setattr(snapshot, field, value)
        else:
            snapshot = ProductionOrderScheduleSnapshot(
                order_no=order_line.order_no,
                line_no=order_line.line_no,
                **payload,
            )
            db.add(snapshot)
        snapshot_map[(order_line.order_no, order_line.line_no)] = snapshot

    await db.flush()
    await db.commit()
    return snapshot_map


async def _query_todo_snapshot_source_rows(
    db: AsyncSession,
    *,
    year: Optional[int],
    month: Optional[int],
    keyword: Optional[str],
    risk_level: Optional[str],
    limit: int,
) -> list:
    today = date.today()
    target_year = year or today.year
    target_month = month or today.month
    first_day = date(target_year, target_month, 1)
    if target_month == 12:
        last_day = date(target_year + 1, 1, 1) - timedelta(days=1)
    else:
        last_day = date(target_year, target_month + 1, 1) - timedelta(days=1)

    pool_conditions = [
        SaleOrderLine.promised_date >= first_day,
        SaleOrderLine.promised_date <= last_day,
        SaleOrderLine.status != "closed",
    ]
    if keyword:
        like = f"%{keyword}%"
        pool_conditions.append(
            or_(
                SaleOrderLine.order_no.ilike(like),
                SaleOrderLine.product_code.ilike(like),
                SaleOrderLine.product_model.ilike(like),
                SaleOrderLine.bom_no.ilike(like),
            )
        )

    latest_line_subq = (
        select(
            SaleOrderLine.order_no,
            SaleOrderLine.line_no,
            func.max(SaleOrderLine.id).label("max_id"),
        )
        .where(*pool_conditions)
        .group_by(SaleOrderLine.order_no, SaleOrderLine.line_no)
        .subquery()
    )
    active_plan_subq = (
        select(
            ProductionSchedulePlan.order_no.label("order_no"),
            ProductionSchedulePlan.line_no.label("line_no"),
        )
        .where(ProductionSchedulePlan.is_active == True)
        .group_by(ProductionSchedulePlan.order_no, ProductionSchedulePlan.line_no)
        .subquery()
    )
    stmt = (
        select(SaleOrderLine, SaleOrder.customer, SaleOrder.risk_level)
        .join(
            latest_line_subq,
            and_(
                SaleOrderLine.order_no == latest_line_subq.c.order_no,
                SaleOrderLine.line_no == latest_line_subq.c.line_no,
                SaleOrderLine.id == latest_line_subq.c.max_id,
            )
        )
        .outerjoin(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)
        .outerjoin(
            active_plan_subq,
            and_(
                SaleOrderLine.order_no == active_plan_subq.c.order_no,
                SaleOrderLine.line_no == active_plan_subq.c.line_no,
            )
        )
        .where(active_plan_subq.c.order_no.is_(None))
        .order_by(SaleOrderLine.promised_date.asc(), SaleOrderLine.order_no.asc(), SaleOrderLine.line_no.asc())
        .limit(limit)
    )
    if risk_level:
        stmt = stmt.where(SaleOrder.risk_level == risk_level)
    return (await db.execute(stmt)).all()


def _resolve_workspace_bucket(bucket_value: Optional[str]) -> Optional[str]:
    normalized = str(bucket_value or "").strip()
    if normalized in {"lean", "assembly", "packaging"}:
        return normalized
    if normalized == "":
        return None
    if normalized == "None":
        return "lean"
    return None


def _resolve_workspace_bucket_hits(bucket_value: Optional[str]) -> list[str]:
    normalized = str(bucket_value or "").strip()
    if normalized in {"", "pending"}:
        return []
    if normalized == "None":
        return ["lean"]
    if normalized == "mixed":
        return ["assembly", "packaging"]
    if normalized in {"lean", "assembly", "packaging"}:
        return [normalized]
    return []


def _is_date_in_range(
    target_date: Optional[date],
    *,
    first_day: date,
    last_day: date,
) -> bool:
    return bool(target_date and first_day <= target_date <= last_day)


def _build_workspace_bucket_filter_condition(column, workspace_bucket: Optional[str]):
    if workspace_bucket == "assembly":
        return column.in_(["assembly", "mixed"])
    if workspace_bucket == "packaging":
        return column.in_(["packaging", "mixed"])
    if workspace_bucket == "lean":
        return or_(column == "lean", column.is_(None))
    if workspace_bucket:
        return column == workspace_bucket
    return None


async def _get_impact_config(db: AsyncSession) -> dict:
    """获取 UPPH 影响等级配置（默认值兜底）"""
    config_codes = [
        "upph_impact_high_ratio",
        "upph_impact_medium_ratio",
        "upph_impact_high_day_delta",
        "upph_impact_medium_day_delta",
        "upph_impact_medium_score",
        "upph_impact_qty_high",
        "upph_impact_qty_medium",
        "upph_impact_qty_bonus_high",
        "upph_impact_qty_bonus_medium",
        "upph_impact_due_days_urgent",
        "upph_impact_due_days_normal",
        "upph_impact_due_days_loose",
        "upph_impact_due_bonus_urgent",
        "upph_impact_due_bonus_normal",
        "upph_impact_due_bonus_loose",
        "upph_impact_day_bonus",
    ]
    result = await db.execute(
        select(NodeStandard)
        .where(NodeStandard.node_code.in_(config_codes), NodeStandard.is_active == True)
    )
    configs = {item.node_code: item for item in result.scalars().all()}
    
    return {
        "high_ratio": float(configs.get("upph_impact_high_ratio").time_value) if configs.get("upph_impact_high_ratio") else 0.3,
        "medium_ratio": float(configs.get("upph_impact_medium_ratio").time_value) if configs.get("upph_impact_medium_ratio") else 0.1,
        "high_day_delta": int(configs.get("upph_impact_high_day_delta").time_value) if configs.get("upph_impact_high_day_delta") else 2,
        "medium_day_delta": int(configs.get("upph_impact_medium_day_delta").time_value) if configs.get("upph_impact_medium_day_delta") else 1,
        "medium_score": float(configs.get("upph_impact_medium_score").time_value) if configs.get("upph_impact_medium_score") else 30,
        "qty_high": float(configs.get("upph_impact_qty_high").time_value) if configs.get("upph_impact_qty_high") else 1000,
        "qty_medium": float(configs.get("upph_impact_qty_medium").time_value) if configs.get("upph_impact_qty_medium") else 500,
        "qty_bonus_high": float(configs.get("upph_impact_qty_bonus_high").time_value) if configs.get("upph_impact_qty_bonus_high") else 15,
        "qty_bonus_medium": float(configs.get("upph_impact_qty_bonus_medium").time_value) if configs.get("upph_impact_qty_bonus_medium") else 8,
        "due_days_urgent": int(configs.get("upph_impact_due_days_urgent").time_value) if configs.get("upph_impact_due_days_urgent") else 3,
        "due_days_normal": int(configs.get("upph_impact_due_days_normal").time_value) if configs.get("upph_impact_due_days_normal") else 7,
        "due_days_loose": int(configs.get("upph_impact_due_days_loose").time_value) if configs.get("upph_impact_due_days_loose") else 14,
        "due_bonus_urgent": float(configs.get("upph_impact_due_bonus_urgent").time_value) if configs.get("upph_impact_due_bonus_urgent") else 20,
        "due_bonus_normal": float(configs.get("upph_impact_due_bonus_normal").time_value) if configs.get("upph_impact_due_bonus_normal") else 10,
        "due_bonus_loose": float(configs.get("upph_impact_due_bonus_loose").time_value) if configs.get("upph_impact_due_bonus_loose") else 5,
        "day_bonus": float(configs.get("upph_impact_day_bonus").time_value) if configs.get("upph_impact_day_bonus") else 6,
    }


def _to_float(value, default: Optional[float] = None) -> Optional[float]:
    if value is None:
        return default
    return float(value)


def _resolve_priority_by_risk(risk_level: Optional[str]) -> str:
    priority_map = {
        "red": "urgent",
        "yellow": "high",
        "blue": "normal",
        "green": "low",
    }
    return priority_map.get(risk_level or "green", "normal")


def _calculate_target_ready_date(promised_date: Optional[date]) -> Optional[date]:
    if not promised_date:
        return None
    return promised_date - timedelta(days=READY_OFFSET_DAYS)


def _is_production_day(target_date: date, include_sunday: bool) -> bool:
    return include_sunday or target_date.weekday() != 6


def _get_previous_production_day(target_date: date, include_sunday: bool) -> date:
    current_date = target_date
    while not _is_production_day(current_date, include_sunday):
        current_date -= timedelta(days=1)
    return current_date


def _get_next_production_day(target_date: date, include_sunday: bool) -> date:
    current_date = target_date
    while not _is_production_day(current_date, include_sunday):
        current_date += timedelta(days=1)
    return current_date


def _shift_production_days(
    anchor_date: date,
    shift_days: int,
    *,
    include_sunday: bool,
    forward: bool,
) -> date:
    current_date = anchor_date
    moved_days = 0
    step = 1 if forward else -1
    while moved_days < shift_days:
        current_date += timedelta(days=step)
        if _is_production_day(current_date, include_sunday):
            moved_days += 1
    return current_date


def _count_production_days(
    start_date: Optional[date],
    end_date: Optional[date],
    *,
    include_sunday: bool,
) -> int:
    if not start_date or not end_date or end_date < start_date:
        return 0
    current_date = start_date
    production_days = 0
    while current_date <= end_date:
        if _is_production_day(current_date, include_sunday):
            production_days += 1
        current_date += timedelta(days=1)
    return production_days


def _build_lean_workhour_plan(
    *,
    quantity: float,
    upph: float,
    promised_date: Optional[date],
) -> dict:
    if not promised_date or not quantity or quantity <= 0 or not upph or upph <= 0:
        return {}

    today = date.today()
    target_ready_date = _calculate_target_ready_date(promised_date)
    total_hours = round(float(quantity) / float(upph), 2)
    available_days_without_sunday = _count_production_days(
        today,
        target_ready_date,
        include_sunday=False,
    )
    available_days_with_sunday = _count_production_days(
        today,
        target_ready_date,
        include_sunday=True,
    )
    required_daily_hours_without_sunday = (
        round(total_hours / available_days_without_sunday, 2)
        if available_days_without_sunday > 0
        else None
    )
    required_daily_hours_with_sunday = (
        round(total_hours / available_days_with_sunday, 2)
        if available_days_with_sunday > 0
        else None
    )

    capacity_load_status = "move_earlier"
    recommended_daily_hours = LEAN_MAX_DAILY_HOURS
    sunday_rest_allowed = False
    needs_sunday_work = True
    needs_move_earlier = True
    move_earlier_days = 0
    available_production_days = available_days_with_sunday
    required_daily_hours = required_daily_hours_with_sunday

    if (
        required_daily_hours_without_sunday is not None
        and required_daily_hours_without_sunday <= LEAN_STANDARD_DAILY_HOURS
    ):
        capacity_load_status = "normal"
        recommended_daily_hours = required_daily_hours_without_sunday
        sunday_rest_allowed = True
        needs_sunday_work = False
        needs_move_earlier = False
        available_production_days = available_days_without_sunday
        required_daily_hours = required_daily_hours_without_sunday
    elif (
        required_daily_hours_without_sunday is not None
        and required_daily_hours_without_sunday <= LEAN_MAX_DAILY_HOURS
    ):
        capacity_load_status = "overtime"
        recommended_daily_hours = required_daily_hours_without_sunday
        sunday_rest_allowed = True
        needs_sunday_work = False
        needs_move_earlier = False
        available_production_days = available_days_without_sunday
        required_daily_hours = required_daily_hours_without_sunday
    elif (
        required_daily_hours_with_sunday is not None
        and required_daily_hours_with_sunday <= LEAN_MAX_DAILY_HOURS
    ):
        capacity_load_status = "sunday_production"
        recommended_daily_hours = required_daily_hours_with_sunday
        sunday_rest_allowed = False
        needs_sunday_work = True
        needs_move_earlier = False
        available_production_days = available_days_with_sunday
        required_daily_hours = required_daily_hours_with_sunday
    else:
        required_days_at_max = max(1, math.ceil(total_hours / LEAN_MAX_DAILY_HOURS))
        move_earlier_days = max(required_days_at_max - max(available_days_with_sunday, 0), 0)
        available_production_days = available_days_with_sunday
        required_daily_hours = round(total_hours / max(available_days_with_sunday, 1), 2) if available_days_with_sunday > 0 else None

    summary_parts = [
        f"建议 {recommended_daily_hours:.2f} 小时/天",
        f"总工时 {total_hours:.2f} 小时",
    ]
    if capacity_load_status == "normal":
        summary_parts.append("周日可休")
    elif capacity_load_status == "overtime":
        summary_parts.append("周日可休，但需加班")
    elif capacity_load_status == "sunday_production":
        summary_parts.append("需启用周日生产")
    else:
        summary_parts.append(f"按 12 小时/天且周日生产仍需前挪 {move_earlier_days} 天")

    return {
        "target_ready_date": target_ready_date,
        "ready_offset_days": READY_OFFSET_DAYS,
        "total_hours": total_hours,
        "available_production_days": available_production_days,
        "required_daily_hours": required_daily_hours,
        "required_daily_hours_without_sunday": required_daily_hours_without_sunday,
        "required_daily_hours_with_sunday": required_daily_hours_with_sunday,
        "recommended_daily_hours": round(recommended_daily_hours, 2),
        "capacity_load_status": capacity_load_status,
        "capacity_load_status_label": LEAN_CAPACITY_LOAD_LABELS[capacity_load_status],
        "sunday_rest_allowed": sunday_rest_allowed,
        "needs_sunday_work": needs_sunday_work,
        "needs_move_earlier": needs_move_earlier,
        "move_earlier_days": move_earlier_days,
        "work_hour_summary": "；".join(summary_parts),
    }


def _calculate_delivery_status(
    end_date: Optional[date],
    target_ready_date: Optional[date],
) -> tuple[Optional[int], str]:
    if not end_date or not target_ready_date:
        return None, "unknown"

    delay_days = (end_date - target_ready_date).days
    if delay_days > 0:
        return delay_days, "delayed"

    ahead_days = (target_ready_date - end_date).days
    if ahead_days >= 2:
        return -ahead_days, "early"

    due_gap = (target_ready_date - date.today()).days
    if 1 <= due_gap <= 3:
        return 0, "upcoming"

    return 0, "normal"


async def _build_promised_date_map(
    db: AsyncSession,
    plans: List[ProductionSchedulePlan],
) -> dict[tuple[str, str], date]:
    missing_keys = {
        (plan.order_no, plan.line_no)
        for plan in plans
        if plan.order_no and plan.line_no and not plan.source_promised_date
    }
    if not missing_keys:
        return {}

    latest_line_subq = (
        select(
            SaleOrderLine.order_no,
            SaleOrderLine.line_no,
            func.max(SaleOrderLine.id).label("max_id"),
        )
        .where(tuple_(SaleOrderLine.order_no, SaleOrderLine.line_no).in_(list(missing_keys)))
        .group_by(SaleOrderLine.order_no, SaleOrderLine.line_no)
        .subquery()
    )
    result = await db.execute(
        select(SaleOrderLine)
        .join(
            latest_line_subq,
            and_(
                SaleOrderLine.order_no == latest_line_subq.c.order_no,
                SaleOrderLine.line_no == latest_line_subq.c.line_no,
                SaleOrderLine.id == latest_line_subq.c.max_id,
            )
        )
    )

    promised_date_map: dict[tuple[str, str], date] = {}
    for row in result.scalars().all():
        key = (row.order_no, row.line_no)
        if row.promised_date:
            promised_date_map[key] = row.promised_date
    return promised_date_map


async def _build_latest_order_line_map_by_keys(
    db: AsyncSession,
    keys: set[tuple[str, str]],
) -> dict[tuple[str, str], SaleOrderLine]:
    if not keys:
        return {}

    latest_line_subq = (
        select(
            SaleOrderLine.order_no,
            SaleOrderLine.line_no,
            func.max(SaleOrderLine.id).label("max_id"),
        )
        .where(tuple_(SaleOrderLine.order_no, SaleOrderLine.line_no).in_(list(keys)))
        .group_by(SaleOrderLine.order_no, SaleOrderLine.line_no)
        .subquery()
    )
    result = await db.execute(
        select(SaleOrderLine)
        .join(
            latest_line_subq,
            and_(
                SaleOrderLine.order_no == latest_line_subq.c.order_no,
                SaleOrderLine.line_no == latest_line_subq.c.line_no,
                SaleOrderLine.id == latest_line_subq.c.max_id,
            )
        )
    )

    order_line_map: dict[tuple[str, str], SaleOrderLine] = {}
    for row in result.scalars().all():
        order_line_map[(row.order_no, row.line_no)] = row
    return order_line_map


async def _build_latest_order_line_map(
    db: AsyncSession,
    plans: List[ProductionSchedulePlan],
) -> dict[tuple[str, str], SaleOrderLine]:
    keys = {
        (plan.order_no, plan.line_no)
        for plan in plans
        if plan.order_no and plan.line_no
    }
    return await _build_latest_order_line_map_by_keys(db, keys)


def _serialize_schedule_plan(
    plan: ProductionSchedulePlan,
    promised_date_map: Optional[dict[tuple[str, str], date]] = None,
    *,
    bom_no: Optional[str] = None,
    snapshot: Optional[ProductionOrderScheduleSnapshot] = None,
    schedule_context: Optional[dict] = None,
    reschedule_payload: Optional[dict[str, object]] = None,
) -> ProductionSchedulePlanOut:
    simulation_service = ScheduleSimulationService(None)
    customer_due_date = plan.source_promised_date or (snapshot.promised_date if snapshot else None)
    if not customer_due_date and promised_date_map and plan.order_no and plan.line_no:
        customer_due_date = promised_date_map.get((plan.order_no, plan.line_no))

    target_ready_date = simulation_service.calculate_target_ready_date(customer_due_date)
    delay_days, delivery_status = simulation_service.calculate_delivery_status(plan.end_date, target_ready_date)
    latest_reschedule_at = plan.created_at if (plan.plan_version or 1) > 1 else None
    lean_workhour_plan = {}
    plan_bucket = plan.source_process_type or (schedule_context.get("schedule_bucket") if schedule_context else None)
    if plan_bucket in {"lean", "assembly", "packaging"}:
        lean_workhour_plan = simulation_service.build_bucket_workhour_plan(
            quantity=float(plan.source_order_qty or plan.quantity or 0),
            upph=float(plan.upph or plan.source_upph or 0),
            promised_date=customer_due_date,
            schedule_bucket=plan_bucket,
        )
        lean_workhour_plan = _apply_saved_lean_daily_hours(lean_workhour_plan, plan)

    payload = ProductionSchedulePlanOut.model_validate(plan)
    schedule_bucket = plan_bucket
    scheduling_state = _resolve_order_scheduling_state(schedule_context, has_schedule=bool(plan.is_active))
    total_hours = lean_workhour_plan.get("total_hours")
    if total_hours is None and plan.quantity and (plan.upph or plan.source_upph):
        total_hours = round(float(plan.quantity) / float(plan.upph or plan.source_upph), 2)
    recommended_daily_hours = lean_workhour_plan.get("recommended_daily_hours")
    if recommended_daily_hours is None and plan.daily_work_hours:
        recommended_daily_hours = float(plan.daily_work_hours)
    return payload.model_copy(update={
        "task_no": _build_schedule_task_no(plan),
        "bom_no": bom_no or (snapshot.bom_no if snapshot else None),
        "schedule_bucket": schedule_bucket,
        "schedule_bucket_label": SCHEDULE_BUCKET_LABELS.get(schedule_bucket),
        "scheduling_reason": scheduling_state["reason"],
        "customer_due_date": customer_due_date,
        "target_ready_date": target_ready_date,
        "ready_offset_days": READY_OFFSET_DAYS,
        "total_hours": total_hours,
        "available_production_days": lean_workhour_plan.get("available_production_days"),
        "required_daily_hours": lean_workhour_plan.get("required_daily_hours"),
        "recommended_daily_hours": recommended_daily_hours,
        "capacity_load_status": lean_workhour_plan.get("capacity_load_status"),
        "capacity_load_status_label": lean_workhour_plan.get("capacity_load_status_label"),
        "sunday_rest_allowed": lean_workhour_plan.get("sunday_rest_allowed"),
        "needs_sunday_work": lean_workhour_plan.get("needs_sunday_work"),
        "needs_move_earlier": lean_workhour_plan.get("needs_move_earlier"),
        "move_earlier_days": lean_workhour_plan.get("move_earlier_days"),
        "work_hour_summary": lean_workhour_plan.get("work_hour_summary") or plan.remark,
        "delay_days": delay_days,
        "delivery_status": delivery_status,
        "latest_reschedule_at": latest_reschedule_at,
        "needs_reschedule": bool((reschedule_payload or {}).get("needs_reschedule", plan.needs_reschedule)),
        "reschedule_reason": (reschedule_payload or {}).get("reschedule_reason") or plan.reschedule_reason,
    })


def _build_schedule_task_no(plan: ProductionSchedulePlan) -> Optional[str]:
    if not getattr(plan, "id", None):
        return None
    reference_date = getattr(plan, "created_at", None) or getattr(plan, "plan_date", None)
    date_part = reference_date.strftime("%Y%m%d") if reference_date else "00000000"
    version_part = int(getattr(plan, "plan_version", 1) or 1)
    return f"SC{date_part}-{int(plan.id):06d}-V{version_part}"


async def _find_active_plan_conflicts(
    db: AsyncSession,
    *,
    department: str,
    schedule_bucket: Optional[str],
    start_date: Optional[date],
    end_date: Optional[date],
    exclude_plan_ids: Optional[list[int]] = None,
) -> list[ProductionSchedulePlan]:
    if not start_date or not end_date or not schedule_bucket:
        return []

    conditions = [
        ProductionSchedulePlan.department == department,
        ProductionSchedulePlan.is_active == True,
        ProductionSchedulePlan.status == "planned",
        ProductionSchedulePlan.start_date <= end_date,
        ProductionSchedulePlan.end_date >= start_date,
    ]
    if exclude_plan_ids:
        conditions.append(ProductionSchedulePlan.id.notin_(exclude_plan_ids))

    if schedule_bucket == "lean":
        # 兼容老数据未回填 source_process_type 的情况，先按空值一并纳入冲突判断。
        conditions.append(
            or_(
                ProductionSchedulePlan.source_process_type == "lean",
                ProductionSchedulePlan.source_process_type.is_(None),
            )
        )
    else:
        conditions.append(ProductionSchedulePlan.source_process_type == schedule_bucket)

    result = await db.execute(
        select(ProductionSchedulePlan)
        .where(*conditions)
        .order_by(ProductionSchedulePlan.start_date.asc(), ProductionSchedulePlan.id.asc())
    )
    return result.scalars().all()


def _get_capacity_limit_by_status(status_key: Optional[str]) -> float:
    return float(LEAN_STANDARD_DAILY_HOURS if status_key == "normal" else LEAN_MAX_DAILY_HOURS)


def _plan_window_start(plan: ProductionSchedulePlan) -> Optional[date]:
    return plan.start_date or plan.plan_date


def _plan_window_end(plan: ProductionSchedulePlan) -> Optional[date]:
    return plan.end_date or plan.plan_date


def _plan_uses_sunday(plan: ProductionSchedulePlan) -> bool:
    remark = str(plan.remark or "")
    return "周日生产" in remark or "启用周日" in remark


def _iter_production_dates(
    start_date: Optional[date],
    end_date: Optional[date],
    *,
    include_sunday: bool,
) -> list[date]:
    if not start_date or not end_date or end_date < start_date:
        return []
    items: list[date] = []
    current = start_date
    while current <= end_date:
        if current.weekday() != 6 or include_sunday:
            items.append(current)
        current += timedelta(days=1)
    return items


def _build_plan_daily_load_map(
    plans: list[ProductionSchedulePlan],
    *,
    range_start: Optional[date],
    range_end: Optional[date],
) -> dict[date, float]:
    if not range_start or not range_end or range_end < range_start:
        return {}

    daily_loads: dict[date, float] = defaultdict(float)
    for plan in plans:
        plan_start = _plan_window_start(plan)
        plan_end = _plan_window_end(plan)
        if not plan_start or not plan_end:
            continue
        overlap_start = max(plan_start, range_start)
        overlap_end = min(plan_end, range_end)
        if overlap_end < overlap_start:
            continue
        plan_daily_hours = float(plan.daily_work_hours or 0)
        if plan_daily_hours <= 0:
            continue
        for production_day in _iter_production_dates(
            overlap_start,
            overlap_end,
            include_sunday=_plan_uses_sunday(plan),
        ):
            daily_loads[production_day] += plan_daily_hours
    return dict(daily_loads)


async def _resolve_conflict_free_window(
    db: AsyncSession,
    *,
    department: str,
    schedule_bucket: Optional[str],
    start_date: Optional[date],
    end_date: Optional[date],
    days_needed: int,
    include_sunday: bool,
    daily_work_hours: Optional[float] = None,
    max_daily_capacity: Optional[float] = None,
    exclude_plan_ids: Optional[list[int]] = None,
) -> tuple[Optional[date], Optional[date], list[ProductionSchedulePlan]]:
    if not start_date or not end_date or not schedule_bucket:
        return start_date, end_date, []

    simulation_service = ScheduleSimulationService(db)
    adjusted_start = start_date
    adjusted_end = end_date
    touched_conflicts: dict[int, ProductionSchedulePlan] = {}

    for _ in range(180):
        conflicts = await _find_active_plan_conflicts(
            db,
            department=department,
            schedule_bucket=schedule_bucket,
            start_date=adjusted_start,
            end_date=adjusted_end,
            exclude_plan_ids=exclude_plan_ids,
        )
        if not conflicts:
            return adjusted_start, adjusted_end, list(touched_conflicts.values())

        if daily_work_hours and max_daily_capacity:
            candidate_days = _iter_production_dates(
                adjusted_start,
                adjusted_end,
                include_sunday=include_sunday,
            )
            daily_loads = _build_plan_daily_load_map(
                conflicts,
                range_start=adjusted_start,
                range_end=adjusted_end,
            )
            blocked_days = [
                production_day
                for production_day in candidate_days
                if daily_loads.get(production_day, 0) + float(daily_work_hours) > float(max_daily_capacity) + 0.01
            ]
            if not blocked_days:
                return adjusted_start, adjusted_end, list(touched_conflicts.values())

            for item in conflicts:
                touched_conflicts[item.id] = item
            earliest_conflict_start = min(blocked_days)
        else:
            for item in conflicts:
                touched_conflicts[item.id] = item

            earliest_conflict_start = min(
                (_plan_window_start(item) or adjusted_start)
                for item in conflicts
            )
        adjusted_end = simulation_service.get_previous_production_day(
            earliest_conflict_start - timedelta(days=1),
            include_sunday,
        )
        adjusted_start = simulation_service.shift_production_days(
            adjusted_end,
            max(days_needed - 1, 0),
            include_sunday=include_sunday,
            forward=False,
        )

    bucket_label = SCHEDULE_BUCKET_LABELS.get(schedule_bucket, "当前排产段")
    raise HTTPException(status_code=400, detail=f"{bucket_label}存在循环冲突，请先调整已排计划后再重试")


async def _resolve_conflict_aware_nonlean_plan(
    db: AsyncSession,
    *,
    department: str,
    schedule_bucket: str,
    calculation_result: dict,
    include_sunday: bool,
    exclude_plan_ids: Optional[list[int]] = None,
) -> dict:
    original_start_date = calculation_result.get("start_date")
    original_end_date = calculation_result.get("end_date")
    capacity_status = str(calculation_result.get("capacity_load_status") or "normal")
    adjusted_start_date, adjusted_end_date, conflict_plans = await _resolve_conflict_free_window(
        db,
        department=department,
        schedule_bucket=schedule_bucket,
        start_date=original_start_date,
        end_date=original_end_date,
        days_needed=int(calculation_result.get("days_needed") or 0),
        include_sunday=include_sunday,
        daily_work_hours=float(calculation_result.get("recommended_daily_hours") or 0),
        max_daily_capacity=_get_capacity_limit_by_status(capacity_status),
        exclude_plan_ids=exclude_plan_ids,
    )
    updated = dict(calculation_result)
    updated["start_date"] = adjusted_start_date
    updated["end_date"] = adjusted_end_date
    conflict_warning = _build_capacity_conflict_warning(
        original_start=original_start_date,
        original_end=original_end_date,
        adjusted_start=adjusted_start_date,
        adjusted_end=adjusted_end_date,
        conflicts=conflict_plans,
    )
    if conflict_warning:
        updated["warning"] = (
            f"{updated['warning']} {conflict_warning}".strip()
            if updated.get("warning")
            else conflict_warning
        )
    return updated


async def _resolve_conflict_aware_mixed_plan(
    db: AsyncSession,
    *,
    department: str,
    mixed_result: dict,
    exclude_plan_ids: Optional[list[int]] = None,
) -> dict:
    assembly_plan = mixed_result["assembly_plan"]
    packaging_plan = mixed_result["packaging_plan"]
    simulation_service = ScheduleSimulationService(db)
    assembly_start = assembly_plan.start_date
    assembly_end = assembly_plan.end_date
    packaging_start = packaging_plan.start_date
    packaging_end = packaging_plan.end_date
    assembly_include_sunday = bool(assembly_plan.needs_sunday_work)
    packaging_include_sunday = bool(packaging_plan.needs_sunday_work)
    assembly_capacity_limit = _get_capacity_limit_by_status(assembly_plan.capacity_load_status)
    packaging_capacity_limit = _get_capacity_limit_by_status(packaging_plan.capacity_load_status)
    touched_conflicts: dict[int, ProductionSchedulePlan] = {}
    original_windows = {
        "assembly_start": assembly_start,
        "assembly_end": assembly_end,
        "packaging_start": packaging_start,
        "packaging_end": packaging_end,
    }

    for _ in range(180):
        assembly_conflicts = await _find_active_plan_conflicts(
            db,
            department=department,
            schedule_bucket="assembly",
            start_date=assembly_start,
            end_date=assembly_end,
            exclude_plan_ids=exclude_plan_ids,
        )
        packaging_conflicts = await _find_active_plan_conflicts(
            db,
            department=department,
            schedule_bucket="packaging",
            start_date=packaging_start,
            end_date=packaging_end,
            exclude_plan_ids=exclude_plan_ids,
        )
        all_conflicts = [*assembly_conflicts, *packaging_conflicts]
        if not all_conflicts:
            break
        assembly_daily_loads = _build_plan_daily_load_map(
            assembly_conflicts,
            range_start=assembly_start,
            range_end=assembly_end,
        )
        packaging_daily_loads = _build_plan_daily_load_map(
            packaging_conflicts,
            range_start=packaging_start,
            range_end=packaging_end,
        )
        assembly_blocked_days = [
            production_day
            for production_day in _iter_production_dates(
                assembly_start,
                assembly_end,
                include_sunday=assembly_include_sunday,
            )
            if assembly_daily_loads.get(production_day, 0) + float(assembly_plan.daily_work_hours or 0)
            > float(assembly_capacity_limit) + 0.01
        ]
        packaging_blocked_days = [
            production_day
            for production_day in _iter_production_dates(
                packaging_start,
                packaging_end,
                include_sunday=packaging_include_sunday,
            )
            if packaging_daily_loads.get(production_day, 0) + float(packaging_plan.daily_work_hours or 0)
            > float(packaging_capacity_limit) + 0.01
        ]
        if not assembly_blocked_days and not packaging_blocked_days:
            break

        for item in all_conflicts:
            touched_conflicts[item.id] = item

        earliest_conflict_start = min([*assembly_blocked_days, *packaging_blocked_days])
        adjusted_packaging_end = simulation_service.get_previous_production_day(
            earliest_conflict_start - timedelta(days=1),
            packaging_include_sunday,
        )
        delta_days = max((packaging_end - adjusted_packaging_end).days, 1)
        assembly_start = assembly_start - timedelta(days=delta_days)
        assembly_end = assembly_end - timedelta(days=delta_days)
        packaging_start = packaging_start - timedelta(days=delta_days)
        packaging_end = packaging_end - timedelta(days=delta_days)
    else:
        raise HTTPException(status_code=400, detail="组装/包装计划存在循环冲突，请先调整已排计划后再重试")

    updated = dict(mixed_result)
    updated["assembly_plan"] = dataclasses.replace(
        assembly_plan,
        start_date=assembly_start,
        end_date=assembly_end,
        plan_date=assembly_start,
    )
    updated["packaging_plan"] = dataclasses.replace(
        packaging_plan,
        start_date=packaging_start,
        end_date=packaging_end,
        plan_date=packaging_start,
    )
    updated["assembly_start_date"] = assembly_start
    updated["assembly_end_date"] = assembly_end
    updated["packaging_start_date"] = packaging_start
    updated["packaging_end_date"] = packaging_end

    assembly_warning = _build_capacity_conflict_warning(
        original_start=original_windows["assembly_start"],
        original_end=original_windows["assembly_end"],
        adjusted_start=assembly_start,
        adjusted_end=assembly_end,
        conflicts=[item for item in touched_conflicts.values() if (item.source_process_type or "lean") == "assembly"],
    )
    packaging_warning = _build_capacity_conflict_warning(
        original_start=original_windows["packaging_start"],
        original_end=original_windows["packaging_end"],
        adjusted_start=packaging_start,
        adjusted_end=packaging_end,
        conflicts=[item for item in touched_conflicts.values() if (item.source_process_type or "lean") == "packaging"],
    )
    warning_parts = [
        part for part in [updated.get("warning"), assembly_warning, packaging_warning] if part
    ]
    if warning_parts:
        updated["warning"] = " ".join(warning_parts)
    return updated


def _build_capacity_conflict_warning(
    *,
    original_start: Optional[date],
    original_end: Optional[date],
    adjusted_start: Optional[date],
    adjusted_end: Optional[date],
    conflicts: list[ProductionSchedulePlan],
) -> str:
    if not original_start or not original_end or not adjusted_start or not adjusted_end:
        return ""
    if original_start == adjusted_start and original_end == adjusted_end:
        return ""

    related_orders = []
    for item in conflicts[:3]:
        if item.order_no and item.line_no:
            related_orders.append(f"{item.order_no}/{item.line_no}")
        elif item.order_no:
            related_orders.append(item.order_no)
    conflict_text = f"，冲突单据：{'、'.join(related_orders)}" if related_orders else ""
    return (
        f"【产能避让】原计划窗口({original_start}~{original_end})与已排计划重叠，"
        f"已自动前移为({adjusted_start}~{adjusted_end}){conflict_text}。"
    )


def _apply_lean_candidate_to_result(
    calculation_result: dict,
    candidate_plan: dict,
    *,
    adjusted_start: Optional[date],
    adjusted_end: Optional[date],
    warning: str = "",
) -> dict:
    updated = dict(calculation_result)
    updated["days_needed"] = int(candidate_plan.get("days_needed") or updated.get("days_needed") or 0)
    updated["start_date"] = adjusted_start or candidate_plan.get("suggested_start_date")
    updated["end_date"] = adjusted_end or candidate_plan.get("suggested_end_date")
    updated["recommended_daily_hours"] = round(float(candidate_plan.get("recommended_daily_hours") or 0), 2)
    updated["needs_sunday_work"] = bool(candidate_plan.get("needs_sunday_work"))
    updated["needs_move_earlier"] = bool(candidate_plan.get("needs_move_earlier"))
    updated["capacity_load_status"] = candidate_plan.get("capacity_load_status")
    updated["capacity_load_status_label"] = candidate_plan.get("capacity_load_status_label")
    updated["move_earlier_days"] = candidate_plan.get("move_earlier_days")
    updated["work_hour_summary"] = candidate_plan.get("work_hour_summary")
    updated["warning"] = warning
    return updated


def _apply_saved_lean_daily_hours(lean_workhour_plan: dict, plan: ProductionSchedulePlan) -> dict:
    if not lean_workhour_plan or not plan.daily_work_hours:
        return lean_workhour_plan

    actual_daily_hours = round(float(plan.daily_work_hours), 2)
    updated = dict(lean_workhour_plan)
    updated["recommended_daily_hours"] = actual_daily_hours

    if updated.get("needs_move_earlier"):
        updated["capacity_load_status"] = "move_earlier"
    elif "周日生产" in str(plan.remark or ""):
        updated["capacity_load_status"] = "sunday_production"
        updated["needs_sunday_work"] = True
        updated["sunday_rest_allowed"] = False
    elif actual_daily_hours > LEAN_STANDARD_DAILY_HOURS + 0.01:
        updated["capacity_load_status"] = "overtime"
    else:
        updated["capacity_load_status"] = "normal"

    status_key = updated.get("capacity_load_status") or "normal"
    updated["capacity_load_status_label"] = LEAN_CAPACITY_LOAD_LABELS[status_key]
    summary_parts = [
        f"建议 {actual_daily_hours:.2f} 小时/天",
        f"总工时 {float(updated.get('total_hours') or 0):.2f} 小时",
    ]
    if status_key == "normal":
        summary_parts.append("周日可休")
    elif status_key == "overtime":
        summary_parts.append("周日可休，但需加班")
    elif status_key == "sunday_production":
        summary_parts.append("需启用周日生产")
    else:
        summary_parts.append(f"按 12 小时/天且周日生产仍需前挪 {updated.get('move_earlier_days') or 0} 天")
    updated["work_hour_summary"] = "；".join(summary_parts)
    return updated


def _build_simulation_explanation_steps(
    *,
    quantity: float,
    upph: float,
    promised_date: date,
    calculation_result: dict,
    consider_existing_plans: bool,
) -> list[str]:
    target_ready_date = calculation_result.get("target_ready_date")
    recommended_daily_hours = float(calculation_result.get("recommended_daily_hours") or 0)
    steps = [
        f"客户交期为 {promised_date}，系统先按交期前 {READY_OFFSET_DAYS} 天倒推出备货目标日 {target_ready_date}。",
        f"数量 {quantity:.2f}，UPPH {upph:.2f}，总工时约 {float(calculation_result.get('total_hours') or 0):.2f} 小时。",
    ]
    status_label = calculation_result.get("capacity_load_status_label") or "正常"
    if calculation_result.get("capacity_load_status") == "normal":
        steps.append(f"按正常班试算后可完成，建议 {recommended_daily_hours:.2f} 小时/天。")
    elif calculation_result.get("capacity_load_status") == "overtime":
        steps.append(f"按 8.5 小时/天排不进目标窗口，已切到加班档，建议 {recommended_daily_hours:.2f} 小时/天。")
    elif calculation_result.get("capacity_load_status") == "sunday_production":
        steps.append(f"按工作日排不进目标窗口，已启用周日生产，建议 {recommended_daily_hours:.2f} 小时/天。")
    else:
        steps.append(
            f"即使按 12 小时/天{'并启用周日' if calculation_result.get('needs_sunday_work') else ''}仍不足，"
            f"因此需要整体前推 {calculation_result.get('move_earlier_days') or 0} 天。"
        )
    if consider_existing_plans:
        if calculation_result.get("warning"):
            steps.append(f"同时叠加当前已排精益计划做冲突避让：{calculation_result['warning']}")
        else:
            steps.append("本次已叠加当前精益已排计划做冲突检查，未发现需要避让的窗口冲突。")
    steps.append(
        f"最终计划窗口为 {calculation_result.get('start_date')} 至 {calculation_result.get('end_date')}，"
        f"计划日取开始日 {calculation_result.get('start_date')}，当前状态为 {status_label}。"
    )
    return steps


async def _resolve_conflict_aware_lean_plan(
    db: AsyncSession,
    *,
    department: str,
    calculation_result: dict,
    lean_workhour_plan: dict,
    exclude_plan_ids: Optional[list[int]] = None,
) -> tuple[dict, dict]:
    if not lean_workhour_plan:
        return calculation_result, lean_workhour_plan

    candidate_plans = lean_workhour_plan.get("candidate_plans") or {}
    candidate_order = ["normal", "overtime", "sunday_production"]
    evaluated_candidates: list[tuple[int, dict, Optional[date], Optional[date], list[ProductionSchedulePlan]]] = []

    for index, candidate_key in enumerate(candidate_order):
        candidate_plan = candidate_plans.get(candidate_key)
        if not candidate_plan or not candidate_plan.get("feasible"):
            continue

        adjusted_start, adjusted_end, conflicts = await _resolve_conflict_free_window(
            db,
            department=department,
            schedule_bucket="lean",
            start_date=candidate_plan.get("suggested_start_date"),
            end_date=candidate_plan.get("suggested_end_date"),
            days_needed=int(candidate_plan.get("days_needed") or 0),
            include_sunday=bool(candidate_plan.get("needs_sunday_work")),
            daily_work_hours=float(candidate_plan.get("recommended_daily_hours") or 0),
            max_daily_capacity=_get_capacity_limit_by_status(candidate_plan.get("capacity_load_status")),
            exclude_plan_ids=exclude_plan_ids,
        )
        evaluated_candidates.append((index, candidate_plan, adjusted_start, adjusted_end, conflicts))

        if (
            adjusted_start == candidate_plan.get("suggested_start_date")
            and adjusted_end == candidate_plan.get("suggested_end_date")
        ):
            return (
                _apply_lean_candidate_to_result(
                    calculation_result,
                    candidate_plan,
                    adjusted_start=adjusted_start,
                    adjusted_end=adjusted_end,
                ),
                {**lean_workhour_plan, **candidate_plan},
            )

    if not evaluated_candidates:
        return calculation_result, lean_workhour_plan

    _, candidate_plan, adjusted_start, adjusted_end, conflicts = max(
        evaluated_candidates,
        key=lambda item: (
            (item[2] or date.min).toordinal(),
            -item[0],
        ),
    )
    conflict_warning = _build_capacity_conflict_warning(
        original_start=candidate_plan.get("suggested_start_date"),
        original_end=candidate_plan.get("suggested_end_date"),
        adjusted_start=adjusted_start,
        adjusted_end=adjusted_end,
        conflicts=conflicts,
    )
    return (
        _apply_lean_candidate_to_result(
            calculation_result,
            candidate_plan,
            adjusted_start=adjusted_start,
            adjusted_end=adjusted_end,
            warning=conflict_warning,
        ),
        {**lean_workhour_plan, **candidate_plan},
    )


def _calculate_schedule_result(
    quantity: float,
    upph: float,
    daily_hours: float,
    promised_date: date,
    schedule_bucket: Optional[str] = None,
    lean_workhour_plan: Optional[dict] = None,
) -> dict:
    total_hours = float(quantity) / float(upph)
    days_needed = max(1, math.ceil(total_hours / float(daily_hours)))

    target_ready_date = _calculate_target_ready_date(promised_date)
    today = date.today()
    include_sunday = True
    if schedule_bucket == "lean":
        include_sunday = bool(lean_workhour_plan and lean_workhour_plan.get("needs_sunday_work"))
        end_date = _get_previous_production_day(target_ready_date, include_sunday)
        start_date = _shift_production_days(
            end_date,
            days_needed - 1,
            include_sunday=include_sunday,
            forward=False,
        )
    else:
        end_date = target_ready_date
        start_date = end_date - timedelta(days=days_needed - 1)

    warning = ""
    actual_today_start = _get_next_production_day(today, include_sunday) if schedule_bucket == "lean" else today
    if start_date < actual_today_start:
        start_date = actual_today_start
        if schedule_bucket == "lean":
            end_date = _shift_production_days(
                start_date,
                days_needed - 1,
                include_sunday=include_sunday,
                forward=True,
            )
        else:
            end_date = start_date + timedelta(days=days_needed - 1)

        if schedule_bucket == "lean" and lean_workhour_plan and lean_workhour_plan.get("needs_move_earlier"):
            warning = (
                f"【前挪预警】按精益最高 {LEAN_MAX_DAILY_HOURS} 小时/天"
                f"{'且启用周日生产' if include_sunday else ''} 仍需整体前挪 "
                f"{lean_workhour_plan.get('move_earlier_days') or 0} 天；"
                f"当前若从 {start_date} 开始，预计备货完成日为 {end_date}。"
            )
        else:
            warning = (
                f"【延期预警】按产能顺推，预计备货完成日({end_date})"
                f"晚于备货目标日({target_ready_date})，客户交期({promised_date})！"
            )

    return {
        "total_hours": round(total_hours, 2),
        "days_needed": days_needed,
        "start_date": start_date,
        "end_date": end_date,
        "target_ready_date": target_ready_date,
        "ready_offset_days": READY_OFFSET_DAYS,
        "recommended_daily_hours": round(float(daily_hours), 2),
        "needs_sunday_work": bool(lean_workhour_plan and lean_workhour_plan.get("needs_sunday_work")),
        "needs_move_earlier": bool(lean_workhour_plan and lean_workhour_plan.get("needs_move_earlier")),
        "capacity_load_status": lean_workhour_plan.get("capacity_load_status") if lean_workhour_plan else None,
        "capacity_load_status_label": lean_workhour_plan.get("capacity_load_status_label") if lean_workhour_plan else None,
        "move_earlier_days": lean_workhour_plan.get("move_earlier_days") if lean_workhour_plan else None,
        "work_hour_summary": lean_workhour_plan.get("work_hour_summary") if lean_workhour_plan else None,
        "warning": warning,
    }


async def _get_latest_sale_order_line(
    db: AsyncSession,
    order_no: Optional[str],
    line_no: Optional[str],
):
    result = await db.execute(
        select(SaleOrderLine, SaleOrder.risk_level)
        .outerjoin(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)
        .where(and_(
            SaleOrderLine.order_no == order_no,
            SaleOrderLine.line_no == line_no,
        ))
        .order_by(SaleOrderLine.id.desc())
        .limit(1)
    )
    return result.first()


async def _get_work_hours_config(db: AsyncSession) -> dict:
    config_codes = ["daily_work_hours", *SCHEDULE_BUCKET_WORK_HOUR_CODES.values()]
    config_result = await db.execute(
        select(NodeStandard).where(
            NodeStandard.node_code.in_(config_codes),
            NodeStandard.is_active == True,
        )
    )
    config_map = {item.node_code: item for item in config_result.scalars().all()}
    default_item = config_map.get("daily_work_hours")
    default_daily_work_hours = float(default_item.time_value) if default_item else 8
    work_hours_by_bucket = {
        bucket: (
            float(config_map[config_code].time_value)
            if config_map.get(config_code)
            else default_daily_work_hours
        )
        for bucket, config_code in SCHEDULE_BUCKET_WORK_HOUR_CODES.items()
    }
    return {
        "default_daily_work_hours": default_daily_work_hours,
        "work_hours_by_bucket": work_hours_by_bucket,
        "lean_standard_daily_hours": LEAN_STANDARD_DAILY_HOURS,
        "lean_max_daily_hours": LEAN_MAX_DAILY_HOURS,
    }


async def _get_default_daily_work_hours(db: AsyncSession, schedule_bucket: Optional[str] = None) -> float:
    work_hours_config = await _get_work_hours_config(db)
    if schedule_bucket:
        return float(
            work_hours_config["work_hours_by_bucket"].get(
                schedule_bucket,
                work_hours_config["default_daily_work_hours"],
            )
        )
    return float(work_hours_config["default_daily_work_hours"])


async def _build_split_rules_map(db: AsyncSession, bom_codes: list[Optional[str]]) -> dict[str, dict]:
    normalized_bom_codes = [str(item).strip() for item in bom_codes if item and str(item).strip()]
    if not normalized_bom_codes:
        return {}
    return await AssemblyRollScheduleService(db).get_stage_rules_bulk(normalized_bom_codes)


async def _get_existing_active_plan(
    db: AsyncSession,
    *,
    order_no: str,
    line_no: str,
    schedule_bucket: Optional[str],
) -> Optional[ProductionSchedulePlan]:
    conditions = [
        ProductionSchedulePlan.order_no == order_no,
        ProductionSchedulePlan.line_no == line_no,
        ProductionSchedulePlan.is_active == True,
    ]
    bucket_condition = _build_workspace_bucket_filter_condition(
        ProductionSchedulePlan.source_process_type,
        schedule_bucket,
    )
    if bucket_condition is not None:
        conditions.append(bucket_condition)

    result = await db.execute(
        select(ProductionSchedulePlan)
        .where(*conditions)
        .order_by(ProductionSchedulePlan.plan_version.desc(), ProductionSchedulePlan.id.desc())
    )
    return result.scalars().first()


def _build_schedule_response_calculation(
    *,
    schedule_bucket: Optional[str],
    order_line,
    resolved_upph: float,
    resolved_daily_hours: float,
    calculation_result: dict,
    lean_workhour_plan: Optional[dict] = None,
) -> dict:
    lean_workhour_plan = lean_workhour_plan or {}
    return {
        "total_hours": calculation_result.get("total_hours"),
        "days_needed": calculation_result.get("days_needed"),
        "upph": float(resolved_upph),
        "daily_work_hours": float(resolved_daily_hours),
        "customer_due_date": order_line.promised_date,
        "target_ready_date": calculation_result.get("target_ready_date"),
        "ready_offset_days": calculation_result.get("ready_offset_days", READY_OFFSET_DAYS),
        "schedule_bucket": schedule_bucket,
        "schedule_bucket_label": SCHEDULE_BUCKET_LABELS.get(schedule_bucket),
        "available_production_days": lean_workhour_plan.get("available_production_days"),
        "required_daily_hours": lean_workhour_plan.get("required_daily_hours"),
        "recommended_daily_hours": calculation_result.get("recommended_daily_hours"),
        "capacity_load_status": calculation_result.get("capacity_load_status"),
        "capacity_load_status_label": calculation_result.get("capacity_load_status_label"),
        "sunday_rest_allowed": lean_workhour_plan.get("sunday_rest_allowed"),
        "needs_sunday_work": calculation_result.get("needs_sunday_work"),
        "needs_move_earlier": calculation_result.get("needs_move_earlier"),
        "move_earlier_days": calculation_result.get("move_earlier_days"),
        "work_hour_summary": calculation_result.get("work_hour_summary"),
        "assembly_start_date": calculation_result.get("assembly_start_date"),
        "assembly_end_date": calculation_result.get("assembly_end_date"),
        "packaging_start_date": calculation_result.get("packaging_start_date"),
        "packaging_end_date": calculation_result.get("packaging_end_date"),
    }


async def _resolve_current_upph_for_bucket(
    db: AsyncSession,
    *,
    schedule_bucket: Optional[str],
    schedule_context: Optional[dict],
    product_code: Optional[str],
    bom_code: Optional[str],
) -> float:
    stage_rules = (schedule_context or {}).get("stage_rules") or {}
    if schedule_bucket in {"assembly", "packaging"}:
        stage_upph = float(stage_rules.get(schedule_bucket, {}).get("upph") or 0)
        if stage_upph > 0:
            return stage_upph
    if schedule_bucket == "mixed":
        assembly_upph = float(stage_rules.get("assembly", {}).get("upph") or 0)
        packaging_upph = float(stage_rules.get("packaging", {}).get("upph") or 0)
        if assembly_upph > 0 and packaging_upph > 0:
            return round(assembly_upph + packaging_upph, 2)
    upph_service = UpphCalculationService(db)
    current_upph, _ = await upph_service.calculate_total_upph(product_code=product_code, bom_code=bom_code)
    return float(current_upph or 0)


async def _save_schedule_plan_record(
    db: AsyncSession,
    *,
    department: str,
    order_line,
    risk_level: Optional[str],
    operator: str,
    owner: Optional[str],
    schedule_bucket: str,
    resolved_upph: float,
    resolved_daily_hours: float,
    calculation_result: dict,
    existing_plan: Optional[ProductionSchedulePlan],
    operation_remark: Optional[str],
) -> ProductionSchedulePlan:
    priority = _resolve_priority_by_risk(risk_level)
    plan_version = 1
    previous_plan_id = None
    if existing_plan:
        plan_version = existing_plan.plan_version + 1
        previous_plan_id = existing_plan.id
        existing_plan.is_active = False
        db.add(existing_plan)

    schedule_data = ProductionSchedulePlanCreate(
        department=department,
        plan_date=calculation_result["plan_date"],
        order_no=order_line.order_no,
        line_no=order_line.line_no,
        product_code=order_line.product_code,
        model_code=order_line.product_model,
        quantity=float(order_line.order_qty),
        start_date=calculation_result["start_date"],
        end_date=calculation_result["end_date"],
        priority=priority,
        status="planned",
        upph=resolved_upph,
        daily_work_hours=resolved_daily_hours,
        owner=owner,
        remark=calculation_result.get("warning") or None,
        plan_version=plan_version,
        is_active=True,
        source_promised_date=order_line.promised_date,
        source_order_qty=float(order_line.order_qty),
        source_product_code=order_line.product_code,
        source_product_model=order_line.product_model,
        source_upph=resolved_upph,
        source_process_type=schedule_bucket,
        previous_plan_id=previous_plan_id,
    )
    record = ProductionSchedulePlan(**schedule_data.model_dump(), created_by=operator)
    db.add(record)
    await db.flush()
    await log_audit(db, "production_schedule_plan", record.id, "create", operator=operator)
    await _log_schedule_operation(
        db,
        "create",
        operator,
        plan_id=record.id,
        plan_version=plan_version,
        order_no=record.order_no,
        line_no=record.line_no,
        previous_version_id=previous_plan_id,
        remark=operation_remark or calculation_result.get("warning") or "自动排产创建",
    )
    return record


async def _create_schedule_plan_from_request(
    db: AsyncSession,
    *,
    order_no: str,
    line_no: str,
    department: str,
    plan_date: Optional[date],
    upph: Optional[float],
    daily_work_hours: Optional[float],
    owner: Optional[str],
    operator: str,
    fail_if_scheduled: bool = False,
    operation_remark: Optional[str] = None,
) -> tuple[list[ProductionSchedulePlan], dict, str]:
    simulation_service = ScheduleSimulationService(db)
    row = await _get_latest_sale_order_line(db, order_no, line_no)
    if not row:
        raise HTTPException(status_code=404, detail="订单行不存在")

    order_line = row.SaleOrderLine
    risk_level = row.risk_level

    if not order_line.promised_date:
        raise HTTPException(status_code=400, detail="订单行没有交期")

    if not order_line.order_qty or order_line.order_qty <= 0:
        raise HTTPException(status_code=400, detail="订单行数量无效")

    bom_code = _get_order_line_bom_code(order_line)
    schedule_bucket = None
    lean_workhour_plan = {}
    upph_service = UpphCalculationService(db)
    split_service = AssemblyRollScheduleService(db)
    schedule_context = None
    if order_line.product_code or bom_code:
        schedule_context = await upph_service.summarize_schedule_context(
            product_code=order_line.product_code,
            bom_code=bom_code,
        )
        schedule_bucket = schedule_context.get("schedule_bucket")

    if schedule_bucket == "lean":
        resolved_upph = upph
        if resolved_upph is None and (order_line.product_code or bom_code):
            resolved_upph, _ = await upph_service.calculate_total_upph(
                product_code=order_line.product_code,
                bom_code=bom_code,
            )
        if resolved_upph is None or resolved_upph <= 0:
            raise HTTPException(status_code=400, detail="缺少UPPH数据，请在订单或产品中配置，或手动指定")

        lean_workhour_plan = simulation_service.build_bucket_workhour_plan(
            quantity=float(order_line.order_qty),
            upph=float(resolved_upph),
            promised_date=order_line.promised_date,
            schedule_bucket=schedule_bucket,
        )
        resolved_daily_hours = await simulation_service.resolve_daily_work_hours(
            schedule_bucket=schedule_bucket,
            daily_work_hours=daily_work_hours,
            lean_workhour_plan=lean_workhour_plan,
        )
        if resolved_daily_hours <= 0:
            raise HTTPException(status_code=400, detail="每日工作时间必须大于0")
        existing_plan = await _get_existing_active_plan(
            db,
            order_no=order_no,
            line_no=line_no,
            schedule_bucket="lean",
        )
        if existing_plan and fail_if_scheduled:
            raise HTTPException(status_code=400, detail="该订单已存在有效排产计划，请先刷新列表")
        calculation_result = simulation_service.calculate_schedule_result(
            quantity=float(order_line.order_qty),
            upph=float(resolved_upph),
            daily_hours=float(resolved_daily_hours),
            promised_date=order_line.promised_date,
            schedule_bucket=schedule_bucket,
            lean_workhour_plan=lean_workhour_plan,
        )
        calculation_result, lean_workhour_plan = await _resolve_conflict_aware_lean_plan(
            db,
            department=department,
            calculation_result=calculation_result,
            lean_workhour_plan=lean_workhour_plan,
            exclude_plan_ids=[existing_plan.id] if existing_plan else None,
        )
        if calculation_result.get("recommended_daily_hours"):
            resolved_daily_hours = float(calculation_result["recommended_daily_hours"])
        calculation_result["plan_date"] = plan_date or calculation_result["start_date"]
        record = await _save_schedule_plan_record(
            db,
            department=department,
            order_line=order_line,
            risk_level=risk_level,
            operator=operator,
            owner=owner,
            schedule_bucket="lean",
            resolved_upph=float(resolved_upph),
            resolved_daily_hours=float(resolved_daily_hours),
            calculation_result=calculation_result,
            existing_plan=existing_plan,
            operation_remark=operation_remark,
        )
        return [record], _build_schedule_response_calculation(
            schedule_bucket="lean",
            order_line=order_line,
            resolved_upph=float(resolved_upph),
            resolved_daily_hours=float(resolved_daily_hours),
            calculation_result=calculation_result,
            lean_workhour_plan=lean_workhour_plan,
        ), calculation_result.get("warning") or "排产成功"

    if schedule_bucket == "mixed":
        stage_rules = (schedule_context or {}).get("stage_rules") or {}
        assembly_upph = float(stage_rules.get("assembly", {}).get("upph") or 0)
        packaging_upph = float(stage_rules.get("packaging", {}).get("upph") or 0)
        if assembly_upph <= 0 or packaging_upph <= 0:
            raise HTTPException(status_code=400, detail="装配拆分后的组装/包装 UPPH 无效，请先检查明细单价或公式配置")

        assembly_workhour_plan = simulation_service.build_bucket_workhour_plan(
            quantity=float(order_line.order_qty),
            upph=float(assembly_upph),
            promised_date=order_line.promised_date,
            schedule_bucket="assembly",
        )
        packaging_workhour_plan = simulation_service.build_bucket_workhour_plan(
            quantity=float(order_line.order_qty),
            upph=float(packaging_upph),
            promised_date=order_line.promised_date,
            schedule_bucket="packaging",
        )
        assembly_daily_hours = float(
            await simulation_service.resolve_daily_work_hours(
                schedule_bucket="assembly",
                daily_work_hours=daily_work_hours,
                lean_workhour_plan=assembly_workhour_plan,
            )
        )
        packaging_daily_hours = float(
            await simulation_service.resolve_daily_work_hours(
                schedule_bucket="packaging",
                daily_work_hours=daily_work_hours,
                lean_workhour_plan=packaging_workhour_plan,
            )
        )
        if assembly_daily_hours <= 0 or packaging_daily_hours <= 0:
            raise HTTPException(status_code=400, detail="组装或包装每日工时必须大于0")

        assembly_existing_plan = await _get_existing_active_plan(
            db,
            order_no=order_no,
            line_no=line_no,
            schedule_bucket="assembly",
        )
        packaging_existing_plan = await _get_existing_active_plan(
            db,
            order_no=order_no,
            line_no=line_no,
            schedule_bucket="packaging",
        )
        if fail_if_scheduled and (assembly_existing_plan or packaging_existing_plan):
            raise HTTPException(status_code=400, detail="该订单已存在组装或包装有效排产计划，请先刷新列表")

        target_ready_date = simulation_service.calculate_target_ready_date(order_line.promised_date)
        mixed_result = split_service.build_mixed_stage_plans(
            quantity=float(order_line.order_qty),
            promised_date=order_line.promised_date,
            assembly_upph=assembly_upph,
            packaging_upph=packaging_upph,
            assembly_daily_hours=assembly_daily_hours,
            packaging_daily_hours=packaging_daily_hours,
            target_ready_date=target_ready_date,
            ready_offset_days=READY_OFFSET_DAYS,
            assembly_workhour_plan=assembly_workhour_plan,
            packaging_workhour_plan=packaging_workhour_plan,
        )
        candidate_order = ["normal", "overtime", "sunday_production"]
        assembly_candidates = assembly_workhour_plan.get("candidate_plans") or {}
        packaging_candidates = packaging_workhour_plan.get("candidate_plans") or {}
        candidate_pairs: list[tuple[int, int, str, str]] = []
        for assembly_index, assembly_key in enumerate(candidate_order):
            assembly_candidate = assembly_candidates.get(assembly_key)
            if not assembly_candidate or not assembly_candidate.get("feasible"):
                continue
            for packaging_index, packaging_key in enumerate(candidate_order):
                packaging_candidate = packaging_candidates.get(packaging_key)
                if not packaging_candidate or not packaging_candidate.get("feasible"):
                    continue
                candidate_pairs.append((assembly_index, packaging_index, assembly_key, packaging_key))
        candidate_pairs.sort(key=lambda item: (max(item[0], item[1]), item[0] + item[1], item[0], item[1]))

        evaluated_mixed_candidates: list[tuple[tuple[int, int], dict, dict]] = []
        exclude_plan_ids = [
            item.id for item in [assembly_existing_plan, packaging_existing_plan] if item and item.id
        ] or None
        for assembly_index, packaging_index, assembly_key, packaging_key in candidate_pairs:
            selected_assembly_candidate = assembly_candidates[assembly_key]
            selected_packaging_candidate = packaging_candidates[packaging_key]
            candidate_mixed_result = split_service.build_mixed_stage_plans(
                quantity=float(order_line.order_qty),
                promised_date=order_line.promised_date,
                assembly_upph=assembly_upph,
                packaging_upph=packaging_upph,
                assembly_daily_hours=float(selected_assembly_candidate.get("recommended_daily_hours") or assembly_daily_hours),
                packaging_daily_hours=float(selected_packaging_candidate.get("recommended_daily_hours") or packaging_daily_hours),
                target_ready_date=target_ready_date,
                ready_offset_days=READY_OFFSET_DAYS,
                assembly_workhour_plan={**assembly_workhour_plan, **selected_assembly_candidate},
                packaging_workhour_plan={**packaging_workhour_plan, **selected_packaging_candidate},
            )
            adjusted_candidate_result = await _resolve_conflict_aware_mixed_plan(
                db,
                department=department,
                mixed_result=candidate_mixed_result,
                exclude_plan_ids=exclude_plan_ids,
            )
            evaluated_mixed_candidates.append(
                (
                    (assembly_index, packaging_index),
                    candidate_mixed_result,
                    adjusted_candidate_result,
                )
            )
            if (
                adjusted_candidate_result["assembly_plan"].start_date == candidate_mixed_result["assembly_plan"].start_date
                and adjusted_candidate_result["assembly_plan"].end_date == candidate_mixed_result["assembly_plan"].end_date
                and adjusted_candidate_result["packaging_plan"].start_date == candidate_mixed_result["packaging_plan"].start_date
                and adjusted_candidate_result["packaging_plan"].end_date == candidate_mixed_result["packaging_plan"].end_date
            ):
                mixed_result = adjusted_candidate_result
                break
        else:
            if evaluated_mixed_candidates:
                _, _, mixed_result = max(
                    evaluated_mixed_candidates,
                    key=lambda item: (
                        (item[2]["packaging_plan"].end_date or date.min).toordinal(),
                        (item[2]["packaging_plan"].start_date or date.min).toordinal(),
                        -max(item[0]),
                        -(item[0][0] + item[0][1]),
                    ),
                )
            else:
                mixed_result = await _resolve_conflict_aware_mixed_plan(
                    db,
                    department=department,
                    mixed_result=mixed_result,
                    exclude_plan_ids=exclude_plan_ids,
                )
        assembly_plan = mixed_result["assembly_plan"]
        packaging_plan = mixed_result["packaging_plan"]
        assembly_calculation = {
            "plan_date": plan_date or assembly_plan.plan_date or assembly_plan.start_date,
            "start_date": assembly_plan.start_date,
            "end_date": assembly_plan.end_date,
            "target_ready_date": assembly_plan.target_ready_date,
            "ready_offset_days": READY_OFFSET_DAYS,
            "total_hours": assembly_plan.total_hours,
            "days_needed": assembly_plan.days_needed,
            "recommended_daily_hours": assembly_plan.daily_work_hours,
            "available_production_days": assembly_plan.available_production_days,
            "required_daily_hours": assembly_plan.required_daily_hours,
            "capacity_load_status": assembly_plan.capacity_load_status,
            "capacity_load_status_label": assembly_plan.capacity_load_status_label,
            "sunday_rest_allowed": assembly_plan.sunday_rest_allowed,
            "needs_sunday_work": assembly_plan.needs_sunday_work,
            "needs_move_earlier": assembly_plan.needs_move_earlier,
            "move_earlier_days": assembly_plan.move_earlier_days,
            "work_hour_summary": assembly_plan.work_hour_summary,
            "warning": assembly_plan.warning,
            "packaging_start_date": packaging_plan.start_date,
            "packaging_end_date": packaging_plan.end_date,
        }
        packaging_calculation = {
            "plan_date": plan_date or packaging_plan.plan_date or packaging_plan.start_date,
            "start_date": packaging_plan.start_date,
            "end_date": packaging_plan.end_date,
            "target_ready_date": packaging_plan.target_ready_date,
            "ready_offset_days": READY_OFFSET_DAYS,
            "total_hours": packaging_plan.total_hours,
            "days_needed": packaging_plan.days_needed,
            "recommended_daily_hours": packaging_plan.daily_work_hours,
            "available_production_days": packaging_plan.available_production_days,
            "required_daily_hours": packaging_plan.required_daily_hours,
            "capacity_load_status": packaging_plan.capacity_load_status,
            "capacity_load_status_label": packaging_plan.capacity_load_status_label,
            "sunday_rest_allowed": packaging_plan.sunday_rest_allowed,
            "needs_sunday_work": packaging_plan.needs_sunday_work,
            "needs_move_earlier": packaging_plan.needs_move_earlier,
            "move_earlier_days": packaging_plan.move_earlier_days,
            "work_hour_summary": packaging_plan.work_hour_summary,
            "warning": packaging_plan.warning,
            "assembly_start_date": assembly_plan.start_date,
            "assembly_end_date": assembly_plan.end_date,
        }
        # #region debug-point A:mixed-plan-persist-payload
        try:
            import json
            import urllib.request

            _p = '.dbg/assembly-duration-overrun.env'
            _u, _s = 'http://127.0.0.1:7777/event', 'assembly-duration-overrun'
            try:
                with open(_p, encoding='utf-8') as f:
                    c = f.read()
                _u = next((l.split('=', 1)[1] for l in c.split('\n') if l.startswith('DEBUG_SERVER_URL=')), _u)
                _s = next((l.split('=', 1)[1] for l in c.split('\n') if l.startswith('DEBUG_SESSION_ID=')), _s)
            except Exception:
                pass
            urllib.request.urlopen(
                urllib.request.Request(
                    _u,
                    data=json.dumps({
                        "sessionId": _s,
                        "runId": "pre-fix",
                        "hypothesisId": "A",
                        "location": "schedule_plans.py:_create_schedule_plan_core",
                        "msg": "[DEBUG] mixed plan payload before save",
                        "data": {
                            "order_no": order_line.order_no,
                            "line_no": order_line.line_no,
                            "quantity": float(order_line.order_qty or 0),
                            "promised_date": str(order_line.promised_date),
                            "assembly": {
                                "upph": assembly_plan.upph,
                                "daily_work_hours": assembly_plan.daily_work_hours,
                                "total_hours": assembly_plan.total_hours,
                                "days_needed": assembly_plan.days_needed,
                                "plan_date": str(assembly_calculation.get("plan_date") or ""),
                                "start_date": str(assembly_calculation.get("start_date") or ""),
                                "end_date": str(assembly_calculation.get("end_date") or ""),
                                "work_hour_summary": assembly_calculation.get("work_hour_summary"),
                            },
                            "packaging": {
                                "upph": packaging_plan.upph,
                                "daily_work_hours": packaging_plan.daily_work_hours,
                                "total_hours": packaging_plan.total_hours,
                                "days_needed": packaging_plan.days_needed,
                                "plan_date": str(packaging_calculation.get("plan_date") or ""),
                                "start_date": str(packaging_calculation.get("start_date") or ""),
                                "end_date": str(packaging_calculation.get("end_date") or ""),
                                "work_hour_summary": packaging_calculation.get("work_hour_summary"),
                            },
                        },
                        "ts": __import__('time').time_ns() // 1_000_000,
                    }).encode(),
                    headers={"Content-Type": "application/json"},
                ),
                timeout=0.3,
            ).read()
        except Exception:
            pass
        # #endregion
        assembly_record = await _save_schedule_plan_record(
            db,
            department=department,
            order_line=order_line,
            risk_level=risk_level,
            operator=operator,
            owner=owner,
            schedule_bucket="assembly",
            resolved_upph=assembly_plan.upph,
            resolved_daily_hours=assembly_plan.daily_work_hours,
            calculation_result=assembly_calculation,
            existing_plan=assembly_existing_plan,
            operation_remark=operation_remark or "两段排产创建-组装",
        )
        packaging_record = await _save_schedule_plan_record(
            db,
            department=department,
            order_line=order_line,
            risk_level=risk_level,
            operator=operator,
            owner=owner,
            schedule_bucket="packaging",
            resolved_upph=packaging_plan.upph,
            resolved_daily_hours=packaging_plan.daily_work_hours,
            calculation_result=packaging_calculation,
            existing_plan=packaging_existing_plan,
            operation_remark=operation_remark or "两段排产创建-包装",
        )
        return [assembly_record, packaging_record], {
            "schedule_bucket": "mixed",
            "schedule_bucket_label": SCHEDULE_BUCKET_LABELS["mixed"],
            "target_ready_date": mixed_result["target_ready_date"],
            "ready_offset_days": READY_OFFSET_DAYS,
            "assembly_start_date": assembly_plan.start_date,
            "assembly_end_date": assembly_plan.end_date,
            "assembly_upph": assembly_plan.upph,
            "assembly_daily_work_hours": assembly_plan.daily_work_hours,
            "assembly_capacity_load_status": assembly_plan.capacity_load_status,
            "assembly_capacity_load_status_label": assembly_plan.capacity_load_status_label,
            "assembly_needs_sunday_work": assembly_plan.needs_sunday_work,
            "assembly_move_earlier_days": assembly_plan.move_earlier_days,
            "packaging_start_date": packaging_plan.start_date,
            "packaging_end_date": packaging_plan.end_date,
            "packaging_upph": packaging_plan.upph,
            "packaging_daily_work_hours": packaging_plan.daily_work_hours,
            "packaging_capacity_load_status": packaging_plan.capacity_load_status,
            "packaging_capacity_load_status_label": packaging_plan.capacity_load_status_label,
            "packaging_needs_sunday_work": packaging_plan.needs_sunday_work,
            "packaging_move_earlier_days": packaging_plan.move_earlier_days,
            "warning": mixed_result.get("warning"),
            "work_hour_summary": (
                f"组装按 {assembly_plan.daily_work_hours:.2f} 小时/天"
                f"（{assembly_plan.capacity_load_status_label or '正常'}，"
                f"{'启用周日' if assembly_plan.needs_sunday_work else '周日可休'}）生产，"
                f"包装按 {packaging_plan.daily_work_hours:.2f} 小时/天"
                f"（{packaging_plan.capacity_load_status_label or '正常'}，"
                f"{'启用周日' if packaging_plan.needs_sunday_work else '周日可休'}）承接前一日释放量。"
            ),
        }, mixed_result.get("warning") or "已生成组装和包装两条分段排产计划"

    resolved_upph = 0.0
    stage_rules = (schedule_context or {}).get("stage_rules") or {}
    if schedule_bucket in {"assembly", "packaging"}:
        resolved_upph = float(stage_rules.get(schedule_bucket, {}).get("upph") or 0)
    if resolved_upph <= 0 and upph is not None:
        resolved_upph = float(upph)
    if resolved_upph <= 0 and (order_line.product_code or bom_code):
        resolved_upph, _ = await upph_service.calculate_total_upph(
            product_code=order_line.product_code,
            bom_code=bom_code,
        )
        resolved_upph = float(resolved_upph or 0)
    if resolved_upph <= 0:
        raise HTTPException(status_code=400, detail="缺少UPPH数据，请在订单或产品中配置，或手动指定")

    if schedule_bucket in {"assembly", "packaging"}:
        lean_workhour_plan = simulation_service.build_bucket_workhour_plan(
            quantity=float(order_line.order_qty),
            upph=float(resolved_upph),
            promised_date=order_line.promised_date,
            schedule_bucket=schedule_bucket,
        )

    resolved_daily_hours = await simulation_service.resolve_daily_work_hours(
        schedule_bucket=schedule_bucket,
        daily_work_hours=daily_work_hours,
        lean_workhour_plan=lean_workhour_plan,
    )
    if resolved_daily_hours <= 0:
        raise HTTPException(status_code=400, detail="每日工作时间必须大于0")

    existing_plan = await _get_existing_active_plan(
        db,
        order_no=order_no,
        line_no=line_no,
        schedule_bucket=schedule_bucket,
    )
    if existing_plan and fail_if_scheduled:
        raise HTTPException(status_code=400, detail="该订单已存在有效排产计划，请先刷新列表")

    calculation_result = simulation_service.calculate_schedule_result(
        quantity=float(order_line.order_qty),
        upph=float(resolved_upph),
        daily_hours=float(resolved_daily_hours),
        promised_date=order_line.promised_date,
        schedule_bucket=schedule_bucket,
        lean_workhour_plan=lean_workhour_plan,
    )
    if schedule_bucket == "lean":
        calculation_result, lean_workhour_plan = await _resolve_conflict_aware_lean_plan(
            db,
            department=department,
            calculation_result=calculation_result,
            lean_workhour_plan=lean_workhour_plan,
            exclude_plan_ids=[existing_plan.id] if existing_plan and existing_plan.id else None,
        )
        if calculation_result.get("recommended_daily_hours"):
            resolved_daily_hours = float(calculation_result["recommended_daily_hours"])
    else:
        calculation_result = await _resolve_conflict_aware_nonlean_plan(
            db,
            department=department,
            schedule_bucket=str(schedule_bucket or "pending"),
            calculation_result=calculation_result,
            include_sunday=bool(lean_workhour_plan and lean_workhour_plan.get("needs_sunday_work")),
            exclude_plan_ids=[existing_plan.id] if existing_plan and existing_plan.id else None,
        )
    calculation_result["plan_date"] = plan_date or calculation_result["start_date"]
    record = await _save_schedule_plan_record(
        db,
        department=department,
        order_line=order_line,
        risk_level=risk_level,
        operator=operator,
        owner=owner,
        schedule_bucket=str(schedule_bucket or "pending"),
        resolved_upph=float(resolved_upph),
        resolved_daily_hours=float(resolved_daily_hours),
        calculation_result=calculation_result,
        existing_plan=existing_plan,
        operation_remark=operation_remark,
    )
    return [record], _build_schedule_response_calculation(
        schedule_bucket=schedule_bucket,
        order_line=order_line,
        resolved_upph=float(resolved_upph),
        resolved_daily_hours=float(resolved_daily_hours),
        calculation_result=calculation_result,
    ), calculation_result.get("warning") or "排产成功"


async def _reschedule_plan_version(
    db: AsyncSession,
    plan_id: int,
    operator: str,
) -> ProductionSchedulePlan:
    old_plan_result = await db.execute(
        select(ProductionSchedulePlan).where(ProductionSchedulePlan.id == plan_id)
    )
    old_plan = old_plan_result.scalar_one_or_none()
    if not old_plan:
        raise HTTPException(status_code=404, detail="原排产计划不存在")

    records, _, _ = await _create_schedule_plan_from_request(
        db,
        order_no=str(old_plan.order_no or ""),
        line_no=str(old_plan.line_no or ""),
        department=str(old_plan.department or ""),
        plan_date=None,
        upph=None,
        daily_work_hours=_to_float(old_plan.daily_work_hours),
        owner=old_plan.owner,
        operator=operator,
        fail_if_scheduled=False,
        operation_remark=f"手动重排，原计划ID:{old_plan.id}",
    )

    preferred_bucket = str(old_plan.source_process_type or "")
    for record in records:
        if str(record.source_process_type or "") == preferred_bucket:
            return record
    return records[0]


async def _build_upph_impact_items(
    db: AsyncSession,
    plans: List[ProductionSchedulePlan],
    impact_config: Optional[dict] = None,
) -> List[UpphImpactPlanOut]:
    if impact_config is None:
        impact_config = await _get_impact_config(db)

    order_line_map = await _build_latest_order_line_map(db, plans)

    upph_service = UpphCalculationService(db)
    schedule_context_cache: dict[tuple[Optional[str], Optional[str]], dict] = {}
    split_rules_map = await _build_split_rules_map(
        db,
        [
            _get_order_line_bom_code(order_line_map.get((plan.order_no, plan.line_no)))
            for plan in plans
            if order_line_map.get((plan.order_no, plan.line_no))
        ],
    )

    today = date.today()
    items: List[UpphImpactPlanOut] = []
    for plan in plans:
        order_line = order_line_map.get((plan.order_no, plan.line_no))
        product_code = (order_line.product_code if order_line else None) or plan.product_code or plan.source_product_code
        bom_code = _get_order_line_bom_code(order_line) if order_line else None
        cache_key = (product_code, bom_code)
        schedule_context = None
        if product_code or bom_code:
            if cache_key not in schedule_context_cache:
                schedule_context_cache[cache_key] = await upph_service.summarize_schedule_context(
                    product_code=product_code,
                    bom_code=bom_code,
                    preloaded_split_rules=split_rules_map.get(str(bom_code).strip()) if bom_code else None,
                )
            schedule_context = schedule_context_cache[cache_key]
        schedule_bucket = plan.source_process_type or (schedule_context.get("schedule_bucket") if schedule_context else None)
        source_upph = _to_float(plan.source_upph, _to_float(plan.upph))
        current_upph = await _resolve_current_upph_for_bucket(
            db,
            schedule_bucket=schedule_bucket,
            schedule_context=schedule_context,
            product_code=product_code,
            bom_code=bom_code,
        )

        if not source_upph or source_upph <= 0:
            continue
        if abs(current_upph - source_upph) < 0.0001:
            continue

        quantity = _to_float(plan.source_order_qty, _to_float(plan.quantity, 0)) or 0
        daily_hours = _to_float(plan.daily_work_hours, 8) or 8
        promised_date = plan.source_promised_date

        planned_total_hours = round(quantity / source_upph, 2) if quantity > 0 else None
        planned_days_needed = max(1, math.ceil(planned_total_hours / daily_hours)) if planned_total_hours else None
        current_total_hours = round(quantity / current_upph, 2) if quantity > 0 and current_upph > 0 else None
        current_days_needed = max(1, math.ceil(current_total_hours / daily_hours)) if current_total_hours else None

        upph_delta = round(current_upph - source_upph, 2)
        upph_delta_ratio = round((current_upph - source_upph) / source_upph, 4)
        day_delta = abs((current_days_needed or 0) - (planned_days_needed or 0))

        impact_score = abs(upph_delta_ratio) * 100
        if quantity >= impact_config["qty_high"]:
            impact_score += impact_config["qty_bonus_high"]
        elif quantity >= impact_config["qty_medium"]:
            impact_score += impact_config["qty_bonus_medium"]

        if promised_date:
            due_days = (promised_date - today).days
            if due_days <= impact_config["due_days_urgent"]:
                impact_score += impact_config["due_bonus_urgent"]
            elif due_days <= impact_config["due_days_normal"]:
                impact_score += impact_config["due_bonus_normal"]
            elif due_days <= impact_config["due_days_loose"]:
                impact_score += impact_config["due_bonus_loose"]

        impact_score += day_delta * impact_config["day_bonus"]
        impact_score = round(impact_score, 2)

        if current_upph <= 0 or abs(upph_delta_ratio) >= impact_config["high_ratio"] or day_delta >= impact_config["high_day_delta"]:
            impact_level = "high"
        elif abs(upph_delta_ratio) >= impact_config["medium_ratio"] or day_delta >= impact_config["medium_day_delta"] or impact_score >= impact_config["medium_score"]:
            impact_level = "medium"
        else:
            impact_level = "low"

        reason_parts = [
            f"UPPH {source_upph:.2f} -> {current_upph:.2f}",
            f"变化{upph_delta_ratio * 100:.1f}%",
        ]
        if planned_total_hours is not None and current_total_hours is not None:
            reason_parts.append(f"工时 {planned_total_hours:.2f}h -> {current_total_hours:.2f}h")
        elif current_upph <= 0:
            reason_parts.append("当前无有效UPPH")
        if planned_days_needed is not None and current_days_needed is not None:
            reason_parts.append(f"天数 {planned_days_needed} -> {current_days_needed}")

        items.append(UpphImpactPlanOut(
            id=plan.id,
            department=plan.department,
            order_no=plan.order_no,
            line_no=plan.line_no,
            schedule_bucket=schedule_bucket,
            schedule_bucket_label=SCHEDULE_BUCKET_LABELS.get(schedule_bucket),
            product_code=product_code,
            model_code=plan.model_code,
            quantity=quantity,
            owner=plan.owner,
            status=plan.status,
            plan_date=plan.plan_date,
            start_date=plan.start_date,
            end_date=plan.end_date,
            source_promised_date=plan.source_promised_date,
            source_upph=source_upph,
            current_upph=round(current_upph, 2),
            upph_delta=upph_delta,
            upph_delta_ratio=upph_delta_ratio,
            planned_total_hours=planned_total_hours,
            current_total_hours=current_total_hours,
            planned_days_needed=planned_days_needed,
            current_days_needed=current_days_needed,
            impact_level=impact_level,
            impact_score=impact_score,
            impact_reason="; ".join(reason_parts),
            needs_reschedule=plan.needs_reschedule,
            reschedule_reason=plan.reschedule_reason,
        ))

    items.sort(
        key=lambda item: (
            IMPACT_PRIORITY_MAP.get(item.impact_level, 99),
            -item.impact_score,
            item.source_promised_date or date.max,
            item.plan_date,
            item.id,
        )
    )
    return items


async def _build_schedule_change_event_items(
    db: AsyncSession,
    plans: List[ProductionSchedulePlan],
    impact_config: Optional[dict] = None,
) -> List[ScheduleChangeEventOut]:
    if impact_config is None:
        impact_config = await _get_impact_config(db)

    upph_items = await _build_upph_impact_items(db, plans, impact_config=impact_config)
    upph_map = {item.id: item for item in upph_items}
    order_line_map = await _build_latest_order_line_map(db, plans)
    status_map = await _build_change_event_status_map(db, [plan.id for plan in plans if plan.id])
    upph_service = UpphCalculationService(db)
    schedule_context_cache: dict[tuple[Optional[str], Optional[str]], dict] = {}
    split_rules_map = await _build_split_rules_map(
        db,
        [
            _get_order_line_bom_code(order_line_map.get((plan.order_no, plan.line_no)))
            for plan in plans
            if order_line_map.get((plan.order_no, plan.line_no))
        ],
    )
    today = date.today()
    items: List[ScheduleChangeEventOut] = []

    for plan in plans:
        order_line = order_line_map.get((plan.order_no, plan.line_no))
        source_qty = _to_float(plan.source_order_qty, _to_float(plan.quantity, 0)) or 0
        current_qty = _to_float(order_line.order_qty, source_qty) if order_line else source_qty
        source_due = plan.source_promised_date
        current_due = order_line.promised_date if order_line and order_line.promised_date else source_due
        source_upph = _to_float(plan.source_upph, _to_float(plan.upph))
        product_code = (order_line.product_code if order_line else None) or plan.product_code or plan.source_product_code
        bom_code = _get_order_line_bom_code(order_line) if order_line else None
        current_schedule_context = None
        if product_code or bom_code:
            cache_key = (product_code, bom_code)
            if cache_key not in schedule_context_cache:
                schedule_context_cache[cache_key] = await upph_service.summarize_schedule_context(
                    product_code=product_code,
                    bom_code=bom_code,
                    preloaded_split_rules=split_rules_map.get(str(bom_code).strip()) if bom_code else None,
                )
            current_schedule_context = schedule_context_cache[cache_key]
        upph_item = upph_map.get(plan.id)
        current_upph = _to_float(upph_item.current_upph if upph_item else source_upph, source_upph)
        daily_hours = _to_float(plan.daily_work_hours, 8) or 8
        source_bucket = _normalize_plan_source_bucket(plan.source_process_type)
        current_bucket = source_bucket
        if order_line is not None:
            current_bucket = _resolve_effective_current_bucket_for_plan(
                source_bucket=source_bucket,
                schedule_context=current_schedule_context,
            )
        schedule_bucket = current_bucket if order_line is not None else source_bucket
        current_schedule_state = _resolve_order_scheduling_state(current_schedule_context, has_schedule=False)

        planned_total_hours = round(source_qty / source_upph, 2) if source_qty > 0 and source_upph and source_upph > 0 else None
        planned_days_needed = max(1, math.ceil(planned_total_hours / daily_hours)) if planned_total_hours else None
        current_total_hours = round(current_qty / current_upph, 2) if current_qty > 0 and current_upph and current_upph > 0 else None
        current_days_needed = max(1, math.ceil(current_total_hours / daily_hours)) if current_total_hours else None

        common_payload = {
            "id": plan.id,
            "department": plan.department,
            "order_no": plan.order_no,
            "line_no": plan.line_no,
            "schedule_bucket": schedule_bucket,
            "schedule_bucket_label": SCHEDULE_BUCKET_LABELS.get(schedule_bucket),
            "product_code": product_code,
            "model_code": (order_line.product_model if order_line else None) or plan.model_code or plan.source_product_model,
            "quantity": current_qty,
            "owner": plan.owner,
            "status": plan.status,
            "plan_version": plan.plan_version or 1,
            "plan_date": plan.plan_date,
            "start_date": plan.start_date,
            "end_date": plan.end_date,
            "source_promised_date": source_due,
            "current_promised_date": current_due,
            "source_order_qty": source_qty,
            "current_order_qty": current_qty,
            "source_upph": source_upph,
            "current_upph": current_upph,
            "planned_days_needed": planned_days_needed,
            "current_days_needed": current_days_needed,
        }

        if current_bucket != source_bucket:
            status_payload = status_map.get((plan.id, "bucket_change"), {})
            bucket_reason = _build_bucket_change_reason(
                source_bucket=source_bucket,
                current_bucket=current_bucket,
                schedule_context=current_schedule_context,
                current_reason=str(current_schedule_state.get("reason") or ""),
            )
            items.append(ScheduleChangeEventOut(
                **{
                    **common_payload,
                    "schedule_bucket": current_bucket,
                    "schedule_bucket_label": SCHEDULE_BUCKET_LABELS.get(current_bucket),
                },
                event_id=f"{plan.id}:bucket_change",
                event_type="bucket_change",
                event_type_label=CHANGE_EVENT_TYPE_LABELS["bucket_change"],
                before_value_text=SCHEDULE_BUCKET_LABELS.get(source_bucket, source_bucket),
                after_value_text=SCHEDULE_BUCKET_LABELS.get(current_bucket, current_bucket),
                change_summary=f"排产段 {SCHEDULE_BUCKET_LABELS.get(source_bucket, source_bucket)} -> {SCHEDULE_BUCKET_LABELS.get(current_bucket, current_bucket)}",
                impact_level="high" if "pending" in {source_bucket, current_bucket} or "lean" in {source_bucket, current_bucket} else "medium",
                impact_score=120 if "pending" in {source_bucket, current_bucket} or "lean" in {source_bucket, current_bucket} else 90,
                impact_reason=bucket_reason,
                needs_reschedule=True,
                reschedule_reason=f"排产段由{SCHEDULE_BUCKET_LABELS.get(source_bucket, source_bucket)}变更为{SCHEDULE_BUCKET_LABELS.get(current_bucket, current_bucket)}，建议重排",
                process_status=str(status_payload.get("process_status") or "pending"),
                process_status_label=str(status_payload.get("process_status_label") or "待处理"),
                process_operator=status_payload.get("process_operator"),
                process_at=status_payload.get("process_at"),
                upph_delta=upph_item.upph_delta if upph_item else None,
                upph_delta_ratio=upph_item.upph_delta_ratio if upph_item else None,
            ))

        if upph_item:
            upph_needs_reschedule = bool(
                plan.needs_reschedule
                or (current_upph is not None and current_upph <= 0)
                or upph_item.impact_level in {"high", "medium"}
            )
            status_payload = status_map.get((plan.id, "upph_change"), {})
            items.append(ScheduleChangeEventOut(
                **common_payload,
                event_id=f"{plan.id}:upph_change",
                event_type="upph_change",
                event_type_label=CHANGE_EVENT_TYPE_LABELS["upph_change"],
                before_value_text=f"{source_upph:.2f}" if source_upph is not None else "-",
                after_value_text=f"{float(current_upph):.2f}" if current_upph is not None else "-",
                change_summary=f"UPPH {source_upph:.2f} -> {float(current_upph):.2f}" if source_upph is not None and current_upph is not None else "UPPH 发生变化",
                impact_level=upph_item.impact_level,
                impact_score=upph_item.impact_score,
                impact_reason=upph_item.impact_reason,
                needs_reschedule=upph_needs_reschedule,
                reschedule_reason=plan.reschedule_reason or ("UPPH变化后建议重排" if upph_needs_reschedule else "建议关注 UPPH 变化"),
                process_status=str(status_payload.get("process_status") or ("pending" if upph_needs_reschedule else "watching")),
                process_status_label=str(status_payload.get("process_status_label") or ("待处理" if upph_needs_reschedule else "观察中")),
                process_operator=status_payload.get("process_operator"),
                process_at=status_payload.get("process_at"),
                upph_delta=upph_item.upph_delta,
                upph_delta_ratio=upph_item.upph_delta_ratio,
            ))

        if source_due and current_due and current_due != source_due:
            due_delta_days = (current_due - source_due).days
            due_impact_score = abs(due_delta_days) * 20
            if current_due <= today + timedelta(days=impact_config["due_days_urgent"]):
                due_impact_score += impact_config["due_bonus_urgent"]
            elif current_due <= today + timedelta(days=impact_config["due_days_normal"]):
                due_impact_score += impact_config["due_bonus_normal"]
            due_impact_score = round(due_impact_score, 2)
            if due_delta_days <= -2:
                due_impact_level = "high"
            elif due_delta_days < 0 or abs(due_delta_days) >= 3:
                due_impact_level = "medium"
            else:
                due_impact_level = "low"
            due_needs_reschedule = due_delta_days < 0
            due_reason = (
                f"交期 {source_due:%Y-%m-%d} -> {current_due:%Y-%m-%d}，"
                f"{'提前' if due_delta_days < 0 else '顺延'} {abs(due_delta_days)} 天"
            )
            if current_days_needed and planned_days_needed:
                due_reason = f"{due_reason}；当前预计天数 {planned_days_needed} -> {current_days_needed}"
            status_payload = status_map.get((plan.id, "due_date_change"), {})
            items.append(ScheduleChangeEventOut(
                **common_payload,
                event_id=f"{plan.id}:due_date_change",
                event_type="due_date_change",
                event_type_label=CHANGE_EVENT_TYPE_LABELS["due_date_change"],
                before_value_text=source_due.strftime("%Y-%m-%d"),
                after_value_text=current_due.strftime("%Y-%m-%d"),
                change_summary=f"{'提前' if due_delta_days < 0 else '顺延'} {abs(due_delta_days)} 天",
                impact_level=due_impact_level,
                impact_score=due_impact_score,
                impact_reason=due_reason,
                needs_reschedule=due_needs_reschedule,
                reschedule_reason="交期提前，建议重排" if due_needs_reschedule else "交期顺延，建议关注是否需要调整",
                process_status=str(status_payload.get("process_status") or ("pending" if due_needs_reschedule else "watching")),
                process_status_label=str(status_payload.get("process_status_label") or ("待处理" if due_needs_reschedule else "观察中")),
                process_operator=status_payload.get("process_operator"),
                process_at=status_payload.get("process_at"),
                upph_delta=upph_item.upph_delta if upph_item else None,
                upph_delta_ratio=upph_item.upph_delta_ratio if upph_item else None,
            ))

        if abs(current_qty - source_qty) >= 0.01:
            qty_delta = round(current_qty - source_qty, 2)
            qty_delta_ratio = round((qty_delta / source_qty), 4) if source_qty else 1
            qty_impact_score = round(abs(qty_delta_ratio) * 100, 2)
            if current_qty <= 0 or abs(qty_delta_ratio) >= impact_config["high_ratio"]:
                qty_impact_level = "high"
            elif abs(qty_delta_ratio) >= impact_config["medium_ratio"]:
                qty_impact_level = "medium"
            else:
                qty_impact_level = "low"
            qty_needs_reschedule = current_qty <= 0 or qty_delta > 0
            qty_reason_parts = [
                f"数量 {source_qty:.2f} -> {current_qty:.2f}",
                f"变化 {qty_delta:+.2f}",
            ]
            if planned_days_needed is not None and current_days_needed is not None:
                qty_reason_parts.append(f"预计天数 {planned_days_needed} -> {current_days_needed}")
            status_payload = status_map.get((plan.id, "quantity_change"), {})
            items.append(ScheduleChangeEventOut(
                **common_payload,
                event_id=f"{plan.id}:quantity_change",
                event_type="quantity_change",
                event_type_label=CHANGE_EVENT_TYPE_LABELS["quantity_change"],
                before_value_text=f"{source_qty:.2f}",
                after_value_text=f"{current_qty:.2f}",
                change_summary=f"{'增加' if qty_delta > 0 else '减少'} {abs(qty_delta):.2f}",
                impact_level=qty_impact_level,
                impact_score=qty_impact_score,
                impact_reason="；".join(qty_reason_parts),
                needs_reschedule=qty_needs_reschedule,
                reschedule_reason="数量增加，建议重排" if qty_needs_reschedule else "数量减少，建议关注是否需要调整",
                process_status=str(status_payload.get("process_status") or ("pending" if qty_needs_reschedule else "watching")),
                process_status_label=str(status_payload.get("process_status_label") or ("待处理" if qty_needs_reschedule else "观察中")),
                process_operator=status_payload.get("process_operator"),
                process_at=status_payload.get("process_at"),
                upph_delta=upph_item.upph_delta if upph_item else None,
                upph_delta_ratio=upph_item.upph_delta_ratio if upph_item else None,
            ))

    items.sort(
        key=lambda item: (
            IMPACT_PRIORITY_MAP.get(item.impact_level, 99),
            -item.impact_score,
            item.current_promised_date or item.source_promised_date or date.max,
            item.plan_date,
            item.id,
            item.event_type,
        )
    )
    return items


@router.get("", response_model=ResponseModel[PageResult[ProductionSchedulePlanOut]])
async def list_schedule_plans(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    department: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    date_start: Optional[date] = Query(None),
    date_end: Optional[date] = Query(None),
    keyword: Optional[str] = Query(None),
    needs_reschedule: Optional[bool] = Query(None),
    is_active: Optional[bool] = Query(True),
    schedule_bucket: Optional[str] = Query(None, pattern="^(lean|assembly|packaging|mixed|pending)$"),
    read_context: dict = Depends(_get_production_schedule_read_context),
):
    # 列表查询优先走数据库已固化字段，避免切页时全量动态重算。
    request_started_at = perf_counter()
    timings_ms: dict[str, float] = {}
    dependency_timings_ms = dict(read_context.get("dependency_timings_ms") or {})
    db: AsyncSession = read_context["db"]
    cache_key = (
        page,
        page_size,
        department or "",
        status or "",
        date_start.isoformat() if date_start else "",
        date_end.isoformat() if date_end else "",
        keyword or "",
        needs_reschedule,
        is_active,
        schedule_bucket or "",
    )
    cached_page = _get_runtime_page_cache(
        _schedule_plan_list_cache,
        cache_key,
        ttl_seconds=SCHEDULE_PLAN_LIST_CACHE_TTL_SECONDS,
    )
    if cached_page is not None:
        logger.info(
            "schedule-plans timing page=%s page_size=%s total=%s needs_reschedule=%s keyword=%s bucket=%s timings_ms=%s",
            page,
            page_size,
            cached_page.total,
            needs_reschedule,
            bool(keyword),
            schedule_bucket or "all",
            {"cache_hit": True},
        )
        return ResponseModel(data=cached_page)
    conditions = []
    if department:
        conditions.append(ProductionSchedulePlan.department == department)
    if status:
        conditions.append(ProductionSchedulePlan.status == status)
    if date_start or date_end:
        plan_window_start = func.coalesce(
            ProductionSchedulePlan.start_date,
            ProductionSchedulePlan.plan_date,
        )
        plan_window_end = func.coalesce(
            ProductionSchedulePlan.end_date,
            ProductionSchedulePlan.plan_date,
        )
        if date_start and date_end:
            conditions.append(
                and_(
                    plan_window_start <= date_end,
                    plan_window_end >= date_start,
                )
            )
        elif date_start:
            conditions.append(plan_window_end >= date_start)
        elif date_end:
            conditions.append(plan_window_start <= date_end)
    if keyword:
        like = f"%{keyword}%"
        conditions.append(
            or_(
                ProductionSchedulePlan.order_no.ilike(like),
                ProductionSchedulePlan.product_code.ilike(like),
                ProductionSchedulePlan.model_code.ilike(like),
                ProductionSchedulePlan.owner.ilike(like),
                ProductionSchedulePlan.remark.ilike(like),
            )
        )
    if is_active is not None:
        conditions.append(ProductionSchedulePlan.is_active == is_active)
    if needs_reschedule is True:
        conditions.append(ProductionSchedulePlan.needs_reschedule == True)
    elif needs_reschedule is False:
        conditions.append(
            or_(
                ProductionSchedulePlan.needs_reschedule == False,
                ProductionSchedulePlan.needs_reschedule.is_(None),
            )
        )
    bucket_condition = _build_workspace_bucket_filter_condition(
        ProductionSchedulePlan.source_process_type,
        schedule_bucket,
    )
    if bucket_condition is not None:
        conditions.append(bucket_condition)

    page_stmt = (
        select(ProductionSchedulePlan, ProductionOrderScheduleSnapshot)
        .select_from(ProductionSchedulePlan)
        .outerjoin(
            ProductionOrderScheduleSnapshot,
            and_(
                ProductionSchedulePlan.order_no == ProductionOrderScheduleSnapshot.order_no,
                ProductionSchedulePlan.line_no == ProductionOrderScheduleSnapshot.line_no,
            ),
        )
        .where(*conditions)
        .order_by(
            func.coalesce(
                ProductionSchedulePlan.start_date,
                ProductionSchedulePlan.plan_date,
            ).asc(),
            ProductionSchedulePlan.id.asc(),
        )
    )
    start = (page - 1) * page_size

    step_started_at = perf_counter()
    total = (
        await db.execute(
            select(func.count(ProductionSchedulePlan.id)).where(*conditions)
        )
    ).scalar() or 0
    timings_ms["count_query"] = round((perf_counter() - step_started_at) * 1000, 2)
    step_started_at = perf_counter()
    result = await db.execute(page_stmt.offset(start).limit(page_size))
    page_rows = list(result.all())
    timings_ms["page_query"] = round((perf_counter() - step_started_at) * 1000, 2)
    step_started_at = perf_counter()
    order_line_map = await _build_latest_order_line_map_by_keys(
        db,
        {
            (plan.order_no, plan.line_no)
            for plan, _ in page_rows
            if plan.order_no and plan.line_no
        },
    )
    timings_ms["order_line_fallback_query"] = round((perf_counter() - step_started_at) * 1000, 2)
    step_started_at = perf_counter()
    items: List[ProductionSchedulePlanOut] = []
    for plan, plan_snapshot in page_rows:
        item = _serialize_schedule_plan(
            plan,
            bom_no=_get_order_line_bom_code(order_line_map.get((plan.order_no, plan.line_no))),
            snapshot=plan_snapshot,
            schedule_context=None,
        )
        items.append(item)
    timings_ms["serialize_items"] = round((perf_counter() - step_started_at) * 1000, 2)
    timings_ms["total"] = round((perf_counter() - request_started_at) * 1000, 2)
    logger.info(
        "schedule-plans timing page=%s page_size=%s total=%s needs_reschedule=%s keyword=%s bucket=%s timings_ms=%s",
        page,
        page_size,
        total,
        needs_reschedule,
        bool(keyword),
        schedule_bucket or "all",
        timings_ms,
    )

    page_result = PageResult(
        total=total,
        page=page,
        page_size=page_size,
        items=items,
        stats={
            "dependency_timings_ms": dependency_timings_ms,
            "timings_ms": timings_ms,
        },
    )
    _set_runtime_page_cache(_schedule_plan_list_cache, cache_key, page_result)
    return ResponseModel(data=page_result)


@router.post("", response_model=ResponseModel[ProductionSchedulePlanOut])
async def create_schedule_plan(
    data: ProductionSchedulePlanCreate,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "create")),
    db: AsyncSession = Depends(get_db),
):
    record = ProductionSchedulePlan(**data.model_dump(), created_by=current_user["username"])
    db.add(record)
    await db.flush()
    await log_audit(db, "production_schedule_plan", record.id, "create", operator=current_user["username"])
    await db.commit()
    if record.order_no and record.line_no:
        await _sync_snapshot_schedule_state_for_keys(db, {(record.order_no, record.line_no)})
    _invalidate_schedule_runtime_caches()
    await db.refresh(record)
    return ResponseModel(data=ProductionSchedulePlanOut.model_validate(record))


@router.put("/{record_id}", response_model=ResponseModel[ProductionSchedulePlanOut])
async def update_schedule_plan(
    record_id: int,
    data: ProductionSchedulePlanUpdate,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "update")),
    db: AsyncSession = Depends(get_db),
):
    record = (await db.execute(select(ProductionSchedulePlan).where(ProductionSchedulePlan.id == record_id))).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="计划不存在")

    update_data = data.model_dump(exclude_unset=True)
    await log_audit(db, "production_schedule_plan", record.id, "update", old_obj=record, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(record, field, value)
    await db.commit()
    if record.order_no and record.line_no:
        await _sync_snapshot_schedule_state_for_keys(db, {(record.order_no, record.line_no)})
    _invalidate_schedule_runtime_caches()
    await db.refresh(record)
    return ResponseModel(data=ProductionSchedulePlanOut.model_validate(record))


@router.get("/{record_id}/delete-preview", response_model=ResponseModel[DeleteSchedulePlanPreviewOut])
async def get_delete_schedule_plan_preview(
    record_id: int,
    reason: Optional[str] = Query(None, description="删除原因"),
    read_context: dict = Depends(_get_production_schedule_read_context),
):
    request_started_at = perf_counter()
    dependency_timings_ms = dict(read_context.get("dependency_timings_ms") or {})
    db: AsyncSession = read_context["db"]
    step_started_at = perf_counter()
    record = (await db.execute(select(ProductionSchedulePlan).where(ProductionSchedulePlan.id == record_id))).scalar_one_or_none()
    record_query_ms = round((perf_counter() - step_started_at) * 1000, 2)
    if not record:
        raise HTTPException(status_code=404, detail="计划不存在")
    if not record.is_active:
        raise HTTPException(status_code=400, detail="仅允许删除当前有效计划")

    delete_service = PlanDeleteAndBackfillService(db)
    if not delete_service.can_participate_backfill(record):
        raise HTTPException(status_code=400, detail="仅允许删除未开始、未投产且未锁定的计划")

    step_started_at = perf_counter()
    preview_result = await delete_service.build_delete_preview(record)
    preview_build_ms = round((perf_counter() - step_started_at) * 1000, 2)
    _set_cached_delete_preview(record_id, preview_result)
    remark = reason or "计划员手动删除计划"
    logger.warning(
        "delete-preview timing plan_id=%s affected_count=%s timings_ms=%s",
        record_id,
        preview_result.get("affected_count", 0),
        {
            "dependency": dependency_timings_ms,
            "record_query": record_query_ms,
            "build_preview": preview_build_ms,
            "total": round((perf_counter() - request_started_at) * 1000, 2),
        },
    )
    return ResponseModel(data=DeleteSchedulePlanPreviewOut(**_build_delete_preview_response(
        record=record,
        remark=remark,
        preview_result=preview_result,
    )))


@router.post("/{record_id}/delete-confirm", response_model=ResponseModel[DeleteSchedulePlanResultOut])
async def confirm_delete_schedule_plan(
    record_id: int,
    data: DeleteSchedulePlanConfirmRequest,
    context: dict = Depends(_get_production_schedule_write_context),
):
    current_user = context["current_user"]
    db = context["db"]
    dependency_timings_ms = context["dependency_timings_ms"]
    request_started_at = perf_counter()
    step_started_at = perf_counter()
    record = (await db.execute(select(ProductionSchedulePlan).where(ProductionSchedulePlan.id == record_id))).scalar_one_or_none()
    record_query_ms = round((perf_counter() - step_started_at) * 1000, 2)
    if not record:
        raise HTTPException(status_code=404, detail="计划不存在")
    if not record.is_active:
        raise HTTPException(status_code=400, detail="仅允许删除当前有效计划")

    delete_service = PlanDeleteAndBackfillService(db)
    if not delete_service.can_participate_backfill(record):
        raise HTTPException(status_code=400, detail="仅允许删除未开始、未投产且未锁定的计划")

    preview_source = "cache_hit"
    step_started_at = perf_counter()
    preview_result = _pop_cached_delete_preview(record_id)
    if preview_result is None:
        if data.execute_backfill:
            preview_source = "rebuild_for_backfill"
            preview_result = await delete_service.build_delete_preview(record)
        else:
            preview_source = "skip_preview_for_delete_only"
            preview_result = {
                "release_plan_date": record.plan_date,
                "earliest_backfill_date": delete_service.get_earliest_backfill_plan_date(record.plan_date),
                "release_bucket": record.source_process_type,
                "affected_count": 0,
                "affected_plan_ids": [],
                "items": [],
            }
    preview_prepare_ms = round((perf_counter() - step_started_at) * 1000, 2)
    remark = data.reason or "计划员手动删除计划"

    step_started_at = perf_counter()
    await log_audit(db, "production_schedule_plan", record.id, "delete", operator=current_user["username"])
    await _log_schedule_operation(
        db,
        "delete",
        current_user["username"],
        plan_id=record_id,
        order_no=record.order_no,
        line_no=record.line_no,
        remark=remark,
        affected_plan_ids=preview_result.get("affected_plan_ids"),
    )
    await db.delete(record)
    delete_mark_ms = round((perf_counter() - step_started_at) * 1000, 2)

    backfill_success_count = 0
    backfill_failed_count = 0
    backfill_ms = 0.0
    if data.execute_backfill and preview_result.get("items"):
        step_started_at = perf_counter()
        results = await delete_service.execute_backfill(
            items=list(preview_result.get("items") or []),
            operator=current_user["username"],
            remark=remark,
        )
        success_items = [item for item in results if item.get("success")]
        backfill_success_count = len(success_items)
        backfill_failed_count = len(results) - backfill_success_count
        success_plan_ids = [int(item["new_plan_id"]) for item in success_items if item.get("new_plan_id")]
        for item in success_items:
            await _log_schedule_operation(
                db,
                "backfill",
                current_user["username"],
                plan_id=item.get("new_plan_id"),
                order_no=item.get("order_no"),
                line_no=item.get("line_no"),
                remark=remark or f"删除补位前滚：{item.get('old_plan_date')} -> {item.get('new_plan_date')}",
                previous_version_id=item.get("old_plan_id"),
            )
        if success_plan_ids:
            await _log_schedule_operation(
                db,
                "batch_backfill",
                current_user["username"],
                affected_plan_ids=success_plan_ids,
                remark=f"执行删除补位 {len(success_plan_ids)} 条",
            )
        backfill_ms = round((perf_counter() - step_started_at) * 1000, 2)
    step_started_at = perf_counter()
    await db.commit()
    commit_ms = round((perf_counter() - step_started_at) * 1000, 2)
    sync_keys = {
        (record.order_no, record.line_no),
        *{
            (str(item.get("order_no")), str(item.get("line_no")))
            for item in (preview_result.get("items") or [])
            if item.get("order_no") and item.get("line_no")
        },
    }
    step_started_at = perf_counter()
    await _sync_snapshot_schedule_state_for_keys(
        db,
        {
            (order_no, line_no)
            for order_no, line_no in sync_keys
            if order_no and line_no
        },
    )
    sync_snapshot_ms = round((perf_counter() - step_started_at) * 1000, 2)
    step_started_at = perf_counter()
    _invalidate_schedule_runtime_caches()
    invalidate_cache_ms = round((perf_counter() - step_started_at) * 1000, 2)
    preview_payload = _build_delete_preview_response(
        record=record,
        remark=remark,
        preview_result=preview_result,
    )
    timings_ms = {
        "dependency": dependency_timings_ms,
        "record_query": record_query_ms,
        "prepare_preview": preview_prepare_ms,
        "mark_delete": delete_mark_ms,
        "execute_backfill": backfill_ms,
        "commit": commit_ms,
        "sync_snapshot": sync_snapshot_ms,
        "invalidate_cache": invalidate_cache_ms,
        "total": round((perf_counter() - request_started_at) * 1000, 2),
    }
    logger.warning(
        "delete-confirm timing plan_id=%s execute_backfill=%s preview_source=%s affected_count=%s timings_ms=%s",
        record_id,
        data.execute_backfill,
        preview_source,
        preview_result.get("affected_count", 0),
        timings_ms,
    )
    return ResponseModel(data=DeleteSchedulePlanResultOut(
        deleted=record_id,
        reason=remark,
        release_plan_date=preview_payload["release_plan_date"],
        earliest_backfill_date=preview_payload.get("earliest_backfill_date"),
        release_bucket=preview_payload["release_bucket"],
        release_bucket_label=preview_payload["release_bucket_label"],
        affected_count=preview_payload["affected_count"],
        affected_plan_ids=preview_payload["affected_plan_ids"],
        items=preview_payload["items"],
        backfill_executed=bool(data.execute_backfill),
        backfill_success_count=backfill_success_count,
        backfill_failed_count=backfill_failed_count,
        timings_ms=timings_ms,
    ))


@router.delete("/{record_id}", response_model=ResponseModel[DeleteSchedulePlanResultOut])
async def delete_schedule_plan(
    record_id: int,
    reason: Optional[str] = Query(None, description="删除原因"),
    context: dict = Depends(_get_production_schedule_write_context),
):
    return await confirm_delete_schedule_plan(
        record_id=record_id,
        data=DeleteSchedulePlanConfirmRequest(reason=reason, execute_backfill=False),
        context=context,
    )


@router.post("/backfill/execute", response_model=ResponseModel[DeleteBackfillExecuteResponse])
async def execute_delete_backfill(
    data: DeleteBackfillExecuteRequest,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "update")),
    db: AsyncSession = Depends(get_db),
):
    if not data.items:
        raise HTTPException(status_code=400, detail="请先选择需要执行补位的计划")

    delete_service = PlanDeleteAndBackfillService(db)
    results = await delete_service.execute_backfill(
        items=[item.model_dump() for item in data.items],
        operator=current_user["username"],
        remark=data.remark,
    )
    success_items = [item for item in results if item.get("success")]
    success_plan_ids = [int(item["new_plan_id"]) for item in success_items if item.get("new_plan_id")]

    for item in success_items:
        await _log_schedule_operation(
            db,
            "backfill",
            current_user["username"],
            plan_id=item.get("new_plan_id"),
            order_no=item.get("order_no"),
            line_no=item.get("line_no"),
            remark=data.remark or f"删除补位前滚：{item.get('old_plan_date')} -> {item.get('new_plan_date')}",
            previous_version_id=item.get("old_plan_id"),
        )
    if success_plan_ids:
        await _log_schedule_operation(
            db,
            "batch_backfill",
            current_user["username"],
            affected_plan_ids=success_plan_ids,
            remark=f"执行删除补位 {len(success_plan_ids)} 条",
        )
    await db.commit()
    await _sync_snapshot_schedule_state_for_keys(
        db,
        {
            (str(item.get("order_no")), str(item.get("line_no")))
            for item in data.items
            if item.order_no and item.line_no
        },
    )
    _invalidate_schedule_runtime_caches()
    return ResponseModel(data=DeleteBackfillExecuteResponse(
        total=len(results),
        success_count=len(success_items),
        failed_count=len(results) - len(success_items),
        items=[DeleteBackfillExecuteItemOut(**item) for item in results],
    ))


@router.post("/detect-changes", response_model=ResponseModel[List[SaleOrderLineChangeLogOut]])
async def detect_sale_order_line_changes(
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "update")),
    db: AsyncSession = Depends(get_db),
):
    """检测销售订单行变更并记录日志，同时标记相关排产计划需要重排"""
    service = ProductionChangeService(db)
    changed_logs = await service.detect_and_log_sale_order_line_changes()
    # 变更日志模型没有 plan_id，兼容读取避免接口在返回前抛错。
    affected_plan_ids = [plan_id for log in changed_logs if (plan_id := getattr(log, "plan_id", None))]
    await _log_schedule_operation(
        db,
        "check_changes",
        current_user["username"],
        affected_plan_ids=affected_plan_ids if affected_plan_ids else None,
        remark=f"检测到 {len(changed_logs)} 条订单行变更",
    )
    await db.commit()
    _invalidate_schedule_runtime_caches()
    return ResponseModel(data=[log for log in changed_logs])


@router.post("/{plan_id}/reschedule", response_model=ResponseModel[ProductionSchedulePlanOut])
async def reschedule_plan(
    plan_id: int,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "update")),
    db: AsyncSession = Depends(get_db),
):
    """重新排产一个已存在的计划"""
    new_record = await _reschedule_plan_version(db, plan_id, current_user["username"])
    await _log_schedule_operation(
        db,
        "reschedule",
        current_user["username"],
        plan_id=new_record.id,
        plan_version=new_record.plan_version,
        order_no=new_record.order_no,
        line_no=new_record.line_no,
        previous_version_id=plan_id,
        remark="单条手动重排",
    )
    await db.commit()
    if new_record.order_no and new_record.line_no:
        await _sync_snapshot_schedule_state_for_keys(db, {(new_record.order_no, new_record.line_no)})
    _invalidate_schedule_runtime_caches()
    await db.refresh(new_record)
    return ResponseModel(data=ProductionSchedulePlanOut.model_validate(new_record))


@router.get("/upph-impact", response_model=ResponseModel[PageResult[UpphImpactPlanOut]])
async def list_upph_impact_plans(
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(20, ge=1, le=200, description="每页数量"),
    department: Optional[str] = Query(None, description="部门筛选"),
    impact_level: Optional[str] = Query(None, description="影响程度筛选（high/medium/low）"),
    keyword: Optional[str] = Query(None, description="关键字筛选（订单/行号/产品/型号/负责人）"),
    schedule_bucket: Optional[str] = Query(None, pattern="^(lean|assembly|packaging|mixed|pending)$"),
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    """
    获取 UPPH 变更影响的排产计划列表（动态计算）
    
    比较当前活跃排产计划中“排产时快照 UPPH”与“当前最新 UPPH”的差异，按影响程度排序，
    用于展示产能变化对已排计划的影响面，支持按部门、影响程度、关键字筛选，支持分页。
    """
    conditions = [ProductionSchedulePlan.is_active == True]
    if department:
        conditions.append(ProductionSchedulePlan.department == department)
    if keyword:
        like = f"%{keyword}%"
        conditions.append(
            or_(
                ProductionSchedulePlan.order_no.ilike(like),
                ProductionSchedulePlan.line_no.ilike(like),
                ProductionSchedulePlan.product_code.ilike(like),
                ProductionSchedulePlan.model_code.ilike(like),
                ProductionSchedulePlan.owner.ilike(like),
            )
        )

    impact_config = await _get_impact_config(db)

    result = await db.execute(
        select(ProductionSchedulePlan)
        .where(*conditions)
        .order_by(ProductionSchedulePlan.plan_date.desc(), ProductionSchedulePlan.id.desc())
    )
    plans = list(result.scalars().all())
    items = await _build_upph_impact_items(db, plans, impact_config=impact_config)

    if impact_level:
        items = [item for item in items if item.impact_level == impact_level]
    if schedule_bucket:
        items = [item for item in items if item.schedule_bucket == schedule_bucket]

    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    return ResponseModel(
        data=PageResult(
            total=total,
            page=page,
            page_size=page_size,
            items=items[start:end],
        )
    )


@router.get("/change-events", response_model=ResponseModel[PageResult[ScheduleChangeEventOut]])
async def list_schedule_change_events(
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(20, ge=1, le=200, description="每页数量"),
    department: Optional[str] = Query(None, description="部门筛选"),
    impact_level: Optional[str] = Query(None, description="影响程度筛选（high/medium/low）"),
    keyword: Optional[str] = Query(None, description="关键字筛选（订单/行号/产品/型号/负责人）"),
    schedule_bucket: Optional[str] = Query(None, pattern="^(lean|assembly|packaging|mixed|pending)$"),
    event_type: Optional[str] = Query(None, pattern="^(upph_change|bucket_change|due_date_change|quantity_change)$"),
    only_pending: bool = Query(False, description="是否只看待处理事件"),
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    conditions = [ProductionSchedulePlan.is_active == True]
    if department:
        conditions.append(ProductionSchedulePlan.department == department)
    if keyword:
        like = f"%{keyword}%"
        conditions.append(
            or_(
                ProductionSchedulePlan.order_no.ilike(like),
                ProductionSchedulePlan.line_no.ilike(like),
                ProductionSchedulePlan.product_code.ilike(like),
                ProductionSchedulePlan.model_code.ilike(like),
                ProductionSchedulePlan.owner.ilike(like),
            )
        )

    result = await db.execute(
        select(ProductionSchedulePlan)
        .where(*conditions)
        .order_by(ProductionSchedulePlan.plan_date.desc(), ProductionSchedulePlan.id.desc())
    )
    plans = list(result.scalars().all())
    impact_config = await _get_impact_config(db)
    items = await _build_schedule_change_event_items(db, plans, impact_config=impact_config)

    if impact_level:
        items = [item for item in items if item.impact_level == impact_level]
    if schedule_bucket:
        items = [item for item in items if item.schedule_bucket == schedule_bucket]
    if event_type:
        items = [item for item in items if item.event_type == event_type]
    if only_pending:
        items = [item for item in items if item.process_status == "pending"]

    stats = {
        "upph_change": sum(1 for item in items if item.event_type == "upph_change"),
        "bucket_change": sum(1 for item in items if item.event_type == "bucket_change"),
        "due_date_change": sum(1 for item in items if item.event_type == "due_date_change"),
        "quantity_change": sum(1 for item in items if item.event_type == "quantity_change"),
        "high": sum(1 for item in items if item.impact_level == "high"),
        "pending": sum(1 for item in items if item.process_status == "pending"),
        "watching": sum(1 for item in items if item.process_status == "watching"),
        "resolved": sum(1 for item in items if item.process_status == "resolved"),
    }
    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    return ResponseModel(data=PageResult(
        total=total,
        page=page,
        page_size=page_size,
        items=items[start:end],
        stats=stats,
    ))


@router.post("/change-events/status", response_model=ResponseModel[ChangeEventStatusUpdateResponse])
async def update_schedule_change_event_status(
    data: ChangeEventStatusUpdateRequest,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "update")),
    db: AsyncSession = Depends(get_db),
):
    event_ids = list(dict.fromkeys(data.event_ids))
    if not event_ids:
        raise HTTPException(status_code=400, detail="请选择需要处理的事件")

    items: List[ChangeEventStatusUpdateItemOut] = []
    for event_id in event_ids:
        plan_id, event_type = _parse_change_event_id(event_id)
        if not plan_id or event_type not in CHANGE_EVENT_TYPE_LABELS:
            items.append(ChangeEventStatusUpdateItemOut(
                event_id=event_id,
                plan_id=0,
                process_status=data.process_status,
                process_status_label=CHANGE_EVENT_PROCESS_STATUS_LABELS.get(data.process_status, data.process_status),
                success=False,
                message="事件标识无效",
            ))
            continue

        plan = await db.get(ProductionSchedulePlan, plan_id)
        if not plan:
            items.append(ChangeEventStatusUpdateItemOut(
                event_id=event_id,
                plan_id=plan_id,
                process_status=data.process_status,
                process_status_label=CHANGE_EVENT_PROCESS_STATUS_LABELS.get(data.process_status, data.process_status),
                success=False,
                message="关联计划不存在",
            ))
            continue

        payload = {
            "event_id": event_id,
            "event_type": event_type,
            "process_status": data.process_status,
            "remark": data.remark or "",
        }
        await _log_schedule_operation(
            db,
            "change_event_status",
            current_user["username"],
            plan_id=plan.id,
            plan_version=plan.plan_version,
            order_no=plan.order_no,
            line_no=plan.line_no,
            remark=json.dumps(payload, ensure_ascii=False),
        )
        items.append(ChangeEventStatusUpdateItemOut(
            event_id=event_id,
            plan_id=plan.id,
            process_status=data.process_status,
            process_status_label=CHANGE_EVENT_PROCESS_STATUS_LABELS.get(data.process_status, data.process_status),
            success=True,
            message="状态已更新",
        ))

    success_count = sum(1 for item in items if item.success)
    failed_count = len(items) - success_count
    return ResponseModel(data=ChangeEventStatusUpdateResponse(
        total=len(items),
        success_count=success_count,
        failed_count=failed_count,
        items=items,
    ))


@router.post("/batch-reschedule", response_model=ResponseModel[BatchRescheduleResponse])
async def batch_reschedule_plans(
    data: BatchRescheduleRequest,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "update")),
    db: AsyncSession = Depends(get_db),
):
    """
    批量重排多个排产计划
    
    对选中的计划逐一按最新订单数据和最新 UPPH 重算，生成新版本计划并标记旧版本为非活跃，
    支持两种模式：
        all_or_none=True：任一条失败则全部回滚
        all_or_none=False：成功几条算几条，失败的单独回滚并记录原因
    """
    plan_ids = list(dict.fromkeys(data.plan_ids))
    if not plan_ids:
        raise HTTPException(status_code=400, detail="请选择需要重排的计划")

    items: List[BatchRescheduleItemOut] = []
    success_count = 0
    new_plan_ids_map = {}

    if data.all_or_none:
        # 模式一：全成功全回滚
        try:
            for plan_id in plan_ids:
                plan_snapshot = await db.get(ProductionSchedulePlan, plan_id)
                if not plan_snapshot:
                    items.append(BatchRescheduleItemOut(
                        plan_id=plan_id,
                        success=False,
                        message="原排产计划不存在",
                    ))
                    raise HTTPException(status_code=400, detail=f"计划 {plan_id} 不存在")
                order_no = plan_snapshot.order_no
                line_no = plan_snapshot.line_no
                new_record = await _reschedule_plan_version(db, plan_id, current_user["username"])
                success_count += 1
                new_plan_ids_map[plan_id] = new_record.id
                items.append(BatchRescheduleItemOut(
                    plan_id=plan_id,
                    new_plan_id=new_record.id,
                    order_no=order_no,
                    line_no=line_no,
                    success=True,
                    message="重排成功",
                ))

            # 全部成功后再统一写操作日志和提交
            await _log_schedule_operation(
                db,
                "batch_reschedule",
                current_user["username"],
                affected_plan_ids=plan_ids,
                remark=f"批量重排 {len(plan_ids)} 条计划（全成功全回滚模式）",
            )
            await db.commit()
            _invalidate_schedule_runtime_caches()

            # 刷新 new record
            for new_plan_id in new_plan_ids_map.values():
                new_record = await db.get(ProductionSchedulePlan, new_plan_id)
                if new_record:
                    await db.refresh(new_record)

        except Exception as exc:
            await db.rollback()
            # 清掉部分成功的结果，全失败
            items = []
            success_count = 0
            for plan_id in plan_ids:
                result = await db.execute(
                    select(ProductionSchedulePlan.order_no, ProductionSchedulePlan.line_no)
                    .where(ProductionSchedulePlan.id == plan_id)
                )
                row = result.first()
                order_no = row.order_no if row else None
                line_no = row.line_no if row else None
                items.append(BatchRescheduleItemOut(
                    plan_id=plan_id,
                    order_no=order_no,
                    line_no=line_no,
                    success=False,
                    message=str(exc.detail) if isinstance(exc, HTTPException) else f"批量重排失败: {exc}",
                ))
    else:
        # 模式二：成功几条算几条（默认）
        for plan_id in plan_ids:
            plan_snapshot = await db.get(ProductionSchedulePlan, plan_id)
            if not plan_snapshot:
                items.append(BatchRescheduleItemOut(
                    plan_id=plan_id,
                    success=False,
                    message="原排产计划不存在",
                ))
                continue
            order_no = plan_snapshot.order_no
            line_no = plan_snapshot.line_no

            try:
                new_record = await _reschedule_plan_version(db, plan_id, current_user["username"])
                new_plan_ids_map[plan_id] = new_record.id
                await _log_schedule_operation(
                    db,
                    "reschedule",
                    current_user["username"],
                    plan_id=new_record.id,
                    plan_version=new_record.plan_version,
                    order_no=new_record.order_no,
                    line_no=new_record.line_no,
                    previous_version_id=plan_id,
                    remark="批量重排中的单条",
                )
                await db.commit()
                _invalidate_schedule_runtime_caches()
                await db.refresh(new_record)
                success_count += 1
                items.append(BatchRescheduleItemOut(
                    plan_id=plan_id,
                    new_plan_id=new_record.id,
                    order_no=order_no,
                    line_no=line_no,
                    success=True,
                    message="重排成功",
                ))
            except HTTPException as exc:
                await db.rollback()
                items.append(BatchRescheduleItemOut(
                    plan_id=plan_id,
                    order_no=order_no,
                    line_no=line_no,
                    success=False,
                    message=str(exc.detail),
                ))
            except Exception as exc:
                await db.rollback()
                items.append(BatchRescheduleItemOut(
                    plan_id=plan_id,
                    order_no=order_no,
                    line_no=line_no,
                    success=False,
                    message=f"重排异常: {exc}",
                ))
        # 批量操作后再写一条总的批量日志
        if success_count > 0:
            await _log_schedule_operation(
                db,
                "batch_reschedule",
                current_user["username"],
                affected_plan_ids=list(new_plan_ids_map.keys()),
                remark=f"批量重排 {len(plan_ids)} 条计划，成功 {success_count} 条",
            )
            await db.commit()
            _invalidate_schedule_runtime_caches()

    # 统计产生新延期预警的条数
    delay_warning_count = 0
    for new_plan_id in new_plan_ids_map.values():
        new_record = await db.get(ProductionSchedulePlan, new_plan_id)
        if new_record and new_record.remark and "延期预警" in new_record.remark:
            delay_warning_count += 1

    return ResponseModel(data=BatchRescheduleResponse(
        total=len(plan_ids),
        success_count=success_count,
        failed_count=len(plan_ids) - success_count,
        delay_warning_count=delay_warning_count,
        items=items,
    ))


@router.get("/history", response_model=ResponseModel[List[ProductionSchedulePlanOut]])
async def list_schedule_plan_history(
    order_no: str = Query(..., description="订单号"),
    line_no: str = Query(..., description="行号"),
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ProductionSchedulePlan)
        .where(
            ProductionSchedulePlan.order_no == order_no,
            ProductionSchedulePlan.line_no == line_no,
        )
        .order_by(ProductionSchedulePlan.plan_version.desc(), ProductionSchedulePlan.id.desc())
    )
    plans = list(result.scalars().all())
    if not plans:
        return ResponseModel(data=[])

    promised_date_map = await _build_promised_date_map(db, plans)
    order_line_map = await _build_latest_order_line_map(db, plans)
    upph_service = UpphCalculationService(db)
    schedule_context_cache: dict[tuple[Optional[str], Optional[str]], dict] = {}
    items: List[ProductionSchedulePlanOut] = []
    for plan in plans:
        order_line = order_line_map.get((plan.order_no, plan.line_no))
        product_code = (order_line.product_code if order_line else None) or plan.product_code or plan.source_product_code
        bom_no = _get_order_line_bom_code(order_line) if order_line else None
        schedule_context = None
        cache_key = (product_code, bom_no)
        if product_code or bom_no:
            if cache_key not in schedule_context_cache:
                schedule_context_cache[cache_key] = await upph_service.summarize_schedule_context(
                    product_code=product_code,
                    bom_code=bom_no,
                )
            schedule_context = schedule_context_cache[cache_key]
        items.append(_serialize_schedule_plan(
            plan,
            promised_date_map,
            bom_no=bom_no,
            schedule_context=schedule_context,
        ))
    return ResponseModel(data=items)


@router.get("/operation-logs", response_model=ResponseModel[PageResult[ProductionScheduleOperationLogOut]])
async def list_operation_logs(
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(20, ge=1, le=200, description="每页数量"),
    plan_id: Optional[int] = Query(None, description="排产计划ID筛选"),
    order_no: Optional[str] = Query(None, description="订单号筛选"),
    operation_type: Optional[str] = Query(None, description="操作类型筛选"),
    operator: Optional[str] = Query(None, description="操作人筛选"),
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    """查询排产操作日志（表不存在时返回空）"""
    try:
        conditions = []
        if plan_id:
            conditions.append(ProductionScheduleOperationLog.plan_id == plan_id)
        if order_no:
            conditions.append(ProductionScheduleOperationLog.order_no == order_no)
        if operation_type:
            conditions.append(ProductionScheduleOperationLog.operation_type == operation_type)
        if operator:
            conditions.append(ProductionScheduleOperationLog.operator == operator)

        # 先查总数
        count_stmt = select(func.count(ProductionScheduleOperationLog.id))
        if conditions:
            count_stmt = count_stmt.where(*conditions)
        count_result = await db.execute(count_stmt)
        total = count_result.scalar()

        # 再查分页数据
        stmt = (
            select(ProductionScheduleOperationLog)
            .order_by(ProductionScheduleOperationLog.operation_at.desc(), ProductionScheduleOperationLog.id.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
        if conditions:
            stmt = stmt.where(*conditions)
        result = await db.execute(stmt)
        items = result.scalars().all()
        serialized_items = [ProductionScheduleOperationLogOut.model_validate(log) for log in items]

        return ResponseModel(
            data=PageResult(
                total=total,
                page=page,
                page_size=page_size,
                items=serialized_items,
            )
        )
    except Exception as exc:
        # 表不存在或其他数据库错误时返回空列表
        from sqlalchemy.exc import ProgrammingError
        if isinstance(exc, ProgrammingError) and "does not exist" in str(exc):
            return ResponseModel(
                data=PageResult(
                    total=0,
                    page=page,
                    page_size=page_size,
                    items=[],
                )
            )
        raise


@router.get("/debug-trace", response_model=ResponseModel[dict])
async def get_schedule_debug_trace(
    order_no: str = Query(..., min_length=1),
    line_no: str = Query(..., min_length=1),
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    request_started_at = perf_counter()
    timings_ms: dict[str, float] = {}
    normalized_order_no = order_no.strip()
    normalized_line_no = line_no.strip()

    step_started_at = perf_counter()
    order_line = (
        await db.execute(
            select(SaleOrderLine)
            .where(
                SaleOrderLine.order_no == normalized_order_no,
                SaleOrderLine.line_no == normalized_line_no,
            )
            .order_by(SaleOrderLine.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    timings_ms["order_line_query"] = round((perf_counter() - step_started_at) * 1000, 2)
    if not order_line:
        raise HTTPException(status_code=404, detail="未找到对应订单行")

    step_started_at = perf_counter()
    snapshot = (
        await db.execute(
            select(ProductionOrderScheduleSnapshot)
            .where(
                ProductionOrderScheduleSnapshot.order_no == normalized_order_no,
                ProductionOrderScheduleSnapshot.line_no == normalized_line_no,
            )
            .order_by(ProductionOrderScheduleSnapshot.snapshot_updated_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    timings_ms["snapshot_query"] = round((perf_counter() - step_started_at) * 1000, 2)
    step_started_at = perf_counter()
    active_plan = (
        await db.execute(
            select(ProductionSchedulePlan)
            .where(
                ProductionSchedulePlan.order_no == normalized_order_no,
                ProductionSchedulePlan.line_no == normalized_line_no,
                ProductionSchedulePlan.is_active == True,
            )
            .order_by(ProductionSchedulePlan.updated_at.desc(), ProductionSchedulePlan.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    timings_ms["active_plan_query"] = round((perf_counter() - step_started_at) * 1000, 2)

    bom_no = _get_order_line_bom_code(order_line) or getattr(snapshot, "bom_no", None)
    product_code = order_line.product_code or getattr(snapshot, "product_code", None) or getattr(active_plan, "product_code", None)

    split_service = AssemblyRollScheduleService(db)
    step_started_at = perf_counter()
    split_rules = await split_service.get_stage_rules(bom_no=bom_no)
    timings_ms["split_rules"] = round((perf_counter() - step_started_at) * 1000, 2)
    upph_service = UpphCalculationService(db)
    step_started_at = perf_counter()
    capacities = await upph_service.get_matched_capacities(product_code=product_code, bom_code=bom_no)
    timings_ms["matched_capacities"] = round((perf_counter() - step_started_at) * 1000, 2)
    step_started_at = perf_counter()
    schedule_context = await upph_service.summarize_schedule_context(
        product_code=product_code,
        bom_code=bom_no,
        preloaded_split_rules=split_rules if bom_no else None,
    )
    timings_ms["schedule_context"] = round((perf_counter() - step_started_at) * 1000, 2)
    serialized_capacities = [_serialize_debug_capacity_record(item) for item in capacities]
    report = _build_schedule_debug_report(
        bom_no=bom_no,
        snapshot=snapshot,
        active_plan=active_plan,
        serialized_capacities=serialized_capacities,
        schedule_context=schedule_context,
        split_rules=split_rules,
    )
    timings_ms["total"] = round((perf_counter() - request_started_at) * 1000, 2)

    return ResponseModel(data={
        "query": {
            "order_no": normalized_order_no,
            "line_no": normalized_line_no,
        },
        "report": report,
        "timings_ms": timings_ms,
        "order_line": {
            "id": int(order_line.id or 0),
            "order_no": order_line.order_no,
            "line_no": order_line.line_no,
            "product_code": order_line.product_code,
            "product_model": order_line.product_model,
            "bom_no": bom_no,
            "order_qty": float(order_line.order_qty or 0),
            "promised_date": order_line.promised_date.isoformat() if order_line.promised_date else None,
            "updated_at": order_line.updated_at.isoformat() if order_line.updated_at else None,
        },
        "snapshot": (
            {
                "id": int(snapshot.id or 0),
                "schedule_bucket_snapshot": snapshot.schedule_bucket_snapshot,
                "schedule_bucket_label": snapshot.schedule_bucket_label,
                "upph_snapshot": float(snapshot.upph_snapshot or 0) if snapshot.upph_snapshot is not None else None,
                "display_status": snapshot.display_status,
                "display_status_label": snapshot.display_status_label,
                "scheduling_reason": snapshot.scheduling_reason,
                "scheduling_reason_details": _deserialize_snapshot_details(snapshot.scheduling_reason_details_json),
                "work_hour_summary": snapshot.work_hour_summary,
                "recommended_daily_hours": float(snapshot.recommended_daily_hours or 0) if snapshot.recommended_daily_hours is not None else None,
                "capacity_load_status": snapshot.capacity_load_status,
                "capacity_load_status_label": snapshot.capacity_load_status_label,
                "snapshot_updated_at": snapshot.snapshot_updated_at.isoformat() if snapshot.snapshot_updated_at else None,
            }
            if snapshot else None
        ),
        "active_plan": (
            {
                "id": int(active_plan.id or 0),
                "plan_version": int(active_plan.plan_version or 1),
                "plan_date": active_plan.plan_date.isoformat() if active_plan.plan_date else None,
                "start_date": active_plan.start_date.isoformat() if active_plan.start_date else None,
                "end_date": active_plan.end_date.isoformat() if active_plan.end_date else None,
                "upph": float(active_plan.upph or 0) if active_plan.upph is not None else None,
                "source_upph": float(active_plan.source_upph or 0) if active_plan.source_upph is not None else None,
                "source_process_type": active_plan.source_process_type,
                "needs_reschedule": bool(active_plan.needs_reschedule),
                "reschedule_reason": active_plan.reschedule_reason,
                "remark": active_plan.remark,
                "updated_at": active_plan.updated_at.isoformat() if active_plan.updated_at else None,
            }
            if active_plan else None
        ),
        "upph_debug": {
            "bom_match_candidates": UpphCalculationService.build_bom_match_candidates(bom_no),
            "matched_capacity_count": len(capacities),
            "matched_capacities": serialized_capacities,
            "schedule_context": {
                "schedule_bucket": schedule_context.get("schedule_bucket"),
                "matched_buckets": schedule_context.get("matched_buckets"),
                "total_upph": schedule_context.get("total_upph"),
                "workshop_names": schedule_context.get("workshop_names"),
                "schedulable_workshop_names": schedule_context.get("schedulable_workshop_names"),
                "non_schedulable_reasons": schedule_context.get("non_schedulable_reasons"),
                "split_price_main_id": schedule_context.get("split_price_main_id"),
                "split_rule_ready": schedule_context.get("split_rule_ready"),
            },
            "split_rules": split_rules,
        },
    })


# ============ 一键排产相关API ============

@router.get("/orders-for-scheduling", response_model=ResponseModel[PageResult[OrderForSchedulingOut]])
async def list_orders_for_scheduling(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    keyword: Optional[str] = Query(None),
    risk_level: Optional[str] = Query(None),
    only_unscheduled: bool = Query(False),
    schedule_bucket: Optional[str] = Query(None, pattern="^(lean|assembly|packaging|mixed|pending)$"),
    scheduling_status: Optional[str] = Query(None, pattern="^(workbench|ready|pending|excluded|scheduled)$"),
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    """获取当月交期的订单列表，用于排产"""
    items, total, stats = await _build_order_scheduling_items(
        db,
        page=page,
        page_size=page_size,
        year=year,
        month=month,
        keyword=keyword,
        risk_level=risk_level,
        only_unscheduled=only_unscheduled,
        schedule_bucket=schedule_bucket,
        scheduling_status=scheduling_status,
    )
    return ResponseModel(data=PageResult(total=total, page=page, page_size=page_size, items=items, stats=stats))


@router.get("/todo-workbench", response_model=ResponseModel[PageResult[TodoWorkbenchItemOut]])
async def list_todo_workbench(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    keyword: Optional[str] = Query(None),
    risk_level: Optional[str] = Query(None),
    schedule_bucket: Optional[str] = Query(None, pattern="^(lean|assembly|packaging|mixed|pending)$"),
    todo_status: Optional[str] = Query(None, pattern="^(ready|pending|reschedule)$"),
    skip_snapshot_reconcile: bool = Query(False),
    read_context: dict = Depends(_get_production_schedule_read_context),
):
    request_started_at = perf_counter()
    timings_ms: dict[str, float] = {}
    dependency_timings_ms = dict(read_context.get("dependency_timings_ms") or {})
    db: AsyncSession = read_context["db"]
    cache_key = (
        page,
        page_size,
        year or 0,
        month or 0,
        keyword or "",
        risk_level or "",
        schedule_bucket or "",
        todo_status or "",
        int(skip_snapshot_reconcile),
    )
    stats = {
        "ready": 0,
        "pending": 0,
        "reschedule": 0,
        "missing_upph": 0,
        "bucket_counts": {
            "all": 0,
            "lean": 0,
            "assembly": 0,
            "packaging": 0,
        },
    }

    try:
        cached_page = _get_runtime_page_cache(
            _todo_workbench_cache,
            cache_key,
            ttl_seconds=TODO_WORKBENCH_CACHE_TTL_SECONDS,
        )
        if cached_page is not None:
            logger.info(
                "todo-workbench timing page=%s page_size=%s total=%s todo_status=%s bucket=%s keyword=%s timings_ms=%s",
                page,
                page_size,
                cached_page.total,
                todo_status or "all",
                schedule_bucket or "all",
                bool(keyword),
                {"cache_hit": True},
            )
            return ResponseModel(data=cached_page)
        today = date.today()
        target_year = year or today.year
        target_month = month or today.month
        first_day = date(target_year, target_month, 1)
        if target_month == 12:
            last_day = date(target_year + 1, 1, 1) - timedelta(days=1)
        else:
            last_day = date(target_year, target_month + 1, 1) - timedelta(days=1)

        step_started_at = perf_counter()
        await _ensure_order_snapshot_table(db)
        timings_ms["ensure_snapshot_table"] = round((perf_counter() - step_started_at) * 1000, 2)
        updated_scheduled_snapshot_count = 0
        if not skip_snapshot_reconcile:
            step_started_at = perf_counter()
            updated_scheduled_snapshot_count = await _sync_month_scheduled_snapshot_flags(
                db,
                first_day=first_day,
                last_day=last_day,
            )
            timings_ms["sync_scheduled_snapshots"] = round((perf_counter() - step_started_at) * 1000, 2)
        snapshot_stats_base_conditions = [
            ProductionOrderScheduleSnapshot.promised_date >= first_day,
            ProductionOrderScheduleSnapshot.promised_date <= last_day,
            ProductionOrderScheduleSnapshot.display_status.in_(["ready", "pending"]),
        ]
        if risk_level:
            snapshot_stats_base_conditions.append(ProductionOrderScheduleSnapshot.risk_level == risk_level)
        if keyword:
            like = f"%{keyword}%"
            snapshot_stats_base_conditions.append(
                or_(
                    ProductionOrderScheduleSnapshot.order_no.ilike(like),
                    ProductionOrderScheduleSnapshot.line_no.ilike(like),
                    ProductionOrderScheduleSnapshot.product_code.ilike(like),
                    ProductionOrderScheduleSnapshot.product_model.ilike(like),
                    ProductionOrderScheduleSnapshot.bom_no.ilike(like),
                )
            )
        if schedule_bucket:
            snapshot_bucket_condition = _build_workspace_bucket_filter_condition(
                ProductionOrderScheduleSnapshot.schedule_bucket_snapshot,
                schedule_bucket,
            )
            if snapshot_bucket_condition is not None:
                snapshot_stats_base_conditions.append(snapshot_bucket_condition)

        snapshot_stats_stmt = (
            select(
                ProductionOrderScheduleSnapshot.display_status,
                ProductionOrderScheduleSnapshot.schedule_bucket_snapshot,
                func.count().label("item_count"),
                func.sum(
                    case((ProductionOrderScheduleSnapshot.is_missing_upph == True, 1), else_=0)
                ).label("missing_upph_count"),
            )
            .select_from(ProductionOrderScheduleSnapshot)
            .where(*snapshot_stats_base_conditions)
            .group_by(
                ProductionOrderScheduleSnapshot.display_status,
                ProductionOrderScheduleSnapshot.schedule_bucket_snapshot,
            )
        )
        step_started_at = perf_counter()
        for display_status_value, bucket_value, item_count, missing_upph_count in (await db.execute(snapshot_stats_stmt)).all():
            status_key = str(display_status_value or "")
            if status_key in {"ready", "pending"}:
                stats[status_key] += int(item_count or 0)
                stats["missing_upph"] += int(missing_upph_count or 0)
            for workspace_bucket in _resolve_workspace_bucket_hits(bucket_value):
                stats["bucket_counts"][workspace_bucket] += int(item_count or 0)
        timings_ms["snapshot_stats"] = round((perf_counter() - step_started_at) * 1000, 2)

        order_items: List[TodoWorkbenchItemOut] = []
        order_total = 0
        if todo_status != "reschedule":
            snapshot_status_condition = ProductionOrderScheduleSnapshot.display_status.in_(["ready", "pending"])
            if todo_status in {"ready", "pending"}:
                snapshot_status_condition = ProductionOrderScheduleSnapshot.display_status == todo_status

            snapshot_base_conditions = [
                ProductionOrderScheduleSnapshot.promised_date >= first_day,
                ProductionOrderScheduleSnapshot.promised_date <= last_day,
                snapshot_status_condition,
            ]
            if risk_level:
                snapshot_base_conditions.append(ProductionOrderScheduleSnapshot.risk_level == risk_level)
            if keyword:
                like = f"%{keyword}%"
                snapshot_base_conditions.append(
                    or_(
                        ProductionOrderScheduleSnapshot.order_no.ilike(like),
                        ProductionOrderScheduleSnapshot.line_no.ilike(like),
                        ProductionOrderScheduleSnapshot.product_code.ilike(like),
                        ProductionOrderScheduleSnapshot.product_model.ilike(like),
                        ProductionOrderScheduleSnapshot.bom_no.ilike(like),
                    )
                )
            snapshot_conditions = list(snapshot_base_conditions)
            if schedule_bucket:
                snapshot_bucket_condition = _build_workspace_bucket_filter_condition(
                    ProductionOrderScheduleSnapshot.schedule_bucket_snapshot,
                    schedule_bucket,
                )
                if snapshot_bucket_condition is not None:
                    snapshot_conditions.append(snapshot_bucket_condition)

            snapshot_base_stmt = (
                select(ProductionOrderScheduleSnapshot)
                .where(*snapshot_conditions)
            )
            if todo_status == "ready":
                order_total = stats["ready"]
            elif todo_status == "pending":
                order_total = stats["pending"]
            else:
                order_total = stats["ready"] + stats["pending"]

        reschedule_items: List[TodoWorkbenchItemOut] = []
        reschedule_total = 0
        effective_reschedule_map: dict[int, dict[str, object]] = {}
        plan_conditions = [ProductionSchedulePlan.is_active == True, ProductionSchedulePlan.needs_reschedule == True]
        if schedule_bucket:
            plan_bucket_condition = _build_workspace_bucket_filter_condition(
                ProductionSchedulePlan.source_process_type,
                schedule_bucket,
            )
            if plan_bucket_condition is not None:
                plan_conditions.append(plan_bucket_condition)
        if keyword:
            like = f"%{keyword}%"
            plan_conditions.append(
                or_(
                    ProductionSchedulePlan.order_no.ilike(like),
                    ProductionSchedulePlan.line_no.ilike(like),
                    ProductionSchedulePlan.product_code.ilike(like),
                    ProductionSchedulePlan.source_product_code.ilike(like),
                )
            )
        step_started_at = perf_counter()
        effective_plan_rows = list((
            await db.execute(
                select(ProductionSchedulePlan)
                .where(*plan_conditions)
                .order_by(ProductionSchedulePlan.plan_date.asc(), ProductionSchedulePlan.id.asc())
            )
        ).scalars().all())
        timings_ms["reschedule_plan_query"] = round((perf_counter() - step_started_at) * 1000, 2)
        step_started_at = perf_counter()
        plan_snapshot_map = await _load_order_snapshot_map_by_keys(
            db,
            {
                (plan.order_no, plan.line_no)
                for plan in effective_plan_rows
                if plan.order_no and plan.line_no
            },
        )
        effective_plan_rows = [
            plan
            for plan in effective_plan_rows
            if _is_date_in_range(
                (
                    getattr(plan_snapshot_map.get((plan.order_no, plan.line_no)), "promised_date", None)
                    or plan.source_promised_date
                    or plan.end_date
                    or plan.plan_date
                ),
                first_day=first_day,
                last_day=last_day,
            )
        ]
        timings_ms["reschedule_supporting_queries"] = round((perf_counter() - step_started_at) * 1000, 2)
        stats["reschedule"] = len(effective_plan_rows)
        step_started_at = perf_counter()
        for plan in effective_plan_rows:
            effective_bucket = _normalize_plan_source_bucket(plan.source_process_type)
            for workspace_bucket in _resolve_workspace_bucket_hits(effective_bucket):
                stats["bucket_counts"][workspace_bucket] += 1

        if todo_status != "ready" and todo_status != "pending":
            reschedule_items = [
                TodoWorkbenchItemOut(
                    id=plan.id,
                    todo_source="change_event",
                    todo_kind="reschedule",
                    todo_due_date=(
                        getattr(plan_snapshot_map.get((plan.order_no, plan.line_no)), "promised_date", None)
                        or plan.source_promised_date
                        or plan.end_date
                        or plan.plan_date
                    ),
                    todo_status_label="待重排",
                    todo_action_label="建议重排",
                    order_no=plan.order_no or "-",
                    line_no=plan.line_no or "-",
                    bom_no=getattr(plan_snapshot_map.get((plan.order_no, plan.line_no)), "bom_no", None),
                    product_code=plan.source_product_code or plan.product_code,
                    product_model=plan.source_product_model or plan.model_code,
                    model_code=plan.model_code,
                    order_qty=float(plan.source_order_qty or plan.quantity or 0),
                    quantity=float(plan.quantity or 0),
                    promised_date=(
                        getattr(plan_snapshot_map.get((plan.order_no, plan.line_no)), "promised_date", None)
                        or plan.source_promised_date
                    ),
                    source_promised_date=(
                        getattr(plan_snapshot_map.get((plan.order_no, plan.line_no)), "promised_date", None)
                        or plan.source_promised_date
                    ),
                    owner=plan.owner,
                    upph=float(plan.upph or 0),
                    source_upph=float(plan.source_upph or 0),
                    has_schedule=True,
                    schedule_bucket=_normalize_plan_source_bucket(plan.source_process_type),
                    schedule_bucket_label=SCHEDULE_BUCKET_LABELS.get(_normalize_plan_source_bucket(plan.source_process_type)),
                    scheduling_status="scheduled",
                    scheduling_status_label="已排产",
                    display_status="pending",
                    display_status_label="待确认",
                    scheduling_reason_code="reschedule_needed",
                    scheduling_reason=(plan.reschedule_reason or "计划发生变化，建议重排"),
                    scheduling_reason_details=[
                        item
                        for item in [
                            plan.reschedule_reason,
                        ]
                        if item
                    ],
                    is_missing_upph=False,
                    plan_date=plan.plan_date,
                    start_date=plan.start_date,
                    end_date=plan.end_date,
                    plan_version=plan.plan_version,
                    previous_plan_id=plan.previous_plan_id,
                    needs_reschedule=True,
                    impact_level=None,
                    impact_score=None,
                    impact_reason=plan.reschedule_reason,
                    reschedule_reason=plan.reschedule_reason,
                )
                for plan in effective_plan_rows
            ]
            reschedule_total = len(reschedule_items)
        timings_ms["reschedule_serialize"] = round((perf_counter() - step_started_at) * 1000, 2)

        total = order_total + reschedule_total
        stats["bucket_counts"]["all"] = total
        start = (page - 1) * page_size
        end = start + page_size
        if todo_status != "reschedule":
            snapshot_offset = max(0, start - reschedule_total)
            snapshot_limit = max(0, end - max(start, reschedule_total))
            if snapshot_limit > 0:
                ready_priority = case(
                    (ProductionOrderScheduleSnapshot.display_status == "ready", 0),
                    else_=1,
                )
                step_started_at = perf_counter()
                snapshot_rows = (
                    await db.execute(
                        snapshot_base_stmt
                        .order_by(
                            ready_priority.asc(),
                            ProductionOrderScheduleSnapshot.promised_date.asc(),
                            ProductionOrderScheduleSnapshot.order_no.asc(),
                            ProductionOrderScheduleSnapshot.line_no.asc(),
                        )
                        .offset(snapshot_offset)
                        .limit(snapshot_limit)
                    )
                ).scalars().all()
                timings_ms["snapshot_page_query"] = round((perf_counter() - step_started_at) * 1000, 2)
                step_started_at = perf_counter()
                order_items = [
                    TodoWorkbenchItemOut(
                        id=snapshot.sale_order_line_id or snapshot.id,
                        todo_source="order_pool",
                        todo_kind=str(snapshot.display_status or "pending"),
                        todo_due_date=snapshot.promised_date,
                        todo_status_label="待排产" if str(snapshot.display_status or "pending") == "ready" else "待确认",
                        todo_action_label="建议排产" if str(snapshot.display_status or "pending") == "ready" else "先确认条件",
                        order_no=snapshot.order_no or "-",
                        line_no=snapshot.line_no or "-",
                        customer=snapshot.customer,
                        bom_no=snapshot.bom_no,
                        product_code=snapshot.product_code,
                        product_model=snapshot.product_model,
                        model_code=snapshot.product_model,
                        order_qty=float(snapshot.order_qty or 0),
                        quantity=float(snapshot.order_qty or 0),
                        promised_date=snapshot.promised_date,
                        source_promised_date=snapshot.promised_date,
                        risk_level=snapshot.risk_level,
                        status=None,
                        owner=None,
                        upph=float(snapshot.upph_snapshot or 0),
                        current_upph=float(snapshot.upph_snapshot or 0),
                        source_upph=float(snapshot.upph_snapshot or 0),
                        has_schedule=False,
                        schedule_bucket=snapshot.schedule_bucket_snapshot,
                        schedule_bucket_label=snapshot.schedule_bucket_label,
                        scheduling_status=snapshot.scheduling_status,
                        scheduling_status_label=snapshot.scheduling_status_label,
                        display_status=snapshot.display_status,
                        display_status_label=snapshot.display_status_label,
                        scheduling_reason_code=snapshot.scheduling_reason_code,
                        scheduling_reason=snapshot.scheduling_reason,
                        scheduling_reason_details=_deserialize_snapshot_details(snapshot.scheduling_reason_details_json),
                        is_missing_upph=bool(snapshot.is_missing_upph),
                        target_ready_date=snapshot.target_ready_date,
                        ready_offset_days=int(snapshot.ready_offset_days or READY_OFFSET_DAYS),
                        total_hours=float(snapshot.total_hours) if snapshot.total_hours is not None else None,
                        available_production_days=snapshot.available_production_days,
                        required_daily_hours=float(snapshot.required_daily_hours) if snapshot.required_daily_hours is not None else None,
                        recommended_daily_hours=float(snapshot.recommended_daily_hours) if snapshot.recommended_daily_hours is not None else None,
                        capacity_load_status=snapshot.capacity_load_status,
                        capacity_load_status_label=snapshot.capacity_load_status_label,
                        sunday_rest_allowed=snapshot.sunday_rest_allowed,
                        needs_sunday_work=snapshot.needs_sunday_work,
                        needs_move_earlier=snapshot.needs_move_earlier,
                        move_earlier_days=snapshot.move_earlier_days,
                        work_hour_summary=snapshot.work_hour_summary,
                    )
                    for snapshot in snapshot_rows
                ]
                timings_ms["snapshot_serialize"] = round((perf_counter() - step_started_at) * 1000, 2)

        page_items = reschedule_items[start:end]
        if len(page_items) < page_size:
            page_items.extend(order_items[: page_size - len(page_items)])
        timings_ms["total"] = round((perf_counter() - request_started_at) * 1000, 2)
        logger.info(
            "todo-workbench timing page=%s page_size=%s total=%s todo_status=%s bucket=%s keyword=%s timings_ms=%s",
            page,
            page_size,
            total,
            todo_status or "all",
            schedule_bucket or "all",
            bool(keyword),
            {**timings_ms, "synced_scheduled_snapshots": updated_scheduled_snapshot_count},
        )
        page_result = PageResult(
            total=total,
            page=page,
            page_size=page_size,
            items=page_items,
            stats={
                **stats,
                "dependency_timings_ms": dependency_timings_ms,
                "timings_ms": timings_ms,
                "synced_scheduled_snapshots": updated_scheduled_snapshot_count,
            },
        )
        _set_runtime_page_cache(_todo_workbench_cache, cache_key, page_result)
        return ResponseModel(data=page_result)
    except Exception as e:
        logger.exception("todo-workbench error timings_ms=%s", timings_ms)

    return ResponseModel(
        data=PageResult(
            total=0,
            page=page,
            page_size=page_size,
            items=[],
            stats=stats,
        )
    )


@router.post("/todo-workbench/refresh-snapshots", response_model=ResponseModel[TodoSnapshotRefreshResponse])
async def refresh_todo_workbench_snapshots(
    data: TodoSnapshotRefreshRequest,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    rows = await _query_todo_snapshot_source_rows(
        db,
        year=data.year,
        month=data.month,
        keyword=data.keyword,
        risk_level=data.risk_level,
        limit=data.limit,
    )
    await _ensure_order_snapshot_table(db)
    snapshot_map = await _load_order_snapshot_map(db, rows)
    stale_rows = [
        row for row in rows
        if _is_snapshot_stale(
            snapshot_map.get((row.SaleOrderLine.order_no, row.SaleOrderLine.line_no)),
            row.SaleOrderLine,
        )
    ]
    if rows:
        # Manual refresh is intentionally forceful so UPPH/process updates
        # can be propagated to order snapshots even when order lines themselves
        # did not change.
        await _refresh_order_schedule_snapshots(db, rows, force_refresh=True)

    month_scope = f"{data.year or date.today().year}-{str(data.month or date.today().month).zfill(2)}"
    return ResponseModel(
        data=TodoSnapshotRefreshResponse(
            matched_total=len(rows),
            stale_total=len(stale_rows),
            refreshed_total=len(rows),
            skipped_total=0,
            month_scope=month_scope,
        )
    )


@router.get("/work-hours-config", response_model=ResponseModel[dict])
async def get_work_hours_config(
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    """获取每日工作时间配置"""
    work_hours_config = await ProductionScheduleConfigService(db).get_work_hours_config()
    return ResponseModel(data={
        "daily_work_hours": work_hours_config["default_daily_work_hours"],
        "work_hours_by_bucket": work_hours_config["work_hours_by_bucket"],
        "ready_offset_days": work_hours_config["ready_offset_days"],
        "lean_standard_daily_hours": work_hours_config["lean_standard_daily_hours"],
        "lean_max_daily_hours": work_hours_config["lean_max_daily_hours"],
    })


@router.post("/simulate-lean", response_model=ResponseModel[ProductionSimulationResponse])
async def simulate_lean_schedule(
    data: ProductionSimulationRequest,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    """生产侧精益排产试算，不依赖订单池，仅验证规则本身。"""
    simulation_service = ScheduleSimulationService(db)
    lean_workhour_plan = simulation_service.build_lean_workhour_plan(
        quantity=float(data.quantity),
        upph=float(data.upph),
        promised_date=data.promised_date,
    )
    if not lean_workhour_plan:
        raise HTTPException(status_code=400, detail="试算参数无效，请检查数量、UPPH、交期")

    resolved_daily_hours = await simulation_service.resolve_daily_work_hours(
        schedule_bucket="lean",
        daily_work_hours=None,
        lean_workhour_plan=lean_workhour_plan,
    )
    calculation_result = simulation_service.calculate_schedule_result(
        quantity=float(data.quantity),
        upph=float(data.upph),
        daily_hours=float(resolved_daily_hours),
        promised_date=data.promised_date,
        schedule_bucket="lean",
        lean_workhour_plan=lean_workhour_plan,
    )
    if data.consider_existing_plans:
        calculation_result, lean_workhour_plan = await _resolve_conflict_aware_lean_plan(
            db,
            department=data.department,
            calculation_result=calculation_result,
            lean_workhour_plan=lean_workhour_plan,
        )

    explanation_steps = _build_simulation_explanation_steps(
        quantity=float(data.quantity),
        upph=float(data.upph),
        promised_date=data.promised_date,
        calculation_result=calculation_result,
        consider_existing_plans=data.consider_existing_plans,
    )
    return ResponseModel(data=ProductionSimulationResponse(
        department=data.department,
        quantity=float(data.quantity),
        upph=float(data.upph),
        promised_date=data.promised_date,
        target_ready_date=calculation_result.get("target_ready_date"),
        total_hours=calculation_result.get("total_hours"),
        days_needed=int(calculation_result.get("days_needed") or 0),
        recommended_daily_hours=float(calculation_result.get("recommended_daily_hours") or 0),
        capacity_load_status=calculation_result.get("capacity_load_status"),
        capacity_load_status_label=calculation_result.get("capacity_load_status_label"),
        sunday_rest_allowed=lean_workhour_plan.get("sunday_rest_allowed"),
        needs_sunday_work=calculation_result.get("needs_sunday_work"),
        needs_move_earlier=calculation_result.get("needs_move_earlier"),
        move_earlier_days=calculation_result.get("move_earlier_days"),
        start_date=calculation_result.get("start_date"),
        end_date=calculation_result.get("end_date"),
        plan_date=calculation_result.get("start_date"),
        warning=calculation_result.get("warning"),
        work_hour_summary=calculation_result.get("work_hour_summary"),
        explanation_steps=explanation_steps,
    ))


@router.post("/auto-schedule", response_model=ResponseModel[AutoScheduleResponse])
async def auto_schedule(
    data: AutoScheduleRequest,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "create")),
    db: AsyncSession = Depends(get_db),
):
    """一键排产"""
    records, calculation_result, response_message = await _create_schedule_plan_from_request(
        db,
        order_no=data.order_no,
        line_no=data.line_no,
        department=data.department,
        plan_date=data.plan_date,
        upph=data.upph,
        daily_work_hours=data.daily_work_hours,
        owner=data.owner,
        operator=current_user["username"],
    )
    await db.commit()
    await _sync_snapshot_schedule_state_for_keys(
        db,
        {
            (record.order_no, record.line_no)
            for record in records
            if record.order_no and record.line_no
        },
    )
    _invalidate_schedule_runtime_caches()
    for record in records:
        await db.refresh(record)
    primary_record = records[0] if records else None

    return ResponseModel(data=AutoScheduleResponse(
        success=True,
        message=response_message,
        schedule_plan=ProductionSchedulePlanOut.model_validate(primary_record) if primary_record else None,
        calculation_result=calculation_result,
    ))


@router.post("/batch-auto-schedule", response_model=ResponseModel[BatchAutoScheduleResponse])
async def batch_auto_schedule(
    data: BatchAutoScheduleRequest,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "create")),
    db: AsyncSession = Depends(get_db),
):
    """批量排产，统一返回成功/失败明细"""
    deduplicated_items = list(
        {
            (item.order_no, item.line_no): item
            for item in data.items
            if item.order_no and item.line_no
        }.values()
    )
    if not deduplicated_items:
        raise HTTPException(status_code=400, detail="请先选择需要排产的订单")

    items: List[BatchAutoScheduleItemOut] = []
    success_count = 0
    delay_warning_count = 0
    created_plan_ids: list[int] = []
    synced_keys: set[tuple[str, str]] = set()

    for item in deduplicated_items:
        try:
            records, calculation_result, response_message = await _create_schedule_plan_from_request(
                db,
                order_no=item.order_no,
                line_no=item.line_no,
                department=data.department,
                plan_date=data.plan_date,
                upph=item.upph,
                daily_work_hours=data.daily_work_hours,
                owner=data.owner,
                operator=current_user["username"],
                fail_if_scheduled=True,
                operation_remark="批量排产创建",
            )
            await db.commit()
            synced_keys.update({
                (record.order_no, record.line_no)
                for record in records
                if record.order_no and record.line_no
            })
            _invalidate_schedule_runtime_caches()
            for record in records:
                await db.refresh(record)

            success_count += 1
            created_plan_ids.extend([record.id for record in records if record.id])
            warning = next((record.remark for record in records if record.remark), None)
            if warning and "延期预警" in warning:
                delay_warning_count += 1
            items.append(BatchAutoScheduleItemOut(
                order_no=item.order_no,
                line_no=item.line_no,
                success=True,
                plan_id=records[0].id if records else None,
                message=response_message,
                warning=warning,
            ))
        except HTTPException as exc:
            await db.rollback()
            items.append(BatchAutoScheduleItemOut(
                order_no=item.order_no,
                line_no=item.line_no,
                success=False,
                message=str(exc.detail),
            ))
        except Exception as exc:
            await db.rollback()
            items.append(BatchAutoScheduleItemOut(
                order_no=item.order_no,
                line_no=item.line_no,
                success=False,
                message=f"排产异常: {exc}",
            ))

    if created_plan_ids:
        await _log_schedule_operation(
            db,
            "batch_create",
            current_user["username"],
            affected_plan_ids=created_plan_ids,
            remark=f"批量排产 {len(deduplicated_items)} 条订单，成功 {success_count} 条",
        )
        await db.commit()
        await _sync_snapshot_schedule_state_for_keys(db, synced_keys)
        _invalidate_schedule_runtime_caches()

    return ResponseModel(data=BatchAutoScheduleResponse(
        total=len(deduplicated_items),
        success_count=success_count,
        failed_count=len(deduplicated_items) - success_count,
        delay_warning_count=delay_warning_count,
        items=items,
    ))


@router.get("/missing-upph-products", response_model=ResponseModel[MissingUpphListOut])
async def list_missing_upph_products(
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    keyword: Optional[str] = Query(None),
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    """获取当月订单中缺少 UPPH 的产品列表（临时降级，等快照化架构落地后恢复）"""
    empty_state = EmptyStateOut(
        code="temporarily_unavailable",
        message="此功能正在优化中，暂时不可用。"
    )
    return ResponseModel(data=MissingUpphListOut(items=[], empty_state=empty_state))

    empty_state = None
    if not products:
        empty_state = EmptyStateOut(
            code="all_have_upph",
            message="当前筛选范围内订单都已匹配到 UPPH。"
            if keyword
            else "本月订单都已匹配到 UPPH。",
        )

    return ResponseModel(data=MissingUpphListOut(items=products[:20], empty_state=empty_state))
