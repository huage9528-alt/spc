"""规则配置中心 — Schema 定义"""

from typing import Optional
from datetime import datetime
from pydantic import BaseModel


# ============ 节点标准 ============

class NodeStandardOut(BaseModel):
    id: int
    node_code: str
    node_name: str
    time_value: int
    time_unit: str
    applicable_scene: str
    description: Optional[str] = None
    is_active: bool = True
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class NodeStandardCreate(BaseModel):
    node_code: str
    node_name: str
    time_value: int
    time_unit: str = "天"
    applicable_scene: str
    description: Optional[str] = None
    is_active: bool = True


class NodeStandardUpdate(BaseModel):
    node_name: Optional[str] = None
    time_value: Optional[int] = None
    time_unit: Optional[str] = None
    applicable_scene: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None
