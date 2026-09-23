"""独立测试脚本 — 34 项，按「旧版回归 / 新版链路 / HTTP 传输」分组输出

运行（在 mcp-company-control/ 目录下）：
    python scripts/test_company_control.py

内置 mock 中台端点（127.0.0.1 随机端口），无需真实中台：
  - stdio：以子进程拉起 mcp_server，用 MCP client 完成真实握手与调用
  - streamable-http：以子进程拉起 --transport streamable-http，验证鉴权与握手

分组：
  - 旧版回归：0.1.0 兼容工具存在、旧 Schema/分页上限、参数与字段映射、能力未开放错误、健康检查修正
  - 新版链路：orders/details/bom 正常链路、错误映射、脱敏、幂等、evidence、齐套 5 工具、质量 2 工具
  - HTTP 传输：401 鉴权、握手、缺 token 拒绝启动
"""

import asyncio
import hashlib
import hmac
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)
if hasattr(sys.stdout, "reconfigure"):  # GBK 控制台下的中文输出
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import httpx2  # noqa: E402
from mcp import ClientSession, StdioServerParameters  # noqa: E402
from mcp.client.stdio import stdio_client  # noqa: E402
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client  # noqa: E402

EXPECTED_TOOLS = {
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
}

DATA_AS_OF = "2026-09-19T18:00:00Z"

ORDERS = [
    {
        "id": 1,
        "order_no": "SO-2609-001",
        "line_no": "1",
        "customer": "示例客户A",
        "customer_code": "C-001",
        "product_code": "P-100",
        "product_name": "商业照明灯",
        "order_qty": 100.0,
        "completed_qty": 10.0,
        "order_amount": 1280000.0,
        "status": "in_progress",
        "erp_status": 1,
        "delivery_completed_date": None,
        "risk_level": "red",
        "promised_date": "2026-09-20",
        "planned_start_date": "2026-09-10",
        "owner": "张三",
        "updated_at": "2026-09-19T10:00:00",
        "phone": "13800001111",  # 仅用于脱敏断言（真实端点无此字段）
    },
    {
        "id": 2,
        "order_no": "SO-2609-002",
        "line_no": "1",
        "customer": "示例客户B",
        "customer_code": "C-002",
        "product_code": "P-200",
        "product_name": "户外照明灯",
        "order_qty": 50.0,
        "completed_qty": 0.0,
        "order_amount": 560000.0,
        "status": "completed",
        "erp_status": 3,
        "delivery_completed_date": "2026-09-18",
        "risk_level": "yellow",
        "promised_date": "2026-09-28",
        "planned_start_date": "2026-09-15",
        "owner": "李四",
        "updated_at": "2026-09-18T09:00:00",
    },
]

ORDER_DETAILS = [
    {
        "id": 11,
        "sale_order_id": 1,
        "order_no": "SO-2609-001",
        "line_no": "1",
        "product_code": "P-100",
        "product_name": "商业照明灯",
        "product_model": "LED-60W",
        "order_qty": 100.0,
        "order_amount": 1280000.0,
        "promised_date": "2026-09-20",
        "batch_no": "B-2609",
        "bom_no": "BOM-001",
        "bom_id": 1001,
        "labor_price_amount": 3200.0,
        "status": "open",
        "customer": "示例客户A",
        "customer_code": "C-001",
    },
]

BOM_TREE = {
    "bom_id": "BOM-001",
    "bom_no": "BOM-001",
    "material_id": 1001,
    "base_qty": 1.0,
    "demand_qty": 1.0,
    "bom_version": "V1",
    "bom_type": "量产",
    "flatten": False,
    "total_nodes": 2,
    "max_level": 1,
    "tree": [
        {
            "bom_id": "BOM-001",
            "material_id": 1001,
            "material_code": "M-100",
            "material_name": "灯壳",
            "standard_qty": 1.0,
            "level": 1,
            "parent_material_id": None,
            "children": [
                {
                    "bom_id": None,
                    "material_id": 2001,
                    "material_code": "M-200",
                    "material_name": "螺丝",
                    "standard_qty": 4.0,
                    "level": 2,
                    "parent_material_id": 1001,
                    "children": [],
                }
            ],
        }
    ],
}

MATERIALS = [
    {
        "id": 1,
        "erp_material_id": 10001,
        "material_code": "MO-8821",
        "material_name": "LED 驱动电源 60W",
        "spec_model": "60W",
        "material_type": "电子件",
        "unit_of_measure": "个",
        "brand": "示例品牌",
        "is_purchase": 1,
        "is_produce": 0,
        "status": 1,
        "supplier_id": 10,
        "supplier_name": "示例供应商",
        "order_unit_price": 42.5,
        "last_outbound_date": "2026-09-18",
        "update_time": "2026-09-19T10:00:00",
    },
    {
        "id": 2,
        "erp_material_id": 10002,
        "material_code": "MS-3310",
        "material_name": "铝合金压铸件-灯壳",
        "spec_model": "A-100",
        "material_type": "结构件",
        "unit_of_measure": "件",
        "brand": None,
        "is_purchase": 1,
        "is_produce": 1,
        "status": 1,
        "supplier_id": None,
        "supplier_name": None,
        "order_unit_price": 18.0,
        "last_outbound_date": None,
        "update_time": "2026-09-18T09:00:00",
    },
]

SUPPLIERS = [
    {
        "id": 10,
        "supplier_code": "SUP-001",
        "supplier_name": "示例供应商",
        "supplier_short": "示例",
        "supplier_type": "外协",
        "contact_person": "张三",
        "contact_phone": "137****3333",
        "payment_terms": "月结30天",
        "status": 1,
        "update_time": "2026-09-19T08:00:00",
    },
]

KITTING_RESULTS = [
    {
        "demand_type": "SALES_ORDER",
        "demand_no": "SO-2609-001",
        "demand_line_no": "1",
        "kit_status": "PARTIAL",
        "kit_rate_by_item": 66.67,
        "allocation_run_id": "run-2609-a",
        "calculation_version": "1.0.0",
    },
    {
        "demand_type": "SALES_ORDER",
        "demand_no": "SO-2609-002",
        "demand_line_no": "1",
        "kit_status": "FULL",
        "kit_rate_by_item": 100.0,
        "allocation_run_id": "run-2609-a",
        "calculation_version": "1.0.0",
    },
]

