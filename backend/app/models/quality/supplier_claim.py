"""品质管理 - 供应商索赔通知单数据模型"""

from sqlalchemy import Column, Integer, String, Numeric, Date, Text, DateTime, ForeignKey, JSON
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship

from app.core.database import Base


class SupplierClaim(Base):
    __tablename__ = "supplier_claim"

    id = Column(Integer, primary_key=True, autoincrement=True)
    claim_no = Column(String(32), unique=True, nullable=False)

    supplier_id = Column(Integer)
    supplier_code = Column(String(64))
    supplier_name = Column(String(128))

    claim_reason = Column(String(32))          # field_customer_claim | supply_performance
    claim_items = Column(JSON, default=list)   # 勾选细项数组
    claim_amount = Column(Numeric(14, 2))
    claim_method = Column(Text)                # 索赔方式说明
    calc_explanation = Column(Text)            # 金额计算说明
    return_requirement = Column(String(32))    # no_return | return_supplier_fee
    claim_date = Column(Date)
    remarks = Column(Text)
    attachments = Column(JSON, default=list)

    # 审批字段（公共审批引擎约定列）
    approval_status = Column(String(16), default="draft")
    approval_level = Column(Integer, default=1)
    approval_snapshot = Column(JSON)
    approved_by = Column(String(64))
    approved_at = Column(DateTime)
    submitted_at = Column(DateTime)
    version = Column(Integer, default=1)

    applicant = Column(String(64))
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    approval_logs = relationship("SupplierClaimApprovalLog", back_populates="claim", cascade="all, delete-orphan")


class SupplierClaimApprovalLog(Base):
    __tablename__ = "supplier_claim_approval_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    claim_id = Column(Integer, ForeignKey("supplier_claim.id", ondelete="CASCADE"), nullable=False)
    approval_level = Column(Integer)
    approver = Column(String(64))
    action = Column(String(16))  # submit/approve/reject/recall/auto_skip/revoked
    comment = Column(Text)
    operated_at = Column(DateTime, server_default=func.now())

    claim = relationship("SupplierClaim", back_populates="approval_logs")
