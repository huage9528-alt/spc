"""用户管理 API — 仅管理员可操作"""

from typing import Optional, Dict, List
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import logging

from sqlalchemy import select, func, or_, and_, cast, String, exists
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.basicdata.wecom.contact_service import list_wecom_users
from app.services.basicdata.wecom.exceptions import WecomAPIError, WecomNotConfiguredError

from app.core.database import get_db
from app.core.security import PermissionChecker, get_password_hash, verify_password
from app.core.config import get_settings
from app.core.audit import log_audit
from app.core.permissions import merge_role_permission_additions
from app.models.basicdata.employee import Employee
from app.models.basicdata.organization import Organization
from app.models.basicdata.position import Position
from app.models.basicdata.supplier import Supplier
from app.models.basicdata.user import SysUser, SysRole
from app.models.basicdata.announcement import Notification
from app.schemas.common import ResponseModel
from app.services.basicdata.position_role_service import resolve_or_create_role, resolve_position_for_employee, sync_user_role_from_employee
from app.services.common.export_service import ExportColumn, GenericExportService

router = APIRouter()
logger = logging.getLogger(__name__)

USER_EXPORT_COLUMNS = [
    ExportColumn("username", "用户名", 18),
    ExportColumn("display_name", "显示名称", 18),
    ExportColumn("emp_code", "员工工号", 16),
    ExportColumn("emp_name", "员工姓名", 16),
    ExportColumn("position_name", "岗位", 18),
    ExportColumn("role_code", "角色编码", 16),
    ExportColumn("role_name", "角色名称", 18),
    ExportColumn("supplier_name", "绑定供应商", 24),
    ExportColumn("is_active", "状态", 10),
    ExportColumn("is_default_password", "默认密码", 10),
    ExportColumn("last_login_time", "最后登录", 18),
    ExportColumn("created_at", "创建时间", 18),
    ExportColumn("updated_at", "更新时间", 18),
]


# ---------- Schemas ----------
class UserCreate(BaseModel):
    username: str
    display_name: Optional[str] = None
    password: str
    role_id: Optional[int] = None
    emp_code: Optional[str] = None
    supplier_name: Optional[str] = None
    wecom_user_id: Optional[str] = None
    is_active: bool = True


class UserUpdate(BaseModel):
    display_name: Optional[str] = None
    role_id: Optional[int] = None
    emp_code: Optional[str] = None
    supplier_name: Optional[str] = None
    wecom_user_id: Optional[str] = None
    is_active: Optional[bool] = None


class PasswordReset(BaseModel):
    new_password: str


class RoleCreate(BaseModel):
    role_code: str
    role_name: str
    permissions: Dict[str, List[str]] = {}


class RoleUpdate(BaseModel):
    role_name: Optional[str] = None
    permissions: Optional[Dict[str, List[str]]] = None


class BatchGrantBody(BaseModel):
    role_ids: List[int]
    permissions: Dict[str, List[str]]   # 例: {"orders.list": ["read","update"]}
    mode: str = "grant"                  # grant=并集追加; revoke=移除指定 actions; replace=用本次 actions 覆盖这些 key


async def _resolve_role(role_id: int, db: AsyncSession) -> SysRole:
    result = await db.execute(select(SysRole).where(SysRole.id == role_id))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=400, detail="角色不存在")
    return role


async def _resolve_user_role(
    role_id: Optional[int],
    emp_code: Optional[str],
    db: AsyncSession,
) -> tuple[SysRole, Optional[Employee], Optional[Position]]:
    clean_emp_code = (emp_code or "").strip()
    employee: Optional[Employee] = None
    position: Optional[Position] = None
    if clean_emp_code:
        result = await db.execute(select(Employee).where(Employee.emp_code == clean_emp_code))
        employee = result.scalar_one_or_none()
        if not employee:
            raise HTTPException(status_code=400, detail="关联员工不存在")
        position = await resolve_position_for_employee(db, employee)

    if employee and position:
        org = None
        if employee.org_id:
            org_result = await db.execute(
                select(Organization).where(Organization.oa_org_id == str(employee.org_id))
            )
            org = org_result.scalars().first()
        role, _ = await resolve_or_create_role(db, position, org)
        if role:
            return role, employee, position

    if role_id is None:
        raise HTTPException(status_code=400, detail="请选择角色或关联有岗位的员工")

    return await _resolve_role(role_id, db), employee, position


async def _validate_supplier_binding(role: SysRole, supplier_name: Optional[str], db: AsyncSession) -> Optional[str]:
    if role.role_code != "supplier":
        return None

    name = supplier_name or ""
    if not name:
        raise HTTPException(status_code=400, detail="供应商账号必须绑定供应商")

    result = await db.execute(
        select(Supplier).where(
            Supplier.supplier_name == name,
            Supplier.status == 1,
        )
    )
    supplier = result.scalar_one_or_none()
    if not supplier:
        raise HTTPException(status_code=400, detail="绑定供应商不存在或已停用")
    return supplier.supplier_name


