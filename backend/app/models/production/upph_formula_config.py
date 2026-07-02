from sqlalchemy import Boolean, Column, DateTime, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.sql import func

from app.core.database import Base


class UpphFormulaConfig(Base):
    __tablename__ = "production_upph_formula_config"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workshop_name = Column(String(64), nullable=False, comment="车间名称")
    process_type = Column(String(64), nullable=False, comment="工序类型")
    manpower = Column(Numeric(10, 2), nullable=False, comment="人数")
    hour_price = Column(Numeric(10, 2), nullable=False, comment="小时单价")
    is_active = Column(Boolean, nullable=False, default=True, comment="是否启用")
    remark = Column(Text, nullable=True, comment="备注")
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("workshop_name", "process_type", name="uq_production_upph_formula_config"),
    )
