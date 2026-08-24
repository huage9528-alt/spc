"""基础数据与集成中心 — 数据供给模型"""

from sqlalchemy import Column, Integer, BigInteger, String, Boolean, Text, DateTime, Numeric
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func

from app.core.database import Base


class DataSupplyApiKey(Base):
    """数据供给 API Key — 为外部系统分配的访问凭据"""
    __tablename__ = "data_supply_api_key"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key_name = Column(String(128), nullable=False, comment="Key 名称（通常为外部系统名）")
    api_key = Column(String(64), nullable=False, unique=True, index=True, comment="API Key 值")
    description = Column(String(512), nullable=True, comment="用途说明")
    is_active = Column(Boolean, default=True, comment="是否启用")
    allowed_endpoints_json = Column(Text, nullable=True, comment="允许调用的对外接口 endpoint_code 列表 JSON")
    rate_limit = Column(Integer, default=100, comment="每分钟请求限制")
    app_key = Column(String(64), nullable=True, unique=True, index=True, comment="应用标识（AppKey）")
    app_secret = Column(String(128), nullable=True, comment="应用密钥（AppSecret，仅创建时返回）")
    ip_whitelist_json = Column(Text, nullable=True, comment="IP 白名单 JSON 列表，为空则不限制")
    expires_at = Column(DateTime, nullable=True, comment="过期时间（null 表示永不过期）")
    created_by = Column(String(64), nullable=True, comment="创建人")
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class DataSupplyCallLog(Base):
    """数据供给调用日志 — 记录每次 API 调用"""
    __tablename__ = "data_supply_call_log"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    api_key_id = Column(Integer, nullable=True, index=True, comment="关联 API Key ID")
    api_key_name = Column(String(128), nullable=True, comment="API Key 名称快照")
    data_type = Column(String(64), nullable=False, index=True, comment="请求的数据类型")
    request_params_json = Column(Text, nullable=True, comment="请求参数快照")
    response_status = Column(Integer, nullable=True, comment="HTTP 响应状态码")
    response_count = Column(Integer, default=0, comment="返回数据条数")
    ip_address = Column(String(64), nullable=True, comment="请求来源 IP")
    user_agent = Column(String(256), nullable=True, comment="请求 User-Agent")
    duration_ms = Column(Numeric(10, 2), nullable=True, comment="响应耗时(ms)")
    error_message = Column(Text, nullable=True, comment="错误信息")
    called_at = Column(DateTime, server_default=func.now(), nullable=False, index=True)