KITTING_SHORTAGES = [
    {
        "demand_no": "SO-2609-001",
        "material_code": "M-100",
        "shortage_qty": 12.5,
        "shortage_reason": "NO_STOCK",
    },
    {
        "demand_no": "SO-2609-001",
        "material_code": "M-200",
        "shortage_qty": 3.0,
        "shortage_reason": "SUPPLY_LATE",
    },
]

KITTING_DEMANDS = [
    {
        "demand_no": "SO-2609-001",
        "demand_line_no": "1",
        "product_code": "P-100",
        "required_date": "2026-09-20",
    },
    {
        "demand_no": "SO-2609-002",
        "demand_line_no": "1",
        "product_code": "P-200",
        "required_date": "2026-09-28",
    },
]

INVENTORY_AVAILABILITY = [
    {"material_code": "M-100", "available_qty": 88.0},
    {"material_code": "M-200", "available_qty": 0.0},
]

MATERIAL_SUPPLIES = [
    {
        "supply_type": "PURCHASE",
        "supply_no": "PO-2609-001",
        "supply_line_no": "1",
        "material_code": "M-100",
        "supply_qty": 200.0,
    },
    {
        "supply_type": "TRANSFER",
        "supply_no": "TR-2609-001",
        "supply_line_no": "1",
        "material_code": "M-200",
        "supply_qty": 50.0,
    },
]

QUALITY_ISSUES = [
    {
        "issue_no": "QI-20260922-0001",
        "title": "来料尺寸超差",
        "status": "open",
        "order_no": "SO-2609-001",
        "product_code": "P-100",
        "severity": None,
        "inspection_result": None,
        "owner": "李四",
        "owner_org": "品质部",
        "occurred_at": "2026-09-22",
    },
    {
        "issue_no": "QI-20260922-0002",
        "title": "外壳划伤",
        "status": "in_progress",
        "order_no": "SO-2609-001",
        "product_code": "P-100",
        "severity": None,
        "inspection_result": None,
        "owner": "赵六",
        "owner_org": "生产部",
        "occurred_at": "2026-09-21",
    },
]

QUALITY_TRACE = [
    {
        "object_type": "quality_issue",
        "object_id": "QI-20260922-0001",
        "relation": "order_no",
        "order_no": "SO-2609-001",
        "issue_no": "QI-20260922-0001",
        "severity": None,
        "owner": "李四",
    },
    {
        "object_type": "order_line",
        "object_id": "SO-2609-001:1",
        "relation": "order_no",
        "order_no": "SO-2609-001",
        "line_no": "1",
        "product_code": "P-100",
        "batch_no": "B-2609",
        "bom_no": "BOM-001",
        "bom_id": 1001,
    },
    {
        "object_type": "bom",
        "object_id": "BOM-001",
        "relation": "order_line",
        "order_no": "SO-2609-001",
        "bom_no": "BOM-001",
        "bom_version": "V1",
    },
]

MOCK_STATE = {"mode": "normal", "last_query": None}

# 与 SPC「数据供给」HMAC 机制一致的校验参数
MOCK_APP_KEY = "test-app-key"
MOCK_APP_SECRET = "test-secret"
MOCK_ENDPOINT_CODES = {
    "/common/ping": "int:health.ping",
    "/external/orders/list": "orders.list",
    "/external/order-details/list": "order_details.list",
    "/external/boms/tree": "boms.tree",
    "/external/materials/list": "materials.list",
    "/external/suppliers/list": "suppliers.list",
    "/external/material-kitting/results": "kitting.results",
    "/external/material-kitting/shortages": "kitting.shortages",
    "/external/material-kitting/demands": "kitting.demands",
    "/external/inventory/availability": "inventory.availability",
    "/external/material-supplies/list": "material.supplies",
    "/external/quality-issues/list": "quality_issues.list",
    "/external/quality-trace/list": "quality_trace.list",
}

# 齐套类 mock 路由（stale_kitting 模式只影响这些路径）
KITTING_MOCK_PATHS = {
    "/external/material-kitting/results",
    "/external/material-kitting/shortages",
    "/external/material-kitting/demands",
    "/external/inventory/availability",
    "/external/material-supplies/list",
}

MCP_HTTP_TOKEN = "test-http-token"


class MockHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静默，避免刷屏
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass  # 客户端超时主动断开属预期（timeout 模式）

    def _list_envelope(self, rows, q, stale=False):
        """列表类端点统一信封：items + 分页 + 新鲜度元信息"""
        return {
            "code": 0,
            "message": "ok",
            "data": {
                "items": rows,
                "total": len(rows),
                "page": int(q.get("page", 1)),
                "page_size": int(q.get("page_size", 20)),
                "data_as_of": DATA_AS_OF,
                "data_confidence": "low" if stale else "high",
                "stale": stale,
            },
        }

    def do_POST(self):
        if urlparse(self.path).path == "/oauth/token":
            self._json({"access_token": "mock-token", "expires_in": 3600})
        else:
            self._json({"error": "not found"}, 404)

    def _verify_signature(self, parsed) -> bool:
        """与 SPC validate_signature_for_endpoint 同算法：HMAC-SHA256(secret, ts+app_key+endpoint_code+query)"""
        app_key = self.headers.get("X-App-Key")
        if not app_key:
            return True  # Bearer 模式不校验签名
        ts = self.headers.get("X-Timestamp", "")
        sig = self.headers.get("X-Signature", "")
        if app_key != MOCK_APP_KEY or not ts.isdigit() or abs(int(time.time()) - int(ts)) > 300:
            return False
        endpoint_code = MOCK_ENDPOINT_CODES.get(parsed.path)
        if not endpoint_code:
            return False
        expected = hmac.new(
            MOCK_APP_SECRET.encode("utf-8"),
            f"{ts}{app_key}{endpoint_code}{parsed.query}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(sig, expected)

    def do_GET(self):
        mode = MOCK_STATE["mode"]
        if mode == "timeout":
            time.sleep(3.0)
            return self._json({"code": 0, "message": "ok", "data": {"items": [], "total": 0}})
        if mode == "unauth":
            return self._json({"error": "invalid token"}, 401)
        if mode == "unavailable":
            return self._json({"error": "upstream down"}, 503)
        if mode == "ratelimit":
            return self._json({"error": "too many requests"}, 429)
        if mode == "stale":
            return self._json(
                {
                    "code": 0,
                    "message": "ok",
                    "data": {"items": [], "total": 0, "stale": True, "data_confidence": "low"},
                }
            )

        parsed = urlparse(self.path)
        if mode == "stale_kitting" and parsed.path in KITTING_MOCK_PATHS:
            return self._json(
                {
                    "code": 0,
                    "message": "ok",
                    "data": {
                        "items": KITTING_RESULTS[:1],
                        "total": 1,
                        "page": 1,
                        "page_size": 20,
                        "data_as_of": DATA_AS_OF,
                        "data_confidence": "low",
                        "stale": True,
                    },
                }
            )
        if not self._verify_signature(parsed):
            return self._json({"error": "signature invalid"}, 401)
        q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        route = parsed.path

        if route == "/common/ping":
            return self._json({"code": 0, "message": "pong", "data": {"ok": True}})
        if route == "/external/orders/list":
            MOCK_STATE["last_query"] = q
            rows = ORDERS
            if q.get("customer_code"):
                rows = [o for o in rows if o["customer_code"] == q["customer_code"]]
            if q.get("keyword"):
                kw = q["keyword"]
                rows = [
                    o
                    for o in rows
                    if kw in o["order_no"] or kw in o["customer"] or kw in o["product_name"]
                ]
            return self._json(
                {
                    "code": 0,
                    "message": "ok",
                    "data": {
                        "items": rows,
                        "total": len(rows),
                        "page": int(q.get("page", 1)),
                        "page_size": int(q.get("page_size", 20)),
                    },
                }
            )
        if route == "/external/order-details/list":
            rows = ORDER_DETAILS
            if q.get("order_no"):
                rows = [r for r in rows if r["order_no"] == q["order_no"]]
            return self._json(
                {
                    "code": 0,
                    "message": "ok",
                    "data": {
                        "items": rows,
                        "total": len(rows),
                        "page": int(q.get("page", 1)),
                        "page_size": int(q.get("page_size", 20)),
                    },
                }
            )
        if route == "/external/boms/tree":
            if str(q.get("flatten", "")).lower() in ("1", "true", "yes"):
                flat_items: list = []

                def _walk(nodes):
                    for node in nodes:
                        flat_items.append({k: v for k, v in node.items() if k != "children"})
                        _walk(node.get("children") or [])

                _walk(BOM_TREE["tree"])
                data = {k: v for k, v in BOM_TREE.items() if k != "tree"}
                data["flatten"] = True
                data["items"] = flat_items
                return self._json({"code": 0, "message": "ok", "data": data})
            return self._json({"code": 0, "message": "ok", "data": BOM_TREE})
        if route == "/external/materials/list":
            rows = MATERIALS
            if q.get("keyword"):
                kw = q["keyword"]
                rows = [
                    m
                    for m in rows
                    if kw in (m["material_code"] or "")
                    or kw in (m["material_name"] or "")
                    or kw in (m.get("spec_model") or "")
                ]
            return self._json(
                {
                    "code": 0,
                    "message": "ok",
                    "data": {
                        "items": rows,
                        "total": len(rows),
                        "page": int(q.get("page", 1)),
                        "page_size": int(q.get("page_size", 20)),
                    },
                }
            )
        if route == "/external/suppliers/list":
            rows = SUPPLIERS
            if q.get("keyword"):
                kw = q["keyword"]
                rows = [
                    s
                    for s in rows
                    if kw in (s["supplier_code"] or "")
                    or kw in (s["supplier_name"] or "")
                    or kw in (s.get("supplier_short") or "")
                ]
            return self._json(
                {
                    "code": 0,
                    "message": "ok",
                    "data": {
                        "items": rows,
                        "total": len(rows),
                        "page": int(q.get("page", 1)),
                        "page_size": int(q.get("page_size", 20)),
                    },
                }
            )
        if route == "/external/material-kitting/results":
            rows = KITTING_RESULTS
            if q.get("demand_no"):
                rows = [r for r in rows if r["demand_no"] == q["demand_no"]]
            return self._json(self._list_envelope(rows, q))
        if route == "/external/material-kitting/shortages":
            rows = KITTING_SHORTAGES
            if q.get("demand_no"):
                rows = [r for r in rows if r["demand_no"] == q["demand_no"]]
            if q.get("material_code"):
                rows = [r for r in rows if r["material_code"] == q["material_code"]]
            return self._json(self._list_envelope(rows, q))
        if route == "/external/material-kitting/demands":
            rows = KITTING_DEMANDS
            if q.get("order_no"):
                rows = [r for r in rows if r["demand_no"] == q["order_no"]]
            return self._json(self._list_envelope(rows, q))
        if route == "/external/inventory/availability":
            rows = INVENTORY_AVAILABILITY
            if q.get("material_code"):
                rows = [r for r in rows if r["material_code"] == q["material_code"]]
            return self._json(self._list_envelope(rows, q))
        if route == "/external/material-supplies/list":
            rows = MATERIAL_SUPPLIES
            if q.get("material_code"):
                rows = [r for r in rows if r["material_code"] == q["material_code"]]
            if q.get("supply_type"):
                wanted = {s.strip().upper() for s in q["supply_type"].split(",")}
                rows = [r for r in rows if r["supply_type"] in wanted]
            return self._json(self._list_envelope(rows, q))
        if route == "/external/quality-issues/list":
            rows = QUALITY_ISSUES
            if q.get("issue_no"):
                rows = [r for r in rows if r["issue_no"] == q["issue_no"]]
            if q.get("order_no"):
                rows = [r for r in rows if r["order_no"] == q["order_no"]]
            if q.get("status"):
                wanted = {s.strip() for s in q["status"].split(",")}
                rows = [r for r in rows if r["status"] in wanted]
            return self._json(self._list_envelope(rows, q))
        if route == "/external/quality-trace/list":
            rows = [
                r for r in QUALITY_TRACE
                if not q.get("order_no") or r.get("order_no") == q["order_no"]
            ]
            return self._json(self._list_envelope(rows, q))
        return self._json({"error": "not found"}, 404)


def start_mock():
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def stdio_server_params(base_url):
    env = {
        **os.environ,
        "CONTROL_PLATFORM_BASE_URL": base_url,
        "CONTROL_PLATFORM_APP_KEY": MOCK_APP_KEY,
        "CONTROL_PLATFORM_APP_SECRET": MOCK_APP_SECRET,
        "CONTROL_PLATFORM_TIMEOUT_MS": "800",
        "CONTROL_PLATFORM_CONNECT_TIMEOUT_MS": "500",
        "MCP_TRANSPORT": "",
        "MCP_HTTP_TOKEN": "",
        "PYTHONUNBUFFERED": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    return StdioServerParameters(command=sys.executable, args=["-m", "mcp_server"], cwd=PROJECT_ROOT, env=env)


async def call_tool(session, name, args):
    """调用 tool，返回 (is_error, 解析后的 JSON 或原始文本)。"""
    result = await session.call_tool(name, args)
    text = result.content[0].text if result.content else ""
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        parsed = None
    return bool(result.is_error), parsed


# ---------------- stdio 检查（规范 §20 + 0.1.0 兼容） ----------------

async def check_01_initialize(session, init_result):
    assert init_result.server_info.name == "company-control", f"server_info.name={init_result.server_info.name}"
    assert init_result.server_info.version == "1.1.0", f"server_info.version={init_result.server_info.version!r}"


async def check_02_tools_list(session):
    tools = await session.list_tools()
    names = {t.name for t in tools.tools}
    assert names == EXPECTED_TOOLS, f"tools={names}"


async def check_03_normal_structured(session):
    _, body = await call_tool(session, "orders_list", {"keyword": "示例", "request_id": "req-001"})
    for key in (
        "source",
        "capability",
        "read_only",
        "generated_at",
        "data_confidence",
        "data_as_of",
        "evidence_refs",
        "data",
        "page",
    ):
        assert key in body, f"缺少字段 {key}"
    assert body["source"] == "company-control" and body["read_only"] is True
    assert body["capability"] == "orders_list" and body["data"]
    assert body.get("request_id") == "req-001", f"request_id 未回显: {body.get('request_id')}"
    row = body["data"][0]
    assert "erp_status" in row and "delivery_completed_date" in row, f"缺少派生状态依据字段: {row}"


async def check_04_invalid_input(session):
    # 日期格式非法 → 结构化 INVALID_ARGUMENT
    _, body = await call_tool(session, "orders_list", {"promised_date_start": "2026/01/01"})
    assert body and body.get("error", {}).get("code") == "INVALID_ARGUMENT", f"日期校验失败: {body}"
    # updated_after 非 ISO 8601 → INVALID_ARGUMENT
    _, body = await call_tool(session, "order_details_list", {"updated_after": "昨天"})
    assert body and body.get("error", {}).get("code") == "INVALID_ARGUMENT", f"时间校验失败: {body}"
    # 必填缺失（bom_id）→ Schema 层拒绝
    is_error, body = await call_tool(session, "bom_tree", {})
    assert is_error or (body and body.get("error", {}).get("code") == "INVALID_ARGUMENT"), "bom_id 缺失未被拒绝"
    # 类型非法 → 被拒绝（Schema 层）
    is_error, body = await call_tool(session, "orders_list", {"page_size": "abc"})
    assert is_error or (body and body.get("error", {}).get("code") == "INVALID_ARGUMENT"), "类型非法未被拒绝"
    # 未定义字段 → 被拒绝（§7）
    is_error, body = await call_tool(session, "orders_list", {"page": 1, "unknown_field": "x"})
    assert is_error or (body and body.get("error", {}).get("code") == "INVALID_ARGUMENT"), "未定义字段未被拒绝"
    # 数值越界（page_size > 200）→ 被拒绝
    is_error, body = await call_tool(session, "orders_list", {"page_size": 201})
    assert is_error or (body and body.get("error", {}).get("code") == "INVALID_ARGUMENT"), "越界值未被拒绝"
    # 拒绝后服务仍存活
    _, body = await call_tool(session, "get_system_health", {})
    assert body and body["data"]["status"] == "ok"


async def check_05_unauthorized(session):
    MOCK_STATE["mode"] = "unauth"
    try:
        _, body = await call_tool(session, "orders_list", {})
        err = body.get("error", {})
        assert err.get("code") == "UNAUTHORIZED" and err.get("retryable") is False, f"{body}"
    finally:
        MOCK_STATE["mode"] = "normal"


async def check_06_upstream_timeout(session):
    MOCK_STATE["mode"] = "timeout"
    try:
        _, body = await call_tool(session, "order_details_list", {"order_no": "SO-2609-001"})
        err = body.get("error", {})
        assert err.get("code") == "UPSTREAM_TIMEOUT" and err.get("retryable") is True, f"{body}"
    finally:
        MOCK_STATE["mode"] = "normal"


async def check_07_upstream_unavailable(session):
    MOCK_STATE["mode"] = "unavailable"
    try:
        _, body = await call_tool(session, "bom_tree", {"bom_id": "BOM-001"})
        assert body.get("error", {}).get("code") == "UPSTREAM_UNAVAILABLE", f"{body}"
    finally:
        MOCK_STATE["mode"] = "normal"
    # 进程未崩溃：恢复正常后可继续调用
    _, body = await call_tool(session, "get_system_health", {})
    assert body and body["data"]["status"] == "ok", "上游不可用导致进程崩溃"


async def check_08_evidence_refs(session):
    _, body = await call_tool(session, "orders_list", {"customer_code": "C-001"})
    refs = body.get("evidence_refs") or []
    assert refs and all(r.startswith("control-platform://order/SO-") and "@" in r for r in refs), f"{refs}"
    _, body = await call_tool(session, "order_details_list", {"order_no": "SO-2609-001"})
    refs = body.get("evidence_refs") or []
    assert refs and all(r.startswith("control-platform://order-detail/SO-2609-001/") for r in refs), f"{refs}"
    _, body = await call_tool(session, "bom_tree", {"bom_id": "BOM-001"})
    refs = body.get("evidence_refs") or []
    assert refs and refs[0].startswith("control-platform://bom/BOM-001@"), f"{refs}"


async def check_09_sensitive_fields(session):
    _, body = await call_tool(session, "orders_list", {"customer_code": "C-001"})
    raw = json.dumps(body, ensure_ascii=False)
    assert "13800001111" not in raw, "手机号未脱敏"
    row = body["data"][0]
    assert row.get("phone") == "***", f"敏感字段未脱敏: {row}"


async def check_10_no_write_tools(session):
    tools = await session.list_tools()
    for t in tools.tools:
        assert t.name in EXPECTED_TOOLS, f"未声明的工具: {t.name}"
        assert "只读" in (t.description or ""), f"{t.name} 描述缺少只读声明"


async def check_11_idempotent_read(session):
    _, a = await call_tool(session, "orders_list", {"customer_code": "C-001"})
    _, b = await call_tool(session, "orders_list", {"customer_code": "C-001"})
    assert a["data"] == b["data"], "重复查询业务数据不一致"
    # evidence 的 as_of 为观测时间（上游未返回 data_as_of），只比较目标部分
    assert [r.split("@")[0] for r in a["evidence_refs"]] == [
        r.split("@")[0] for r in b["evidence_refs"]
    ], "重复查询 evidence 目标不一致"


async def check_12_health(session):
    _, body = await call_tool(session, "get_system_health", {})
    data = body.get("data", {})
    assert data.get("status") == "ok", f"{data}"
    assert data.get("read_only") is True and data.get("version") == "1.1.0"
    assert set(data.get("capabilities", [])) == EXPECTED_TOOLS
    # §16 顶层字段超集
    assert body.get("status") == "ok" and body.get("version") == "1.1.0"
    assert body.get("checked_at") and set(body.get("capabilities", [])) == EXPECTED_TOOLS


async def check_13_stale_data(session):
    MOCK_STATE["mode"] = "stale"
    try:
        _, body = await call_tool(session, "orders_list", {})
        err = body.get("error", {})
        assert err.get("code") == "STALE_DATA" and err.get("retryable") is True, f"{body}"
    finally:
        MOCK_STATE["mode"] = "normal"


async def check_14_legacy_tools_present(session):
    """0.1.0 兼容工具全部存在，且旧参数 Schema 可正常调用"""
    tools = await session.list_tools()
    names = {t.name for t in tools.tools}
    legacy = {
        "catalog_metrics_list",
        "metric_query",
        "master_material_search",
        "master_supplier_get",
        "detail_orders_list",
    }
    assert legacy <= names, f"缺少兼容工具: {legacy - names}"
    is_error, body = await call_tool(
        session, "detail_orders_list", {"customer": "示例客户A", "page": 1, "page_size": 20}
    )
    assert not is_error and body and body.get("capability") == "detail_orders_list", f"{body}"


async def check_15_metrics_capability_unavailable(session):
    """指标类工具返回结构化「能力未开放」错误，不返回空数组成功"""
    for name, args in (
        ("catalog_metrics_list", {"page": 1, "page_size": 20}),
        (
            "metric_query",
            {"metric_code": "OTD", "date_from": "2026-09-01", "date_to": "2026-09-19", "dimension": "day"},
        ),
    ):
        _, body = await call_tool(session, name, args)
        err = (body or {}).get("error", {})
        assert err.get("code") == "UPSTREAM_UNAVAILABLE", f"{name}: {body}"
        assert err.get("retryable") is False, f"{name}: retryable 应为 false: {body}"
        assert "data" not in body, f"{name}: 能力不可用时不应返回 data"


async def check_16_metric_query_legacy_validation(session):
    """metric_query 保留 92 天跨度校验"""
    _, body = await call_tool(
        session, "metric_query", {"metric_code": "OTD", "date_from": "2026-01-01", "date_to": "2026-09-19"}
    )
    assert body and body.get("error", {}).get("code") == "INVALID_ARGUMENT", f"{body}"


async def check_17_material_search(session):
    """master_material_search 功能兼容：关键词检索 + 证据 + 旧分页上限 100"""
    _, body = await call_tool(session, "master_material_search", {"keyword": "电源"})
    assert body and body.get("capability") == "master_material_search", f"{body}"
    assert body.get("data"), f"未返回物料数据: {body}"
    refs = body.get("evidence_refs") or []
    assert refs and all(r.startswith("control-platform://material/") for r in refs), f"{refs}"
    is_error, body = await call_tool(session, "master_material_search", {"keyword": "电源", "page_size": 101})
    assert is_error or (body and body.get("error", {}).get("code") == "INVALID_ARGUMENT"), f"旧分页上限未生效: {body}"


async def check_18_supplier_get(session):
    """master_supplier_get 功能兼容：命中返回单对象，未命中 NOT_FOUND，电话脱敏"""
    _, body = await call_tool(session, "master_supplier_get", {"supplier_code": "SUP-001"})
    assert body and body.get("capability") == "master_supplier_get", f"{body}"
    row = body.get("data") or {}
    assert row.get("supplier_code") == "SUP-001", f"{body}"
    assert row.get("contact_phone") == "***", f"联系电话未脱敏: {row}"
    refs = body.get("evidence_refs") or []
    assert refs and refs[0].startswith("control-platform://supplier/SUP-001@"), f"{refs}"
    _, body = await call_tool(session, "master_supplier_get", {"supplier_code": "SUP-404"})
    assert body and body.get("error", {}).get("code") == "NOT_FOUND", f"{body}"


async def check_19_detail_orders_mapping(session):
    """detail_orders_list 参数映射（customer→keyword、日期→合同交期）与字段别名"""
    MOCK_STATE["last_query"] = None
    _, body = await call_tool(
        session,
        "detail_orders_list",
        {"customer": "示例客户A", "date_from": "2026-09-01", "date_to": "2026-09-30"},
    )
    assert body and body.get("capability") == "detail_orders_list", f"{body}"
    q = MOCK_STATE.get("last_query") or {}
    assert q.get("keyword") == "示例客户A", f"customer 未映射 keyword: {q}"
    assert q.get("promised_date_start") == "2026-09-01" and q.get("promised_date_end") == "2026-09-30", (
        f"日期未映射: {q}"
    )
    row = (body.get("data") or [{}])[0]
    assert "amount_cny" in row and row["amount_cny"] == row.get("order_amount"), f"缺少 amount_cny 别名: {row}"
    assert "due_date" in row and row["due_date"] == row.get("promised_date"), f"缺少 due_date 别名: {row}"
    assert "risk_probability" not in row, "不应伪造 risk_probability"
    # customer 与 product_line 同时提供时 customer 优先
    MOCK_STATE["last_query"] = None
    await call_tool(session, "detail_orders_list", {"customer": "示例客户A", "product_line": "户外照明"})
    q = MOCK_STATE.get("last_query") or {}
    assert q.get("keyword") == "示例客户A", f"customer 应优先于 product_line: {q}"
    # 旧契约：至少一个过滤条件
    _, body = await call_tool(session, "detail_orders_list", {})
    assert body and body.get("error", {}).get("code") == "INVALID_ARGUMENT", f"{body}"
    # 旧分页上限 100
    is_error, body = await call_tool(session, "detail_orders_list", {"customer": "示例客户A", "page_size": 101})
    assert is_error or (body and body.get("error", {}).get("code") == "INVALID_ARGUMENT"), f"旧分页上限未生效: {body}"


async def check_20_health_evidence_and_confidence(session):
    """健康检查：成功含 evidence 且三时间戳一致；上游不可用时降级为 low 且无证据"""
    _, body = await call_tool(session, "get_system_health", {})
    data = body.get("data", {})
    assert data.get("status") == "ok", f"{data}"
    refs = body.get("evidence_refs") or []
    assert refs and refs[0].startswith("control-platform://health/ping@"), f"{refs}"
    ts = refs[0].split("@", 1)[1]
    assert data.get("checked_at") == ts == body.get("data_as_of"), (
        f"时间戳不一致: {data.get('checked_at')} / {ts} / {body.get('data_as_of')}"
    )
    assert body.get("data_confidence") == "high"
    MOCK_STATE["mode"] = "unavailable"
    try:
        _, body = await call_tool(session, "get_system_health", {})
    finally:
        MOCK_STATE["mode"] = "normal"
    assert body.get("data", {}).get("status") == "degraded", f"{body}"
    assert body.get("data_confidence") == "low", f"{body.get('data_confidence')}"
    assert not (body.get("evidence_refs") or []), f"降级不应含证据: {body.get('evidence_refs')}"


async def check_21_bom_tree_forms(session):
    """bom_tree 支持嵌套树与扁平列表两种返回（方案 §12.2）"""
    _, body = await call_tool(session, "bom_tree", {"bom_id": "BOM-001"})
    data = body.get("data", {})
    assert data.get("tree") and not data.get("items"), f"默认应返回嵌套树: {data}"
    assert data["tree"][0].get("children"), f"嵌套树缺少 children: {data['tree'][0]}"
    _, body = await call_tool(session, "bom_tree", {"bom_id": "BOM-001", "flatten": True})
    data = body.get("data", {})
    assert data.get("items") and not data.get("tree"), f"flatten=true 应返回扁平列表: {data}"
    assert all("children" not in node for node in data["items"]), f"扁平列表不应含 children: {data['items']}"


async def check_22_rate_limited(session):
    """上游 429 映射为 RATE_LIMITED（retryable）"""
    MOCK_STATE["mode"] = "ratelimit"
    try:
        _, body = await call_tool(session, "orders_list", {})
    finally:
        MOCK_STATE["mode"] = "normal"
    err = body.get("error", {})
    assert err.get("code") == "RATE_LIMITED" and err.get("retryable") is True, f"{body}"


async def check_27_kitting_results(session):
    """material_kitting_results_list：demand_no 过滤、evidence、分页信封"""
    _, body = await call_tool(
        session, "material_kitting_results_list", {"demand_no": "SO-2609-001", "page_size": 2}
    )
    assert body and body.get("capability") == "material_kitting_results_list", f"{body}"
    assert body.get("source") == "company-control" and body.get("read_only") is True, f"{body}"
    rows = body.get("data") or []
    assert rows and all(r.get("demand_no") == "SO-2609-001" for r in rows), f"demand_no 过滤未生效: {rows}"
    refs = body.get("evidence_refs") or []
    assert refs and all(
        r.startswith("control-platform://kitting-result/SALES_ORDER/") and "@" in r for r in refs
    ), f"{refs}"
    page = body.get("page") or {}
    assert page.get("page") == 1 and page.get("page_size") == 2 and page.get("total", 0) > 0, f"{page}"


async def check_28_shortages(session):
    """material_shortages_list：evidence 前缀 shortage/"""
    _, body = await call_tool(session, "material_shortages_list", {"demand_no": "SO-2609-001"})
    assert body and body.get("capability") == "material_shortages_list", f"{body}"
    assert body.get("data"), f"未返回缺料明细: {body}"
    refs = body.get("evidence_refs") or []
    assert refs and all(r.startswith("control-platform://shortage/") for r in refs), f"{refs}"


async def check_29_kitting_related_lists(session):
    """demands / inventory / supplies 三工具：capability、data、evidence 前缀"""
    cases = (
        ("material_kitting_demands_list", {"order_no": "SO-2609-001"}, "control-platform://demand/"),
        ("inventory_availability_list", {"material_code": "M-100"}, "control-platform://inventory/"),
        ("material_supplies_list", {"material_code": "M-100"}, "control-platform://supply/"),
    )
    for name, args, prefix in cases:
        _, body = await call_tool(session, name, args)
        assert body and body.get("capability") == name, f"{name}: {body}"
        assert body.get("data"), f"{name}: 未返回数据"
        refs = body.get("evidence_refs") or []
        assert refs and all(r.startswith(prefix) for r in refs), f"{name}: {refs}"


async def check_30_kitting_stale(session):
    """齐套端点 stale=true → 成功信封 + low confidence（数据照常返回，不抛 STALE_DATA）"""
    MOCK_STATE["mode"] = "stale_kitting"
    try:
        _, body = await call_tool(
            session, "material_kitting_results_list", {"demand_no": "SO-2609-001"}
        )
    finally:
        MOCK_STATE["mode"] = "normal"
    assert not (body or {}).get("error"), f"{body}"
    assert body.get("data_confidence") == "low", f"{body}"
    assert isinstance(body.get("data"), list), f"{body}"


async def check_31_quality_issues_list(session):
    """quality_issues_list：过滤、null 占位字段、evidence、分页信封"""
    _, body = await call_tool(
        session, "quality_issues_list", {"order_no": "SO-2609-001", "page_size": 2}
    )
    assert body and body.get("capability") == "quality_issues_list", f"{body}"
    assert body.get("source") == "company-control" and body.get("read_only") is True, f"{body}"
    rows = body.get("data") or []
    assert rows and all(r.get("order_no") == "SO-2609-001" for r in rows), f"order_no 过滤未生效: {rows}"
    assert rows[0].get("severity") is None, f"无数据源字段必须为 null: {rows[0]}"
    refs = body.get("evidence_refs") or []
    assert refs and all(
        r.startswith("control-platform://quality-issue/") and "@" in r for r in refs
    ), f"{refs}"
    page = body.get("page") or {}
    assert page.get("page") == 1 and page.get("page_size") == 2 and page.get("total", 0) > 0, f"{page}"


async def check_32_quality_trace(session):
    """quality_trace：三类节点 + evidence 使用 object_type/object_id"""
    _, body = await call_tool(session, "quality_trace", {"order_no": "SO-2609-001"})
    assert body and body.get("capability") == "quality_trace", f"{body}"
    rows = body.get("data") or []
    types = {r.get("object_type") for r in rows}
    assert {"quality_issue", "order_line", "bom"} <= types, f"{types}"
    refs = body.get("evidence_refs") or []
    assert refs and all(r.startswith("control-platform://quality-trace/") for r in refs), f"{refs}"
    assert any("/quality_issue/" in r for r in refs), f"{refs}"
    assert any("/order_line/" in r for r in refs), f"{refs}"


async def check_33_quality_trace_requires_anchor(session):
    """quality_trace 缺锚点 → INVALID_ARGUMENT（不调用上游、不崩溃）"""
    _, body = await call_tool(session, "quality_trace", {})
    err = body.get("error", {})
    assert err.get("code") == "INVALID_ARGUMENT" and err.get("retryable") is False, f"{body}"


async def check_34_quality_stale(session):
    """质量端点 stale=true → STALE_DATA（retryable，交付说明 §11.9）"""
    MOCK_STATE["mode"] = "stale"
    try:
        _, body = await call_tool(session, "quality_issues_list", {"order_no": "SO-2609-001"})
    finally:
        MOCK_STATE["mode"] = "normal"
    err = body.get("error", {})
    assert err.get("code") == "STALE_DATA" and err.get("retryable") is True, f"{body}"


# ---------------- HTTP 检查（双传输补充） ----------------

INIT_BODY = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "probe", "version": "0"},
    },
}
INIT_HEADERS = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http_server_env(base_url: str, token: str) -> dict:
    """HTTP 子进程环境：显式覆盖 CONTROL_PLATFORM_* 与 MCP_*，与真实 .env 隔离"""
    return {
        **os.environ,
        "CONTROL_PLATFORM_BASE_URL": base_url,
        "CONTROL_PLATFORM_APP_KEY": MOCK_APP_KEY,
        "CONTROL_PLATFORM_APP_SECRET": MOCK_APP_SECRET,
        "CONTROL_PLATFORM_TIMEOUT_MS": "800",
        "CONTROL_PLATFORM_CONNECT_TIMEOUT_MS": "500",
        "MCP_TRANSPORT": "",
        "MCP_HTTP_HOST": "",
        "MCP_HTTP_PORT": "",
        "MCP_HTTP_TOKEN": token,
        "PYTHONUNBUFFERED": "1",
        "PYTHONIOENCODING": "utf-8",
    }


