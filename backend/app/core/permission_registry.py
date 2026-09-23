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
    """将已声明的权限播种到 sys_permission 表（仅首次插入，不覆盖既有行）。

    DB 是权限定义的唯一真相源：首次部署时把代码声明的权限 seed 进去，
    之后管理员可通过「权限管理」页面在运行时增删改，重启不会被覆盖。
    新增的代码声明（新 code）仍会在下次启动时自动 seed。
    注意：对既有 code 的代码侧改名/调序不再回灌 DB——需在权限管理页面或迁移脚本中处理。
    """
    from app.models.basicdata.permission import SysPermission

    if not _declared_permissions:
        logger.warning("[权限注册] 没有声明任何权限，跳过同步")
        return 0

    synced = 0
    for code, perm in _declared_permissions.items():
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
        # 冲突时什么都不做——保留 DB 中的运行时编辑
        stmt = stmt.on_conflict_do_nothing(index_elements=["code"])
        await db.execute(stmt)
        synced += 1

    await db.commit()
    logger.info(f"[权限注册] 播种 {synced} 个权限定义到数据库（仅首次插入）")
    return synced


# 已废弃的权限 code —— 这些权限已迁移到 materials.stock_check，
# 运行期代码（API PermissionChecker / 前端菜单）不再引用，需在每次启动时清理。
# quality.supplier_claim.pending / .config：审批中心上线前的旧权限，已被 approval.pending / approval.config 取代。
# 仅存在于历史库中（代码从未声明），不清理会继续作为菜单项渲染在「品质管理」下。
DEPRECATED_PERMISSION_CODES = (
    "orders.stock_check",
    "orders.inventory_check",
    "quality.supplier_claim.pending",
    "quality.supplier_claim.config",
)

# 一次性动作迁移:盘点抽检曾声明为 read/manage,现回归标准增删改查。
# 幂等:每次启动执行,已迁移的行不再变化。
MIGRATE_AUDIT_ACTIONS = ("materials.stock_check_audit",)


async def migrate_permission_actions(db: AsyncSession) -> int:
    """把 materials.stock_check_audit 的 actions 迁移为标准 CRUD,并把角色 JSON 内的
    manage 动作迁到 update(该权限此前以 read/manage 声明)。幂等,每次启动执行。"""
    from sqlalchemy import text

    changed = 0
    for code in MIGRATE_AUDIT_ACTIONS:
        await db.execute(
            text(
                "UPDATE sys_permission SET actions = '[\"create\", \"read\", \"update\", \"delete\"]'::jsonb "
                "WHERE code = CAST(:code AS text) AND actions::text <> '[\"create\", \"read\", \"update\", \"delete\"]'"
            ),
            {"code": code},
        )
        # 角色 JSON: {"materials.stock_check_audit": ["read","manage"]} → manage 迁移为 update,并确保含 read
        result = await db.execute(
            text(
                "UPDATE sys_role SET permissions = jsonb_set( "
                "  permissions - CAST(:code AS text), "
                "  ARRAY[:code], "
                "  ( "
                "    SELECT COALESCE(jsonb_agg(DISTINCT x.a ORDER BY x.a), '[]'::jsonb) "
                "    FROM ( "
                "      SELECT CASE WHEN t.a = 'manage' THEN 'update' ELSE t.a END AS a "
                "      FROM jsonb_array_elements_text(permissions -> CAST(:code AS text)) AS t(a) "
                "      UNION SELECT 'read' "
                "    ) x "
                "  ) "
                ") "
                "WHERE permissions ? CAST(:code AS text) "
                "  AND permissions -> CAST(:code AS text) ? 'manage'"
            ),
            {"code": code},
        )
        changed += result.rowcount or 0
    await db.commit()
    if changed:
        logger.info(f"[权限注册] 迁移盘点抽检动作 manage→update,涉及 {changed} 个角色")
    return changed


