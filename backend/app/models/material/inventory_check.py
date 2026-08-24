"""物料齐套中心 — 物料盘点单模型（盘点单头 + 物料行）"""

from sqlalchemy import (
    Column, BigInteger, Integer, String, Numeric, DateTime, Date, Text,
    UniqueConstraint, Index, ForeignKey,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func

from app.core.database import Base


class StockCheck(Base):
    __tablename__ = "scm_inventory_check"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    check_no = Column(String(32), nullable=False, unique=True, comment="盘点单号 PDyyyyMMdd-NNN")
    order_no = Column(String(64), nullable=True, index=True, comment="触发起源订单号(manual 类型可空)")
    title = Column(String(200), nullable=True, comment="盘点单标题")
    check_type = Column(String(16), nullable=False, default="order", comment="order/manual/cycle_count")
    status = Column(String(16), nullable=False, default="open", comment="open/in_progress/completed/cancelled")
    check_date = Column(Date, nullable=False, comment="盘点日期")
    total_materials = Column(Integer, nullable=False, default=0, comment="应盘物料数")
    checked_materials = Column(Integer, nullable=False, default=0, comment="已盘物料数")
    total_diff_qty = Column(Numeric(18, 4), nullable=False, default=0, comment="总差异数")
    created_by = Column(String(100), nullable=True)
    checked_by = Column(String(100), nullable=True, comment="完工人")
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    completed_at = Column(DateTime, nullable=True)
    remark = Column(Text, nullable=True)
    covered_products = Column(JSONB, nullable=True, comment="本次盘点覆盖的产品行 [{product_code,bom_no,line_no,product_name,order_qty}]")
    co_checker_user_ids = Column(JSONB, nullable=True, comment="共同盘点人 sys_user.id 列表")
    created_by_user_id = Column(BigInteger, nullable=True, comment="创建人 sys_user.id（用于修改权限判定）")
    version = Column(Integer, nullable=False, default=0, comment="乐观锁版本号,每次更新+1")
    source = Column(String(16), nullable=False, default="manual", server_default="manual", comment="数据来源 manual/k3")
    erp_bill_no = Column(String(64), nullable=True, comment="K3 盘盈盘亏单号(YADJ/KADJ),幂等键")
    erp_inter_id = Column(BigInteger, nullable=True, comment="K3 ICStockBill.FInterID")

    __table_args__ = (
        Index("ix_scm_inventory_check_order_date", "order_no", "check_date"),
    )


class StockCheckItem(Base):
    __tablename__ = "scm_inventory_check_item"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    check_id = Column(BigInteger, ForeignKey("scm_inventory_check.id", ondelete="CASCADE"), nullable=False, index=True)
    line_no = Column(String(32), nullable=True, comment="关联 SaleOrderLine 行号(跨行聚合行时为空)")
    level = Column(Integer, nullable=True, comment="BOM 层级(1=最外层)；手动盘点为空")
    material_id = Column(BigInteger, nullable=True, index=True, comment="物料ID")
    material_code = Column(String(50), nullable=True)
    material_name = Column(String(200), nullable=True)
    spec_model = Column(String(200), nullable=True)
    unit = Column(String(20), nullable=True)
    req_qty = Column(Numeric(18, 4), nullable=False, default=0, comment="应盘数(BOM standard_qty × order_qty)")
    system_qty = Column(Numeric(18, 4), nullable=False, default=0, comment="库存数(快照)")
    system_qty_time = Column(DateTime, nullable=True, comment="快照库存对应的 scm_inventory.updated_at(建单时捕获)")
    actual_qty = Column(Numeric(18, 4), nullable=True, comment="盘点数(用户录入)")
    diff_qty = Column(Numeric(18, 4), nullable=False, default=0, comment="差异数=actual-system")
    is_checked = Column(Integer, nullable=False, default=0, comment="盘点标记 0否1是")
    checked_at = Column(DateTime, nullable=True)
    checked_by = Column(String(100), nullable=True)
    counted_by_user_id = Column(BigInteger, nullable=True, comment="最后录入实盘数量的用户ID")
    counted_by = Column(String(100), nullable=True, comment="最后录入实盘数量的用户名称快照")
    counted_at = Column(DateTime, nullable=True, comment="最后录入实盘数量的时间")
    wh_id = Column(Integer, nullable=True, comment="仓库ID(快照);NULL=历史老盘点单或(未入库)")
    wh_name = Column(String(50), nullable=True, comment="仓库名称(建单时快照)")
    wh_code = Column(String(20), nullable=True, comment="仓库编码(建单时快照)")
    recent_checked_check_no = Column(String(32), nullable=True, comment="近期已盘来源盘点单号(快照);NULL=普通行")
    recent_checked_date = Column(Date, nullable=True, comment="近期已盘来源盘点日期(快照)")
    remark = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    version = Column(Integer, nullable=False, default=0, comment="乐观锁版本号,每次更新+1")

    __table_args__ = (
        Index("ix_sci_wh", "check_id", "material_id", "wh_id"),
        Index("ix_sci_counted_by_date", "counted_by_user_id", "counted_at"),
    )
