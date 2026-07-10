"""权限声明注册表 — 声明即注册，启动时同步到数据库"""

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


@dataclass
class PermissionDef:
    """权限定义"""
    code: str
    name: str
    module: str
    parent_code: Optional[str] = None
    actions: List[str] = field(default_factory=lambda: ["create", "read", "update", "delete"])
    route_path: Optional[str] = None
    sort_order: int = 0


# 全局权限声明注册表
_declared_permissions: Dict[str, PermissionDef] = {}


def declare_permission(
    code: str,
    name: str,
    module: str,
    parent_code: Optional[str] = None,
    actions: Optional[List[str]] = None,
    route_path: Optional[str] = None,
    sort_order: int = 0,
) -> None:
    """声明一个权限定义。在 API 模块顶部调用，应用启动时会同步到数据库。

    用法:
        declare_permission("production", "生产协同中心", module="production")
        declare_permission("production.schedule_plans", "排产台账", module="production",
                          parent_code="production", route_path="/schedule-plans")
    """
    if code in _declared_permissions:
        # 已存在则更新（允许重复声明，以最后一次为准）
        existing = _declared_permissions[code]
        existing.name = name
        existing.module = module
        if parent_code is not None:
            existing.parent_code = parent_code
        if actions is not None:
            existing.actions = actions
        if route_path is not None:
            existing.route_path = route_path
        if sort_order != 0:
            existing.sort_order = sort_order
        return

    _declared_permissions[code] = PermissionDef(
        code=code,
        name=name,
        module=module,
        parent_code=parent_code,
        actions=actions or ["create", "read", "update", "delete"],
        route_path=route_path,
        sort_order=sort_order,
    )


def get_all_declared_permissions() -> Dict[str, PermissionDef]:
    """获取所有已声明的权限定义"""
    return dict(_declared_permissions)


async def sync_permissions_to_db(db: AsyncSession) -> int:
    """将所有已声明的权限同步到 sys_permission 表（upsert）。
    返回新增或更新的权限数量。
    """
    from app.models.basicdata.permission import SysPermission

    if not _declared_permissions:
        logger.warning("[权限注册] 没有声明任何权限，跳过同步")
        return 0

    synced = 0
    for code, perm in _declared_permissions.items():
        # 使用 PostgreSQL 的 INSERT ... ON CONFLICT DO UPDATE
        stmt = pg_insert(SysPermission).values(
            code=perm.code,
            name=perm.name,
            module=perm.module,
            parent_code=perm.parent_code,
            actions=perm.actions,
            route_path=perm.route_path,
            sort_order=perm.sort_order,
            is_active=True,
        )
        # 冲突时更新 name、module、parent_code、actions、route_path、sort_order
        stmt = stmt.on_conflict_do_update(
            index_elements=["code"],
            set_={
                "name": stmt.excluded.name,
                "module": stmt.excluded.module,
                "parent_code": stmt.excluded.parent_code,
                "actions": stmt.excluded.actions,
                "route_path": stmt.excluded.route_path,
                "sort_order": stmt.excluded.sort_order,
                "updated_at": sa_func_now(),
            },
        )
        await db.execute(stmt)
        synced += 1

    await db.commit()
    logger.info(f"[权限注册] 同步 {synced} 个权限定义到数据库")
    return synced


def sa_func_now():
    """延迟导入避免循环依赖"""
    from sqlalchemy.sql import func
    return func.now()


# ========== 声明所有当前系统权限 ==========
# 这些声明与代码同位，新增功能时只需在这里添加一行

# 供应链驾驶舱
declare_permission("dashboard", "供应链驾驶舱", module="dashboard", route_path="/dashboard", sort_order=1)

