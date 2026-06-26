from sqlalchemy import Boolean, Column, DateTime, Integer, Numeric, String, Index, Text
from sqlalchemy.sql import func

from app.core.database import Base

class ProductProcessCapacity(Base):
    __tablename__ = "product_process_capacity"

    id = Column(Integer, primary_key=True, autoincrement=True)
    oa_detail_id = Column(String(64), nullable=True, index=True, comment="OA明细ID")
    bom_code = Column(String(64), nullable=True, index=True, comment="BOM编码")
    product_code = Column(String(64), nullable=False, index=True, comment="产品编码")
    product_name = Column(String(256), nullable=True, comment="产品名称")
    process_type = Column(String(32), nullable=False, comment="工序类型(如: 组装, 包装)")
    upph = Column(Numeric(15, 2), nullable=False, default=0, comment="每小时产能")
    source = Column(String(32), nullable=True, default="OA", comment="数据来源")
    sync_batch_no = Column(String(64), nullable=True, index=True, comment="同步批次号")
    last_sync_time = Column(DateTime, nullable=True, comment="上次同步时间")
    is_active = Column(Boolean, nullable=False, default=True, comment="是否有效")
    remark = Column(Text, nullable=True, comment="备注/区分信息(来自OA的bz/bzcn)")

    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_product_process_capacity_product_process", "product_code", "process_type", unique=False),
        Index("ix_product_process_capacity_bom_process", "bom_code", "process_type", unique=False),
    )
