from datetime import datetime, timedelta, timezone
from typing import Optional
import uuid

from jose import JWTError, jwt
import bcrypt
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.models.basicdata.user import SysUser, SysRole
from app.models.basicdata.supplier import Supplier
from app.models.basicdata.employee import Employee
from app.services.basicdata.org_scope_service import resolve_user_org_scopes

settings = get_settings()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_PREFIX}/auth/login")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(
        plain_password.encode("utf-8"), hashed_password.encode("utf-8")
    )


def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(
        password.encode("utf-8"), bcrypt.gensalt()
    ).decode("utf-8")


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    if "jti" not in to_encode:
        to_encode["jti"] = str(uuid.uuid4())
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_access_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        return payload
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="无效的认证凭据",
            headers={"WWW-Authenticate": "Bearer"},
        )


def resolve_channel_login_version(user, token_channel: str) -> int:
    """按渠道读取登录版本号：所有渠道统一存于 channel_sessions JSON。

    同渠道每次登录版本递增，旧 token 携带的版本与当前版本不一致即失效；
    跨渠道版本互相独立，互不影响。"""
    sessions = user.channel_sessions or {}
    return int((sessions.get(token_channel) or {}).get("version", 0) or 0)


def verify_channel_version(user, payload: dict) -> int:
    """校验 token 携带的渠道版本与 DB 当前版本一致；不一致抛 401（X-Force-Logout）。

    返回 DB 当前版本号。供所有鉴权点（dependencies / PermissionChecker / schedule_plans）共用，
    避免版本校验逻辑四处复制。"""
    token_channel = payload.get("auth_channel", "web")
    token_login_version = payload.get("login_version", 0)
    db_login_version = resolve_channel_login_version(user, token_channel)
    if token_login_version != db_login_version:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="您的账号已在其他设备登录，请重新登录",
            headers={"X-Force-Logout": "true"},
        )
    return db_login_version


def create_share_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """为分享链接访问签发临时 JWT，包含 share 标记，有效期 24 小时"""
    to_encode = data.copy()
    to_encode["share"] = True
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(hours=24))
    to_encode.update({"exp": expire})
    if "jti" not in to_encode:
        to_encode["jti"] = str(uuid.uuid4())
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


class RoleChecker:
    """角色校验依赖，用法: Depends(RoleChecker(["admin", "operator"]))"""

    def __init__(self, allowed_roles: list[str]):
        self.allowed_roles = allowed_roles

    def __call__(self, token: str = Depends(oauth2_scheme)):
        payload = decode_access_token(token)
        role = payload.get("role", "")
        if role not in self.allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="权限不足",
            )
        return payload


async def _get_share_path_to_resource(db: AsyncSession) -> dict[str, str]:
    """从 sys_permission 表动态获取 route_path → code 映射，替代硬编码的 _SHARE_PATH_TO_RESOURCE"""
    from app.models.basicdata.permission import SysPermission
    result = await db.execute(
        select(SysPermission.code, SysPermission.route_path)
        .where(SysPermission.route_path.isnot(None), SysPermission.is_active == True)
    )
    return {row[1]: row[0] for row in result.all() if row[1]}


