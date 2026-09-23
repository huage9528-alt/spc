"""质量类只读 Tool（质量异常列表 / 质量追溯）— 对齐 AEOS 异常与质量中心交付说明 §7"""

from __future__ import annotations

from typing import Annotated, Any, Dict

from pydantic import Field

from .contracts import BizError
from .tool_helpers import (
    READ_ONLY_TOOL,
    Page,
    PageSize,
    RequestId,
    filter_params,
    list_result,
    parse_date,
    parse_iso_datetime,
    tool_error_envelope,
)
from .upstream_client import call as upstream


def register_quality_tools(mcp) -> None:
    """注册 2 个质量类 Tool（由 server.py 调用一次）"""

    @mcp.tool(annotations=READ_ONLY_TOOL)
    @tool_error_envelope
    async def quality_issues_list(
        issue_no: Annotated[str, Field(max_length=80, description="质量异常编号精确匹配")] = "",
        order_no: Annotated[str, Field(max_length=80, description="订单号精确匹配")] = "",
        product_code: Annotated[str, Field(max_length=80, description="产品编码精确匹配")] = "",
        status: Annotated[str, Field(max_length=120, description="状态，逗号分隔多选：open/in_progress/closed")] = "",
        defect_type: Annotated[str, Field(max_length=80, description="缺陷类型精确匹配")] = "",
        submit_dept: Annotated[str, Field(max_length=80, description="提出部门精确匹配")] = "",
        occurred_start: Annotated[str, Field(max_length=10, description="发生日期起 YYYY-MM-DD（含）")] = "",
        occurred_end: Annotated[str, Field(max_length=10, description="发生日期止 YYYY-MM-DD（含）")] = "",
        updated_after: Annotated[str, Field(max_length=40, description="增量同步锚点 ISO 8601")] = "",
        page: Page = 1,
        page_size: PageSize = 20,
        request_id: RequestId = "",
    ) -> Dict[str, Any]:
        """分页查询质量异常（只读）。无数据源字段（severity/inspection_result/batch_no/supplier_code/material_code/line_no/blocking/issue_type）返回 null，不虚构。"""
        if occurred_start:
            parse_date(occurred_start, "occurred_start")
        if occurred_end:
            parse_date(occurred_end, "occurred_end")
        if updated_after:
            parse_iso_datetime(updated_after, "updated_after")
        params = filter_params(
            page=page, page_size=page_size, issue_no=issue_no, order_no=order_no,
            product_code=product_code, status=status, defect_type=defect_type,
            submit_dept=submit_dept, occurred_start=occurred_start, occurred_end=occurred_end,
            updated_after=updated_after, request_id=request_id,
        )
        payload = await upstream("/external/quality-issues/list", params)
        return list_result(
            "quality_issues_list", payload, page=page, page_size=page_size,
            request_id=request_id, evidence_entity="quality-issue",
            evidence_id=lambda row: str(row.get("issue_no") or ""),
        )

    @mcp.tool(annotations=READ_ONLY_TOOL)
    @tool_error_envelope
    async def quality_trace(
        order_no: Annotated[str, Field(max_length=80, description="追溯锚点：订单号（三选一必填）")] = "",
        product_code: Annotated[str, Field(max_length=80, description="追溯锚点：产品编码（三选一必填）")] = "",
        batch_no: Annotated[str, Field(max_length=128, description="追溯锚点：批次号（三选一必填）")] = "",
        page: Page = 1,
        page_size: PageSize = 20,
        request_id: RequestId = "",
    ) -> Dict[str, Any]:
        """按订单号/产品编码/批次号追溯质量异常、订单行与 BOM 节点（只读）。至少提供 order_no / product_code / batch_no 之一；批次锚点下质量异常为同订单推断关联。"""
        if not (order_no or product_code or batch_no):
            raise BizError("INVALID_ARGUMENT", "至少提供 order_no / product_code / batch_no 之一")
        params = filter_params(
            page=page, page_size=page_size, order_no=order_no,
            product_code=product_code, batch_no=batch_no, request_id=request_id,
        )
        payload = await upstream("/external/quality-trace/list", params)
        return list_result(
            "quality_trace", payload, page=page, page_size=page_size,
            request_id=request_id, evidence_entity="quality-trace",
            evidence_id=lambda row: "/".join(
                str(p) for p in (row.get("object_type"), row.get("object_id")) if p
            ),
        )
