"""生产协同中心 — 前道管理 API

数据主体为喷塑车间/压铸车间未关闭的生产任务单(OA 同步)。
壳体/框/手杆/支架圆盘/备注 等手工字段存于 front_process_record 表，
通过 task_id 与任务单关联；任务单基础信息及 sale_order 关联字段在
查询时 JOIN 带出。OA 同步只更新 production_task_order 的映射字段，
不会触及 front_process_record。
"""

from datetime import date

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select, func, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.core.audit import log_audit
from app.models.production.production_task_order import ProductionTaskOrder
from app.models.production.front_process_record import FrontProcessRecord
from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.schemas.common import ResponseModel, PageResult
from app.schemas.production.schemas import FrontProcessTaskOut, FrontProcessRecordUpdate

router = APIRouter()

# 前道管理覆盖的车间
FRONT_WORKSHOPS = ["喷塑车间", "压铸车间"]

# production_task_order.sale_order_id 存的是 ERP FOrderInterID（外部 ID），
# 通过 sale_order.erp_id 关联获取订单头属性。
#
# 两层关联：
#  1) _sale_order_header —— 通过 erp_id == sale_order_id 关联，取每个订单的
#     首行(line_no 最小)，提供订单头属性 customer/customer_code/order_date。
#  2) _sale_order_product —— 通过 order_no 从 header 子查询关联，取每个订单
#     的首行(line_no 最小)，提供行级属性 product_name/product_model/promised_date。
_sale_order_header = (
    select(
        SaleOrder.erp_id.label("so_erp_id"),
        SaleOrder.order_no.label("so_order_no"),
        SaleOrder.customer_code.label("customer_code"),
        SaleOrder.customer.label("customer"),
        SaleOrder.order_date.label("order_date"),
    )
    .distinct(SaleOrder.erp_id)
    .order_by(SaleOrder.erp_id, SaleOrder.line_no)
    .subquery()
)

_sale_order_product = (
    select(
        SaleOrderLine.order_no.label("sol_order_no"),
        SaleOrderLine.product_name.label("product_name"),
        SaleOrderLine.product_model.label("product_model"),
        SaleOrderLine.promised_date.label("promised_date"),
    )
    .distinct(SaleOrderLine.order_no)
    .order_by(SaleOrderLine.order_no, SaleOrderLine.line_no)
    .subquery()
)


def _base_filters():
    return [
        ProductionTaskOrder.workshop.in_(FRONT_WORKSHOPS),
        or_(ProductionTaskOrder.is_closed == 0, ProductionTaskOrder.is_closed.is_(None)),
        ProductionTaskOrder.task_id.isnot(None),
    ]


