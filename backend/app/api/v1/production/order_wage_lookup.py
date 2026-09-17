"""生产协同中心 — 订单工价查询 API

以销售订单为入口: 订单行(产品+BOM) -> 工价明细(工序级, 来自 product_process_capacity 的 OA 元数据 gjje)。
匹配口径与排产 UPPH 一致: BOM 精确优先, 产品编码兜底; 仅取 is_active=True, 按 oa_detail_id 去重(保留最近同步)。
"""

from datetime import date, datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.core.audit import log_audit
from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.models.production.product_process_capacity import (
    ProductProcessCapacity,
    parse_capacity_metadata,
)
from app.models.production.production_task_order import ProductionTaskOrder
from app.services.basicdata.erp_sync_service import ERPConnectionError
from app.services.production.product_process_capacity_sync_service import (
    ProductProcessCapacitySyncService,
)
from app.schemas.common import ResponseModel, PageResult

router = APIRouter()


class WageProcessDetail(BaseModel):
    process_type: Optional[str] = None
    workshop: Optional[str] = None
    source_bom: Optional[str] = None
    gjje: Optional[float] = None
    upph: Optional[float] = None
    upph_source: Optional[str] = None
    oa_main_id: Optional[str] = None
    last_sync_time: Optional[datetime] = None


class OrderWageItem(BaseModel):
    line_id: int
    order_no: str
    line_no: Optional[str] = None
    customer: Optional[str] = None
    product_code: Optional[str] = None
    product_name: Optional[str] = None
    bom_no: Optional[str] = None
    order_qty: Optional[float] = None
    order_date: Optional[date] = None
    promised_date: Optional[date] = None

    wage_status: str = "no_wage"
    wage_no_reason: Optional[str] = None
    match_type: Optional[str] = None
    wage_total: Optional[float] = None
    details: List[WageProcessDetail] = []
    task_orders: List["TaskOrderBrief"] = []


class TaskOrderBrief(BaseModel):
    """订单下查的生产任务单(简要, K3 同步)。"""

    task_no: Optional[str] = None
    workshop: Optional[str] = None
    material_code: Optional[str] = None
    task_qty: Optional[float] = None
    actual_qty: Optional[float] = None
    planned_start_date: Optional[date] = None
    planned_end_date: Optional[date] = None
    is_closed: Optional[int] = None


def _reason_label(reason: Optional[str]) -> Optional[str]:
    return REASON_LABELS.get(reason or "", reason)


REASON_LABELS = {
    "no_bom_code": "订单行无BOM编码",
    "not_covered": "工价表未覆盖(BOM未匹配到工价)",
    "zero_price": "匹配到工价记录但金额为0",
}


def _to_float(value) -> Optional[float]:
    if value is None:
        return None
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None


def _dedupe_capacities(records: list[ProductProcessCapacity]) -> list[ProductProcessCapacity]:
    """按 oa_detail_id 去重, 保留 last_sync_time 最新(次选 id 最大)的一条。"""
    best: dict[str, ProductProcessCapacity] = {}
    for rec in records:
        key = rec.oa_detail_id or f"__row_{rec.id}"
        cur = best.get(key)
        if cur is None:
            best[key] = rec
            continue
        cur_time = cur.last_sync_time or cur.created_at
        rec_time = rec.last_sync_time or rec.created_at
        if (rec_time, rec.id) > (cur_time, cur.id):
            best[key] = rec
    return list(best.values())


# 样品单 BOM 前缀: 匹配工价时先去掉前缀再匹配量产 BOM
BOM_SAMPLE_PREFIXES = ("Y-", "P-")


def _bom_candidates(bom: Optional[str]) -> list[str]:
    """工价匹配候选: 样品单 BOM(Y-/P-开头)去掉前缀优先, 原始编码兜底。"""
    raw = (bom or "").strip()
    if not raw:
        return []
    for prefix in BOM_SAMPLE_PREFIXES:
        if raw.startswith(prefix):
            stripped = raw[len(prefix):].strip()
            if stripped and stripped != raw:
                return [stripped, raw]
            break
    return [raw]


