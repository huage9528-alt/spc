"""生产协同中心 — 报工记录表（针对排产计划，报工→虚拟仓→自动日报）"""
from sqlalchemy import Column, Integer, String, Numeric, Date, DateTime, Index, Text, Boolean, text
from sqlalchemy.sql import func

from app.core.database import Base


class ProductionReport(Base):
    """报工记录：针对某个排产计划记录当日实际完工数量，并选择入库仓（线边仓/成品仓）。
    工价在报工时快照，保证记录不可变、可对账。"""

    __tablename__ = "production_report"

    id = Column(Integer, primary_key=True, autoincrement=True)
    schedule_plan_id = Column(Integer, nullable=False, index=True, comment="排产计划ID")
    report_date = Column(Date, nullable=False, index=True, comment="报工日期")
    department = Column(String(32), nullable=True, comment="车间(冗余)")
    order_no = Column(String(64), nullable=True, comment="订单号(冗余)")
    line_no = Column(String(32), nullable=True, comment="订单行(冗余)")
    product_code = Column(String(64), nullable=True, comment="产品编码(冗余)")
    bom_code = Column(String(64), nullable=True, comment="BOM编码(冗余)")
    process_type = Column(String(32), nullable=True, comment="工序类型(冗余)")
    report_qty = Column(Numeric(15, 2), nullable=False, comment="报工数量(完工量)")
    warehouse_id = Column(Integer, nullable=True, comment="入库仓ID(线边仓/成品仓)")
    warehouse_name = Column(String(64), nullable=True, comment="入库仓名称(冗余)")
    work_hours = Column(Numeric(10, 2), nullable=True, comment="工时")
    unit_price = Column(Numeric(12, 2), nullable=True, comment="工价快照")
    amount = Column(Numeric(12, 2), nullable=True, comment="金额=单价×数量")
    planned_qty = Column(Numeric(15, 2), nullable=True, comment="排产量(冗余,用于超额标记)")
    is_overflow = Column(Boolean, nullable=False, default=False, comment="是否超额(报工量>排产量)")
    reporter = Column(String(64), nullable=True, comment="报工人")
    team = Column(String(64), nullable=True, comment="班组")
    remark = Column(Text, nullable=True, comment="备注")
    reported_at = Column(DateTime, nullable=True, comment="报工时间")
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_production_report_schedule_date", "schedule_plan_id", "report_date"),
        Index("ix_production_report_order_date", "order_no", "report_date"),
        Index("ix_production_report_warehouse", "warehouse_id"),
    )
