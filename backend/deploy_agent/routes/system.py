from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    """无需鉴权；本地 loopback 健康检查。"""
    return {"status": "ok", "service": "deploy_agent"}