def _match_wage(
    line_bom: Optional[str],
    by_bom: dict[str, list[ProductProcessCapacity]],
) -> tuple[Optional[str], list[ProductProcessCapacity]]:
    """仅 BOM 匹配: 样品BOM去前缀优先, 原始编码兜底, 不做产品兜底。"""
    raw = (line_bom or "").strip()
    for candidate in _bom_candidates(line_bom):
        if candidate in by_bom:
            match_type = "bom" if candidate == raw else "bom_stripped"
            return match_type, by_bom[candidate]
    return None, []


def _build_item(
    line: SaleOrderLine,
    order: SaleOrder,
    by_bom: dict,
    tasks_by_line: dict[tuple, List[TaskOrderBrief]],
) -> OrderWageItem:
    match_type, caps = _match_wage(line.bom_no, by_bom)
    details: List[WageProcessDetail] = []
    wage_total = 0.0
    for cap in caps:
        meta = parse_capacity_metadata(cap.remark)
        gjje = _to_float(meta.get("gjje"))
        if gjje:
            wage_total += gjje
        details.append(
            WageProcessDetail(
                process_type=cap.process_type,
                workshop=meta.get("oa_workshop_name"),
                source_bom=cap.bom_code,
                gjje=gjje,
                upph=_to_float(cap.upph),
                upph_source=meta.get("upph_source"),
                oa_main_id=meta.get("oa_main_id"),
                last_sync_time=cap.last_sync_time,
            )
        )

    wage_status = "no_wage"
    reason = None
    if any(d.gjje and d.gjje > 0 for d in details):
        wage_status = "has_wage"
    elif details:
        reason = "zero_price"
    elif not (line.bom_no or "").strip():
        reason = "no_bom_code"
    else:
        reason = "not_covered"

    return OrderWageItem(
        line_id=line.id,
        order_no=line.order_no,
        line_no=line.line_no,
        customer=order.customer,
        product_code=line.product_code,
        product_name=line.product_name or order.product_name,
        bom_no=line.bom_no,
        order_qty=_to_float(line.order_qty),
        order_date=order.order_date or order.audit_date,
        promised_date=line.promised_date or order.promised_date,
        wage_status=wage_status,
        wage_no_reason=_reason_label(reason),
        match_type=match_type,
        wage_total=round(wage_total, 4) if wage_total else None,
        details=details,
        task_orders=tasks_by_line.get((order.erp_id, (line.product_code or "").strip()), []),
    )


def _base_filters(
    order_no: Optional[str],
    line_no: Optional[str],
    product_code: Optional[str],
    bom_no: Optional[str],
    customer: Optional[str],
    include_closed: bool,
    promised_from: Optional[date] = None,
    promised_to: Optional[date] = None,
) -> list:
    filters = [SaleOrderLine.status != "closed"]
    if not include_closed:
        filters.append(SaleOrder.is_closed == 0)
    if order_no:
        filters.append(SaleOrderLine.order_no.ilike(f"%{order_no}%"))
    if line_no:
        filters.append(SaleOrderLine.line_no == line_no)
    if product_code:
        filters.append(
            or_(
                SaleOrderLine.product_code.ilike(f"%{product_code}%"),
                SaleOrder.product_code.ilike(f"%{product_code}%"),
            )
        )
    if bom_no:
        filters.append(SaleOrderLine.bom_no.ilike(f"%{bom_no}%"))
    if customer:
        filters.append(
            or_(
                SaleOrder.customer.ilike(f"%{customer}%"),
                SaleOrder.customer_code.ilike(f"%{customer}%"),
            )
        )
    if promised_from or promised_to:
        promised = func.coalesce(SaleOrderLine.promised_date, SaleOrder.promised_date)
        if promised_from:
            filters.append(promised >= promised_from)
        if promised_to:
            filters.append(promised <= promised_to)
    return filters


