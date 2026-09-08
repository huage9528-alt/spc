import uuid
from datetime import datetime, timedelta
from urllib.parse import quote
from fastapi import APIRouter, Depends, Form, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from typing import Optional

from pydantic import BaseModel

from app.core.database import get_db
from app.core.config import get_settings
from app.core.security import verify_password, get_password_hash, create_access_token, decode_access_token, oauth2_scheme
from app.core.dependencies import get_current_user
from app.core.audit import log_audit
from app.core.permissions import merge_role_permission_additions
from app.core.token_blacklist import add_token_to_blacklist
from app.core.permission_cache import invalidate_user_payload
from app.models.basicdata.user import SysUser, SysRole
from app.models.basicdata.supplier import Supplier
from app.models.basicdata.employee import Employee
from app.services.basicdata.wecom.client import get_wecom_client
from app.services.basicdata.wecom.exceptions import WecomAPIError, WecomNotConfiguredError
from app.schemas.basicdata.schemas import TokenResponse, UserInfo
from app.schemas.common import ResponseModel

router = APIRouter()

VALID_LOGIN_TYPES = {"employee", "supplier"}


def _bump_channel_session(user: SysUser, channel: str) -> tuple[str, int]:
    """递增指定渠道的会话版本并轮换 jti，返回 (new_jti, new_version)。

    所有渠道（web / wecom / 未来新端）统一存于 channel_sessions JSON：
    同渠道每次登录版本递增，旧 token 随之失效；跨渠道版本独立、互不影响。
    """
    sessions = dict(user.channel_sessions or {})
    sess = dict(sessions.get(channel) or {})
    new_jti = str(uuid.uuid4())
    sessions[channel] = {
        "version": int(sess.get("version") or 0) + 1,
        "last_jti": new_jti,
    }
    user.channel_sessions = sessions
    return new_jti, sessions[channel]["version"]


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


class UpdatePreferencesRequest(BaseModel):
    font_size_scale: Optional[str] = None
    ui_preferences: Optional[dict] = None


class UpdateProfileRequest(BaseModel):
    display_name: str


class WecomLoginRequest(BaseModel):
    code: str
    channel: Optional[str] = None


@router.post("/login", response_model=ResponseModel[TokenResponse])
async def login(
        form: OAuth2PasswordRequestForm = Depends(),
        login_type: str = Form("employee"),
        channel: str = Form("web"),
        remember_me: bool = Form(False),
        db: AsyncSession = Depends(get_db),
):
    login_type = (login_type or "employee").strip().lower()
    if login_type not in VALID_LOGIN_TYPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="登录类型不正确")

    channel = (channel or "web").strip().lower() or "web"

    if form.username == "sys-api-caller":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误")

    result = await db.execute(
        select(SysUser).where(SysUser.username == form.username, SysUser.is_active == True).with_for_update()
    )
    user = result.scalar_one_or_none()
    if not user or not verify_password(form.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误")

    role_result = await db.execute(select(SysRole).where(SysRole.id == user.role_id))
    role = role_result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="用户角色配置异常，请联系管理员")

    is_supplier_account = role.role_code == "supplier"
    if login_type == "supplier" and not is_supplier_account:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="当前账号不是供应商账号，请选择内部员工登录")
    if login_type == "employee" and is_supplier_account:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="当前账号为供应商账号，请选择供应商登录")

    supplier_code = None
    if is_supplier_account:
        if not user.supplier_name:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="供应商账号未绑定供应商")
        supplier_result = await db.execute(
            select(Supplier).where(
                Supplier.supplier_name == user.supplier_name,
                Supplier.status == 1,
            )
        )
        supplier = supplier_result.scalar_one_or_none()
        if not supplier:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="绑定供应商不存在或已停用")
        supplier_code = supplier.supplier_code

    user.last_login_time = datetime.now()
    old_token_jti = (user.channel_sessions or {}).get(channel, {}).get("last_jti")
    new_jti, login_version = _bump_channel_session(user, channel)

    permissions = merge_role_permission_additions(role.role_code, role.permissions)

    token_payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": role.role_code,
        "login_type": login_type,
        "supplier_name": user.supplier_name if is_supplier_account else None,
        "auth_channel": channel,
        "login_version": login_version,
        "jti": new_jti,
    }
    if supplier_code:
        token_payload["supplier_code"] = supplier_code

    token = create_access_token(
        data=token_payload,
        expires_delta=timedelta(days=7) if remember_me else None,
    )

    await db.commit()

    if old_token_jti:
        try:
            await add_token_to_blacklist(old_token_jti)
        except Exception:
            pass

    try:
        await invalidate_user_payload(user.id, channel)
    except Exception:
        pass

    return ResponseModel(data=TokenResponse(access_token=token))


