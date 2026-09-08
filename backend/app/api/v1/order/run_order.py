"""跑单管理 API 路由"""

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select, func, case, asc, desc
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.core.audit import log_audit
from app.models.order.run_order import RunOrder
from app.models.order.sale_order import SaleOrder
from app.models.material.mrp_plan_order import MrpPlanOrder
from app.schemas.common import ResponseModel, PageResult
from app.schemas.order.schemas import RunOrderOut, RunOrderCreate, RunOrderUpdate

router = APIRouter()

_mrp_min_run_time = (
    select(
        MrpPlanOrder.sale_order_no.label("order_no"),
        func.min(MrpPlanOrder.mrp_run_time).label("mrp_run_time"),
    )
    .where(MrpPlanOrder.sale_order_no.isnot(None))
    .group_by(MrpPlanOrder.sale_order_no)
    .subquery()
)

_mrp_min_run_time_days = (
    (func.date(_mrp_min_run_time.c.mrp_run_time) - SaleOrder.order_date)
    .label("mrp_run_days")
)

RUN_ORDER_SORTABLE_COLUMNS = {
    'customer_code': SaleOrder.customer_code,
    'order_no': SaleOrder.order_no,
    'order_qty': SaleOrder.order_qty,
    'order_type': SaleOrder.order_nature,
    'contract_date': SaleOrder.order_date,
    'delivery_date': SaleOrder.promised_date,
    'run_date': _mrp_min_run_time.c.mrp_run_time,
    'run_days': _mrp_min_run_time_days,
    'order_amount': RunOrder.order_amount,
    'po_placed_date': SaleOrder.order_date,
    'material_ready_date': SaleOrder.material_ready_date,
    'procurement_cycle': RunOrder.procurement_cycle,
    'completed_date': RunOrder.completed_date,
    'shipped_date': RunOrder.shipped_date,
    'order_status': RunOrder.order_status,
}


