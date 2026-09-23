"""审批中心 API 回归测试（统一待我审批聚合 / 审批链配置 / 角色选项）。"""

from tests.conftest import DEFAULT_CHAIN, login
from tests.integration._helpers import FIN, PM, Q, VIEWER, act, create, payload, pending_items, snap_roles

ADMIN = "admin"


async def test_pending_aggregates_supplier_claim(client):
    """统一待审批聚合索赔单条目，字段与深链完整。"""
    h_q, h_pm = await login(client, Q), await login(client, PM)
    a = await create(client, h_q, 500, submit=True)
    items = await pending_items(client, h_pm)
    hit = [x for x in items if x["id"] == a["id"]]
    assert len(hit) == 1
    item = hit[0]
    assert item["biz_type"] == "supplier_claim" and item["biz_name"] == "供应商索赔单"
    assert item["no"] == a["claim_no"]
    assert item["title"] == a["supplier_name"]
    assert item["deep_link"] == f"/quality/supplier-claims/{a['id']}"
    assert item["current_node"] == "索赔部门意见"
    assert item["current_level"] == 1
    assert item["submitted_at"]


async def test_pending_requires_approval_permission(client):
    """无 approval.pending 权限的角色访问统一待审批 → 403。"""
    h_viewer = await login(client, VIEWER)
    r = await client.get("/api/v1/approvals/pending", headers=h_viewer)
    assert r.status_code == 403


async def test_pending_admin_sees_all_nodes(client):
    """admin 旁路节点权限，任何节点都能看到。"""
    h_q, h_admin = await login(client, Q), await login(client, ADMIN)
    a = await create(client, h_q, 2000, submit=True)  # 当前节点=采购经理
    items = await pending_items(client, h_admin)
    assert any(x["id"] == a["id"] for x in items)


async def test_configs_list_includes_registered_biz(client):
    h_admin = await login(client, ADMIN)
    r = await client.get("/api/v1/approvals/configs", headers=h_admin)
    items = r.json()["data"]["items"]
    sc = next((x for x in items if x["biz_type"] == "supplier_claim"), None)
    assert sc is not None and sc["biz_name"] == "供应商索赔单"
    assert len(sc["nodes"]) == 4


async def test_config_save_via_center_takes_effect(client):
    """经审批中心保存的审批链，对之后重新提交的单据生效。"""
    h_admin, h_q = await login(client, ADMIN), await login(client, Q)
    nodes = [{"seq": 1, "label": "单级确认", "role": "quality"}]
    r = await client.put("/api/v1/approvals/configs/supplier_claim", json={"nodes": nodes}, headers=h_admin)
    assert r.json()["code"] == 0
    a = await create(client, h_q, 100, submit=True)
    assert await snap_roles(a) == ["quality"]
    r = await act(client, h_q, a["id"], "approve")
    assert r.json()["code"] == 0 and r.json()["data"].get("finished") is True


async def test_config_unregistered_biz_rejected(client):
    """未注册到审批中心的 biz_type（如调价单）不可经统一入口改配置，防双写路径。"""
    h_admin = await login(client, ADMIN)
    r = await client.put("/api/v1/approvals/configs/price_change", json={"nodes": []}, headers=h_admin)
    assert r.json()["code"] == 1
    r = await client.get("/api/v1/approvals/configs/price_change", headers=h_admin)
    assert r.json()["code"] == 1


async def test_roles_endpoint_lists_system_roles(client):
    h_admin = await login(client, ADMIN)
    r = await client.get("/api/v1/approvals/roles", headers=h_admin)
    codes = {x["role_code"] for x in r.json()["data"]["items"]}
    assert {"admin", "quality", "purchase_manager", "manager", "finance", "general_manager"} <= codes


async def test_roles_requires_config_permission(client):
    """角色下拉走审批域自有权限：无 approval.config 的角色 403。"""
    h_pm = await login(client, PM)
    r = await client.get("/api/v1/approvals/roles", headers=h_pm)
    assert r.status_code == 403