@router.get("", response_model=ResponseModel[PageResult[OrderWageItem]])
async def lookup_order_wage(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    order_no: Optional[str] = Query(None, description="订单号模糊搜索"),
    line_no: Optional[str] = Query(None, description="订单行号(精确)"),
    product_code: Optional[str] = Query(None, description="产品编码模糊搜索"),
    bom_no: Optional[str] = Query(None, description="BOM编码模糊搜索"),
    customer: Optional[str] = Query(None, description="客户模糊搜索"),
    wage_status: Optional[str] = Query(None, description="筛选: has=有工价 / no=无工价 / 空=全部"),
    include_closed: bool = Query(False, description="是否包含ERP已关闭(is_closed=1)的订单"),
    only_with_tasks: bool = Query(True, description="只显示匹配到生产任务单(装配一线/精益)的订单行"),
    promised_from: Optional[date] = Query(None, description="交期起(含), 支持跨月范围"),
    promised_to: Optional[date] = Query(None, description="交期止(含), 支持跨月范围"),
    current_user: dict = Depends(PermissionChecker("production.order_wage_lookup", "read")),
    db: AsyncSession = Depends(get_db),
):
    filters = _base_filters(
        order_no, line_no, product_code, bom_no, customer, include_closed,
        promised_from, promised_to,
    )

    base_stmt = (
        select(SaleOrderLine, SaleOrder)
        .join(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)
        .where(*filters)
    )

    # 统计口径: 全量命中行(不带分页), 需要工价匹配状态
    all_rows = (await db.execute(base_stmt)).all()

    # 预加载工价数据: 按涉及的 BOM 候选(样品BOM含去前缀形态)匹配
    involved_boms: set[str] = set()
    for r in all_rows:
        involved_boms.update(_bom_candidates(r[0].bom_no))
    by_bom: dict[str, list] = {}
    if involved_boms:
        cap_rows = (
            await db.execute(
                select(ProductProcessCapacity).where(
                    and_(
                        ProductProcessCapacity.is_active == True,
                        ProductProcessCapacity.bom_code.in_(list(involved_boms)),
                    )
                )
            )
        ).scalars().all()
        deduped = _dedupe_capacities(list(cap_rows))
        for cap in deduped:
            if cap.bom_code and cap.bom_code in involved_boms:
                by_bom.setdefault(cap.bom_code, []).append(cap)

    # 全量行 -> 工价状态(用于统计和 wage_status 过滤)
    item_status: dict[int, tuple[str, Optional[str]]] = {}
    for line, order in all_rows:
        match_type, caps = _match_wage(line.bom_no, by_bom)
        has_wage = False
        reason = None
        for cap in caps:
            gjje = parse_capacity_metadata(cap.remark).get("gjje")
            if gjje and float(gjje) > 0:
                has_wage = True
                break
        if has_wage:
            status = "has_wage"
        elif caps:
            status, reason = "no_wage", "zero_price"
        elif not (line.bom_no or "").strip():
            status, reason = "no_wage", "no_bom_code"
        else:
            status, reason = "no_wage", "not_covered"
        item_status[line.id] = (status, reason)

    if wage_status == "has":
        all_rows = [r for r in all_rows if item_status[r[0].id][0] == "has_wage"]
    elif wage_status == "no":
        all_rows = [r for r in all_rows if item_status[r[0].id][0] == "no_wage"]

    # 订单下查: 取装配一线/精益车间任务单, 按 (订单,物料=行产品) 对应到行
    tasks_by_line: dict[tuple, List[TaskOrderBrief]] = {}
    all_erp_ids = list({order.erp_id for _, order in all_rows if order.erp_id})
    if all_erp_ids:
        task_rows = (
            await db.execute(
                select(ProductionTaskOrder)
                .where(
                    ProductionTaskOrder.sale_order_id.in_(all_erp_ids),
                    ProductionTaskOrder.workshop.in_(TASK_LINE_WORKSHOPS),
                )
                .order_by(
                    ProductionTaskOrder.workshop.asc(),
                    ProductionTaskOrder.planned_end_date.desc().nullslast(),
                )
            )
        ).scalars().all()
        for t in task_rows:
            key = (t.sale_order_id, (t.material_code or "").strip())
            tasks_by_line.setdefault(key, []).append(
                TaskOrderBrief(
                    task_no=t.task_no,
                    workshop=t.workshop,
                    material_code=t.material_code,
                    task_qty=_to_float(t.task_qty),
                    actual_qty=_to_float(t.actual_qty),
                    planned_start_date=t.planned_start_date,
                    planned_end_date=t.planned_end_date,
                    is_closed=t.is_closed,
                )
            )

    # 只保留匹配到任务单的行(可开关)
    if only_with_tasks:
        all_rows = [
            r for r in all_rows
            if tasks_by_line.get((r[1].erp_id, (r[0].product_code or "").strip()))
        ]

    total = len(all_rows)
    stats = {
        "total": total,
        "has_wage": sum(1 for r in all_rows if item_status[r[0].id][0] == "has_wage"),
        "no_wage": sum(1 for r in all_rows if item_status[r[0].id][0] == "no_wage"),
        "no_wage_no_bom": sum(1 for r in all_rows if item_status[r[0].id][1] == "no_bom_code"),
        "no_wage_not_covered": sum(1 for r in all_rows if item_status[r[0].id][1] == "not_covered"),
        "no_wage_zero": sum(1 for r in all_rows if item_status[r[0].id][1] == "zero_price"),
    }

    all_rows.sort(
        key=lambda r: (
            r[1].order_date or r[1].audit_date or date.min,
            r[0].order_no,
            r[0].line_no or "",
        ),
        reverse=True,
    )
    start = (page - 1) * page_size
    page_rows = all_rows[start:start + page_size]

    items = [_build_item(line, order, by_bom, tasks_by_line) for line, order in page_rows]
    return ResponseModel(data=PageResult(total=total, page=page, page_size=page_size, items=items, stats=stats))


