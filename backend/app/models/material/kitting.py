"""物料齐套中心 — 对外齐套计算结果模型（AEOS 只读接入，v1 销售订单口径）"""

from sqlalchemy import (
    JSON,
    Column,
    Date,
    DateTime,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.sql import func

from app.core.database import Base


class KittingRun(Base):
    """齐套计算批次（一次全量重算 = 一个 allocation_run_id）"""

    __tablename__ = "kitting_run"

    id = Column(Integer, primary_key=True, autoincrement=True)
    allocation_run_id = Column(String(64), nullable=False, unique=True, index=True)
    calculation_version = Column(String(16), nullable=False, default="1.0.0")
    trigger_type = Column(String(16), nullable=False, default="manual", comment="sync_hook/manual")
    triggered_by = Column(Integer, nullable=True, comment="手动触发用户 id")
    status = Column(String(16), nullable=False, default="running", comment="running/success/failed/skipped")
    data_as_of = Column(DateTime, nullable=True, comment="各源最近成功同步时间的最小值")
    source_as_of = Column(JSON, nullable=True, comment="分源同步时间 {sync_type: iso}")
    demand_count = Column(Integer, nullable=False, default=0)
    full_count = Column(Integer, nullable=False, default=0)
    partial_count = Column(Integer, nullable=False, default=0)
    shortage_count = Column(Integer, nullable=False, default=0)
    pending_count = Column(Integer, nullable=False, default=0)
    blocked_count = Column(Integer, nullable=False, default=0)
    started_at = Column(DateTime, nullable=False, server_default=func.now())
    finished_at = Column(DateTime, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    error_message = Column(Text, nullable=True)


class KittingResult(Base):
    """齐套结果（需求对象粒度，v1 = 销售订单行）"""

    __tablename__ = "kitting_result"
    __table_args__ = (
        UniqueConstraint("demand_no", "demand_line_no", name="uq_kitting_result_demand"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    demand_type = Column(String(32), nullable=False, default="SALES_ORDER", index=True)
    demand_no = Column(String(64), nullable=False, index=True)
    demand_line_no = Column(String(32), nullable=False, default="")
    customer_code = Column(String(64))
    product_code = Column(String(64), index=True)
    required_date = Column(Date)
    kit_status = Column(String(16), nullable=False, index=True, comment="FULL/PARTIAL/SHORTAGE/BLOCKED/PENDING")
    kit_rate_by_item = Column(Numeric(6, 2))
    kit_rate_by_qty = Column(Numeric(6, 2))
    estimated_kit_date = Column(Date)
    shortage_item_count = Column(Integer, nullable=False, default=0)
    shortage_amount = Column(Numeric(18, 2))
    affected_order_amount = Column(Numeric(18, 2))
    risk_level = Column(String(16), comment="green/yellow/red")
    key_material_shortage = Column(Integer, nullable=False, default=0)
    bom_id = Column(String(64))
    bom_version = Column(String(32))
    allocation_run_id = Column(String(64), nullable=False, index=True)
    calculation_version = Column(String(16), nullable=False, default="1.0.0")
    calculated_at = Column(DateTime, nullable=False)
    data_as_of = Column(DateTime, nullable=True)
    is_deleted = Column(Integer, nullable=False, default=0, server_default="0", index=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now(), index=True)


class KittingShortage(Base):
    """缺料明细（需求对象 × 物料）"""

    __tablename__ = "kitting_shortage"
    __table_args__ = (
        UniqueConstraint(
            "demand_no", "demand_line_no", "material_code", name="uq_kitting_shortage_demand_material"
        ),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    demand_type = Column(String(32), nullable=False, default="SALES_ORDER", index=True)
    demand_no = Column(String(64), nullable=False, index=True)
    demand_line_no = Column(String(32), nullable=False, default="")
    material_code = Column(String(64), nullable=False, index=True)
    material_name = Column(String(256))
    required_qty = Column(Numeric(18, 4), nullable=False, default=0)
    available_qty = Column(Numeric(18, 4), nullable=False, default=0)
    future_supply_qty = Column(Numeric(18, 4), nullable=False, default=0)
    shortage_qty = Column(Numeric(18, 4), nullable=False, default=0)
    required_date = Column(Date)
    estimated_available_date = Column(Date, nullable=True)
    shortage_days = Column(Integer, nullable=True)
    shortage_reason = Column(String(32), comment="NO_STOCK/INSUFFICIENT_STOCK/NO_SUPPLY/SUPPLY_LATE")
    supply_source = Column(String(128))
    supplier_code = Column(String(64))
    supplier_name = Column(String(256))
    is_key_material = Column(Integer, nullable=False, default=0)
    owner_department = Column(String(64))
    owner = Column(String(64))
    alert_status = Column(String(16), nullable=False, default="OPEN")
    allocation_run_id = Column(String(64), nullable=False, index=True)
    is_deleted = Column(Integer, nullable=False, default=0, server_default="0", index=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now(), index=True)