@router.get("/wecom-qr-config", response_model=ResponseModel[dict])
async def wecom_qr_config():
    """返回企业微信 Web 扫码登录 SDK 初始化所需的非敏感配置（公开，登录前调用）。
    enabled=False 时前端隐藏二维码面板，回退纯账密登录。"""
    settings = get_settings()
    corp_id = settings.wecom_corp_id or ""
    agent_id = settings.wecom_agent_id or ""
    return ResponseModel(data={
        "enabled": bool(corp_id and agent_id),
        "corp_id": corp_id,
        "agent_id": agent_id,
        "state": "sso",
    })


def _build_wecom_oauth_url(redirect_path: str = "/login", state: str = "sso") -> str:
    """构造企业微信静默授权 URL，回跳 {redirect_path}?code=xxx&state={state}"""
    settings = get_settings()
    corp_id = settings.wecom_corp_id
    if not corp_id:
        raise HTTPException(status_code=501, detail="企业微信未配置")
    base_url = (settings.frontend_base_url or "http://localhost:3000").rstrip("/")
    redirect_uri = quote(f"{base_url}{redirect_path}", safe="")
    return (
        f"https://open.weixin.qq.com/connect/oauth2/authorize"
        f"?appid={corp_id}"
        f"&redirect_uri={redirect_uri}"
        f"&response_type=code"
        f"&scope=snsapi_base"
        f"&state={state}#wechat_redirect"
    )


WECOM_OAUTH_REDIRECT_WHITELIST = ("/login", "/profile", "/m/", "/m/login")


@router.get("/wecom-oauth-url", response_model=ResponseModel[dict])
async def wecom_oauth_url(state: Optional[str] = None, redirect_path: str = "/login"):
    """返回企业微信静默授权跳转地址（公开，登录前调用）。
    state 可由前端传入随机 nonce，回跳时原样带回以校验 CSRF。
    redirect_path 仅允许白名单内的前端路径。"""
    if redirect_path not in WECOM_OAUTH_REDIRECT_WHITELIST:
        raise HTTPException(status_code=400, detail=f"redirect_path 仅允许 {'/'.join(WECOM_OAUTH_REDIRECT_WHITELIST)}")
    return ResponseModel(data={"oauth_url": _build_wecom_oauth_url(redirect_path=redirect_path, state=state or "sso")})


