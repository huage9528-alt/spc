"""质量对外接口（quality_issues.list / quality_trace.list）集成回归测试。

独立测试库 spc_test + ASGI 内存客户端 + HMAC 签名（rate_limit=0 绕过 Redis）。
覆盖：鉴权 401/403、空列表、分页、筛选、软删过滤、字段映射与 null 占位、
request_id 回显、新鲜度元信息、追溯锚点校验与节点解析。
"""

import time
from datetime import date

import httpx
import pytest_asyncio

from tests._common_external import build_headers, generate_signature

QUALITY_LIST = "/api/v1/external/quality-issues/list"
QUALITY_TRACE = "/api/v1/external/quality-trace/list"


async def signed_get(client, path, endpoint_code, key, params=None):
    """按 endpoint_code 签名后请求；签名串与 httpx 实际发送的 query 完全一致。"""
    params = params or {}
    query_string = str(httpx.QueryParams(params))
    timestamp = int(time.time())
    _, signature = generate_signature(
        timestamp, key["app_key"], key["app_secret"], endpoint_code, query_string
    )
    return await client.get(path, params=params, headers=build_headers(key["app_key"], signature, timestamp))


@pytest_asyncio.fixture(loop_scope="session")
async def seeded(external_keys, db):
    """2 个订单 + 2 个订单行 + 2 个 BOM + 3 条质量异常（其中 1 条软删）。"""
    from app.models.basicdata.bom import Bom
    from app.models.exception.quality_issue import QualityIssue
    from app.models.order.sale_order import SaleOrder, SaleOrderLine

    order1 = SaleOrder(order_no="SO-2609-001", line_no="1", customer="客户A", customer_code="C-001",
                       product_code="P-100", order_qty=100, status="open", is_closed=0, is_deleted=0)
    order2 = SaleOrder(order_no="SO-2609-002", line_no="1", product_code="P-200",
                       order_qty=50, status="open", is_closed=0, is_deleted=0)
    db.add_all([order1, order2])
    await db.flush()
    db.add_all([
        SaleOrderLine(sale_order_id=order1.id, order_no="SO-2609-001", line_no="1",
                      product_code="P-100", batch_no="B-2609", bom_no="BOM-001", bom_id=101,
                      order_qty=100, status="open"),
        SaleOrderLine(sale_order_id=order2.id, order_no="SO-2609-002", line_no="1",
                      product_code="P-200", batch_no="B-2610", bom_no="BOM-002", bom_id=102,
                      order_qty=50, status="open"),
        Bom(bom_id="101", bom_no="BOM-001", bom_version="V1", bom_type="production"),
        Bom(bom_id="102", bom_no="BOM-002", bom_version="V1", bom_type="production"),
    ])
    db.add_all([
        QualityIssue(issue_no="QI-20260922-0001", status="open", workflow_status="创建",
                     submit_dept="品质部", submit_date=date(2026, 9, 22), submitter="张三",
                     order_no="SO-2609-001", product_code="P-100", product_name="产品A",
                     process="组装", defect_type="尺寸超差", description="来料尺寸超差",
                     responsible_person="李四", responsible_dept="品质部",
                     batch_qty=1200, sample_qty=50, defect_qty=8,
                     data_source="manual", is_deleted=False),
        QualityIssue(issue_no="QI-20260922-0002", status="in_progress", workflow_status="提交",
                     submit_dept="品质部", submit_date=date(2026, 9, 21), submitter="王五",
                     order_no="SO-2609-001", product_code="P-100", product_name="产品A",
                     defect_type="外观不良", description="外壳划伤",
                     responsible_person="赵六", responsible_dept="生产部",
                     batch_qty=800, sample_qty=20, defect_qty=3,
                     data_source="manual", is_deleted=False),
        QualityIssue(issue_no="QI-20260922-0003", status="closed", workflow_status="归档",
                     submit_dept="品质部", submit_date=date(2026, 9, 20), submitter="张三",
                     order_no="SO-2609-002", product_code="P-200", description="已关闭软删样本",
                     responsible_person="钱七", responsible_dept="品质部",
                     batch_qty=100, sample_qty=10, defect_qty=1,
                     data_source="manual", is_deleted=True),
    ])
    await db.commit()
    return {"order_no": "SO-2609-001", "batch_no": "B-2609", "product_code": "P-100"}


async def test_missing_auth_401(ext_client):
    r = await ext_client.get(QUALITY_LIST)
    assert r.status_code == 401


async def test_bad_signature_403(ext_client, external_keys):
    key = external_keys["quality"]
    timestamp = int(time.time())
    _, signature = generate_signature(timestamp, key["app_key"], "wrong_secret", "quality_issues.list", "")
    r = await ext_client.get(QUALITY_LIST, headers=build_headers(key["app_key"], signature, timestamp))
    assert r.status_code == 403


async def test_endpoint_not_authorized_403(ext_client, external_keys):
    r = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", external_keys["orders"])
    assert r.status_code == 403


async def test_empty_list_returns_zero_items(ext_client, external_keys):
    r = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", external_keys["quality"])
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["items"] == []
    assert data["total"] == 0
    assert data["data_as_of"] is None
    assert data["data_confidence"] == "unknown"
    assert data["stale"] is False


