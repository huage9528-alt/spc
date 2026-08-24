"""通知 SSE 实时推送 — Redis pub/sub → SSE 桥接。

publish_unread_update: 供 API/service 层在通知变更后调用，推未读计数到 Redis。
subscribe_stream: 供 SSE 端点使用，长连接订阅 notif:{user_id} 并 yield SSE 帧。

Redis 不可用时：publish 静默丢弃；subscribe 降级为 snapshot + 心跳，不抛异常。
结构克隆自 app/services/material/stock_check_broker.py。
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import AsyncGenerator, Optional

import redis.asyncio as redis
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.basicdata.announcement import Notification

logger = logging.getLogger(__name__)

CHANNEL_FMT = "notif:{user_id}"
HEARTBEAT_SEC = 15

# 模块级共享 Redis 客户端（lifespan 启动时初始化，避免每次 publish 开关连接）
_client: Optional[redis.Redis] = None


async def init_client() -> None:
    """lifespan 启动时调用：建立共享 Redis 客户端。失败则降级（publish 时即时建临时客户端）。"""
    global _client
    try:
        _client = redis.from_url(
            get_settings().REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=2,
        )
        await _client.ping()
        logger.info("[notification_broker] redis client ready")
    except Exception as e:
        logger.warning(f"[notification_broker] redis init failed, will degrade: {e}")
        _client = None


async def close_client() -> None:
    """lifespan 关闭时调用：释放共享客户端。"""
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:
            pass
        _client = None


def _borrow_publish_client() -> tuple[Optional[redis.Redis], bool]:
    """返回 (client, is_temp)。共享客户端优先；否则即时建临时客户端。"""
    if _client is not None:
        return _client, False
    try:
        return redis.from_url(
            get_settings().REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=2,
        ), True
    except Exception:
        return None, False


async def compute_unread_counts(db: AsyncSession, user_id: int) -> dict:
    """计算某用户的未读计数 {total, by_type}。供 /unread-count 端点与 broker 复用。"""
    q = (
        select(Notification.type, func.count(Notification.id))
        .where(and_(Notification.user_id == user_id, Notification.is_read == False))  # noqa: E712
        .group_by(Notification.type)
    )
    rows = (await db.execute(q)).all()
    counts = {r[0]: r[1] for r in rows}
    total = sum(counts.values())
    return {"total": total, "by_type": counts}


async def publish_unread_update(db: AsyncSession, user_id: int) -> None:
    """通知变更后调用：计算该用户未读计数并 PUBLISH 到 notif:{user_id}。Redis 不可用则静默丢弃。"""
    client, is_temp = _borrow_publish_client()
    if client is None:
        logger.warning("notification_broker.publish: redis unavailable, user_id=%s dropped", user_id)
        return
    try:
        payload = await compute_unread_counts(db, user_id)
        envelope = {
            "total": payload["total"],
            "by_type": payload["by_type"],
            "ts": datetime.utcnow().isoformat(),
        }
        await client.publish(
            CHANNEL_FMT.format(user_id=user_id),
            json.dumps(envelope, ensure_ascii=False),
        )
    except Exception as e:
        logger.warning("notification_broker.publish failed user_id=%s: %s", user_id, e)
    finally:
        if is_temp:
            try:
                await client.aclose()
            except Exception:
                pass


def _unread_chunk(payload: dict) -> str:
    return (
        "event: unread\n"
        f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
    )


def _make_subscribe_client() -> Optional[redis.Redis]:
    """每个 SSE 订阅用独立客户端（独立 pubsub 连接）。"""
    try:
        return redis.from_url(
            get_settings().REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=2,
        )
    except Exception:
        return None


async def subscribe_stream(
    user_id: int,
) -> AsyncGenerator[str, None]:
    """SSE 端点生成器。首帧 snapshot(当前未读计数)，后续 unread 事件 + 15s 心跳。

    快照用短命会话算完立刻归还,订阅循环只走 Redis:流可活几小时,
    持有调用方 db 会话会占住连接池的一条连接。
    """
    from app.core.database import AsyncSessionLocal

    try:
        async with AsyncSessionLocal() as db:
            snapshot = await compute_unread_counts(db, user_id)
    except Exception as e:
        logger.warning("notification_broker.subscribe snapshot failed: %s", e)
        snapshot = {"total": 0, "by_type": {}}
    yield _unread_chunk(snapshot)

    channel = CHANNEL_FMT.format(user_id=user_id)
    client = _make_subscribe_client()
    if client is None:
        logger.warning("notification_broker.subscribe: redis unavailable, heartbeat-only")
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_SEC)
                yield ": keep-alive\n\n"
        except asyncio.CancelledError:
            return
        return

    pubsub = client.pubsub()
    try:
        await pubsub.subscribe(channel)
        while True:
            try:
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=HEARTBEAT_SEC
                )
            except asyncio.CancelledError:
                break
            if msg is None:
                yield ": keep-alive\n\n"
                continue
            data = msg.get("data") if isinstance(msg, dict) else None
            if not data or not isinstance(data, str):
                continue
            try:
                envelope = json.loads(data)
            except Exception:
                continue
            yield _unread_chunk({
                "total": envelope.get("total", 0),
                "by_type": envelope.get("by_type", {}),
            })
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.warning("notification_broker.subscribe loop error: %s", e)
    finally:
        try:
            await pubsub.unsubscribe(channel)
        except Exception:
            pass
        try:
            await pubsub.close()
        except Exception:
            pass
        try:
            await client.aclose()
        except Exception:
            pass