def start_http_server(base_url: str, token: str):
    port = free_port()
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "mcp_server",
            "--transport",
            "streamable-http",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=PROJECT_ROOT,
        env=http_server_env(base_url, token),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc, port


async def wait_http_ready(port: int, timeout_s: float = 20.0) -> bool:
    url = f"http://127.0.0.1:{port}/mcp"
    deadline = time.monotonic() + timeout_s
    async with httpx2.AsyncClient(timeout=1.0) as client:
        while time.monotonic() < deadline:
            try:
                resp = await client.post(url, json=INIT_BODY, headers=INIT_HEADERS)
                if resp.status_code == 401:  # 服务已就绪（未带 token 被拒）
                    return True
            except httpx2.HTTPError:
                pass
            await asyncio.sleep(0.2)
    return False


async def check_23_http_no_token(port: int):
    url = f"http://127.0.0.1:{port}/mcp"
    async with httpx2.AsyncClient(timeout=5.0) as client:
        resp = await client.post(url, json=INIT_BODY, headers=INIT_HEADERS)
    assert resp.status_code == 401, f"无 token 未被拒绝: {resp.status_code} {resp.text[:120]}"


async def check_24_http_bad_token(port: int):
    url = f"http://127.0.0.1:{port}/mcp"
    async with httpx2.AsyncClient(timeout=5.0) as client:
        resp = await client.post(
            url, json=INIT_BODY, headers={**INIT_HEADERS, "Authorization": "Bearer wrong-token"}
        )
    assert resp.status_code == 401, f"错误 token 未被拒绝: {resp.status_code} {resp.text[:120]}"