# ---------- 用户列表 ----------
@router.get("", response_model=ResponseModel[dict])
async def list_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = None,
    role_code: Optional[str] = None,
    user_type: Optional[str] = Query(None, description="用户类型筛选：employee=内部员工 / supplier=供应商账号"),
    is_active: Optional[bool] = None,
    is_default_password: Optional[bool] = Query(None, description="是否仍为默认密码"),
    keyword: Optional[str] = None,
    org_name: Optional[str] = None,
    position_name: Optional[str] = None,
    supplier_name: Optional[str] = None,
    current_user: dict = Depends(PermissionChecker("users", "read")),
    db: AsyncSession = Depends(get_db),
):
    SORTABLE = {
        'username': SysUser.username,
        'display_name': SysUser.display_name,
        'emp_code': SysUser.emp_code,
        'role_code': SysRole.role_code,
        'is_active': SysUser.is_active,
        'last_login_time': SysUser.last_login_time,
        'created_at': SysUser.created_at,
        'position_name': Position.position_name,
        'org_name': Organization.org_name,
        'supplier_name': SysUser.supplier_name,
    }

    Manager = aliased(Employee)
    query = (
        select(SysUser, SysRole, Employee, Position, Organization, Manager)
        .join(SysRole, SysUser.role_id == SysRole.id)
        .outerjoin(Employee, SysUser.scm_employee_id == Employee.id)
        .outerjoin(Position, Employee.position_id == Position.id)
        .outerjoin(Organization, cast(Employee.org_id, String) == Organization.oa_org_id)
        .outerjoin(Manager, Employee.manager_oa_user_id == Manager.oa_user_id)
    )

    # 用户管理不受上级员工控制，所有用户可见

    if role_code:
        codes = [c.strip() for c in role_code.split(",") if c.strip()]
        if codes:
            query = query.where(SysRole.role_code.in_(codes))
    if user_type == "employee":
        query = query.where(SysRole.role_code != "supplier")
    elif user_type == "supplier":
        query = query.where(SysRole.role_code == "supplier")
    if is_active is not None:
        query = query.where(SysUser.is_active == is_active)
    if is_default_password is not None:
        query = query.where(SysUser.is_default_password == is_default_password)
    if org_name:
        names = [n.strip() for n in org_name.split(",") if n.strip()]
        if names:
            query = query.where(Organization.org_name.in_(names))
    if position_name:
        names = [n.strip() for n in position_name.split(",") if n.strip()]
        if names:
            query = query.where(Position.position_name.in_(names))
    if supplier_name:
        names = [n.strip() for n in supplier_name.split(",") if n.strip()]
        if names:
            query = query.where(SysUser.supplier_name.in_(names))
    if keyword:
        like = f"%{keyword}%"
        query = query.where(
            (SysUser.username.ilike(like))
            | (SysUser.display_name.ilike(like))
            | (SysUser.emp_code.ilike(like))
            | (Employee.emp_name.ilike(like))
        )

    # 排序
    order_clauses = []
    if sort_by and sort_by in SORTABLE:
        col = SORTABLE[sort_by]
        if sort_order == 'desc':
            order_clauses.append(col.desc().nullslast())
        else:
            order_clauses.append(col.asc().nullslast())
    if not order_clauses:
        order_clauses = [SysUser.id.asc()]

    # 计算总数
    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar()

    # 分页
    offset = (page - 1) * page_size
    result = await db.execute(query.order_by(*order_clauses).offset(offset).limit(page_size))
    rows = result.all()

    return ResponseModel(data={
        "items": [
            {
                "id": user.id,
                "username": user.username,
                "display_name": user.display_name,
                "emp_code": user.emp_code,
                "scm_employee_id": user.scm_employee_id,
                "emp_name": employee.emp_name if employee else None,
                "position_id": employee.position_id if employee else None,
                "position_name": position.position_name if position else (employee.position if employee else None),
                "org_name": org.org_name if org else None,
                "manager_name": manager.emp_name if manager else None,
                "role_id": user.role_id,
                "role_code": role.role_code,
                "role_name": role.role_name,
                "supplier_name": user.supplier_name,
                "wecom_user_id": user.wecom_user_id,
                "is_active": user.is_active,
                "is_default_password": bool(user.is_default_password),
                "last_login_time": user.last_login_time.strftime("%Y-%m-%d %H:%M") if user.last_login_time else None,
                "created_at": user.created_at.strftime("%Y-%m-%d %H:%M") if user.created_at else None,
                "updated_at": user.updated_at.strftime("%Y-%m-%d %H:%M") if user.updated_at else None,
            }
            for user, role, employee, position, org, manager in rows
        ],
        "total": total,
    })


# ---------- 用户统计（KPI 带 / 筛选 chips 计数） ----------
@router.get("/stats", response_model=ResponseModel[dict])
async def user_stats(
    current_user: dict = Depends(PermissionChecker("users", "read")),
    db: AsyncSession = Depends(get_db),
):
    base_q = (
        select(
            func.count(SysUser.id).label("total"),
            func.count().filter(SysUser.is_active.is_(True)).label("active"),
            func.count().filter(SysRole.role_code == "supplier").label("suppliers"),
            func.count().filter(SysUser.is_default_password.is_(True)).label("default_password"),
            func.count().filter(SysUser.wecom_user_id.is_(None)).label("wecom_unbound"),
        )
        .join(SysRole, SysUser.role_id == SysRole.id)
    )
    row = (await db.execute(base_q)).one()
    total = row.total or 0
    suppliers = row.suppliers or 0
    return ResponseModel(data={
        "total": total,
        "active": row.active or 0,
        "disabled": total - (row.active or 0),
        "employees": total - suppliers,
        "suppliers": suppliers,
        "default_password": row.default_password or 0,
        "wecom_unbound": row.wecom_unbound or 0,
    })


@router.get("/export")
async def export_users(
    format: str = Query("xlsx", pattern="^(xlsx|csv)$"),
    columns: Optional[str] = Query(None),
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = None,
    role_code: Optional[str] = None,
    user_type: Optional[str] = Query(None, description="用户类型筛选：employee=内部员工 / supplier=供应商账号"),
    is_active: Optional[bool] = None,
    is_default_password: Optional[bool] = Query(None, description="是否仍为默认密码"),
    keyword: Optional[str] = None,
    org_name: Optional[str] = None,
    position_name: Optional[str] = None,
    supplier_name: Optional[str] = None,
    current_user: dict = Depends(PermissionChecker("users", "read")),
    db: AsyncSession = Depends(get_db),
):
    SORTABLE = {
        'username': SysUser.username,
        'display_name': SysUser.display_name,
        'emp_code': SysUser.emp_code,
        'role_code': SysRole.role_code,
        'is_active': SysUser.is_active,
        'last_login_time': SysUser.last_login_time,
        'created_at': SysUser.created_at,
        'position_name': Position.position_name,
        'org_name': Organization.org_name,
        'supplier_name': SysUser.supplier_name,
    }

    query = (
        select(SysUser, SysRole, Employee, Position, Organization)
        .join(SysRole, SysUser.role_id == SysRole.id)
        .outerjoin(Employee, SysUser.scm_employee_id == Employee.id)
        .outerjoin(Position, Employee.position_id == Position.id)
        .outerjoin(Organization, cast(Employee.org_id, String) == Organization.oa_org_id)
    )

    if role_code:
        codes = [c.strip() for c in role_code.split(",") if c.strip()]
        if codes:
            query = query.where(SysRole.role_code.in_(codes))
    if user_type == "employee":
        query = query.where(SysRole.role_code != "supplier")
    elif user_type == "supplier":
        query = query.where(SysRole.role_code == "supplier")
    if is_active is not None:
        query = query.where(SysUser.is_active == is_active)
    if is_default_password is not None:
        query = query.where(SysUser.is_default_password == is_default_password)
    if org_name:
        names = [n.strip() for n in org_name.split(",") if n.strip()]
        if names:
            query = query.where(Organization.org_name.in_(names))
    if position_name:
        names = [n.strip() for n in position_name.split(",") if n.strip()]
        if names:
            query = query.where(Position.position_name.in_(names))
    if supplier_name:
        names = [n.strip() for n in supplier_name.split(",") if n.strip()]
        if names:
            query = query.where(SysUser.supplier_name.in_(names))
    if keyword:
        like = f"%{keyword}%"
        query = query.where(
            (SysUser.username.ilike(like))
            | (SysUser.display_name.ilike(like))
            | (SysUser.emp_code.ilike(like))
            | (Employee.emp_name.ilike(like))
        )

    order_clauses = []
    if sort_by and sort_by in SORTABLE:
        col = SORTABLE[sort_by]
        if sort_order == 'desc':
            order_clauses.append(col.desc().nullslast())
        else:
            order_clauses.append(col.asc().nullslast())
    if not order_clauses:
        order_clauses = [SysUser.id.asc()]

    result = await db.execute(query.order_by(*order_clauses))
    rows = result.all()

    selected_keys = [c.strip() for c in columns.split(",") if c.strip()] if columns else []
    allowed = {col.key for col in USER_EXPORT_COLUMNS}
    selected_columns = [col for col in USER_EXPORT_COLUMNS if not selected_keys or col.key in selected_keys]
    if selected_keys and not selected_columns:
        raise HTTPException(status_code=400, detail="请选择至少一个有效导出字段")
    invalid_columns = [key for key in selected_keys if key not in allowed]
    if invalid_columns:
        raise HTTPException(status_code=400, detail=f"无效导出字段: {', '.join(invalid_columns)}")

    export_rows = []
    for user, role, employee, position, org in rows:
        export_rows.append({
            "username": user.username,
            "display_name": user.display_name or "",
            "emp_code": user.emp_code or "",
            "emp_name": employee.emp_name if employee else "",
            "position_name": position.position_name if position else (employee.position if employee else ""),
            "role_code": role.role_code,
            "role_name": role.role_name,
            "supplier_name": user.supplier_name or "",
            "is_active": "启用" if user.is_active else "停用",
            "is_default_password": "是" if user.is_default_password else "否",
            "last_login_time": user.last_login_time.strftime("%Y-%m-%d %H:%M") if user.last_login_time else "",
            "created_at": user.created_at.strftime("%Y-%m-%d %H:%M") if user.created_at else "",
            "updated_at": user.updated_at.strftime("%Y-%m-%d %H:%M") if user.updated_at else "",
        })

    svc = GenericExportService(selected_columns, export_rows, sheet_name="用户管理")
    if format == "csv":
        output = svc.to_csv()
        return StreamingResponse(
            output,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=users.csv"},
        )

    output = svc.to_xlsx()
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=users.xlsx"},
    )