async def cleanup_deprecated_permissions(db: AsyncSession) -> int:
    """清理已废弃的权限：从 sys_role.permissions JSONB 移除 key，并删除 sys_permission 行。

    与 sync_permissions_to_db 不同，本函数在每次应用启动（lifespan）时执行，
    因此不依赖 init_database.py 是否被运行。幂等。
    """
    from sqlalchemy import text

    removed = 0
    for code in DEPRECATED_PERMISSION_CODES:
        # 1) sys_role.permissions: 移除 JSONB 中的 key
        await db.execute(
            text(
                "UPDATE sys_role "
                "SET permissions = permissions - CAST(:code AS text) "
                "WHERE permissions ? CAST(:code AS text)"
            ),
            {"code": code},
        )
        # 2) sys_permission: 删除行
        result = await db.execute(
            text("DELETE FROM sys_permission WHERE code = CAST(:code AS text)"),
            {"code": code},
        )
        removed += result.rowcount or 0
    await db.commit()
    if removed:
        logger.info(
            f"[权限注册] 清理 {removed} 个废弃权限定义 "
            f"(codes={list(DEPRECATED_PERMISSION_CODES)})"
        )
    return removed


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
declare_permission("materials.kitting", "齐套计算", module="materials", parent_code="materials", actions=["read", "manage"], sort_order=5)
declare_permission("materials.supplier_risk", "供应商风险分析", module="materials", parent_code="materials", route_path="/supplier-risk", sort_order=5)
declare_permission("materials.supplier_payment", "供应商付款排程", module="materials", parent_code="materials", route_path="/supplier-payment", sort_order=6)
declare_permission("materials.stock_check", "物料盘点", module="materials", parent_code="materials", route_path="/stock-check", sort_order=7)
declare_permission("materials.task_stock_check", "任务盘点", module="materials", parent_code="materials", route_path="/task-stock-check", sort_order=8)
declare_permission("materials.stock_check_audit", "盘点抽检", module="materials", parent_code="materials", route_path="/stock-check-audit", sort_order=13)
declare_permission("materials.subcontract_orders", "委外订单", module="materials", parent_code="materials", route_path="/subcontract-orders", sort_order=9)
declare_permission("materials.scrap_inventory", "报废物料库存查询", module="materials", parent_code="materials", route_path="/scrap-inventory", sort_order=10)
declare_permission("materials.inventory_board", "库存看板", module="materials", parent_code="materials", route_path="/inventory-board", sort_order=11)
declare_permission("materials.occupancy", "物料占用分析", module="materials", parent_code="materials", actions=["read"], route_path="/material-occupancy", sort_order=12)

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
declare_permission("production.daily_report", "生产日报表", module="production", parent_code="production", route_path="/daily-reports", sort_order=10)
declare_permission("production.labor_price_audit", "工价审核", module="production", parent_code="production", route_path="/labor-price-audits", sort_order=11)
declare_permission("production.order_wage_lookup", "订单工价查询", module="production", parent_code="production", route_path="/order-wage-lookup", sort_order=12, actions=["read"])

# 异常与质量中心
declare_permission("exceptions", "异常与质量中心", module="exceptions", sort_order=6)
declare_permission("exceptions.pool", "异常总池", module="exceptions", parent_code="exceptions", route_path="/issues", sort_order=1)
declare_permission("exceptions.quality", "品质异常", module="exceptions", parent_code="exceptions", route_path="/quality-issues", sort_order=4)
declare_permission("exceptions.product_samples", "产品封样", module="exceptions", parent_code="exceptions", route_path="/product-samples", sort_order=5)
declare_permission("exceptions.closure", "闭环跟踪", module="exceptions", parent_code="exceptions", route_path="/closure-tracking", sort_order=6)

