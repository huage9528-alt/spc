"""基础数据与集成中心 — 基础数据CRUD API"""

import logging
from datetime import date, datetime, timedelta
from typing import List, Optional, Dict
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_, and_, cast, String, not_, case
from sqlalchemy.orm import aliased

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.core.audit import log_audit
from app.core.config import get_settings
from app.schemas.common import ResponseModel
from app.schemas.basicdata.schemas import (
    CustomerCreate, CustomerUpdate, CustomerOut,
    SupplierCreate, SupplierUpdate, SupplierOut, SupplierMatchRequest, SupplierMatchItem, SupplierMatchResult,
    MaterialCreate, MaterialUpdate, MaterialOut, MaterialTreeNode,
    SKUCreate, SKUUpdate, SKUOut,
    ProductCreate, ProductUpdate, ProductOut,
    WarehouseCreate, WarehouseUpdate, WarehouseOut,
    LocationCreate, LocationUpdate, LocationOut,
    ProcessCreate, ProcessUpdate, ProcessOut,
    OrganizationCreate, OrganizationUpdate, OrganizationOut, OrganizationTreeNode, OrganizationWithLeaderOut,
    PositionOut,
    EmployeeCreate, EmployeeUpdate, EmployeeOut,
)
from app.models.basicdata import (
    Customer, Supplier, Material, SKU, Product,
    Warehouse, Location, Process, Organization, Employee, Position,
    Inventory,
)
from app.models.material.inventory_check import StockCheck, StockCheckItem
from app.services.basicdata.position_role_service import sync_user_role_from_employee
from app.services.material.stock_check_service import (
    _get_recent_checked_by_warehouse,
    _resolve_recent_days,
)
from app.services.common.export_service import GenericExportService, ExportColumn
router = APIRouter()
logger = logging.getLogger(__name__)


def _apply_sort(query, model, sort_by: Optional[str], sort_order: Optional[str], sortable: dict):
    """通用排序辅助函数"""
    order_clauses = []
    if sort_by and sort_by in sortable:
        col = sortable[sort_by]
        if sort_order == 'desc':
            order_clauses.append(col.desc().nullslast())
        else:
            order_clauses.append(col.asc().nullslast())
    if not order_clauses:
        order_clauses = [model.id.desc()]
    return query.order_by(*order_clauses)


async def _enrich_recent_checked(db: AsyncSession, keys, recent_days: Optional[int] = None):
    """对 (material_id, wh_id) 列表，返回 {(mid, wh_id): {"checked","date","check_no"}}。

    "近期已盘" 口径与盘点建单预填补一致：最近一条 actual_qty 非空且未取消的盘点行，
    且 check_date 距今天不超过 recent_days（省略时用 STOCK_CHECK_RECENT_SKIP_DAYS，默认 7 天；
    recent_days < 0 = 不限，全部历史）。
    """
    if not keys:
        return {}
    skip_days = _resolve_recent_days(recent_days)
    today = date.today()
    raw = await _get_recent_checked_by_warehouse(db, keys)
    out: Dict = {}
    for k, v in raw.items():
        rd = v.get("check_date")
        out[k] = {
            "checked": rd is not None and (today - rd).days <= skip_days,
            "date": rd.isoformat() if rd else None,
            "check_no": v.get("check_no"),
        }
    return out


def _recent_checked_exists_cond(recent_days: Optional[int] = None, material_col=None, wh_col=None):
    """EXISTS 条件：该 (material_id, wh_id) 近 N 天(recent_days,省略用配置默认,
    负数=不限全部历史)存在 actual_qty 非空且未取消的盘点行。
    与 _enrich_recent_checked 的「近期已盘」口径一致。
    material_col/wh_col 用于指定关联的列表达式(默认 Inventory 行级,可传聚合子查询列)。"""
    skip_days = _resolve_recent_days(recent_days)
    cutoff = date.today() - timedelta(days=skip_days)
    if material_col is None:
        material_col = Inventory.material_id
    if wh_col is None:
        wh_col = Inventory.wh_id
    return (
        select(1)
        .select_from(StockCheckItem)
        .join(StockCheck, StockCheck.id == StockCheckItem.check_id)
        .where(
            StockCheckItem.material_id == material_col,
            StockCheckItem.wh_id == wh_col,
            StockCheckItem.actual_qty.isnot(None),
            StockCheck.status != "cancelled",
            StockCheck.check_date >= cutoff,
        )
        .exists()
    )


def _inventory_material_active_cond():
    """库存行排除已删除物料：不存在 is_deleted=1 的物料主数据行（逻辑删除）。"""
    return not_(
        select(1)
        .select_from(Material)
        .where(
            Material.erp_material_id == Inventory.material_id,
            Material.is_deleted == 1,
        )
        .exists()
    )


def _inventory_nonzero_qty_cond():
    """库存行排除零库存：qty_on_hand 为 0/NULL 的行不参与页面统计与导出。"""
    return func.coalesce(Inventory.qty_on_hand, 0) != 0


def _inventory_filter_conds(
    keyword: Optional[str] = None,
    material_code: Optional[str] = None,
    wh_code: Optional[str] = None,
    wh_name: Optional[str] = None,
    batch_no: Optional[str] = None,
    recent_checked: Optional[str] = None,
    recent_days: Optional[int] = None,
    time_filters: Optional[dict] = None,
) -> list:
    """库存列表/导出共用的筛选条件（含排除已删除物料与零库存）。"""
    conds = [_inventory_material_active_cond(), _inventory_nonzero_qty_cond()]
    if keyword:
        like = f"%{keyword}%"
        conds.append(or_(
            Inventory.material_code.ilike(like),
            Inventory.material_name.ilike(like),
            Inventory.wh_name.ilike(like),
        ))
    if material_code:
        vals = [v.strip() for v in material_code.split(",") if v.strip()]
        if vals:
            conds.append(Inventory.material_code.in_(vals))
    if wh_code:
        vals = [v.strip() for v in wh_code.split(",") if v.strip()]
        if vals:
            conds.append(Inventory.wh_code.in_(vals))
    if wh_name:
        vals = [v.strip() for v in wh_name.split(",") if v.strip()]
        if vals:
            conds.append(Inventory.wh_name.in_(vals))
    if batch_no:
        vals = [v.strip() for v in batch_no.split(",") if v.strip()]
        if vals:
            conds.append(Inventory.batch_no.in_(vals))
    if recent_checked is not None and recent_checked.strip().lower() in ("true", "1", "yes", "false", "0", "no"):
        rc_exists = _recent_checked_exists_cond(recent_days)
        conds.append(rc_exists if recent_checked.strip().lower() in ("true", "1", "yes") else not_(rc_exists))
    conds.extend(_inventory_time_conds(lambda f: getattr(Inventory, f), time_filters))
    return conds


# ── 收发时间字段筛选（最后入库/出库/领料时间）──

INVENTORY_TIME_FIELD_LABELS = {
    "last_inbound_at": "最后入库时间",
    "last_outbound_at": "最后出库时间",
    "last_picking_at": "最后领料时间",
}


def _inventory_time_query_params(
    last_inbound_at_start: Optional[str] = Query(None, description="最后入库时间 起(YYYY-MM-DD 或 ISO 时间)"),
    last_inbound_at_end: Optional[str] = Query(None, description="最后入库时间 止(YYYY-MM-DD 或 ISO 时间,日期取当天末)"),
    last_inbound_at_within_days: Optional[int] = Query(None, ge=0, le=100000, description="最后入库时间在最近 N 天内"),
    last_inbound_at_over_days: Optional[int] = Query(None, ge=0, le=100000, description="最后入库时间距今超过 N 天(含从未入库)"),
    last_outbound_at_start: Optional[str] = Query(None, description="最后出库时间 起(YYYY-MM-DD 或 ISO 时间)"),
    last_outbound_at_end: Optional[str] = Query(None, description="最后出库时间 止(YYYY-MM-DD 或 ISO 时间,日期取当天末)"),
    last_outbound_at_within_days: Optional[int] = Query(None, ge=0, le=100000, description="最后出库时间在最近 N 天内"),
    last_outbound_at_over_days: Optional[int] = Query(None, ge=0, le=100000, description="最后出库时间距今超过 N 天(含从未出库)"),
    last_picking_at_start: Optional[str] = Query(None, description="最后领料时间 起(YYYY-MM-DD 或 ISO 时间)"),
    last_picking_at_end: Optional[str] = Query(None, description="最后领料时间 止(YYYY-MM-DD 或 ISO 时间,日期取当天末)"),
    last_picking_at_within_days: Optional[int] = Query(None, ge=0, le=100000, description="最后领料时间在最近 N 天内"),
    last_picking_at_over_days: Optional[int] = Query(None, ge=0, le=100000, description="最后领料时间距今超过 N 天(含从未领料)"),
    days_in_stock_gt: Optional[int] = Query(None, ge=0, le=100000, description="呆滞天数大于 N 天(参考=最后出库时间,无则最后入库时间;两时间皆空的 '-' 行不计入)"),
    days_in_stock_lt: Optional[int] = Query(None, ge=0, le=100000, description="呆滞天数小于 N 天(参考同 gt;两时间皆空的 '-' 行不计入)"),
) -> dict:
    """三个收发时间字段的筛选参数(依赖注入,列表/导出共用),另含呆滞天数 大于/小于 N 天 阈值筛选。"""
    return {
        "last_inbound_at_start": last_inbound_at_start,
        "last_inbound_at_end": last_inbound_at_end,
        "last_inbound_at_within_days": last_inbound_at_within_days,
        "last_inbound_at_over_days": last_inbound_at_over_days,
        "last_outbound_at_start": last_outbound_at_start,
        "last_outbound_at_end": last_outbound_at_end,
        "last_outbound_at_within_days": last_outbound_at_within_days,
        "last_outbound_at_over_days": last_outbound_at_over_days,
        "last_picking_at_start": last_picking_at_start,
        "last_picking_at_end": last_picking_at_end,
        "last_picking_at_within_days": last_picking_at_within_days,
        "last_picking_at_over_days": last_picking_at_over_days,
        "days_in_stock_gt": days_in_stock_gt,
        "days_in_stock_lt": days_in_stock_lt,
    }


def _parse_dt_bound(value: Optional[str], ceil: bool = False) -> Optional[datetime]:
    """解析筛选时间边界。日期粒度(YYYY-MM-DD)按当天 00:00:00 / 23:59:59.999999;完整 ISO 时间原样使用。"""
    v = value.strip() if value else ""
    if not v:
        return None
    try:
        if len(v) == 10:
            dt = datetime.strptime(v, "%Y-%m-%d")
            if ceil:
                dt = dt.replace(hour=23, minute=59, second=59, microsecond=999999)
            return dt
        return datetime.fromisoformat(v)
    except ValueError:
        return None


def _inventory_time_conds(getter, params: Optional[dict] = None) -> list:
    """收发时间字段筛选条件。getter(field) 返回字段对应的 SQL 表达式:
    行级传 Inventory 列;按仓库聚合视图传 MAX 聚合表达式(组级语义)。
    - {f}_start/{f}_end: 时间范围(含边界)
    - {f}_within_days: 最近 N 天内(不含 NULL)
    - {f}_over_days: 距今超过 N 天(NULL 视为超过,即从未收发)
    同一字段多种条件同时给出时按 AND 叠加。"""
    if not params:
        return []
    conds = []
    now = datetime.now()
    for f in INVENTORY_TIME_FIELD_LABELS:
        col = getter(f)
        start = _parse_dt_bound(params.get(f"{f}_start"))
        end = _parse_dt_bound(params.get(f"{f}_end"), ceil=True)
        within_days = params.get(f"{f}_within_days")
        over_days = params.get(f"{f}_over_days")
        if start:
            conds.append(col >= start)
        if end:
            conds.append(col <= end)
        if within_days is not None:
            conds.append(col >= now - timedelta(days=int(within_days)))
        if over_days is not None:
            conds.append(or_(col <= now - timedelta(days=int(over_days)), col.is_(None)))
    return conds


