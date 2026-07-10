"""调价单模块 - 数据模型"""

from sqlalchemy import Column, Integer, String, Numeric, Date, Text, Boolean, DateTime, ForeignKey, JSON
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship

from app.core.database import Base


class PurchasePriceChange(Base):
    __tablename__ = "purchase_price_change"

    id = Column(Integer, primary_key=True, autoincrement=True)
    change_no = Column(String(32), unique=True, nullable=False)
    title = Column(String(256))
    change_type = Column(String(32), default="price_change")
    price_direction = Column(String(16))

    supplier_code = Column(String(64))
    supplier_name = Column(String(128))
    phone = Column(String(32))
    fax = Column(String(32))
    contact_person = Column(String(64))
    address = Column(String(256))

    customer = Column(String(128))
    customer_phone = Column(String(32))
    customer_fax = Column(String(32))
    purchase_contact = Column(String(64))

    tax_rate = Column(String(16))
    payment_method = Column(String(64))
    settlement_method = Column(String(64))

    change_date = Column(Date)

    attachments = Column(JSON, default=list)

    remark = Column(Text)
    signature_opinion = Column(Text)

    approval_status = Column(String(16), default="draft")
    approval_level = Column(Integer, default=1)
    approved_by = Column(String(64))
    approved_at = Column(DateTime)
    submitted_at = Column(DateTime)
    approval_snapshot = Column(JSON)
    version = Column(Integer, default=1)

    applicant = Column(String(64))
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    items = relationship("PurchasePriceChangeItem", back_populates="change", cascade="all, delete-orphan")
    approval_logs = relationship("PurchasePriceChangeApprovalLog", back_populates="change", cascade="all, delete-orphan")


class PurchasePriceChangeItem(Base):
    __tablename__ = "purchase_price_change_item"

    id = Column(Integer, primary_key=True, autoincrement=True)
    change_id = Column(Integer, ForeignKey("purchase_price_change.id", ondelete="CASCADE"), nullable=False)
    seq = Column(Integer)

    material_code = Column(String(64))
    material_name = Column(String(256))
    spec = Column(String(256))
    unit = Column(String(16))

    order_qty = Column(Numeric(15, 4))
    delivery_qty = Column(Numeric(15, 4))

    old_price = Column(Numeric(15, 4))
    old_price_date = Column(String(16))
    new_price = Column(Numeric(15, 4))
    price_change_pct = Column(Numeric(5, 2))

    remark = Column(String(256))

    change = relationship("PurchasePriceChange", back_populates="items")


class PurchasePriceChangeApprovalLog(Base):
    __tablename__ = "purchase_price_change_approval_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    change_id = Column(Integer, ForeignKey("purchase_price_change.id", ondelete="CASCADE"), nullable=False)
    approval_level = Column(Integer)
    approver = Column(String(64))
    action = Column(String(16))
    comment = Column(Text)
    operated_at = Column(DateTime, server_default=func.now())

    change = relationship("PurchasePriceChange", back_populates="approval_logs")


class PurchasePriceChangeAiAnalysis(Base):
    __tablename__ = "purchase_price_change_ai_analysis"

    id = Column(Integer, primary_key=True, autoincrement=True)
    change_id = Column(Integer, ForeignKey("purchase_price_change.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(Integer, ForeignKey("purchase_price_change_item.id"))

    history_trend = Column(JSON)
    market_source = Column(String(64))
    market_price = Column(Numeric(15, 4))
    market_range = Column(String(32))
    market_fetched_at = Column(DateTime)

    ai_conclusion = Column(Text)
    ai_risk_level = Column(String(16))
    ai_detail = Column(Text)
    ai_model = Column(String(64))
    ai_status = Column(String(16), default="pending")
    ai_error_msg = Column(Text)

    search_keywords = Column(Text)
    ai_analyzed_at = Column(DateTime)
    created_at = Column(DateTime, server_default=func.now())


class ApprovalConfig(Base):
    __tablename__ = "approval_config"

    id = Column(Integer, primary_key=True, autoincrement=True)
    biz_type = Column(String(64), unique=True, nullable=False)
    biz_name = Column(String(128))
    nodes = Column(JSON, nullable=False, default=list)
    is_active = Column(Boolean, default=True)
    updated_by = Column(String(64))
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