# ---------- 角色列表 ----------
@router.get("/roles", response_model=ResponseModel[dict])
async def list_roles(
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = None,
    role_code: Optional[str] = None,
    org_name: Optional[str] = None,
    position_name: Optional[str] = None,
    keyword: Optional[str] = Query(None),
    current_user: dict = Depends(PermissionChecker("roles", "read")),
    db: AsyncSession = Depends(get_db),
):
    # 查询角色及用户数
    user_count_sub = (
        select(SysUser.role_id, func.count().label("user_count"))
        .group_by(SysUser.role_id)
        .subquery()
    )
    query = (
        select(SysRole, func.coalesce(user_count_sub.c.user_count, 0))
        .outerjoin(user_count_sub, SysRole.id == user_count_sub.c.role_id)
    )

    if role_code:
        codes = [c.strip() for c in role_code.split(",") if c.strip()]
        if codes:
            query = query.where(SysRole.role_code.in_(codes))
    if org_name:
        names = [n.strip() for n in org_name.split(",") if n.strip()]
        if names:
            query = query.where(SysRole.org_id.in_(
                select(Organization.oa_org_id).where(Organization.org_name.in_(names))
            ))
    if position_name:
        names = [n.strip() for n in position_name.split(",") if n.strip()]
        if names:
            query = query.where(SysRole.position_id.in_(
                select(cast(Position.id, String)).where(Position.position_name.in_(names))
            ))

    if keyword:
        like = f"%{keyword}%"
        query = query.where(
            (SysRole.role_code.ilike(like))
            | (SysRole.role_name.ilike(like))
        )

    # 排序
    SORTABLE = {
        'role_code': SysRole.role_code,
        'role_name': SysRole.role_name,
        'user_count': user_count_sub.c.user_count,
    }
    order_clauses = []
    if sort_by and sort_by in SORTABLE:
        col = SORTABLE[sort_by]
        if sort_order == 'desc':
            order_clauses.append(col.desc().nullslast())
        else:
            order_clauses.append(col.asc().nullslast())
    if not order_clauses:
        order_clauses = [SysRole.id.asc()]

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar()
    offset = (page - 1) * page_size
    result = await db.execute(query.order_by(*order_clauses).offset(offset).limit(page_size))
    paged = result.all()

    # 批量查询关联的部门和岗位
    org_ids = [role.org_id for role, _ in paged if role.org_id]
    position_ids = {int(role.position_id) for role, _ in paged if role.position_id and role.position_id.isdigit()}

    org_map = {}
    if org_ids:
        org_result = await db.execute(select(Organization).where(Organization.oa_org_id.in_(org_ids)))
        org_map = {o.oa_org_id: o for o in org_result.scalars().all() if o.oa_org_id}

    position_map = {}
    if position_ids:
        pos_result = await db.execute(select(Position).where(Position.id.in_(position_ids)))
        position_map = {p.id: p for p in pos_result.scalars().all()}

    return ResponseModel(data={
        "items": [
            {
                "id": role.id,
                "role_code": role.role_code,
                "role_name": role.role_name,
                "permissions": merge_role_permission_additions(role.role_code, role.permissions),
                "user_count": user_count,
                "org_id": role.org_id,
                "org_name": org_map[role.org_id].org_name if role.org_id and org_map.get(role.org_id) else None,
                "position_id": role.position_id,
                "position_name": position_map[role.position_id].position_name if role.position_id and role.position_id in position_map else None,
            }
            for role, user_count in paged
        ],
        "total": total,
    })


@router.post("/sync-roles", response_model=ResponseModel[dict])
async def sync_user_roles(
    current_user: dict = Depends(PermissionChecker("users", "update")),
    db: AsyncSession = Depends(get_db),
):
    # 先回填角色的 org_id 和 position_id（已移除，避免回填错误关联）

    result = await db.execute(
        select(SysUser, Employee, Position, Organization)
        .join(Employee, SysUser.scm_employee_id == Employee.id)
        .outerjoin(Position, Employee.position_id == Position.id)
        .outerjoin(Organization, cast(Employee.org_id, String) == Organization.oa_org_id)
    )
    rows = result.all()
    updated = 0
    created = 0
    for user, employee, position, org in rows:
        if not position:
            continue

        # 使用公共函数查找或创建角色
        role, role_created = await resolve_or_create_role(db, position, org)
        if role_created:
            created += 1

        # 更新用户角色
        if role and user.role_id != role.id:
            user.role_id = role.id
            updated += 1

    await db.commit()
    return ResponseModel(data={"total": len(rows), "updated": updated, "created": created})