# 顶栏功能
declare_permission("topbar", "顶栏功能", module="topbar", sort_order=2)
declare_permission("topbar.share", "页面分享", module="topbar", parent_code="topbar", actions=["read"], sort_order=1)
declare_permission("topbar.feedback", "问题反馈", module="topbar", parent_code="topbar", actions=["read"], sort_order=2)
declare_permission("topbar.ai_search", "AI 全局搜索", module="topbar", parent_code="topbar", actions=["read"], sort_order=3)
declare_permission("topbar.font_size", "字号设置", module="topbar", parent_code="topbar", actions=["read"], sort_order=4)
declare_permission("topbar.notifications", "通知铃铛", module="topbar", parent_code="topbar", actions=["read"], sort_order=5)

# 订单交付中心
declare_permission("orders", "订单交付中心", module="orders", sort_order=3)
declare_permission("orders.list", "订单总控台", module="orders", parent_code="orders", route_path="/orders", sort_order=1)
declare_permission("orders.run_orders", "跑单管理", module="orders", parent_code="orders", route_path="/run-orders", sort_order=2)
declare_permission("orders.risk_pool", "订单风险池", module="orders", parent_code="orders", route_path="/order-risk-pool", sort_order=3)

# 物料齐套中心
declare_permission("materials", "物料齐套中心", module="materials", sort_order=4)
declare_permission("materials.purchase_plan", "采购到料计划", module="materials", parent_code="materials", route_path="/purchase-plan", sort_order=1)
declare_permission("materials.issues", "问题物料池", module="materials", parent_code="materials", route_path="/material-issues", sort_order=2)
declare_permission("materials.long_lead", "长交期物料池", module="materials", parent_code="materials", route_path="/long-lead-materials", sort_order=3)
declare_permission("materials.kit_analysis", "齐套分析", module="materials", parent_code="materials", route_path="/kit-analysis", sort_order=4)
declare_permission("materials.supplier_risk", "供应商风险分析", module="materials", parent_code="materials", route_path="/supplier-risk", sort_order=5)
declare_permission("materials.supplier_payment", "供应商付款排程", module="materials", parent_code="materials", route_path="/supplier-payment", sort_order=6)

# 生产协同中心
declare_permission("production", "生产协同中心", module="production", sort_order=5)
declare_permission("production.overview", "生产总览", module="production", parent_code="production", route_path="/production-overview", sort_order=1)
declare_permission("production.schedule_plans", "排产台账", module="production", parent_code="production", route_path="/schedule-plans", sort_order=2)
declare_permission("production.product_process_capacities", "产品工序产能", module="production", parent_code="production", route_path="/product-process-capacities", sort_order=3)
declare_permission("production.front_process", "前道管理", module="production", parent_code="production", route_path="/front-process", sort_order=4)
declare_permission("production.smt", "贴片管理", module="production", parent_code="production", route_path="/smt", sort_order=5)
declare_permission("production.lean", "精益管理", module="production", parent_code="production", route_path="/lean", sort_order=6)
declare_permission("production.assembly", "组装管理", module="production", parent_code="production", route_path="/assembly", sort_order=7)
declare_permission("production.packaging", "包装管理", module="production", parent_code="production", route_path="/packaging", sort_order=8)
declare_permission("production.exceptions", "工序异常池", module="production", parent_code="production", route_path="/process-exceptions", sort_order=9)

# 异常与质量中心
declare_permission("exceptions", "异常与质量中心", module="exceptions", sort_order=6)
declare_permission("exceptions.pool", "异常总池", module="exceptions", parent_code="exceptions", route_path="/issues", sort_order=1)
declare_permission("exceptions.issue_log", "问题日志", module="exceptions", parent_code="exceptions", route_path="/issue-log", sort_order=2)
declare_permission("exceptions.change_log", "变更日志", module="exceptions", parent_code="exceptions", route_path="/change-log", sort_order=3)
declare_permission("exceptions.quality", "品质异常", module="exceptions", parent_code="exceptions", route_path="/quality-issues", sort_order=4)
declare_permission("exceptions.product_samples", "产品封样", module="exceptions", parent_code="exceptions", route_path="/product-samples", sort_order=5)
declare_permission("exceptions.closure", "闭环跟踪", module="exceptions", parent_code="exceptions", route_path="/closure-tracking", sort_order=6)

