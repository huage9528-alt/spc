"""齐套类只读 Tool（物料齐套结果/缺料/需求/库存可用量/未来供给）— 对齐 AEOS 文档 §9 工具清单"""

from __future__ import annotations

from typing import Annotated, Any, Dict

from pydantic import Field

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


def register_kitting_tools(mcp) -> None:
    """注册 5 个齐套类 Tool（由 server.py 调用一次）"""

    @mcp.tool(annotations=READ_ONLY_TOOL)
    @tool_error_envelope
    async def material_kitting_results_list(
        demand_type: Annotated[str, Field(max_length=32, description="需求对象类型，v1 仅 SALES_ORDER")] = "",
        demand_no: Annotated[str, Field(max_length=80, description="需求对象编号（销售订单号）精确匹配")] = "",
        demand_line_no: Annotated[str, Field(max_length=32, description="需求对象行号精确匹配")] = "",
        kit_status: Annotated[str, Field(max_length=120, description="齐套状态，逗号分隔多选：FULL/PARTIAL/SHORTAGE/BLOCKED/PENDING")] = "",
        risk_level: Annotated[str, Field(max_length=40, description="风险等级，逗号分隔多选：green,yellow,red")] = "",
        required_date_start: Annotated[str, Field(max_length=10, description="需求日期起 YYYY-MM-DD（含）")] = "",
        required_date_end: Annotated[str, Field(max_length=10, description="需求日期止 YYYY-MM-DD（含）")] = "",
        allocation_run_id: Annotated[str, Field(max_length=64, description="计算批次 ID 精确匹配")] = "",
        updated_after: Annotated[str, Field(max_length=40, description="增量同步锚点 ISO 8601")] = "",
        is_deleted: Annotated[bool, Field(description="是否返回已删除结果")] = False,
        page: Page = 1,
        page_size: PageSize = 20,
        request_id: RequestId = "",
    ) -> Dict[str, Any]:
        """分页查询齐套结果（只读）。单页最多 200 条；含状态/齐套率/预计齐套日期。"""
        if required_date_start:
            parse_date(required_date_start, "required_date_start")
        if required_date_end:
            parse_date(required_date_end, "required_date_end")
        if updated_after:
            parse_iso_datetime(updated_after, "updated_after")
        params = filter_params(
            page=page, page_size=page_size, demand_type=demand_type, demand_no=demand_no,
            demand_line_no=demand_line_no, kit_status=kit_status, risk_level=risk_level,
            required_date_start=required_date_start, required_date_end=required_date_end,
            allocation_run_id=allocation_run_id, updated_after=updated_after,
            is_deleted="true" if is_deleted else "", request_id=request_id,
        )
        payload = await upstream("/external/material-kitting/results", params)
        return list_result(
            "material_kitting_results_list", payload, page=page, page_size=page_size,
            request_id=request_id, evidence_entity="kitting-result", allow_stale=True,
            evidence_id=lambda row: "/".join(
                str(p) for p in (row.get("demand_type"), row.get("demand_no"), row.get("demand_line_no")) if p
            ),
        )

    @mcp.tool(annotations=READ_ONLY_TOOL)
    @tool_error_envelope
    async def material_shortages_list(
        demand_no: Annotated[str, Field(max_length=80, description="需求对象编号（销售订单号）精确匹配")] = "",
        material_code: Annotated[str, Field(max_length=80, description="物料编码精确匹配")] = "",
        is_key_material: Annotated[bool, Field(description="仅关键料缺料")] = False,
        updated_after: Annotated[str, Field(max_length=40, description="增量同步锚点 ISO 8601")] = "",
        is_deleted: Annotated[bool, Field(description="是否返回已删除缺料行")] = False,
        page: Page = 1,
        page_size: PageSize = 20,
        request_id: RequestId = "",
    ) -> Dict[str, Any]:
        """分页查询缺料明细（只读）。含净缺口/预计可用日期/缺料原因/责任部门。"""
        if updated_after:
            parse_iso_datetime(updated_after, "updated_after")
        params = filter_params(
            page=page, page_size=page_size, demand_no=demand_no, material_code=material_code,
            is_key_material="true" if is_key_material else "", updated_after=updated_after,
            is_deleted="true" if is_deleted else "", request_id=request_id,
        )
        payload = await upstream("/external/material-kitting/shortages", params)
        return list_result(
            "material_shortages_list", payload, page=page, page_size=page_size,
            request_id=request_id, evidence_entity="shortage", allow_stale=True,
            evidence_id=lambda row: "/".join(
                str(p) for p in (row.get("demand_no"), row.get("material_code")) if p
            ),
        )

    @mcp.tool(annotations=READ_ONLY_TOOL)
    @tool_error_envelope
    async def material_kitting_demands_list(
        order_no: Annotated[str, Field(max_length=80, description="订单号精确匹配")] = "",
        customer_code: Annotated[str, Field(max_length=80, description="客户编码精确匹配")] = "",
        product_code: Annotated[str, Field(max_length=80, description="产品编码精确匹配")] = "",
        updated_after: Annotated[str, Field(max_length=40, description="增量同步锚点 ISO 8601")] = "",
        is_deleted: Annotated[bool, Field(description="是否返回已关闭/已删除订单")] = False,
        page: Page = 1,
        page_size: PageSize = 20,
        request_id: RequestId = "",
    ) -> Dict[str, Any]:
        """分页查询齐套需求对象（销售订单行，只读）。含数量/需求日期/优先级/状态。"""
        if updated_after:
            parse_iso_datetime(updated_after, "updated_after")
        params = filter_params(
            page=page, page_size=page_size, order_no=order_no, customer_code=customer_code,
            product_code=product_code, updated_after=updated_after,
            is_deleted="true" if is_deleted else "", request_id=request_id,
        )
        payload = await upstream("/external/material-kitting/demands", params)
        return list_result(
            "material_kitting_demands_list", payload, page=page, page_size=page_size,
            request_id=request_id, evidence_entity="demand", allow_stale=True,
            evidence_id=lambda row: "/".join(
                str(p) for p in (row.get("demand_no"), row.get("demand_line_no")) if p
            ),
        )

    @mcp.tool(annotations=READ_ONLY_TOOL)
    @tool_error_envelope
    async def inventory_availability_list(
        material_code: Annotated[str, Field(max_length=80, description="物料编码精确匹配")] = "",
        keyword: Annotated[str, Field(max_length=80, description="关键字（物料编码/名称 模糊匹配）")] = "",
        wh_code: Annotated[str, Field(max_length=32, description="仓库编码精确匹配（先按仓过滤再按物料聚合）")] = "",
        updated_after: Annotated[str, Field(max_length=40, description="增量同步锚点 ISO 8601")] = "",
        page: Page = 1,
        page_size: PageSize = 20,
        request_id: RequestId = "",
    ) -> Dict[str, Any]:
        """分页查询按物料聚合的库存可用量（只读）。available_qty = 现存 − 锁定（全仓汇总）。"""
        if updated_after:
            parse_iso_datetime(updated_after, "updated_after")
        params = filter_params(
            page=page, page_size=page_size, material_code=material_code, keyword=keyword,
            wh_code=wh_code, updated_after=updated_after, request_id=request_id,
        )
        payload = await upstream("/external/inventory/availability", params)
        return list_result(
            "inventory_availability_list", payload, page=page, page_size=page_size,
            request_id=request_id, evidence_entity="inventory", allow_stale=True,
            evidence_id=lambda row: str(row.get("material_code") or ""),
        )

    @mcp.tool(annotations=READ_ONLY_TOOL)
    @tool_error_envelope
    async def material_supplies_list(
        material_code: Annotated[str, Field(max_length=80, description="物料编码精确匹配")] = "",
        supply_type: Annotated[str, Field(max_length=80, description="供给类型，逗号分隔多选：PURCHASE/OUTSOURCE/PRODUCTION/TRANSFER")] = "",
        supply_no: Annotated[str, Field(max_length=80, description="供给单号精确匹配")] = "",
        expected_date_start: Annotated[str, Field(max_length=10, description="预计可用日期起 YYYY-MM-DD（含）")] = "",
        expected_date_end: Annotated[str, Field(max_length=10, description="预计可用日期止 YYYY-MM-DD（含）")] = "",
        updated_after: Annotated[str, Field(max_length=40, description="增量同步锚点 ISO 8601")] = "",
        page: Page = 1,
        page_size: PageSize = 20,
        request_id: RequestId = "",
    ) -> Dict[str, Any]:
        """分页查询未来供给（只读）。四类来源统一：采购在途/委外回货/自制计划/调拨。"""
        if expected_date_start:
            parse_date(expected_date_start, "expected_date_start")
        if expected_date_end:
            parse_date(expected_date_end, "expected_date_end")
        if updated_after:
            parse_iso_datetime(updated_after, "updated_after")
        params = filter_params(
            page=page, page_size=page_size, material_code=material_code, supply_type=supply_type,
            supply_no=supply_no, expected_date_start=expected_date_start,
            expected_date_end=expected_date_end, updated_after=updated_after, request_id=request_id,
        )
        payload = await upstream("/external/material-supplies/list", params)
        return list_result(
            "material_supplies_list", payload, page=page, page_size=page_size,
            request_id=request_id, evidence_entity="supply", allow_stale=True,
            evidence_id=lambda row: "/".join(
                str(p) for p in (row.get("supply_type"), row.get("supply_no"), row.get("supply_line_no")) if p
            ),
        )
