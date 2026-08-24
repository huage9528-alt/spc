"""测试外部 BOM 多级树接口

调用外部接口 GET /api/v1/external/boms/tree 并打印 bom_id 指定的多级 BOM 树。

签名机制：HMAC-SHA256
签名串 = {timestamp}{app_key}{endpoint_code}{query_string}
"""

import hmac
import hashlib
import time
import os
import asyncio
import json

import httpx


# ── 配置（通过环境变量提供，不落盘明文密钥） ──
APP_KEY = os.environ.get("APP_KEY", "")
APP_SECRET = os.environ.get("APP_SECRET", "")
BASE_URL = os.environ.get("BASE_URL", "http://localhost:8000")
ENDPOINT_CODE = "boms.tree"
ENDPOINT_PATH = "/api/v1/external/boms/tree"
BOM_ID = os.environ.get("BOM_ID", "14348")
DEMAND_QTY = os.environ.get("DEMAND_QTY", "")          # 留空则用根 BOM 的 base_qty
FLATTEN = os.environ.get("FLATTEN", "") in ("1", "true", "yes")


def generate_signature(timestamp: int, app_key: str, app_secret: str,
                       endpoint_code: str, query_string: str):
    string_to_sign = f"{timestamp}{app_key}{endpoint_code}{query_string}"
    sig = hmac.new(
        app_secret.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return string_to_sign, sig


def build_headers(app_key: str, signature: str, timestamp: int) -> dict:
    return {
        "X-App-Key": app_key,
        "X-Timestamp": str(timestamp),
        "X-Signature": signature,
    }


def render_tree(nodes, depth=0):
    """递归缩进打印嵌套树。"""
    lines = []
    for n in nodes:
        indent = "  " * depth
        material_code = n.get("material_code") or n.get("material_id") or ""
        material_name = n.get("material_name") or ""
        bom_id = n.get("bom_id") or "-"
        level = n.get("level", depth)
        std_qty = n.get("standard_qty")
        demand = n.get("demand_qty")
        unit = n.get("unit") or ""
        leaf = "  (叶子)" if not n.get("children") else ""
        lines.append(
            f"{indent}L{level} bom_id={bom_id}  {material_code} {material_name}"
            f"  std={std_qty}{unit}  demand={demand}{leaf}"
        )
        children = n.get("children") or []
        if children:
            lines.append(render_tree(children, depth + 1))
    return "\n".join(lines)


def render_flat(items):
    """打印扁平列表。"""
    lines = []
    for it in items:
        level = it.get("level", 0)
        indent = "  " * level
        material_code = it.get("material_code") or it.get("material_id") or ""
        material_name = it.get("material_name") or ""
        bom_id = it.get("bom_id") or "-"
        std_qty = it.get("standard_qty")
        demand = it.get("demand_qty")
        unit = it.get("unit") or ""
        lines.append(
            f"{indent}L{level} bom_id={bom_id}  {material_code} {material_name}"
            f"  std={std_qty}{unit}  demand={demand}"
        )
    return "\n".join(lines)


async def main():
    # 组装 query string（参与签名，必须与实际请求完全一致）
    q_parts = [f"bom_id={BOM_ID}"]
    if DEMAND_QTY:
        q_parts.append(f"demand_qty={DEMAND_QTY}")
    if FLATTEN:
        q_parts.append("flatten=true")
    query_string = "&".join(q_parts)

    timestamp = int(time.time())
    sign_str, signature = generate_signature(timestamp, APP_KEY, APP_SECRET, ENDPOINT_CODE, query_string)
    headers = build_headers(APP_KEY, signature, timestamp)
    url = f"{BASE_URL}{ENDPOINT_PATH}?{query_string}"

    print("=" * 80)
    print(f"外部 BOM 多级树 — bom_id={BOM_ID}  flatten={FLATTEN}")
    print("=" * 80)
    print(f"URL:         {url}")
    print(f"Timestamp:   {timestamp}")
    print(f"Sign String: {sign_str}")
    print(f"Signature:   {signature}")
    print()

    try:
        async with httpx.AsyncClient(verify=False) as client:
            response = await client.get(url, headers=headers, timeout=30.0)
            response.raise_for_status()
            body = response.json()
    except httpx.HTTPStatusError as e:
        print(f"[HTTP {e.response.status_code}] {e.response.text[:800]}")
        return
    except httpx.RequestError as e:
        print(f"[连接失败] {e}")
        return

    code = body.get("code", -1)
    message = body.get("message", "")
    data = body.get("data") or {}

    if code != 0:
        print(f"[API 错误] code={code}, message={message}")
        return

    root_info_keys = ("bom_id", "bom_no", "material_id", "base_qty",
                      "demand_qty", "bom_version", "bom_type",
                      "flatten", "total_nodes", "max_level")
    print("── 根 BOM 信息 ──")
    for k in root_info_keys:
        if k in data:
            print(f"  {k}: {data.get(k)}")
    print()

    if "message" in data:
        print(f"提示: {data['message']}")
        return

    if FLATTEN or "items" in data:
        items = data.get("items", [])
        print(f"── 扁平列表（{len(items)} 个节点）──")
        print(render_flat(items))
    else:
        tree = data.get("tree", [])
        print(f"── 嵌套树 ──")
        print(render_tree(tree))

    print()
    print(f"完成。共 {data.get('total_nodes', 0)} 个节点，最大层级 {data.get('max_level', 0)}。")


if __name__ == "__main__":
    asyncio.run(main())
