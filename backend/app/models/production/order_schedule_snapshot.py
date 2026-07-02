"""Production-side order scheduling snapshot."""

from sqlalchemy import Boolean, Column, Date, DateTime, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.sql import func

from app.core.database import Base


class ProductionOrderScheduleSnapshot(Base):
    __tablename__ = "production_order_schedule_snapshot"

    id = Column(Integer, primary_key=True, autoincrement=True)
    order_no = Column(String(64), nullable=False, index=True)
    line_no = Column(String(32), nullable=False, index=True)
    sale_order_line_id = Column(Integer, nullable=False, index=True, comment="最近同步的销售订单行ID")
    sale_order_line_updated_at = Column(DateTime, nullable=True, comment="最近同步的销售订单行更新时间")

    customer = Column(String(128), nullable=True)
    risk_level = Column(String(16), nullable=True)
    bom_no = Column(String(64), nullable=True)
    product_code = Column(String(64), nullable=True, index=True)
    product_model = Column(String(128), nullable=True)
    order_qty = Column(Numeric(15, 2), nullable=True)
    promised_date = Column(Date, nullable=True, index=True)

    upph_snapshot = Column(Numeric(15, 2), nullable=True, comment="同步时固化的UPPH")
    schedule_bucket_snapshot = Column(String(32), nullable=True, comment="同步时固化的排产段")
    schedule_bucket_label = Column(String(64), nullable=True)
    scheduling_status = Column(String(32), nullable=True)
    scheduling_status_label = Column(String(32), nullable=True)
    display_status = Column(String(32), nullable=True)
    display_status_label = Column(String(32), nullable=True)
    scheduling_reason_code = Column(String(64), nullable=True)
    scheduling_reason = Column(String(255), nullable=True)
    scheduling_reason_details_json = Column(Text, nullable=True)
    is_missing_upph = Column(Boolean, nullable=False, default=False)

    target_ready_date = Column(Date, nullable=True)
    ready_offset_days = Column(Integer, nullable=False, default=2)
    total_hours = Column(Numeric(15, 2), nullable=True)
    available_production_days = Column(Integer, nullable=True)
    required_daily_hours = Column(Numeric(10, 2), nullable=True)
    recommended_daily_hours = Column(Numeric(10, 2), nullable=True)
    capacity_load_status = Column(String(32), nullable=True)
    capacity_load_status_label = Column(String(32), nullable=True)
    sunday_rest_allowed = Column(Boolean, nullable=True)
    needs_sunday_work = Column(Boolean, nullable=True)
    needs_move_earlier = Column(Boolean, nullable=True)
    move_earlier_days = Column(Integer, nullable=True)
    work_hour_summary = Column(Text, nullable=True)

    snapshot_updated_at = Column(DateTime, server_default=func.now(), nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("order_no", "line_no", name="uq_production_order_schedule_snapshot_line"),
        Index("ix_production_order_snapshot_due_status", "promised_date", "display_status"),
    )