def _inventory_dormant_conds(getter, params: Optional[dict] = None) -> list:
    """呆滞天数字段筛选条件,与前端单元格口径一致:
    呆滞天数 = (now - COALESCE(最后出库时间, 最后入库时间)) 取整天数;两时间皆空或未来时间的 '-' 行不计入筛选。
    getter(field) 返回字段对应的 SQL 表达式:行级传 Inventory 列;按仓库聚合视图传 MAX 聚合表达式。
    - days_in_stock_gt: 呆滞天数 > N 天
    - days_in_stock_lt: 呆滞天数 < N 天"""
    if not params:
        return []
    gt = params.get("days_in_stock_gt")
    lt = params.get("days_in_stock_lt")
    if gt is None and lt is None:
        return []
    now = datetime.now()
    ref = func.coalesce(getter("last_outbound_at"), getter("last_inbound_at"))
    conds = [ref.isnot(None), ref <= now]
    if gt is not None:
        conds.append(ref <= now - timedelta(days=int(gt) + 1))
    if lt is not None:
        conds.append(ref > now - timedelta(days=int(lt)))
    return conds


def _inventory_dormant_days_export(out_at: Optional[datetime], in_at: Optional[datetime]) -> Optional[int]:
    """呆滞天数导出值,与前端单元格口径一致: 参考 = 最后出库时间(无则最后入库时间), 取整天数;
    两时间皆空或未来时间返回 None(导出空单元格)。"""
    ref = out_at or in_at
    if not ref:
        return None
    diff = int((datetime.now() - ref).total_seconds() // 86400)
    return diff if diff >= 0 else None


def _inventory_dormant_sort_clause(col_out, col_in, sort_order: Optional[str]):
    """呆滞天数排序子句(与单元格显示口径一致): 排序值 = 参考时间 COALESCE(最后出库, 最后入库)。
    升序 = 参考新→旧(天数小→大), 降序 = 参考旧→新(天数大→小);
    参考为空或未来时间的 '-' 行恒排末尾, 避免仅按最后出库时间排序导致无出库行乱序。
    col_* 行级传 Inventory 列, 按仓库聚合视图传 MAX 聚合表达式。"""
    now = datetime.now()
    ref = func.coalesce(col_out, col_in)
    disp = case((or_(ref.is_(None), ref > now), None), else_=ref)
    return disp.desc().nullslast() if sort_order == "desc" else disp.asc().nullslast()


def _employee_out(employee: Employee, position_name: Optional[str] = None, manager_name: Optional[str] = None) -> EmployeeOut:
    data = EmployeeOut.model_validate(employee)
    data.position_name = position_name or employee.position
    data.manager_name = manager_name
    return data


def _can_manage_employee(current_user: dict, target_employee: Employee) -> bool:
    """检查当前用户是否有权限管理目标员工（上级管理下级或自己管理自己）"""
    if current_user.get("role") == "admin":
        return True
    current_oa_user_id = current_user.get("oa_user_id")
    if not current_oa_user_id:
        return False
    # 可以管理自己
    if target_employee.oa_user_id == current_oa_user_id:
        return True
    # 可以管理下级
    if target_employee.manager_oa_user_id == current_oa_user_id:
        return True
    return False


def _position_out(position: Position) -> PositionOut:
    return PositionOut.model_validate(position)



# ── Customer ──
@router.get("/customers", response_model=ResponseModel[dict])
async def list_customers(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索编码/名称"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    customer_level: Optional[str] = Query(None, description="客户等级筛选，逗号分隔"),
    status: Optional[str] = Query(None, description="状态筛选，逗号分隔"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.customers", "read"))
):
    """查询客户列表（分页+排序+筛选）"""
    SORTABLE = {
        'customer_code': Customer.customer_code,
        'customer_name': Customer.customer_name,
        'customer_short': Customer.customer_short,
        'customer_level': Customer.customer_level,
        'status': Customer.status,
    }
    query = select(Customer)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(Customer.customer_code.ilike(like), Customer.customer_name.ilike(like)))
    if customer_level:
        levels = [l.strip() for l in customer_level.split(",") if l.strip()]
        if levels:
            query = query.where(Customer.customer_level.in_(levels))
    if status:
        statuses = [int(s.strip()) for s in status.split(",") if s.strip().isdigit()]
        if statuses:
            query = query.where(Customer.status.in_(statuses))

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    query = _apply_sort(query, Customer, sort_by, sort_order, SORTABLE)
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = [CustomerOut.model_validate(r) for r in result.scalars().all()]
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/customers/stats", response_model=ResponseModel[dict])
async def get_customer_stats(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.customers", "read"))
):
    """客户统计：总数 / 按等级 / 停用数"""
    result = await db.execute(
        select(Customer.customer_level, Customer.status, func.count())
        .group_by(Customer.customer_level, Customer.status)
    )
    total = 0
    disabled = 0
    by_level: Dict[str, int] = {"A": 0, "B": 0, "C": 0, "": 0}
    for level, status_val, cnt in result.all():
        total += cnt
        if status_val == 0:
            disabled += cnt
        key = level or ""
        by_level[key] = by_level.get(key, 0) + cnt
    return ResponseModel(data={"total": total, "by_level": by_level, "disabled": disabled})


@router.get("/customers/{customer_id}", response_model=CustomerOut)
async def get_customer(customer_id: int, db: AsyncSession = Depends(get_db)):
    """查询单个客户"""
    result = await db.execute(select(Customer).filter(Customer.id == customer_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="客户不存在")
    return item


@router.post("/customers", response_model=CustomerOut)
async def create_customer(customer: CustomerCreate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.customers", "create"))):
    """创建客户"""
    # 检查编码唯一性
    result = await db.execute(select(Customer).filter(Customer.customer_code == customer.customer_code))
    existing = result.scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="客户编码已存在")
    
    db_item = Customer(**customer.model_dump())
    db.add(db_item)
    await db.flush()
    await log_audit(db, "customer", db_item.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.put("/customers/{customer_id}", response_model=CustomerOut)
async def update_customer(customer_id: int, customer: CustomerUpdate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.customers", "update"))):
    """更新客户"""
    result = await db.execute(select(Customer).filter(Customer.id == customer_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="客户不存在")
    
    update_data = customer.model_dump(exclude_unset=True)
    await log_audit(db, "customer", db_item.id, "update", old_obj=db_item, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(db_item, field, value)
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.delete("/customers/{customer_id}")
async def delete_customer(customer_id: int, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.customers", "delete"))):
    """删除客户"""
    result = await db.execute(select(Customer).filter(Customer.id == customer_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="客户不存在")
    
    await log_audit(db, "customer", db_item.id, "delete", operator=current_user["username"])
    await db.delete(db_item)
    await db.commit()
    return {"message": "删除成功"}


# ── Supplier ──
@router.get("/suppliers", response_model=ResponseModel[dict])
async def list_suppliers(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索编码/名称"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    supplier_type: Optional[str] = Query(None, description="供应商类型筛选，逗号分隔"),
    status: Optional[str] = Query(None, description="状态筛选，逗号分隔"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.suppliers", "read"))
):
    """查询供应商列表（分页+排序+筛选）"""
    SORTABLE = {
        'supplier_code': Supplier.supplier_code,
        'supplier_name': Supplier.supplier_name,
        'supplier_type': Supplier.supplier_type,
        'contact_person': Supplier.contact_person,
        'status': Supplier.status,
    }
    query = select(Supplier)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(Supplier.supplier_code.ilike(like), Supplier.supplier_name.ilike(like)))
    if supplier_type:
        types = [t.strip() for t in supplier_type.split(",") if t.strip()]
        if types:
            query = query.where(Supplier.supplier_type.in_(types))
    if status:
        statuses = [int(s.strip()) for s in status.split(",") if s.strip().isdigit()]
        if statuses:
            query = query.where(Supplier.status.in_(statuses))

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    query = _apply_sort(query, Supplier, sort_by, sort_order, SORTABLE)
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = [SupplierOut.model_validate(r) for r in result.scalars().all()]
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/suppliers/stats", response_model=ResponseModel[dict])
async def get_supplier_stats(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.suppliers", "read"))
):
    """供应商统计：总数 / 按类型 / 未关联ERP / 停用数"""
    result = await db.execute(
        select(
            Supplier.supplier_type,
            Supplier.erp_supply_id,
            Supplier.status,
            func.count(),
        ).group_by(Supplier.supplier_type, Supplier.erp_supply_id, Supplier.status)
    )
    total = 0
    no_erp = 0
    disabled = 0
    by_type: Dict[str, int] = {}
    for stype, erp_id, status_val, cnt in result.all():
        total += cnt
        if erp_id is None:
            no_erp += cnt
        if status_val == 0:
            disabled += cnt
        key = stype or ""
        by_type[key] = by_type.get(key, 0) + cnt
    return ResponseModel(data={"total": total, "by_type": by_type, "no_erp": no_erp, "disabled": disabled})


@router.get("/suppliers/{supplier_id}", response_model=SupplierOut)
async def get_supplier(supplier_id: int, db: AsyncSession = Depends(get_db)):
    """查询单个供应商"""
    result = await db.execute(select(Supplier).filter(Supplier.id == supplier_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="供应商不存在")
    return item


@router.post("/suppliers", response_model=SupplierOut)
async def create_supplier(supplier: SupplierCreate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.suppliers", "create"))):
    """创建供应商"""
    result = await db.execute(select(Supplier).filter(Supplier.supplier_code == supplier.supplier_code))
    existing = result.scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="供应商编码已存在")
    
    db_item = Supplier(**supplier.model_dump())
    db.add(db_item)
    await db.flush()
    await log_audit(db, "supplier", db_item.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.put("/suppliers/{supplier_id}", response_model=SupplierOut)
async def update_supplier(supplier_id: int, supplier: SupplierUpdate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.suppliers", "update"))):
    """更新供应商"""
    result = await db.execute(select(Supplier).filter(Supplier.id == supplier_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="供应商不存在")
    
    update_data = supplier.model_dump(exclude_unset=True)
    await log_audit(db, "supplier", db_item.id, "update", old_obj=db_item, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(db_item, field, value)
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.delete("/suppliers/{supplier_id}")
async def delete_supplier(supplier_id: int, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.suppliers", "delete"))):
    """删除供应商"""
    result = await db.execute(select(Supplier).filter(Supplier.id == supplier_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="供应商不存在")
    
    await log_audit(db, "supplier", db_item.id, "delete", operator=current_user["username"])
    await db.delete(db_item)
    await db.commit()
    return {"message": "删除成功"}


@router.post("/suppliers/match", response_model=ResponseModel[SupplierMatchResult])
async def match_suppliers(
    req: SupplierMatchRequest,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.suppliers", "read"))
):
    """模糊匹配供应商名称 — 供供应商物料对照使用"""
    if not req.names:
        return ResponseModel(data=SupplierMatchResult(matched=[], unmatched=[]))

    all_suppliers = (await db.execute(select(Supplier).filter(Supplier.status == 1))).scalars().all()
    supplier_map = {}
    for s in all_suppliers:
        supplier_map[s.supplier_name] = s
        if s.supplier_short:
            supplier_map[s.supplier_short] = s

    matched: list[SupplierMatchItem] = []
    unmatched: list[str] = []

    for name in req.names:
        name = name.strip()
        if not name:
            continue
        hits = []
        for key, s in supplier_map.items():
            if name == key or name in key or key in name:
                hits.append(s)
        if not hits:
            unmatched.append(name)
        elif len(hits) == 1:
            s = hits[0]
            matched.append(SupplierMatchItem(
                input_name=name, supplier_id=s.id, supplier_name=s.supplier_name,
                supplier_code=s.supplier_code, supplier_short=s.supplier_short,
                erp_supply_id=s.erp_supply_id, ambiguous=False,
            ))
        else:
            s = hits[0]
            matched.append(SupplierMatchItem(
                input_name=name, supplier_id=s.id, supplier_name=s.supplier_name,
                supplier_code=s.supplier_code, supplier_short=s.supplier_short,
                erp_supply_id=s.erp_supply_id, ambiguous=True,
            ))

    return ResponseModel(data=SupplierMatchResult(matched=matched, unmatched=unmatched))


@router.get("/materials/by-suppliers", response_model=ResponseModel[dict])
async def get_materials_by_suppliers(
    erp_supply_ids: str = Query(..., description="逗号分隔的 ERP 供应商 ID 列表"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.materials", "read"))
):
    """按供应商 ERP ID 列表反查名下物料"""
    id_strs = [s.strip() for s in erp_supply_ids.split(",") if s.strip().isdigit()]
    if not id_strs:
        return ResponseModel(data={"items": [], "total": 0})
    erp_ids = [int(s) for s in id_strs]

    query = (
        select(Material, Supplier.supplier_name, Supplier.supplier_code)
        .outerjoin(Supplier, Material.supplier_id == Supplier.erp_supply_id)
        .filter(Material.is_deleted == 0, Material.supplier_id.in_(erp_ids))
        .order_by(Material.material_code)
    )
    rows = (await db.execute(query)).all()
    items = []
    for m, supplier_name, supplier_code in rows:
        out = MaterialOut.model_validate(m).model_dump()
        out["supplier_name"] = supplier_name
        out["supplier_code"] = supplier_code
        items.append(out)

    msg = None
    total = len(items)
    if not total:
        msg = "所选供应商名下暂无物料（物料主数据可能未维护供应商归属）"

    return ResponseModel(message=msg, data={"items": items, "total": total})


# ── Material ──
@router.get("/materials/tree", response_model=ResponseModel[List[MaterialTreeNode]])
async def get_material_tree(db: AsyncSession = Depends(get_db)):
    """查询物料树形结构"""
    result = await db.execute(
        select(Material)
        .filter(Material.is_deleted == 0)
        .order_by(Material.parent_id.nullsfirst(), Material.id)
    )
    all_items = result.scalars().all()

    node_map: dict[int, MaterialTreeNode] = {}
    roots: List[MaterialTreeNode] = []
    for item in all_items:
        node = MaterialTreeNode(
            id=item.id, erp_material_id=item.erp_material_id, parent_id=item.parent_id,
            material_code=item.material_code, material_name=item.material_name,
            spec_model=item.spec_model, material_type=item.material_type,
            unit_of_measure=item.unit_of_measure, brand=item.brand,
            is_purchase=item.is_purchase, is_produce=item.is_produce,
            status=item.status, children=[],
        )
        node_map[item.erp_material_id] = node
        if item.parent_id is None:
            roots.append(node)
        else:
            parent = node_map.get(item.parent_id)
            if parent:
                parent.children.append(node)
            else:
                roots.append(node)
    return ResponseModel(data=roots)


@router.get("/materials", response_model=ResponseModel[dict])
async def list_materials(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    parent_id: Optional[int] = Query(None, description="父级物料ID筛选, None表示根级"),
    keyword: Optional[str] = Query(None, description="搜索编码/名称"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    material_type: Optional[str] = Query(None, description="物料分类筛选，逗号分隔"),
    status: Optional[str] = Query(None, description="状态筛选，逗号分隔"),
    material_property: Optional[str] = Query(None, description="物料属性筛选，逗号分隔(1外购/2自制/3委外/5虚拟件/9组装件)"),
    data_source: Optional[str] = Query(None, description="数据来源筛选，逗号分隔(erp/manual/excel)"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.materials", "read"))
):
    """查询物料列表（分页+排序+筛选, 默认排除已删除）"""
    SORTABLE = {
        'material_code': Material.material_code,
        'material_name': Material.material_name,
        'spec_model': Material.spec_model,
        'material_type': Material.material_type,
        'unit_of_measure': Material.unit_of_measure,
        'status': Material.status,
        'material_property': Material.material_property,
        'brand': Material.brand,
        'data_source': Material.data_source,
        'order_unit_price': Material.order_unit_price,
        'last_outbound_date': Material.last_outbound_date,
    }
    query = (
        select(Material, Supplier.supplier_name)
        .outerjoin(Supplier, Material.supplier_id == Supplier.erp_supply_id)
        .filter(Material.is_deleted == 0)
    )
    if parent_id is not None:
        query = query.filter(Material.parent_id == parent_id)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(Material.material_code.ilike(like), Material.material_name.ilike(like), Material.spec_model.ilike(like)))
    if material_type:
        types = [t.strip() for t in material_type.split(",") if t.strip()]
        if types:
            query = query.where(Material.material_type.in_(types))
    if status:
        statuses = [int(s.strip()) for s in status.split(",") if s.strip().isdigit()]
        if statuses:
            query = query.where(Material.status.in_(statuses))
    if material_property:
        props = [int(p.strip()) for p in material_property.split(",") if p.strip().isdigit()]
        if props:
            query = query.where(Material.material_property.in_(props))
    if data_source:
        sources = [s.strip() for s in data_source.split(",") if s.strip()]
        if sources:
            query = query.where(Material.data_source.in_(sources))

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    query = _apply_sort(query, Material, sort_by, sort_order, SORTABLE)
    rows = (await db.execute(query.offset((page - 1) * page_size).limit(page_size))).all()
    items = []
    for m, supplier_name in rows:
        out = MaterialOut.model_validate(m).model_dump()
        out["supplier_name"] = supplier_name
        items.append(out)
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/materials/stats", response_model=ResponseModel[dict])
async def get_material_stats(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.materials", "read"))
):
    """物料统计（筛选 chips 计数）：总数 / 按属性 / 停用数 / 全部分类"""
    result = await db.execute(
        select(Material.material_property, Material.status, func.count())
        .filter(Material.is_deleted == 0)
        .group_by(Material.material_property, Material.status)
    )
    total = 0
    disabled = 0
    by_property: Dict[str, int] = {}
    for prop, st, cnt in result.all():
        total += cnt
        if st == 0:
            disabled += cnt
        if prop is not None:
            by_property[str(prop)] = by_property.get(str(prop), 0) + cnt
    types_result = await db.execute(
        select(Material.material_type)
        .filter(Material.is_deleted == 0)
        .distinct()
        .order_by(Material.material_type)
    )
    types = [t[0] for t in types_result.all()]
    return ResponseModel(data={
        "total": total, "disabled": disabled, "by_property": by_property, "types": types,
    })


@router.get("/materials/{erp_material_id}", response_model=ResponseModel[MaterialOut])
async def get_material(erp_material_id: int, db: AsyncSession = Depends(get_db)):
    """查询单个物料"""
    result = await db.execute(
        select(Material).filter(Material.erp_material_id == erp_material_id, Material.is_deleted == 0)
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="物料不存在")
    return ResponseModel(data=MaterialOut.model_validate(item))


@router.post("/materials", response_model=ResponseModel[MaterialOut])
async def create_material(material: MaterialCreate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.materials", "create"))):
    """创建物料"""
    result = await db.execute(select(Material).filter(Material.erp_material_id == material.erp_material_id))
    existing = result.scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="ERP物料ID已存在")

    db_item = Material(**material.model_dump())
    db.add(db_item)
    await db.flush()
    await log_audit(db, "material", db_item.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(db_item)
    return ResponseModel(data=MaterialOut.model_validate(db_item))


@router.put("/materials/{erp_material_id}", response_model=ResponseModel[MaterialOut])
async def update_material(erp_material_id: int, material: MaterialUpdate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.materials", "update"))):
    """更新物料"""
    result = await db.execute(select(Material).filter(Material.erp_material_id == erp_material_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="物料不存在")

    update_data = material.model_dump(exclude_unset=True)
    await log_audit(db, "material", db_item.id, "update", old_obj=db_item, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(db_item, field, value)
    await db.commit()
    await db.refresh(db_item)
    return ResponseModel(data=MaterialOut.model_validate(db_item))


@router.delete("/materials/{erp_material_id}", response_model=ResponseModel[dict])
async def delete_material(erp_material_id: int, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.materials", "delete"))):
    """逻辑删除物料"""
    result = await db.execute(
        select(Material).filter(Material.erp_material_id == erp_material_id, Material.is_deleted == 0)
    )
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="物料不存在")

    await log_audit(db, "material", db_item.id, "delete", operator=current_user["username"])
    db_item.is_deleted = 1
    await db.commit()
    return ResponseModel(data={"message": "删除成功"})


@router.get("/materials/{erp_material_id}/references", response_model=ResponseModel[dict])
async def get_material_references(
    erp_material_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.materials", "read"))
):
    """物料被引用位置：关联 SKU + 直接子物料数（详情抽屉用）"""
    sku_result = await db.execute(
        select(SKU)
        .filter(SKU.material_id == erp_material_id)
        .order_by(SKU.id)
        .limit(20)
    )
    child_result = await db.execute(
        select(func.count())
        .select_from(Material)
        .where(Material.parent_id == erp_material_id, Material.is_deleted == 0)
    )
    child_count = child_result.scalar() or 0
    return ResponseModel(data={
        "skus": [SKUOut.model_validate(s) for s in sku_result.scalars().all()],
        "child_count": child_count,
    })


# ── SKU ──
@router.get("/skus", response_model=ResponseModel[dict])
async def list_skus(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索编码/名称"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.skus", "read"))
):
    """查询SKU列表（分页+排序+筛选）"""
    SORTABLE = {
        'sku_code': SKU.sku_code,
        'sku_name': SKU.sku_name,
        'material_id': SKU.material_id,
        'barcode': SKU.barcode,
    }
    query = select(SKU)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(SKU.sku_code.ilike(like), SKU.sku_name.ilike(like)))

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    query = _apply_sort(query, SKU, sort_by, sort_order, SORTABLE)
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = [SKUOut.model_validate(r) for r in result.scalars().all()]
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/skus/stats", response_model=ResponseModel[dict])
async def get_sku_stats(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.skus", "read"))
):
    """SKU统计：总数 / 有条码 / 缺条码"""
    has_barcode = and_(SKU.barcode.isnot(None), SKU.barcode != "")
    result = await db.execute(select(has_barcode, func.count()).group_by(has_barcode))
    total = 0
    with_barcode = 0
    for flag, cnt in result.all():
        total += cnt
        if flag:
            with_barcode += cnt
    return ResponseModel(data={"total": total, "with_barcode": with_barcode, "without_barcode": total - with_barcode})


@router.get("/skus/{sku_id}", response_model=SKUOut)
async def get_sku(sku_id: int, db: AsyncSession = Depends(get_db)):
    """查询单个SKU"""
    result = await db.execute(select(SKU).filter(SKU.id == sku_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="SKU不存在")
    return item


@router.post("/skus", response_model=SKUOut)
async def create_sku(sku: SKUCreate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.skus", "create"))):
    """创建SKU"""
    result = await db.execute(select(SKU).filter(SKU.sku_code == sku.sku_code))
    existing = result.scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="SKU编码已存在")
    
    db_item = SKU(**sku.model_dump())
    db.add(db_item)
    await db.flush()
    await log_audit(db, "sku", db_item.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.put("/skus/{sku_id}", response_model=SKUOut)
async def update_sku(sku_id: int, sku: SKUUpdate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.skus", "update"))):
    """更新SKU"""
    result = await db.execute(select(SKU).filter(SKU.id == sku_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="SKU不存在")
    
    update_data = sku.model_dump(exclude_unset=True)
    await log_audit(db, "sku", db_item.id, "update", old_obj=db_item, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(db_item, field, value)
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.delete("/skus/{sku_id}")
async def delete_sku(sku_id: int, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.skus", "delete"))):
    """删除SKU"""
    result = await db.execute(select(SKU).filter(SKU.id == sku_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="SKU不存在")
    
    await log_audit(db, "sku", db_item.id, "delete", operator=current_user["username"])
    await db.delete(db_item)
    await db.commit()
    return {"message": "删除成功"}


# ── Product ──
@router.get("/products", response_model=ResponseModel[dict])
async def list_products(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索编码"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.products", "read"))
):
    """查询产品列表（分页+排序+筛选）"""
    SORTABLE = {
        'product_code': Product.product_code,
        'product_line': Product.product_line,
        'tech_version': Product.tech_version,
        'bom_version': Product.bom_version,
    }
    query = select(Product)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(Product.product_code.ilike(like))

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    query = _apply_sort(query, Product, sort_by, sort_order, SORTABLE)
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = [ProductOut.model_validate(r) for r in result.scalars().all()]
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/products/stats", response_model=ResponseModel[dict])
async def get_product_stats(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.products", "read"))
):
    """产品统计：总数 / 按产品线 / 缺默认仓库"""
    missing_wh = or_(Product.default_warehouse.is_(None), Product.default_warehouse == "")
    result = await db.execute(
        select(Product.product_line, missing_wh, func.count())
        .group_by(Product.product_line, missing_wh)
    )
    total = 0
    missing_default_warehouse = 0
    by_product_line: Dict[str, int] = {}
    for line, missing, cnt in result.all():
        total += cnt
        if missing:
            missing_default_warehouse += cnt
        key = line or ""
        by_product_line[key] = by_product_line.get(key, 0) + cnt
    return ResponseModel(data={"total": total, "by_product_line": by_product_line, "missing_default_warehouse": missing_default_warehouse})


@router.get("/products/{product_id}", response_model=ProductOut)
async def get_product(product_id: int, db: AsyncSession = Depends(get_db)):
    """查询单个产品"""
    result = await db.execute(select(Product).filter(Product.id == product_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="产品不存在")
    return item


@router.post("/products", response_model=ProductOut)
async def create_product(product: ProductCreate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.products", "create"))):
    """创建产品"""
    result = await db.execute(select(Product).filter(Product.product_code == product.product_code))
    existing = result.scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="产品编码已存在")
    
    db_item = Product(**product.model_dump())
    db.add(db_item)
    await db.flush()
    await log_audit(db, "product", db_item.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.put("/products/{product_id}", response_model=ProductOut)
async def update_product(product_id: int, product: ProductUpdate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.products", "update"))):
    """更新产品"""
    result = await db.execute(select(Product).filter(Product.id == product_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="产品不存在")
    
    update_data = product.model_dump(exclude_unset=True)
    await log_audit(db, "product", db_item.id, "update", old_obj=db_item, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(db_item, field, value)
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.delete("/products/{product_id}")
async def delete_product(product_id: int, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.products", "delete"))):
    """删除产品"""
    result = await db.execute(select(Product).filter(Product.id == product_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="产品不存在")
    
    await log_audit(db, "product", db_item.id, "delete", operator=current_user["username"])
    await db.delete(db_item)
    await db.commit()
    return {"message": "删除成功"}


# ── Warehouse ──
@router.get("/warehouses", response_model=ResponseModel[dict])
async def list_warehouses(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索编码/名称"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    wh_type: Optional[str] = Query(None, description="仓库类型筛选，逗号分隔"),
    is_enabled: Optional[str] = Query(None, description="启用状态筛选，逗号分隔"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.warehouses", "read"))
):
    """查询仓库列表（分页+排序+筛选）"""
    SORTABLE = {
        'wh_code': Warehouse.wh_code,
        'wh_name': Warehouse.wh_name,
        'wh_type': Warehouse.wh_type,
        'is_enabled': Warehouse.is_enabled,
    }
    query = select(Warehouse)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(Warehouse.wh_code.ilike(like), Warehouse.wh_name.ilike(like)))
    if wh_type:
        types = [t.strip() for t in wh_type.split(",") if t.strip()]
        if types:
            query = query.where(Warehouse.wh_type.in_(types))
    if is_enabled:
        statuses = [int(s.strip()) for s in is_enabled.split(",") if s.strip().isdigit()]
        if statuses:
            query = query.where(Warehouse.is_enabled.in_(statuses))

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    query = _apply_sort(query, Warehouse, sort_by, sort_order, SORTABLE)
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = [WarehouseOut.model_validate(r) for r in result.scalars().all()]
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/warehouses/stats", response_model=ResponseModel[dict])
async def get_warehouse_stats(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.warehouses", "read"))
):
    """仓库统计：总数 / 按类型 / 停用数 / 未删库位数"""
    result = await db.execute(
        select(Warehouse.wh_type, Warehouse.is_enabled, func.count())
        .group_by(Warehouse.wh_type, Warehouse.is_enabled)
    )
    total = 0
    disabled = 0
    by_type: Dict[str, int] = {}
    for wtype, enabled_val, cnt in result.all():
        total += cnt
        if enabled_val == 0:
            disabled += cnt
        key = wtype or ""
        by_type[key] = by_type.get(key, 0) + cnt
    location_count = (await db.execute(
        select(func.count()).select_from(Location).where(Location.is_deleted == 0)
    )).scalar() or 0
    return ResponseModel(data={"total": total, "by_type": by_type, "disabled": disabled, "location_count": location_count})


@router.get("/warehouses/{warehouse_id}", response_model=WarehouseOut)
async def get_warehouse(warehouse_id: int, db: AsyncSession = Depends(get_db)):
    """查询单个仓库"""
    result = await db.execute(select(Warehouse).filter(Warehouse.id == warehouse_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="仓库不存在")
    return item


@router.post("/warehouses", response_model=WarehouseOut)
async def create_warehouse(warehouse: WarehouseCreate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.warehouses", "create"))):
    """创建仓库"""
    result = await db.execute(select(Warehouse).filter(Warehouse.wh_code == warehouse.wh_code))
    existing = result.scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="仓库编码已存在")
    
    db_item = Warehouse(**warehouse.model_dump())
    db.add(db_item)
    await db.flush()
    await log_audit(db, "warehouse", db_item.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.put("/warehouses/{warehouse_id}", response_model=WarehouseOut)
async def update_warehouse(warehouse_id: int, warehouse: WarehouseUpdate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.warehouses", "update"))):
    """更新仓库"""
    result = await db.execute(select(Warehouse).filter(Warehouse.id == warehouse_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="仓库不存在")
    
    update_data = warehouse.model_dump(exclude_unset=True)
    await log_audit(db, "warehouse", db_item.id, "update", old_obj=db_item, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(db_item, field, value)
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.delete("/warehouses/{warehouse_id}")
async def delete_warehouse(warehouse_id: int, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.warehouses", "delete"))):
    """删除仓库"""
    result = await db.execute(select(Warehouse).filter(Warehouse.id == warehouse_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="仓库不存在")
    
    await log_audit(db, "warehouse", db_item.id, "delete", operator=current_user["username"])
    await db.delete(db_item)
    await db.commit()
    return {"message": "删除成功"}


# ── Location ──
@router.get("/locations", response_model=ResponseModel[dict])
async def list_locations(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索编码/名称"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    depth: Optional[str] = Query(None, description="层级深度筛选，逗号分隔"),
    detail_flag: Optional[str] = Query(None, description="明细标识筛选，逗号分隔"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.locations", "read"))
):
    """查询库位列表（分页+排序+筛选）"""
    SORTABLE = {
        'location_id': Location.location_id,
        'location_code': Location.location_code,
        'location_name': Location.location_name,
        'depth': Location.depth,
        'detail_flag': Location.detail_flag,
    }
    query = select(Location).where(Location.is_deleted == 0)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(
            cast(Location.location_id, String).ilike(like),
            Location.location_code.ilike(like),
            Location.location_name.ilike(like),
            Location.location_full_name.ilike(like),
        ))
    if depth:
        depths = [int(d.strip()) for d in depth.split(",") if d.strip().isdigit()]
        if depths:
            query = query.where(Location.depth.in_(depths))
    if detail_flag:
        flags = [int(f.strip()) for f in detail_flag.split(",") if f.strip().isdigit()]
        if flags:
            query = query.where(Location.detail_flag.in_(flags))

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    query = _apply_sort(query, Location, sort_by, sort_order, SORTABLE)
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = [LocationOut.model_validate(r) for r in result.scalars().all()]
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/locations/stats", response_model=ResponseModel[dict])
async def get_location_stats(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.locations", "read"))
):
    """库位统计（含软删）：总数 / 按层级 / 软删数 / 按来源"""
    result = await db.execute(
        select(Location.depth, Location.is_deleted, Location.data_source, func.count())
        .group_by(Location.depth, Location.is_deleted, Location.data_source)
    )
    total = 0
    deleted = 0
    by_depth: Dict[str, int] = {}
    by_source: Dict[str, int] = {}
    for depth, deleted_val, source, cnt in result.all():
        total += cnt
        if deleted_val == 1:
            deleted += cnt
        by_depth[str(depth)] = by_depth.get(str(depth), 0) + cnt
        key = source or ""
        by_source[key] = by_source.get(key, 0) + cnt
    return ResponseModel(data={"total": total, "by_depth": by_depth, "deleted": deleted, "by_source": by_source})


@router.get("/locations/tree", response_model=ResponseModel[dict])
async def get_location_tree(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.locations", "read"))
):
    """查询库位树形结构（含软删，按 depth→location_id 排序）"""
    result = await db.execute(
        select(Location).order_by(Location.depth, Location.location_id)
    )
    all_items = result.scalars().all()

    node_map: dict[int, dict] = {}
    for item in all_items:
        node_map[item.location_id] = {
            "id": item.id,
            "location_id": item.location_id,
            "location_code": item.location_code,
            "location_name": item.location_name,
            "location_full_name": item.location_full_name,
            "depth": item.depth,
            "detail_flag": item.detail_flag,
            "parent_id": item.parent_id,
            "data_source": item.data_source,
            "system_type": item.system_type,
            "is_deleted": item.is_deleted,
            "children": [],
        }

    roots: List[dict] = []
    for item in all_items:
        node = node_map.get(item.location_id)
        if not node:
            continue
        if item.parent_id is None or item.parent_id == "":
            roots.append(node)
        else:
            parent = node_map.get(item.parent_id)
            if parent:
                parent["children"].append(node)
            else:
                roots.append(node)
    return ResponseModel(data={"tree": roots, "total": len(all_items)})


@router.get("/locations/{location_id}", response_model=LocationOut)
async def get_location(location_id: int, db: AsyncSession = Depends(get_db)):
    """查询单个库位"""
    result = await db.execute(select(Location).filter(Location.id == location_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="库位不存在")
    return item


@router.post("/locations", response_model=LocationOut)
async def create_location(location: LocationCreate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.locations", "create"))):
    """创建库位"""
    result = await db.execute(select(Location).filter(Location.location_id == location.location_id))
    existing = result.scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="库位ID已存在")
    
    db_item = Location(**location.model_dump())
    db.add(db_item)
    await db.flush()
    await log_audit(db, "location", db_item.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.put("/locations/{location_id}", response_model=LocationOut)
async def update_location(location_id: int, location: LocationUpdate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.locations", "update"))):
    """更新库位"""
    result = await db.execute(select(Location).filter(Location.id == location_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="库位不存在")
    
    update_data = location.model_dump(exclude_unset=True)
    await log_audit(db, "location", db_item.id, "update", old_obj=db_item, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(db_item, field, value)
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.delete("/locations/{location_id}")
async def delete_location(location_id: int, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.locations", "delete"))):
    """删除库位"""
    result = await db.execute(select(Location).filter(Location.id == location_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="库位不存在")
    
    await log_audit(db, "location", db_item.id, "delete", operator=current_user["username"])
    await db.delete(db_item)
    await db.commit()
    return {"message": "删除成功"}


# ── Process ──
@router.get("/processes", response_model=ResponseModel[dict])
async def list_processes(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索编码/名称"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    process_group: Optional[str] = Query(None, description="工序分组筛选，逗号分隔"),
    is_qc_point: Optional[str] = Query(None, description="质检点筛选，逗号分隔"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.processes", "read"))
):
    """查询工序列表（分页+排序+筛选）"""
    SORTABLE = {
        'process_code': Process.process_code,
        'process_name': Process.process_name,
        'process_group': Process.process_group,
        'work_center': Process.work_center,
        'is_qc_point': Process.is_qc_point,
    }
    query = select(Process)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(Process.process_code.ilike(like), Process.process_name.ilike(like)))
    if process_group:
        groups = [g.strip() for g in process_group.split(",") if g.strip()]
        if groups:
            query = query.where(Process.process_group.in_(groups))
    if is_qc_point:
        vals = [int(v.strip()) for v in is_qc_point.split(",") if v.strip().isdigit()]
        if vals:
            query = query.where(Process.is_qc_point.in_(vals))

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    query = _apply_sort(query, Process, sort_by, sort_order, SORTABLE)
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = [ProcessOut.model_validate(r) for r in result.scalars().all()]
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/processes/stats", response_model=ResponseModel[dict])
async def get_process_stats(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.processes", "read"))
):
    """工序统计：总数 / 质检点 / 分组数 / 缺标准工时"""
    result = await db.execute(
        select(
            Process.is_qc_point,
            Process.standard_hour,
            func.count(),
        ).group_by(Process.is_qc_point, Process.standard_hour)
    )
    total = 0
    qc_points = 0
    missing_standard_hour = 0
    for qc_val, std_hour, cnt in result.all():
        total += cnt
        if qc_val == 1:
            qc_points += cnt
        if std_hour is None:
            missing_standard_hour += cnt
    groups = (await db.execute(
        select(func.count(func.distinct(Process.process_group)))
    )).scalar() or 0
    group_rows = await db.execute(
        select(Process.process_group, func.count()).group_by(Process.process_group)
    )
    by_group: Dict[str, int] = {}
    for gname, gcnt in group_rows.all():
        by_group[gname or "未分组"] = gcnt
    return ResponseModel(data={"total": total, "qc_points": qc_points, "groups": groups, "missing_standard_hour": missing_standard_hour, "by_group": by_group})


@router.get("/processes/{process_id}", response_model=ProcessOut)
async def get_process(process_id: int, db: AsyncSession = Depends(get_db)):
    """查询单个工序"""
    result = await db.execute(select(Process).filter(Process.id == process_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="工序不存在")
    return item


@router.post("/processes", response_model=ProcessOut)
async def create_process(process: ProcessCreate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.processes", "create"))):
    """创建工序"""
    result = await db.execute(select(Process).filter(Process.process_code == process.process_code))
    existing = result.scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="工序编码已存在")
    
    db_item = Process(**process.model_dump())
    db.add(db_item)
    await db.flush()
    await log_audit(db, "process", db_item.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.put("/processes/{process_id}", response_model=ProcessOut)
async def update_process(process_id: int, process: ProcessUpdate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.processes", "update"))):
    """更新工序"""
    result = await db.execute(select(Process).filter(Process.id == process_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="工序不存在")
    
    update_data = process.model_dump(exclude_unset=True)
    await log_audit(db, "process", db_item.id, "update", old_obj=db_item, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(db_item, field, value)
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.delete("/processes/{process_id}")
async def delete_process(process_id: int, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.processes", "delete"))):
    """删除工序"""
    result = await db.execute(select(Process).filter(Process.id == process_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="工序不存在")
    
    await log_audit(db, "process", db_item.id, "delete", operator=current_user["username"])
    await db.delete(db_item)
    await db.commit()
    return {"message": "删除成功"}


# ── Organization ──
@router.get("/organizations/tree", response_model=ResponseModel[List[OrganizationTreeNode]])
async def get_organization_tree(db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.organizations", "read"))):
    """查询组织树形结构（含负责人姓名）"""
    result = await db.execute(
        select(
            Organization,
            Employee.emp_name.label('leader_name')
        )
        .outerjoin(Employee, Organization.leader_id == Employee.id)
        .order_by(Organization.parent_id.nullsfirst(), Organization.id)
    )
    all_items = result.all()

    node_map: dict[str, OrganizationTreeNode] = {}
    roots: List[OrganizationTreeNode] = []

    for org, leader_name in all_items:
        node = OrganizationTreeNode(
            id=org.id,
            org_code=org.org_code,
            org_name=org.org_name,
            org_type=org.org_type,
            parent_id=org.parent_id,
            leader_id=org.leader_id,
            leader_name=leader_name,
            oa_org_id=org.oa_org_id,
            status=org.status,
            data_source=org.data_source,
            children=[],
        )
        node_map[str(org.id)] = node

    for org, leader_name in all_items:
        node = node_map.get(str(org.id))
        if not node:
            continue

        if org.parent_id is None or org.parent_id == 0:
            roots.append(node)
        else:
            parent = node_map.get(str(org.parent_id))
            if parent:
                parent.children.append(node)
            else:
                logger.warning(
                    "组织 %s(id=%s) 的 parent_id=%s 找不到对应父组织，临时挂为根",
                    org.org_code, org.id, org.parent_id,
                )
                roots.append(node)
    return ResponseModel(data=roots)


@router.get("/organizations", response_model=ResponseModel[dict])
async def list_organizations(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索编码/名称"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    org_type: Optional[str] = Query(None, description="组织类型筛选，逗号分隔"),
    status: Optional[str] = Query(None, description="状态筛选，逗号分隔"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.organizations", "read"))
):
    """查询组织列表（分页+排序+筛选，含负责人姓名）"""
    SORTABLE = {
        'org_code': Organization.org_code,
        'org_name': Organization.org_name,
        'org_type': Organization.org_type,
        'parent_id': Organization.parent_id,
        'status': Organization.status,
    }
    query = select(Organization, Employee.emp_name.label('leader_name')).outerjoin(Employee, Organization.leader_id == Employee.id)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(Organization.org_code.ilike(like), Organization.org_name.ilike(like)))
    if org_type:
        types = [t.strip() for t in org_type.split(",") if t.strip()]
        if types:
            query = query.where(Organization.org_type.in_(types))
    if status:
        statuses = [int(s.strip()) for s in status.split(",") if s.strip().isdigit()]
        if statuses:
            query = query.where(Organization.status.in_(statuses))

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    query = _apply_sort(query, Organization, sort_by, sort_order, SORTABLE)
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = []
    for org, leader_name in result.all():
        org_out = OrganizationWithLeaderOut.model_validate(org)
        org_out.leader_name = leader_name
        items.append(org_out)
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/organizations/stats", response_model=ResponseModel[dict])
async def get_organization_stats(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.organizations", "read"))
):
    """组织统计：总数 / 按类型 / 缺负责人"""
    result = await db.execute(
        select(Organization.org_type, Organization.leader_id.is_(None), func.count())
        .group_by(Organization.org_type, Organization.leader_id.is_(None))
    )
    total = 0
    missing_leader = 0
    by_type: Dict[str, int] = {}
    for otype, missing_flag, cnt in result.all():
        total += cnt
        if missing_flag:
            missing_leader += cnt
        key = otype or ""
        by_type[key] = by_type.get(key, 0) + cnt
    return ResponseModel(data={"total": total, "by_type": by_type, "missing_leader": missing_leader})


@router.get("/organizations/{org_id}", response_model=OrganizationWithLeaderOut)
async def get_organization(org_id: int, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.organizations", "read"))):
    """查询单个组织（含负责人姓名）"""
    result = await db.execute(
        select(Organization, Employee.emp_name.label('leader_name'))
        .outerjoin(Employee, Organization.leader_id == Employee.id)
        .filter(Organization.id == org_id)
    )
    item = result.first()
    if not item:
        raise HTTPException(status_code=404, detail="组织不存在")
    org, leader_name = item
    org_out = OrganizationWithLeaderOut.model_validate(org)
    org_out.leader_name = leader_name
    return org_out


@router.post("/organizations", response_model=OrganizationOut)
async def create_organization(org: OrganizationCreate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.organizations", "create"))):
    """创建组织"""
    result = await db.execute(select(Organization).filter(Organization.org_code == org.org_code))
    existing = result.scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="组织编码已存在")
    
    db_item = Organization(**org.model_dump())
    db.add(db_item)
    await db.flush()
    await log_audit(db, "organization", db_item.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.put("/organizations/{org_id}", response_model=OrganizationOut)
async def update_organization(org_id: int, org: OrganizationUpdate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.organizations", "update"))):
    """更新组织"""
    result = await db.execute(select(Organization).filter(Organization.id == org_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="组织不存在")
    
    update_data = org.model_dump(exclude_unset=True)
    await log_audit(db, "organization", db_item.id, "update", old_obj=db_item, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(db_item, field, value)
    await db.commit()
    await db.refresh(db_item)
    return db_item


@router.delete("/organizations/{org_id}")
async def delete_organization(org_id: int, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.organizations", "delete"))):
    """删除组织"""
    result = await db.execute(select(Organization).filter(Organization.id == org_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="组织不存在")
    
    await log_audit(db, "organization", db_item.id, "delete", operator=current_user["username"])
    await db.delete(db_item)
    await db.commit()
    return {"message": "删除成功"}


# ── Employee ──
@router.get("/positions", response_model=ResponseModel[dict])
async def list_positions(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="Search code/name"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    status: Optional[str] = Query(None, description="Comma separated statuses"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.positions", "read")),
):
    SORTABLE = {
        "position_code": Position.position_code,
        "oa_position_id": Position.oa_position_id,
        "position_name": Position.position_name,
        "status": Position.status,
        "create_time": Position.create_time,
    }
    query = select(Position)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(
            or_(
                Position.position_code.ilike(like),
                Position.oa_position_id.ilike(like),
                Position.position_name.ilike(like),
            )
        )
    if status:
        statuses = [int(s.strip()) for s in status.split(",") if s.strip().isdigit()]
        if statuses:
            query = query.where(Position.status.in_(statuses))

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    query = _apply_sort(query, Position, sort_by, sort_order, SORTABLE)
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = [_position_out(position) for position in result.scalars().all()]
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/positions/stats", response_model=ResponseModel[dict])
async def get_position_stats(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.positions", "read"))
):
    """岗位统计：总数 / 启用 / 停用"""
    result = await db.execute(select(Position.status, func.count()).group_by(Position.status))
    total = 0
    enabled = 0
    disabled = 0
    for st, cnt in result.all():
        total += cnt
        if st == 1:
            enabled += cnt
        elif st == 0:
            disabled += cnt
    return ResponseModel(data={"total": total, "enabled": enabled, "disabled": disabled})


@router.get("/positions/{position_id}", response_model=PositionOut)
async def get_position(
    position_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.positions", "read")),
):
    result = await db.execute(select(Position).where(Position.id == position_id))
    position = result.scalar_one_or_none()
    if not position:
        raise HTTPException(status_code=404, detail="Position not found")
    return _position_out(position)


@router.get("/employees", response_model=ResponseModel[dict])
async def list_employees(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索工号/姓名"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    status: Optional[str] = Query(None, description="状态筛选，逗号分隔"),
    org_id: Optional[int] = Query(None, description="所属组织ID筛选"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.employees", "read"))
):
    """查询人员列表（分页+排序+筛选），支持数据权限过滤"""
    SORTABLE = {
        'emp_code': Employee.emp_code,
        'emp_name': Employee.emp_name,
        'org_id': Employee.org_id,
        'position_id': Employee.position_id,
        'position': Employee.position,
        'position_name': Position.position_name,
        'phone': Employee.phone,
        'status': Employee.status,
    }
    # Manager 别名用于关联上级姓名
    Manager = aliased(Employee)
    query = (
        select(Employee, Position.position_name, Manager.emp_name.label("manager_name"))
        .outerjoin(Position, Employee.position_id == Position.id)
        .outerjoin(Manager, Employee.manager_oa_user_id == Manager.oa_user_id)
    )
    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(Employee.emp_code.ilike(like), Employee.emp_name.ilike(like)))
    if status:
        statuses = [int(s.strip()) for s in status.split(",") if s.strip().isdigit()]
        if statuses:
            query = query.where(Employee.status.in_(statuses))
    if org_id is not None:
        query = query.where(Employee.org_id == org_id)

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    query = _apply_sort(query, Employee, sort_by, sort_order, SORTABLE)
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = [_employee_out(employee, position_name, mgr_name) for employee, position_name, mgr_name in result.all()]
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/employees/stats", response_model=ResponseModel[dict])
async def get_employee_stats(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.employees", "read"))
):
    """人员统计：总数 / 按状态（8 态全覆盖）"""
    result = await db.execute(select(Employee.status, func.count()).group_by(Employee.status))
    by_status: Dict[str, int] = {str(i): 0 for i in range(8)}
    total = 0
    for st, cnt in result.all():
        total += cnt
        key = str(st)
        by_status[key] = by_status.get(key, 0) + cnt
    return ResponseModel(data={"total": total, "by_status": by_status})


@router.get("/employees/{employee_id}", response_model=EmployeeOut)
async def get_employee(employee_id: int, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.employees", "read"))):
    """查询单个人员"""
    Manager = aliased(Employee)
    result = await db.execute(
        select(Employee, Position.position_name, Manager.emp_name.label("manager_name"))
        .outerjoin(Position, Employee.position_id == Position.id)
        .outerjoin(Manager, Employee.manager_oa_user_id == Manager.oa_user_id)
        .filter(Employee.id == employee_id)
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Employee not found")
    employee, position_name, manager_name = row
    return _employee_out(employee, position_name, manager_name)


@router.post("/employees", response_model=EmployeeOut)
async def create_employee(employee: EmployeeCreate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.employees", "create"))):
    """创建人员"""
    result = await db.execute(select(Employee).filter(Employee.emp_code == employee.emp_code))
    existing = result.scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="员工工号已存在")
    
    payload = employee.model_dump()
    if payload.get("position_id"):
        position_result = await db.execute(select(Position).where(Position.id == payload["position_id"]))
        position = position_result.scalar_one_or_none()
        if not position:
            raise HTTPException(status_code=400, detail="Position not found")
        payload["position"] = position.position_name
    db_item = Employee(**payload)
    db.add(db_item)
    await db.flush()
    await sync_user_role_from_employee(db, db_item)
    await log_audit(db, "employee", db_item.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(db_item)
    position_name = None
    if db_item.position_id:
        position_result = await db.execute(select(Position.position_name).where(Position.id == db_item.position_id))
        position_name = position_result.scalar_one_or_none()
    # 查询上级姓名
    manager_name = None
    if db_item.manager_oa_user_id:
        mgr_result = await db.execute(select(Employee.emp_name).where(Employee.oa_user_id == db_item.manager_oa_user_id))
        manager_name = mgr_result.scalar_one_or_none()
    return _employee_out(db_item, position_name, manager_name)


@router.put("/employees/{employee_id}", response_model=EmployeeOut)
async def update_employee(employee_id: int, employee: EmployeeUpdate, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.employees", "update"))):
    """更新人员"""
    result = await db.execute(select(Employee).filter(Employee.id == employee_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="人员不存在")
    
    # 上下级权限检查：非 admin 只能更新自己或下级
    if not _can_manage_employee(current_user, db_item):
        raise HTTPException(status_code=403, detail="无权编辑该员工信息")

    update_data = employee.model_dump(exclude_unset=True)
    if update_data.get("position_id"):
        position_result = await db.execute(select(Position).where(Position.id == update_data["position_id"]))
        position = position_result.scalar_one_or_none()
        if not position:
            raise HTTPException(status_code=400, detail="Position not found")
        update_data["position"] = position.position_name
    await log_audit(db, "employee", db_item.id, "update", old_obj=db_item, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(db_item, field, value)
    await sync_user_role_from_employee(db, db_item)
    await db.commit()
    await db.refresh(db_item)
    position_name = None
    if db_item.position_id:
        position_result = await db.execute(select(Position.position_name).where(Position.id == db_item.position_id))
        position_name = position_result.scalar_one_or_none()
    # 查询上级姓名
    manager_name = None
    if db_item.manager_oa_user_id:
        mgr_result = await db.execute(select(Employee.emp_name).where(Employee.oa_user_id == db_item.manager_oa_user_id))
        manager_name = mgr_result.scalar_one_or_none()
    return _employee_out(db_item, position_name, manager_name)


@router.delete("/employees/{employee_id}")
async def delete_employee(employee_id: int, db: AsyncSession = Depends(get_db), current_user: dict = Depends(PermissionChecker("basicdata.data.employees", "delete"))):
    """删除人员"""
    result = await db.execute(select(Employee).filter(Employee.id == employee_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="人员不存在")
    
    # 上下级权限检查：非 admin 只能删除自己或下级
    if not _can_manage_employee(current_user, db_item):
        raise HTTPException(status_code=403, detail="无权删除该员工信息")

    await log_audit(db, "employee", db_item.id, "delete", operator=current_user["username"])
    await db.delete(db_item)
    await db.commit()
    return {"message": "删除成功"}


@router.get("/organizations/{org_identifier}/employees", response_model=ResponseModel[dict])
async def get_organization_employees(
    org_identifier: str,
    keyword: Optional[str] = Query(None, description="搜索工号/姓名"),
    status: Optional[str] = Query(None, description="状态筛选，逗号分隔"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.employees", "read"))
):
    """查询指定组织下的全部员工列表（支持通过 id 或 oa_org_id 查询，不分页）"""
    SORTABLE = {
        'emp_code': Employee.emp_code,
        'emp_name': Employee.emp_name,
        'position_id': Employee.position_id,
        'position': Employee.position,
        'position_name': Position.position_name,
        'status': Employee.status,
    }
    
    # 前端传 oa_org_id；为兼容历史调用，找不到时再兜底按内部 id 查询。
    org_result = await db.execute(select(Organization).where(Organization.oa_org_id == org_identifier))
    org = org_result.scalar_one_or_none()

    if not org:
        if org_identifier.isdigit():
            org_result = await db.execute(select(Organization).where(Organization.id == int(org_identifier)))
            org = org_result.scalar_one_or_none()
    
    if not org:
        return ResponseModel(data={"items": [], "total": 0})
    
    # 员工表 org_id 存的是组织表 oa_org_id；手工组织没有 oa_org_id 时兜底使用内部 id。
    employee_org_id = None
    if org.oa_org_id:
        try:
            # 尝试将 oa_org_id 转换为整数
            employee_org_id = int(org.oa_org_id)
        except (ValueError, TypeError):
            # 如果转换失败，使用组织的内部 id
            employee_org_id = org.id
    else:
        employee_org_id = org.id
        
    query = (
        select(Employee, Position.position_name)
        .outerjoin(Position, Employee.position_id == Position.id)
        .where(Employee.org_id == employee_org_id)
    )
    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(Employee.emp_code.ilike(like), Employee.emp_name.ilike(like)))
    if status:
        statuses = [int(s.strip()) for s in status.split(",") if s.strip().isdigit()]
        if statuses:
            query = query.where(Employee.status.in_(statuses))

    query = _apply_sort(query, Employee, None, None, SORTABLE)
    result = await db.execute(query)
    items = [_employee_out(employee, position_name) for employee, position_name in result.all()]
    return ResponseModel(data={"items": items, "total": len(items)})


# ── Inventory ──
SORTABLE_INVENTORY = {
    "material_code": Inventory.material_code,
    "material_name": Inventory.material_name,
    "wh_code": Inventory.wh_code,
    "qty_on_hand": Inventory.qty_on_hand,
    "locked_qty": Inventory.locked_qty,
    "balance_qty": Inventory.balance_qty,
    "qty_in_transit": Inventory.qty_in_transit,
    "unit_price": Inventory.unit_price,
    "ending_balance": Inventory.ending_balance,
    "batch_no": Inventory.batch_no,
    "last_inbound_at": Inventory.last_inbound_at,
    "last_outbound_at": Inventory.last_outbound_at,
    "last_picking_at": Inventory.last_picking_at,
    "updated_at": Inventory.updated_at,
}


@router.get("/inventory", response_model=ResponseModel[dict])
async def list_inventory(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="模糊搜索物料编码/名称/仓库名称"),
    material_code: Optional[str] = Query(None, description="物料编码精确筛选"),
    wh_code: Optional[str] = Query(None, description="仓库编码精确筛选"),
    wh_name: Optional[str] = Query(None, description="仓库名称精确筛选"),
    batch_no: Optional[str] = Query(None, description="批次号精确筛选"),
    recent_checked: Optional[str] = Query(None, description="近期已盘筛选:true=仅近期已盘,false=仅未盘"),
    recent_days: Optional[int] = Query(None, ge=-1, le=100000, description="近 N 天内已盘算近期已盘;-1 或 99999=不限(全部历史);省略=服务端配置默认"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query("asc"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.inventory", "read")),
    tf: dict = Depends(_inventory_time_query_params),
):
    query = select(Inventory)
    count_query = select(func.count()).select_from(Inventory)
    sums_query = select(
        func.coalesce(func.sum(Inventory.qty_on_hand), 0),
        func.coalesce(func.sum(Inventory.locked_qty), 0),
        func.coalesce(func.sum(Inventory.balance_qty), 0),
        func.coalesce(func.sum(Inventory.qty_in_transit), 0),
        func.coalesce(func.sum(Inventory.ending_balance), 0),
    )
    total_materials_query = select(func.count(func.distinct(Inventory.material_id)))
    counted_materials_query = select(func.count(func.distinct(Inventory.material_id))).where(_recent_checked_exists_cond(recent_days))

    active_cond = _inventory_material_active_cond()
    nonzero_cond = _inventory_nonzero_qty_cond()
    time_conds = _inventory_time_conds(lambda f: getattr(Inventory, f), tf)
    dormant_conds = _inventory_dormant_conds(lambda f: getattr(Inventory, f), tf)
    query = query.where(active_cond, nonzero_cond, *time_conds, *dormant_conds)
    count_query = count_query.where(active_cond, nonzero_cond, *time_conds, *dormant_conds)
    sums_query = sums_query.where(active_cond, nonzero_cond, *time_conds, *dormant_conds)
    total_materials_query = total_materials_query.where(active_cond, nonzero_cond, *time_conds, *dormant_conds)
    counted_materials_query = counted_materials_query.where(active_cond, nonzero_cond, *time_conds, *dormant_conds)

    if keyword:
        like = f"%{keyword}%"
        filter_cond = or_(
            Inventory.material_code.ilike(like),
            Inventory.material_name.ilike(like),
            Inventory.wh_name.ilike(like),
        )
        query = query.where(filter_cond)
        count_query = count_query.where(filter_cond)
        sums_query = sums_query.where(filter_cond)
        total_materials_query = total_materials_query.where(filter_cond)
        counted_materials_query = counted_materials_query.where(filter_cond)
    if material_code:
        vals = [v.strip() for v in material_code.split(",") if v.strip()]
        cond = Inventory.material_code.in_(vals)
        query = query.where(cond)
        count_query = count_query.where(cond)
        sums_query = sums_query.where(cond)
        total_materials_query = total_materials_query.where(cond)
        counted_materials_query = counted_materials_query.where(cond)
    if wh_code:
        vals = [v.strip() for v in wh_code.split(",") if v.strip()]
        cond = Inventory.wh_code.in_(vals)
        query = query.where(cond)
        count_query = count_query.where(cond)
        sums_query = sums_query.where(cond)
        total_materials_query = total_materials_query.where(cond)
        counted_materials_query = counted_materials_query.where(cond)
    if wh_name:
        vals = [v.strip() for v in wh_name.split(",") if v.strip()]
        cond = Inventory.wh_name.in_(vals)
        query = query.where(cond)
        count_query = count_query.where(cond)
        sums_query = sums_query.where(cond)
        total_materials_query = total_materials_query.where(cond)
        counted_materials_query = counted_materials_query.where(cond)
    if batch_no:
        vals = [v.strip() for v in batch_no.split(",") if v.strip()]
        cond = Inventory.batch_no.in_(vals)
        query = query.where(cond)
        count_query = count_query.where(cond)
        sums_query = sums_query.where(cond)
        total_materials_query = total_materials_query.where(cond)
        counted_materials_query = counted_materials_query.where(cond)
    if recent_checked is not None and recent_checked.strip().lower() in ("true", "1", "yes", "false", "0", "no"):
        rc_exists = _recent_checked_exists_cond(recent_days)
        rc_cond = rc_exists if recent_checked.strip().lower() in ("true", "1", "yes") else not_(rc_exists)
        query = query.where(rc_cond)
        count_query = count_query.where(rc_cond)
        sums_query = sums_query.where(rc_cond)
        total_materials_query = total_materials_query.where(rc_cond)
        counted_materials_query = counted_materials_query.where(rc_cond)

    total = (await db.execute(count_query)).scalar() or 0
    sum_on_hand, sum_locked, sum_balance, sum_in_transit, sum_ending = (await db.execute(sums_query)).one()
    total_materials = (await db.execute(total_materials_query)).scalar() or 0
    counted_materials = (await db.execute(counted_materials_query)).scalar() or 0

    if sort_by == "days_in_stock":
        query = query.order_by(_inventory_dormant_sort_clause(Inventory.last_outbound_at, Inventory.last_inbound_at, sort_order))
    else:
        query = _apply_sort(query, Inventory, sort_by, sort_order, SORTABLE_INVENTORY)
    query = query.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    items = result.scalars().all()

    recent_meta = await _enrich_recent_checked(
        db, [(inv.material_id, inv.wh_id) for inv in items], recent_days
    )

    # 批量查询物料单位
    material_ids = list({inv.material_id for inv in items})
    unit_map: Dict[int, str] = {}
    if material_ids:
        unit_rows = (await db.execute(
            select(Material.erp_material_id, Material.unit_of_measure)
            .where(Material.erp_material_id.in_(material_ids))
        )).all()
        unit_map = {row[0]: row[1] or "" for row in unit_rows}

    out_items = []
    for inv in items:
        rc = recent_meta.get((inv.material_id, inv.wh_id)) or {}
        out_items.append({
            "id": inv.id,
            "material_id": inv.material_id,
            "material_code": inv.material_code,
            "material_name": inv.material_name,
            "wh_id": inv.wh_id,
            "wh_code": inv.wh_code,
            "wh_name": inv.wh_name,
            "location_id": inv.location_id,
            "location_name": inv.location_name,
            "qty_on_hand": float(inv.qty_on_hand) if inv.qty_on_hand else 0,
            "locked_qty": float(inv.locked_qty) if inv.locked_qty else 0,
            "balance_qty": float(inv.balance_qty) if inv.balance_qty else 0,
            "qty_in_transit": float(inv.qty_in_transit) if inv.qty_in_transit else 0,
            "unit_price": float(inv.unit_price) if inv.unit_price else 0,
            "ending_balance": float(inv.ending_balance) if inv.ending_balance else 0,
            "batch_no": inv.batch_no,
            "last_inbound_at": inv.last_inbound_at.isoformat() if inv.last_inbound_at else None,
            "last_outbound_at": inv.last_outbound_at.isoformat() if inv.last_outbound_at else None,
            "last_picking_at": inv.last_picking_at.isoformat() if inv.last_picking_at else None,
            "created_at": inv.created_at.isoformat() if inv.created_at else None,
            "updated_at": inv.updated_at.isoformat() if inv.updated_at else None,
            "recent_checked": bool(rc.get("checked")),
            "recent_checked_date": rc.get("date"),
            "recent_checked_check_no": rc.get("check_no"),
            "unit_of_measure": unit_map.get(inv.material_id, ""),
        })

    return ResponseModel(data={
        "items": out_items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "sums": {
            "qty_on_hand": float(sum_on_hand or 0),
            "locked_qty": float(sum_locked or 0),
            "balance_qty": float(sum_balance or 0),
            "qty_in_transit": float(sum_in_transit or 0),
            "ending_balance": float(sum_ending or 0),
        },
        "stats": {
            "total_materials": int(total_materials or 0),
            "counted_materials": int(counted_materials or 0),
        },
    })


@router.get("/inventory/by-warehouse", response_model=ResponseModel[dict])
async def list_inventory_by_warehouse(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="模糊搜索物料编码/名称/仓库名称"),
    material_code: Optional[str] = Query(None, description="物料编码精确筛选"),
    wh_code: Optional[str] = Query(None, description="仓库编码精确筛选"),
    wh_name: Optional[str] = Query(None, description="仓库名称精确筛选"),
    recent_checked: Optional[str] = Query(None, description="近期已盘筛选:true=仅近期已盘,false=仅未盘"),
    recent_days: Optional[int] = Query(None, ge=-1, le=100000, description="近 N 天内已盘算近期已盘;-1 或 99999=不限(全部历史);省略=服务端配置默认"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query("asc"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.inventory", "read")),
    tf: dict = Depends(_inventory_time_query_params),
):
    """按 物料 x 仓库 聚合的即时库存视图（合并库位维度）。"""
    filters = [_inventory_material_active_cond(), _inventory_nonzero_qty_cond()]
    if keyword:
        like = f"%{keyword}%"
        filters.append(or_(
            Inventory.material_code.ilike(like),
            Inventory.material_name.ilike(like),
            Inventory.wh_name.ilike(like),
        ))
    if material_code:
        vals = [v.strip() for v in material_code.split(",") if v.strip()]
        filters.append(Inventory.material_code.in_(vals))
    if wh_code:
        vals = [v.strip() for v in wh_code.split(",") if v.strip()]
        filters.append(Inventory.wh_code.in_(vals))
    if wh_name:
        vals = [v.strip() for v in wh_name.split(",") if v.strip()]
        filters.append(Inventory.wh_name.in_(vals))
    if recent_checked is not None and recent_checked.strip().lower() in ("true", "1", "yes", "false", "0", "no"):
        rc_exists = _recent_checked_exists_cond(recent_days)
        filters.append(rc_exists if recent_checked.strip().lower() in ("true", "1", "yes") else not_(rc_exists))

    sum_qty = func.coalesce(func.sum(Inventory.qty_on_hand), 0).label("qty_on_hand")
    sum_locked = func.coalesce(func.sum(Inventory.locked_qty), 0).label("locked_qty")
    sum_balance = func.coalesce(func.sum(Inventory.balance_qty), 0).label("balance_qty")
    sum_transit = func.coalesce(func.sum(Inventory.qty_in_transit), 0).label("qty_in_transit")
    sum_ending = func.coalesce(func.sum(Inventory.ending_balance), 0).label("ending_balance")
    cnt_locations = func.count(Inventory.id).label("location_count")
    max_last_inbound = func.max(Inventory.last_inbound_at).label("last_inbound_at")
    max_last_outbound = func.max(Inventory.last_outbound_at).label("last_outbound_at")
    max_last_picking = func.max(Inventory.last_picking_at).label("last_picking_at")

    group_cols = [
        Inventory.material_id, Inventory.material_code, Inventory.material_name,
        Inventory.wh_id, Inventory.wh_code, Inventory.wh_name,
    ]

    max_cols = {
        "last_inbound_at": max_last_inbound,
        "last_outbound_at": max_last_outbound,
        "last_picking_at": max_last_picking,
    }
    time_conds = _inventory_time_conds(lambda f: max_cols[f], tf)
    dormant_conds = _inventory_dormant_conds(lambda f: max_cols[f], tf)

    groups = select(*group_cols, sum_qty, sum_locked, sum_balance, sum_transit, sum_ending, cnt_locations, max_last_inbound, max_last_outbound, max_last_picking).group_by(*group_cols)
    for f in filters:
        groups = groups.where(f)
    # 组级排除零库存（防正负抵消为 0 的组）+ 组级时间/呆滞筛选（作用于 MAX 聚合值，NULL 视为超过 N 天）
    groups = groups.having(sum_qty != 0, *time_conds, *dormant_conds)

    sortable = {
        "material_code": Inventory.material_code,
        "material_name": Inventory.material_name,
        "wh_code": Inventory.wh_code,
        "qty_on_hand": sum_qty,
        "locked_qty": sum_locked,
        "balance_qty": sum_balance,
        "qty_in_transit": sum_transit,
        "ending_balance": sum_ending,
        "last_inbound_at": max_last_inbound,
        "last_outbound_at": max_last_outbound,
        "last_picking_at": max_last_picking,
    }
    if sort_by == "days_in_stock":
        query = groups.order_by(_inventory_dormant_sort_clause(max_last_outbound, max_last_inbound, sort_order))
    elif sort_by in sortable:
        col = sortable[sort_by]
        query = groups.order_by(col.desc() if sort_order == "desc" else col.asc())
    else:
        query = groups.order_by(Inventory.material_code.asc(), Inventory.wh_code.asc())

    # 计数/合计/统计均基于同一份组级结果，保证与表格行口径一致
    g = groups.subquery()
    count_query = select(func.count()).select_from(g)
    total = (await db.execute(count_query)).scalar() or 0

    sums_query = select(
        func.coalesce(func.sum(g.c.qty_on_hand), 0),
        func.coalesce(func.sum(g.c.locked_qty), 0),
        func.coalesce(func.sum(g.c.balance_qty), 0),
        func.coalesce(func.sum(g.c.qty_in_transit), 0),
        func.coalesce(func.sum(g.c.ending_balance), 0),
    )
    sum_on_hand, sum_locked, sum_balance, sum_in_transit, sum_ending = (await db.execute(sums_query)).one()

    total_materials_query = select(func.count(func.distinct(g.c.material_id)))
    counted_materials_query = select(func.count(func.distinct(g.c.material_id))).where(
        _recent_checked_exists_cond(recent_days, g.c.material_id, g.c.wh_id)
    )
    total_materials = (await db.execute(total_materials_query)).scalar() or 0
    counted_materials = (await db.execute(counted_materials_query)).scalar() or 0

    query = query.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    rows = result.all()

    recent_meta = await _enrich_recent_checked(db, [(r[0], r[3]) for r in rows], recent_days)  # (material_id, wh_id)

    # 批量查询物料单位
    material_ids = list({r[0] for r in rows})
    unit_map: Dict[int, str] = {}
    if material_ids:
        unit_rows = (await db.execute(
            select(Material.erp_material_id, Material.unit_of_measure)
            .where(Material.erp_material_id.in_(material_ids))
        )).all()
        unit_map = {row[0]: row[1] or "" for row in unit_rows}

    items = []
    for row in rows:
        (mat_id, mat_code, mat_name, wh_id, w_code, w_name,
         qty, locked, balance, transit, ending, loc_cnt, last_in, last_out, last_pick) = row
        qty_f = float(qty or 0)
        ending_f = float(ending or 0)
        rc = recent_meta.get((mat_id, wh_id)) or {}
        items.append({
            "material_id": mat_id,
            "material_code": mat_code,
            "material_name": mat_name,
            "wh_id": wh_id,
            "wh_code": w_code,
            "wh_name": w_name,
            "qty_on_hand": qty_f,
            "locked_qty": float(locked or 0),
            "balance_qty": float(balance or 0),
            "qty_in_transit": float(transit or 0),
            "unit_price": (ending_f / qty_f) if qty_f else 0,
            "ending_balance": ending_f,
            "location_count": int(loc_cnt or 0),
            "last_inbound_at": last_in.isoformat() if last_in else None,
            "last_outbound_at": last_out.isoformat() if last_out else None,
            "last_picking_at": last_pick.isoformat() if last_pick else None,
            "recent_checked": bool(rc.get("checked")),
            "recent_checked_date": rc.get("date"),
            "recent_checked_check_no": rc.get("check_no"),
            "unit_of_measure": unit_map.get(mat_id, ""),
        })

    return ResponseModel(data={
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "sums": {
            "qty_on_hand": float(sum_on_hand or 0),
            "locked_qty": float(sum_locked or 0),
            "balance_qty": float(sum_balance or 0),
            "qty_in_transit": float(sum_in_transit or 0),
            "ending_balance": float(sum_ending or 0),
        },
        "stats": {
            "total_materials": int(total_materials or 0),
            "counted_materials": int(counted_materials or 0),
        },
    })


@router.get("/inventory/filter-options", response_model=ResponseModel[dict])
async def inventory_filter_options(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.inventory", "read")),
):
    """库存列筛选选项：全量去重值（仓库编码/名称全量；物料编码/批次号上限 3000 条）。"""
    active_cond = _inventory_material_active_cond()
    nonzero_cond = _inventory_nonzero_qty_cond()
    material_codes = (await db.execute(
        select(Inventory.material_code).where(Inventory.material_code.isnot(None), active_cond, nonzero_cond)
        .distinct().order_by(Inventory.material_code).limit(3000)
    )).scalars().all()
    wh_codes = (await db.execute(
        select(Inventory.wh_code).where(Inventory.wh_code.isnot(None), active_cond, nonzero_cond)
        .distinct().order_by(Inventory.wh_code)
    )).scalars().all()
    wh_names = (await db.execute(
        select(Inventory.wh_name).where(Inventory.wh_name.isnot(None), active_cond, nonzero_cond)
        .distinct().order_by(Inventory.wh_name)
    )).scalars().all()
    batch_nos = (await db.execute(
        select(Inventory.batch_no).where(Inventory.batch_no.isnot(None), active_cond, nonzero_cond)
        .distinct().order_by(Inventory.batch_no).limit(3000)
    )).scalars().all()
    return ResponseModel(data={
        "material_codes": list(material_codes),
        "wh_codes": list(wh_codes),
        "wh_names": list(wh_names),
        "batch_nos": list(batch_nos),
    })


INVENTORY_DETAIL_EXPORT_COLUMNS = [
    ExportColumn("material_code", "物料编码", 14),
    ExportColumn("material_name", "物料名称", 24),
    ExportColumn("unit_of_measure", "单位", 8),
    ExportColumn("wh_code", "仓库编码", 10),
    ExportColumn("wh_name", "仓库名称", 14),
    ExportColumn("location_name", "库位名称", 14),
    ExportColumn("qty_on_hand", "库存量", 12),
    ExportColumn("locked_qty", "锁定数量", 12),
    ExportColumn("balance_qty", "结存数量", 12),
    ExportColumn("qty_in_transit", "在途库存", 12),
    ExportColumn("unit_price", "库存单价", 12),
    ExportColumn("ending_balance", "期末余额", 14),
    ExportColumn("batch_no", "批次号", 14),
    ExportColumn("last_inbound_at", "最后入库时间", 18),
    ExportColumn("last_outbound_at", "最后出库时间", 18),
    ExportColumn("last_picking_at", "最后领料时间", 18),
    ExportColumn("days_in_stock", "呆滞天数", 10),
    ExportColumn("recent_checked", "近期已盘", 10),
    ExportColumn("updated_at", "更新时间", 18),
]

INVENTORY_BYWH_EXPORT_COLUMNS = [
    ExportColumn("material_code", "物料编码", 14),
    ExportColumn("material_name", "物料名称", 24),
    ExportColumn("unit_of_measure", "单位", 8),
    ExportColumn("wh_code", "仓库编码", 10),
    ExportColumn("wh_name", "仓库名称", 14),
    ExportColumn("location_count", "库位数", 10),
    ExportColumn("qty_on_hand", "库存量", 12),
    ExportColumn("locked_qty", "锁定数量", 12),
    ExportColumn("balance_qty", "结存数量", 12),
    ExportColumn("qty_in_transit", "在途库存", 12),
    ExportColumn("unit_price", "加权单价", 12),
    ExportColumn("ending_balance", "期末余额", 14),
    ExportColumn("last_inbound_at", "最后入库时间", 18),
    ExportColumn("last_outbound_at", "最后出库时间", 18),
    ExportColumn("last_picking_at", "最后领料时间", 18),
    ExportColumn("days_in_stock", "呆滞天数", 10),
    ExportColumn("recent_checked", "近期已盘", 10),
]


@router.get("/inventory/export")
async def export_inventory(
    format: str = Query("xlsx", pattern="^(xlsx|csv)$"),
    columns: Optional[str] = Query(None, description="导出字段(逗号分隔key),缺省=全部"),
    keyword: Optional[str] = Query(None, description="模糊搜索物料编码/名称/仓库名称"),
    material_code: Optional[str] = Query(None, description="物料编码精确筛选"),
    wh_code: Optional[str] = Query(None, description="仓库编码精确筛选"),
    wh_name: Optional[str] = Query(None, description="仓库名称精确筛选"),
    batch_no: Optional[str] = Query(None, description="批次号精确筛选"),
    recent_checked: Optional[str] = Query(None, description="近期已盘筛选:true=仅近期已盘,false=仅未盘"),
    recent_days: Optional[int] = Query(None, ge=-1, le=100000, description="近 N 天内已盘算近期已盘;-1 或 99999=不限(全部历史);省略=服务端配置默认"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query("asc"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.inventory", "read")),
    tf: dict = Depends(_inventory_time_query_params),
):
    """库存明细导出（物料 x 仓库 x 库位），按当前筛选/排序全量导出，零库存行已排除。"""
    selected_keys = [c.strip() for c in columns.split(",") if c.strip()] if columns else []
    allowed = {col.key for col in INVENTORY_DETAIL_EXPORT_COLUMNS}
    invalid_columns = [key for key in selected_keys if key not in allowed]
    if invalid_columns:
        raise HTTPException(status_code=400, detail=f"无效导出字段: {', '.join(invalid_columns)}")
    selected_columns = [col for col in INVENTORY_DETAIL_EXPORT_COLUMNS if not selected_keys or col.key in selected_keys]
    if not selected_columns:
        raise HTTPException(status_code=400, detail="请选择至少一个有效导出字段")
    conds = _inventory_filter_conds(keyword, material_code, wh_code, wh_name, batch_no, recent_checked, recent_days, time_filters=tf)
    conds.extend(_inventory_dormant_conds(lambda f: getattr(Inventory, f), tf))
    query = select(Inventory).where(*conds)
    if sort_by == "days_in_stock":
        query = query.order_by(_inventory_dormant_sort_clause(Inventory.last_outbound_at, Inventory.last_inbound_at, sort_order))
    else:
        query = _apply_sort(query, Inventory, sort_by, sort_order, SORTABLE_INVENTORY)
    items = (await db.execute(query)).scalars().all()

    recent_meta = await _enrich_recent_checked(
        db, [(inv.material_id, inv.wh_id) for inv in items], recent_days
    )

    # 批量查询物料单位
    material_ids = list({inv.material_id for inv in items})
    unit_map: Dict[int, str] = {}
    if material_ids:
        unit_rows = (await db.execute(
            select(Material.erp_material_id, Material.unit_of_measure)
            .where(Material.erp_material_id.in_(material_ids))
        )).all()
        unit_map = {row[0]: row[1] or "" for row in unit_rows}

    export_rows = []
    for inv in items:
        rc = recent_meta.get((inv.material_id, inv.wh_id)) or {}
        export_rows.append({
            "material_code": inv.material_code or "",
            "material_name": inv.material_name or "",
            "unit_of_measure": unit_map.get(inv.material_id, ""),
            "wh_code": inv.wh_code or "",
            "wh_name": inv.wh_name or "",
            "location_name": inv.location_name or "",
            "qty_on_hand": float(inv.qty_on_hand) if inv.qty_on_hand else 0,
            "locked_qty": float(inv.locked_qty) if inv.locked_qty else 0,
            "balance_qty": float(inv.balance_qty) if inv.balance_qty else 0,
            "qty_in_transit": float(inv.qty_in_transit) if inv.qty_in_transit else 0,
            "unit_price": float(inv.unit_price) if inv.unit_price else 0,
            "ending_balance": float(inv.ending_balance) if inv.ending_balance else 0,
            "batch_no": inv.batch_no or "",
            "last_inbound_at": inv.last_inbound_at.strftime("%Y-%m-%d %H:%M:%S") if inv.last_inbound_at else "",
            "last_outbound_at": inv.last_outbound_at.strftime("%Y-%m-%d %H:%M:%S") if inv.last_outbound_at else "",
            "last_picking_at": inv.last_picking_at.strftime("%Y-%m-%d %H:%M:%S") if inv.last_picking_at else "",
            "days_in_stock": _inventory_dormant_days_export(inv.last_outbound_at, inv.last_inbound_at),
            "recent_checked": "是" if rc.get("checked") else "否",
            "updated_at": inv.updated_at.strftime("%Y-%m-%d %H:%M:%S") if inv.updated_at else "",
        })

    svc = GenericExportService(selected_columns, export_rows, sheet_name="库存明细")
    if format == "csv":
        output = svc.to_csv()
        return StreamingResponse(
            output,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=inventory_export.csv"},
        )

    output = svc.to_xlsx()
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=inventory_export.xlsx"},
    )


@router.get("/inventory/by-warehouse/export")
async def export_inventory_by_warehouse(
    format: str = Query("xlsx", pattern="^(xlsx|csv)$"),
    columns: Optional[str] = Query(None, description="导出字段(逗号分隔key),缺省=全部"),
    keyword: Optional[str] = Query(None, description="模糊搜索物料编码/名称/仓库名称"),
    material_code: Optional[str] = Query(None, description="物料编码精确筛选"),
    wh_code: Optional[str] = Query(None, description="仓库编码精确筛选"),
    wh_name: Optional[str] = Query(None, description="仓库名称精确筛选"),
    recent_checked: Optional[str] = Query(None, description="近期已盘筛选:true=仅近期已盘,false=仅未盘"),
    recent_days: Optional[int] = Query(None, ge=-1, le=100000, description="近 N 天内已盘算近期已盘;-1 或 99999=不限(全部历史);省略=服务端配置默认"),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query("asc"),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data.inventory", "read")),
    tf: dict = Depends(_inventory_time_query_params),
):
    """按 物料 x 仓库 聚合的即时库存导出，按当前筛选/排序全量导出，零库存行/组已排除。"""
    selected_keys = [c.strip() for c in columns.split(",") if c.strip()] if columns else []
    allowed = {col.key for col in INVENTORY_BYWH_EXPORT_COLUMNS}
    invalid_columns = [key for key in selected_keys if key not in allowed]
    if invalid_columns:
        raise HTTPException(status_code=400, detail=f"无效导出字段: {', '.join(invalid_columns)}")
    selected_columns = [col for col in INVENTORY_BYWH_EXPORT_COLUMNS if not selected_keys or col.key in selected_keys]
    if not selected_columns:
        raise HTTPException(status_code=400, detail="请选择至少一个有效导出字段")
    filters = _inventory_filter_conds(keyword, material_code, wh_code, wh_name, None, recent_checked, recent_days)

    sum_qty = func.coalesce(func.sum(Inventory.qty_on_hand), 0).label("qty_on_hand")
    sum_locked = func.coalesce(func.sum(Inventory.locked_qty), 0).label("locked_qty")
    sum_balance = func.coalesce(func.sum(Inventory.balance_qty), 0).label("balance_qty")
    sum_transit = func.coalesce(func.sum(Inventory.qty_in_transit), 0).label("qty_in_transit")
    sum_ending = func.coalesce(func.sum(Inventory.ending_balance), 0).label("ending_balance")
    cnt_locations = func.count(Inventory.id).label("location_count")
    max_last_inbound = func.max(Inventory.last_inbound_at).label("last_inbound_at")
    max_last_outbound = func.max(Inventory.last_outbound_at).label("last_outbound_at")
    max_last_picking = func.max(Inventory.last_picking_at).label("last_picking_at")

    group_cols = [
        Inventory.material_id, Inventory.material_code, Inventory.material_name,
        Inventory.wh_id, Inventory.wh_code, Inventory.wh_name,
    ]

    query = select(*group_cols, sum_qty, sum_locked, sum_balance, sum_transit, sum_ending, cnt_locations, max_last_inbound, max_last_outbound, max_last_picking).group_by(*group_cols)
    for f in filters:
        query = query.where(f)
    # 组级时间筛选（作用于 MAX 聚合值，NULL 视为超过 N 天）
    max_cols = {
        "last_inbound_at": max_last_inbound,
        "last_outbound_at": max_last_outbound,
        "last_picking_at": max_last_picking,
    }
    query = query.having(sum_qty != 0, *_inventory_time_conds(lambda f: max_cols[f], tf), *_inventory_dormant_conds(lambda f: max_cols[f], tf))

    sortable = {
        "material_code": Inventory.material_code,
        "material_name": Inventory.material_name,
        "wh_code": Inventory.wh_code,
        "qty_on_hand": sum_qty,
        "locked_qty": sum_locked,
        "balance_qty": sum_balance,
        "qty_in_transit": sum_transit,
        "ending_balance": sum_ending,
        "last_inbound_at": max_last_inbound,
        "last_outbound_at": max_last_outbound,
        "last_picking_at": max_last_picking,
    }
    if sort_by == "days_in_stock":
        query = query.order_by(_inventory_dormant_sort_clause(max_last_outbound, max_last_inbound, sort_order))
    elif sort_by in sortable:
        col = sortable[sort_by]
        query = query.order_by(col.desc() if sort_order == "desc" else col.asc())
    else:
        query = query.order_by(Inventory.material_code.asc(), Inventory.wh_code.asc())

    rows = (await db.execute(query)).all()

    recent_meta = await _enrich_recent_checked(db, [(r[0], r[3]) for r in rows], recent_days)  # (material_id, wh_id)

    # 批量查询物料单位
    material_ids = list({r[0] for r in rows})
    unit_map: Dict[int, str] = {}
    if material_ids:
        unit_rows = (await db.execute(
            select(Material.erp_material_id, Material.unit_of_measure)
            .where(Material.erp_material_id.in_(material_ids))
        )).all()
        unit_map = {row[0]: row[1] or "" for row in unit_rows}

    export_rows = []
    for row in rows:
        (mat_id, mat_code, mat_name, wh_id, w_code, w_name,
         qty, locked, balance, transit, ending, loc_cnt, last_in, last_out, last_pick) = row
        qty_f = float(qty or 0)
        ending_f = float(ending or 0)
        rc = recent_meta.get((mat_id, wh_id)) or {}
        export_rows.append({
            "material_code": mat_code or "",
            "material_name": mat_name or "",
            "unit_of_measure": unit_map.get(mat_id, ""),
            "wh_code": w_code or "",
            "wh_name": w_name or "",
            "location_count": int(loc_cnt or 0),
            "last_inbound_at": last_in.strftime("%Y-%m-%d %H:%M:%S") if last_in else "",
            "last_outbound_at": last_out.strftime("%Y-%m-%d %H:%M:%S") if last_out else "",
            "last_picking_at": last_pick.strftime("%Y-%m-%d %H:%M:%S") if last_pick else "",
            "days_in_stock": _inventory_dormant_days_export(last_out, last_in),
            "qty_on_hand": qty_f,
            "locked_qty": float(locked or 0),
            "balance_qty": float(balance or 0),
            "qty_in_transit": float(transit or 0),
            "unit_price": (ending_f / qty_f) if qty_f else 0,
            "ending_balance": ending_f,
            "recent_checked": "是" if rc.get("checked") else "否",
        })

    svc = GenericExportService(selected_columns, export_rows, sheet_name="按物料仓库统计")
    if format == "csv":
        output = svc.to_csv()
        return StreamingResponse(
            output,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=inventory_by_warehouse.csv"},
        )

    output = svc.to_xlsx()
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=inventory_by_warehouse.xlsx"},
    )