async def test_snapshot_keeps_node_timeout(client):
    """节点超时配置随快照冻结，供待办列表计算超时分级（0 = 不提醒，必须与未配置区分）。"""
    h_admin, h_q = await login(client, ADMIN), await login(client, Q)
    nodes = [
        {"seq": 1, "label": "单级确认", "role": "quality", "timeout_hours": 24},
        {"seq": 2, "label": "财务结算", "role": "finance", "timeout_hours": 0},
    ]
    r = await client.put("/api/v1/approvals/configs/supplier_claim", json={"nodes": nodes}, headers=h_admin)
    assert r.json()["code"] == 0
    a = await create(client, h_q, 100, submit=True)
    assert [n.get("timeout_hours") for n in a["approval_snapshot"]] == [24, 0]


async def test_pending_returns_page_and_stats(client):
    """分页结构 + 统计卡口径 + 等待时长分级字段。"""
    h_q, h_pm = await login(client, Q), await login(client, PM)
    await create(client, h_q, 500, submit=True)
    r = await client.get("/api/v1/approvals/pending", headers=h_pm)
    body = r.json()
    assert body["code"] == 0
    data = body["data"]
    assert set(data) >= {"items", "total", "page", "page_size", "stats"}
    assert data["total"] == len(data["items"]) >= 1
    stats = data["stats"]
    assert stats["total"] == data["total"]
    assert stats["by_biz"].get("supplier_claim") == data["total"]
    item = data["items"][0]
    assert item["wait_level"] in ("normal", "soon", "overdue")
    assert item["timeout_hours"] == 48
    assert item["version"] >= 1


async def test_pending_keyword_and_biz_filters(client):
    h_q, h_pm = await login(client, Q), await login(client, PM)
    a = await create(client, h_q, 500, submit=True, supplier="深圳市浩瑞佳电子科技有限公司")
    b = await create(client, h_q, 600, submit=True, supplier="东莞精艺塑胶有限公司")
    r = await client.get("/api/v1/approvals/pending", params={"keyword": "精艺"}, headers=h_pm)
    ids = [x["id"] for x in r.json()["data"]["items"]]
    assert ids == [b["id"]]
    r = await client.get("/api/v1/approvals/pending", params={"biz_type": "price_change"}, headers=h_pm)
    assert r.json()["data"]["items"] == []
    # stats 为「全部待办」口径，不随业务类型筛选收缩（统计卡 / chips 计数依赖此口径）
    assert r.json()["data"]["stats"]["total"] == 2


async def test_pending_overdue_only_filter(client):
    """仅看超时：构造 1 条 50 小时前的待办，过滤后只剩它。"""
    from datetime import datetime, timedelta

    from sqlalchemy import text

    from app.core.database import engine

    h_q, h_pm = await login(client, Q), await login(client, PM)
    old = await create(client, h_q, 500, submit=True, supplier="超时供应商")
    fresh = await create(client, h_q, 500, submit=True, supplier="正常供应商")
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE supplier_claim SET submitted_at = :ts WHERE id = :eid"),
            {"ts": datetime.now() - timedelta(hours=50), "eid": old["id"]},
        )
    r = await client.get("/api/v1/approvals/pending", params={"overdue_only": True}, headers=h_pm)
    items = r.json()["data"]["items"]
    assert [x["id"] for x in items] == [old["id"]]
    assert items[0]["wait_level"] == "overdue"
    # 统计卡点击筛选：wait_level / today_only 与 overdue_only 等价或互补
    r = await client.get("/api/v1/approvals/pending", params={"wait_level": "overdue"}, headers=h_pm)
    assert [x["id"] for x in r.json()["data"]["items"]] == [old["id"]]
    r = await client.get("/api/v1/approvals/pending", params={"wait_level": "soon"}, headers=h_pm)
    assert r.json()["data"]["items"] == []
    r = await client.get("/api/v1/approvals/pending", params={"today_only": True}, headers=h_pm)
    assert [x["id"] for x in r.json()["data"]["items"]] == [fresh["id"]]


