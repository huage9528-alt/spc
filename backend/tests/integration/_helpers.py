"""供应商索赔 / 审批中心集成测试共享助手与账号常量。"""

PM = "qa_pm"        # 采购经理：默认链第 1 级
MGR = "qa_mgr"      # 供应链经理：第 2 级（金额 ≥1000）
GM = "qa_gm"        # 总经理：第 3 级（金额 ≥5000，需角色行种权限）
FIN = "qa_fin"      # 财务：末级
Q = "qa_quality"    # 品质：发起人
Q2 = "qa_quality2"  # 品质二号：验证非发起人操作被拒
VIEWER = "qa_viewer"  # 无审批权限的旁观角色：验证 403


def payload(amount=500, submit=False, attachments=None, supplier="深圳市浩瑞佳电子科技有限公司"):
    return {
        "supplier_name": supplier,
        "supplier_code": "S-HRJ",
        "claim_reason": "field_customer_claim",
        "claim_items": ["man_hour_fee"],
        "claim_amount": amount,
        "claim_method": "本公司财务部直接扣款",
        "calc_explanation": f"回归测试单，金额 {amount}",
        "return_requirement": "no_return",
        "remarks": "pytest",
        "attachments": attachments or [],
        "submit": submit,
    }


async def create(client, headers, amount=500, submit=False, **kw):
    r = await client.post("/api/v1/quality/supplier-claims", json=payload(amount, submit, **kw), headers=headers)
    body = r.json()
    assert body["code"] == 0, body
    return body["data"]


async def get_claim(client, headers, cid):
    r = await client.get(f"/api/v1/quality/supplier-claims/{cid}", headers=headers)
    assert r.json()["code"] == 0, r.text
    return r.json()["data"]


async def act(client, headers, cid, action, comment=""):
    r = await client.post(f"/api/v1/quality/supplier-claims/{cid}/{action}",
                          json={"comment": comment}, headers=headers)
    return r


async def snap_roles(data):
    return [n["role"] for n in (data.get("approval_snapshot") or [])]


async def pending_items(client, headers, biz_type="supplier_claim"):
    """统一待审批列表（可按业务类型过滤；P0 起返回分页结构，取 items）。"""
    r = await client.get("/api/v1/approvals/pending", headers=headers)
    assert r.json()["code"] == 0, r.text
    items = r.json()["data"]["items"]
    return [x for x in items if biz_type is None or x["biz_type"] == biz_type]
