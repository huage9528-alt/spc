"""供应商索赔通知单 API 集成回归测试。

独立测试库（spc_test）+ ASGI 内存客户端，不依赖开发库与外部服务。
覆盖：正向生命周期（金额条件节点过滤/跳过总经理）、状态机拒绝、驳回重提多轮、
撤回、反审核、同人自动跳过、待我审批过滤、发起人校验、乐观锁、归档删除权、
通知落库、附件引用计数、审批配置变更生效。
"""

import pytest
from sqlalchemy import text

from tests.conftest import login
from tests.integration._helpers import (  # noqa: F401 — 账号常量供本模块用例直接引用
    FIN, GM, MGR, PM, Q, Q2, VIEWER,
    act, create, get_claim, payload, pending_items, snap_roles,
)


# ---------------------------------------------------------------- 认证与创建

async def test_no_token_rejected(client):
    r = await client.get("/api/v1/quality/supplier-claims")
    assert r.status_code == 401


async def test_claim_no_daily_sequence(client):
    h = await login(client, Q)
    a = await create(client, h, 100)
    b = await create(client, h, 100)
    assert a["claim_no"].startswith("SC") and a["claim_no"].endswith("-001")
    assert b["claim_no"].endswith("-002")
    assert a["approval_status"] == "draft" and b["approval_status"] == "draft"


async def test_validate_missing_supplier(client):
    h = await login(client, Q)
    p = payload(100)
    p["supplier_name"] = "  "
    r = await client.post("/api/v1/quality/supplier-claims", json=p, headers=h)
    assert r.json()["code"] == 1 and "供应商" in r.json()["message"]


async def test_validate_bad_reason(client):
    h = await login(client, Q)
    p = payload(100)
    p["claim_reason"] = "other"
    r = await client.post("/api/v1/quality/supplier-claims", json=p, headers=h)
    assert r.json()["code"] == 1


async def test_validate_bad_item(client):
    h = await login(client, Q)
    p = payload(100)
    p["claim_items"] = ["man_hour_fee", "not_a_item"]
    r = await client.post("/api/v1/quality/supplier-claims", json=p, headers=h)
    assert r.json()["code"] == 1


async def test_validate_negative_amount(client):
    h = await login(client, Q)
    p = payload(-1)
    r = await client.post("/api/v1/quality/supplier-claims", json=p, headers=h)
    assert r.json()["code"] == 1


async def test_validate_bad_return_requirement(client):
    h = await login(client, Q)
    p = payload(100)
    p["return_requirement"] = "send_back"
    r = await client.post("/api/v1/quality/supplier-claims", json=p, headers=h)
    assert r.json()["code"] == 1


async def test_edit_draft_then_pending_denied(client):
    h = await login(client, Q)
    a = await create(client, h, 100)
    r = await client.put(f"/api/v1/quality/supplier-claims/{a['id']}",
                         json=payload(800), headers=h)
    assert r.json()["code"] == 0 and r.json()["data"]["claim_amount"] == 800
    await client.post(f"/api/v1/quality/supplier-claims/{a['id']}/submit", json={}, headers=h)
    r = await client.put(f"/api/v1/quality/supplier-claims/{a['id']}",
                         json=payload(900), headers=h)
    assert r.json()["code"] == 1


async def test_create_with_string_claim_date_from_frontend(client):
    """前端 dayjs 提交 claim_date 为 'YYYY-MM-DD' 字符串；asyncpg 对 DATE 列不做隐式转换，服务端必须转 date。"""
    h = await login(client, Q)
    p = payload(500)
    p["claim_date"] = "2026-09-23"
    r = await client.post("/api/v1/quality/supplier-claims", json=p, headers=h)
    body = r.json()
    assert body["code"] == 0, body
    assert body["data"]["claim_date"] == "2026-09-23"


