"""产能时间槽模型.

记录某天某车间某工序段的工作时间槽, 支持多订单共享同一天的工时.
例如订单A占8.12全天8.5h + 8.13上午4.36h, 订单B自动塞进8.13下午4.14h.
"""
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, Numeric, String
from sqlalchemy.sql import func

from app.core.database import Base


class CapacitySlot(Base):
    """产能时间槽: 一条记录 = 某天某段的一次占用.

    同一个 (department, schedule_bucket, slot_date) 可以有多条记录,
    每条代表一个订单在该日的占用. 求和得到当日总占用.
    """
    __tablename__ = "production_capacity_slot"

    id = Column(Integer, primary_key=True, autoincrement=True)
    department = Column(String(32), nullable=False, index=True, comment="车间/部门")
    schedule_bucket = Column(String(32), nullable=False, index=True, comment="工序段: lean/assembly/packaging")
    slot_date = Column(DateTime, nullable=False, index=True, comment="槽日期(只用日期部分)")
    hours = Column(Numeric(5, 2), nullable=False, default=0, comment="本次占用小时数")
    plan_id = Column(Integer, nullable=True, index=True, comment="关联的排产计划ID")
    order_no = Column(String(64), nullable=True, comment="订单号(冗余, 便于查询)")
    line_no = Column(String(32), nullable=True, comment="行号(冗余)")
    is_active = Column(Boolean, nullable=False, default=True, comment="是否有效")
    remark = Column(String(100), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_capacity_slot_dept_bucket_date", "department", "schedule_bucket", "slot_date"),
        Index("ix_capacity_slot_plan", "plan_id"),
    )
