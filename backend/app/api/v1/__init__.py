from fastapi import APIRouter

from app.api.v1 import assistant, basicdata, common, dashboard, exception, external, masterdata, material, meeting, npi, order, production, purchase, rules, system, writeback

api_router = APIRouter()

# Dashboard
api_router.include_router(dashboard.router, prefix="/dashboard", tags=["供应链驾驶舱"])

# Order delivery center
api_router.include_router(order.order_router, prefix="/orders", tags=["订单交付中心"])
api_router.include_router(order.eta_router, prefix="/orders/eta", tags=["ETA管理"])
api_router.include_router(order.run_order_router, prefix="/run-orders", tags=["跑单管理"])

# Material center
api_router.include_router(material.purchase_plan_router, prefix="/materials/purchase-plan", tags=["物料齐套中心-采购到料计划"])
api_router.include_router(material.purchase_plan_analysis_router, prefix="/materials/purchase-plan/analysis", tags=["物料齐套中心-采购到料计划分析"])
api_router.include_router(material.issues_router, prefix="/materials/issues", tags=["物料齐套中心-问题物料"])
api_router.include_router(material.long_lead_router, prefix="/materials/long-lead", tags=["物料齐套中心-长交期物料"])
api_router.include_router(material.kit_analysis_router, prefix="/materials/kit-analysis", tags=["物料齐套中心-齐套分析"])
api_router.include_router(material.supplier_risk_router, prefix="/materials/supplier-risk", tags=["物料齐套中心-供应商风险"])
api_router.include_router(material.supplier_payment_router, prefix="/materials/supplier-payment", tags=["物料齐套中心-供应商付款排程"])
api_router.include_router(material.supplier_message_router, prefix="/materials/supplier-messages", tags=["物料齐套中心-供应商即时沟通"])
api_router.include_router(material.subcontract_orders_router, prefix="/materials/subcontract-orders", tags=["物料齐套中心-委外订单"])
api_router.include_router(material.po_router, prefix="/materials", tags=["物料齐套中心-ERP采购订单"])
api_router.include_router(material.stock_check_router, prefix="/materials", tags=["物料齐套中心-物料盘点"])
api_router.include_router(material.scrap_inventory_router, prefix="/materials", tags=["物料齐套中心-报废物料库存查询"])

# Production center
api_router.include_router(production.router, prefix="/production", tags=["生产协同中心"])

# Exception and quality center
api_router.include_router(exception.issues_router, prefix="/exceptions", tags=["异常与质量中心"])
api_router.include_router(exception.risk_router, prefix="/exceptions/risk", tags=["风险扫描"])
api_router.include_router(exception.pool_router, prefix="/exceptions/pool", tags=["异常总池"])
api_router.include_router(exception.issue_log_router, prefix="/exceptions/issue-log", tags=["问题日志"])
api_router.include_router(exception.change_log_router, prefix="/exceptions/change-log", tags=["变更日志"])
api_router.include_router(exception.quality_router, prefix="/exceptions/quality", tags=["品质异常"])
api_router.include_router(exception.product_samples_router, prefix="/exceptions/product-samples", tags=["产品封样"])

# Meeting and NPI centers
api_router.include_router(meeting.router, prefix="/meetings", tags=["会议与任务中心"])
api_router.include_router(npi.router, prefix="/npi", tags=["新品/NPI项目中心"])

# Rules center
api_router.include_router(rules.rules_router, prefix="/rules", tags=["规则配置中心"])
api_router.include_router(rules.inspections_router, prefix="/rules/inspections", tags=["点检规则配置"])
api_router.include_router(rules.node_standards_router, prefix="/rules/node-standards", tags=["节点标准配置"])
api_router.include_router(rules.responsibilities_router, prefix="/rules/responsibilities", tags=["责任归属配置"])
api_router.include_router(rules.status_dict_router, prefix="/rules/status-dict", tags=["状态字典配置"])
api_router.include_router(rules.order_standards_router, prefix="/rules/order-standards", tags=["订单标准"])
api_router.include_router(rules.work_instructions_router, prefix="/rules/work-instructions", tags=["作业指导书"])

# Basic data and integration center
api_router.include_router(basicdata.auth_router, prefix="/basicdata/auth", tags=["认证"])
api_router.include_router(basicdata.users_router, prefix="/basicdata/users", tags=["用户管理"])
api_router.include_router(basicdata.audit_router, prefix="/basicdata/audit", tags=["审计日志"])
api_router.include_router(basicdata.import_export_router, prefix="/basicdata/import-export", tags=["导入导出"])
api_router.include_router(basicdata.sync_router, prefix="/basicdata/sync", tags=["ERP同步"])
api_router.include_router(basicdata.basicdata_router, prefix="/basicdata", tags=["基础数据管理"])
api_router.include_router(basicdata.subject_balance_router, prefix="/basicdata/subject-balances", tags=["科目余额"])
api_router.include_router(basicdata.sync_sql_router, prefix="/basicdata/sync-sql", tags=["同步SQL配置"])
api_router.include_router(basicdata.feedback_router, prefix="/basicdata/feedback", tags=["问题反馈"])
api_router.include_router(basicdata.announcements_router, prefix="/basicdata/announcements", tags=["公告管理"])
api_router.include_router(basicdata.notifications_router, prefix="/notifications", tags=["通知中心"])
api_router.include_router(basicdata.share_router, prefix="/share", tags=["页面分享"])
api_router.include_router(basicdata.wecom_public_router, prefix="/wecom", tags=["企业微信"])
api_router.include_router(basicdata.wecom_share_router, prefix="/share", tags=["页面分享"])

# 权限定义
api_router.include_router(basicdata.permissions_router, prefix="/permissions", tags=["权限定义"])

# 部署版本管理（部署运维 · 部署版本）
api_router.include_router(system.deploy_versions_router, prefix="/system/deploy", tags=["部署运维·部署版本"])

# 数据供给
api_router.include_router(basicdata.data_supply_router, prefix="/basicdata/data-supply", tags=["数据供给"])

# 对外接口（外部系统集成，需 API Key 签名认证）
# 真路由直挂主应用；include_in_schema=False 使内部 /docs 不再混入对外接口
api_router.include_router(external.external_router, prefix="/external", tags=["对外接口"], include_in_schema=False)
# 对外专属 OpenAPI 文档（公开，无需签名）
api_router.include_router(external.docs_router, prefix="/external", include_in_schema=False)

# Common files and assistant
api_router.include_router(common.files_router, prefix="/files", tags=["文件"])
api_router.include_router(common.health.router, prefix="/common", tags=["common"])
api_router.include_router(assistant.assistant_router, prefix="/assistant", tags=["智能助手"])

# Purchase center
api_router.include_router(purchase.price_change_router, prefix="/purchase/price-change", tags=["采购中心-调价单"])

# Writeback center
api_router.include_router(writeback.router, tags=["数据回写"])
