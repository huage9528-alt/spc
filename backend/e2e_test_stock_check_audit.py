"""盘点财务抽检 · HTTP 端到端测试（独立 uvicorn 实例，测完清理数据）。

覆盖: 建单→录数→过程抽检(flag)→重填→完结→发回(reject)→重填→再完结→通过(pass,回写计划>0)
     →免检(exempt)→重复处置409→flag误用400→权限403→通知→清理。
运行: cd backend && python e2e_test_stock_check_audit.py
"""

import asyncio
import subprocess
import sys
import time

import requests

BASE = "http://127.0.0.1:8903"
API = f"{BASE}/api/v1"
RESULTS: list = []

# 绕过系统代理(localhost 代理劫持会导致连接失败)
S = requests.Session()
S.trust_env = False


def check(name: str, cond: bool, detail: str = "") -> None:
    RESULTS.append((name, cond))
    print(f"  {'PASS' if cond else 'FAIL'}  {name} {detail}")


def envelope(res, expect_http=200):
    assert res.status_code == expect_http, f"{res.request.method} {res.url} -> {res.status_code}: {res.text[:300]}"
    body = res.json()
    assert body.get("code") == 0, f"envelope code!=0: {body}"
    return body["data"]


def login(username: str, password: str = "admin123") -> str:
    r = S.post(
        f"{API}/basicdata/auth/login",
        data={"username": username, "password": password, "login_type": "employee"},
        timeout=20,
    )
    return envelope(r)["access_token"]


def hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def main() -> None:
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8903", "--log-level", "warning"],
        cwd=".",
    )
    try:
        for i in range(90):
            if proc.poll() is not None:
                raise RuntimeError(f"uvicorn 进程提前退出 code={proc.returncode}")
            try:
                # /docs 已被禁用(404);任意 HTTP 响应即视为就绪
                S.get(f"{BASE}/docs", timeout=3)
                break
            except requests.exceptions.RequestException:
                pass
            time.sleep(1)
        else:
            raise RuntimeError("uvicorn 未在 90s 内就绪")

        admin = login("admin")
        H = hdr(admin)

        # 1. 选 2 个有仓库的物料
        cand = envelope(S.get(
            f"{API}/materials/stock-check/material-candidates",
            params={"page": 1, "page_size": 30}, headers=H, timeout=30,
        ))
        picked = [c for c in cand["items"] if c.get("wh_id") is not None][:2]
        assert len(picked) == 2, f"可测物料不足: {len(picked)}"
        m_a, m_b = picked[0], picked[1]

        # 2. 建手动盘点单
        head = envelope(S.post(f"{API}/materials/stock-check/from-materials", headers=H, timeout=30, json={
            "items": [
                {"material_id": m_a["erp_material_id"], "wh_id": m_a["wh_id"]},
                {"material_id": m_b["erp_material_id"], "wh_id": m_b["wh_id"]},
            ],
            "title": "E2E抽检测试单",
        }))
        cid = head["id"]
        items = {it["material_code"]: it for it in head["items"]}
        ia, ib = items[m_a["material_code"]], items[m_b["material_code"]]
        check("建单", head["status"] in ("open", "in_progress") and len(head["items"]) == 2)

        # 3. 加共同盘点人（后续验证通知）
        planner_id = None
        co_cand = envelope(S.get(f"{API}/materials/stock-check/co-checker-candidates", headers=H, timeout=20))
        for c in co_cand:
            if c.get("name") == "planner01" or str(c.get("username", "")) == "planner01":
                planner_id = c["user_id"]
                break
        if planner_id:
            envelope(S.put(f"{API}/materials/stock-check/{cid}/co-checkers", headers=H, timeout=20,
                           json={"co_checker_user_ids": [planner_id]}))

        # 4. 录实盘数（造差异: A 实盘=系统+2, B 实盘=系统）
        sys_a = float(ia["system_qty"] or 0)
        sys_b = float(ib["system_qty"] or 0)
        envelope(S.post(f"{API}/materials/stock-check/items/batch", headers=H, timeout=30, json={
            "check_id": cid,
            "items": [
                {"id": ia["id"], "actual_qty": round(sys_a + 2, 4)},
                {"id": ib["id"], "actual_qty": round(sys_b, 4)},
            ],
        }))
        det = envelope(S.get(f"{API}/materials/stock-check/{cid}", headers=H, timeout=20))
        mp = {it["id"]: it for it in det["items"]}
        check("录数", mp[ia["id"]]["actual_qty"] is not None and det["status"] in ("open", "in_progress"))
        ia, ib = mp[ia["id"]], mp[ib["id"]]

        # 5. 过程抽检 flag（A 复点不一致: 系统+3 vs 实盘 系统+2）
        d = envelope(S.post(f"{API}/materials/stock-check/{cid}/audit/flag", headers=H, timeout=30, json={
            "comment": "过程抽检: A 数不符",
            "audit_items": [{"item_id": ia["id"], "audit_qty": round(sys_a + 3, 4)}],
        }))
        check("flag: 单据仍进行中", d["status"] == "in_progress" and d["audit_status"] is None)
        check("flag: 不一致行标记",
              any(it["id"] == ia["id"] and it["audit_failed"] == 1 for it in d["items"]))
        logs = envelope(S.get(f"{API}/materials/stock-check/{cid}/audit-logs", headers=H, timeout=20))
        check("flag: log 轮次1", len(logs) == 1 and logs[0]["action"] == "flag"
              and logs[0]["rejected_item_ids"] == [ia["id"]] and logs[0]["items"][0]["matches"] == 0)

        # 5b. 过程标记的行也可申请复议 → 财务支持 → 标记撤销
        envelope(S.post(f"{API}/materials/stock-check/{cid}/appeal", headers=H, timeout=30, json={
            "item_ids": [ia["id"]], "reason": "过程复点有异议",
        }))
        det = envelope(S.get(f"{API}/materials/stock-check/{cid}", headers=H, timeout=20))
        mp5 = {it["id"]: it for it in det["items"]}
        check("过程标记复议: pending", mp5[ia["id"]]["appeal_status"] == "pending")
        envelope(S.post(f"{API}/materials/stock-check/{cid}/appeal/resolve", headers=H, timeout=30, json={
            "item_ids": [ia["id"]], "accept": True, "comment": "确认口径不同",
        }))
        det = envelope(S.get(f"{API}/materials/stock-check/{cid}", headers=H, timeout=20))
        mp5 = {it["id"]: it for it in det["items"]}
        check("过程复议支持: 标记撤销", mp5[ia["id"]]["audit_failed"] == 0 and mp5[ia["id"]]["appeal_status"] == "accepted")

        # 6. 盘点人重录 A → 标记清除
        envelope(S.post(f"{API}/materials/stock-check/items/batch", headers=H, timeout=30, json={
            "check_id": cid,
            "items": [{"id": ia["id"], "actual_qty": round(sys_a + 2, 4), "force_recount": True}],
        }))
        det = envelope(S.get(f"{API}/materials/stock-check/{cid}", headers=H, timeout=20))
        mp = {it["id"]: it for it in det["items"]}
        check("重录后标记清除", mp[ia["id"]]["audit_failed"] == 0)
        ia, ib = mp[ia["id"]], mp[ib["id"]]

        # 7. 完结 → 待抽检（K3 计划为 0）
        d = envelope(S.post(f"{API}/materials/stock-check/{cid}/complete", headers=H, timeout=30, json={}))
        check("完结: pending 且无回写计划",
              d["status"] == "completed" and d["audit_status"] == "pending"
              and (d.get("writeback_summary") or {}).get("total", 0) == 0)

        # 8. 终检 reject（B 复点不一致）
        d = envelope(S.post(f"{API}/materials/stock-check/{cid}/audit/reject", headers=H, timeout=30, json={
            "comment": "B 复点不符，发回",
            "audit_items": [
                {"item_id": ia["id"], "audit_qty": round(sys_a + 2, 4)},
                {"item_id": ib["id"], "audit_qty": round(sys_b + 1, 4)},
            ],
        }))
        mp = {it["id"]: it for it in d["items"]}
        check("reject: 回 in_progress+rejected", d["status"] == "in_progress" and d["audit_status"] == "rejected")
        check("reject: 仅 B 标记", mp[ia["id"]]["audit_failed"] == 0 and mp[ib["id"]]["audit_failed"] == 1)

        # 9. 通知（planner01 收到；admin 是操作人被排除）
        if planner_id:
            planner_token = login("planner01")
            notif = envelope(S.get(f"{API}/notifications", headers=hdr(planner_token), timeout=20))
            items_n = notif.get("items", notif if isinstance(notif, list) else [])
            hit = [n for n in items_n if n.get("ref_type") == "stock_check" and n.get("ref_id") == cid]
            check("发回通知送达共同盘点人", len(hit) >= 1 and "发回" in hit[0]["title"])

        # 10. 修正 B → 再完结 → pass
        envelope(S.post(f"{API}/materials/stock-check/items/batch", headers=H, timeout=30, json={
            "check_id": cid,
            "items": [{"id": ib["id"], "actual_qty": round(sys_b + 1, 4), "force_recount": True}],
        }))
        envelope(S.post(f"{API}/materials/stock-check/{cid}/complete", headers=H, timeout=30, json={}))
        d = envelope(S.post(f"{API}/materials/stock-check/{cid}/audit/pass", headers=H, timeout=30, json={
            "comment": "复点一致，通过",
            "audit_items": [{"item_id": ib["id"], "audit_qty": round(sys_b + 1, 4)}],
        }))
        wb_sum = d.get("writeback_summary") or {}
        check("pass: passed", d["audit_status"] == "passed")
        check("pass: K3 回写计划 > 0", wb_sum.get("pending", 0) > 0, f"(pending={wb_sum.get('pending')})")
        wbs = envelope(S.get(f"{API}/materials/stock-check/{cid}/writebacks", headers=H, timeout=20))
        check("回写记录落库 pending", all(w["status"] == "pending" for w in wbs.get("writebacks", []))
              and len(wbs.get("writebacks", [])) > 0)

        # 11. 全部 log(含 5b 的复议两轮)
        logs = envelope(S.get(f"{API}/materials/stock-check/{cid}/audit-logs", headers=H, timeout=20))
        acts = [l["action"] for l in logs]
        check("log: flag→复议→裁决→reject→pass 五轮",
              acts == ["flag", "appeal", "appeal_resolve", "reject", "pass"], f"({acts})")

        # 12. 重复处置 → 409
        r = S.post(f"{API}/materials/stock-check/{cid}/audit/reject", headers=H, json={"comment": "x"}, timeout=20)
        check("已处置单再 reject → 409", r.status_code == 409)

        # 13. flag 用于已完结单 → 400
        r = S.post(f"{API}/materials/stock-check/{cid}/audit/flag", headers=H, json={}, timeout=20)
        check("完结单 flag → 400", r.status_code == 400)

        # 14. exempt 流程（第二张单）
        head2 = envelope(S.post(f"{API}/materials/stock-check/from-materials", headers=H, timeout=30, json={
            "items": [{"material_id": m_a["erp_material_id"], "wh_id": m_a["wh_id"]}],
            "title": "E2E免检测试单",
        }))
        it2 = head2["items"][0]
        envelope(S.post(f"{API}/materials/stock-check/items/batch", headers=H, timeout=30, json={
            "check_id": head2["id"], "items": [{"id": it2["id"], "actual_qty": round(sys_a + 2, 4)}],
        }))
        envelope(S.post(f"{API}/materials/stock-check/{head2['id']}/complete", headers=H, timeout=30, json={}))
        d2 = envelope(S.post(f"{API}/materials/stock-check/{head2['id']}/audit/exempt", headers=H, timeout=30, json={}))
        logs2 = envelope(S.get(f"{API}/materials/stock-check/{head2['id']}/audit-logs", headers=H, timeout=20))
        check("exempt: passed 且无复点明细",
              d2["audit_status"] == "passed" and len(logs2) == 1
              and logs2[0]["action"] == "pass_exemption" and logs2[0]["items"] == [])

        # 15. 权限: planner01 无 audit 权限 → 403
        head3 = envelope(S.post(f"{API}/materials/stock-check/from-materials", headers=H, timeout=30, json={
            "items": [{"material_id": m_b["erp_material_id"], "wh_id": m_b["wh_id"]}],
            "title": "E2E权限测试单",
        }))
        r = S.post(f"{API}/materials/stock-check/{head3['id']}/audit/flag",
                   headers=hdr(login("planner01")), json={}, timeout=20)
        check("无权限用户 audit → 403", r.status_code == 403)

        # 16. 复议流程: 发回后盘点人申请复议 → 完结拦截 → 财务支持 → 标记撤销
        head4 = envelope(S.post(f"{API}/materials/stock-check/from-materials", headers=H, timeout=30, json={
            "items": [
                {"material_id": m_a["erp_material_id"], "wh_id": m_a["wh_id"]},
                {"material_id": m_b["erp_material_id"], "wh_id": m_b["wh_id"]},
            ],
            "title": "E2E复议测试单",
        }))
        mp0 = {it["material_code"]: it for it in head4["items"]}
        ra, rb = mp0[m_a["material_code"]], mp0[m_b["material_code"]]
        envelope(S.post(f"{API}/materials/stock-check/items/batch", headers=H, timeout=30, json={
            "check_id": head4["id"],
            "items": [
                {"id": ra["id"], "actual_qty": round(sys_a + 2, 4)},
                {"id": rb["id"], "actual_qty": round(sys_b + 1, 4)},
            ],
        }))
        envelope(S.post(f"{API}/materials/stock-check/{head4['id']}/complete", headers=H, timeout=30, json={}))
        # 财务复点全部不符并发回
        envelope(S.post(f"{API}/materials/stock-check/{head4['id']}/audit/reject", headers=H, timeout=30, json={
            "comment": "两行复点均不符",
            "audit_items": [
                {"item_id": ra["id"], "audit_qty": round(sys_a + 5, 4)},
                {"item_id": rb["id"], "audit_qty": round(sys_b + 9, 4)},
            ],
        }))
        # 盘点人(admin 同人,此处验证接口)对两行申请复议
        ap = envelope(S.post(f"{API}/materials/stock-check/{head4['id']}/appeal", headers=H, timeout=30, json={
            "item_ids": [ra["id"], rb["id"]], "reason": "实地重数无误，复点口径不同",
        }))
        check("复议申请 2 行", ap is not None)
        det = envelope(S.get(f"{API}/materials/stock-check/{head4['id']}", headers=H, timeout=20))
        mp1 = {it["id"]: it for it in det["items"]}
        check("复议中状态", all(it["appeal_status"] == "pending" for it in mp1.values()))
        # 有待裁决复议时完结 → 400
        r = S.post(f"{API}/materials/stock-check/{head4['id']}/complete", headers=H, json={}, timeout=20)
        check("复议待裁决完结 → 400", r.status_code == 400 and "复议" in r.text)
        # 财务裁决: A 支持(撤销标记) B 驳回(维持)
        envelope(S.post(f"{API}/materials/stock-check/{head4['id']}/appeal/resolve", headers=H, timeout=30, json={
            "item_ids": [ra["id"]], "accept": True, "comment": "确认复点口径不同",
        }))
        envelope(S.post(f"{API}/materials/stock-check/{head4['id']}/appeal/resolve", headers=H, timeout=30, json={
            "item_ids": [rb["id"]], "accept": False, "comment": "再次复点确认不符",
        }))
        det = envelope(S.get(f"{API}/materials/stock-check/{head4['id']}", headers=H, timeout=20))
        mp1 = {it["id"]: it for it in det["items"]}
        check("支持复议: 标记撤销", mp1[ra["id"]]["audit_failed"] == 0 and mp1[ra["id"]]["appeal_status"] == "accepted")
        check("驳回复议: 标记维持", mp1[rb["id"]]["audit_failed"] == 1 and mp1[rb["id"]]["appeal_status"] == "rejected")
        logs = envelope(S.get(f"{API}/materials/stock-check/{head4['id']}/audit-logs", headers=H, timeout=20))
        acts4 = [l["action"] for l in logs]
        check("复议留痕 audit_log", "appeal" in acts4 and "appeal_resolve" in acts4, f"({acts4})")

        test_ids = [cid, head2["id"], head3["id"], head4["id"]]
        print(f"\n测试单: {test_ids}")

        # 16b. 复议驳回后修正 B → 再完结 → 通过(确认复议数据不阻塞终检)
        envelope(S.post(f"{API}/materials/stock-check/items/batch", headers=H, timeout=30, json={
            "check_id": head4["id"],
            "items": [{"id": rb["id"], "actual_qty": round(sys_b + 9, 4), "force_recount": True}],
        }))
        envelope(S.post(f"{API}/materials/stock-check/{head4['id']}/complete", headers=H, timeout=30, json={}))
        d4 = envelope(S.post(f"{API}/materials/stock-check/{head4['id']}/audit/pass", headers=H, timeout=30, json={}))
        check("复议闭环后正常终检通过", d4["audit_status"] == "passed")

        failed = [n for n, ok in RESULTS if not ok]
        print()
        if failed:
            print(f"E2E FAILED: {len(failed)} 项 → {failed}")
            _cleanup(test_ids)
            raise SystemExit(1)
        print(f"E2E PASSED: {len(RESULTS)} 项全部通过")
        _cleanup(test_ids)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except Exception:
            proc.kill()


def _cleanup(check_ids: list) -> None:
    """删除测试数据: 盘点单(级联明细/审计/回写记录) + 通知。"""
    async def run() -> None:
        from sqlalchemy import text
        from app.core.database import AsyncSessionLocal
        async with AsyncSessionLocal() as db:
            await db.execute(text(
                "DELETE FROM notification WHERE ref_type = 'stock_check' AND ref_id = ANY(:ids)"
            ), {"ids": check_ids})
            await db.execute(text("DELETE FROM scm_inventory_check WHERE id = ANY(:ids)"), {"ids": check_ids})
            await db.commit()
        print(f"清理完成: 盘点单×{len(check_ids)}(级联明细/audit_log/audit_item/回写记录) + 相关通知")
    asyncio.run(run())


if __name__ == "__main__":
    main()
