"""部署版本管理 schemas

包裹 deploy-agent 返回的数据结构用于前端消费。
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class VersionRow(BaseModel):
    version: str
    current: bool = False
    images: str = Field(default="MISSING", description="OK / MISSING")
    created: str = ""
    git: str = ""
    note: str = ""
    deployer: str = ""


class StatusResp(BaseModel):
    current: str = ""
    current_created: str = ""
    current_git: str = ""
    version_count: int = 0
    retain_count: int = 5
    compose_file: str = ""
    git_url: str = ""
    git_branch: str = ""


class RollbackReq(BaseModel):
    version: str = Field(default="", description="空=回退到上一版本")


class SwitchReq(BaseModel):
    version: str = Field(..., min_length=1)


class DeployNewReq(BaseModel):
    note: str = Field(default="", max_length=500)
    options: dict[str, Any] = Field(default_factory=dict)


class JobCreated(BaseModel):
    """动作接口的统一返回：job_id 给前端订阅 SSE。"""
    job_id: str
