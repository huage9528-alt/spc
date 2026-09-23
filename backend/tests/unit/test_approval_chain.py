"""审批链节点校验纯函数测试。"""

from app.services.common.approval_chain import MAX_TIMEOUT_HOURS, normalize_conditions, validate_nodes

ALLOWED = ["claim_amount"]


def _node(**kw):
    base = {"seq": 1, "label": "部门意见", "role": "purchase_manager"}
    base.update(kw)
    return base


class TestValidateNodes:
    def test_valid_role_node(self):
        assert validate_nodes([_node()], allowed_condition_fields=ALLOWED) is None

    def test_valid_approvers_node(self):
        node = _node(role="", approvers=[{"user_id": 7, "username": "qa_pm"}])
        assert validate_nodes([node], allowed_condition_fields=ALLOWED) is None

    def test_empty_nodes_rejected(self):
        assert validate_nodes([], allowed_condition_fields=ALLOWED) == "审批链至少需要 1 个节点"
        assert validate_nodes(None) is not None

    def test_missing_label_rejected(self):
        assert "缺少名称" in validate_nodes([_node(label="  ")], allowed_condition_fields=ALLOWED)

    def test_missing_approver_rejected(self):
        err = validate_nodes([_node(role="")], allowed_condition_fields=ALLOWED)
        assert "未选择审批角色或指定人员" in err

    def test_empty_approvers_rejected(self):
        assert "指定审批人为空" in validate_nodes([_node(role="", approvers=[])], allowed_condition_fields=ALLOWED)

    def test_condition_field_must_be_declared(self):
        node = _node(condition={"field": "unknown", "op": ">=", "value": 1})
        assert "不合法" in validate_nodes([node], allowed_condition_fields=ALLOWED)

    def test_condition_op_whitelist(self):
        node = _node(condition={"field": "claim_amount", "op": "like", "value": 1})
        assert "操作符" in validate_nodes([node], allowed_condition_fields=ALLOWED)

    def test_condition_numeric_value(self):
        node = _node(condition={"field": "claim_amount", "op": ">=", "value": "abc"})
        assert "必须是数字" in validate_nodes([node], allowed_condition_fields=ALLOWED)

    def test_condition_in_accepts_list_or_csv(self):
        ok_list = _node(conditions=[{"field": "claim_amount", "op": "in", "value": [1, 2]}])
        ok_csv = _node(conditions=[{"field": "claim_amount", "op": "in", "value": "1,2"}])
        bad = _node(conditions=[{"field": "claim_amount", "op": "in", "value": ""}])
        assert validate_nodes([ok_list], allowed_condition_fields=ALLOWED) is None
        assert validate_nodes([ok_csv], allowed_condition_fields=ALLOWED) is None
        assert "候选值" in validate_nodes([bad], allowed_condition_fields=ALLOWED)

    def test_conditions_list_validated(self):
        node = _node(conditions=[{"field": "claim_amount", "op": ">=", "value": 1000}])
        assert validate_nodes([node], allowed_condition_fields=ALLOWED) is None
        assert validate_nodes([_node(conditions=[])], allowed_condition_fields=ALLOWED) is not None

    def test_timeout_range(self):
        assert validate_nodes([_node(timeout_hours=0)], allowed_condition_fields=ALLOWED) is None
        assert validate_nodes([_node(timeout_hours=MAX_TIMEOUT_HOURS)], allowed_condition_fields=ALLOWED) is None
        assert "0 ~ 720" in validate_nodes([_node(timeout_hours=MAX_TIMEOUT_HOURS + 1)], allowed_condition_fields=ALLOWED)
        assert "0 ~ 720" in validate_nodes([_node(timeout_hours=-1)], allowed_condition_fields=ALLOWED)
        assert "小时数不正确" in validate_nodes([_node(timeout_hours="abc")], allowed_condition_fields=ALLOWED)

    def test_error_carries_node_index(self):
        assert validate_nodes([_node(), _node(seq=2, label="")], allowed_condition_fields=ALLOWED).startswith("第 2 个节点")


class TestNormalizeConditions:
    def test_legacy_single_condition(self):
        assert normalize_conditions({"condition": {"field": "a", "op": ">=", "value": 1}}) == [{"field": "a", "op": ">=", "value": 1}]

    def test_new_conditions_list(self):
        conds = [{"field": "a", "op": ">=", "value": 1}, {"field": "b", "op": "<=", "value": 2}]
        assert normalize_conditions({"conditions": conds}) == conds

    def test_none(self):
        assert normalize_conditions({}) == []
        assert normalize_conditions(None) == []