async def test_pagination(ext_client, external_keys, seeded):
    key = external_keys["quality"]
    r1 = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", key, {"page": 1, "page_size": 1})
    d1 = r1.json()["data"]
    assert d1["total"] == 2 and len(d1["items"]) == 1
    r2 = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", key, {"page": 2, "page_size": 1})
    d2 = r2.json()["data"]
    assert d2["total"] == 2 and len(d2["items"]) == 1
    assert d1["items"][0]["issue_no"] != d2["items"][0]["issue_no"]


async def test_filters(ext_client, external_keys, seeded):
    key = external_keys["quality"]

    r = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", key, {"order_no": "SO-2609-001"})
    assert r.json()["data"]["total"] == 2

    r = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", key, {"status": "open,in_progress"})
    assert r.json()["data"]["total"] == 2

    r = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", key, {"occurred_start": "2026-09-21"})
    assert r.json()["data"]["total"] == 2

    r = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", key, {"occurred_end": "2026-09-21"})
    assert r.json()["data"]["total"] == 1

    r = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", key,
                         {"updated_after": "2999-01-01T00:00:00"})
    assert r.json()["data"]["total"] == 0


async def test_soft_deleted_excluded(ext_client, external_keys, seeded):
    r = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", external_keys["quality"],
                         {"issue_no": "QI-20260922-0003"})
    assert r.json()["data"]["total"] == 0


async def test_field_mapping_and_null_placeholders(ext_client, external_keys, seeded):
    r = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", external_keys["quality"],
                         {"issue_no": "QI-20260922-0001"})
    item = r.json()["data"]["items"][0]
    assert item["title"] == "来料尺寸超差"
    assert item["owner"] == "李四"
    assert item["owner_org"] == "品质部"
    assert item["occurred_at"] == "2026-09-22"
    assert item["affected_qty"] == 1200
    assert item["batch_qty"] == 1200
    assert item["sample_qty"] == 50 and item["defect_qty"] == 8
    assert item["status"] == "open"
    for field in ("issue_type", "severity", "inspection_result", "line_no",
                  "material_code", "batch_no", "supplier_code",
                  "blocking", "blocking_reason"):
        assert item[field] is None


async def test_request_id_echo(ext_client, external_keys, seeded):
    r = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", external_keys["quality"],
                         {"request_id": "eqc-20260922-001"})
    assert r.json()["data"]["request_id"] == "eqc-20260922-001"


async def test_freshness_meta(ext_client, external_keys, seeded):
    r = await signed_get(ext_client, QUALITY_LIST, "quality_issues.list", external_keys["quality"])
    data = r.json()["data"]
    assert data["data_as_of"] is not None
    assert data["data_confidence"] in ("high", "medium")
    assert data["stale"] is False


async def test_trace_requires_anchor_422(ext_client, external_keys):
    r = await signed_get(ext_client, QUALITY_TRACE, "quality_trace.list", external_keys["quality"])
    assert r.status_code == 422


async def test_trace_supplier_code_unsupported_422(ext_client, external_keys):
    r = await signed_get(ext_client, QUALITY_TRACE, "quality_trace.list", external_keys["quality"],
                         {"supplier_code": "SUP-001"})
    assert r.status_code == 422


async def test_trace_by_order_no(ext_client, external_keys, seeded):
    r = await signed_get(ext_client, QUALITY_TRACE, "quality_trace.list", external_keys["quality"],
                         {"order_no": "SO-2609-001"})
    items = r.json()["data"]["items"]
    by_type = {}
    for item in items:
        by_type.setdefault(item["object_type"], []).append(item)
    assert len(by_type["quality_issue"]) == 2
    assert {i["relation"] for i in by_type["quality_issue"]} == {"order_no"}
    assert len(by_type["order_line"]) == 1
    assert by_type["order_line"][0]["object_id"] == "SO-2609-001:1"
    assert by_type["bom"][0]["object_id"] == "101"
    assert by_type["bom"][0]["bom_no"] == "BOM-001"


async def test_trace_by_batch_no_marks_inferred(ext_client, external_keys, seeded):
    r = await signed_get(ext_client, QUALITY_TRACE, "quality_trace.list", external_keys["quality"],
                         {"batch_no": "B-2609"})
    items = r.json()["data"]["items"]
    by_type = {}
    for item in items:
        by_type.setdefault(item["object_type"], []).append(item)
    assert len(by_type["quality_issue"]) == 2
    assert {i["relation"] for i in by_type["quality_issue"]} == {"via_batch_order"}
    assert {i["relation"] for i in by_type["order_line"]} == {"batch_no"}


async def test_trace_by_product_code(ext_client, external_keys, seeded):
    r = await signed_get(ext_client, QUALITY_TRACE, "quality_trace.list", external_keys["quality"],
                         {"product_code": "P-100"})
    items = r.json()["data"]["items"]
    assert {i["relation"] for i in items if i["object_type"] == "quality_issue"} == {"product_code"}
    assert len([i for i in items if i["object_type"] == "order_line"]) == 1


async def test_trace_empty(ext_client, external_keys, seeded):
    r = await signed_get(ext_client, QUALITY_TRACE, "quality_trace.list", external_keys["quality"],
                         {"order_no": "SO-NOPE"})
    data = r.json()["data"]
    assert data["items"] == [] and data["total"] == 0
