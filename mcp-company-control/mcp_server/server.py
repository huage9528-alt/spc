"""company-control MCP Server — Tool 注册与实现（规范 §6/§7/§8/§10/§14/§16）

运行：
  python -m mcp_server                                    # stdio（默认，AEOS Hub 拉起）
  python -m mcp_server --transport streamable-http ...    # HTTP（需 MCP_HTTP_TOKEN）
目录名用 mcp_server 而非 mcp，避免与 SDK 的 mcp 包在 sys.path 中冲突。
日志只写 stderr，绝不写 stdout（规范 §4）。
"""

from __future__ import annotations

import hmac
import logging
import os
from typing import Annotated, Any, Dict, Optional

from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.mcpserver import MCPServer as FastMCP  # mcp SDK 2.x：FastMCP 已更名 MCPServer
from mcp.server.mcpserver.server import AuthSettings
from mcp.server.mcpserver.utilities.func_metadata import ArgModelBase
from pydantic import ConfigDict, Field

from . import __version__, contracts
from .kitting import register_kitting_tools
from .legacy_compat import register_legacy_tools
from .orders import query_orders
from .quality import register_quality_tools
from .tool_helpers import (
    READ_ONLY_TOOL,
    Page,
    PageSize,
    RequestId,
    as_of_confidence,
    filter_params,
    list_result,
    parse_date,
    parse_iso_datetime,
    tool_error_envelope,
)
from .upstream_client import UpstreamError
from .upstream_client import call as upstream

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")  # 默认 stderr

# 规范 §7：不允许接受任意未定义字段。SDK 生成的参数模型继承此配置，必须在注册 Tool 之前设置。
ArgModelBase.model_config = ConfigDict(arbitrary_types_allowed=True, extra="forbid")

# HTTP 模式静态 Bearer Token（env 注入，禁止硬编码）；为空则不启用 auth（stdio 模式不受影响）
HTTP_TOKEN = os.getenv("MCP_HTTP_TOKEN", "")
HTTP_PUBLIC_URL = os.getenv("MCP_HTTP_PUBLIC_URL", "").rstrip("/") or (
    f"http://127.0.0.1:{os.getenv('MCP_HTTP_PORT') or '8902'}"
)


class StaticTokenVerifier(TokenVerifier):
    """HTTP 模式静态 Bearer Token 校验；常数时间比较，避免时序侧信道"""

    def __init__(self, expected_token: str):
        self._expected_token = expected_token

    async def verify_token(self, token: str) -> AccessToken | None:
        if self._expected_token and hmac.compare_digest(token, self._expected_token):
            return AccessToken(token=token, client_id="static-bearer", scopes=[])
        return None


mcp = FastMCP(
    "company-control",
    version=__version__,
    token_verifier=StaticTokenVerifier(HTTP_TOKEN) if HTTP_TOKEN else None,
    auth=(
        AuthSettings(
            issuer_url=HTTP_PUBLIC_URL,
            resource_server_url=HTTP_PUBLIC_URL,
            validate_token_resource=False,
        )
        if HTTP_TOKEN
        else None
    ),
)

EXPECTED_TOOLS = [
    "get_system_health",
    "orders_list",
    "order_details_list",
    "bom_tree",
    "detail_orders_list",
    "catalog_metrics_list",
    "metric_query",
    "master_material_search",
    "master_supplier_get",
    "material_kitting_results_list",
    "material_shortages_list",
    "material_kitting_demands_list",
    "inventory_availability_list",
    "material_supplies_list",
    "quality_issues_list",
    "quality_trace",
]


@mcp.tool(annotations=READ_ONLY_TOOL)
@tool_error_envelope
async def get_system_health() -> Dict[str, Any]:
    """连接自检（只读）。返回 company-control 能力状态与版本，用于验证 AEOS Agent → MCP → 中台链路连通性。"""
    checked_at = contracts.utc_now_iso()
    upstream_status = "ok"
    upstream_error = None
    evidence_refs: list = []
    try:
        await upstream("/common/ping")  # SPC 对外联调端点（int:health.ping，验证 HMAC 签名配置）
        evidence_refs = [contracts.evidence("health", "ping", checked_at)]
    except UpstreamError as exc:
        upstream_status = "degraded"
        upstream_error = {"code": exc.code, "message": exc.message}

    data: Dict[str, Any] = {
        "status": "ok" if upstream_status == "ok" else "degraded",
        "read_only": True,
        "version": __version__,
        "checked_at": checked_at,
        "upstream_status": upstream_status,
        "capabilities": EXPECTED_TOOLS,
    }
    if upstream_error:
        data["upstream_error"] = upstream_error
    envelope = contracts.ok(
        "get_system_health",
        data,
        data_as_of=checked_at,
        data_confidence="high" if upstream_status == "ok" else "low",
        evidence_refs=evidence_refs,
    )
    # 规范 §16：顶层字段超集（同时保留 §8 标准信封字段）
    envelope.update(
        {
            "status": data["status"],
            "version": data["version"],
            "checked_at": data["checked_at"],
            "capabilities": data["capabilities"],
        }
    )
    return envelope


