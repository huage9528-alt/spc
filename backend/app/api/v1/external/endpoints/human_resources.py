"""组织人员对外接口

为外部系统提供组织架构、岗位、员工信息查询。
区别于内部 /api/v1/basicdata/* 的 CRUD 逻辑，对外只暴露精简字段集与常用筛选条件。
"""

from typing import Annotated, Optional, Set

from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_, cast, String
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.database import get_db
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.basicdata.organization import Organization
from app.models.basicdata.position import Position
from app.models.basicdata.employee import Employee
from app.models.basicdata.employee_organization import EmployeeOrganization
from app.schemas.common import ResponseModel

from ..common import ExternalPage, IntCsv, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

org_router = APIRouter(prefix="/organizations", tags=["组织人员"])
pos_router = APIRouter(prefix="/positions", tags=["组织人员"])
emp_router = APIRouter(prefix="/employees", tags=["组织人员"])


def _mask_phone(v):
    if not v or len(v) < 7:
        return v
    return v[:3] + "****" + v[-4:]


# ═══════════════════════════════════════════
# 组织
# ═══════════════════════════════════════════

class OrganizationsListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（oa_org_id / org_name 模糊匹配）")
    org_type: Optional[str] = Field(None, description="组织类型精确匹配")
    status: IntCsv = Field(None, description="状态，多选逗号分隔（1-启用 0-禁用）")


class OrganizationOut(BaseModel):
    """组织（对外精简字段集）"""
    oa_org_id: Optional[str] = Field(None, description="OA 组织ID")
    org_name: Optional[str] = Field(None, description="组织名称")
    org_type: Optional[str] = Field(None, description="组织类型")
    parent_code: Optional[str] = Field(None, description="父组织 oa_org_id")
    leader_name: Optional[str] = Field(None, description="负责人姓名")
    status: Optional[int] = Field(None, description="状态（1-启用 0-禁用）")


@org_router.get("/list", response_model=ResponseModel[ExternalPage[OrganizationOut]],
                summary="组织列表", description="endpoint_code: organizations.list")