async def test_create_with_invalid_claim_date_rejected(client):
    h = await login(client, Q)
    p = payload(500)
    p["claim_date"] = "2026/09/23 下午"
    r = await client.post("/api/v1/quality/supplier-claims", json=p, headers=h)
    assert r.json()["code"] == 1


async def test_list_date_range_filter_with_strings(client):
    """列表日期区间过滤（前端传字符串）不得 500。"""
    h = await login(client, Q)
    await create(client, h, 500)
    r = await client.get("/api/v1/quality/supplier-claims",
                         params={"date_start": "2026-01-01", "date_end": "2026-12-31"}, headers=h)
    assert r.json()["code"] == 0, r.text
    assert r.json()["data"]["total"] >= 1


# ---------------------------------------------------------------- 状态机拒绝

async def test_submit_non_draft_rejected(client):
    h = await login(client, Q)
    a = await create(client, h, 100, submit=True)
    r = await client.post(f"/api/v1/quality/supplier-claims/{a['id']}/submit", json={}, headers=h)
    assert r.json()["code"] == 1


async def test_delete_pending_rejected(client):
    h_admin = await login(client, "admin")
    a = await create(client, h_admin, 100, submit=True)
    r = await client.delete(f"/api/v1/quality/supplier-claims/{a['id']}", headers=h_admin)
    assert r.json()["code"] == 1 and "不可删除" in r.json()["message"]


async def test_delete_requires_delete_permission(client):
    h_q, h_admin = await login(client, Q), await login(client, "admin")
    a = await create(client, h_admin, 100)  # admin 的草稿
    r = await client.delete(f"/api/v1/quality/supplier-claims/{a['id']}", headers=h_q)
    assert r.status_code == 403


async def test_recall_non_pending_rejected(client):
    h = await login(client, Q)
    a = await create(client, h, 100)
    r = await client.post(f"/api/v1/quality/supplier-claims/{a['id']}/recall", json={}, headers=h)
    assert r.json()["code"] == 1


# ---------------------------------------------------------------- 金额条件节点

async def test_low_amount_chain_filters_middle_nodes(client):
    h = await login(client, Q)
    a = await create(client, h, 500, submit=True)
    assert await snap_roles(a) == ["purchase_manager", "finance"]


async def test_mid_amount_chain_keeps_manager(client):
    h = await login(client, Q)
    a = await create(client, h, 2000, submit=True)
    assert await snap_roles(a) == ["purchase_manager", "manager", "finance"]


async def test_high_amount_chain_keeps_gm(client):
    h = await login(client, Q)
    a = await create(client, h, 6000, submit=True)
    assert await snap_roles(a) == ["purchase_manager", "manager", "general_manager", "finance"]


# ---------------------------------------------------------------- 正向审批生命周期

async def test_low_amount_full_flow(client):
    h_q, h_pm, h_fin = await login(client, Q), await login(client, PM), await login(client, FIN)
    a = await create(client, h_q, 500, submit=True)
    r = await act(client, h_pm, a["id"], "approve", "按第三条执行")
    assert r.json()["code"] == 0, r.text
    a = await get_claim(client, h_q, a["id"])
    assert a["approval_level"] == 2
    r = await act(client, h_fin, a["id"], "approve", "财务确认")
    assert r.json()["code"] == 0 and "归档" in r.json()["message"]
    a = await get_claim(client, h_q, a["id"])
    assert a["approval_status"] == "approved" and a["approved_by"] == FIN


async def test_mid_amount_full_flow_with_gm_filtered(client):
    h_q = await login(client, Q)
    h_pm, h_mgr, h_fin = await login(client, PM), await login(client, MGR), await login(client, FIN)
    a = await create(client, h_q, 2000, submit=True)
    for user, comment in ((PM, "同意"), (MGR, "情况属实"), (FIN, "已安排扣款")):
        h = {"admin": h_q}.get(user) or {PM: h_pm, MGR: h_mgr, FIN: h_fin}[user]
        r = await act(client, h, a["id"], "approve", comment)
        assert r.json()["code"] == 0, f"{user}: {r.text}"
    a = await get_claim(client, h_q, a["id"])
    assert a["approval_status"] == "approved"