async def check_25_http_authorized(port: int, token: str):
    url = f"http://127.0.0.1:{port}/mcp"
    http_client = create_mcp_http_client(headers={"Authorization": f"Bearer {token}"})
    async with http_client:
        async with streamable_http_client(url, http_client=http_client) as (read, write):
            async with ClientSession(read, write) as session:
                init_result = await session.initialize()
                assert init_result.server_info.name == "company-control", f"{init_result.server_info}"
                tools = await session.list_tools()
                names = {t.name for t in tools.tools}
                assert names == EXPECTED_TOOLS, f"tools={names}"


def check_26_http_requires_token(base_url: str):
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "mcp_server",
            "--transport",
            "streamable-http",
            "--host",
            "127.0.0.1",
            "--port",
            str(free_port()),
        ],
        cwd=PROJECT_ROOT,
        env=http_server_env(base_url, ""),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        code = proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise AssertionError("未配置 MCP_HTTP_TOKEN 时 HTTP 模式未拒绝启动")
    assert code == 2, f"退出码应为 2，实际 {code}"


# 分组：legacy = 旧版回归（0.1.0 兼容契约）；new = 新版链路（1.1.0 能力）；http = HTTP 传输
GROUPS = [
    ("legacy", "旧版", "旧版回归（0.1.0 兼容契约）"),
    ("new", "新版", "新版链路（1.1.0 能力）"),
    ("http", "HTTP", "HTTP 传输（双传输）"),
]
GROUP_SHORT = {key: short for key, short, _ in GROUPS}
GROUP_TITLE = {key: title for key, _, title in GROUPS}

