"""公共审批引擎纯函数单元测试（不依赖数据库）。"""

from app.services.common.approval_engine import _cond_match, check_node_permission

NODE_NO_CONDITION = {"seq": 1, "label": "节点1", "role": "purchase_manager"}
NODE_DYNAMIC = {"seq": 1, "label": "动态节点", "approvers": [{"username": "张三", "user_id": 7}]}


class TestCheckNodePermission:
    def test_admin_bypasses_all(self):
        ok, msg = check_node_permission({"seq": 1, "role": "finance"}, "任何人", "admin")
        assert ok is True and msg == ""

    def test_dynamic_approver_match_username(self):
        ok, _ = check_node_permission(NODE_DYNAMIC, "张三", "quality")
        assert ok is True

    def test_dynamic_approver_match_user_id(self):
        ok, _ = check_node_permission(NODE_DYNAMIC, "7", "quality")
        assert ok is True

    def test_dynamic_approver_mismatch(self):
        ok, msg = check_node_permission(NODE_DYNAMIC, "李四", "quality")
        assert ok is False and "张三" in msg

    def test_dynamic_approvers_empty_is_resolver_failure(self):
        ok, msg = check_node_permission({"seq": 1, "approvers": []}, "张三", "quality")
        assert ok is False and "解析失败" in msg

    def test_fixed_role_match(self):
        ok, _ = check_node_permission(NODE_NO_CONDITION, "采购经理甲", "purchase_manager")
        assert ok is True

    def test_fixed_role_mismatch(self):
        ok, msg = check_node_permission(NODE_NO_CONDITION, "采购经理甲", "finance")
        assert ok is False and "purchase_manager" in msg

    def test_node_without_role_or_approvers_allows(self):
        ok, _ = check_node_permission({"seq": 1, "label": "空节点"}, "乙", "unknown_role")
        assert ok is True


class TestCondMatch:
    def test_no_condition_matches(self):
        assert _cond_match(None, {}) is True
        assert _cond_match({}, {"claim_amount": 1}) is True

    def test_condition_without_field_matches(self):
        assert _cond_match({"op": ">=", "value": 1000}, {}) is True

    def test_in_operator(self):
        cond = {"field": "claim_reason", "op": "in", "value": ["a", "b"]}
        assert _cond_match(cond, {"claim_reason": "a"}) is True
        assert _cond_match(cond, {"claim_reason": "c"}) is False

    def test_gte_boundary(self):
        cond = {"field": "claim_amount", "op": ">=", "value": 1000}
        assert _cond_match(cond, {"claim_amount": 1000}) is True
        assert _cond_match(cond, {"claim_amount": 999.99}) is False

    def test_all_comparison_operators(self):
        assert _cond_match({"field": "v", "op": ">", "value": 1}, {"v": 2}) is True
        assert _cond_match({"field": "v", "op": "<", "value": 1}, {"v": 2}) is False
        assert _cond_match({"field": "v", "op": "<=", "value": 2}, {"v": 2}) is True
        assert _cond_match({"field": "v", "op": "==", "value": 2}, {"v": 2}) is True
        assert _cond_match({"field": "v", "op": "!=", "value": 2}, {"v": 2}) is False

    def test_non_numeric_value_fails_closed(self):
        assert _cond_match({"field": "v", "op": ">=", "value": 1}, {"v": "abc"}) is False
        assert _cond_match({"field": "v", "op": ">=", "value": 1}, {"v": None}) is False

    def test_missing_field_value_fails_closed(self):
        assert _cond_match({"field": "v", "op": ">=", "value": 1}, {}) is False


class TestConditionsMatch:
    def test_multi_conditions_and(self):
        from app.services.common.approval_engine import _conditions_match

        node = {"conditions": [
            {"field": "amount", "op": ">=", "value": 1000},
            {"field": "dept", "op": "in", "value": ["采购部", "质量部"]},
        ]}
        assert _conditions_match(node, {"amount": 1500, "dept": "采购部"}) is True
        assert _conditions_match(node, {"amount": 1500, "dept": "财务部"}) is False
        assert _conditions_match(node, {"amount": 500, "dept": "采购部"}) is False

    def test_legacy_single_condition(self):
        from app.services.common.approval_engine import _conditions_match

        assert _conditions_match({"condition": {"field": "amount", "op": ">=", "value": 1000}}, {"amount": 1000}) is True
        assert _conditions_match({"condition": {"field": "amount", "op": ">=", "value": 1000}}, {"amount": 999}) is False

    def test_no_condition_always_matches(self):
        from app.services.common.approval_engine import _conditions_match

        assert _conditions_match({}, {"amount": 1}) is True
        assert _conditions_match({"conditions": None}, {"amount": 1}) is True

    def test_in_accepts_comma_string(self):
        from app.services.common.approval_engine import _conditions_match

        node = {"condition": {"field": "dept", "op": "in", "value": "采购部, 质量部"}}
        assert _conditions_match(node, {"dept": "质量部"}) is True
        assert _conditions_match(node, {"dept": "财务部"}) is False


class TestResolveNodeApproverUserIds:
    async def test_approvers_take_priority(self):
        from app.services.common.approval_engine import resolve_node_approver_user_ids

        node = {"role": "purchase_manager", "approvers": [{"user_id": 7, "username": "u7"}, {"username": "u9"}]}
        assert await resolve_node_approver_user_ids(None, node) == [7]

    async def test_role_lookup_uses_db(self):
        from app.services.common.approval_engine import resolve_node_approver_user_ids

        class FakeResult:
            def __iter__(self):
                return iter([(3,), (5,), (None,)])

        class FakeDb:
            async def execute(self, *_a, **_kw):
                return FakeResult()

        assert await resolve_node_approver_user_ids(FakeDb(), {"role": "finance"}) == [3, 5]

    async def test_no_role_returns_empty(self):
        from app.services.common.approval_engine import resolve_node_approver_user_ids

        assert await resolve_node_approver_user_ids(None, {}) == []