@router.post("/wecom-login", response_model=ResponseModel[TokenResponse])
async def wecom_login(body: WecomLoginRequest, db: AsyncSession = Depends(get_db)):
    """企业微信 OAuth 登录：code → userid → 绑定的系统用户 → 发 JWT。"""
    client = get_wecom_client()
    try:
        userinfo = await client.get_userinfo_by_code(body.code)
    except WecomNotConfiguredError as e:
        raise HTTPException(status_code=501, detail=str(e)) from e
    except WecomAPIError as e:
        raise HTTPException(
            status_code=401,
            detail=f"企业微信登录失败（code 无效或已过期，errcode={e.errcode}）",
        ) from e

    wecom_userid = userinfo.get("UserId") or userinfo.get("userid")
    if not wecom_userid:
        raise HTTPException(status_code=401, detail="无法获取企业微信身份（可能非企业成员）")

    result = await db.execute(
        select(SysUser).where(SysUser.wecom_user_id == wecom_userid, SysUser.is_active == True).with_for_update()
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(
            status_code=403,
            detail="企业微信账号未绑定系统用户，请联系管理员在用户管理中绑定",
        )

    role_result = await db.execute(select(SysRole).where(SysRole.id == user.role_id))
    role = role_result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=500, detail="用户角色配置异常，请联系管理员")
    if role.role_code == "supplier":
        raise HTTPException(status_code=403, detail="供应商账号不支持企业微信登录")

    # 所有渠道走同一套逻辑（_bump_channel_session）：同渠道互斥、跨渠道并存
    channel = (body.channel or "wecom").strip().lower() or "wecom"
    user.last_login_time = datetime.now()
    old_token_jti = (user.channel_sessions or {}).get(channel, {}).get("last_jti")
    new_jti, login_version = _bump_channel_session(user, channel)

    token_payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": role.role_code,
        "login_type": "employee",
        "supplier_name": None,
        "auth_channel": channel,
        "login_version": login_version,
        "jti": new_jti,
    }
    token = create_access_token(data=token_payload)

    await db.commit()

    if old_token_jti:
        try:
            await add_token_to_blacklist(old_token_jti)
        except Exception:
            pass

    try:
        await invalidate_user_payload(user.id, channel)
    except Exception:
        pass

    return ResponseModel(data=TokenResponse(access_token=token))


@router.get("/wecom-bind-url", response_model=ResponseModel[dict])
async def wecom_bind_url():
    """返回绑定企业微信的 OAuth 跳转地址（需登录，回跳 /profile?code=xxx&state=bind）。"""
    return ResponseModel(data={"oauth_url": _build_wecom_oauth_url(redirect_path="/profile", state="bind")})


@router.post("/wecom-bind", response_model=ResponseModel[dict])
async def wecom_bind(
        body: WecomLoginRequest,
        current_user: dict = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    """企业微信绑定/换绑：OAuth code → userid → 写回当前用户（供应商账号禁止）。"""
    result = await db.execute(
        select(SysUser, SysRole)
        .join(SysRole, SysUser.role_id == SysRole.id)
        .where(SysUser.id == current_user["user_id"])
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="用户不存在")
    user, role = row
    if role.role_code == "supplier":
        raise HTTPException(status_code=403, detail="供应商账号不支持绑定企业微信")

    client = get_wecom_client()
    try:
        userinfo = await client.get_userinfo_by_code(body.code)
    except WecomNotConfiguredError as e:
        raise HTTPException(status_code=501, detail=str(e)) from e
    except WecomAPIError as e:
        raise HTTPException(
            status_code=401,
            detail=f"企业微信授权失败（code 无效或已过期，errcode={e.errcode}）",
        ) from e

    wecom_userid = userinfo.get("UserId") or userinfo.get("userid")
    if not wecom_userid:
        raise HTTPException(status_code=400, detail="无法获取企业微信身份")

    # 唯一性：该企微账号至多绑定一个系统用户
    dup_result = await db.execute(
        select(SysUser.id).where(
            SysUser.wecom_user_id == wecom_userid,
            SysUser.id != user.id,
        )
    )
    if dup_result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=400, detail="该企业微信账号已绑定其他系统用户，请联系管理员处理")

    user.wecom_user_id = wecom_userid
    await log_audit(db, "sys_user", user.id, "update", field_name="wecom_user_id", operator=current_user["username"])
    await db.commit()
    return ResponseModel(data={"wecom_user_id": wecom_userid, "message": "企业微信绑定成功"})


@router.delete("/wecom-bind", response_model=ResponseModel[dict])
async def wecom_unbind(
        current_user: dict = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(SysUser).where(SysUser.id == current_user["user_id"]))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    user.wecom_user_id = None
    await log_audit(db, "sys_user", user.id, "update", field_name="wecom_user_id", operator=current_user["username"])
    await db.commit()
    return ResponseModel(data={"message": "企业微信已解绑"})


