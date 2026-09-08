from app.core.redis_client import get_command_client, note_failure, note_success

TOKEN_BLACKLIST_PREFIX = "token:blacklist:"
BLACKLIST_TTL = 60 * 60 * 24


async def get_redis_client():
    """共享命令客户端（熔断开启时返回 None）。调用方不要 aclose。"""
    return get_command_client()


async def add_token_to_blacklist(jti: str) -> bool:
    client = await get_redis_client()
    if not client:
        return False
    try:
        await client.setex(f"{TOKEN_BLACKLIST_PREFIX}{jti}", BLACKLIST_TTL, "1")
        note_success()
        return True
    except Exception:
        note_failure()
        return False


async def is_token_blacklisted(jti: str) -> bool:
    client = await get_redis_client()
    if not client:
        return False
    try:
        result = await client.exists(f"{TOKEN_BLACKLIST_PREFIX}{jti}")
        note_success()
        return result > 0
    except Exception:
        note_failure()
        return False