@router.get("", response_model=ResponseModel[PageResult[RunOrderOut]])
async def list_run_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None),
    order_type: Optional[str] = Query(None, description="订单性质，多选逗号分隔如 返单,新订单"),
    order_status: Optional[str] = Query(None, description="订单状态，多选逗号分隔如 进行中,已完成"),
    is_domestic: Optional[bool] = Query(None),
    sort_by: Optional[str] = Query(None, description="排序字段"),
    sort_order: Optional[str] = Query(None, description="排序方向 asc/desc"),
    current_user: dict = Depends(PermissionChecker("orders.run_orders", "read")),
    db: AsyncSession = Depends(get_db),
):
    # 从 sale_order 表查询，左连接 run_order 表判断是否已同步
    query = select(
        SaleOrder,
        RunOrder,
        RunOrder.id.label('run_order_id'),
        case((RunOrder.id.isnot(None), True), else_=False).label('is_synced'),
        _mrp_min_run_time.c.mrp_run_time.label('mrp_run_time'),
        _mrp_min_run_time_days.label('mrp_run_days'),
    ).outerjoin(
        RunOrder, SaleOrder.order_no == RunOrder.order_no
    ).outerjoin(
        _mrp_min_run_time, _mrp_min_run_time.c.order_no == SaleOrder.order_no
    )
    
    count_query = select(func.count(SaleOrder.id.distinct())).outerjoin(RunOrder, SaleOrder.order_no == RunOrder.order_no)

    if order_type:
        types = [x.strip() for x in order_type.split(',') if x.strip()]
        if len(types) == 1:
            query = query.where(SaleOrder.order_nature == types[0])
            count_query = count_query.where(SaleOrder.order_nature == types[0])
        elif types:
            query = query.where(SaleOrder.order_nature.in_(types))
            count_query = count_query.where(SaleOrder.order_nature.in_(types))
    if order_status:
        statuses = [x.strip() for x in order_status.split(',') if x.strip()]
        if len(statuses) == 1:
            query = query.where(RunOrder.order_status == statuses[0])
            count_query = count_query.where(RunOrder.order_status == statuses[0])
        elif statuses:
            query = query.where(RunOrder.order_status.in_(statuses))
            count_query = count_query.where(RunOrder.order_status.in_(statuses))
    if is_domestic is not None:
        query = query.where(RunOrder.is_domestic == is_domestic)
        count_query = count_query.where(RunOrder.is_domestic == is_domestic)
    if keyword:
        like_expr = f"%{keyword}%"
        query = query.where(
            (SaleOrder.order_no.ilike(like_expr)) | (SaleOrder.customer_code.ilike(like_expr))
        )
        count_query = count_query.where(
            (SaleOrder.order_no.ilike(like_expr)) | (SaleOrder.customer_code.ilike(like_expr))
        )

    total_result = await db.execute(count_query)
    total = total_result.scalar()

    # 全局统计（基于已同步的跑单数据）
    counts_query = select(
        func.count(RunOrder.id).label('total'),
        func.sum(case((RunOrder.completed_date.isnot(None), 1), else_=0)).label('completed_count'),
        func.sum(case((RunOrder.shipped_date.isnot(None), 1), else_=0)).label('shipped_count'),
    )
    avg_query = (
        select(func.avg(
            func.date(_mrp_min_run_time.c.mrp_run_time) - SaleOrder.order_date
        ).label('avg_days'))
        .select_from(SaleOrder)
        .join(_mrp_min_run_time, _mrp_min_run_time.c.order_no == SaleOrder.order_no)
        .where(_mrp_min_run_time.c.mrp_run_time.isnot(None))
        .where(SaleOrder.order_date.isnot(None))
    )
    counts_result = await db.execute(counts_query)
    counts = counts_result.first()
    avg_result = await db.execute(avg_query)
    avg_row = avg_result.first()
    global_stats = (
        counts.total,
        counts.completed_count,
        counts.shipped_count,
        avg_row.avg_days if avg_row else None,
    )

    # 构建排序子句
    order_clauses = []
    if sort_by and sort_by in RUN_ORDER_SORTABLE_COLUMNS:
        col = RUN_ORDER_SORTABLE_COLUMNS[sort_by]
        if sort_order == 'desc':
            order_clauses.append(col.desc().nullslast())
        else:
            order_clauses.append(col.asc().nullslast())
    if not order_clauses:
        order_clauses = [SaleOrder.order_date.desc().nullslast()]

    query = query.order_by(*order_clauses).offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    
    items = []
    for row in result.all():
        sale_order = row[0]
        run_order = row[1]
        is_synced = row.is_synced
        mrp_run_time = row.mrp_run_time
        po_placed_date = sale_order.order_date
        run_date_val = mrp_run_time.date() if mrp_run_time else None
        run_days_val = (
            (mrp_run_time.date() - po_placed_date).days
            if (mrp_run_time and po_placed_date) else None
        )
        if run_order:
            item = RunOrderOut.model_validate(run_order)
            item.is_synced = True
            item.run_date = run_date_val
            item.run_days = run_days_val
            item.order_amount = float(sale_order.order_amount) if sale_order.order_amount else item.order_amount
        else:
            # 从 sale_order 映射到 RunOrderOut
            item = RunOrderOut(
                id=None,
                customer_code=sale_order.customer_code,
                order_no=sale_order.order_no,
                order_qty=float(sale_order.order_qty) if sale_order.order_qty else None,
                order_type=sale_order.order_nature,
                contract_date=sale_order.order_date,
                delivery_date=sale_order.promised_date,
                run_date=run_date_val,
                run_days=run_days_val,
                order_amount=float(sale_order.order_amount) if sale_order.order_amount else None,
                packaging_not_released=None,
                po_placed_date=sale_order.order_date,
                material_ready_date=sale_order.material_ready_date,
                procurement_cycle=None,
                completed_date=None,
                shipped_date=None,
                order_status=None,
                delay_reason=None,
                remark=sale_order.remark,
                is_domestic=False,
                is_synced=is_synced,
                created_at=sale_order.created_at,
                updated_at=sale_order.updated_at,
            )
        items.append(item)

    page_result = PageResult(total=total, page=page, page_size=page_size, items=items)
    page_result.stats = {
        'total': global_stats[0] or 0,
        'completed_count': global_stats[1] or 0,
        'shipped_count': global_stats[2] or 0,
        'avg_days': round(global_stats[3], 1) if global_stats[3] else 0,
    }

    return ResponseModel(data=page_result)