# 保留硬编码映射作为 fallback（数据库不可用时使用）
_SHARE_PATH_TO_RESOURCE: dict[str, str] = {
    "/dashboard": "dashboard",
    "/orders": "orders",
    "/run-orders": "orders.run_orders",
    "/order-risk-pool": "orders.risk_pool",
    "/purchase-plan": "materials.purchase_plan",
    "/material-issues": "materials.issues",
    "/long-lead-materials": "materials.long_lead",
    "/kit-analysis": "materials.kit_analysis",
    "/supplier-risk": "materials.supplier_risk",
    "/supplier-payment": "materials.supplier_payment",
    "/subcontract-orders": "materials.subcontract_orders",
    "/issues": "exceptions",
    "/quality-issues": "exceptions.quality",
    "/product-samples": "exceptions.product_samples",
    "/closure-tracking": "exceptions.closure",
    "/production-overview": "production.overview",
    "/schedule-plans": "production.schedule_plans",
    "/front-process": "production.front_process",
    "/smt": "production.smt",
    "/lean": "production.lean",
    "/assembly": "production.assembly",
    "/packaging": "production.packaging",
    "/process-exceptions": "production.exceptions",
    "/import": "basicdata.import",
    "/risk-rules": "rules.risk_rules",
    "/node-standards": "rules.node_standards",
    "/order-standards": "rules.order_standards",
    "/work-instructions": "rules.work_instructions",
    "/users": "users",
    "/audit": "audit",
    "/sync-config": "settings",
    "/basicdata/customers": "basicdata.data",
    "/basicdata/suppliers": "basicdata.data",
    "/basicdata/materials": "basicdata.data",
    "/basicdata/skus": "basicdata.data",
    "/basicdata/products": "basicdata.data",
    "/basicdata/warehouses": "basicdata.data",
    "/basicdata/processes": "basicdata.data",
    "/basicdata/organizations": "basicdata.data",
    "/basicdata/positions": "basicdata.data",
    "/basicdata/employees": "basicdata.data",
    "/basicdata/feedback": "basicdata.feedback",
    "/basicdata/files": "basicdata.files",
    "/share-management": "basicdata.share_management",
    "/announcements": "announcements",
    "/purchase/price-change": "purchase.price_change",
    "/purchase/price-change/pending": "purchase.price_change.pending",
    "/purchase/price-change/config": "purchase.price_change.config",
    "/finance/subject-balances": "finance.data",
    "/permissions": "permissions",
}