class TaskOrderItem(BaseModel):
    id: int
    task_no: Optional[str] = None
    workshop: Optional[str] = None
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    task_qty: Optional[float] = None
    actual_qty: Optional[float] = None
    repair_qty: Optional[float] = None
    planned_start_date: Optional[date] = None
    planned_end_date: Optional[date] = None
    actual_start_date: Optional[date] = None
    actual_end_date: Optional[date] = None
    is_closed: Optional[int] = None
    audit_status: Optional[int] = None
    bom_id: Optional[int] = None
    order_no: Optional[str] = None
    order_line_no: Optional[str] = None
    customer: Optional[str] = None
    promised_date: Optional[date] = None
    task_order_id: Optional[int] = None


ASSEMBLY_WORKSHOPS = ["装配一线", "精益车间"]
# 订单行级关联的任务单车间: 成品车间, 物料代码与订单行产品一致, 可精确对应行号
TASK_LINE_WORKSHOPS = ["装配一线", "精益车间"]


@router.get("/task-orders", response_model=ResponseModel[PageResult[TaskOrderItem]])
async def lookup_assembly_task_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    order_no: Optional[str] = Query(None, description="销售订单号模糊搜索"),
    task_no: Optional[str] = Query(None, description="任务单号模糊搜索"),
    material_code: Optional[str] = Query(None, description="物料代码模糊搜索"),
    workshops: Optional[List[str]] = Query(None, description="车间列表, 默认装配一线+装配二线"),
    planned_end_from: Optional[date] = Query(None, description="计划完工起(含), 支持跨月范围"),
    planned_end_to: Optional[date] = Query(None, description="计划完工止(含), 支持跨月范围"),
    closed: Optional[str] = Query(None, description="关闭状态: open=未关闭 / closed=已关闭 / 空=全部"),
    current_user: dict = Depends(PermissionChecker("production.order_wage_lookup", "read")),
    db: AsyncSession = Depends(get_db),
):
    """销售订单下查装配生产任务单(production_task_order, K3 同步)。

    通过 task_order.sale_order_id (=K3 FOrderInterID) 关联中台 sale_order.erp_id,
    订单级关联(同一订单的多行共享任务单清单), 与 K3「下查」口径一致。
    """
    ws_list = workshops or ASSEMBLY_WORKSHOPS
    filters = [ProductionTaskOrder.workshop.in_(ws_list)]
    if order_no:
        filters.append(SaleOrder.order_no.ilike(f"%{order_no}%"))
    if task_no:
        filters.append(ProductionTaskOrder.task_no.ilike(f"%{task_no}%"))
    if material_code:
        filters.append(ProductionTaskOrder.material_code.ilike(f"%{material_code}%"))
    if planned_end_from:
        filters.append(ProductionTaskOrder.planned_end_date >= planned_end_from)
    if planned_end_to:
        filters.append(ProductionTaskOrder.planned_end_date <= planned_end_to)
    if closed == "open":
        filters.append(or_(ProductionTaskOrder.is_closed == 0, ProductionTaskOrder.is_closed.is_(None)))
    elif closed == "closed":
        filters.append(ProductionTaskOrder.is_closed == 1)

    base = (
        select(ProductionTaskOrder, SaleOrder)
        .outerjoin(SaleOrder, SaleOrder.erp_id == ProductionTaskOrder.sale_order_id)
        .where(*filters)
    )

    total = (
        await db.execute(
            select(func.count())
            .select_from(ProductionTaskOrder)
            .outerjoin(SaleOrder, SaleOrder.erp_id == ProductionTaskOrder.sale_order_id)
            .where(*filters)
        )
    ).scalar() or 0

    rows = (
        await db.execute(
            base.order_by(
                ProductionTaskOrder.planned_end_date.desc().nullslast(),
                ProductionTaskOrder.id.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()

    # 行号匹配: (订单erp_id, 物料代码) -> 订单行号(同订单同产品多行时逗号连接)
    page_order_ids = {t.sale_order_id for t, _ in rows if t.sale_order_id}
    line_no_map: dict[tuple, list[str]] = {}
    if page_order_ids:
        line_rows = (
            await db.execute(
                select(SaleOrder.erp_id, SaleOrderLine.product_code, SaleOrderLine.line_no)
                .join(SaleOrderLine, SaleOrderLine.sale_order_id == SaleOrder.id)
                .where(SaleOrder.erp_id.in_(list(page_order_ids)))
            )
        ).all()
        for erp_id, pc, lno in line_rows:
            if pc:
                line_no_map.setdefault((erp_id, pc.strip()), []).append(str(lno))

    items = []
    ws_counter: dict[str, int] = {}
    open_cnt = 0
    for t, o in rows:
        line_nos = line_no_map.get((t.sale_order_id, (t.material_code or "").strip()), []) if t.sale_order_id else []
        items.append(
            TaskOrderItem(
                id=t.id,
                task_no=t.task_no,
                workshop=t.workshop,
                material_code=t.material_code,
                material_name=t.material_name,
                task_qty=_to_float(t.task_qty),
                actual_qty=_to_float(t.actual_qty),
                repair_qty=_to_float(t.repair_qty),
                planned_start_date=t.planned_start_date,
                planned_end_date=t.planned_end_date,
                actual_start_date=t.actual_start_date,
                actual_end_date=t.actual_end_date,
                is_closed=t.is_closed,
                audit_status=t.audit_status,
                bom_id=t.bom_id,
                order_no=o.order_no if o else None,
                order_line_no=",".join(line_nos) or None,
                customer=o.customer if o else None,
                promised_date=o.promised_date if o else None,
                task_order_id=t.sale_order_id,
            )
        )

    # 车间分布/未关闭数按当前筛选全量统计
    ws_rows = (
        await db.execute(
            select(ProductionTaskOrder.workshop, func.count())
            .outerjoin(SaleOrder, SaleOrder.erp_id == ProductionTaskOrder.sale_order_id)
            .where(*filters)
            .group_by(ProductionTaskOrder.workshop)
        )
    ).all()
    for w, c in ws_rows:
        ws_counter[w or "未知车间"] = c
    open_cnt = (
        await db.execute(
            select(func.count())
            .select_from(ProductionTaskOrder)
            .outerjoin(SaleOrder, SaleOrder.erp_id == ProductionTaskOrder.sale_order_id)
            .where(
                *filters,
                or_(ProductionTaskOrder.is_closed == 0, ProductionTaskOrder.is_closed.is_(None)),
            )
        )
    ).scalar() or 0

    stats = {"total": total, "open": open_cnt, "closed": total - open_cnt, "by_workshop": ws_counter}
    return ResponseModel(data=PageResult(total=total, page=page, page_size=page_size, items=items, stats=stats))


@router.post("/sync-oa", response_model=ResponseModel[dict])
async def sync_oa_wage(
    current_user: dict = Depends(PermissionChecker("production.order_wage_lookup", "read")),
    db: AsyncSession = Depends(get_db),
):
    """手动触发 OA 工价/产能同步(与产品工序产能页的同步同一底层服务), 免等整点自动同步。"""
    service = ProductProcessCapacitySyncService(db)
    try:
        result = await service.sync_from_oa()
    except ERPConnectionError as exc:
        raise HTTPException(status_code=500, detail=f"OA/ERP 连接失败: {exc}") from exc

    await log_audit(
        db,
        "product_process_capacity",
        0,
        "sync",
        field_name="oa_sync",
        new_value=str(result),
        operator=current_user["username"],
    )
    await db.commit()
    return ResponseModel(data=result)
