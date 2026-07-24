"""Production schedule plan ledger."""

from sqlalchemy import Boolean, Column, Date, DateTime, Integer, Numeric, String, Text, Index
from sqlalchemy.sql import func

from app.core.database import Base


class ProductionSchedulePlan(Base):
    __tablename__ = "production_schedule_plan"

    id = Column(Integer, primary_key=True, autoincrement=True)
    department = Column(String(32), nullable=False, index=True)
    plan_date = Column(Date, nullable=False, index=True)
    order_no = Column(String(64), nullable=True, index=True)
    line_no = Column(String(32), nullable=True, index=True)
    product_code = Column(String(64), nullable=True, index=True)
    model_code = Column(String(128), nullable=True)
    quantity = Column(Numeric(15, 2), nullable=True)
    owner = Column(String(64), nullable=True)
    start_date = Column(Date, nullable=True)
    end_date = Column(Date, nullable=True)
    priority = Column(String(32), nullable=False, default="normal")
    status = Column(String(32), nullable=False, default="planned", index=True)
    upph = Column(Numeric(15, 2), nullable=True, default=0, comment="排产时使用的UPPH")
    manpower = Column(Integer, nullable=True, comment="排产时班组人数(每人每小时的产能 × 人数 × 工时 = 日产能)")
    daily_work_hours = Column(Numeric(5, 2), nullable=True, default=8, comment="每日工作小时数")
    plan_version = Column(Integer, nullable=False, default=1, comment="排产版本号")
    is_active = Column(Boolean, nullable=False, default=True, index=True, comment="当前生效版本")
    source_promised_date = Column(Date, nullable=True, comment="排产时承诺交期快照")
    source_order_qty = Column(Numeric(15, 2), nullable=True, comment="排产时订单数量快照")
    planned_qty = Column(Numeric(15, 2), nullable=True, comment="v2 Q8：本段计划负责的数量（用于拆分对账，默认=source_order_qty）")
    source_product_code = Column(String(64), nullable=True, comment="排产时产品编码快照")
    source_product_model = Column(String(128), nullable=True, comment="排产时产品型号快照")
    source_upph = Column(Numeric(15, 2), nullable=True, comment="排产时UPPH快照")
    source_process_type = Column(String(32), nullable=True, comment="排产所使用的工序类型")
    needs_reschedule = Column(Boolean, nullable=False, default=False, index=True, comment="是否需要重排")
    reschedule_reason = Column(String(100), nullable=True, comment="重排原因")
    previous_plan_id = Column(Integer, nullable=True, comment="上一版本计划ID")
    sync_batch_no = Column(String(50), nullable=True, comment="最近一次同步批次号")
    locked_by = Column(String(64), nullable=True, comment="锁定人")
    locked_at = Column(DateTime, nullable=True, comment="锁定时间")
    frozen_locked_by = Column(String(64), nullable=True, comment="冷冻锁定人（v2 阶段2：业务锁定 vs 冷冻锁定分离）")
    frozen_locked_at = Column(DateTime, nullable=True, comment="冷冻锁定时间")
    confirmed_by = Column(String(64), nullable=True, comment="确认人")
    confirmed_at = Column(DateTime, nullable=True, comment="确认时间")
    remark = Column(Text, nullable=True)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_production_schedule_dept_date", "department", "plan_date"),
        Index("ix_production_schedule_order_product", "order_no", "product_code"),
        Index("ix_production_schedule_active_line", "order_no", "line_no", "product_code", "is_active"),
        Index("ix_production_schedule_active_product_date", "is_active", "product_code", "plan_date"),
    )
