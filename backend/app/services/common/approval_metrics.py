"""审批中心 - 等待时长 / 超时分级 / 统计口径（纯函数，便于单测）。

超时口径：节点可配 timeout_hours（0 = 不提醒），未配置取默认 48；
等待 >= 阈值判 overdue，>= 阈值一半判 soon，其余 normal。
"""

from datetime import datetime
from typing import Optional

DEFAULT_TIMEOUT_HOURS = 48


def resolve_timeout_hours(node: Optional[dict]) -> int:
    """节点超时小时数；未配置用默认值，显式 0 表示不提醒。"""
    raw = (node or {}).get("timeout_hours")
    try:
        hours = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_HOURS
    return hours if hours > 0 else 0


def parse_dt(value) -> Optional[datetime]:
    """兼容 datetime 与 ISO 字符串（DB 为 naive 时间戳）。"""
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)[:19])
    except ValueError:
        return None


def wait_hours(submitted_at, now: Optional[datetime] = None) -> Optional[float]:
    dt = parse_dt(submitted_at)
    if not dt:
        return None
    now = now or datetime.now()
    return round(max((now - dt).total_seconds(), 0) / 3600, 1)


def wait_level(hours: Optional[float], timeout_hours: int) -> str:
    if hours is None or not timeout_hours:
        return "normal"
    if hours >= timeout_hours:
        return "overdue"
    if hours >= timeout_hours / 2:
        return "soon"
    return "normal"


def enrich_pending_item(item: dict, now: Optional[datetime] = None) -> dict:
    """给待办条目补齐 timeout_hours / wait_hours / wait_level。"""
    timeout = resolve_timeout_hours(item)
    hours = wait_hours(item.get("submitted_at"), now)
    item["timeout_hours"] = timeout
    item["wait_hours"] = hours
    item["wait_level"] = wait_level(hours, timeout)
    return item


def pending_stats(items: list[dict], now: Optional[datetime] = None) -> dict:
    now = now or datetime.now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    by_biz: dict[str, int] = {}
    today = soon = overdue = 0
    for it in items:
        biz = it.get("biz_type") or ""
        by_biz[biz] = by_biz.get(biz, 0) + 1
        dt = parse_dt(it.get("submitted_at"))
        if dt and dt >= today_start:
            today += 1
        if it.get("wait_level") == "soon":
            soon += 1
        elif it.get("wait_level") == "overdue":
            overdue += 1
    return {"total": len(items), "today": today, "soon": soon, "overdue": overdue, "by_biz": by_biz}


def approved_stats(items: list[dict]) -> dict:
    durations = []
    for it in items:
        start, end = parse_dt(it.get("submitted_at")), parse_dt(it.get("acted_at"))
        if start and end and end >= start:
            durations.append((end - start).total_seconds() / 3600)
    return {
        "processed": len(items),
        "passed": sum(1 for it in items if it.get("my_action") == "approve"),
        "rejected": sum(1 for it in items if it.get("my_action") == "reject"),
        "avg_hours": round(sum(durations) / len(durations), 1) if durations else None,
    }


def submitted_stats(items: list[dict]) -> dict:
    counts = {"pending": 0, "approved": 0, "rejected": 0, "recalled": 0}
    for it in items:
        status = it.get("status")
        if status in counts:
            counts[status] += 1
    return counts
