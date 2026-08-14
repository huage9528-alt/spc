"""基础数据与集成中心 — 页面分享链接 API"""

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.security import PermissionChecker, create_share_access_token
from app.models.basicdata.share_link import ShareLink
from app.models.basicdata.share_link_recipient import ShareLinkRecipient
from app.schemas.common import ResponseModel
from app.services.basicdata.wecom.client import get_wecom_client
from app.services.basicdata.wecom.exceptions import WecomNotConfiguredError
from app.services.basicdata.wecom.send_service import (
    RecipientSpec,
    WecomPushResult,
    push_share_link,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ──

class ShareRecipient(BaseModel):
    user_ids: list[str] = []


class ShareCreateRequest(BaseModel):
    target_path: str
    target_params: Optional[dict] = None
    expires_in: Optional[str] = "30d"  # "7d" | "30d" | "90d" | "permanent"
    permissions: Optional[list[str]] = ["read"]  # ["read","create","update","delete"]
    reason: Optional[str] = None
    auto_send_wecom: bool = False
    recipient: Optional[ShareRecipient] = None


class ShareVerifyResponse(BaseModel):
    access_token: str
    target_path: str
    target_params: Optional[dict] = None
    permissions: Optional[list[str]] = None
    oauth_url: Optional[str] = None
    oauth_required: bool = False


class ShareListItem(BaseModel):
    id: int
    token: str
    target_path: str
    target_params: Optional[dict] = None
    permissions: Optional[list[str]] = None
    reason: Optional[str] = None
    expires_at: Optional[datetime] = None
    is_revoked: bool
    access_count: int
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Helpers ──

_EXPIRES_MAP = {
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
    "90d": timedelta(days=90),
    "permanent": None,
}


def _generate_token() -> str:
    return secrets.token_urlsafe(24)


def _get_user_id(current_user: dict) -> int:
    return int(current_user.get("user_id") or current_user["sub"])


def _build_oauth_url(share: ShareLink) -> str:
    """构造企微 OAuth 静默授权 URL，回跳 /share/{token}?code=xxx"""
    settings = get_settings()
    corp_id = settings.wecom_corp_id
    base_url = settings.frontend_base_url or "http://localhost:3000"
    if base_url and not base_url.startswith(("http://", "https://")):
        base_url = "http://" + base_url
    redirect_uri = quote(f"{base_url}/share/{share.token}", safe="")
    return (
        f"https://open.weixin.qq.com/connect/oauth2/authorize"
        f"?appid={corp_id}"
        f"&redirect_uri={redirect_uri}"
        f"&response_type=code"
        f"&scope=snsapi_base"
        f"&state={share.token}#wechat_redirect"
    )


async def _has_recipients(db: AsyncSession, share_id: int) -> bool:
    result = await db.execute(
        select(ShareLinkRecipient.id).where(
            ShareLinkRecipient.share_link_id == share_id
        ).limit(1)
    )
    return result.scalar_one_or_none() is not None


async def _is_authorized_recipient(db: AsyncSession, share_id: int, wecom_userid: str) -> bool:
    result = await db.execute(
        select(ShareLinkRecipient.id).where(
            ShareLinkRecipient.share_link_id == share_id,
            ShareLinkRecipient.recipient_id == wecom_userid,
        ).limit(1)
    )
    return result.scalar_one_or_none() is not None


async def _recipient_ids(db: AsyncSession, share_id: int) -> list[str]:
    result = await db.execute(
        select(ShareLinkRecipient.recipient_id).where(
            ShareLinkRecipient.share_link_id == share_id
        )
    )
    return list(result.scalars().all())


# ── Endpoints ──

@router.post("", response_model=ResponseModel[dict])
async def create_share_link(
    body: ShareCreateRequest,
    current_user: dict = Depends(PermissionChecker("topbar.share", "read")),
    db: AsyncSession = Depends(get_db),
):
    """创建分享链接（需登录）"""
    delta = _EXPIRES_MAP.get(body.expires_in, timedelta(days=30))
    expires_at = datetime.now(timezone.utc) + delta if delta else None

    token = _generate_token()
    share = ShareLink(
        token=token,
        target_path=body.target_path,
        target_params=body.target_params,
        permissions=body.permissions,
        reason=body.reason,
        created_by=_get_user_id(current_user),
        expires_at=expires_at,
    )
    db.add(share)
    await db.flush()

    wecom_delivery = None
    if body.auto_send_wecom and body.recipient:
        client = get_wecom_client()
        base_url = client._settings.frontend_base_url or "http://localhost:3000"
        if base_url and not base_url.startswith(("http://", "https://")):
            base_url = "http://" + base_url
        share_url = f"{base_url}/share/{token}"
        user_recs = [RecipientSpec(id=uid) for uid in body.recipient.user_ids]
        aggregated = WecomPushResult()
        try:
            if user_recs:
                r = await push_share_link(db, share, user_recs, share_url)
                aggregated.success += r.success
                aggregated.failed.extend(r.failed)
        except WecomNotConfiguredError as e:
            raise HTTPException(status_code=501, detail={"code": 1001, "message": str(e)})
        wecom_delivery = aggregated.to_dict()

    return ResponseModel(data={
        "id": share.id,
        "token": token,
        "share_url": f"/share/{token}",
        "expires_at": expires_at.isoformat() if expires_at else None,
        "wecom_delivery": wecom_delivery,
    })


@router.get("/list", response_model=ResponseModel[list[ShareListItem]])
async def list_share_links(
    current_user: dict = Depends(PermissionChecker("topbar.share", "read")),
    db: AsyncSession = Depends(get_db),
):
    """查询我创建的分享链接（需登录）"""
    result = await db.execute(
        select(ShareLink)
        .where(ShareLink.created_by == _get_user_id(current_user))
        .order_by(ShareLink.created_at.desc())
    )
    items = result.scalars().all()
    return ResponseModel(data=[ShareListItem.model_validate(item) for item in items])


@router.get("/{token}", response_model=ResponseModel[ShareVerifyResponse])
async def verify_share_link(
    token: str,
    code: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """验证分享链接，签发临时 JWT（无需登录）

    有收件人的分享为限制型：必须通过企微 OAuth code 换取访问者身份，
    且该 userid 必须在收件人列表中，否则拒绝。
    """
    result = await db.execute(
        select(ShareLink).where(ShareLink.token == token)
    )
    share = result.scalar_one_or_none()

    if not share:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="分享链接不存在")

    if share.is_revoked:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="分享链接已被撤销")

    if share.expires_at and share.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="分享链接已过期")

    restricted = await _has_recipients(db, share.id)
    if restricted:
        if not code:
            oauth_url = _build_oauth_url(share)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"code": 1006, "message": "需要企业微信身份验证", "oauth_url": oauth_url},
            )
        client = get_wecom_client()
        try:
            userinfo = await client.get_userinfo_by_code(code)
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"code": 1007, "message": "企业微信身份验证失败，请在企业微信中打开", "oauth_url": _build_oauth_url(share)},
            )
        wecom_userid = userinfo.get("UserId") or userinfo.get("userid")
        logger.info(f"[share] OAuth code 换身份: token={token} userinfo={userinfo} userid={wecom_userid}")
        if not wecom_userid or not await _is_authorized_recipient(db, share.id, wecom_userid):
            logger.warning(f"[share] 授权拒绝: token={token} userid={wecom_userid} recipients={await _recipient_ids(db, share.id)}")
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="您不在该分享的授权范围内",
            )

    # 增加访问计数
    await db.execute(
        update(ShareLink)
        .where(ShareLink.id == share.id)
        .values(access_count=ShareLink.access_count + 1)
    )
    await db.flush()

    # 签发临时 JWT，标记为分享访问
    share_permissions = share.permissions or ["read"]
    access_token = create_share_access_token(data={
        "sub": str(share.created_by),
        "share_target_path": share.target_path,
        "share_token": share.token,
        "share_permissions": share_permissions,
    })

    return ResponseModel(data=ShareVerifyResponse(
        access_token=access_token,
        target_path=share.target_path,
        target_params=share.target_params,
        permissions=share_permissions,
        oauth_url=_build_oauth_url(share) if restricted else None,
        oauth_required=False,
    ))


@router.delete("/{share_id}", response_model=ResponseModel[dict])
async def revoke_share_link(
    share_id: int,
    current_user: dict = Depends(PermissionChecker("topbar.share", "read")),
    db: AsyncSession = Depends(get_db),
):
    """撤销分享链接（仅创建者可操作）"""
    result = await db.execute(
        select(ShareLink).where(ShareLink.id == share_id)
    )
    share = result.scalar_one_or_none()

    if not share:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="分享链接不存在")

    if share.created_by != _get_user_id(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="只能撤销自己创建的分享链接")

    share.is_revoked = True
    await db.flush()

    return ResponseModel(data={"id": share.id, "message": "分享链接已撤销"})
