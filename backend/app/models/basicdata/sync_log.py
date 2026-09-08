"""同步日志模型 — 记录每次同步任务的执行状态与结果"""

from sqlalchemy import Column, Integer, String, Text, DateTime, Numeric
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func

from app.core.database import Base


class SyncLog(Base):
    __tablename__ = "sync_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(36), unique=True, nullable=False, index=True, comment="UUID任务ID")
    sync_type = Column(String(32), nullable=False, index=True, comment="同步类型(orders/materials等)")
    trigger_mode = Column(String(16), nullable=False, default="manual", comment="触发方式(manual/scheduled)")
    triggered_by = Column(String(64), comment="操作人username")
    server_id = Column(String(64), comment="执行同步的后端服务标识(SERVER_ID或hostname)")
    status = Column(String(16), nullable=False, default="pending", index=True, comment="pending/running/success/failed")

    started_at = Column(DateTime, comment="开始时间")
    finished_at = Column(DateTime, comment="结束时间")
    duration_seconds = Column(Numeric(10, 2), comment="耗时(秒)")

    synced_count = Column(Integer, default=0, comment="处理条数")
    created_count = Column(Integer, default=0, comment="新增条数")
    updated_count = Column(Integer, default=0, comment="更新条数")
    failed_count = Column(Integer, default=0, comment="失败条数")
    message = Column(Text, comment="成功摘要或错误信息")
    error_detail = Column(Text, comment="异常堆栈(仅failed)")

    sync_params = Column(JSONB, comment="同步参数快照 {hours, order_numbers, ...}")

    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
