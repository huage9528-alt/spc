"""部署版本管理 API（薄代理到 deploy-agent）。

权限模型：持有 deploy_versions.view 可读、deploy_versions.manage 可执行动作
（rollback / switch / deploy-new / 看流）。权限由「角色管理」按角色授予，
不限定 admin；admin 自动通过。

设计：
- GET 端点同步代理 5s 连接超时；
- POST 端点（rollback / switch / deploy-new）生成 job 后立即返回 {job_id}；
- SSE 通过 httpx.AsyncClient.stream() 转发 agent 的 SSE 流给前端
  （前端用 fetch + ReadableStream，走 Authorization header）。

任何 agent 故障/不可达都返回 502。
"""
from __future__ import annotations

import json
import logging
from typing import AsyncIterator

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import PermissionChecker, oauth2_scheme
from app.core.audit import log_audit
from app.core.database import get_db
from app.schemas.common import ResponseModel
from app.schemas.deploy_versions import (
    DeployNewReq,
    JobCreated,
    RollbackReq,
    SwitchReq,
    VersionRow,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _agent_url(path: str) -> str:
    base = get_settings().DEPLOY_AGENT_URL.rstrip("/")
    return f"{base}{path}"


def _auth_header(token: str) -> dict[str, str]:
    """把后端用户的 JWT 透传给 deploy-agent（同 SECRET_KEY/ALGORITHM）。"""
    return {"Authorization": f"Bearer {token}"}


async def _audit(
    db: AsyncSession,
    user: dict,
    action: str,
    target: str,
    extra: dict | None = None,
) -> None:
    """审计一次部署动作。

    audit_log 表 record_id 是 Integer，无法直接存版本字符串。
    设计：
      - table_name = "deploy_version_job"（与既有 audit_log 模型兼容）
      - field_name = 动作子类型（rollback / switch / deploy_new）
      - old_value / new_value = 版本号 / job_id
    """
    try:
        operator = (user or {}).get("username") or (user or {}).get("sub") or "system"
        await log_audit(
            db,
            "deploy_version_job",
            0,  # record_id: 0 表示「无具体行记录」
            action,
            field_name=target,
            old_value=extra.get("from_version", "") if extra else "",
            new_value=extra.get("to_version", "") if extra else "",
            operator=operator,
        )
        await db.commit()
    except Exception as exc:  # pragma: no cover - 不让审计失败阻塞主流程
        logger.warning("audit log failed: %s", exc)


async def _post_to_agent(path: str, body: dict, token: str) -> JobCreated:
    settings = get_settings()
    url = _agent_url(f"/api/v1/deploy{path}")
    try:
        async with httpx.AsyncClient(timeout=settings.DEPLOY_AGENT_TIMEOUT_ACTION) as client:
            r = await client.post(url, json=body, headers=_auth_header(token))
    except (httpx.ConnectError, httpx.ReadError, httpx.ConnectTimeout) as e:
        logger.warning("deploy_agent unreachable: %s", e)
        raise HTTPException(status_code=502, detail=f"deploy_agent 不可达: {e!s}") from None

    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text or "agent error")
    payload = r.json().get("data") or {}
    return JobCreated(**payload)


@router.get("/versions", response_model=ResponseModel)
async def list_versions(
    current_user: dict = Depends(PermissionChecker("deploy_versions", "read")),
    token: str = Depends(oauth2_scheme),
):
    settings = get_settings()
    try:
        async with httpx.AsyncClient(timeout=settings.DEPLOY_AGENT_TIMEOUT_CONNECT) as client:
            r = await client.get(_agent_url("/api/v1/deploy/versions"), headers=_auth_header(token))
    except (httpx.ConnectError, httpx.ReadError, httpx.ConnectTimeout) as e:
        raise HTTPException(status_code=502, detail=f"deploy_agent 不可达: {e!s}") from None
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text or "agent error")
    rows = r.json().get("data") or []
    return ResponseModel(data=[VersionRow(**row).model_dump() for row in rows])


@router.get("/status", response_model=ResponseModel)
async def status(
    current_user: dict = Depends(PermissionChecker("deploy_versions", "read")),
    token: str = Depends(oauth2_scheme),
):
    settings = get_settings()
    try:
        async with httpx.AsyncClient(timeout=settings.DEPLOY_AGENT_TIMEOUT_CONNECT) as client:
            r = await client.get(_agent_url("/api/v1/deploy/status"), headers=_auth_header(token))
    except (httpx.ConnectError, httpx.ReadError, httpx.ConnectTimeout) as e:
        raise HTTPException(status_code=502, detail=f"deploy_agent 不可达: {e!s}") from None
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text or "agent error")
    return ResponseModel(data=r.json().get("data") or {})