class PermissionChecker:
    """权限校验依赖，用法: Depends(PermissionChecker("orders", "update"))
    admin角色自动通过所有权限检查
    实时从数据库查询角色权限，不依赖JWT中的旧permissions

    多权限 OR：传入 any_of=[(resource, action), ...] 可让接口接受多个权限中的任意一个，
    例如 PermissionChecker("users", "read", any_of=[("materials.purchase_plan", "update")])
    表示持有 users.read 或 materials.purchase_plan.update 任一权限即放行。"""

    def __init__(self, resource: str, action: str, any_of: Optional[list[tuple[str, str]]] = None):
        self.resource = resource
        self.action = action
        # 主检查项 + 备选检查项（OR 关系）。错误提示仍以主权限为准。
        self.checks: list[tuple[str, str]] = [(resource, action)] + list(any_of or [])

    _ALIASES = {
        "basicdata.import": ["masterdata.import"],
        "basicdata.data": ["masterdata.data"],
        "basicdata.feedback": ["masterdata.feedback"],
        "basicdata.files": ["masterdata.files"],
        "masterdata.import": ["basicdata.import"],
        "masterdata.data": ["basicdata.data"],
        "masterdata.feedback": ["basicdata.feedback"],
        "masterdata.files": ["basicdata.files"],
    }

    def _resource_candidates(self, resource: Optional[str] = None) -> list[str]:
        if resource is None:
            resource = self.resource
        return [resource, *self._ALIASES.get(resource, [])]

    def _check_one(self, permissions: dict, resource: str, action: str) -> bool:
        """检查单个 (resource, action) 是否通过，含别名和全链路父级 fallback"""
        candidates = self._resource_candidates(resource)
        for r in candidates:
            if action in permissions.get(r, []):
                return True
        for r in candidates:
            parts = r.split(".")
            for i in range(len(parts) - 1, 0, -1):
                parent = ".".join(parts[:i])
                if not parent:
                    continue
                for pr in self._resource_candidates(parent):
                    if action in permissions.get(pr, []):
                        return True
        return False

    def _has_any_permission(self, permissions: dict) -> bool:
        """检查 self.checks 中任意一项是否通过"""
        return any(self._check_one(permissions, r, a) for r, a in self.checks)

    def _forbidden_detail(self) -> str:
        """生成 403 错误提示：单权限时保持原格式，多权限时用 ' 或 ' 连接"""
        if len(self.checks) <= 1:
            return f"缺少 {self.resource}.{self.action} 权限"
        perms = " 或 ".join(f"{r}.{a}" for r, a in self.checks)
        return f"缺少以下任一权限：{perms}"

    def _role_permission_additions(self, role_code: str, permissions: dict) -> dict:
        from app.core.permissions import merge_role_permission_additions

        return merge_role_permission_additions(role_code, permissions)

    async def _enrich_payload(self, payload: dict, db: AsyncSession, user_id) -> dict:
        """在 payload 中补充 oa_user_id 和 org_scope_ids"""
        user_result = await db.execute(select(SysUser).where(SysUser.id == int(user_id)))
        user = user_result.scalar_one_or_none()
        oa_user_id = None
        if user and user.emp_code:
            emp_result = await db.execute(
                select(Employee.oa_user_id).where(Employee.emp_code == user.emp_code)
            )
            oa_user_id = emp_result.scalar_one_or_none()
        org_scope_ids = await resolve_user_org_scopes(db, int(user_id))
        payload["oa_user_id"] = oa_user_id
        payload["org_scope_ids"] = org_scope_ids
        return payload

    async def __call__(self, token: str = Depends(oauth2_scheme), db: AsyncSession = Depends(get_db)):
        from app.core.token_blacklist import is_token_blacklisted
        from app.core.permission_cache import get_cached_user_payload, set_cached_user_payload

        payload = decode_access_token(token)
        role = payload.get("role", "")
        token_jti = payload.get("jti")
        token_login_version = payload.get("login_version", 0)
        token_channel = payload.get("auth_channel", "web")
        is_share = payload.get("share", False)

        if token_jti and await is_token_blacklisted(token_jti):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="您的账号已在其他设备登录，请重新登录",
                headers={"X-Force-Logout": "true"},
            )

        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无效的认证凭据")

        db_login_version = 0  # 默认值，is_share 路径不查库

        # === 性能优化：先查 payload 缓存（命中则跳过所有数据库查询） ===
        # 缓存 key 含 channel + login_version，重新登录主动 invalidate 该渠道缓存
        if not is_share:
            cached = await get_cached_user_payload(int(user_id), token_channel, int(token_login_version or 0))
            if cached and cached.get("role") and token_login_version == cached.get("login_version"):
                # 命中缓存：payload 复用缓存的 role/supplier/oa/org_scope
                payload.update({
                    "role": cached["role"],
                    "supplier_name": cached.get("supplier_name"),
                    "supplier_code": cached.get("supplier_code"),
                    "oa_user_id": cached.get("oa_user_id"),
                    "org_scope_ids": set(cached.get("org_scope_ids", [])),
                })
                role = cached["role"]
                # admin 直接返回
                if role == "admin":
                    return payload
                # 非 admin 还是要校验权限（permissions 不入缓存，因为容易变）
                # 但省了 user/role/employee/org_scope 的 4 次查询
                # 走下面的权限校验分支，permissions 单独查
                result = await db.execute(
                    select(SysRole.permissions)
                    .join(SysUser, SysUser.role_id == SysRole.id)
                    .where(SysUser.id == int(user_id))
                )
                row = result.one_or_none()
                if not row or not row[0]:
                    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="用户角色配置异常")
                permissions = row[0]
                if not isinstance(permissions, dict):
                    permissions = {}
                permissions = self._role_permission_additions(role, permissions)
                if self._has_any_permission(permissions):
                    return payload
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=self._forbidden_detail(),
                )

        if not is_share:
            user_result = await db.execute(
                select(SysUser, SysRole.role_code)
                .outerjoin(SysRole, SysUser.role_id == SysRole.id)
                .where(SysUser.id == int(user_id))
            )
            row = user_result.one_or_none()
            user = row[0] if row else None
            if not user or not user.is_active:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在或已禁用")

            role = row[1] or role
            payload["role"] = role
            payload["supplier_name"] = user.supplier_name
            if user.supplier_name and not payload.get("supplier_code"):
                supplier_result = await db.execute(
                    select(Supplier.supplier_code).where(
                        Supplier.supplier_name == user.supplier_name,
                        Supplier.status == 1,
                    )
                )
                supplier_code = supplier_result.scalar_one_or_none()
                if supplier_code:
                    payload["supplier_code"] = supplier_code
            db_login_version = verify_channel_version(user, payload)
            # 写入缓存（含 role/supplier/oa/org_scope），下次请求命中即跳过 4 次查询
            try:
                await self._enrich_payload(payload, db, user_id)
                await set_cached_user_payload(int(user_id), token_channel, int(db_login_version), {
                    "role": payload.get("role"),
                    "supplier_name": payload.get("supplier_name"),
                    "supplier_code": payload.get("supplier_code"),
                    "oa_user_id": payload.get("oa_user_id"),
                    "org_scope_ids": list(payload.get("org_scope_ids", set())),
                    "login_version": int(db_login_version),
                })
            except Exception:
                pass

        if role == "admin":
            if not payload.get("oa_user_id") and not is_share:
                # admin 缓存未命中时才补 oa/org_scope
                await self._enrich_payload(payload, db, user_id)
                try:
                    await set_cached_user_payload(int(user_id), token_channel, int(db_login_version or 0), {
                        "role": "admin",
                        "supplier_name": payload.get("supplier_name"),
                        "supplier_code": payload.get("supplier_code"),
                        "oa_user_id": payload.get("oa_user_id"),
                        "org_scope_ids": list(payload.get("org_scope_ids", set())),
                        "login_version": int(db_login_version or 0),
                    })
                except Exception:
                    pass
            return payload

        if role == "supplier" and self.action != "read":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="\u4f9b\u5e94\u5546\u8d26\u53f7\u4ec5\u5141\u8bb8\u67e5\u770b\u81ea\u5df1\u7684\u6570\u636e",
            )

        # 分享用户：只允许访问分享目标页面对应的资源，且仅限授权的操作
        if is_share:
            share_target_path = payload.get("share_target_path", "")
            share_permissions = payload.get("share_permissions", ["read"])
            # 优先从数据库动态获取映射，fallback 到硬编码
            try:
                path_to_resource = await _get_share_path_to_resource(db)
            except Exception:
                path_to_resource = _SHARE_PATH_TO_RESOURCE
            allowed_resource = path_to_resource.get(share_target_path)
            # 动态路由前缀匹配
            if not allowed_resource and "/:" in share_target_path:
                prefix = share_target_path.split("/:")[0]
                allowed_resource = path_to_resource.get(prefix)
            if allowed_resource:
                # 检查请求的资源是否属于分享目标页面
                if self.resource == allowed_resource or self.resource.split(".")[0] == allowed_resource.split(".")[0]:
                    # 检查请求的操作是否在分享权限中
                    if self.action in share_permissions:
                        payload["oa_user_id"] = None
                        payload["org_scope_ids"] = set()
                        return payload
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="分享访问仅限指定页面和授权操作，无权执行此操作",
            )

        result = await db.execute(
            select(SysRole.permissions)
            .join(SysUser, SysUser.role_id == SysRole.id)
            .where(SysUser.id == int(user_id))
        )
        row = result.one_or_none()
        if not row or not row[0]:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="用户角色配置异常")
        permissions = row[0]
        if not isinstance(permissions, dict):
            permissions = {}
        permissions = self._role_permission_additions(role, permissions)
        if self._has_any_permission(permissions):
            return await self._enrich_payload(payload, db, user_id)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=self._forbidden_detail(),
        )


if __name__ == "__main__":
    """测试密码生成"""
    password = "123456"
    hashed = get_password_hash(password)
    print(f"原始密码: {password}")
    print(f"哈希密码: {hashed}")
    
    # 验证密码
    is_valid = verify_password(password, hashed)
    print(f"密码是否有效: {is_valid}")
