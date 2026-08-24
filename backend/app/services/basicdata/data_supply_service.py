"""基础数据与集成中心 — 数据供给服务层"""

import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.basicdata.data_supply import DataSupplyApiKey, DataSupplyCallLog
from app.services.basicdata.rate_limiter import RATE_LIMITED_MARK

# 签名有效期（秒），防重放攻击
SIGNATURE_TTL = 300


# ═══════════════════════════════════════════
# 认证相关
# ═══════════════════════════════════════════

def check_ip_whitelist(key_obj: DataSupplyApiKey, client_ip: str) -> bool:
    """检查请求 IP 是否在白名单内"""
    if not key_obj.ip_whitelist_json:
        return True
    try:
        whitelist = json.loads(key_obj.ip_whitelist_json)
    except (json.JSONDecodeError, TypeError):
        return True
    if not whitelist:
        return True
    return client_ip in whitelist


def _key_has_endpoint_access(key_obj: DataSupplyApiKey, endpoint_code: str) -> bool:
    """检查 API Key 是否被授权调用指定的对外接口 endpoint_code"""
    if not key_obj.allowed_endpoints_json:
        return False
    try:
        allowed = json.loads(key_obj.allowed_endpoints_json)
    except (json.JSONDecodeError, TypeError):
        return False
    return endpoint_code in allowed


