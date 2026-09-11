"""订单交付中心 — 销售订单模型（对齐1.点检CSV 38列）"""

from sqlalchemy import Column, Integer, String, Numeric, Date, DateTime, Text, UniqueConstraint, Index, ForeignKey, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship, backref
from sqlalchemy.sql import func

from app.core.database import Base


class SaleOrder(Base):
    """销售订单主表 — 对齐 1.点检 CSV 列"""
    __tablename__ = "sale_order"
    __table_args__ = (
        Index("uq_sale_order_erp_id", "erp_id", unique=True, postgresql_where=text("erp_id IS NOT NULL")),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    order_no = Column(String(64), nullable=False, index=True)
    line_no = Column(String(32), nullable=False)
    customer = Column(String(128))
    customer_code = Column(String(64))
    product_code = Column(String(64))
    product_name = Column(String(256))
    order_qty = Column(Numeric(15, 2))
    order_amount = Column(Numeric(15, 2), comment="金额")
    completed_qty = Column(Numeric(15, 2), comment="完成数量")
    promised_date = Column(Date)
    planned_start_date = Column(Date)
    batch_no = Column(String(128))
    department = Column(String(64))
    audit_date = Column(Date)
    owner = Column(String(64))
    status = Column(String(32), nullable=False, default="open")
    erp_id = Column(Integer, comment="ERP订单主键ID")
    erp_status = Column(Integer, comment="ERP订单状态(整型)")
    risk_level = Column(String(16))
    extra_data = Column(JSONB)
    data_source = Column(String(32))
    order_nature = Column(String(32), comment="订单性质")
    order_date = Column(Date, comment="下单时间")

    # ── 点检新增字段 ──
    delivery_completed_date = Column(Date, comment="6.发货完成日期")
    customer_grade = Column(String(4), comment="客户等级 A/B/C/D")
    shipping_plan = Column(Date, comment="出货计划")
    customer_inspection_date = Column(Date, comment="客户验货时间")
    inspection_result = Column(String(64), comment="客检结果 OK/NG")
    packaging_status = Column(Text, comment="包装完成状况")
    bom_return_date = Column(Date, comment="BOM回收日期")
    material_ready_date = Column(Date, comment="料齐套时间")
    shipping_status_desc = Column(Text, comment="发货状态即时说明")
    procurement_status = Column(Text, comment="采购物料齐套-总体说明")
    material_dates = Column(JSONB, comment="物料分类到料日期 {电子料,SMT上线,光源,...,包材}")
    front_process_date = Column(Date, comment="前道日期")
    first_article_date = Column(Date, comment="首件检验日期")
    assembly_start_date = Column(Date, comment="组装上线日期")
    assembly_complete_date = Column(Date, comment="组装完成日期")
    is_closed = Column(Integer, nullable=False, server_default='0', default=0, comment="是否关闭")
    is_deleted = Column(Integer, nullable=False, server_default='0', default=0, comment="是否删除 0否1是")
    remark = Column(Text, comment="备注")

    # ── 风险评估字段 ──
    risk_score = Column(Numeric(5, 2), comment="风险总评分0-100")
    risk_factors = Column(JSONB, comment="各因子分值明细 {delivery_delay,shortage,process_lag,quality,eta_delay,inspection_ng}")
    risk_assessed_at = Column(DateTime, comment="最近风险评估时间")
    field_synced_at = Column(JSONB, comment="字段级同步时间 {field_name: ISO8601 str}")

    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    lines = relationship('SaleOrderLine', backref=backref('order', lazy='raise'), lazy='raise', order_by='SaleOrderLine.id')


class SaleOrderLine(Base):
    __tablename__ = "sale_order_line"

    id = Column(Integer, primary_key=True, autoincrement=True)
    sale_order_id = Column(Integer, ForeignKey('sale_order.id'), nullable=False, index=True)
    erp_line_id = Column(String(64))
    order_no = Column(String(64), nullable=False, index=True)
    line_no = Column(String(32), nullable=False)
    product_code = Column(String(64))
    product_name = Column(String(256))
    product_model = Column(String(128), comment="产品型号")
    order_qty = Column(Numeric(15, 2))
    order_amount = Column(Numeric(15, 2), comment="金额")
    promised_date = Column(Date)
    shipping_plan = Column(Date, comment="出货计划(冗余自 sale_order, 排产以此为准)")
    planned_start_date = Column(Date)
    batch_no = Column(String(128))
    bom_no = Column(String(64), comment="BOM编号")
    bom_id = Column(Integer, comment="BOM ID")
    status = Column(String(32), nullable=False, default="open")
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("order_no", "erp_line_id", name="uq_sale_order_line_order_erp"),
    )

