"""Tool 公共基础设施：错误信封、参数校验、列表返回构造（server 与 legacy_compat 共用）

规范依据：§7 严格 Schema、§8 标准返回包、§9 Evidence、§12 结构化错误、§17 脱敏。
"""

from __future__ import annotations

import functools
import logging
import re
from datetime import datetime
from typing import Annotated, Any, Callable, Dict, Optional

from mcp.types import ToolAnnotations
from pydantic import Field

from . import contracts
from .contracts import BizError
from .upstream_client import UpstreamError

logger = logging.getLogger(__name__)

# 规范 §10：机器可读的只读声明（readOnlyHint），配合 AEOS Policy 强制执行
READ_ONLY_TOOL = ToolAnnotations(readOnlyHint=True)

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_EVIDENCE_PER_CALL = 50

Page = Annotated[int, Field(ge=1, description="页码，从 1 开始")]
PageSize = Annotated[int, Field(ge=1, le=200, description="每页条数，上限 200")]
LegacyPage = Annotated[int, Field(ge=1, le=100, description="页码，从 1 开始（0.1.0 兼容上限 100）")]
LegacyPageSize = Annotated[int, Field(ge=1, le=100, description="每页条数，0.1.0 兼容上限 100")]
RequestId = Annotated[str, Field(max_length=64, description="调用方请求 ID（审计/链路追踪用，可选）")]


def tool_error_envelope(fn):
    """Tool 内异常 → 规范 §12 结构化错误返回，保证非法输入不导致进程崩溃（规范 §7）"""

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except (BizError, UpstreamError) as exc:
            return contracts.err(exc.code, exc.message, retryable=getattr(exc, "retryable", None))
        except Exception:
            logger.exception("tool internal error: %s", fn.__name__)
            return contracts.err("INTERNAL_ERROR", "内部错误，详情见服务端 stderr 日志")

    return wrapper


def parse_date(value: str, field: str):
    if not _DATE_RE.match(value or ""):
        raise BizError("INVALID_ARGUMENT", f"{field} 格式必须为 YYYY-MM-DD：{value!r}")
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise BizError("INVALID_ARGUMENT", f"{field} 不是合法日期：{value!r}") from exc


def parse_iso_datetime(value: str, field: str) -> None:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise BizError("INVALID_ARGUMENT", f"{field} 必须为 ISO 8601 时间：{value!r}") from exc


def as_of_confidence(payload: Dict[str, Any], allow_stale: bool = False):
    if not allow_stale and payload.get("stale") is True:
        raise UpstreamError("STALE_DATA", "上游数据已过期，超出新鲜度阈值")
    as_of = str(payload.get("data_as_of") or contracts.utc_now_iso())
    confidence = str(payload.get("data_confidence") or "high").lower()
    if confidence not in ("high", "medium", "low"):
        confidence = "high"
    return as_of, confidence


def filter_params(**values: Any) -> Dict[str, Any]:
    """省略未填写的空值参数（透传上游时保持与 SPC 对外接口默认行为一致）"""
    return {key: value for key, value in values.items() if value}


def list_result(
    capability: str,
    payload: Dict[str, Any],
    *,
    page: int,
    page_size: int,
    request_id: str,
    evidence_entity: str,
    evidence_id: Callable[[Dict[str, Any]], str],
    row_transform: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None,
    allow_stale: bool = False,
) -> Dict[str, Any]:
    """列表类 Tool 公共返回：解包 items/total、脱敏、（可选）字段别名、分页信息、Evidence"""
    as_of, confidence = as_of_confidence(payload, allow_stale=allow_stale)
    rows = contracts.redact(payload.get("items") or [])
    if row_transform is not None:
        rows = [row_transform(row) for row in rows]
    total = int(payload.get("total") or len(rows))
    refs = []
    for row in rows:
        ref_id = evidence_id(row)
        if ref_id:
            refs.append(contracts.evidence(evidence_entity, ref_id, as_of))
    return contracts.ok(
        capability,
        rows,
        data_as_of=as_of,
        data_confidence=confidence,
        evidence_refs=refs[:MAX_EVIDENCE_PER_CALL],
        page=contracts.page_envelope(page, page_size, total, total > page * page_size),
        request_id=request_id or None,
    )
