"""对外接口路由装配：聚合各业务 router 并做注册表一致性校验"""

from fastapi import APIRouter

from .registry import check_registry_matches_router
# 触发 endpoints 包导入，使所有 @register_external 装饰器生效
from . import endpoints  # noqa: F401
from .endpoints import (
    bom, bom_detail, bom_tree, human_resources, inventory, inventory_availability,
    masterdata, material_kitting, material_supplies, orders, production,
    production_task_orders, process_data, purchase, quality, warehouse,
)

external_router = APIRouter()
for r in (
    orders.router, orders.router_details,
    masterdata.router,
    bom.router, bom_detail.router, bom_tree.router,
    human_resources.org_router, human_resources.pos_router, human_resources.emp_router,
    production.router, production_task_orders.router,
    process_data.router,
    purchase.router, inventory.router,
    inventory_availability.router,
    material_kitting.router, material_supplies.router,
    quality.router, quality.router_trace,
    warehouse.wh_router, warehouse.loc_router,
):
    external_router.include_router(r)

check_registry_matches_router(external_router)

