"""共享 Redis 客户端（单例连接池） + 进程内熔断器。

所有命令型调用（token 黑名单 / 权限缓存 / 限流 / publish 等）统一走 get_command_client()：
- 带 socket_timeout：Redis"假死"（连接建立但不响应，如落盘卡住/网络黑洞）时
  await 会在 2s 后抛异常，而不是永远挂起。没有它，任何 try/except 降级都无效，
  且这些调用在认证热路径上，一个挂死的 Redis 会挂死全站请求。
- 连接池复用，替代各处"每操作 from_url 新建连接再 aclose"的开销。

熔断器：连续失败 3 次跳闸，10s 冷却期内 get_command_client() 返回 None，
调用方直接走降级分支，避免 Redis 宕机期间每个请求白付超时代价。

SSE 订阅（pub/sub）用 make_pubsub_client()：读等待由
pubsub.get_message(timeout=...) 显式限时，不能叠加 socket_timeout，
否则会提前打断长等待，故独立建客户端、只设连接超时。
"""
from __future__ import annotations

import logging
import time
from typing import Optional

import redis.asyncio as aioredis

from app.core.config import get_settings

logger = logging.getLogger(__name__)

FAILURE_THRESHOLD = 3
COOLDOWN_SEC = 10.0

_client: Optional[aioredis.Redis] = None
_consecutive_failures = 0
_down_until = 0.0


def get_command_client() -> Optional[aioredis.Redis]:
    """取共享命令客户端。熔断开启期间返回 None（调用方走各自降级分支）。

    返回的客户端进程共享，调用方【不要】 aclose 它；
    调用成功后 note_success()，失败后 note_failure()。
    """
    global _client
    if time.monotonic() < _down_until:
        return None
    if _client is None:
        _client = aioredis.from_url(
            get_settings().REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
            health_check_interval=30,
        )
    return _client


def make_pubsub_client() -> aioredis.Redis:
    """SSE 订阅专用客户端（每个订阅独立连接，随流关闭）。"""
    return aioredis.from_url(
        get_settings().REDIS_URL,
        decode_responses=True,
        socket_connect_timeout=2,
    )


def note_success() -> None:
    global _consecutive_failures
    _consecutive_failures = 0


def note_failure() -> None:
    global _consecutive_failures, _down_until
    _consecutive_failures += 1
    if _consecutive_failures >= FAILURE_THRESHOLD:
        _down_until = time.monotonic() + COOLDOWN_SEC
        logger.warning(
            "redis 连续失败 %s 次，熔断 %ss，期间各调用方直接降级",
            _consecutive_failures, COOLDOWN_SEC,
        )


async def probe_redis() -> bool:
    """主动探测（启动检查/诊断用）。"""
    client = get_command_client()
    if client is None:
        return False
    try:
        await client.ping()
        note_success()
        return True
    except Exception as e:
        note_failure()
        logger.warning("redis 探测失败: %s", e)
        return False


async def close_shared_client() -> None:
    """进程退出时释放共享客户端。"""
    global _client, _consecutive_failures, _down_until
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:
            pass
        _client = None
    _consecutive_failures = 0
    _down_until = 0.0