async def test_high_amount_full_flow_with_gm(client):
    h_q, h_pm, h_mgr, h_gm, h_fin = (
        await login(client, Q), await login(client, PM), await login(client, MGR),
        await login(client, GM), await login(client, FIN))
    a = await create(client, h_q, 6000, submit=True)
    for h, user in ((h_pm, PM), (h_mgr, MGR), (h_gm, GM), (h_fin, FIN)):
        r = await act(client, h, a["id"], "approve", f"{user} 同意")
        assert r.json()["code"] == 0, f"{user}: {r.text}"
    assert (await get_claim(client, h_q, a["id"]))["approval_status"] == "approved"


async def test_wrong_role_cannot_approve_node(client):
    h_q, h_mgr = await login(client, Q), await login(client, MGR)
    a = await create(client, h_q, 500, submit=True)
    r = await act(client, h_mgr, a["id"], "approve")
    assert r.json()["code"] == 1 and "purchase_manager" in r.json()["message"]


async def test_admin_bypasses_node_role(client):
    h_q, h_admin = await login(client, Q), await login(client, "admin")
    a = await create(client, h_q, 500, submit=True)
    r = await act(client, h_admin, a["id"], "approve")
    assert r.json()["code"] == 0


async def test_version_optimistic_lock_conflict(client):
    h_q, h_pm = await login(client, Q), await login(client, PM)
    a = await create(client, h_q, 500, submit=True)
    stale = a["version"]
    r = await client.post(f"/api/v1/quality/supplier-claims/{a['id']}/approve",
                          json={"comment": "", "expected_version": stale - 1}, headers=h_pm)
    assert r.json()["code"] == 1 and "刷新" in r.json()["message"]


# ---------------------------------------------------------------- 驳回 / 撤回 / 反审核

async def test_reject_then_resubmit_keeps_rounds(client):
    h_q, h_pm = await login(client, Q), await login(client, PM)
    a = await create(client, h_q, 500, submit=True)
    r = await act(client, h_pm, a["id"], "reject", "计算依据不足")
    assert r.json()["code"] == 0
    assert (await get_claim(client, h_q, a["id"]))["approval_status"] == "rejected"
    r = await client.post(f"/api/v1/quality/supplier-claims/{a['id']}/submit", json={}, headers=h_q)
    assert r.json()["code"] == 0
    a = await get_claim(client, h_q, a["id"])
    assert a["approval_status"] == "pending" and a["approval_round"] == 2
    assert len(a["approval_logs"]) == 3 and a["approval_logs"][-1]["round"] == 2
    assert [l for l in a["approval_logs"] if l["action"] == "reject"]


async def test_recall_pending_then_resubmit(client):
    h_q = await login(client, Q)
    a = await create(client, h_q, 500, submit=True)
    r = await client.post(f"/api/v1/quality/supplier-claims/{a['id']}/recall", json={}, headers=h_q)
    assert r.json()["code"] == 0
    assert (await get_claim(client, h_q, a["id"]))["approval_status"] == "recalled"
    r = await client.post(f"/api/v1/quality/supplier-claims/{a['id']}/submit", json={}, headers=h_q)
    assert r.json()["code"] == 0


async def test_revoke_rolls_back_one_level(client):
    h_q, h_pm, h_mgr = await login(client, Q), await login(client, PM), await login(client, MGR)
    a = await create(client, h_q, 2000, submit=True)
    assert (await act(client, h_pm, a["id"], "approve")).json()["code"] == 0
    a = await get_claim(client, h_q, a["id"])
    assert a["approval_level"] == 2
    # 第2级（供应链经理）先审批推进到第3级，再撤回自己这次审批 → 回退到第2级
    assert (await act(client, h_mgr, a["id"], "approve", "属实")).json()["code"] == 0
    a = await get_claim(client, h_q, a["id"])
    assert a["approval_level"] == 3
    r = await act(client, h_mgr, a["id"], "revoke-approval")
    assert r.json()["code"] == 0
    a = await get_claim(client, h_q, a["id"])
    assert a["approval_level"] == 2
    assert any(l["action"] == "revoked" for l in a["approval_logs"])


