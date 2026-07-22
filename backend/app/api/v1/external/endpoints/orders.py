"""订单对外接口

为外部系统定制的订单查询接口。基于 SaleOrder 表（按 order_no + line_no 唯一），
提供外部常用的查询参数和精简字段集，区别于内部 /api/v1/orders 的复杂查询逻辑。
"""

from datetime import datetime
from typing import Optional
from urllib.parse import parse_qsl

from sqlalchemy import select, func, or_

from app.models.order.sale_order import SaleOrder, SaleOrderLine

from ..registry import register_external, ExternalCallContext


def _parse_date(s: Optional[str]):
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


@register_external(
    "orders.list",
    "订单列表",
    method="GET",
    path="/orders/list",
    description="销售订单行列表查询，支持关键字、状态、客户、风险等级、合同交期范围、增量同步",
    tags=["订单"],
)
async def orders_list(ctx: ExternalCallContext) -> dict:
    """销售订单行列表（外部定制版）

    参数（query）：
        page, page_size: 分页
        keyword: 关键字（订单号 / 客户 / 产品名 模糊匹配）
        status: 订单状态，多选逗号分隔，如 open,closed
        customer_code: 客户编码精确匹配
        risk_level: 风险等级，多选逗号分隔，如 red,yellow
        promised_date_start, promised_date_end: 合同交期范围 YYYY-MM-DD
        updated_after: 增量同步，仅返回 updated_at >= 此时间的记录 (ISO 8601)
    """
    params = ctx.params
    db = ctx.db

    page = max(int(params.get("page", 1) or 1), 1)
    page_size = min(max(int(params.get("page_size", 20) or 20), 1), 200)
    keyword = params.get("keyword")
    status = params.get("status")
    customer_code = params.get("customer_code")
    risk_level = params.get("risk_level")
    promised_start = _parse_date(params.get("promised_date_start"))
    promised_end = _parse_date(params.get("promised_date_end"))
    updated_after_raw = params.get("updated_after")

    query = select(SaleOrder)
    count_query = select(func.count()).select_from(SaleOrder)

    if keyword:
        like_expr = f"%{keyword}%"
        kw_cond = or_(
            SaleOrder.order_no.ilike(like_expr),
            SaleOrder.customer.ilike(like_expr),
            SaleOrder.product_name.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if status:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        if len(statuses) == 1:
            query = query.where(SaleOrder.status == statuses[0])
            count_query = count_query.where(SaleOrder.status == statuses[0])
        elif statuses:
            query = query.where(SaleOrder.status.in_(statuses))
            count_query = count_query.where(SaleOrder.status.in_(statuses))

    if customer_code:
        query = query.where(SaleOrder.customer_code == customer_code)
        count_query = count_query.where(SaleOrder.customer_code == customer_code)

    if risk_level:
        levels = [s.strip() for s in risk_level.split(",") if s.strip()]
        if len(levels) == 1:
            query = query.where(SaleOrder.risk_level == levels[0])
            count_query = count_query.where(SaleOrder.risk_level == levels[0])
        elif levels:
            query = query.where(SaleOrder.risk_level.in_(levels))
            count_query = count_query.where(SaleOrder.risk_level.in_(levels))

    if promised_start:
        query = query.where(SaleOrder.promised_date >= promised_start)
        count_query = count_query.where(SaleOrder.promised_date >= promised_start)
    if promised_end:
        query = query.where(SaleOrder.promised_date <= promised_end)
        count_query = count_query.where(SaleOrder.promised_date <= promised_end)

    if updated_after_raw:
        try:
            ua_dt = datetime.fromisoformat(updated_after_raw)
            query = query.where(SaleOrder.updated_at >= ua_dt)
            count_query = count_query.where(SaleOrder.updated_at >= ua_dt)
        except ValueError:
            pass

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(SaleOrder.promised_date.asc().nullslast(), SaleOrder.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    result = await db.execute(query)
    rows = result.scalars().all()

    # 对外暴露的精简字段集
    items = []
    for r in rows:
        items.append({
            "id": r.id,
            "order_no": r.order_no,
            "line_no": r.line_no,
            "customer": r.customer,
            "customer_code": r.customer_code,
            "product_code": r.product_code,
            "product_name": r.product_name,
            "order_qty": float(r.order_qty) if r.order_qty is not None else None,
            "completed_qty": float(r.completed_qty) if r.completed_qty is not None else None,
            "order_amount": float(r.order_amount) if r.order_amount is not None else None,
            "status": r.status,
            "risk_level": r.risk_level,
            "promised_date": r.promised_date.isoformat() if r.promised_date else None,
            "planned_start_date": r.planned_start_date.isoformat() if r.planned_start_date else None,
            "owner": r.owner,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        })

    return {"items": items, "total": total, "page": page, "page_size": page_size}


@register_external(
    "order_details.list",
    "订单明细列表",
    method="GET",
    path="/order-details/list",
    description="销售订单明细行列表查询，支持按订单号、产品、BOM、状态、合同交期范围、增量同步",
    tags=["订单"],
)
async def order_details_list(ctx: ExternalCallContext) -> dict:
    """销售订单明细行列表（外部定制版，基于 SaleOrderLine）

    参数（query）：
        page, page_size: 分页
        order_no: 订单号精确匹配（拉取某订单的全部明细行）
        keyword: 关键字（订单号 / 产品名 / 产品型号 模糊匹配）
        product_code: 产品编码精确匹配
        status: 明细行状态，多选逗号分隔，如 open,closed
        bom_no: BOM编号精确匹配
        promised_date_start, promised_date_end: 合同交期范围 YYYY-MM-DD
        updated_after: 增量同步，仅返回 updated_at >= 此时间的记录 (ISO 8601)
    """
    params = ctx.params
    db = ctx.db

    page = max(int(params.get("page", 1) or 1), 1)
    page_size = min(max(int(params.get("page_size", 20) or 20), 1), 200)
    order_no = params.get("order_no")
    keyword = params.get("keyword")
    product_code = params.get("product_code")
    status = params.get("status")
    bom_no = params.get("bom_no")
    promised_start = _parse_date(params.get("promised_date_start"))
    promised_end = _parse_date(params.get("promised_date_end"))
    updated_after_raw = params.get("updated_after")

    query = select(
        SaleOrderLine,
        SaleOrder.customer,
        SaleOrder.customer_code,
    ).outerjoin(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)

    count_query = select(func.count()).select_from(SaleOrderLine)

    if order_no:
        query = query.where(SaleOrderLine.order_no == order_no)
        count_query = count_query.where(SaleOrderLine.order_no == order_no)

    if keyword:
        like_expr = f"%{keyword}%"
        kw_cond = or_(
            SaleOrderLine.order_no.ilike(like_expr),
            SaleOrderLine.product_name.ilike(like_expr),
            SaleOrderLine.product_model.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if product_code:
        query = query.where(SaleOrderLine.product_code == product_code)
        count_query = count_query.where(SaleOrderLine.product_code == product_code)

    if status:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        if len(statuses) == 1:
            query = query.where(SaleOrderLine.status == statuses[0])
            count_query = count_query.where(SaleOrderLine.status == statuses[0])
        elif statuses:
            query = query.where(SaleOrderLine.status.in_(statuses))
            count_query = count_query.where(SaleOrderLine.status.in_(statuses))

    if bom_no:
        query = query.where(SaleOrderLine.bom_no == bom_no)
        count_query = count_query.where(SaleOrderLine.bom_no == bom_no)

    if promised_start:
        query = query.where(SaleOrderLine.promised_date >= promised_start)
        count_query = count_query.where(SaleOrderLine.promised_date >= promised_start)
    if promised_end:
        query = query.where(SaleOrderLine.promised_date <= promised_end)
        count_query = count_query.where(SaleOrderLine.promised_date <= promised_end)

    if updated_after_raw:
        try:
            ua_dt = datetime.fromisoformat(updated_after_raw)
            query = query.where(SaleOrderLine.updated_at >= ua_dt)
            count_query = count_query.where(SaleOrderLine.updated_at >= ua_dt)
        except ValueError:
            pass

    total = (await db.execute(count_query)).scalar() or 0

    query = (
        query.order_by(SaleOrderLine.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).all()

    items = []
    for row in rows:
        line = row.SaleOrderLine
        items.append({
            "id": line.id,
            "sale_order_id": line.sale_order_id,
            "order_no": line.order_no,
            "erp_line_id": line.erp_line_id,
            "line_no": line.line_no,
            "product_code": line.product_code,
            "product_name": line.product_name,
            "product_model": line.product_model,
            "order_qty": float(line.order_qty) if line.order_qty is not None else None,
            "order_amount": float(line.order_amount) if line.order_amount is not None else None,
            "promised_date": line.promised_date.isoformat() if line.promised_date else None,
            "planned_start_date": line.planned_start_date.isoformat() if line.planned_start_date else None,
            "batch_no": line.batch_no,
            "bom_no": line.bom_no,
            "bom_id": line.bom_id,
            "status": line.status,
            "customer": row.customer,
            "customer_code": row.customer_code,
            "created_at": line.created_at.isoformat() if line.created_at else None,
            "updated_at": line.updated_at.isoformat() if line.updated_at else None,
        })

    return {"items": items, "total": total, "page": page, "page_size": page_size}