CHECKS = [
    ("new", "01 initialize 握手成功", check_01_initialize),
    ("new", "02 tools/list 返回预期 Tool", check_02_tools_list),
    ("new", "03 正常输入返回结构化结果", check_03_normal_structured),
    ("new", "04 非法输入被拒绝且不崩溃", check_04_invalid_input),
    ("new", "05 未授权请求被拒绝", check_05_unauthorized),
    ("new", "06 上游超时返回标准错误", check_06_upstream_timeout),
    ("new", "07 上游不可用不导致进程崩溃", check_07_upstream_unavailable),
    ("new", "08 结果含 evidence_refs", check_08_evidence_refs),
    ("new", "09 敏感字段不出现在结果中", check_09_sensitive_fields),
    ("legacy", "10 无未声明的写操作工具", check_10_no_write_tools),
    ("new", "11 重复只读请求结果一致", check_11_idempotent_read),
    ("new", "12 get_system_health 返回正确状态", check_12_health),
    ("new", "13 数据过期返回 STALE_DATA", check_13_stale_data),
    ("legacy", "14 0.1.0 兼容工具存在且旧 Schema 可用", check_14_legacy_tools_present),
    ("legacy", "15 指标类工具返回能力未开放错误", check_15_metrics_capability_unavailable),
    ("legacy", "16 metric_query 保留 92 天跨度校验", check_16_metric_query_legacy_validation),
    ("legacy", "17 master_material_search 功能兼容", check_17_material_search),
    ("legacy", "18 master_supplier_get 功能兼容", check_18_supplier_get),
    ("legacy", "19 detail_orders_list 参数/字段映射", check_19_detail_orders_mapping),
    ("legacy", "20 健康检查 evidence 与置信度", check_20_health_evidence_and_confidence),
    ("new", "21 bom_tree 嵌套树与扁平列表", check_21_bom_tree_forms),
    ("new", "22 上游限流映射 RATE_LIMITED", check_22_rate_limited),
    ("new", "27 齐套结果查询与 evidence", check_27_kitting_results),
    ("new", "28 缺料明细查询与 evidence", check_28_shortages),
    ("new", "29 需求/库存/供给三工具链路", check_29_kitting_related_lists),
    ("new", "30 齐套数据过期返回 low confidence", check_30_kitting_stale),
    ("new", "31 质量异常列表查询与 evidence", check_31_quality_issues_list),
    ("new", "32 质量追溯节点与 evidence", check_32_quality_trace),
    ("new", "33 质量追溯缺锚点被拒", check_33_quality_trace_requires_anchor),
    ("new", "34 质量数据过期返回 STALE_DATA", check_34_quality_stale),
]