# 规则配置中心
declare_permission("rules", "规则配置中心", module="rules", sort_order=9)
declare_permission("rules.risk_rules", "预警规则", module="rules", parent_code="rules", route_path="/risk-rules", sort_order=1)
declare_permission("rules.node_standards", "节点标准", module="rules", parent_code="rules", route_path="/node-standards", sort_order=3)
declare_permission("rules.order_standards", "订单标准", module="rules", parent_code="rules", route_path="/order-standards", sort_order=4)
declare_permission("rules.work_instructions", "作业指导书", module="rules", parent_code="rules", route_path="/work-instructions", sort_order=5)

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
declare_permission("basicdata.data.locations", "库位", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/locations", sort_order=7)
declare_permission("basicdata.data.processes", "工序", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/processes", sort_order=8)
declare_permission("basicdata.data.organizations", "组织", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/organizations", sort_order=9)
declare_permission("basicdata.data.positions", "岗位", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/positions", sort_order=10)
declare_permission("basicdata.data.employees", "人员", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/employees", sort_order=11)
declare_permission("basicdata.data.inventory", "库存", module="basicdata", parent_code="basicdata.data", route_path="/basicdata/inventory", sort_order=12)
declare_permission("basicdata.feedback", "问题反馈", module="basicdata", parent_code="basicdata", route_path="/basicdata/feedback", sort_order=3)
declare_permission("basicdata.feedback.handle", "处理问题反馈", module="basicdata", parent_code="basicdata.feedback", actions=["handle"], sort_order=1)
declare_permission("basicdata.files", "文件管理", module="basicdata", parent_code="basicdata", route_path="/basicdata/files", sort_order=4)
declare_permission("basicdata.data_supply", "数据供给", module="basicdata", parent_code="basicdata", route_path="/basicdata/data-supply", sort_order=10)
declare_permission("basicdata.share_management", "分享管理", module="basicdata", parent_code="basicdata", route_path="/share-management", sort_order=11)
declare_permission("announcements", "公告管理", module="basicdata", parent_code="basicdata", route_path="/announcements", sort_order=5)
declare_permission(
    code="users",
    name="用户管理",
    module="basicdata",
    parent_code="basicdata",
    actions=["create", "read", "update", "delete"],
    route_path="/users",
    sort_order=6,
)
declare_permission("users.reset_password", "重置密码", module="basicdata", parent_code="users", actions=["reset_password"], sort_order=1)
declare_permission("roles", "角色管理", module="basicdata", parent_code="basicdata", route_path="/roles", sort_order=7)
declare_permission("audit", "审计日志", module="basicdata", parent_code="basicdata", actions=["read"], route_path="/audit", sort_order=8)
declare_permission("settings", "同步SQL配置", module="basicdata", parent_code="basicdata", route_path="/sync-config", sort_order=9)
declare_permission("permissions", "权限管理", module="basicdata", parent_code="basicdata", actions=["create", "read", "update", "delete"], route_path="/permissions", sort_order=11)

# 数据回写
declare_permission("writeback", "数据回写", module="basicdata", sort_order=10)
declare_permission("writeback.config", "回写SQL配置", module="basicdata", parent_code="writeback", route_path="/writeback-config", sort_order=1)
declare_permission("writeback.monitor", "回写监控", module="basicdata", parent_code="writeback", route_path="/writeback-monitor", sort_order=2)

# 采购中心
declare_permission("purchase", "采购中心", module="purchase", sort_order=11)
declare_permission("purchase.price_change", "调价单管理", module="purchase", parent_code="purchase", route_path="/purchase/price-change", sort_order=1)
declare_permission("purchase.price_change.pending", "待我审批", module="purchase", parent_code="purchase", route_path="/purchase/price-change/pending", sort_order=2)
declare_permission("purchase.price_change.config", "审批配置", module="purchase", parent_code="purchase", route_path="/purchase/price-change/config", sort_order=3)
declare_permission("purchase.price_change.archive_delete", "调价单归档删除", module="purchase", parent_code="purchase", actions=["delete"], sort_order=4)

# 财务数据
declare_permission("finance", "财务数据", module="finance", sort_order=12)
declare_permission("finance.data", "科目余额", module="finance", parent_code="finance", actions=["read"], route_path="/finance/subject-balances", sort_order=1)

# 品质管理（2026-09-22）— 供应商索赔通知单
declare_permission("quality", "品质管理", module="quality", sort_order=13)
declare_permission("quality.supplier_claim", "供应商索赔单", module="quality", parent_code="quality", route_path="/quality/supplier-claims", sort_order=1)
declare_permission("quality.supplier_claim.archive_delete", "索赔单归档删除", module="quality", parent_code="quality", actions=["delete"], sort_order=2)

# 审批中心（2026-09-22）— 统一待我审批 + 审批链配置（新流程注册 provider 即接入）
declare_permission("approval", "审批中心", module="approval", sort_order=14)
declare_permission("approval.pending", "待我审批", module="approval", parent_code="approval", route_path="/approvals/pending", sort_order=1)
declare_permission("approval.config", "审批配置", module="approval", parent_code="approval", route_path="/approvals/configs", sort_order=2)

# 部署运维（2026-09-04）— 生产环境部署 / 回退 / 切换任意版本为当前
declare_permission(
    "deploy_versions", "部署版本管理",
    module="basicdata", parent_code="basicdata",
    actions=["read", "manage"],
    route_path="/deploy-versions", sort_order=12,
)