@router.get("", response_model=ResponseModel[PageResult[FrontProcessTaskOut]])
async def list_front_process(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    workshop: Optional[str] = Query(None, description="车间筛选"),
    year: Optional[int] = Query(None, ge=2000, le=2100, description="计划开工年份筛选"),
    sale_order_no: Optional[str] = Query(None, description="销售订单号筛选"),
    keyword: Optional[str] = Query(None),
    current_user: dict = Depends(PermissionChecker("production.front_process", "read")),
    db: AsyncSession = Depends(get_db),
):
    filters = _base_filters()
    if workshop:
        filters.append(ProductionTaskOrder.workshop == workshop)
    if year:
        filters.append(ProductionTaskOrder.planned_start_date >= date(year, 1, 1))
        filters.append(ProductionTaskOrder.planned_start_date < date(year + 1, 1, 1))
    if sale_order_no:
        filters.append(
            or_(
                ProductionTaskOrder.sale_order_no.ilike(f"%{sale_order_no}%"),
                _sale_order_header.c.so_order_no.ilike(f"%{sale_order_no}%"),
            )
        )
    if keyword:
        like = f"%{keyword}%"
        filters.append(
            or_(
                ProductionTaskOrder.task_no.ilike(like),
                ProductionTaskOrder.material_code.ilike(like),
                ProductionTaskOrder.material_name.ilike(like),
                ProductionTaskOrder.sale_order_no.ilike(like),
                _sale_order_header.c.so_order_no.ilike(like),
                _sale_order_header.c.customer.ilike(like),
                _sale_order_header.c.customer_code.ilike(like),
                _sale_order_product.c.product_model.ilike(like),
                _sale_order_product.c.product_name.ilike(like),
            )
        )

    count_stmt = (
        select(func.count())
        .select_from(ProductionTaskOrder)
        .outerjoin(FrontProcessRecord, FrontProcessRecord.task_id == ProductionTaskOrder.task_id)
        .outerjoin(_sale_order_header, _sale_order_header.c.so_erp_id == ProductionTaskOrder.sale_order_id)
        .outerjoin(
            _sale_order_product,
            _sale_order_product.c.sol_order_no == _sale_order_header.c.so_order_no,
        )
        .where(*filters)
    )
    total = (await db.execute(count_stmt)).scalar()

    query = (
        select(
            ProductionTaskOrder.task_id.label("task_id"),
            ProductionTaskOrder.task_no.label("task_no"),
            ProductionTaskOrder.workshop.label("workshop"),
            ProductionTaskOrder.material_code.label("material_code"),
            ProductionTaskOrder.material_name.label("material_name"),
            func.coalesce(ProductionTaskOrder.sale_order_no, _sale_order_header.c.so_order_no).label("sale_order_no"),
            ProductionTaskOrder.task_qty.label("task_qty"),
            ProductionTaskOrder.planned_start_date.label("planned_start_date"),
            ProductionTaskOrder.planned_end_date.label("planned_end_date"),
            ProductionTaskOrder.actual_start_date.label("actual_start_date"),
            ProductionTaskOrder.actual_end_date.label("actual_end_date"),
            ProductionTaskOrder.is_closed.label("is_closed"),
            _sale_order_header.c.customer_code.label("customer_code"),
            _sale_order_header.c.customer.label("customer"),
            _sale_order_header.c.order_date.label("order_date"),
            _sale_order_product.c.product_name.label("product_name"),
            _sale_order_product.c.product_model.label("product_model"),
            _sale_order_product.c.promised_date.label("promised_date"),
            FrontProcessRecord.shell_status.label("shell_status"),
            FrontProcessRecord.frame_status.label("frame_status"),
            FrontProcessRecord.handle_status.label("handle_status"),
            FrontProcessRecord.bracket_status.label("bracket_status"),
            FrontProcessRecord.remark.label("remark"),
            func.coalesce(FrontProcessRecord.status, "pending").label("status"),
        )
        .select_from(ProductionTaskOrder)
        .outerjoin(FrontProcessRecord, FrontProcessRecord.task_id == ProductionTaskOrder.task_id)
        .outerjoin(_sale_order_header, _sale_order_header.c.so_erp_id == ProductionTaskOrder.sale_order_id)
        .outerjoin(
            _sale_order_product,
            _sale_order_product.c.sol_order_no == _sale_order_header.c.so_order_no,
        )
        .where(*filters)
        .order_by(ProductionTaskOrder.planned_start_date.asc().nullslast(), ProductionTaskOrder.task_id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    result = await db.execute(query)
    items = [FrontProcessTaskOut.model_validate(dict(row)) for row in result.mappings().all()]

    return ResponseModel(data=PageResult(total=total or 0, page=page, page_size=page_size, items=items))


@router.put("/{task_id}", response_model=ResponseModel[dict])
async def update_front_process(
    task_id: int,
    data: FrontProcessRecordUpdate,
    current_user: dict = Depends(PermissionChecker("production.front_process", "update")),
    db: AsyncSession = Depends(get_db),
):
    # 确认任务单存在且属于前道车间
    task = (
        await db.execute(
            select(ProductionTaskOrder.task_no, ProductionTaskOrder.workshop).where(
                ProductionTaskOrder.task_id == task_id
            )
        )
    ).first()
    if not task:
        raise HTTPException(status_code=404, detail="任务单不存在")

    update_data = data.model_dump(exclude_unset=True)

    result = await db.execute(select(FrontProcessRecord).where(FrontProcessRecord.task_id == task_id))
    rec = result.scalar_one_or_none()
    if rec is None:
        rec = FrontProcessRecord(task_id=task_id, task_no=task.task_no, **update_data)
        db.add(rec)
        await db.flush()
        await log_audit(
            db, "front_process_record", rec.id, "create",
            field_name="front_process", new_value=task.task_no, operator=current_user["username"],
        )
    else:
        await log_audit(
            db, "front_process_record", rec.id, "update",
            old_obj=rec, update_data=update_data, operator=current_user["username"],
        )
        for field, value in update_data.items():
            setattr(rec, field, value)

    await db.commit()
    await db.refresh(rec)
    return ResponseModel(data={"task_id": task_id, "id": rec.id, "status": rec.status})

