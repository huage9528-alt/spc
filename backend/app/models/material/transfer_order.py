"""物料齐套中心 — 调拨单模型（同步自 K3 ICStockBill FTranType=41 仓库调拨）"""

from sqlalchemy import Column, Date, DateTime, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.sql import func

from app.core.database import Base


class TransferOrder(Base):
    __tablename__ = "transfer_order"
    __table_args__ = (
        UniqueConstraint("transfer_no", "entry_id", name="uq_transfer_order_no_entry"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    transfer_no = Column(String(64), nullable=False, index=True, comment="调拨单号")
    entry_id = Column(Integer, nullable=False, default=1, comment="明细行号 (FEntryID)")
    material_id = Column(Integer, index=True, comment="物料 id (K3 FItemID)")
    material_code = Column(String(64), index=True)
    material_name = Column(String(256))
    qty = Column(Numeric(15, 2), comment="调拨数量")
    from_wh_code = Column(String(32), comment="调出仓编码")
    to_wh_code = Column(String(32), comment="调入仓编码")
    transfer_date = Column(Date, index=True, comment="调拨日期")
    expected_arrival_date = Column(Date, comment="预计到货日期")
    status = Column(String(16), comment="confirmed/in_transit")
    erp_updated_at = Column(DateTime)
    data_source = Column(String(32), comment="erp/manual/excel")
    is_deleted = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
