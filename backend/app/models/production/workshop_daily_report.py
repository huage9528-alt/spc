"""生产协同中心 — 车间日报表单据（泛微OA样式，手工填报，主表+3张子表）"""
from sqlalchemy import Column, Integer, String, Numeric, Date, DateTime, Index, ForeignKey, Text, text
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship

from app.core.database import Base


class WorkshopDailyReport(Base):
    """车间日报表 — 主表（表头信息）"""

    __tablename__ = "workshop_daily_report"

    id = Column(Integer, primary_key=True, autoincrement=True)
    report_no = Column(String(64), nullable=False, comment="流程编号/单据编号(自动生成)")
    title = Column(String(255), nullable=True, comment="标题(自动生成)")
    report_type = Column(String(32), nullable=True, server_default="计件", default="计件", comment="报表类型(计件/计时)")
    department = Column(String(128), nullable=True, comment="部门")
    group_name = Column(String(128), nullable=True, comment="组别")
    workshop = Column(String(128), nullable=True, comment="车间")
    report_date = Column(Date, nullable=True, comment="填报日期")
    plan_qty = Column(Numeric(15, 2), nullable=True, comment="计划数量")
    work_hours = Column(Numeric(10, 2), nullable=True, comment="当日工时")
    leader = Column(String(64), nullable=True, comment="组长")
    repairer = Column(String(64), nullable=True, comment="维修员")
    material_handler = Column(String(64), nullable=True, comment="物料员")
    completed_qty = Column(Numeric(15, 2), nullable=True, comment="实际完成数")
    temp_personnel = Column(String(255), nullable=True, comment="临时工人员(姓名文本)")
    temp_people_count = Column(Integer, nullable=True, default=0, comment="临时工人数")
    temp_count = Column(Integer, nullable=True, default=0, comment="临时工人员(兼容旧字段)")
    temp_amount = Column(Numeric(12, 2), nullable=True, comment="临时工金额")
    remark = Column(Text, nullable=True, comment="备注")
    reporter = Column(String(64), nullable=True, comment="填报人(自动带出当前登录人)")

    # ---- 派生统计（保存时自动计算，不手填） ----
    attendance_count = Column(Integer, nullable=True, default=0, comment="实际出勤人员(出勤明细条数)")
    attendance_actual = Column(Integer, nullable=True, default=0, comment="实际出勤人数(出勤-请假)")
    leave_count = Column(Integer, nullable=True, default=0, comment="请假人数")
    leave_hours_total = Column(Numeric(10, 2), nullable=True, comment="请假总时间")
    work_wages_total = Column(Numeric(12, 2), nullable=True, comment="当日总工资(出勤明细金额合计)")
    grand_total_wages = Column(Numeric(12, 2), nullable=True, comment="总工资(含临时工)")
    modulus_total = Column(Integer, nullable=True, default=0, comment="模数合计")

    data_source = Column(String(32), nullable=False, server_default="manual", default="manual", comment="数据来源")
    created_by = Column(String(64), nullable=True, comment="创建人用户名")
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    leave_items = relationship(
        "WorkshopDailyReportLeave",
        back_populates="report",
        cascade="all, delete-orphan",
        order_by="WorkshopDailyReportLeave.id",
    )
    work_items = relationship(
        "WorkshopDailyReportWork",
        back_populates="report",
        cascade="all, delete-orphan",
        order_by="WorkshopDailyReportWork.id",
    )
    task_items = relationship(
        "WorkshopDailyReportTask",
        back_populates="report",
        cascade="all, delete-orphan",
        order_by="WorkshopDailyReportTask.id",
    )

    __table_args__ = (
        Index("uq_workshop_daily_report_no", "report_no", unique=True),
        Index("ix_workshop_daily_report_report_date", "report_date"),
        Index("ix_workshop_daily_report_department", "department"),
        Index("ix_workshop_daily_report_workshop", "workshop"),
    )