@register_external(
    "organizations.list",
    "组织列表",
    method="GET",
    path="/organizations/list",
    description="组织架构列表查询，支持关键字、组织类型、状态筛选",
    tags=["组织人员"],
)
@log_external_call("organizations.list")
async def organizations_list(
    request: Request,
    q: Annotated[OrganizationsListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("organizations.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(Organization)
    count_query = select(func.count()).select_from(Organization)

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            Organization.oa_org_id.ilike(like_expr),
            Organization.org_name.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.org_type:
        query = query.where(Organization.org_type == q.org_type)
        count_query = count_query.where(Organization.org_type == q.org_type)

    if q.status:
        query = query.where(Organization.status.in_(q.status))
        count_query = count_query.where(Organization.status.in_(q.status))

    total = (await db.execute(count_query)).scalar() or 0

    ParentOrg = aliased(Organization)
    LeaderEmp = aliased(Employee)

    query = (
        query
        .outerjoin(ParentOrg, Organization.parent_id == ParentOrg.id)
        .outerjoin(LeaderEmp, Organization.leader_id == LeaderEmp.id)
        .add_columns(
            ParentOrg.oa_org_id.label("parent_code"),
            LeaderEmp.emp_name.label("leader_name"),
        )
        .order_by(Organization.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).all()

    items = []
    for row in rows:
        org = row[0]
        parent_code = row.parent_code
        leader_name = row.leader_name
        items.append({
            "oa_org_id": org.oa_org_id,
            "org_name": org.org_name,
            "org_type": org.org_type,
            "parent_code": parent_code,
            "leader_name": leader_name,
            "status": org.status,
        })

    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ═══════════════════════════════════════════
# 岗位
# ═══════════════════════════════════════════

class PositionsListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（position_code / position_name 模糊匹配）")
    status: IntCsv = Field(None, description="状态，多选逗号分隔（1-启用 0-禁用）")


class PositionOut(BaseModel):
    """岗位（对外精简字段集）"""
    id: int = Field(..., description="主键")
    position_code: Optional[str] = Field(None, description="岗位编码")
    position_name: Optional[str] = Field(None, description="岗位名称")
    status: Optional[int] = Field(None, description="状态（1-启用 0-禁用）")


@pos_router.get("/list", response_model=ResponseModel[ExternalPage[PositionOut]],
                summary="岗位列表", description="endpoint_code: positions.list")
@register_external(
    "positions.list",
    "岗位列表",
    method="GET",
    path="/positions/list",
    description="岗位列表查询，支持关键字、状态筛选",
    tags=["组织人员"],
)
@log_external_call("positions.list")
async def positions_list(
    request: Request,
    q: Annotated[PositionsListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("positions.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(Position)
    count_query = select(func.count()).select_from(Position)

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            Position.position_code.ilike(like_expr),
            Position.position_name.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.status:
        query = query.where(Position.status.in_(q.status))
        count_query = count_query.where(Position.status.in_(q.status))

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query
        .order_by(Position.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).scalars().all()

    items = [{
        "id": r.id,
        "position_code": r.position_code,
        "position_name": r.position_name,
        "status": r.status,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ═══════════════════════════════════════════
# 员工
# ═══════════════════════════════════════════

class EmployeesListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（oa_user_id / emp_name 模糊匹配）")
    org_id: Optional[str] = Field(None, description="组织 oa_org_id 筛选")
    position_code: Optional[str] = Field(None, description="岗位编码筛选")
    status: IntCsv = Field(None, description="状态，多选逗号分隔（1-启用 0-禁用）")


class EmployeeOut(BaseModel):
    """员工（对外精简字段集）"""
    id: int = Field(..., description="主键")
    oa_user_id: Optional[str] = Field(None, description="OA 用户ID")
    emp_name: Optional[str] = Field(None, description="姓名")
    org_id: Optional[int] = Field(None, description="组织 oa_org_id")
    org_name: Optional[str] = Field(None, description="组织名称")
    position_name: Optional[str] = Field(None, description="岗位名称")
    phone: Optional[str] = Field(None, description="手机号，脱敏显示")
    email: Optional[str] = Field(None, description="邮箱")
    status: Optional[int] = Field(None, description="状态（1-启用 0-禁用）")


@emp_router.get("/list", response_model=ResponseModel[ExternalPage[EmployeeOut]],
                summary="员工列表", description="endpoint_code: employees.list")
@register_external(
    "employees.list",
    "员工列表",
    method="GET",
    path="/employees/list",
    description="员工列表查询，支持关键字、组织、岗位、状态筛选（手机号脱敏）",
    tags=["组织人员"],
)
@log_external_call("employees.list")
async def employees_list(
    request: Request,
    q: Annotated[EmployeesListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("employees.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(Employee)
    count_query = select(func.count()).select_from(Employee)

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            Employee.oa_user_id.ilike(like_expr),
            Employee.emp_name.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.org_id:
        query = query.where(Employee.org_id == q.org_id)
        count_query = count_query.where(Employee.org_id == q.org_id)

    if q.position_code:
        PosFilter = aliased(Position)
        query = query.join(PosFilter, Employee.position_id == PosFilter.id)
        query = query.where(PosFilter.position_code == q.position_code)
        count_query = count_query.join(PosFilter, Employee.position_id == PosFilter.id)
        count_query = count_query.where(PosFilter.position_code == q.position_code)

    if q.status:
        query = query.where(Employee.status.in_(q.status))
        count_query = count_query.where(Employee.status.in_(q.status))

    total = (await db.execute(count_query)).scalar() or 0

    OrgAlias = aliased(Organization)
    PosAlias = aliased(Position)

    query = (
        query
        .outerjoin(OrgAlias, cast(Employee.org_id, String) == OrgAlias.oa_org_id)
        .outerjoin(PosAlias, Employee.position_id == PosAlias.id)
        .add_columns(
            OrgAlias.org_name.label("org_name"),
            PosAlias.position_name.label("pos_name"),
        )
        .order_by(Employee.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).all()

    items = []
    for row in rows:
        emp = row[0]
        items.append({
            "id": emp.id,
            "oa_user_id": emp.oa_user_id,
            "emp_name": emp.emp_name,
            "org_id": emp.org_id,
            "org_name": row.org_name,
            "position_name": row.pos_name or emp.position,
            "phone": _mask_phone(emp.phone),
            "email": emp.email,
            "status": emp.status,
        })

    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ═══════════════════════════════════════════
# 组织下员工
# ═══════════════════════════════════════════

class OrgEmployeesQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（oa_user_id / emp_name 模糊匹配）")
    position_code: Optional[str] = Field(None, description="岗位编码筛选")
    status: IntCsv = Field(None, description="状态，多选逗号分隔（1-启用 0-禁用）")


async def _get_descendant_org_codes(db, root_oa_org_id: str) -> Set[str]:
    """递归获取某组织及其所有子组织的 org_code 集合"""
    result = set()
    to_process = [root_oa_org_id]
    processed_ids = set()

    while to_process:
        current = to_process.pop()
        res = await db.execute(
            select(Organization.org_code, Organization.id)
            .where(Organization.oa_org_id == current)
        )
        row = res.first()
        if not row or row[1] in processed_ids:
            continue
        org_code, org_id = row[0], row[1]
        processed_ids.add(org_id)
        result.add(org_code)

        child_res = await db.execute(
            select(Organization.oa_org_id)
            .where(Organization.parent_id == org_id)
        )
        for child_row in child_res.all():
            to_process.append(child_row[0])

    return result


@org_router.get("/{oa_org_id}/employees",
                response_model=ResponseModel[ExternalPage[EmployeeOut]],
                summary="组织员工", description="endpoint_code: organizations.employees")
@register_external(
    "organizations.employees", "组织员工", method="GET",
    path="/organizations/{oa_org_id}/employees",
    description="查询指定组织（含子组织）下的员工列表", tags=["组织人员"],
)
@log_external_call("organizations.employees", path_params=("oa_org_id",))
async def organization_employees(
    request: Request,
    oa_org_id: Annotated[str, Path(description="组织 oa_org_id")],
    q: Annotated[OrgEmployeesQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("organizations.employees")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    org_codes = await _get_descendant_org_codes(db, oa_org_id)

    if not org_codes:
        return {"items": [], "total": 0, "page": 1, "page_size": page_size}

    # 批量获取 org_code 对应的 oa_org_id（避免 N+1）
    org_rows = (await db.execute(
        select(Organization.oa_org_id)
        .where(Organization.org_code.in_(org_codes))
    )).all()
    descendant_oa_ids = {int(row[0]) for row in org_rows if row[0]}

    # 同时收集所有 org_codes 对应的 oa_org_id
    all_oa_ids = set(descendant_oa_ids)

    # 员工查询：主部门匹配 oa_org_id，或兼职关联 org_code
    query = (
        select(Employee)
        .distinct()
    )
    count_query_base = select(Employee).distinct()

    if all_oa_ids:
        sub_emp = (
            select(EmployeeOrganization.emp_code)
            .where(EmployeeOrganization.org_code.in_(org_codes))
        )
        query = query.where(
            or_(
                Employee.org_id.in_(all_oa_ids),
                Employee.emp_code.in_(sub_emp),
            )
        )
        count_query_base = count_query_base.where(
            or_(
                Employee.org_id.in_(all_oa_ids),
                Employee.emp_code.in_(sub_emp),
            )
        )

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            Employee.oa_user_id.ilike(like_expr),
            Employee.emp_name.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query_base = count_query_base.where(kw_cond)

    if q.position_code:
        PosFilter = aliased(Position)
        query = query.join(PosFilter, Employee.position_id == PosFilter.id)
        query = query.where(PosFilter.position_code == q.position_code)
        count_query_base = count_query_base.join(PosFilter, Employee.position_id == PosFilter.id)
        count_query_base = count_query_base.where(PosFilter.position_code == q.position_code)

    if q.status:
        query = query.where(Employee.status.in_(q.status))
        count_query_base = count_query_base.where(Employee.status.in_(q.status))

    count_query = select(func.count()).select_from(count_query_base.subquery())
    total = (await db.execute(count_query)).scalar() or 0

    OrgAlias = aliased(Organization)
    PosAlias = aliased(Position)

    query = (
        query
        .outerjoin(OrgAlias, cast(Employee.org_id, String) == OrgAlias.oa_org_id)
        .outerjoin(PosAlias, Employee.position_id == PosAlias.id)
        .add_columns(
            OrgAlias.org_name.label("org_name"),
            PosAlias.position_name.label("pos_name"),
        )
        .order_by(Employee.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).all()

    items = []
    for row in rows:
        emp = row[0]
        items.append({
            "id": emp.id,
            "oa_user_id": emp.oa_user_id,
            "emp_name": emp.emp_name,
            "org_id": emp.org_id,
            "org_name": row.org_name,
            "position_name": row.pos_name or emp.position,
            "phone": _mask_phone(emp.phone),
            "email": emp.email,
            "status": emp.status,
        })

    return {"items": items, "total": total, "page": page, "page_size": page_size}