@router.get("/employee-options", response_model=ResponseModel[list])
async def list_employee_options(
    keyword: Optional[str] = Query(None),
    current_user: dict = Depends(PermissionChecker(
        "users", "read",
        any_of=[
            ("materials.purchase_plan", "update"),
            ("materials.purchase_plan", "create"),
        ],
    )),
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(Employee, Position, SysRole)
        .outerjoin(Position, Employee.position_id == Position.id)
        .outerjoin(SysRole, SysRole.position_id == Position.id.cast(String))
    )
    if keyword:
        like = f"%{keyword}%"
        query = query.where(
            or_(
                Employee.emp_code.ilike(like),
                Employee.emp_name.ilike(like),
                Employee.login_id.ilike(like),
                Position.position_name.ilike(like),
            )
        )

    result = await db.execute(query.order_by(Employee.emp_code.asc()).limit(200))
    return ResponseModel(data=[
        {
            "id": employee.id,
            "scm_employee_id": employee.id,
            "emp_code": employee.emp_code,
            "emp_name": employee.emp_name,
            "login_id": employee.login_id,
            "position_id": employee.position_id,
            "position_name": position.position_name if position else employee.position,
            "role_id": role.id if role else None,
            "role_code": role.role_code if role else None,
            "role_name": role.role_name if role else None,
            "oa_user_id": employee.oa_user_id,
            "manager_oa_user_id": employee.manager_oa_user_id,
            "status": employee.status,
        }
        for employee, position, role in result.all()
    ])


# ---------- 批量授权（按权限分配给多个角色） ----------
@router.post("/roles/batch-grant", response_model=ResponseModel[dict])
async def batch_grant_permissions(
    body: BatchGrantBody,
    current_user: dict = Depends(PermissionChecker("roles", "update")),
    db: AsyncSession = Depends(get_db),
):
    if not body.role_ids:
        raise HTTPException(status_code=400, detail="请选择目标角色")
    if not body.permissions:
        raise HTTPException(status_code=400, detail="请选择权限项")
    if body.mode not in ("grant", "revoke", "replace"):
        raise HTTPException(status_code=400, detail="无效的模式")

    result = await db.execute(select(SysRole).where(SysRole.id.in_(body.role_ids)))
    roles = result.scalars().all()
    if not roles:
        raise HTTPException(status_code=404, detail="未找到角色")

    affected = 0
    skipped_admin = 0
    for role in roles:
        if role.role_code == "admin":
            skipped_admin += 1
            continue
        perms: Dict[str, List[str]] = dict(role.permissions or {})
        for key, actions in body.permissions.items():
            cur = set(perms.get(key, []))
            acts = set(actions or [])
            if body.mode == "grant":
                cur |= acts
            elif body.mode == "revoke":
                cur -= acts
            else:  # replace
                cur = acts
            if cur:
                perms[key] = sorted(cur)
            else:
                perms.pop(key, None)
        role.permissions = perms
        await log_audit(
            db, "sys_role", role.id, "update",
            field_name="permissions_batch", operator=current_user["username"],
        )
        affected += 1
    await db.commit()
    return ResponseModel(data={"affected": affected, "skipped_admin": skipped_admin})


