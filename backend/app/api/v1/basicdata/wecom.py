"""基础数据与集成中心 — 企业微信通讯录与分享推送 API。

两个 router 分离以避免前缀冲突：
- wecom_public_router (前缀 /wecom): /users, /test-connection
- wecom_share_router (无前缀): /share/{share_id}/send-wecom
  留空以便在父 include_router 处复用既有 /share 前缀
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.core.security import PermissionChecker
from app.models.basicdata.share_link import ShareLink
from app.schemas.common import ResponseModel
from app.services.basicdata.wecom.client import get_wecom_client
from app.services.basicdata.wecom.contact_service import (
    list_wecom_departments,
    list_wecom_users,
)
from app.services.basicdata.wecom.exceptions import WecomAPIError, WecomError, WecomNotConfiguredError
from app.services.basicdata.wecom.send_service import (
    RecipientSpec,
    WecomPushResult,
    push_share_link,
)

wecom_public_router = APIRouter()
wecom_share_router = APIRouter()


def _err(exc: WecomError) -> HTTPException:
    """将企微异常映射为前端可读的 HTTP 错误（detail 为字符串，全局拦截器直接 toast）。"""
    if isinstance(exc, WecomNotConfiguredError):
        return HTTPException(status_code=501, detail=str(exc))
    if isinstance(exc, WecomAPIError):
        return HTTPException(
            status_code=502,
            detail=f"企业微信接口调用失败（errcode={exc.errcode}）：{exc.errmsg}",
        )
    return HTTPException(status_code=502, detail=str(exc))


@wecom_public_router.get("/users", response_model=ResponseModel)
async def get_wecom_users(
    keyword: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    try:
        users = await list_wecom_users(keyword)
    except WecomError as e:
        raise _err(e) from e
    return ResponseModel(data=users)


@wecom_public_router.get("/departments", response_model=ResponseModel)
async def get_wecom_departments(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    try:
        departments = await list_wecom_departments()
    except WecomError as e:
        raise _err(e) from e
    return ResponseModel(data=departments)


@wecom_public_router.post("/test-connection", response_model=ResponseModel)
async def test_connection(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail={"code": 1003, "message": "仅管理员可调用"})
    try:
        users = await list_wecom_users()
    except WecomError as e:
        raise _err(e) from e
    return ResponseModel(data={"user_count": len(users)})


class SendWecomRequest(BaseModel):
    user_ids: list[str] = []


@wecom_share_router.post(
    "/{share_id}/send-wecom",
    response_model=ResponseModel,
)
async def send_share_to_wecom(
    share_id: int,
    payload: SendWecomRequest,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("topbar.share", "read")),
):
    link: ShareLink | None = await db.get(ShareLink, share_id)
    if not link:
        raise HTTPException(status_code=404, detail={"code": 1004, "message": "分享链接不存在"})
    if link.is_revoked:
        raise HTTPException(status_code=400, detail={"code": 1005, "message": "链接已撤销"})

    settings = get_wecom_client()._settings
    base_url = getattr(settings, "frontend_base_url", None) or "http://localhost:3000"
    if base_url and not base_url.startswith(("http://", "https://")):
        base_url = "http://" + base_url
    share_url = f"{base_url}/share/{link.token}"

    user_recipients = [RecipientSpec(id=uid) for uid in payload.user_ids]

    aggregated = WecomPushResult()
    try:
        if user_recipients:
            r = await push_share_link(db, link, user_recipients, share_url)
            aggregated.success += r.success
            aggregated.failed.extend(r.failed)
    except WecomError as e:
        raise _err(e) from e

    return ResponseModel(data=aggregated.to_dict())
