# 订单交付中心
from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.models.order.eta_update import ETAUpdate

# 物料齐套中心
from app.models.material.material_demand import MaterialDemand
from app.models.material.purchase_order import PurchaseOrder
from app.models.material.binding import OrderMaterialPoBinding
from app.models.material.receipt_batch import ReceiptBatch
from app.models.material.material_issue import MaterialIssue
from app.models.material.long_lead_material import LongLeadMaterial
from app.models.material.purchase_invoice import PurchaseInvoice
from app.models.material.payment_apply import PaymentApply
from app.models.material.subcontract_order import SubcontractOrder
from app.models.material.subcontract_order_detail import SubcontractOrderDetail
from app.models.material.supplier_message import SupplierMessage
from app.models.material.kitting import KittingResult, KittingRun, KittingShortage  # noqa: F401
from app.models.material.transfer_order import TransferOrder  # noqa: F401

# 生产协同中心
from app.models.production.process_progress import ProcessProgress
from app.models.production.process_exception import ProcessException
from app.models.production.schedule_plan import ProductionSchedulePlan
from app.models.production.base_condition import ProductionBaseCondition  # noqa: F401
from app.models.production.production_daily_report import ProductionDailyReport  # noqa: F401
from app.models.production.labor_price_audit import ProductionLaborPriceAudit  # noqa: F401
from app.models.production.workshop_daily_report import (  # noqa: F401
    WorkshopDailyReport,
    WorkshopDailyReportLeave,
    WorkshopDailyReportWork,
    WorkshopDailyReportTask,
)
from app.models.production.production_report import ProductionReport  # noqa: F401

# 异常与质量中心
from app.models.exception.risk_issue import RiskIssue
from app.models.exception.quality_issue import QualityIssue

from app.models.common.business_document import BusinessDocument, BusinessDocumentVersion

# 规则配置中心
from app.models.rules.risk_rule import RiskRule
from app.models.rules.node_standard import NodeStandard

# 品质管理
from app.models.quality.supplier_claim import SupplierClaim, SupplierClaimApprovalLog  # noqa: F401

# 基础数据与集成中心
from app.models.basicdata.user import SysUser, SysRole
from app.models.basicdata.user_org_scope import UserOrgScope  # noqa: F401
from app.models.basicdata.audit_log import AuditLog
from app.models.basicdata.sync_sql_config import SyncSqlConfig  # noqa: F401
from app.models.basicdata.sync_log import SyncLog  # noqa: F401
from app.models.basicdata.position import Position  # noqa: F401
from app.models.basicdata.file_asset import FileAsset  # noqa: F401
from app.models.basicdata.feedback import Feedback  # noqa: F401
from app.models.basicdata.permission import SysPermission  # noqa: F401
from app.models.basicdata.announcement import Announcement, Notification  # noqa: F401
from app.models.basicdata.data_supply import DataSupplyApiKey, DataSupplyCallLog  # noqa: F401
from app.models.basicdata.share_link import ShareLink  # noqa: F401
from app.models.basicdata.share_link_recipient import ShareLinkRecipient  # noqa: F401

__all__ = [
    # 订单交付中心
    "SaleOrder",
    "SaleOrderLine",
    # 物料齐套中心
    "MaterialDemand",
    "PurchaseOrder",
    "OrderMaterialPoBinding",
    "ReceiptBatch",
    "ETAUpdate",
    "MaterialIssue",
    "LongLeadMaterial",
    "PurchaseInvoice",
    "PaymentApply",
    "SubcontractOrder",
    "SubcontractOrderDetail",
    "SupplierMessage",
    # 生产协同中心
    "ProcessProgress",
    "ProcessException",
    "ProductionSchedulePlan",
    # 异常与质量中心
    "RiskIssue",
    "QualityIssue",
    "BusinessDocument",
    "BusinessDocumentVersion",
    # 规则配置中心
    "RiskRule",
    "NodeStandard",
    # 基础数据与集成中心
    "SysUser",
    "SysRole",
    "AuditLog",
    "SyncSqlConfig",
    "SyncLog",
    "Position",
    "FileAsset",
    "Feedback",
    "Announcement",
    "Notification",
    "SysPermission",
    "DataSupplyApiKey",
    "DataSupplyCallLog",
    "ShareLink",
    "ShareLinkRecipient",
    # 品质管理
    "SupplierClaim",
    "SupplierClaimApprovalLog",
]
