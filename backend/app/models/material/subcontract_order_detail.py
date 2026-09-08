"""物料齐套中心 — 委外订单明细模型（同步自 ERP K3）"""

from sqlalchemy import Column, Integer, String, Numeric, DateTime, UniqueConstraint
from sqlalchemy.sql import func

from app.core.database import Base


class SubcontractOrderDetail(Base):
    __tablename__ = "subcontract_order_detail"
    __table_args__ = (
        UniqueConstraint("erp_order_id", "detail_id", name="uq_subcontract_order_detail_order_entry"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    erp_order_id = Column(Integer, nullable=False, index=True, comment="委外订单ID (ERP FID)")
    detail_id = Column(Integer, nullable=False, comment="明细标识 (ERP FEntryID)")
    line_no = Column(Integer, nullable=True, comment="行号")
    unit_id = Column(Integer, nullable=True, comment="单位id")
    material_id = Column(Integer, nullable=True, index=True, comment="物料id")
    qty = Column(Numeric(15, 2), nullable=True, comment="数量")
    delivery_qty = Column(Numeric(15, 2), nullable=True, comment="交货数量")
    received_qty = Column(Numeric(15, 2), nullable=True, comment="收货数量")
    returned_qty = Column(Numeric(15, 2), nullable=True, comment="退货数量")
    price = Column(Numeric(15, 4), nullable=True, comment="单价")
    amount = Column(Numeric(15, 2), nullable=True, comment="金额")
    mrp_closed_flag = Column(Integer, nullable=True, comment="MRP关闭标志 0/1")
    sale_order_line_no = Column(Integer, nullable=True, comment="销售订单行号")
    sale_order_id = Column(Integer, nullable=True, index=True, comment="销售订单id")
    sale_order_no = Column(String(64), nullable=True, index=True, comment="销售订单编号")
    data_source = Column(String(32), nullable=True, comment="数据来源")
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
