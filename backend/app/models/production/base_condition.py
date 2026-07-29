"""Production schedule base condition (车间排产基础条件).

按排产阶段分桶存储"基础条件"默认值: 班组人数 / 每日工时 / 是否周日排产.
排产弹窗预填这些值, 用户可临时覆盖; 设一次后新排产自动套用.
"""

from sqlalchemy import Boolean, Column, DateTime, Integer, Numeric, String
from sqlalchemy.sql import func

from app.core.database import Base


class ProductionBaseCondition(Base):
    __tablename__ = "production_base_condition"

    id = Column(Integer, primary_key=True, autoincrement=True)
    schedule_bucket = Column(String(32), nullable=False, unique=True, index=True, comment="排产阶段 lean/assembly/packaging/mixed")
    bucket_label = Column(String(64), nullable=False, comment="阶段中文名")
    default_manpower = Column(Integer, nullable=False, default=10, comment="默认班组人数")
    daily_work_hours = Column(Numeric(5, 2), nullable=False, default=8, comment="默认每日工时")
    include_sunday = Column(Boolean, nullable=False, default=False, comment="是否默认周日排产")
    is_active = Column(Boolean, nullable=False, default=True, comment="启用状态")
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
