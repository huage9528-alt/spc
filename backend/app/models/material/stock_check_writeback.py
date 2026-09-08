"""物料齐套中心 — 盘点完结 K3 回写记录模型

设计文档: docs/superpowers/specs/2026-09-01-stockcheck-k3-writeback-design.md
每行 = 一张待生成/已生成/失败的 K3 单据(按 盘点单×类型×仓库 分组,唯一约束幂等)。
"""

from sqlalchemy import (
    Column, BigInteger, Integer, String, Numeric, DateTime, Text,
    UniqueConstraint, Index, ForeignKey,
)
from sqlalchemy.sql import func

from app.core.database import Base


class StockCheckK3Writeback(Base):
    __tablename__ = "scm_stock_check_k3_writeback"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    check_id = Column(BigInteger, ForeignKey("scm_inventory_check.id", ondelete="CASCADE"), nullable=False, index=True)
    bill_type = Column(String(16), nullable=False, comment="gain=盘盈入库单(40)/loss_transfer=盘亏调拨单(41)")
    wh_id = Column(Integer, nullable=False, comment="仓库ID快照(调拨单为调出仓)")
    wh_code = Column(String(20), nullable=True, comment="仓库编码快照")
    wh_name = Column(String(50), nullable=True, comment="仓库名称快照")
    status = Column(String(16), nullable=False, default="pending", server_default="pending", comment="pending/success/failed")
    erp_bill_no = Column(String(64), nullable=True, comment="已生成的 K3 单号")
    k3_inter_id = Column(BigInteger, nullable=True, comment="K3 ICStockBill.FInterID")
    item_count = Column(Integer, nullable=False, default=0, comment="明细行数")
    total_qty = Column(Numeric(18, 4), nullable=False, default=0, comment="数量合计(绝对值)")
    error_msg = Column(Text, nullable=True, comment="失败原因")
    retry_count = Column(Integer, nullable=False, default=0, comment="重试次数")
    created_by = Column(String(100), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    written_at = Column(DateTime, nullable=True, comment="K3 写入成功时间")

    __table_args__ = (
        UniqueConstraint("check_id", "bill_type", "wh_id", name="uq_sckw_check_type_wh"),
        Index("ix_sckw_status", "status"),
    )
