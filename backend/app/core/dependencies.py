from dataclasses import dataclass
from typing import Optional

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import oauth2_scheme, decode_access_token, verify_channel_version
from app.core.token_blacklist import is_token_blacklisted
from app.core.permissions import merge_role_permission_additions
from app.models.basicdata.user import SysUser, SysRole
from app.models.basicdata.supplier import Supplier
from app.models.basicdata.employee import Employee
from app.services.basicdata.org_scope_service import resolve_user_org_scopes


async def _build_user_info(db: AsyncSession, user: SysUser, user_id, username, role, supplier_code) -> dict:
    """构建当前用户信息字典，包含 oa_user_id 和 org_scope_ids"""
    # 查询角色权限
    role_result = await db.execute(
        select(SysRole.role_code, SysRole.permissions)
        .join(SysUser, SysUser.role_id == SysRole.id)
        .where(SysUser.id == int(user_id))
    )
    row = role_result.one_or_none()
    role_code = row[0] if row else role
    permissions = row[1] if row and row[1] else {}
    if not isinstance(permissions, dict):
        permissions = {}
    permissions = merge_role_permission_additions(role_code, permissions)

    # 供应商用户处理
    if role_code == "supplier" and user.supplier_name and not supplier_code:
        supplier_result = await db.execute(
            select(Supplier.supplier_code).where(
                Supplier.supplier_name == user.supplier_name,
                Supplier.status == 1,
            )
        )
        supplier_code = supplier_result.scalar_one_or_none()

    # 查询当前用户的 oa_user_id
    oa_user_id = None
    if user.emp_code:
        emp_result = await db.execute(
            select(Employee.oa_user_id).where(Employee.emp_code == user.emp_code)
        )
        oa_user_id = emp_result.scalar_one_or_none()

    # 查询当前用户的组织数据范围
    org_scope_ids = await resolve_user_org_scopes(db, int(user_id))

    return {
        "user_id": int(user_id),
        "username": username,
        "role": role_code,
        "permissions": permissions,
        "supplier_name": user.supplier_name,
        "supplier_code": supplier_code,
        "oa_user_id": oa_user_id,
        "org_scope_ids": org_scope_ids,
    }


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> dict:
    payload = decode_access_token(token)
    is_share = payload.get("share", False)

    # 分享 token：跳过 login_version 校验和权限检查
    if is_share:
        user_id = payload.get("sub")
        share_target_path = payload.get("share_target_path", "")
        return {
            "user_id": int(user_id) if user_id else 0,
            "username": "share_user",
            "role": "share",
            "permissions": {},
            "is_share": True,
            "share_target_path": share_target_path,
            "oa_user_id": None,
            "org_scope_ids": set(),
        }

    # 正常用户认证流程
    user_id = payload.get("sub")
    username = payload.get("username")
    role = payload.get("role")
    supplier_code = payload.get("supplier_code")
    token_jti = payload.get("jti")

    if not user_id:
        from fastapi import HTTPException, status
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="无效的认证凭据",
        )

    if token_jti:
        try:
            if await is_token_blacklisted(token_jti):
                from fastapi import HTTPException, status
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="您的账号已在其他设备登录，请重新登录",
                    headers={"X-Force-Logout": "true"},
                )
        except Exception:
            pass

    result = await db.execute(select(SysUser).where(SysUser.id == int(user_id)))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        from fastapi import HTTPException, status
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户不存在或已禁用",
        )

    verify_channel_version(user, payload)

    return await _build_user_info(db, user, user_id, username, role, supplier_code)


async def get_current_user_or_share(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """获取当前用户，支持分享 token 访问。
    分享 token 的 JWT 中包含 share=True 标记，跳过权限检查和 login_version 校验。"""
    payload = decode_access_token(token)
    is_share = payload.get("share", False)

    if is_share:
        # 分享访问：跳过 login_version 校验和权限检查
        user_id = payload.get("sub")
        share_target_path = payload.get("share_target_path", "")
        return {
            "user_id": int(user_id) if user_id else 0,
            "username": "share_user",
            "role": "share",
            "permissions": {},
            "is_share": True,
            "share_target_path": share_target_path,
            "oa_user_id": None,
            "org_scope_ids": set(),
        }

    # 正常用户认证流程
    user_id = payload.get("sub")
    username = payload.get("username")
    role = payload.get("role")
    supplier_code = payload.get("supplier_code")
    token_jti = payload.get("jti")

    if not user_id:
        from fastapi import HTTPException, status
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="无效的认证凭据",
        )

    if token_jti:
        try:
            if await is_token_blacklisted(token_jti):
                from fastapi import HTTPException, status
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="您的账号已在其他设备登录，请重新登录",
                    headers={"X-Force-Logout": "true"},
                )
        except Exception:
            pass

    result = await db.execute(select(SysUser).where(SysUser.id == int(user_id)))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        from fastapi import HTTPException, status
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户不存在或已禁用",
        )

    verify_channel_version(user, payload)

    return await _build_user_info(db, user, user_id, username, role, supplier_code)


