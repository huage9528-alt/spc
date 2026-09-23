"""0.1.0 向后兼容工具（AEOS Hub 依赖的旧契约）

职责：
- 旧工具输入 Schema（名称/参数/分页上限 100 与 0.1.0 一致）
- 参数转换（旧参数 → SPC 对外接口参数）
- 返回字段别名（order_amount→amount_cny、promised_date→due_date）
- 旧能力不可用时的结构化错误（指标端点未开放，不返回伪造/演示数据）

订单查询复用 orders.query_orders（禁止 Tool 调 Tool，避免重复包装错误信封）。
"""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated, Any, Dict, Literal

from pydantic import Field

from . import contracts
from .contracts import BizError
from .orders import alias_order_row, query_orders
from .tool_helpers import (
    READ_ONLY_TOOL,
    LegacyPage,
    LegacyPageSize,
    RequestId,
    as_of_confidence,
    filter_params,
    list_result,
    parse_date,
    tool_error_envelope,
)
from .upstream_client import call as upstream

_MAX_METRIC_SPAN_DAYS = 92


def register_legacy_tools(mcp) -> None:
    """注册 0.1.0 兼容工具（由 server.py 调用一次）"""

    @mcp.tool(annotations=READ_ONLY_TOOL)
    @tool_error_envelope
    async def detail_orders_list(
        customer: Annotated[str, Field(max_length=80, description="客户名称（映射上游 keyword 模糊查询）")] = "",
        product_line: Annotated[str, Field(max_length=40, description="产品线（与 customer 同时提供时优先 customer）")] = "",
        date_from: Annotated[str, Field(max_length=10, description="交期范围起 YYYY-MM-DD（旧参数名为下单日期，上游语义为合同交期）")] = "",
        date_to: Annotated[str, Field(max_length=10, description="交期范围止 YYYY-MM-DD（与 date_from 成对）")] = "",
        page: LegacyPage = 1,
        page_size: LegacyPageSize = 20,
        request_id: RequestId = "",
    ) -> Dict[str, Any]:
        """分页查询订单风险列表（只读，0.1.0 兼容）。至少一个过滤条件；date_from/date_to 映射为上游合同交期范围。"""
        if not (customer or product_line or (date_from and date_to)):
            raise BizError("INVALID_ARGUMENT", "至少需要一个过滤条件：customer / product_line / date_from+date_to")
        if date_from or date_to:
            parse_date(date_from, "date_from")
            parse_date(date_to, "date_to")

        params = filter_params(
            page=page,
            page_size=page_size,
            keyword=customer or product_line,
            promised_date_start=date_from,
            promised_date_end=date_to,
            request_id=request_id,
        )
        payload = await query_orders(params)
        return list_result(
            "detail_orders_list",
            payload,
            page=page,
            page_size=page_size,
            request_id=request_id,
            evidence_entity="order",
            evidence_id=lambda row: str(row.get("order_no") or ""),
            row_transform=alias_order_row,
        )

    @mcp.tool(annotations=READ_ONLY_TOOL)
    @tool_error_envelope
    async def catalog_metrics_list(
        page: LegacyPage = 1,
        page_size: LegacyPageSize = 20,
        request_id: RequestId = "",
    ) -> Dict[str, Any]:
        """列出中台可查询的指标目录（只读，0.1.0 兼容）。SPC 指标端点尚未开放，当前返回能力不可用错误。"""
        raise BizError("UPSTREAM_UNAVAILABLE", "SPC 指标目录端点尚未开放", retryable=False)

    @mcp.tool(annotations=READ_ONLY_TOOL)
    @tool_error_envelope
    async def metric_query(
        metric_code: Annotated[str, Field(min_length=1, max_length=80, description="指标编码")],
        date_from: Annotated[str, Field(description="开始日期 YYYY-MM-DD（含）")],
        date_to: Annotated[str, Field(description="结束日期 YYYY-MM-DD（含）")],
        dimension: Annotated[Literal["day", "week", "month"], Field(description="聚合粒度：day / week / month")] = "day",
        request_id: RequestId = "",
    ) -> Dict[str, Any]:
        """查询中台指标数据（只读，0.1.0 兼容）。保留 92 天跨度校验；SPC 指标端点尚未开放，返回能力不可用错误。"""
        d_from = parse_date(date_from, "date_from")
        d_to = parse_date(date_to, "date_to")
        if d_from > d_to:
            raise BizError("INVALID_ARGUMENT", "date_from 不能晚于 date_to")
        if (d_to - d_from) > timedelta(days=_MAX_METRIC_SPAN_DAYS):
            raise BizError("INVALID_ARGUMENT", f"日期跨度不能超过 {_MAX_METRIC_SPAN_DAYS} 天")
        raise BizError("UPSTREAM_UNAVAILABLE", "SPC 指标查询端点尚未开放", retryable=False)

    @mcp.tool(annotations=READ_ONLY_TOOL)
    @tool_error_envelope
    async def master_material_search(
        keyword: Annotated[str, Field(min_length=2, max_length=80, description="物料编码或名称关键词")],
        page: LegacyPage = 1,
        page_size: LegacyPageSize = 20,
        request_id: RequestId = "",
    ) -> Dict[str, Any]:
        """按关键词检索物料主数据（只读，0.1.0 兼容）。"""
        params = filter_params(keyword=keyword, page=page, page_size=page_size, request_id=request_id)
        payload = await upstream("/external/materials/list", params)
        return list_result(
            "master_material_search",
            payload,
            page=page,
            page_size=page_size,
            request_id=request_id,
            evidence_entity="material",
            evidence_id=lambda row: str(row.get("material_code") or ""),
        )

    @mcp.tool(annotations=READ_ONLY_TOOL)
    @tool_error_envelope
    async def master_supplier_get(
        supplier_code: Annotated[str, Field(min_length=1, max_length=80, description="供应商编码")],
        request_id: RequestId = "",
    ) -> Dict[str, Any]:
        """获取供应商主数据详情（只读，0.1.0 兼容）。不存在时返回 NOT_FOUND。"""
        params = filter_params(keyword=supplier_code, page=1, page_size=200, request_id=request_id)
        payload = await upstream("/external/suppliers/list", params)
        as_of, confidence = as_of_confidence(payload)
        rows = contracts.redact(payload.get("items") or [])
        row = next((r for r in rows if r.get("supplier_code") == supplier_code), None)
        if row is None:
            raise BizError("NOT_FOUND", f"供应商不存在：{supplier_code}")
        return contracts.ok(
            "master_supplier_get",
            row,
            data_as_of=as_of,
            data_confidence=confidence,
            evidence_refs=[contracts.evidence("supplier", supplier_code, as_of)],
            request_id=request_id or None,
        )
