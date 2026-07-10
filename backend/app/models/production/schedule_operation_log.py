
"""Production schedule plan operation log."""

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, Index
from sqlalchemy.sql import func

from app.core.database import Base


class ProductionScheduleOperationLog(Base):
    __tablename__ = "production_schedule_operation_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    plan_id = Column(Integer, nullable=True, index=True, comment="关联的排产计划ID")
    plan_version = Column(Integer, nullable=True, comment="排产计划版本号")
    order_no = Column(String(64), nullable=True, index=True, comment="订单号")
    line_no = Column(String(32), nullable=True, index=True, comment="行号")
    operation_type = Column(String(32), nullable=False, index=True, comment="操作类型（create/update/reschedule/batch_reschedule/check_changes）")
    operator = Column(String(64), nullable=False, index=True, comment="操作人")
    operation_at = Column(DateTime, server_default=func.now(), nullable=False, index=True, comment="操作时间")
    remark = Column(Text, nullable=True, comment="操作备注")
    affected_plan_ids = Column(Text, nullable=True, comment="影响的计划ID列表（JSON数组）")
    previous_version_id = Column(Integer, nullable=True, comment="上一版本计划ID")
    is_frozen_break = Column(Boolean, nullable=False, default=False, comment="v2 阶段2：是否破冻操作（提权干预）")

    __table_args__ = (
        Index("ix_prod_schedule_op_plan_id_type", "plan_id", "operation_type"),
        Index("ix_prod_schedule_op_order_type", "order_no", "operation_type"),
    )
