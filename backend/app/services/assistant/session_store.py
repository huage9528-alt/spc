"""会话存储 — Redis 存储对话历史，支持服务端会话管理"""

import json
import logging
from typing import Any, Dict, List

from app.core.redis_client import get_command_client, note_failure, note_success

logger = logging.getLogger(__name__)

# 会话配置
SESSION_TTL = 1800  # 30 分钟过期
MAX_HISTORY_LENGTH = 20  # 最多保留 20 条消息

# 内存 fallback（Redis 不可用时）
_memory_store: Dict[str, str] = {}


def _session_key(session_id: str) -> str:
    return f"assistant:session:{session_id}"


async def get_history(session_id: str) -> List[Dict[str, Any]]:
    """获取会话历史"""
    if not session_id:
        return []

    key = _session_key(session_id)
    client = get_command_client()
    if client is None:
        data = _memory_store.get(key)
    else:
        try:
            data = await client.get(key)
            note_success()
        except Exception as e:
            note_failure()
            logger.error(f"获取会话历史失败: {e}")
            data = _memory_store.get(key)

    if data:
        try:
            return json.loads(data)
        except Exception as e:
            logger.error(f"解析会话历史失败: {e}")
    return []


async def save_history(session_id: str, history: List[Dict[str, Any]]) -> None:
    """保存会话历史"""
    if not session_id:
        return

    # 限制历史长度
    if len(history) > MAX_HISTORY_LENGTH:
        history = history[-MAX_HISTORY_LENGTH:]

    key = _session_key(session_id)
    client = get_command_client()
    if client is None:
        _memory_store[key] = json.dumps(history, ensure_ascii=False, default=str)
        return
    try:
        await client.setex(key, SESSION_TTL, json.dumps(history, ensure_ascii=False, default=str))
        note_success()
    except Exception as e:
        note_failure()
        _memory_store[key] = json.dumps(history, ensure_ascii=False, default=str)
        logger.error(f"保存会话历史失败: {e}")


async def append_messages(
    session_id: str,
    messages: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """追加消息到会话历史并返回完整历史"""
    history = await get_history(session_id)
    history.extend(messages)

    # 限制长度
    if len(history) > MAX_HISTORY_LENGTH:
        history = history[-MAX_HISTORY_LENGTH:]

    await save_history(session_id, history)
    return history


async def clear_session(session_id: str) -> None:
    """清除会话"""
    if not session_id:
        return
    key = _session_key(session_id)
    client = get_command_client()
    if client is None:
        _memory_store.pop(key, None)
        return
    try:
        await client.delete(key)
        note_success()
    except Exception as e:
        note_failure()
        logger.error(f"清除会话失败: {e}")
