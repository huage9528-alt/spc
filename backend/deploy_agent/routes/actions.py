"""动作接口：回退 / 切换任意版本 / 部署新版本。

设计原则：
- POST 仅生成 job_id 并启动后台任务，立即返回。
- 客户端通过 /jobs/{id}/stream 跟踪实时日志。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import deploy_service
from ..auth import TokenPayload

router = APIRouter()


class RollbackReq(BaseModel):
    """target 为空表示"回退到上一版本"（即 list_versions 的第 2 新）。"""
    version: str = Field(default="", description="目标版本号，空=上一版本")


class SwitchReq(BaseModel):
    version: str = Field(..., description="目标版本号")


class DeployNewReq(BaseModel):
    note: str = Field(default="", description="版本备注，会写入 meta.txt")
    options: dict[str, Any] = Field(
        default_factory=dict,
        description="扩展选项：auto_rollback_on_fail / skip_build 等",
    )


def _job_resp(job_id: str) -> dict:
    return {"code": 0, "message": "ok", "data": {"job_id": job_id}}


@router.post("/rollback")
async def rollback(req: RollbackReq, _: TokenPayload) -> dict:
    try:
        job_id, _stream = await deploy_service.rollback(req.version)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    return _job_resp(job_id)


@router.post("/switch")
async def switch(req: SwitchReq, _: TokenPayload) -> dict:
    if not req.version:
        raise HTTPException(status_code=400, detail="version is required")
    job_id, _stream = await deploy_service.switch(req.version)
    return _job_resp(job_id)


@router.post("/deploy-new")
async def deploy_new(req: DeployNewReq, user: TokenPayload) -> dict:
    operator = (user.get("username") or user.get("display_name") or user.get("sub") or "").strip()
    job_id, _stream = await deploy_service.deploy_new(req.note, req.options, operator)
    return _job_resp(job_id)