@dataclass
class AuthContext:
    """统一鉴权上下文：JWT 与 API Key 二选一。

    Note: 本轮实现未将 get_current_user_or_api_key 返回类型改为 AuthContext，
    以保持现有 handler 中 current_user["user_id"] 等下标访问兼容。
    后续如需引入按调用方分派的 handler 行为，可在此类型上扩展。
    """
    user: Optional[dict] = None
    api_key: object = None

    @property
    def is_api_key(self) -> bool:
        return self.api_key is not None


async def _get_or_load_sys_api_user(db: AsyncSession) -> dict:
    """加载 sys-api-caller 占位用户；未初始化则抛 500。"""
    result = await db.execute(
        select(SysUser).where(SysUser.username == "sys-api-caller")
    )
    user = result.scalar_one_or_none()
    if not user:
        from fastapi import HTTPException, status
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="sys-api-caller 占位用户未初始化，请运行 init_database.py",
        )

    return await _build_user_info(
        db, user,
        user_id=str(user.id),
        username="sys-api-caller",
        role="api_caller",
        supplier_code=None,
    )


def _resolve_endpoint_code_from_request(request: Request) -> Optional[str]:
    """根据 request.scope["route"] 反查 endpoint_code；未注册返回 None。"""
    from app.services.basicdata.exposable_registry import resolve_endpoint_code
    route = request.scope.get("route")
    if route is None:
        return None
    return resolve_endpoint_code(request.method, route.path)


async def _authenticate_via_api_key(request: Request, db: AsyncSession):
    """返回 (api_key_obj, sys_api_user_dict)；任一环节失败返回 None。"""
    import time
    from app.services.basicdata.data_supply_service import (
        validate_signature_for_exposable,
        check_ip_whitelist,
        log_call,
    )
    from app.services.basicdata.rate_limiter import check_rate_limit, RATE_LIMITED_MARK

    app_key = request.headers.get("x-app-key")
    timestamp = request.headers.get("x-timestamp")
    signature = request.headers.get("x-signature")
    if not (app_key and timestamp and signature):
        return None

    endpoint_code = _resolve_endpoint_code_from_request(request)
    if not endpoint_code:
        return None

    auth_start = time.time()
    key_obj, reason = await validate_signature_for_exposable(
        db, app_key, signature, timestamp, endpoint_code,
        request_query_string=str(request.url.query),
    )
    if not key_obj:
        return None

    client_ip = request.client.host if request.client else None
    if client_ip and not check_ip_whitelist(key_obj, client_ip):
        return None

    allowed, retry_after = await check_rate_limit(key_obj.id, key_obj.rate_limit)
    if not allowed:
        try:
            await log_call(
                db=db, api_key_id=key_obj.id, api_key_name=key_obj.key_name,
                data_type=endpoint_code,
                request_params={"path": request.url.path, "query": str(request.url.query)},
                response_status=429, response_count=0,
                ip_address=client_ip,
                user_agent=request.headers.get("user-agent"),
                duration_ms=(time.time() - auth_start) * 1000,
                error_message=RATE_LIMITED_MARK,
            )
        except Exception:
            pass
        raise HTTPException(
            status_code=429,
            detail=f"请求超过每分钟限额 {key_obj.rate_limit} 次，请 {retry_after} 秒后重试",
            headers={"Retry-After": str(retry_after)},
        )

    sys_user = await _get_or_load_sys_api_user(db)

    duration_ms = (time.time() - auth_start) * 1000
    try:
        await log_call(
            db=db,
            api_key_id=key_obj.id,
            api_key_name=key_obj.key_name,
            data_type=endpoint_code,
            request_params={"path": request.url.path, "query": str(request.url.query)},
            response_status=200,
            response_count=0,
            ip_address=client_ip,
            user_agent=request.headers.get("user-agent"),
            duration_ms=duration_ms,
        )
    except Exception:
        pass

    return key_obj, sys_user


def _extract_bearer_token(request: Request) -> Optional[str]:
    """从 Authorization 头解析 Bearer token；不存在或格式错误返回 None。"""
    auth_header = request.headers.get("authorization")
    if not auth_header:
        return None
    parts = auth_header.strip().split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


async def get_current_user_or_api_key(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """JWT 与 HMAC 二选一。

    优先级：
      1) 请求头存在 X-App-Key -> HMAC（外部调用不容忍身份冒充）；
      2) 否则 -> JWT。

    HMAC 命中时把 request.state.current_user 设为 sys-api-caller（拥有全部权限），
    使现有 PermissionChecker 无需修改即可放行。
    """
    if request.headers.get("x-app-key"):
        result = await _authenticate_via_api_key(request, db)
        if result is None:
            from fastapi import HTTPException, status
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="API Key 签名认证失败或该路径未对外开放",
            )
        key_obj, sys_user = result
        request.state.current_user = sys_user
        request.state.auth_source = "api_key"
        request.state.api_key = key_obj
        return sys_user

    token = _extract_bearer_token(request)
    if not token:
        # 与 oauth2_scheme 行为对齐：缺 Authorization 头直接 401，
        # 否则 decode_access_token(None) 会抛 AttributeError 变成 500
        from fastapi import HTTPException, status
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = await get_current_user(token=token, db=db)
    request.state.current_user = user
    request.state.auth_source = "jwt"
    return user
