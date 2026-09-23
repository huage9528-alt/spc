"""订单表头共享查询与 0.1.0 兼容字段别名

orders_list（新版公开工具）与 detail_orders_list（0.1.0 兼容工具）共用同一上游端点，
避免重复包装错误信封与字段映射逻辑（不让一个 MCP Tool 调用另一个 MCP Tool）。
"""

from __future__ import annotations

from typing import Any, Dict

from .upstream_client import call as upstream

ORDERS_LIST_PATH = "/external/orders/list"


async def query_orders(params: Dict[str, Any]) -> Dict[str, Any]:
    """订单表头查询（GET /external/orders/list）"""
    return await upstream(ORDERS_LIST_PATH, params)


def alias_order_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """0.1.0 兼容字段别名（保留新版原字段；不伪造 risk_probability）"""
    aliased = dict(row)
    if "order_amount" in aliased:
        aliased["amount_cny"] = aliased["order_amount"]
    if "promised_date" in aliased:
        aliased["due_date"] = aliased["promised_date"]
    return aliased
