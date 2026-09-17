from copy import deepcopy
from typing import Dict, List


FULL_ACTIONS = ["create", "read", "update", "delete"]


ROLE_PERMISSION_ADDITIONS: Dict[str, Dict[str, List[str]]] = {
    "admin": {
        "production.schedule_plans": FULL_ACTIONS,
        "production.daily_report": FULL_ACTIONS,
        "production.labor_price_audit": ["read"],
        "production.order_wage_lookup": ["read"],
        "exceptions.product_samples": FULL_ACTIONS,
        "rules.order_standards": FULL_ACTIONS,
        "rules.work_instructions": FULL_ACTIONS,
        "finance.data": ["read"],
        "materials.scrap_inventory": ["read"],
        "materials.task_stock_check": ["read"],
        # 部署版本管理：admin 全量（其它角色按需在角色管理授权 read / manage）
        "deploy_versions": ["read", "manage"],
    },
    "planner": {
        "production.schedule_plans": ["read", "update"],
        "production.order_wage_lookup": ["read"],
        "exceptions.product_samples": ["read", "update"],
        "materials.scrap_inventory": ["read"],
        "materials.task_stock_check": ["read"],
    },
    "purchaser": {
        "materials.scrap_inventory": ["read"],
        "materials.task_stock_check": ["read"],
    },
    "manager": {
        "production.schedule_plans": ["read", "update"],
        "production.order_wage_lookup": ["read"],
        "exceptions.product_samples": ["read", "update"],
        "rules.order_standards": ["read", "update"],
        "rules.work_instructions": ["read", "update"],
        "users": ["read", "update"],
        "users.reset_password": ["reset_password"],
        "roles": ["read", "update"],
        "materials.subcontract_orders": ["read"],
        "finance.data": ["read"],
        "materials.scrap_inventory": ["read"],
        "materials.task_stock_check": ["read"],
    },
    "warehouse_Keeper": {
        "materials.subcontract_orders": ["read"],
    },
    "quality": {
        "materials.subcontract_orders": ["read"],
    },
    "org27_pos76": {
        "production.order_wage_lookup": ["read"],
    "purchase_manager": {
        "materials.task_stock_check": ["read"],
    },
}


def merge_role_permission_additions(role_code: str, permissions: Dict[str, List[str]] | None) -> Dict[str, List[str]]:
    merged = deepcopy(permissions or {})
    additions = ROLE_PERMISSION_ADDITIONS.get(role_code, {})
    for resource, actions in additions.items():
        current = set(merged.get(resource, []))
        current.update(actions)
        merged[resource] = sorted(current)
    return merged
