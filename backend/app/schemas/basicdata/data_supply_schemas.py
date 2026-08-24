"""基础数据与集成中心 — 数据供给 Schema"""

from typing import Optional, List
from datetime import datetime
from decimal import Decimal
from pydantic import BaseModel


# ── DataSupplyApiKey ──
class DataSupplyApiKeyCreate(BaseModel):
    key_name: str
    description: Optional[str] = None
    allowed_endpoints_json: Optional[str] = None
    ip_whitelist_json: Optional[str] = None
    rate_limit: int = 100
    expires_at: Optional[datetime] = None


class DataSupplyApiKeyUpdate(BaseModel):
    key_name: Optional[str] = None
    description: Optional[str] = None
    allowed_endpoints_json: Optional[str] = None
    ip_whitelist_json: Optional[str] = None
    rate_limit: Optional[int] = None
    is_active: Optional[bool] = None
    expires_at: Optional[datetime] = None


class DataSupplyApiKeyOut(BaseModel):
    id: int
    key_name: str
    app_key: Optional[str] = None
    description: Optional[str] = None
    is_active: bool = True
    allowed_endpoints_json: Optional[str] = None
    ip_whitelist_json: Optional[str] = None
    rate_limit: int = 100
    expires_at: Optional[datetime] = None
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class DataSupplyApiKeyCreateResult(BaseModel):
    """创建结果，包含 AppSecret（仅创建时返回一次）"""
    id: int
    key_name: str
    app_key: str
    app_secret: str
    description: Optional[str] = None
    is_active: bool = True
    allowed_endpoints_json: Optional[str] = None
    ip_whitelist_json: Optional[str] = None
    rate_limit: int = 100
    expires_at: Optional[datetime] = None
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ── DataSupplyCallLog ──
class DataSupplyCallLogOut(BaseModel):
    id: int
    api_key_id: Optional[int] = None
    api_key_name: Optional[str] = None
    data_type: str
    request_params_json: Optional[str] = None
    response_status: Optional[int] = None
    response_count: int = 0
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    duration_ms: Optional[Decimal] = None
    error_message: Optional[str] = None
    called_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ── 统计 ──
class DataSupplyCallStatistics(BaseModel):
    total_calls: int = 0
    success_calls: int = 0
    failed_calls: int = 0
    failure_rate: Optional[float] = None
    rate_limited_calls: int = 0
    p95_duration_ms: Optional[float] = None
    avg_duration_ms: Optional[float] = None
    by_data_type: dict = {}
    by_endpoint: dict = {}
    by_date: dict = {}
    by_api_key: dict = {}

