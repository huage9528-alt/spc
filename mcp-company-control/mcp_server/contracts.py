"""标准返回包 / 错误结构 / Evidence 构造器 — 对齐 AEOS MCP Integration Spec §8/§9/§12"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

SOURCE = "company-control"

RETRYABLE_CODES = {"UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE", "RATE_LIMITED", "STALE_DATA"}

# 敏感字段集合（规范 §17 最小暴露原则）；命中即脱敏
SENSITIVE_KEYS = {"phone", "mobile", "contact_phone", "cost_price", "unit_cost", "id_card", "bank_card"}


class BizError(Exception):
    """业务/参数校验错误 — 由 Tool 包装为规范 §12 结构化错误返回"""

    def __init__(self, code: str, message: str, *, retryable: Optional[bool] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ok(
    capability: str,
    data: Any,
    *,
    data_as_of: str,
    data_confidence: str = "high",
    evidence_refs: Optional[List[str]] = None,
    page: Optional[Dict[str, Any]] = None,
    request_id: Optional[str] = None,
) -> Dict[str, Any]:
    """标准成功返回包（规范 §8；request_id 回显用于审计与链路追踪，规范 §14）"""
    payload: Dict[str, Any] = {
        "source": SOURCE,
        "capability": capability,
        "read_only": True,
        "generated_at": utc_now_iso(),
        "data_confidence": data_confidence,
        "data_as_of": data_as_of,
        "evidence_refs": evidence_refs or [],
        "data": data,
    }
    if page is not None:
        payload["page"] = page
    if request_id:
        payload["request_id"] = request_id
    return payload


def err(code: str, message: str, *, retryable: Optional[bool] = None) -> Dict[str, Any]:
    """标准错误返回（规范 §12）；retryable 默认按错误码判定，能力未开放等场景可显式覆盖"""
    is_retryable = code in RETRYABLE_CODES if retryable is None else retryable
    return {
        "source": SOURCE,
        "error": {
            "code": code,
            "message": message,
            "retryable": is_retryable,
            "occurred_at": utc_now_iso(),
        },
    }


def evidence(entity: str, ref_id: str, as_of: str) -> str:
    """Evidence URI：control-platform://{entity}/{id}@{as_of}（规范 §9，稳定可追溯）"""
    return f"control-platform://{entity}/{ref_id}@{as_of}"


def page_envelope(page: int, page_size: int, total: int, truncated: bool) -> Dict[str, Any]:
    """分页信息（规范 §13）"""
    env: Dict[str, Any] = {"page": page, "page_size": page_size, "total": total, "truncated": truncated}
    if page * page_size < total:
        env["next_cursor"] = str(page + 1)
    return env


def redact(value: Any, sensitive: Iterable[str] = SENSITIVE_KEYS) -> Any:
    """递归脱敏：命中敏感键的非空值替换为 ***（规范 §17）"""
    keys = set(sensitive)
    if isinstance(value, dict):
        return {k: ("***" if k in keys and v is not None else redact(v, keys)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, keys) for v in value]
    return value
