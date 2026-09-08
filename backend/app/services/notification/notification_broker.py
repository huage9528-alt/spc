"""通知 SSE 实时推送 — Redis pub/sub → SSE 桥接。

publish_unread_update: 供 API/service 层在通知变更后调用，推未读计数到 Redis。
subscribe_stream: 供 SSE 端点使用，长连接订阅 notif:{user_id} 并 yield SSE 帧。

Redis 不可用时：publish 静默丢弃；subscribe 降级为 snapshot + 心跳，不抛异常、
不结束流（流一旦结束，浏览器 EventSource 会每 3s 重连，形成重连风暴）。
结构克隆自 app/services/material/stock_check_broker.py。
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import AsyncGenerator, Optional

from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.redis_client import (
    get_command_client,
    make_pubsub_client,
    note_failure,
    note_success,
)

from app.models.basicdata.announcement import Notification

logger = logging.getLogger(__name__)

CHANNEL_FMT = "notif:{user_id}"
HEARTBEAT_SEC = 15


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
    client = get_command_client()
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
        note_success()
    except Exception as e:
        note_failure()
        logger.warning("notification_broker.publish failed user_id=%s: %s", user_id, e)


def _unread_chunk(payload: dict) -> str:
    return (
        "event: unread\n"
        f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
    )


async def _close_pubsub(pubsub, client) -> None:
    """释放订阅连接与专属客户端。"""
    if pubsub is not None:
        try:
            await pubsub.aclose()
        except Exception:
            pass
    if client is not None:
        try:
            await client.aclose()
        except Exception:
            pass


async def subscribe_stream(
    user_id: int,
) -> AsyncGenerator[str, None]:
    """SSE 端点生成器。首帧 snapshot(当前未读计数)，后续 unread 事件 + 15s 心跳。

    快照用短命会话算完立刻归还,订阅循环只走 Redis:流可活几小时,
    持有调用方 db 会话会占住连接池的一条连接。
    订阅失败/订阅中断一律降级为心跳模式保活流,绝不让流异常结束。
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
    pubsub = None
    client = None
    try:
        client = make_pubsub_client()
        pubsub = client.pubsub()
        await pubsub.subscribe(channel)
    except asyncio.CancelledError:
        await _close_pubsub(pubsub, client)
        raise
    except Exception as e:
        logger.warning("notification_broker.subscribe failed (%s), SSE 降级为心跳模式", e)
        await _close_pubsub(pubsub, client)
        pubsub = None
        client = None

    try:
        degraded = pubsub is None
        while True:
            if degraded:
                await asyncio.sleep(HEARTBEAT_SEC)
                yield ": keep-alive\n\n"
                continue
            try:
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=HEARTBEAT_SEC
                )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("notification_broker.subscribe loop error (%s), 降级为心跳模式", e)
                degraded = True
                continue
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
    finally:
        await _close_pubsub(pubsub, client)