@mcp.tool(annotations=READ_ONLY_TOOL)
@tool_error_envelope
async def orders_list(
    keyword: Annotated[str, Field(max_length=80, description="关键字（订单号 / 客户 / 产品名 模糊匹配）")] = "",
    status: Annotated[str, Field(max_length=200, description="订单状态（派生值），逗号分隔多选：pending_review / in_progress / partially_closed / completed / cancelled")] = "",
    customer_code: Annotated[str, Field(max_length=80, description="客户编码精确匹配")] = "",
    risk_level: Annotated[str, Field(max_length=40, description="风险等级，逗号分隔多选，如 red,yellow")] = "",
    promised_date_start: Annotated[str, Field(max_length=10, description="合同交期范围起 YYYY-MM-DD（含）")] = "",
    promised_date_end: Annotated[str, Field(max_length=10, description="合同交期范围止 YYYY-MM-DD（含）")] = "",
    updated_after: Annotated[str, Field(max_length=40, description="增量同步锚点 ISO 8601，仅返回 updated_at 不早于该时间的记录")] = "",
    page: Page = 1,
    page_size: PageSize = 20,
    request_id: RequestId = "",
) -> Dict[str, Any]:
    """分页查询销售订单列表（只读）。过滤条件均可选；单页最多 200 条。"""
    if promised_date_start:
        parse_date(promised_date_start, "promised_date_start")
    if promised_date_end:
        parse_date(promised_date_end, "promised_date_end")
    if updated_after:
        parse_iso_datetime(updated_after, "updated_after")

    params = filter_params(
        page=page,
        page_size=page_size,
        keyword=keyword,
        status=status,
        customer_code=customer_code,
        risk_level=risk_level,
        promised_date_start=promised_date_start,
        promised_date_end=promised_date_end,
        updated_after=updated_after,
        request_id=request_id,
    )
    payload = await query_orders(params)
    return list_result(
        "orders_list",
        payload,
        page=page,
        page_size=page_size,
        request_id=request_id,
        evidence_entity="order",
        evidence_id=lambda row: str(row.get("order_no") or ""),
    )


@mcp.tool(annotations=READ_ONLY_TOOL)
@tool_error_envelope
async def order_details_list(
    order_no: Annotated[str, Field(max_length=80, description="订单号精确匹配（拉取某订单的全部明细行）")] = "",
    keyword: Annotated[str, Field(max_length=80, description="关键字（订单号 / 产品名 / 产品型号 模糊匹配）")] = "",
    product_code: Annotated[str, Field(max_length=80, description="产品编码精确匹配")] = "",
    status: Annotated[str, Field(max_length=200, description="明细行状态，逗号分隔多选，如 open,closed")] = "",
    bom_no: Annotated[str, Field(max_length=80, description="BOM 编号精确匹配")] = "",
    promised_date_start: Annotated[str, Field(max_length=10, description="合同交期范围起 YYYY-MM-DD（含）")] = "",
    promised_date_end: Annotated[str, Field(max_length=10, description="合同交期范围止 YYYY-MM-DD（含）")] = "",
    updated_after: Annotated[str, Field(max_length=40, description="增量同步锚点 ISO 8601，仅返回 updated_at 不早于该时间的记录")] = "",
    page: Page = 1,
    page_size: PageSize = 20,
    request_id: RequestId = "",
) -> Dict[str, Any]:
    """分页查询销售订单明细行列表（只读）。过滤条件均可选；单页最多 200 条。"""
    if promised_date_start:
        parse_date(promised_date_start, "promised_date_start")
    if promised_date_end:
        parse_date(promised_date_end, "promised_date_end")
    if updated_after:
        parse_iso_datetime(updated_after, "updated_after")

    params = filter_params(
        page=page,
        page_size=page_size,
        order_no=order_no,
        keyword=keyword,
        product_code=product_code,
        status=status,
        bom_no=bom_no,
        promised_date_start=promised_date_start,
        promised_date_end=promised_date_end,
        updated_after=updated_after,
        request_id=request_id,
    )
    payload = await upstream("/external/order-details/list", params)
    return list_result(
        "order_details_list",
        payload,
        page=page,
        page_size=page_size,
        request_id=request_id,
        evidence_entity="order-detail",
        evidence_id=lambda row: "/".join(
            part for part in (row.get("order_no"), row.get("line_no")) if part
        ),
    )


@mcp.tool(annotations=READ_ONLY_TOOL)
@tool_error_envelope
async def bom_tree(
    bom_id: Annotated[str, Field(min_length=1, max_length=80, description="顶层 BOM ID（必填），以其为根向下展开多级")],
    demand_qty: Annotated[Optional[float], Field(ge=0, description="根需求量；缺省取根 BOM 基础用量，再缺省取 1")] = None,
    flatten: Annotated[bool, Field(description="true 返回扁平列表 items，false 返回嵌套树 tree")] = False,
    request_id: RequestId = "",
) -> Dict[str, Any]:
    """查询已组装好的多级 BOM 树（只读）。仅支持按 bom_id 查询；子件需求量为沿树连乘结果。"""
    params = filter_params(
        bom_id=bom_id,
        flatten="true" if flatten else "false",
        demand_qty=str(demand_qty) if demand_qty is not None else "",
        request_id=request_id,
    )
    payload = await upstream("/external/boms/tree", params)
    as_of, confidence = as_of_confidence(payload)
    return contracts.ok(
        "bom_tree",
        contracts.redact(payload),
        data_as_of=as_of,
        data_confidence=confidence,
        evidence_refs=[contracts.evidence("bom", bom_id, as_of)],
        request_id=request_id or None,
    )


# 0.1.0 向后兼容工具（detail_orders_list / catalog_metrics_list / metric_query /
# master_material_search / master_supplier_get），注册后共 9 个只读 Tool
register_legacy_tools(mcp)

# 物料齐套类工具（结果/缺料/需求/库存可用量/未来供给），注册后共 14 个只读 Tool
register_kitting_tools(mcp)

# 质量类工具（质量异常列表/质量追溯），注册后共 16 个只读 Tool
register_quality_tools(mcp)
