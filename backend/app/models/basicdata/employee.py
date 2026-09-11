"""基础数据与集成中心 — 人员模型"""

from sqlalchemy import Column, BigInteger, String, Integer, DateTime
from sqlalchemy.sql import func

from app.core.database import Base


class Employee(Base):
    __tablename__ = "scm_employee"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    emp_code = Column(String(20), nullable=True, unique=True, comment="员工工号（可空；ERP 同步不再用 oa_user_id/login_id 兜底填充）")
    emp_name = Column(String(50), nullable=False, comment="员工姓名")
    org_id = Column(BigInteger, nullable=True, comment="所属组织ID（主部门）")
    position_id = Column(BigInteger, nullable=True, comment="岗位ID")
    oa_user_id = Column(String(64), nullable=True, unique=True, comment="OA系统用户ID")
    erp_user_id = Column(BigInteger, nullable=True, comment="ERP系统用户ID（通过姓名匹配回填）")
    manager_oa_user_id = Column(String(64), nullable=True, comment="上级人员OA用户ID")
    login_id = Column(String(64), nullable=True, comment="登录ID")
    position = Column(String(50), nullable=True, comment="岗位名称")
    phone = Column(String(20), nullable=True, comment="手机号")
    email = Column(String(50), nullable=True, comment="邮箱")
    status = Column(Integer, nullable=False, default=1, comment="状态 (0-试用 1-正式 2-临时 3-试用延期 4-解聘 5-离职 6-退休 7-无效)")
    data_source = Column(String(32))
    create_time = Column(DateTime, server_default=func.now(), nullable=False)