class WorkshopDailyReportLeave(Base):
    """车间日报表 — 请假人员明细"""

    __tablename__ = "workshop_daily_report_leave"

    id = Column(Integer, primary_key=True, autoincrement=True)
    report_id = Column(
        Integer, ForeignKey("workshop_daily_report.id", ondelete="CASCADE"), nullable=False, index=True
    )
    leave_date = Column(Date, nullable=True, comment="请假日期")
    employee_name = Column(String(64), nullable=True, comment="人员姓名")
    emp_code = Column(String(32), nullable=True, comment="工号")
    leave_hours = Column(Numeric(10, 2), nullable=True, comment="请假时间")

    report = relationship("WorkshopDailyReport", back_populates="leave_items")

    __table_args__ = (Index("ix_wsdr_leave_report_id", "report_id"),)


class WorkshopDailyReportWork(Base):
    """车间日报表 — 出勤人员·工时明细"""

    __tablename__ = "workshop_daily_report_work"

    id = Column(Integer, primary_key=True, autoincrement=True)
    report_id = Column(
        Integer, ForeignKey("workshop_daily_report.id", ondelete="CASCADE"), nullable=False, index=True
    )
    work_date = Column(Date, nullable=True, comment="出勤日期")
    employee_name = Column(String(64), nullable=True, comment="人员姓名")
    emp_code = Column(String(32), nullable=True, comment="工号")
    total_hours = Column(Numeric(10, 2), nullable=True, comment="当日工时")
    leave_hours = Column(Numeric(10, 2), nullable=True, comment="请假工时")
    normal_hours = Column(Numeric(10, 2), nullable=True, comment="正班工时")
    overtime_hours = Column(Numeric(10, 2), nullable=True, comment="加班工时")
    actual_hours = Column(Numeric(10, 2), nullable=True, comment="实际工时(正班+加班,自动)")
    hourly_wage = Column(Numeric(12, 2), nullable=True, comment="工时工资")
    amount = Column(Numeric(12, 2), nullable=True, comment="金额(默认=工时工资)")
    modulus = Column(Integer, nullable=True, default=1, comment="模数")
    daily_attendance = Column(String(255), nullable=True, comment="当日考勤情况(打卡点)")

    report = relationship("WorkshopDailyReport", back_populates="work_items")

    __table_args__ = (Index("ix_wsdr_work_report_id", "report_id"),)


class WorkshopDailyReportTask(Base):
    """车间日报表 — 选择K3任务单明细"""

    __tablename__ = "workshop_daily_report_task"

    id = Column(Integer, primary_key=True, autoincrement=True)
    report_id = Column(
        Integer, ForeignKey("workshop_daily_report.id", ondelete="CASCADE"), nullable=False, index=True
    )
    seq = Column(Integer, nullable=True, comment="序号")
    sale_order_no = Column(String(64), nullable=True, comment="销售订单号")
    production_order_no = Column(String(64), nullable=True, comment="生产订单号")
    public_material = Column(String(255), nullable=True, comment="公共物料件选择")
    specification = Column(String(128), nullable=True, comment="规格型号")
    batch_qty = Column(Numeric(15, 2), nullable=True, comment="生产单批量")
    bom_no = Column(String(64), nullable=True, comment="BOM编号")
    material_code = Column(String(64), nullable=True, comment="物料代码")
    process = Column(String(64), nullable=True, comment="生产工序")
    process_remark = Column(String(255), nullable=True, comment="工序备注")
    color = Column(String(64), nullable=True, comment="颜色")
    color_temp = Column(String(64), nullable=True, comment="色温")
    product_unit_price = Column(Numeric(12, 2), nullable=True, comment="产品单价")
    unit_price = Column(Numeric(12, 2), nullable=True, comment="单价")
    completed_qty = Column(Numeric(15, 2), nullable=True, comment="完工数量")
    amount = Column(Numeric(12, 2), nullable=True, comment="金额")
    exception_amount = Column(Numeric(12, 2), nullable=True, comment="异常金额")
    allocated_unit_price = Column(Numeric(12, 2), nullable=True, comment="分摊后单价")
    allocated_amount = Column(Numeric(12, 2), nullable=True, comment="分摊后金额")

    report = relationship("WorkshopDailyReport", back_populates="task_items")

    __table_args__ = (Index("ix_wsdr_task_report_id", "report_id"),)
