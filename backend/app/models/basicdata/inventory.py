"""基础数据与集成中心 — 即时库存模型"""

from sqlalchemy import Column, BigInteger, String, Integer, Numeric, DateTime, UniqueConstraint
from sqlalchemy.sql import func

from app.core.database import Base


class Inventory(Base):
    __tablename__ = "scm_inventory"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    material_id = Column(Integer, nullable=False, comment="物料ID(外部系统)")
    material_code = Column(String(50), nullable=True, comment="物料编码")
    material_name = Column(String(200), nullable=True, comment="物料名称")
    wh_id = Column(Integer, nullable=False, comment="仓库ID(外部系统)")
    wh_code = Column(String(20), nullable=True, comment="仓库编码")
    wh_name = Column(String(50), nullable=True, comment="仓库名称")
    location_id = Column(Integer, nullable=True, comment="库位ID(外部系统)")
    location_name = Column(String(100), nullable=True, comment="库位名称")
    qty_on_hand = Column(Numeric(15, 2), nullable=False, default=0, comment="库存量")
    locked_qty = Column(Numeric(15, 2), nullable=False, default=0, comment="锁定数量")
    balance_qty = Column(Numeric(15, 2), nullable=False, default=0, comment="结存数量")
    qty_in_transit = Column(Numeric(15, 2), nullable=False, default=0, comment="在途库存")
    unit_price = Column(Numeric(15, 6), nullable=False, default=0, comment="库存单价")
    ending_balance = Column(Numeric(15, 2), nullable=False, default=0, comment="期末余额")
    batch_no = Column(String(50), nullable=True, comment="批次号")
    last_inbound_at = Column(DateTime, nullable=True, comment="最后入库时间(ERP)")
    last_outbound_at = Column(DateTime, nullable=True, comment="最后出库时间(ERP)")
    last_picking_at = Column(DateTime, nullable=True, comment="最后领料时间(ERP)")
    data_source = Column(String(32))
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint('material_id', 'wh_id', 'location_id', name='uq_inventory_material_wh_location'),
    )