"""基础数据与集成中心 — 用户/角色模型"""

from sqlalchemy import BigInteger, Column, Integer, String, Boolean, DateTime
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func

from app.core.database import Base


class SysRole(Base):
    __tablename__ = "sys_role"

    id = Column(Integer, primary_key=True, autoincrement=True)
    role_code = Column(String(32), nullable=False, unique=True)
    role_name = Column(String(64), nullable=False)
    permissions = Column(JSONB)
    org_id = Column(String(64), nullable=True, comment="关联部门ID")
    position_id = Column(String(64), nullable=True, comment="关联岗位ID")
    created_at = Column(DateTime, server_default=func.now(), nullable=False)



class SysUser(Base):
    __tablename__ = "sys_user"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(64), nullable=False, unique=True)
    display_name = Column(String(128))
    hashed_password = Column(String(256), nullable=False)
    role_id = Column(Integer, nullable=False)
    supplier_name = Column(String(100), nullable=True, comment="关联供应商名称")
    emp_code = Column(String(20), nullable=True, comment="关联员工工号")
    wecom_user_id = Column(String(64), nullable=True, unique=True, comment="绑定企业微信userid")
    is_active = Column(Boolean, nullable=False, default=True)
    login_version = Column(Integer, nullable=False, default=0, comment="（已废弃，保留兼容）原 web 渠道登录版本号，现由 channel_sessions 取代")
    last_token_jti = Column(String(64), nullable=True, comment="（已废弃，保留兼容）原 web 渠道 token jti，现由 channel_sessions 取代")
    channel_sessions = Column(JSONB, nullable=True, comment="分渠道会话状态：{渠道名: {version, last_jti}}，同渠道互斥、跨渠道并存，新增端直接使用新渠道名")
    last_login_time = Column(DateTime, nullable=True, comment="最后一次登录时间")
    font_size_scale = Column(String(10), nullable=True, default='1.0', comment="字体大小缩放比例")
    ui_preferences = Column(JSONB, nullable=True, comment="UI偏好设置（如各页面列可见性等）")
    is_default_password = Column(Boolean, nullable=False, default=True, comment="是否默认密码，首次登录强制修改")
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
