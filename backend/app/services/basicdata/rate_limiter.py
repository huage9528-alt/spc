"""数据供给 — API Key 限流（Redis 固定窗口，每分钟每 Key）

规则：rate_limit 为 NULL/0 表示不限；Redis 异常时降级放行（不阻断业务）。
"""

import logging
import time
from typing import Optional

from app.core.redis_client import get_command_client, note_failure, note_success

logger = logging.getLogger(__name__)

RATE_LIMIT_PREFIX = "ds_ratelimit"
RATE_LIMITED_MARK = "RATE_LIMITED"


async def check_rate_limit(api_key_id: int, rate_limit: Optional[int]) -> tuple[bool, int]:
    """返回 (allowed, retry_after_seconds)。"""
    if not rate_limit or rate_limit <= 0:
        return True, 0

    client = get_command_client()
    if client is None:
        # 熔断开启期间直接放行，不付超时代价
        return True, 0
    try:
        epoch_minute = int(time.time() // 60)
        key = f"{RATE_LIMIT_PREFIX}:{api_key_id}:{epoch_minute}"
        count = await client.incr(key)
        note_success()
        if count == 1:
            await client.expire(key, 60)
        if count > rate_limit:
            retry_after = 60 - int(time.time() % 60)
            return False, max(retry_after, 1)
        return True, 0
    except Exception as e:
        note_failure()
        logger.error(f"[数据供给限流] Redis 异常，降级放行 api_key_id={api_key_id}: {e}")
        return True, 0