async def test_my_approved_and_submitted_tabs(client):
    """我已审批 / 我发起的 两个 Tab 的数据与统计口径。"""
    h_q, h_pm, h_fin = await login(client, Q), await login(client, PM), await login(client, FIN)
    a = await create(client, h_q, 500, submit=True)
    await act(client, h_pm, a["id"], "approve", "同意")
    # 默认链财务为无条件末级，需走完财务节点单据才会归档为 approved
    await act(client, h_fin, a["id"], "approve", "同意")

    r = await client.get("/api/v1/approvals/approved", headers=h_pm)
    data = r.json()["data"]
    assert data["total"] == 1 and data["items"][0]["my_action"] == "approve"
    assert data["items"][0]["my_comment"] == "同意"
    assert data["stats"]["processed"] == 1 and data["stats"]["passed"] == 1
    assert data["items"][0]["status"] == "approved"

    r = await client.get("/api/v1/approvals/submitted", headers=h_q)
    data = r.json()["data"]
    assert data["total"] == 1 and data["items"][0]["status"] == "approved"
    assert data["stats"]["approved"] == 1

    r = await client.get("/api/v1/approvals/approved", params={"action": "reject"}, headers=h_pm)
    assert r.json()["data"]["total"] == 0


async def test_item_preview_shape_and_permission(client):
    """抽屉详情：字段 / 进度 / 记录 / can_act 与节点权限一致。"""
    h_q, h_pm, h_fin = await login(client, Q), await login(client, PM), await login(client, FIN)
    a = await create(client, h_q, 500, submit=True)

    r = await client.get(f"/api/v1/approvals/items/supplier_claim/{a['id']}", headers=h_pm)
    data = r.json()["data"]
    assert data["no"] == a["claim_no"] and data["can_act"] is True
    assert [f["label"] for f in data["fields"]][:3] == ["申请人", "提交时间", "供应商"]
    assert data["progress"][0]["state"] == "current"
    assert data["progress"][0]["approver_label"] == "角色：purchase_manager"
    assert data["logs"][0]["action"] == "submit"

    r = await client.get(f"/api/v1/approvals/items/supplier_claim/{a['id']}", headers=h_fin)
    assert r.json()["data"]["can_act"] is False
    # 非当前节点审批人打开抽屉：不能提示「业务不支持审批」
    assert "其他审批人" in r.json()["data"]["action_hint"]


async def test_preview_progress_scoped_to_current_round(client):
    """驳回重提后，上一轮审批记录不得把当前节点标成已处理（进度只看当前轮次）。"""
    h_q, h_pm = await login(client, Q), await login(client, PM)
    a = await create(client, h_q, 500, submit=True)
    assert (await act(client, h_pm, a["id"], "reject", "第一轮驳回")).json()["code"] == 0
    r = await client.post(f"/api/v1/quality/supplier-claims/{a['id']}/submit", headers=h_q)
    assert r.json()["code"] == 0

    r = await client.get(f"/api/v1/approvals/items/supplier_claim/{a['id']}", headers=h_pm)
    progress = r.json()["data"]["progress"]
    assert progress[0]["state"] == "current"
    assert progress[0]["comment"] is None


async def test_submit_rejected_when_chain_missing(client, db):
    """审批链未配置时提交被拒，不产生无人可见的挂起单据。"""
    h_admin, h_q = await login(client, ADMIN), await login(client, Q)
    assert (await client.put("/api/v1/approvals/configs/supplier_claim",
                             json={"nodes": []}, headers=h_admin)).json()["code"] == 1
    # nodes 为空本身会被校验拒绝，这里直接删配置行模拟「未配置」
    from sqlalchemy import text
    from app.core.database import engine
    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM approval_config WHERE biz_type = 'supplier_claim'"))
    try:
        r = await client.post("/api/v1/quality/supplier-claims", json=payload(500, True), headers=h_q)
        assert r.json()["code"] == 1 and "审批链" in r.json()["message"]
        # 失败时丢弃本次插入的草稿，避免留下用户看不到的孤儿单
        count = (await db.execute(text(
            "SELECT COUNT(*) FROM supplier_claim WHERE supplier_name = :sn"
        ), {"sn": payload(500)["supplier_name"]})).scalar()
        assert count == 0
    finally:
        # client fixture 只 UPDATE 不 INSERT，删除的行必须在此恢复，否则污染后续用例
        assert (await client.put("/api/v1/approvals/configs/supplier_claim",
                                 json={"nodes": DEFAULT_CHAIN}, headers=h_admin)).json()["code"] == 0


