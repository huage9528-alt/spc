"""审批链节点校验（纯函数，供配置 API 与单测使用）。

节点结构（approval_config.nodes 数组元素）：
    {seq, label, role, approvers?, condition?, conditions?, timeout_hours?}
- role 与 approvers 二选一（approvers 优先，元素形如 {"user_id": 7, "username": "x"}）
- conditions（数组，AND）优先；condition（单对象）为历史格式，继续兼容
- timeout_hours：0 = 不提醒，未配置按引擎默认 48
"""

from typing import Optional

COND_OPS = (">=", "<=", ">", "<", "==", "!=", "in")
MAX_TIMEOUT_HOURS = 720


def _clean_str(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def normalize_conditions(node: Optional[dict]) -> list[dict]:
    """把节点条件统一成数组：优先 conditions，其次历史单条件 condition。"""
    if not node:
        return []
    conds = node.get("conditions")
    if isinstance(conds, list) and conds:
        return conds
    single = node.get("condition")
    return [single] if isinstance(single, dict) and single else []


def _validate_condition(cond, allowed_fields: list[str]) -> Optional[str]:
    if not isinstance(cond, dict):
        return "触发条件格式不正确"
    field = _clean_str(cond.get("field"))
    if not field:
        return "触发条件缺少字段"
    if allowed_fields and field not in allowed_fields:
        return f"触发条件字段 {field} 不合法"
    op = _clean_str(cond.get("op")) or "in"
    if op not in COND_OPS:
        return f"触发条件操作符 {op} 不合法"
    value = cond.get("value")
    if op == "in":
        if isinstance(value, str):
            value = [v.strip() for v in value.split(",") if v.strip()]
        if not isinstance(value, list) or not value:
            return "in 条件需要提供至少一个候选值"
    else:
        try:
            float(value)
        except (TypeError, ValueError):
            return "触发条件阈值必须是数字"
    return None


def validate_nodes(nodes, *, allowed_condition_fields: Optional[list[str]] = None) -> Optional[str]:
    """返回错误信息（含节点序号）；None 表示校验通过。"""
    if not isinstance(nodes, list) or not nodes:
        return "审批链至少需要 1 个节点"
    allowed = allowed_condition_fields or []
    for idx, node in enumerate(nodes, 1):
        if not isinstance(node, dict):
            return f"第 {idx} 个节点格式不正确"
        if not _clean_str(node.get("label")):
            return f"第 {idx} 个节点缺少名称"
        approvers = node.get("approvers")
        if approvers is not None:
            if not isinstance(approvers, list) or not approvers:
                return f"第 {idx} 个节点的指定审批人为空"
            for a in approvers:
                if not isinstance(a, dict) or not (a.get("user_id") or _clean_str(a.get("username"))):
                    return f"第 {idx} 个节点的审批人格式不正确"
                if a.get("user_id") is not None:
                    try:
                        int(a["user_id"])
                    except (TypeError, ValueError):
                        return f"第 {idx} 个节点的审批人 user_id 必须是数字"
        elif not _clean_str(node.get("role")):
            return f"第 {idx} 个节点未选择审批角色或指定人员"
        timeout = node.get("timeout_hours")
        if timeout is not None and timeout != "":
            try:
                hours = int(timeout)
            except (TypeError, ValueError):
                return f"第 {idx} 个节点的超时提醒小时数不正确"
            if hours < 0 or hours > MAX_TIMEOUT_HOURS:
                return f"第 {idx} 个节点的超时提醒需在 0 ~ {MAX_TIMEOUT_HOURS} 小时之间"
        conds = node.get("conditions")
        if conds is not None:
            if not isinstance(conds, list) or not conds:
                return f"第 {idx} 个节点的触发条件为空"
        for cond in normalize_conditions(node):
            err = _validate_condition(cond, allowed)
            if err:
                return f"第 {idx} 个节点：{err}"
    return None