# ---------- 创建角色 ----------
@router.post("/roles", response_model=ResponseModel[dict])
async def create_role(
    body: RoleCreate,
    current_user: dict = Depends(PermissionChecker("roles", "create")),
    db: AsyncSession = Depends(get_db),
):
    existing = await db.execute(select(SysRole).where(SysRole.role_code == body.role_code))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail=f"角色编码 '{body.role_code}' 已存在")

    role = SysRole(role_code=body.role_code, role_name=body.role_name, permissions=body.permissions)
    db.add(role)
    await db.flush()
    await log_audit(db, "sys_role", role.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(role)
    return ResponseModel(data={"id": role.id, "role_code": role.role_code})


# ---------- 更新角色 ----------
@router.put("/roles/{role_id}", response_model=ResponseModel[dict])
async def update_role(
    role_id: int,
    body: RoleUpdate,
    current_user: dict = Depends(PermissionChecker("roles", "update")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(SysRole).where(SysRole.id == role_id))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="角色不存在")

    if body.role_name is not None:
        role.role_name = body.role_name
    if body.permissions is not None:
        role.permissions = body.permissions

    await log_audit(db, "sys_role", role.id, "update", operator=current_user["username"])
    await db.commit()
    return ResponseModel(data={"id": role.id, "role_code": role.role_code})


# ---------- 删除角色 ----------
@router.delete("/roles/{role_id}", response_model=ResponseModel[dict])
async def delete_role(
    role_id: int,
    current_user: dict = Depends(PermissionChecker("roles", "delete")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(SysRole).where(SysRole.id == role_id))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="角色不存在")

    if role.role_code == "admin":
        raise HTTPException(status_code=400, detail="不能删除系统管理员角色")

    user_count = await db.execute(
        select(func.count()).select_from(SysUser).where(SysUser.role_id == role_id)
    )
    if user_count.scalar() > 0:
        raise HTTPException(status_code=400, detail=f"该角色下有 {user_count.scalar()} 个用户，请先更换用户角色后再删除")

    await log_audit(db, "sys_role", role.id, "delete", operator=current_user["username"])
    await db.delete(role)
    await db.commit()
    return ResponseModel(data={"deleted": role_id})


async def _validate_wecom_user_id(
    db: AsyncSession, wecom_user_id: Optional[str], exclude_user_id: Optional[int] = None
) -> None:
    """校验企业微信账号绑定：空值放行（允许解绑）；否则查唯一性 + 通讯录存在性。"""
    if not wecom_user_id:
        return
    wecom_user_id = wecom_user_id.strip()
    if not wecom_user_id:
        return
    # 1) 唯一性：每个 wecom userid 至多绑定一个系统用户
    dup_q = select(SysUser.id, SysUser.username).where(SysUser.wecom_user_id == wecom_user_id)
    if exclude_user_id is not None:
        dup_q = dup_q.where(SysUser.id != exclude_user_id)
    dup = (await db.execute(dup_q)).first()
    if dup:
        raise HTTPException(
            status_code=400, detail=f"该企业微信账号已被用户「{dup.username}」绑定"
        )
    # 2) 存在性：所选 userid 必须在企业微信通讯录中
    try:
        wecom_users = await list_wecom_users()
    except WecomNotConfiguredError:
        logger.warning("企业微信未配置，跳过绑定存在性校验: %s", wecom_user_id)
        return
    except WecomAPIError as e:
        raise HTTPException(
            status_code=503, detail=f"企业微信通讯录获取失败，请稍后重试（{e.errmsg}）"
        ) from e
    if not any(u.get("userid") == wecom_user_id for u in wecom_users):
        raise HTTPException(
            status_code=400, detail=f"企业微信账号不存在: {wecom_user_id}"
        )


# ---------- 创建用户 ----------
@router.post("", response_model=ResponseModel[dict])
async def create_user(
    body: UserCreate,
    current_user: dict = Depends(PermissionChecker("users", "create")),
    db: AsyncSession = Depends(get_db),
):
    existing = await db.execute(select(SysUser).where(SysUser.username == body.username))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail=f"用户名 '{body.username}' 已存在")

    role, employee, _ = await _resolve_user_role(body.role_id, body.emp_code, db)
    supplier_name = await _validate_supplier_binding(role, body.supplier_name, db)
    await _validate_wecom_user_id(db, body.wecom_user_id)

    user = SysUser(
        username=body.username,
        display_name=body.display_name or (employee.emp_name if employee else None),
        hashed_password=get_password_hash(body.password),
        role_id=role.id,
        supplier_name=supplier_name,
        emp_code=employee.emp_code if employee else None,
        scm_employee_id=employee.id if employee else None,
        wecom_user_id=body.wecom_user_id.strip() if body.wecom_user_id else None,
        is_active=body.is_active,
    )
    db.add(user)
    await db.flush()
    await log_audit(db, "sys_user", user.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(user)
    return ResponseModel(data={"id": user.id, "username": user.username})


# ---------- 更新用户 ----------
@router.put("/{user_id}", response_model=ResponseModel[dict])
async def update_user(
    user_id: int,
    body: UserUpdate,
    current_user: dict = Depends(PermissionChecker("users", "update")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(SysUser).where(SysUser.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    # 用户管理不受上级员工控制，所有用户可编辑

    if body.display_name is not None:
        user.display_name = body.display_name
    if body.role_id is not None or body.emp_code is not None:
        role, employee, _ = await _resolve_user_role(
            body.role_id if body.role_id is not None else user.role_id,
            body.emp_code if body.emp_code is not None else user.emp_code,
            db,
        )
        user.supplier_name = await _validate_supplier_binding(role, body.supplier_name, db)
        user.role_id = role.id
        user.emp_code = employee.emp_code if employee else None
        user.scm_employee_id = employee.id if employee else None
        if employee and body.display_name is None:
            user.display_name = employee.emp_name
    elif body.supplier_name is not None:
        role = await _resolve_role(user.role_id, db)
        user.supplier_name = await _validate_supplier_binding(role, body.supplier_name, db)
    # 企业微信绑定：前端始终回传当前值或 null，故无条件赋值（支持清空解绑）
    await _validate_wecom_user_id(db, body.wecom_user_id, exclude_user_id=user_id)
    user.wecom_user_id = body.wecom_user_id.strip() if body.wecom_user_id else None
    if body.is_active is not None:
        user.is_active = body.is_active

    await log_audit(db, "sys_user", user.id, "update", operator=current_user["username"])
    await db.commit()
    return ResponseModel(data={"id": user.id, "username": user.username})


# ---------- 重置密码 ----------
@router.put("/{user_id}/password", response_model=ResponseModel[dict])
async def reset_password(
    user_id: int,
    body: PasswordReset,
    current_user: dict = Depends(PermissionChecker("users.reset_password", "reset_password")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(SysUser).where(SysUser.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="密码长度不能少于6位")

    user.hashed_password = get_password_hash(body.new_password)
    user.is_default_password = True
    await log_audit(db, "sys_user", user.id, "update", field_name="password", operator=current_user["username"])
    await db.commit()
    return ResponseModel(data={"id": user.id, "message": "密码已重置"})


# ---------- 删除用户 ----------
@router.delete("/{user_id}", response_model=ResponseModel[dict])
async def delete_user(
    user_id: int,
    current_user: dict = Depends(PermissionChecker("users", "delete")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(SysUser).where(SysUser.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    if user.id == current_user.get("user_id"):
        raise HTTPException(status_code=400, detail="不能删除当前登录用户")

    await log_audit(db, "sys_user", user.id, "delete", operator=current_user["username"])
    await db.execute(Notification.__table__.delete().where(Notification.user_id == user_id))
    await db.delete(user)
    await db.commit()
    return ResponseModel(data={"deleted": user_id})


# ---------- 批量操作 Schemas ----------
class BatchFilterParams(BaseModel):
    role_code: Optional[str] = None
    user_type: Optional[str] = None
    is_active: Optional[bool] = None
    is_default_password: Optional[bool] = None
    keyword: Optional[str] = None
    org_name: Optional[str] = None
    position_name: Optional[str] = None
    supplier_name: Optional[str] = None


class BatchSetActiveBody(BaseModel):
    user_ids: Optional[List[int]] = None
    is_active: bool
    filter: Optional[BatchFilterParams] = None


class BatchResetPasswordBody(BaseModel):
    user_ids: Optional[List[int]] = None
    filter: Optional[BatchFilterParams] = None


class BatchDeleteBody(BaseModel):
    user_ids: Optional[List[int]] = None
    filter: Optional[BatchFilterParams] = None


def _build_filtered_user_ids(
    db: AsyncSession,
    user_ids: Optional[List[int]],
    flt: Optional[BatchFilterParams],
    exclude_user_id: Optional[int] = None,
):
    Manager = aliased(Employee)
    query = (
        select(SysUser.id)
        .join(SysRole, SysUser.role_id == SysRole.id)
        .outerjoin(Employee, SysUser.scm_employee_id == Employee.id)
        .outerjoin(Position, Employee.position_id == Position.id)
        .outerjoin(Organization, cast(Employee.org_id, String) == Organization.oa_org_id)
    )

    if user_ids is not None:
        if not user_ids:
            return []
        query = query.where(SysUser.id.in_(user_ids))

    if flt:
        if flt.role_code:
            codes = [c.strip() for c in flt.role_code.split(",") if c.strip()]
            if codes:
                query = query.where(SysRole.role_code.in_(codes))
        if flt.user_type == "employee":
            query = query.where(SysRole.role_code != "supplier")
        elif flt.user_type == "supplier":
            query = query.where(SysRole.role_code == "supplier")
        if flt.is_active is not None:
            query = query.where(SysUser.is_active == flt.is_active)
        if flt.is_default_password is not None:
            query = query.where(SysUser.is_default_password == flt.is_default_password)
        if flt.org_name:
            names = [n.strip() for n in flt.org_name.split(",") if n.strip()]
            if names:
                query = query.where(Organization.org_name.in_(names))
        if flt.position_name:
            names = [n.strip() for n in flt.position_name.split(",") if n.strip()]
            if names:
                query = query.where(Position.position_name.in_(names))
        if flt.supplier_name:
            names = [n.strip() for n in flt.supplier_name.split(",") if n.strip()]
            if names:
                query = query.where(SysUser.supplier_name.in_(names))
        if flt.keyword:
            like = f"%{flt.keyword}%"
            query = query.where(
                (SysUser.username.ilike(like))
                | (SysUser.display_name.ilike(like))
                | (SysUser.emp_code.ilike(like))
                | (Employee.emp_name.ilike(like))
            )

    if exclude_user_id is not None:
        query = query.where(SysUser.id != exclude_user_id)

    return query


async def _resolve_users_for_batch(
    db: AsyncSession,
    user_ids: Optional[List[int]],
    flt: Optional[BatchFilterParams],
    exclude_user_id: Optional[int] = None,
) -> List[int]:
    if user_ids is not None and not user_ids and flt is None:
        return []

    stmt = _build_filtered_user_ids(db, user_ids, flt, exclude_user_id)
    if isinstance(stmt, list):
        return stmt
    result = await db.execute(stmt)
    return [row[0] for row in result.all()]


# ---------- 批量启用/停用 ----------
@router.put("/batch/toggle-active", response_model=ResponseModel[dict])
async def batch_toggle_active(
    body: BatchSetActiveBody,
    current_user: dict = Depends(PermissionChecker("users", "update")),
    db: AsyncSession = Depends(get_db),
):
    matched_ids = await _resolve_users_for_batch(db, body.user_ids, body.filter)
    if not matched_ids:
        raise HTTPException(status_code=400, detail="未找到符合条件的用户")

    result = await db.execute(
        select(SysUser).where(SysUser.id.in_(matched_ids))
    )
    users = result.scalars().all()
    updated = 0
    for user in users:
        if user.is_active != body.is_active:
            user.is_active = body.is_active
            updated += 1
            await log_audit(
                db, "sys_user", user.id, "update",
                field_name="is_active", operator=current_user["username"],
            )
    await db.commit()
    action = "启用" if body.is_active else "停用"
    return ResponseModel(data={"total": len(users), "updated": updated, "action": action})


# ---------- 批量重置密码 ----------
@router.put("/batch/reset-password", response_model=ResponseModel[dict])
async def batch_reset_password(
    body: BatchResetPasswordBody,
    current_user: dict = Depends(PermissionChecker("users.reset_password", "reset_password")),
    db: AsyncSession = Depends(get_db),
):
    matched_ids = await _resolve_users_for_batch(db, body.user_ids, body.filter)
    if not matched_ids:
        raise HTTPException(status_code=400, detail="未找到符合条件的用户")

    settings = get_settings()
    default_pwd = settings.ERP_SYNC_DEFAULT_PASSWORD
    hashed_pwd = get_password_hash(default_pwd)

    result = await db.execute(
        select(SysUser).where(SysUser.id.in_(matched_ids))
    )
    users = result.scalars().all()
    updated = 0
    for user in users:
        user.hashed_password = hashed_pwd
        user.is_default_password = True
        updated += 1
        await log_audit(
            db, "sys_user", user.id, "update",
            field_name="password", operator=current_user["username"],
        )
    await db.commit()
    return ResponseModel(data={"total": len(users), "updated": updated, "default_password": default_pwd})


# ---------- 批量删除 ----------
@router.post("/batch/delete", response_model=ResponseModel[dict])
async def batch_delete_users(
    body: BatchDeleteBody,
    current_user: dict = Depends(PermissionChecker("users", "delete")),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = current_user.get("user_id")
    matched_ids = await _resolve_users_for_batch(
        db, body.user_ids, body.filter, exclude_user_id=current_user_id
    )
    if not matched_ids:
        raise HTTPException(status_code=400, detail="未找到符合条件的用户或仅选择了当前登录用户")

    result = await db.execute(
        select(SysUser).where(SysUser.id.in_(matched_ids))
    )
    users = result.scalars().all()
    deleted = 0
    for user in users:
        await log_audit(db, "sys_user", user.id, "delete", operator=current_user["username"])
        await db.execute(Notification.__table__.delete().where(Notification.user_id == user.id))
        await db.delete(user)
        deleted += 1
    await db.commit()
    return ResponseModel(data={"total": len(users), "deleted": deleted})


# ---------- Schemas: 批量开通用户 ----------
class BatchProvisionBody(BaseModel):
    emp_codes: List[str]
    role_id: Optional[int] = None
    default_password: Optional[str] = None
    usernames: Optional[Dict[str, str]] = None  # emp_code → 自定义登录账号；未提供时按 emp_name 生成


# ---------- 未开通用户的员工列表 ----------
@router.get("/unprovisioned-employees", response_model=ResponseModel[dict])
async def list_unprovisioned_employees(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    keyword: Optional[str] = None,
    org_name: Optional[str] = None,
    position_name: Optional[str] = None,
    current_user: dict = Depends(PermissionChecker("users", "read")),
    db: AsyncSession = Depends(get_db),
):
    """查询已同步员工数据但尚未开通系统用户的员工列表"""

    # 已开通用户的判定: sys_user.emp_code = e.emp_code OR sys_user.scm_employee_id = e.id
    # 用 NOT EXISTS 比 NOT IN 更准确地表达"两列任一匹配即视为已开通"
    provisioned_exists = select(SysUser.id).where(
        or_(
            and_(SysUser.emp_code.isnot(None), SysUser.emp_code == Employee.emp_code),
            and_(SysUser.scm_employee_id.isnot(None), SysUser.scm_employee_id == Employee.id),
        )
    )

    # 查找未开通的员工，关联岗位和组织
    query = (
        select(Employee, Position, Organization)
        .outerjoin(Position, Employee.position_id == Position.id)
        .outerjoin(Organization, cast(Employee.org_id, String) == Organization.oa_org_id)
        .where(~exists(provisioned_exists))
    )

    # 过滤条件：keyword 支持空格分隔多关键词（任一匹配即可）
    if keyword:
        parts = [p.strip() for p in keyword.replace("，", " ").split() if p.strip()]
        if parts:
            or_clauses = []
            for p in parts:
                like = f"%{p}%"
                or_clauses.append(
                    (Employee.emp_code.ilike(like))
                    | (Employee.emp_name.ilike(like))
                    | (Employee.login_id.ilike(like))
                )
            if len(or_clauses) == 1:
                query = query.where(or_clauses[0])
            else:
                from sqlalchemy import or_ as sa_or
                query = query.where(sa_or(*or_clauses))
    if org_name:
        names = [n.strip() for n in org_name.split(",") if n.strip()]
        if names:
            query = query.where(Organization.org_name.in_(names))
    if position_name:
        names = [n.strip() for n in position_name.split(",") if n.strip()]
        if names:
            query = query.where(
                or_(
                    Position.position_name.in_(names),
                    Employee.position.in_(names),
                )
            )

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar()
    offset = (page - 1) * page_size
    result = await db.execute(query.order_by(Employee.emp_code.asc()).offset(offset).limit(page_size))
    paged_rows = result.all()

    # 统计所有岗位和部门供前端筛选（独立查询）
    options_query = (
        select(Position.position_name, Employee.position, Organization.org_name)
        .select_from(Employee)
        .outerjoin(Position, Employee.position_id == Position.id)
        .outerjoin(Organization, cast(Employee.org_id, String) == Organization.oa_org_id)
        .where(~exists(provisioned_exists))
    )
    options_result = await db.execute(options_query)
    all_position_names = set()
    all_org_names = set()
    for pos_name, emp_pos, org_name_val in options_result.all():
        name = pos_name or emp_pos
        if name:
            all_position_names.add(name)
        if org_name_val:
            all_org_names.add(org_name_val)

    return ResponseModel(data={
        "items": [
            {
                "id": emp.id,
                "scm_employee_id": emp.id,
                "emp_code": emp.emp_code,
                "emp_name": emp.emp_name,
                "login_id": emp.login_id,
                "position_name": pos.position_name if pos else (emp.position or None),
                "org_name": org.org_name if org else None,
                "status": emp.status,
                "phone": emp.phone,
                "email": emp.email,
            }
            for emp, pos, org in paged_rows
        ],
        "total": total,
        "position_options": sorted(all_position_names),
        "org_options": sorted(all_org_names),
    })


# ---------- 批量开通用户 ----------
@router.post("/batch-provision", response_model=ResponseModel[dict])
async def batch_provision_users(
    body: BatchProvisionBody,
    current_user: dict = Depends(PermissionChecker("users", "create")),
    db: AsyncSession = Depends(get_db),
):
    """批量为选中的员工开通系统用户"""

    if not body.emp_codes:
        raise HTTPException(status_code=400, detail="请选择至少一名员工")

    codes = [c.strip() for c in body.emp_codes if c and c.strip()]
    if not codes:
        raise HTTPException(status_code=400, detail="员工工号为空")

    # 检查已开通的用户
    existing_result = await db.execute(
        select(SysUser.emp_code).where(SysUser.emp_code.in_(codes))
    )
    existing_codes = {row[0] for row in existing_result.all() if row[0]}
    skipped_codes = sorted(existing_codes)

    # 获取需要开通的员工
    emp_result = await db.execute(
        select(Employee).where(Employee.emp_code.in_(codes))
    )
    employees = emp_result.scalars().all()
    employee_map = {e.emp_code: e for e in employees}

    # 确定角色
    from app.core.config import get_settings
    from app.services.basicdata.position_role_service import resolve_or_create_role
    settings = get_settings()

    # 默认密码
    default_pwd = body.default_password or settings.ERP_SYNC_DEFAULT_PASSWORD
    hashed_pwd = get_password_hash(default_pwd)

    # 默认角色（当 role_id 未指定且员工无岗位时使用）
    fallback_role_id = None
    if not body.role_id:
        planner_result = await db.execute(
            select(SysRole).where(SysRole.role_code == "planner").limit(1)
        )
        planner = planner_result.scalar_one_or_none()
        if planner:
            fallback_role_id = planner.id
        else:
            first_result = await db.execute(select(SysRole).limit(1))
            first = first_result.scalar_one_or_none()
            fallback_role_id = first.id if first else None

    created = 0
    errors: List[str] = []
    newly_created_users: List[dict] = []

    for emp_code in codes:
        if emp_code in existing_codes:
            continue  # 已开通，跳过

        emp = employee_map.get(emp_code)
        if not emp:
            errors.append(f"{emp_code}: 员工不存在")
            continue

        # 确定角色
        target_role_id = body.role_id
        if not target_role_id:
            # 按岗位自动匹配
            matched_position = None
            if emp.position_id:
                pos_result = await db.execute(
                    select(Position).where(Position.id == emp.position_id)
                )
                matched_position = pos_result.scalar_one_or_none()
            if not matched_position and emp.position:
                pos_result = await db.execute(
                    select(Position).where(Position.position_name == emp.position).limit(1)
                )
                matched_position = pos_result.scalar_one_or_none()

            matched_org = None
            if emp.org_id and matched_position:
                org_result = await db.execute(
                    select(Organization).where(Organization.oa_org_id == str(emp.org_id))
                )
                matched_org = org_result.scalars().first()

            if matched_position:
                matched_role, _ = await resolve_or_create_role(db, matched_position, matched_org)
                if matched_role:
                    target_role_id = matched_role.id

            if not target_role_id:
                target_role_id = fallback_role_id

        if not target_role_id:
            errors.append(f"{emp_code}({emp.emp_name}): 无法确定角色，请先创建角色")
            continue

        # 解析用户名: 前端覆盖 > emp_name; 无覆盖且 emp_name 缺失则报错
        override = (body.usernames or {}).get(emp.emp_code or "")
        if override and override.strip():
            username = override.strip()
        elif emp.emp_name and emp.emp_name.strip():
            username = emp.emp_name.strip()
        else:
            errors.append(f"{emp_code}: 员工姓名缺失，无法生成登录账号，请手动指定")
            continue

        # 确定激活状态
        is_active = (emp.status in {0, 1, 2, 3}) if emp.status is not None else True

        # 创建用户
        try:
            new_user = SysUser(
                username=username,
                display_name=emp.emp_name,
                hashed_password=hashed_pwd,
                role_id=target_role_id,
                emp_code=emp.emp_code,
                scm_employee_id=emp.id,
                is_active=is_active,
            )
            db.add(new_user)
            await db.flush()
            await log_audit(db, "sys_user", new_user.id, "create", operator=current_user["username"])
            created += 1
            newly_created_users.append({
                "emp_code": emp.emp_code,
                "scm_employee_id": emp.id,
                "username": username,
                "display_name": emp.emp_name,
                "role_id": target_role_id,
            })
        except Exception as e:
            errors.append(f"{emp_code}({emp.emp_name}): {e}")
            try:
                await db.rollback()
            except Exception:
                pass
            await db.begin_nested()

    await db.commit()

    return ResponseModel(data={
        "created": created,
        "skipped": len(skipped_codes),
        "skipped_codes": skipped_codes,
        "errors": errors,
        "total_requested": len(codes),
        "default_password": default_pwd,
        "new_users": newly_created_users,
    })


# ---------- 批量绑定企业微信：智能匹配 ----------
class WecomBindingItem(BaseModel):
    user_id: int
    wecom_user_id: str


class BatchBindWecomBody(BaseModel):
    bindings: List[WecomBindingItem]


@router.get("/wecom-match", response_model=ResponseModel[dict])
async def wecom_bind_match(
    current_user: dict = Depends(PermissionChecker("users", "read")),
    db: AsyncSession = Depends(get_db),
):
    """按姓名自动匹配未绑定用户 ↔ 企业微信账号，返回建议供管理员确认。"""
    # 1. 取所有未绑定企微的用户 + emp_name
    rows = (
        await db.execute(
            select(
                SysUser.id, SysUser.username, SysUser.display_name, SysUser.emp_code, Employee.emp_name
            )
            .outerjoin(Employee, SysUser.scm_employee_id == Employee.id)
            .where(SysUser.wecom_user_id.is_(None))
            .order_by(SysUser.id)
        )
    ).all()

    # 2. 取企微通讯录（一次）
    try:
        wecom_users = await list_wecom_users()
    except WecomNotConfiguredError as e:
        raise HTTPException(status_code=501, detail=str(e)) from e
    except WecomAPIError as e:
        raise HTTPException(
            status_code=502,
            detail=f"企业微信接口调用失败（errcode={e.errcode}）：{e.errmsg}",
        ) from e

    # 3. 反向索引：name -> [{userid, name}]
    name_to_ids: Dict[str, List[Dict[str, str]]] = {}
    for w in wecom_users:
        nm = (w.get("name") or "").strip()
        if not nm:
            continue
        name_to_ids.setdefault(nm, []).append({"userid": w.get("userid", ""), "name": nm})

    # 4. 逐用户匹配
    items: List[Dict] = []
    stats = {"matched": 0, "ambiguous": 0, "unmatched": 0}
    for row in rows:
        uid, username, display_name, _emp_code, emp_name = row[0], row[1], row[2], row[3], row[4]
        key = (emp_name or "").strip() or (display_name or "").strip()
        cands = name_to_ids.get(key, [])
        if not key or not cands:
            status = "unmatched"
            stats["unmatched"] += 1
        elif len(cands) == 1:
            status = "matched"
            stats["matched"] += 1
        else:
            status = "ambiguous"
            stats["ambiguous"] += 1
        items.append(
            {
                "user_id": uid,
                "username": username,
                "display_name": display_name,
                "emp_name": emp_name,
                "match_status": status,
                "suggested_wecom_userid": cands[0]["userid"] if cands else None,
                "suggested_wecom_name": cands[0]["name"] if cands else None,
                "candidates": cands,
            }
        )

    # 5. 多用户争同一企微账号 → 后到的 matched 降级为 ambiguous
    seen_userid_owner: Dict[str, int] = {}
    for it in items:
        wid = it["suggested_wecom_userid"]
        if not wid or it["match_status"] != "matched":
            continue
        if wid in seen_userid_owner:
            it["match_status"] = "ambiguous"
            stats["matched"] -= 1
            stats["ambiguous"] += 1
        else:
            seen_userid_owner[wid] = it["user_id"]

    return ResponseModel(data={"items": items, "stats": stats})


@router.post("/batch-bind-wecom", response_model=ResponseModel[dict])
async def batch_bind_wecom(
    body: BatchBindWecomBody,
    current_user: dict = Depends(PermissionChecker("users", "update")),
    db: AsyncSession = Depends(get_db),
):
    """批量绑定企业微信账号：批次内/对库内唯一性 + 通讯录存在性，容错写入。"""
    if not body.bindings:
        raise HTTPException(status_code=400, detail="请提交至少一条绑定")

    # 清洗 + 批次内唯一性
    errors: List[Dict] = []
    seen: Dict[str, int] = {}
    unique_bindings: List[tuple] = []
    for b in body.bindings:
        wid = (b.wecom_user_id or "").strip()
        if not wid:
            continue
        if wid in seen:
            errors.append({"user_id": b.user_id, "message": f"企业微信账号 {wid} 在提交中重复"})
            continue
        seen[wid] = b.user_id
        unique_bindings.append((b.user_id, wid))
    if not unique_bindings:
        raise HTTPException(status_code=400, detail="企业微信账号不能为空")

    # 通讯录存在性（一次拉取；未配置则跳过该校验）
    try:
        wecom_users = await list_wecom_users()
        valid_ids = {w.get("userid") for w in wecom_users}
    except WecomNotConfiguredError:
        valid_ids = None
        logger.warning("企业微信未配置，批量绑定跳过存在性校验")
    except WecomAPIError as e:
        raise HTTPException(
            status_code=502,
            detail=f"企业微信接口调用失败（errcode={e.errcode}）：{e.errmsg}",
        ) from e

    # 对库内唯一性：查这些 wecom id 当前被谁占用
    target_ids = [wid for _, wid in unique_bindings]
    dup_users = (
        await db.execute(select(SysUser).where(SysUser.wecom_user_id.in_(target_ids)))
    ).scalars().all()
    db_owner: Dict[str, tuple] = {u.wecom_user_id: (u.id, u.username) for u in dup_users}

    # 取目标用户
    user_ids = [uid for uid, _ in unique_bindings]
    target_users = (
        await db.execute(select(SysUser).where(SysUser.id.in_(user_ids)))
    ).scalars().all()
    users_map = {u.id: u for u in target_users}

    # 逐条校验 + 应用
    updated = 0
    for uid, wid in unique_bindings:
        user = users_map.get(uid)
        if not user:
            errors.append({"user_id": uid, "message": "用户不存在"})
            continue
        if valid_ids is not None and wid not in valid_ids:
            errors.append({"user_id": uid, "message": f"企业微信账号不存在: {wid}"})
            continue
        owner = db_owner.get(wid)
        if owner and owner[0] != uid:
            errors.append(
                {"user_id": uid, "message": f"该企业微信账号已被用户「{owner[1]}」绑定"}
            )
            continue
        user.wecom_user_id = wid
        updated += 1
        await log_audit(
            db, "sys_user", user.id, "update",
            field_name="wecom_user_id", operator=current_user["username"],
        )

    await db.commit()
    return ResponseModel(data={"updated": updated, "errors": errors})