async def test_unified_approve_and_reject(client):
    """统一动作端点：通过逐级推进（¥500 经 PM → 财务 两级归档）、驳回必填意见。"""
    h_q, h_pm, h_fin = await login(client, Q), await login(client, PM), await login(client, FIN)
    a = await create(client, h_q, 500, submit=True)

    r = await client.post(f"/api/v1/approvals/items/supplier_claim/{a['id']}/reject",
                          json={"comment": ""}, headers=h_pm)
    assert r.json()["code"] == 1

    r = await client.post(f"/api/v1/approvals/items/supplier_claim/{a['id']}/approve",
                          json={"comment": "同意"}, headers=h_pm)
    body = r.json()
    assert body["code"] == 0 and body["data"].get("finished") is False
    assert body["data"].get("skipped") == []  # 下一节点是财务，非同人自动跳过

    r = await client.post(f"/api/v1/approvals/items/supplier_claim/{a['id']}/approve",
                          json={}, headers=h_fin)
    assert r.json()["code"] == 0 and r.json()["data"].get("finished") is True

    r = await client.post(f"/api/v1/approvals/items/supplier_claim/{a['id']}/approve",
                          json={}, headers=h_pm)
    assert r.json()["code"] == 1  # 已归档，状态不正确


async def test_unified_approve_requires_node_permission(client):
    h_q, h_fin = await login(client, Q), await login(client, FIN)
    a = await create(client, h_q, 500, submit=True)
    r = await client.post(f"/api/v1/approvals/items/supplier_claim/{a['id']}/approve",
                          json={}, headers=h_fin)
    assert r.json()["code"] == 1 and "无权" in r.json()["message"]


async def test_unregistered_biz_actions_rejected(client):
    h_admin = await login(client, ADMIN)
    r = await client.post("/api/v1/approvals/items/price_change/1/approve", json={}, headers=h_admin)
    assert r.json()["code"] == 1
    r = await client.get("/api/v1/approvals/items/price_change/1", headers=h_admin)
    assert r.json()["code"] == 1


async def test_batch_approve_reports_partial_failure(client):
    """批量通过：1 条成功 + 1 条乐观锁冲突失败，逐条报告。"""
    h_q, h_pm = await login(client, Q), await login(client, PM)
    a = await create(client, h_q, 300, submit=True)
    b = await create(client, h_q, 400, submit=True)
    payload = {"items": [
        {"biz_type": "supplier_claim", "id": a["id"], "expected_version": a["version"]},
        {"biz_type": "supplier_claim", "id": b["id"], "expected_version": 999},
    ], "comment": "批量同意"}
    r = await client.post("/api/v1/approvals/batch-approve", json=payload, headers=h_pm)
    data = r.json()["data"]
    assert [x["id"] for x in data["passed"]] == [a["id"]]
    assert [x["id"] for x in data["failed"]] == [b["id"]]
    assert "更新" in data["failed"][0]["reason"]
    assert data["skipped"] == []


