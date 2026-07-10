"""用户权限 payload 缓存 — 减轻 PermissionChecker 每次请求查库的负担

缓存内容：role_code / supplier_name / supplier_code / oa_user_id / org_scope_ids / login_version
缓存粒度：按 user_id + login_version（重新登录会 bump login_version，自动失效旧缓存）
TTL：5 分钟（兜底，即使 login_version 失效机制出问题也不会缓存太久）
"""
import json
import time
import threading
import redis.asyncio as redis
from app.core.config import get_settings

settings = get_settings()

PAYLOAD_CACHE_PREFIX = "perm:payload:"
PAYLOAD_CACHE_TTL = 5 * 60  # 5 分钟

# 进程内 fallback 缓存（Redis 不可用时用）
_local_cache: dict[str, tuple[float, dict]] = {}
_local_lock = threading.Lock()


async def _get_redis():
    try:
        return redis.from_url(settings.REDIS_URL, decode_responses=True, socket_connect_timeout=2)
    except Exception:
        return None


def _cache_key(user_id: int, login_version: int) -> str:
    return f"{PAYLOAD_CACHE_PREFIX}{user_id}:v{login_version}"


def _local_get(key: str) -> dict | None:
    """进程内缓存读取"""
    with _local_lock:
        item = _local_cache.get(key)
        if item and time.time() - item[0] < PAYLOAD_CACHE_TTL:
            return item[1]
        if item:
            _local_cache.pop(key, None)
    return None


def _local_set(key: str, value: dict) -> None:
    """进程内缓存写入"""
    with _local_lock:
        _local_cache[key] = (time.time(), value)


async def get_cached_user_payload(user_id: int, login_version: int) -> dict | None:
    """读取缓存的用户 payload（不含 permissions，permissions 单独查）。返回 None 表示未命中。"""
    key = _cache_key(user_id, login_version)
    # 先查进程内缓存（最快）
    local = _local_get(key)
    if local is not None:
        return local
    # 再查 Redis
    client = await _get_redis()
    if not client:
        return None
    try:
        raw = await client.get(key)
        if not raw:
            return None
        data = json.loads(raw)
        _local_set(key, data)  # 回写进程内
        return data
    except Exception:
        return None
    finally:
        try:
            await client.aclose()
        except Exception:
            pass


async def set_cached_user_payload(user_id: int, login_version: int, payload: dict) -> None:
    """写入用户 payload 缓存"""
    key = _cache_key(user_id, login_version)
    # org_scope_ids 是 set，需要转 list 才能序列化
    safe = dict(payload)
    if isinstance(safe.get("org_scope_ids"), set):
        safe["org_scope_ids"] = list(safe["org_scope_ids"])
    # 进程内缓存（即使 Redis 不可用也能命中）
    _local_set(key, safe)
    # Redis（跨进程共享）
    client = await _get_redis()
    if not client:
        return
    try:
        await client.setex(key, PAYLOAD_CACHE_TTL, json.dumps(safe, default=str))
    except Exception:
        pass
    finally:
        try:
            await client.aclose()
        except Exception:
            pass


async def invalidate_user_payload(user_id: int) -> None:
    """主动失效某用户的所有版本缓存（扫前缀）"""
    client = await _get_redis()
    if not client:
        return
    try:
        # 扫所有版本 key（不同 login_version 的）
        pattern = f"{PAYLOAD_CACHE_PREFIX}{user_id}:v*"
        async for key in client.scan_iter(match=pattern, count=100):
            await client.delete(key)
    except Exception:
        pass
    finally:
        try:
            await client.aclose()
        except Exception:
            pass