# 会议与任务中心
declare_permission("meetings", "会议与任务中心", module="meetings", route_path="/meetings", sort_order=7)

# 新品/NPI项目中心
declare_permission("npi", "新品/NPI项目中心", module="npi", route_path="/npi", sort_order=8)

# 规则配置中心
declare_permission("rules", "规则配置中心", module="rules", sort_order=9)
declare_permission("rules.risk_rules", "预警规则", module="rules", parent_code="rules", route_path="/risk-rules", sort_order=1)
declare_permission("rules.inspection", "点检规则", module="rules", parent_code="rules", route_path="/inspection-rules", sort_order=2)
declare_permission("rules.node_standards", "节点标准", module="rules", parent_code="rules", route_path="/node-standards", sort_order=3)
declare_permission("rules.order_standards", "订单标准", module="rules", parent_code="rules", route_path="/order-standards", sort_order=4)
declare_permission("rules.work_instructions", "作业指导书", module="rules", parent_code="rules", route_path="/work-instructions", sort_order=5)
declare_permission("rules.responsibility", "责任归属", module="rules", parent_code="rules", route_path="/responsibility-map", sort_order=6)
declare_permission("rules.status_dict", "状态字典", module="rules", parent_code="rules", route_path="/status-dict", sort_order=7)

# 基础数据与集成中心
declare_permission("basicdata", "基础数据与集成中心", module="basicdata", sort_order=10)
declare_permission("basicdata.import", "数据集成", module="basicdata", parent_code="basicdata", actions=["create", "read", "update", "delete", "import"], route_path="/import", sort_order=1)
declare_permission("basicdata.data", "基础数据管理", module="basicdata", parent_code="basicdata", sort_order=2)
declare_permission("basicdata.data.customers", "客户", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/customers", sort_order=1)
declare_permission("basicdata.data.suppliers", "供应商", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/suppliers", sort_order=2)
declare_permission("basicdata.data.materials", "物料", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/materials", sort_order=3)
declare_permission("basicdata.data.skus", "SKU", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/skus", sort_order=4)
declare_permission("basicdata.data.products", "产品", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/products", sort_order=5)
declare_permission("basicdata.data.warehouses", "仓库", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/warehouses", sort_order=6)
declare_permission("basicdata.data.processes", "工序", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/processes", sort_order=7)
declare_permission("basicdata.data.organizations", "组织", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/organizations", sort_order=8)
declare_permission("basicdata.data.positions", "岗位", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/positions", sort_order=9)
declare_permission("basicdata.data.employees", "人员", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/employees", sort_order=10)
declare_permission("basicdata.feedback", "问题反馈", module="basicdata", parent_code="basicdata", route_path="/basicdata/feedback", sort_order=3)
declare_permission("basicdata.files", "文件管理", module="basicdata", parent_code="basicdata", route_path="/basicdata/files", sort_order=4)
declare_permission("basicdata.data_supply", "数据供给", module="basicdata", parent_code="basicdata", route_path="/basicdata/data-supply", sort_order=10)
declare_permission("announcements", "公告管理", module="basicdata", parent_code="basicdata", route_path="/announcements", sort_order=5)
declare_permission("users", "用户管理", module="basicdata", parent_code="basicdata", route_path="/users", sort_order=6)
declare_permission("roles", "角色管理", module="basicdata", parent_code="basicdata", route_path="/roles", sort_order=7)
declare_permission("audit", "审计日志", module="basicdata", parent_code="basicdata", actions=["read"], route_path="/audit", sort_order=8)
declare_permission("settings", "同步SQL配置", module="basicdata", parent_code="basicdata", route_path="/sync-config", sort_order=9)