async def test_batch_approve_failure_leaves_no_orphan_log(client, db):
    """批量失败路径回滚 SAVEPOINT：乐观锁冲突不得留下「未生效的审批记录」。"""
    from sqlalchemy import text

    h_q, h_pm = await login(client, Q), await login(client, PM)
    a = await create(client, h_q, 300, submit=True)
    payload = {"items": [{"biz_type": "supplier_claim", "id": a["id"], "expected_version": 999}]}
    r = await client.post("/api/v1/approvals/batch-approve", json=payload, headers=h_pm)
    assert len(r.json()["data"]["failed"]) == 1
    count = (await db.execute(text(
        "SELECT COUNT(*) FROM supplier_claim_approval_log "
        "WHERE claim_id = :eid AND action IN ('approve', 'auto_skip')"
    ), {"eid": a["id"]})).scalar()
    assert count == 0


async def test_action_endpoints_reject_malformed_input(client):
    """畸形入参返回业务错误（HTTP 200 + code=1）而不是 500。"""
    h_q, h_pm = await login(client, Q), await login(client, PM)
    a = await create(client, h_q, 300, submit=True)
    r = await client.post(f"/api/v1/approvals/items/supplier_claim/{a['id']}/approve",
                          json={"expected_version": "abc"}, headers=h_pm)
    assert r.status_code == 200 and r.json()["code"] == 1
    r = await client.post("/api/v1/approvals/batch-approve", json={"items": ["x"]}, headers=h_pm)
    assert r.status_code == 200 and r.json()["data"]["failed"][0]["reason"] == "请求条目格式不正确"
    r = await client.post("/api/v1/approvals/batch-approve",
                          json={"items": [{"biz_type": "supplier_claim", "id": "abc"}]}, headers=h_pm)
    assert r.status_code == 200 and r.json()["data"]["failed"][0]["reason"] == "单据 ID 不正确"


async def test_config_validation_rejects_bad_nodes(client):
    """审批链保存校验：空链 / 缺审批人 / 非法操作符 / 非法条件字段 / 超时越界。"""
    h_admin = await login(client, ADMIN)
    cases = [
        ([], "至少需要 1 个节点"),
        ([{"seq": 1, "label": "意见", "role": ""}], "未选择审批角色或指定人员"),
        ([{"seq": 1, "label": "意见", "role": "quality",
           "condition": {"field": "claim_amount", "op": "like", "value": 1}}], "操作符"),
        ([{"seq": 1, "label": "意见", "role": "quality",
           "condition": {"field": "unknown_field", "op": ">=", "value": 1}}], "不合法"),
        ([{"seq": 1, "label": "意见", "role": "quality", "timeout_hours": 9999}], "0 ~ 720"),
    ]
    for nodes, keyword in cases:
        r = await client.put("/api/v1/approvals/configs/supplier_claim", json={"nodes": nodes}, headers=h_admin)
        assert r.json()["code"] == 1, nodes
        assert keyword in r.json()["message"], (nodes, r.json()["message"])


async def test_config_accepts_approvers_multi_conditions_and_timeout(client, db):
    """指定人员 + 多条件 AND + 超时配置：保存后提交，快照按条件过滤并带上审批人与超时。"""
    from sqlalchemy import text

    h_admin, h_q = await login(client, ADMIN), await login(client, Q)
    qa2_id = (await db.execute(text("SELECT id FROM sys_user WHERE username = 'qa_quality2'"))).scalar()
    nodes = [
        {"seq": 1, "label": "指定人确认", "role": "",
         "approvers": [{"user_id": qa2_id, "username": "qa_quality2"}], "timeout_hours": 12},
        {"seq": 2, "label": "金额双条件", "role": "manager", "timeout_hours": 0,
         "conditions": [{"field": "claim_amount", "op": ">=", "value": 1000},
                        {"field": "claim_amount", "op": "<=", "value": 999999}]},
    ]
    r = await client.put("/api/v1/approvals/configs/supplier_claim", json={"nodes": nodes}, headers=h_admin)
    assert r.json()["code"] == 0, r.json()
    a = await create(client, h_q, 500, submit=True)   # 500 不满足节点 2 的金额条件
    snap = a["approval_snapshot"]
    assert [n["label"] for n in snap] == ["指定人确认"]
    assert snap[0]["approvers"][0]["user_id"] == qa2_id
    assert snap[0]["approvers"][0]["username"] == "qa_quality2"
    assert snap[0]["timeout_hours"] == 12