@router.get("/versions/{version}", response_model=ResponseModel)
async def version_detail(
    version: str,
    current_user: dict = Depends(PermissionChecker("deploy_versions", "read")),
    token: str = Depends(oauth2_scheme),
):
    settings = get_settings()
    try:
        async with httpx.AsyncClient(timeout=settings.DEPLOY_AGENT_TIMEOUT_CONNECT) as client:
            r = await client.get(_agent_url(f"/api/v1/deploy/versions/{version}"),
                                 headers=_auth_header(token))
    except (httpx.ConnectError, httpx.ReadError, httpx.ConnectTimeout) as e:
        raise HTTPException(status_code=502, detail=f"deploy_agent 不可达: {e!s}") from None
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="version not found")
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text or "agent error")
    return ResponseModel(data=r.json().get("data") or {})


@router.post("/rollback", response_model=ResponseModel)
async def rollback(
    req: RollbackReq,
    current_user: dict = Depends(PermissionChecker("deploy_versions", "manage")),
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
):
    job = await _post_to_agent("/rollback", {"version": req.version}, token)
    await _audit(db, current_user, "rollback", req.version or "(previous)",
                 {"to_version": req.version or "(previous)",
                  "from_version": "(current)",
                  "job_id": job.job_id})
    return ResponseModel(data=job.model_dump())


@router.post("/switch", response_model=ResponseModel)
async def switch(
    req: SwitchReq,
    current_user: dict = Depends(PermissionChecker("deploy_versions", "manage")),
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
):
    if not req.version:
        raise HTTPException(status_code=400, detail="version is required")
    job = await _post_to_agent("/switch", {"version": req.version}, token)
    await _audit(db, current_user, "switch", req.version,
                 {"to_version": req.version,
                  "from_version": "(current)",
                  "job_id": job.job_id})
    return ResponseModel(data=job.model_dump())


@router.post("/deploy-new", response_model=ResponseModel)
async def deploy_new(
    req: DeployNewReq,
    current_user: dict = Depends(PermissionChecker("deploy_versions", "manage")),
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
):
    job = await _post_to_agent(
        "/deploy-new",
        {"note": req.note, "options": req.options},
        token,
    )
    await _audit(db, current_user, "deploy_new", "(pending)",
                 {"to_version": "(pending)",
                  "from_version": "(current)",
                  "job_id": job.job_id,
                  "note": req.note})
    return ResponseModel(data=job.model_dump())


@router.get("/jobs/{job_id}", response_model=ResponseModel)
async def job_state(
    job_id: str,
    current_user: dict = Depends(PermissionChecker("deploy_versions", "read")),
    token: str = Depends(oauth2_scheme),
):
    settings = get_settings()
    try:
        async with httpx.AsyncClient(timeout=settings.DEPLOY_AGENT_TIMEOUT_CONNECT) as client:
            r = await client.get(_agent_url(f"/api/v1/deploy/jobs/{job_id}"), headers=_auth_header(token))
    except (httpx.ConnectError, httpx.ReadError, httpx.ConnectTimeout) as e:
        raise HTTPException(status_code=502, detail=f"deploy_agent 不可达: {e!s}") from None
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="job not found")
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return ResponseModel(data=r.json().get("data") or {})


@router.get("/jobs/{job_id}/stream")
async def job_stream(
    job_id: str,
    current_user: dict = Depends(PermissionChecker("deploy_versions", "read")),
    token: str = Depends(oauth2_scheme),
) -> StreamingResponse:
    """代理 agent 的 SSE 流给前端。

    与其它 deploy 端点一致：需持有 deploy_versions.view 权限（角色可在
    「角色管理」中授权，不限定 admin）。前端用 fetch + ReadableStream，
    支持 Authorization header，无需 query token。
    """
    settings = get_settings()
    url = _agent_url(f"/api/v1/deploy/jobs/{job_id}/stream")

    async def _gen() -> AsyncIterator[bytes]:
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(settings.DEPLOY_AGENT_TIMEOUT_ACTION, connect=5.0),
            ) as client:
                async with client.stream(
                    "GET", url,
                    headers={**_auth_header(token), "Accept": "text/event-stream"},
                ) as resp:
                    if resp.status_code >= 400:
                        body = await resp.aread()
                        yield b"event: error\ndata: " + json.dumps(
                            {"detail": body.decode("utf-8", errors="replace")}
                        ).encode("utf-8") + b"\n\n"
                        return
                    async for raw in resp.aiter_bytes():
                        if not raw:
                            continue
                        yield raw
        except (httpx.ConnectError, httpx.ReadError, httpx.ConnectTimeout) as e:
            yield b"event: error\ndata: " + json.dumps(
                {"detail": f"deploy_agent 不可达: {e!s}"}
            ).encode("utf-8") + b"\n\n"

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