async def test_revoke_at_level1_denied(client):
    h_q, h_pm = await login(client, Q), await login(client, PM)
    a = await create(client, h_q, 500, submit=True)
    r = await act(client, h_pm, a["id"], "revoke-approval")
    assert r.json()["code"] == 1


async def test_revoke_by_other_approver_denied(client):
    h_q, h_pm, h_fin = await login(client, Q), await login(client, PM), await login(client, FIN)
    a = await create(client, h_q, 2000, submit=True)
    assert (await act(client, h_pm, a["id"], "approve")).json()["code"] == 0
    r = await act(client, h_fin, a["id"], "revoke-approval")
    assert r.json()["code"] == 1 and "只能撤回自己" in r.json()["message"]


async def test_same_person_auto_skip_across_levels(client):
    """自造双节点同角色链：第1级审批后第2级同人自动跳过并归档。"""
    h_admin, h_q, h_pm = await login(client, "admin"), await login(client, Q), await login(client, PM)
    nodes = [
        {"seq": 1, "label": "一级审核", "role": "purchase_manager"},
        {"seq": 2, "label": "二级复核", "role": "purchase_manager"},
    ]
    r = await client.put("/api/v1/approvals/configs/supplier_claim",
                         json={"nodes": nodes}, headers=h_admin)
    assert r.json()["code"] == 0
    a = await create(client, h_q, 100, submit=True)
    assert len(a["approval_snapshot"]) == 2
    r = await act(client, h_pm, a["id"], "approve")
    assert r.json()["code"] == 0 and r.json()["data"].get("finished") is True
    a = await get_claim(client, h_q, a["id"])
    assert a["approval_status"] == "approved"
    assert any(l["action"] == "auto_skip" for l in a["approval_logs"])


# ---------------------------------------------------------------- 待我审批过滤 / 发起人校验

async def test_pending_filtered_by_node_role(client):
    """统一待审批列表按当前节点权限过滤（聚合端点）。"""
    h_q, h_mgr, h_fin, h_pm = (
        await login(client, Q), await login(client, MGR), await login(client, FIN), await login(client, PM))
    a = await create(client, h_q, 500, submit=True)  # 当前节点=采购经理
    assert any(x["id"] == a["id"] for x in await pending_items(client, h_pm))
    assert all(x["id"] != a["id"] for x in await pending_items(client, h_mgr))  # 金额<1000，manager 节点被条件过滤
    assert all(x["id"] != a["id"] for x in await pending_items(client, h_fin))


async def test_submit_by_non_applicant_denied(client):
    h_q, h_q2 = await login(client, Q), await login(client, Q2)
    a = await create(client, h_q, 100)
    r = await client.post(f"/api/v1/quality/supplier-claims/{a['id']}/submit", json={}, headers=h_q2)
    assert r.json()["code"] == 1 and "发起人" in r.json()["message"]


async def test_recall_by_non_applicant_denied(client):
    h_q, h_q2 = await login(client, Q), await login(client, Q2)
    a = await create(client, h_q, 100, submit=True)
    r = await client.post(f"/api/v1/quality/supplier-claims/{a['id']}/recall", json={}, headers=h_q2)
    assert r.json()["code"] == 1 and "发起人" in r.json()["message"]


# ---------------------------------------------------------------- 删除与归档

async def test_draft_deleted_by_owner(client):
    # admin 有 delete 权限，可删自己的草稿（quality 角色无 delete，删除权用例见 archive 相关测试）
    h_admin = await login(client, "admin")
    a = await create(client, h_admin, 100)
    r = await client.delete(f"/api/v1/quality/supplier-claims/{a['id']}", headers=h_admin)
    assert r.json()["code"] == 0
    assert (await client.get(f"/api/v1/quality/supplier-claims/{a['id']}", headers=h_admin)).json()["code"] == 1