async def run() -> int:
    mock, port = start_mock()
    base_url = f"http://127.0.0.1:{port}"
    results = []  # (group, name, ok, err)

    def record(group: str, name: str, ok: bool, err: str = "") -> None:
        results.append((group, name, ok, err))
        print(f"[{GROUP_SHORT[group]}] {'PASS' if ok else 'FAIL'}  {name}" + (f": {err}" if err else ""))

    try:
        async with stdio_client(stdio_server_params(base_url)) as (read, write):
            async with ClientSession(read, write) as session:
                init_result = await session.initialize()
                for group, name, fn in CHECKS:
                    try:
                        if name.startswith("01"):
                            await fn(session, init_result)
                        else:
                            await fn(session)
                        record(group, name, True)
                    except Exception as exc:  # noqa: BLE001
                        record(group, name, False, str(exc))

        http_proc, http_port = start_http_server(base_url, MCP_HTTP_TOKEN)
        try:
            if not await wait_http_ready(http_port):
                record("http", "23-25 HTTP 检查", False, "HTTP 服务未就绪")
            else:
                http_checks = [
                    ("23 HTTP 无 token 被拒（401）", lambda: check_23_http_no_token(http_port)),
                    ("24 HTTP 错误 token 被拒（401）", lambda: check_24_http_bad_token(http_port)),
                    ("25 HTTP 正确 token 握手成功", lambda: check_25_http_authorized(http_port, MCP_HTTP_TOKEN)),
                ]
                for name, fn in http_checks:
                    try:
                        await fn()
                        record("http", name, True)
                    except Exception as exc:  # noqa: BLE001
                        record("http", name, False, str(exc))
        finally:
            http_proc.terminate()
            try:
                http_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                http_proc.kill()

        try:
            check_26_http_requires_token(base_url)
            record("http", "26 HTTP 未配 token 拒绝启动", True)
        except Exception as exc:  # noqa: BLE001
            record("http", "26 HTTP 未配 token 拒绝启动", False, str(exc))
    finally:
        mock.shutdown()

    print()
    total_failed = 0
    for group, _, title in GROUPS:
        group_results = [r for r in results if r[0] == group]
        failed = [r for r in group_results if not r[2]]
        total_failed += len(failed)
        print(f"【{title}】通过 {len(group_results) - len(failed)}/{len(group_results)}")
        for _, name, ok, err in group_results:
            if not ok:
                print(f"    FAIL {name}: {err}")
    print(f"\n总计 {len(results)} 项，通过 {len(results) - total_failed}，失败 {total_failed}")
    return 1 if total_failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