async def test_config_disable_blocks_new_submission(client):
    """停用审批链：提交被拒（避免产生无人可见的挂单），在途单据不受影响。"""
    h_admin, h_q = await login(client, ADMIN), await login(client, Q)
    r = await client.put("/api/v1/approvals/configs/supplier_claim",
                         json={"nodes": [{"seq": 1, "label": "意见", "role": "quality"}], "is_active": False},
                         headers=h_admin)
    assert r.json()["code"] == 0 and r.json()["data"]["is_active"] is False
    r = await client.get("/api/v1/approvals/configs/supplier_claim", headers=h_admin)
    assert r.json()["data"]["is_active"] is False
    r = await client.post("/api/v1/quality/supplier-claims", json=payload(500, True), headers=h_q)
    assert r.json()["code"] == 1 and "审批链" in r.json()["message"]
    # 重新启用后恢复可提交
    r = await client.put("/api/v1/approvals/configs/supplier_claim",
                         json={"nodes": [{"seq": 1, "label": "意见", "role": "quality"}], "is_active": True},
                         headers=h_admin)
    assert r.json()["code"] == 0
    a = await create(client, h_q, 500, submit=True)
    assert a["approval_status"] == "pending"


async def test_configs_list_reports_pending_count_and_field_options(client):
    h_admin, h_q = await login(client, ADMIN), await login(client, Q)
    await create(client, h_q, 500, submit=True)
    r = await client.get("/api/v1/approvals/configs", headers=h_admin)
    sc = next(x for x in r.json()["data"]["items"] if x["biz_type"] == "supplier_claim")
    assert sc["pending_count"] == 1
    assert sc["condition_field_options"] == [{"value": "claim_amount", "label": "索赔金额"}]


async def test_users_endpoint_lists_approver_candidates(client):
    h_admin, h_pm = await login(client, ADMIN), await login(client, PM)
    r = await client.get("/api/v1/approvals/users", headers=h_admin)
    usernames = {x["username"] for x in r.json()["data"]["items"]}
    assert {"qa_pm", "qa_fin", "admin"} <= usernames
    assert all(x["display_name"] for x in r.json()["data"]["items"])
    r = await client.get("/api/v1/approvals/users", params={"keyword": "qa_pm"}, headers=h_admin)
    assert [x["username"] for x in r.json()["data"]["items"]] == ["qa_pm"]
    # 审批域自有权限：无 approval.config 的角色 403
    assert (await client.get("/api/v1/approvals/users", headers=h_pm)).status_code == 403


async def test_timeout_reminder_skips_disabled_business(client, db):
    """停用审批链后不再推送超时提醒（在途单据仍保留待办可见与可审批）。"""
    from datetime import datetime, timedelta

    from sqlalchemy import text as sql_text

    from app.core.database import engine
    from app.services.scheduler.approval_timeout_reminder import ApprovalTimeoutReminderScheduler

    h_admin, h_q = await login(client, ADMIN), await login(client, Q)
    nodes = [{"seq": 1, "label": "意见", "role": "purchase_manager", "timeout_hours": 1}]
    assert (await client.put("/api/v1/approvals/configs/supplier_claim",
                             json={"nodes": nodes}, headers=h_admin)).json()["code"] == 0
    a = await create(client, h_q, 500, submit=True)
    async with engine.begin() as conn:
        await conn.execute(sql_text("UPDATE supplier_claim SET submitted_at = :ts WHERE id = :eid"),
                           {"ts": datetime.now() - timedelta(hours=3), "eid": a["id"]})

    scheduler = ApprovalTimeoutReminderScheduler()
    assert await scheduler._collect_targets(db) != []  # 启用时命中超时待办
    assert (await client.put("/api/v1/approvals/configs/supplier_claim",
                             json={"nodes": nodes, "is_active": False}, headers=h_admin)).json()["code"] == 0
    assert await scheduler._collect_targets(db) == []  # 停用后不再提醒