@router.get("/{run_order_id}", response_model=ResponseModel[RunOrderOut])
async def get_run_order(
    run_order_id: int,
    current_user: dict = Depends(PermissionChecker("orders.run_orders", "read")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(
            RunOrder,
            _mrp_min_run_time.c.mrp_run_time.label('mrp_run_time'),
            SaleOrder.order_date.label('po_placed_date'),
        )
        .outerjoin(SaleOrder, SaleOrder.order_no == RunOrder.order_no)
        .outerjoin(_mrp_min_run_time, _mrp_min_run_time.c.order_no == RunOrder.order_no)
        .where(RunOrder.id == run_order_id)
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="跑单记录不存在")
    run_order = row[0]
    mrp_run_time = row.mrp_run_time
    po_placed_date = row.po_placed_date
    out = RunOrderOut.model_validate(run_order)
    out.run_date = mrp_run_time.date() if mrp_run_time else None
    out.run_days = (
        (mrp_run_time.date() - po_placed_date).days
        if (mrp_run_time and po_placed_date) else None
    )
    return ResponseModel(data=out)


@router.post("", response_model=ResponseModel[RunOrderOut])
async def create_run_order(
    data: RunOrderCreate,
    current_user: dict = Depends(PermissionChecker("orders.run_orders", "create")),
    db: AsyncSession = Depends(get_db),
):
    run_order = RunOrder(**data.model_dump())
    db.add(run_order)
    await db.flush()
    await log_audit(db, "run_order", run_order.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(run_order)
    return ResponseModel(data=RunOrderOut.model_validate(run_order))


@router.post("/sync-from-order/{order_no}", response_model=ResponseModel[RunOrderOut])
async def sync_from_order(
    order_no: str,
    current_user: dict = Depends(PermissionChecker("orders.run_orders", "create")),
    db: AsyncSession = Depends(get_db),
):
    """从订单创建跑单记录"""
    # 检查订单是否存在
    sale_order_result = await db.execute(select(SaleOrder).where(SaleOrder.order_no == order_no).order_by(SaleOrder.id.desc()).limit(1))
    sale_order = sale_order_result.scalar_one_or_none()
    if not sale_order:
        raise HTTPException(status_code=404, detail="订单不存在")
    
    # 检查是否已存在跑单记录
    existing_run_order_result = await db.execute(select(RunOrder).where(RunOrder.order_no == order_no))
    existing_run_order = existing_run_order_result.scalar_one_or_none()
    if existing_run_order:
        return ResponseModel(data=RunOrderOut.model_validate({**existing_run_order.__dict__, 'is_synced': True}))
    
    # 从订单创建跑单记录
    run_order = RunOrder(
        customer_code=sale_order.customer_code,
        order_no=sale_order.order_no,
        order_qty=float(sale_order.order_qty) if sale_order.order_qty else None,
        order_amount=float(sale_order.order_amount) if sale_order.order_amount else None,
        order_type=sale_order.order_nature,
        contract_date=sale_order.order_date,
        delivery_date=sale_order.promised_date,
        po_placed_date=sale_order.order_date,
        material_ready_date=sale_order.material_ready_date,
        remark=sale_order.remark,
        is_domestic=False,
    )
    db.add(run_order)
    await db.flush()
    await log_audit(db, "run_order", run_order.id, "create", field_name="sync_from_order", new_value=order_no, operator=current_user["username"])
    await db.commit()
    await db.refresh(run_order)
    
    return ResponseModel(data=RunOrderOut.model_validate({**run_order.__dict__, 'is_synced': True}))


@router.put("/{run_order_id}", response_model=ResponseModel[RunOrderOut])
async def update_run_order(
    run_order_id: int,
    data: RunOrderUpdate,
    current_user: dict = Depends(PermissionChecker("orders.run_orders", "update")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(RunOrder).where(RunOrder.id == run_order_id))
    run_order = result.scalar_one_or_none()
    if not run_order:
        raise HTTPException(status_code=404, detail="跑单记录不存在")

    update_data = data.model_dump(exclude_unset=True)
    await log_audit(db, "run_order", run_order.id, "update", old_obj=run_order, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(run_order, field, value)
    await db.commit()
    await db.refresh(run_order)
    return ResponseModel(data=RunOrderOut.model_validate(run_order))