async def test_archived_delete_denied_without_archive_permission(client):
    h_q, h_pm = await login(client, Q), await login(client, PM)
    a = await create(client, h_q, 500, submit=True)
    assert (await act(client, h_pm, a["id"], "approve")).json()["code"] == 0
    assert (await act(client, await login(client, FIN), a["id"], "approve")).json()["code"] == 0
    r = await client.delete(f"/api/v1/quality/supplier-claims/{a['id']}", headers=h_pm)
    assert r.status_code == 403


async def test_archived_delete_by_admin(client):
    h_q, h_pm, h_fin, h_admin = (
        await login(client, Q), await login(client, PM), await login(client, FIN), await login(client, "admin"))
    a = await create(client, h_q, 500, submit=True)
    assert (await act(client, h_pm, a["id"], "approve")).json()["code"] == 0
    assert (await act(client, h_fin, a["id"], "approve")).json()["code"] == 0
    r = await client.delete(f"/api/v1/quality/supplier-claims/{a['id']}", headers=h_admin)
    assert r.json()["code"] == 0


# ---------------------------------------------------------------- 配置 / 通知 / 附件引用计数

async def test_config_update_takes_effect_on_resubmit(client):
    h_admin, h_q = await login(client, "admin"), await login(client, Q)
    nodes = [{"seq": 1, "label": "品质确认", "role": "quality"}]
    assert (await client.put("/api/v1/approvals/configs/supplier_claim",
                             json={"nodes": nodes}, headers=h_admin)).json()["code"] == 0
    a = await create(client, h_q, 100, submit=True)
    assert await snap_roles(a) == ["quality"]
    r = await act(client, h_q, a["id"], "approve")
    assert r.json()["code"] == 0 and r.json()["data"].get("finished") is True


async def test_submit_creates_notifications(db, client):
    h_q = await login(client, Q)
    a = await create(client, h_q, 500, submit=True)
    row = (await db.execute(text(
        "SELECT COUNT(*) FROM notification WHERE type='supplier_claim' "
        "AND ref_type='supplier_claim' AND ref_id=:cid"), {"cid": a["id"]})).scalar()
    await db.commit()
    assert row >= 1


async def test_attachment_refcount_bound_on_submit_and_freed_on_delete(db, client):
    # 全流程用 admin（quality 角色无 delete 权限，无法走到删除解绑分支）
    h_admin = await login(client, "admin")
    keys = ["claim-attach-1.png", "claim-attach-2.pdf"]
    for k in keys:
        await db.execute(text("""
            INSERT INTO file_asset (key, url, name, mime, size, namespace, ref_count, is_orphan)
            VALUES (:k, :k, :k, 'image/png', 10, 'supplier-claim', 0, TRUE)
        """), {"k": k})
    await db.commit()
    a = await create(client, h_admin, 500, submit=True,
                     attachments=[{"key": k, "url": f"/f/{k}", "name": k} for k in keys])
    counts = (await db.execute(text(
        "SELECT ref_count, is_orphan FROM file_asset WHERE key = :k"), {"k": keys[0]})).one()
    await db.commit()
    assert counts[0] == 1 and counts[1] is False
    # 撤回后删除单据 → 解绑引用
    await client.post(f"/api/v1/quality/supplier-claims/{a['id']}/recall", json={}, headers=h_admin)
    assert (await client.delete(f"/api/v1/quality/supplier-claims/{a['id']}", headers=h_admin)).json()["code"] == 0
    counts = (await db.execute(text(
        "SELECT ref_count, is_orphan FROM file_asset WHERE key = :k"), {"k": keys[0]})).one()
    await db.commit()
    assert counts[0] == 0 and counts[1] is True
