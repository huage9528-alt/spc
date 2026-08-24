"""物料盘点共同盘点 — SSE 实时同步事件分发。

publish_event: 供 service 层在写库后调用,发到 Redis pub/sub。
subscribe_stream: 供 SSE 端点使用,长连接订阅 channel 并 yield SSE 帧。

Redis 不可用时 publish 静默丢弃、subscribe 降级为只发 snapshot + 心跳,不抛异常。
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime
from decimal import Decimal
from typing import AsyncGenerator, Optional

import redis.asyncio as redis

from app.core.config import get_settings

logger = logging.getLogger(__name__)

CHANNEL_FMT = "stockcheck:{check_id}"
HEARTBEAT_SEC = 15
PRESENCE_TTL = 60
PRESENCE_KEY_FMT = "stockcheck:{check_id}:presence:{user_id}"
PRESENCE_IDX_FMT = "stockcheck:{check_id}:presence:idx"


def _json_default(o):
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    if isinstance(o, Decimal):
        return float(o) if o.is_finite() else str(o)
    if isinstance(o, set):
        return list(o)
    raise TypeError(f"not serializable: {type(o)}")


def _make_client() -> Optional[redis.Redis]:
    try:
        return redis.from_url(
            get_settings().REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=2,
        )
    except Exception:
        return None


async def publish_event(
    check_id: int,
    event_type: str,
    payload: dict,
    origin_user_id: Optional[int],
) -> None:
    """发事件到 Redis channel。Redis 不可用则静默丢弃(warn)。"""
    client = _make_client()
    if client is None:
        logger.warning("stock_check_broker.publish: redis unavailable, event=%s dropped", event_type)
        return
    try:
        envelope = {
            "type": event_type,
            "payload": payload,
            "origin_user_id": origin_user_id,
            "ts": datetime.utcnow().isoformat(),
        }
        await client.publish(
            CHANNEL_FMT.format(check_id=check_id),
            json.dumps(envelope, default=_json_default, ensure_ascii=False),
        )
    except Exception as e:
        logger.warning("stock_check_broker.publish failed: %s", e)
    finally:
        try:
            await client.aclose()
        except Exception:
            pass


def _sse_chunk(event_type: str, payload: dict, origin_user_id: Optional[int] = None) -> str:
    body = {"type": event_type, "payload": payload}
    if origin_user_id is not None:
        body["origin_user_id"] = origin_user_id
    return (
        f"event: {event_type}\n"
        f"data: {json.dumps(body, default=_json_default, ensure_ascii=False)}\n\n"
    )


async def set_presence(check_id: int, user_id: int, name: str, item_id: Optional[int]) -> None:
    """记录某用户正在编辑 item_id,写 Redis(TTL 60s)并广播 presence 事件。"""
    client = _make_client()
    if client is None:
        logger.warning("[presence] set_presence: redis unavailable")
        return
    try:
        key = PRESENCE_KEY_FMT.format(check_id=check_id, user_id=user_id)
        idx = PRESENCE_IDX_FMT.format(check_id=check_id)
        val = json.dumps(
            {"user_id": user_id, "name": name, "item_id": item_id, "ts": datetime.utcnow().isoformat()},
            default=_json_default, ensure_ascii=False,
        )
        pipe = client.pipeline()
        pipe.setex(key, PRESENCE_TTL, val)
        pipe.sadd(idx, str(user_id))
        await pipe.execute()
        await client.publish(
            CHANNEL_FMT.format(check_id=check_id),
            json.dumps({"type": "presence", "payload": {"user_id": user_id, "name": name, "item_id": item_id}, "origin_user_id": user_id, "ts": datetime.utcnow().isoformat()}, default=_json_default, ensure_ascii=False),
        )
        logger.info("[presence] published: check=%s user=%s item=%s", check_id, user_id, item_id)
    except Exception as e:
        logger.warning("[presence] set_presence failed: %s", e)
    finally:
        try:
            await client.aclose()
        except Exception:
            pass


async def clear_presence(check_id: int, user_id: int, name: Optional[str]) -> None:
    """清除某用户的编辑存在感并广播 idle。"""
    client = _make_client()
    if client is None:
        return
    try:
        key = PRESENCE_KEY_FMT.format(check_id=check_id, user_id=user_id)
        idx = PRESENCE_IDX_FMT.format(check_id=check_id)
        pipe = client.pipeline()
        pipe.delete(key)
        pipe.srem(idx, str(user_id))
        await pipe.execute()
        await client.publish(
            CHANNEL_FMT.format(check_id=check_id),
            json.dumps({"type": "presence", "payload": {"user_id": user_id, "name": name, "item_id": None}, "origin_user_id": user_id, "ts": datetime.utcnow().isoformat()}, default=_json_default, ensure_ascii=False),
        )
    except Exception as e:
        logger.warning("clear_presence failed: %s", e)
    finally:
        try:
            await client.aclose()
        except Exception:
            pass


async def get_presence_map(check_id: int) -> list:
    """读取当前 check 的存在感列表(用于 snapshot)。自动清理已过期的 idx 项。"""
    client = _make_client()
    if client is None:
        return []
    try:
        idx = PRESENCE_IDX_FMT.format(check_id=check_id)
        user_ids = await client.smembers(idx)
        if not user_ids:
            return []
        result: list = []
        expired: list = []
        for uid in user_ids:
            key = PRESENCE_KEY_FMT.format(check_id=check_id, user_id=uid)
            val = await client.get(key)
            if val:
                try:
                    result.append(json.loads(val))
                except Exception:
                    pass
            else:
                expired.append(uid)
        for uid in expired:
            await client.srem(idx, uid)
        return result
    except Exception as e:
        logger.warning("get_presence_map failed: %s", e)
        return []
    finally:
        try:
            await client.aclose()
        except Exception:
            pass


async def build_snapshot_payload(check_id: int, db, current_user: dict) -> Optional[dict]:
    """构造 snapshot 事件 payload: head + items + co_checkers 全量(含 version)。

    can_edit 按订阅者计算:否则 payload 里恒为 null,前端合并时会覆盖掉
    REST 接口返回的 can_edit=false,导致无权限用户按钮"恢复可用"。
    """
    from app.services.material.stock_check_service import (  # late import 防循环
        get_stock_check_with_items,
        _resolve_user_names,
        _user_can_edit,
    )
    from app.schemas.material.stock_check import StockCheckOut, StockCheckItemOut

    head = await get_stock_check_with_items(db, check_id)
    if head is None:
        return None
    out = StockCheckOut.model_validate(head)
    ids = list(head.co_checker_user_ids or [])
    name_map = await _resolve_user_names(
        db, ids + ([head.created_by_user_id] if head.created_by_user_id else [])
    )
    out.co_checkers = [
        {"user_id": int(i), "name": name_map.get(int(i), f"user#{i}")}
        for i in ids
    ]
    out.can_edit = _user_can_edit(head, current_user)
    out.items = [StockCheckItemOut.model_validate(it) for it in (head.items or [])]
    out_dict = out.model_dump()
    out_dict["version"] = int(head.version or 0)
    out_dict["presence"] = await get_presence_map(check_id)
    return out_dict


async def subscribe_stream(
    check_id: int,
    current_user: dict,
) -> AsyncGenerator[str, None]:
    """SSE 端点生成器。yield 形如 'event: <type>\\ndata: {...}\\n\\n'。

    快照用短命会话构建后立刻归还,订阅循环只走 Redis:流可活几小时,
    持有 db 会话会占住连接池的一条连接。
    """
    from app.core.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        snapshot = await build_snapshot_payload(check_id, db, current_user)
    if snapshot is None:
        return
    yield _sse_chunk("snapshot", snapshot)

    channel = CHANNEL_FMT.format(check_id=check_id)
    client = _make_client()
    if client is None:
        logger.warning("stock_check_broker.subscribe: redis unavailable, heartbeat-only")
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
            yield _sse_chunk(
                envelope.get("type", "message"),
                envelope.get("payload", {}),
                envelope.get("origin_user_id"),
            )
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.warning("stock_check_broker.subscribe loop error: %s", e)
    finally:
        # 断开连接:清除该用户的存在感并广播 idle
        uid = current_user.get("user_id") if current_user else None
        uname = current_user.get("username") if current_user else None
        if uid is not None:
            try:
                await clear_presence(check_id, int(uid), uname)
            except Exception:
                pass
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