@router.get("/me", response_model=ResponseModel[UserInfo])
async def get_me(current_user: dict = Depends(get_current_user), token: str = Depends(oauth2_scheme), db: AsyncSession = Depends(get_db)):
    # 从当前 token 解出渠道版本，避免硬编码 web 渠道（不同端登录返回各自渠道版本）
    me_payload = decode_access_token(token)
    result = await db.execute(
        select(SysUser, SysRole)
        .join(SysRole, SysUser.role_id == SysRole.id)
        .where(SysUser.id == current_user["user_id"])
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="用户不存在")
    user, role = row
    supplier_code = None
    if role.role_code == "supplier" and user.supplier_name:
        supplier_result = await db.execute(
            select(Supplier.supplier_code).where(
                Supplier.supplier_name == user.supplier_name,
                Supplier.status == 1,
            )
        )
        supplier_code = supplier_result.scalar_one_or_none()

    settings = get_settings()
    has_logged_in = bool(user.channel_sessions)
    if has_logged_in and user.is_default_password == True:
        is_default = verify_password(settings.ERP_SYNC_DEFAULT_PASSWORD, user.hashed_password)
    else:
        is_default = user.is_default_password

    # 获取关联员工的岗位名称；员工未关联时回退到角色名称
    position_name = None
    if user.emp_code:
        emp_result = await db.execute(
            select(Employee.position).where(Employee.emp_code == user.emp_code)
        )
        position_name = emp_result.scalar_one_or_none()
    if not position_name:
        position_name = role.role_name

    return ResponseModel(data=UserInfo(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role_code=role.role_code,
        role_name=role.role_name,
        permissions=merge_role_permission_additions(role.role_code, role.permissions),
        supplier_name=user.supplier_name,
        supplier_code=supplier_code,
        font_size_scale=user.font_size_scale,
        ui_preferences=user.ui_preferences,
        is_default_password=is_default,
        login_version=me_payload.get("login_version", 0),
        position_name=position_name,
        wecom_user_id=user.wecom_user_id,
    ))


@router.put("/change-password", response_model=ResponseModel[dict])
async def change_password(
        body: ChangePasswordRequest,
        current_user: dict = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(SysUser).where(SysUser.id == current_user["user_id"]))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    if not verify_password(body.old_password, user.hashed_password):
        raise HTTPException(status_code=400, detail="原密码错误")

    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="新密码长度不能少于6位")

    if body.old_password == body.new_password:
        raise HTTPException(status_code=400, detail="新密码不能与原密码相同")

    user.hashed_password = get_password_hash(body.new_password)
    user.is_default_password = False
    await log_audit(db, "sys_user", user.id, "update", field_name="password", operator=current_user["username"])
    await db.commit()
    return ResponseModel(data={"id": user.id, "message": "密码修改成功"})


@router.put("/preferences", response_model=ResponseModel[dict])
async def update_preferences(
        body: UpdatePreferencesRequest,
        current_user: dict = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(SysUser).where(SysUser.id == current_user["user_id"]))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    if body.font_size_scale is not None:
        user.font_size_scale = body.font_size_scale
    if body.ui_preferences is not None:
        user.ui_preferences = body.ui_preferences
    await db.commit()
    return ResponseModel(data={"id": user.id, "message": "偏好设置已更新"})


@router.put("/profile", response_model=ResponseModel[dict])
async def update_profile(
        body: UpdateProfileRequest,
        current_user: dict = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    name = (body.display_name or "").strip()
    if not name or len(name) > 50:
        raise HTTPException(status_code=400, detail="显示姓名不能为空且不超过50个字符")

    result = await db.execute(select(SysUser).where(SysUser.id == current_user["user_id"]))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    user.display_name = name
    await log_audit(db, "sys_user", user.id, "update", field_name="display_name", operator=current_user["username"])
    await db.commit()
    return ResponseModel(data={"id": user.id, "display_name": name, "message": "个人资料已更新"})