async def validate_signature_for_endpoint(
    db: AsyncSession,
    app_key: str,
    signature: str,
    timestamp: str,
    endpoint_code: str,
    request_query_string: str = "",
) -> tuple[Optional[DataSupplyApiKey], str]:
    """验证 HMAC-SHA256 签名是否可调用指定对外接口（推荐模式）

    返回 (key_obj, reason)。成功时 key_obj 非空、reason 为空；
    失败时 key_obj 为 None、reason 说明原因。
    """
    try:
        ts = int(timestamp)
    except (ValueError, TypeError):
        return None, "时间戳格式无效（应为整数秒）"

    now = int(time.time())
    if abs(now - ts) > SIGNATURE_TTL:
        return None, f"时间戳超出有效期（服务器时间戳 {now}，允许偏差 ±{SIGNATURE_TTL}s）"

    result = await db.execute(
        select(DataSupplyApiKey).where(
            DataSupplyApiKey.app_key == app_key,
        )
    )
    key_obj = result.scalar_one_or_none()
    if not key_obj:
        return None, "AppKey 不存在"
    if not key_obj.is_active:
        return None, "API Key 已禁用"
    if not key_obj.app_secret:
        return None, "该 API Key 未配置 AppSecret"
    if key_obj.expires_at and key_obj.expires_at < datetime.now():
        return None, "API Key 已过期"

    if not _key_has_endpoint_access(key_obj, endpoint_code):
        return None, f"API Key 未授权调用接口 {endpoint_code}（请在管理后台勾选该接口权限）"

    # 签名串：timestamp + app_key + endpoint_code + query_string
    string_to_sign = f"{timestamp}{app_key}{endpoint_code}{request_query_string}"
    expected_sig = hmac.new(
        key_obj.app_secret.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(signature, expected_sig):
        return None, (
            f"签名不匹配。待签名串 = timestamp+app_key+endpoint_code+query_string "
            f"= '{timestamp}{app_key}{endpoint_code}{request_query_string}'，"
            f"endpoint_code 应为 '{endpoint_code}'（注意用接口代码而非 URL 路径）"
        )

    return key_obj, ""


# ═══════════════════════════════════════════
# 日志与统计
# ═══════════════════════════════════════════

async def log_call(
    db: AsyncSession,
    api_key_id: Optional[int],
    api_key_name: Optional[str],
    data_type: str,
    request_params: Optional[dict],
    response_status: int,
    response_count: int,
    ip_address: Optional[str],
    user_agent: Optional[str],
    duration_ms: float,
    error_message: Optional[str] = None,
):
    """记录调用日志"""
    log = DataSupplyCallLog(
        api_key_id=api_key_id,
        api_key_name=api_key_name,
        data_type=data_type,
        request_params_json=json.dumps(request_params, ensure_ascii=False, default=str) if request_params else None,
        response_status=response_status,
        response_count=response_count,
        ip_address=ip_address,
        user_agent=user_agent,
        duration_ms=duration_ms,
        error_message=error_message,
    )
    db.add(log)
    try:
        await db.commit()
    except Exception:
        # 日志写入失败不应掩盖业务异常；回滚后吞掉，避免污染外层事务
        try:
            await db.rollback()
        except Exception:
            pass


async def get_call_statistics(
    db: AsyncSession,
    api_key_id: Optional[int] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    data_type: Optional[str] = None,
) -> dict:
    """获取调用统计

    单遍 FILTER 聚合（total/success/rate_limited/avg/p95 一次扫描）+ 3 个分组查询，
    避免在大日志表上多次独立子查询全扫。
    """
    criteria = []
    if api_key_id:
        criteria.append(DataSupplyCallLog.api_key_id == api_key_id)
    if start_date:
        criteria.append(DataSupplyCallLog.called_at >= start_date)
    if end_date:
        criteria.append(DataSupplyCallLog.called_at <= end_date)
    if data_type:
        criteria.append(DataSupplyCallLog.data_type == data_type)

    def _filtered(sel):
        return sel.where(*criteria) if criteria else sel

    agg_row = (await db.execute(_filtered(select(
        func.count().label("total"),
        func.count().filter(DataSupplyCallLog.response_status == 200).label("success"),
        func.count().filter(DataSupplyCallLog.error_message == RATE_LIMITED_MARK).label("rate_limited"),
        func.avg(DataSupplyCallLog.duration_ms).label("avg_ms"),
        func.percentile_cont(0.95).within_group(DataSupplyCallLog.duration_ms).label("p95_ms"),
    )))).one()
    total = agg_row.total or 0
    success = agg_row.success or 0
    rate_limited = agg_row.rate_limited or 0
    avg_duration = agg_row.avg_ms
    p95 = agg_row.p95_ms

    by_type_result = await db.execute(_filtered(
        select(DataSupplyCallLog.data_type, func.count())
        .group_by(DataSupplyCallLog.data_type)
    ))
    by_data_type = {row[0]: row[1] for row in by_type_result.all()}

    by_date_result = await db.execute(_filtered(
        select(func.date(DataSupplyCallLog.called_at), func.count())
        .group_by(func.date(DataSupplyCallLog.called_at))
        .order_by(desc(func.date(DataSupplyCallLog.called_at)))
        .limit(30)
    ))
    by_date = {str(row[0]): row[1] for row in by_date_result.all()}

    by_key_result = await db.execute(_filtered(
        select(DataSupplyCallLog.api_key_name, func.count())
        .group_by(DataSupplyCallLog.api_key_name)
    ))
    by_api_key = {row[0] or "未知": row[1] for row in by_key_result.all()}

    return {
        "total_calls": total,
        "success_calls": success,
        "failed_calls": total - success,
        "failure_rate": round((total - success) / total, 4) if total else None,
        "rate_limited_calls": rate_limited,
        "p95_duration_ms": float(p95) if p95 is not None else None,
        "avg_duration_ms": float(avg_duration) if avg_duration else None,
        "by_data_type": by_data_type,
        "by_endpoint": by_data_type,
        "by_date": by_date,
        "by_api_key": by_api_key,
    }


# ═══════════════════════════════════════════
# Key 生成
# ═══════════════════════════════════════════

def generate_api_key() -> str:
    return f"spc_{uuid.uuid4().hex[:32]}"


def generate_app_key() -> str:
    return f"ak_{uuid.uuid4().hex[:16]}"


def generate_app_secret() -> str:
    return uuid.uuid4().hex + uuid.uuid4().hex


async def validate_signature_for_exposable(
    db: AsyncSession,
    app_key: str,
    signature: str,
    timestamp: str,
    endpoint_code: str,
    request_query_string: str = "",
) -> tuple[Optional[DataSupplyApiKey], str]:
    """验证 HMAC-SHA256 签名是否可调用指定 @exposable 内部接口。

    与 validate_signature_for_endpoint 区别：
      - 面向 @exposable 内部接口（不涉及对外 endpoint 注册表）
      - 检查 allowed_endpoints_json 是否包含 endpoint_code（必须以 'int:' 前缀）
      - 其余 (TTL / 失效 / IP 由调用方处理) 与现有规则一致
    """
    try:
        ts = int(timestamp)
    except (ValueError, TypeError):
        return None, "时间戳格式无效（应为整数秒）"

    now = int(time.time())
    if abs(now - ts) > SIGNATURE_TTL:
        return None, f"时间戳超出有效期（服务器时间戳 {now}，允许偏差 ±{SIGNATURE_TTL}s）"

    if not endpoint_code.startswith("int:"):
        return None, f"endpoint_code 必须是 'int:' 前缀: {endpoint_code}"

    result = await db.execute(
        select(DataSupplyApiKey).where(DataSupplyApiKey.app_key == app_key)
    )
    key_obj = result.scalar_one_or_none()
    if not key_obj:
        return None, "AppKey 不存在"
    if not key_obj.is_active:
        return None, "API Key 已禁用"
    if not key_obj.app_secret:
        return None, "该 API Key 未配置 AppSecret"
    if key_obj.expires_at and key_obj.expires_at < datetime.now():
        return None, "API Key 已过期"

    if not _key_has_endpoint_access(key_obj, endpoint_code):
        return None, f"API Key 未授权调用接口 {endpoint_code}"

    string_to_sign = f"{timestamp}{app_key}{endpoint_code}{request_query_string}"
    expected_sig = hmac.new(
        key_obj.app_secret.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, expected_sig):
        return None, (
            f"签名不匹配。待签名串 = timestamp+app_key+endpoint_code+query_string "
            f"= '{timestamp}{app_key}{endpoint_code}{request_query_string}'"
        )
    return key_obj, ""

