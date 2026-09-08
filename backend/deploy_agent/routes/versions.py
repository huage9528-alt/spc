"""版本查询与 SSE 流接口。"""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import deploy_service
from ..auth import TokenPayload

router = APIRouter()


@router.get("/versions")
async def list_versions(_: TokenPayload) -> dict:
    """列出远程 versions/ 目录 + docker image inspect 状态。"""
    rows = await deploy_service.list_versions()
    return {"code": 0, "message": "ok", "data": rows}


@router.get("/versions/{version}")
async def version_detail(version: str, _: TokenPayload) -> dict:
    """单个版本详情：元信息 / 镜像 / 快照 / 活动日志（供详情抽屉）。"""
    detail = await deploy_service.get_version_detail(version)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"version not found: {version}")
    return {"code": 0, "message": "ok", "data": detail}


@router.get("/status")
async def status(_: TokenPayload) -> dict:
    """服务器健康 + 当前运行版本。"""
    s = await deploy_service.get_status()
    return {"code": 0, "message": "ok", "data": s}


def _sse_format(ev: dict) -> bytes:
    """FastAPI/Starlette 自带 SSEResponse 也可；这里手写以保证兼容。"""
    name = ev.get("event", "message")
    data = json.dumps(ev, ensure_ascii=False)
    return f"event: {name}\ndata: {data}\n\n".encode("utf-8")


@router.get("/jobs/{job_id}/stream")
async def job_stream(job_id: str, _: TokenPayload) -> StreamingResponse:
    """Server-Sent Events 流；前端 EventSource 消费。

    job 可以是 running / 已结束。已结束会先 replay 缓存事件再 close。
    """
    if not deploy_service.bus.has(job_id):
        raise HTTPException(status_code=404, detail="job not found")

    async def _gen() -> AsyncIterator[bytes]:
        async for ev in deploy_service.bus.subscribe(job_id):
            yield _sse_format(ev)
        yield b"event: end\ndata: {}\n\n"

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/jobs/{job_id}")
async def job_state(job_id: str, _: TokenPayload) -> dict:
    """同步查询 job 最终状态。running 时 status='running'。"""
    if not deploy_service.bus.has(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    if deploy_service.bus.is_ended(job_id):
        final = deploy_service.bus.final_status(job_id) or {}
        return {"code": 0, "message": "ok",
                "data": {"status": "ended", **final}}
    return {"code": 0, "message": "ok",
            "data": {"status": "running", "job_id": job_id}}
