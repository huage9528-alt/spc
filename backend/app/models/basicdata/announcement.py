"""公告 & 通用通知模型"""

from sqlalchemy import Column, Integer, BigInteger, String, Text, Boolean, DateTime, ForeignKey, Index
from sqlalchemy.sql import func

from app.core.database import Base


class Announcement(Base):
    __tablename__ = "announcement"

    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String(256), nullable=False)
    content = Column(Text, nullable=True)
    type = Column(String(32), nullable=False, default="notice", comment="system_update / notice / maintenance")
    priority = Column(String(16), nullable=False, default="normal", comment="normal / important / urgent")
    is_published = Column(Boolean, nullable=False, default=False)
    published_at = Column(DateTime, nullable=True)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class Notification(Base):
    __tablename__ = "notification"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("sys_user.id"), nullable=False)
    type = Column(String(32), nullable=False, comment="announcement / material_alert / exception_alert")
    title = Column(String(256), nullable=False)
    content = Column(String(512), nullable=True)
    ref_type = Column(String(32), nullable=True, comment="关联对象类型")
    ref_id = Column(Integer, nullable=True, comment="关联对象ID")
    sender_id = Column(Integer, ForeignKey("sys_user.id"), nullable=True, comment="提出人ID")
    sender_name = Column(String(64), nullable=True, comment="提出人/发送人")
    priority = Column(String(16), nullable=False, default="normal")
    is_read = Column(Boolean, nullable=False, default=False)
    read_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_notification_user_read", "user_id", "is_read"),
        Index("ix_notification_user_type", "user_id", "type"),
    )
