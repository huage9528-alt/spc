from copy import deepcopy
from typing import Dict, List


FULL_ACTIONS = ["create", "read", "update", "delete"]


ROLE_PERMISSION_ADDITIONS: Dict[str, Dict[str, List[str]]] = {
    "admin": {
        "production.schedule_plans": FULL_ACTIONS,
        "production.daily_report": FULL_ACTIONS,
        "exceptions.product_samples": FULL_ACTIONS,
        "rules.order_standards": FULL_ACTIONS,
        "rules.work_instructions": FULL_ACTIONS,
        "finance.data": ["read"],
    },
    "planner": {
        "production.schedule_plans": ["read", "update"],
        "exceptions.product_samples": ["read", "update"],
    },
    "manager": {
        "production.schedule_plans": ["read", "update"],
        "exceptions.product_samples": ["read", "update"],
        "rules.order_standards": ["read", "update"],
        "rules.work_instructions": ["read", "update"],
        "users": ["read", "update", "reset_password"],
        "roles": ["read", "update"],
        "materials.subcontract_orders": ["read"],
        "finance.data": ["read"],
    },
    "warehouse_Keeper": {
        "materials.subcontract_orders": ["read"],
    },
    "quality": {
        "materials.subcontract_orders": ["read"],
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
