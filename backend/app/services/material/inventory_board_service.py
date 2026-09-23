"""库存看板 — 库存聚合查询 service"""

from datetime import datetime
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func, select, case, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.basicdata.inventory import Inventory
from app.models.basicdata.material import Material
from app.schemas.material.inventory_board import (
    AgingBucket,
    CategoryStockRow,
    InventoryBoardKpi,
    LowStockRow,
    WarehouseStockRow,
)


def _apply_filters(warehouse_id: Optional[int], category: Optional[str]):
    """构建公用 WHERE：scm_inventory + scm_material join"""
    inv = Inventory
    mat = Material
    cond = [inv.material_id == mat.erp_material_id]
    if warehouse_id is not None:
        cond.append(inv.wh_id == warehouse_id)
    if category:
        cond.append(mat.material_type == category)
    return cond


async def get_inventory_overview(
    db: AsyncSession,
    warehouse_id: Optional[int],
    category: Optional[str],
    low_stock_limit: int = 10,
) -> dict:
    """返回 KPI / 仓库分布 / 类别分布 / 库龄 / 低库存 / 筛选下拉"""

    cond = _apply_filters(warehouse_id, category)

    # KPI: 物料数 / 总库存量 / 总库存金额 / 仓库数
    kpi_q = (
        select(
            func.count(func.distinct(Inventory.material_id)).label("material_count"),
            func.coalesce(func.sum(Inventory.qty_on_hand), 0).label("total_qty"),
            func.coalesce(
                func.sum(Inventory.qty_on_hand * Inventory.unit_price), 0
            ).label("total_value"),
            func.count(func.distinct(Inventory.wh_id)).label("warehouse_count"),
        )
        .select_from(Inventory)
        .join(Material, and_(*cond))
    )
    kpi_row = (await db.execute(kpi_q)).one()
    kpi = InventoryBoardKpi(
        material_count=int(kpi_row.material_count or 0),
        total_qty=Decimal(kpi_row.total_qty or 0),
        total_value=Decimal(kpi_row.total_value or 0),
        warehouse_count=int(kpi_row.warehouse_count or 0),
    )

    # 按仓库
    by_wh_q = (
        select(
            Inventory.wh_id.label("wh_id"),
            func.max(Inventory.wh_name).label("wh_name"),
            func.count(func.distinct(Inventory.material_id)).label("material_count"),
            func.coalesce(func.sum(Inventory.qty_on_hand), 0).label("total_qty"),
            func.coalesce(
                func.sum(Inventory.qty_on_hand * Inventory.unit_price), 0
            ).label("total_value"),
        )
        .select_from(Inventory)
        .join(Material, and_(*cond))
        .group_by(Inventory.wh_id)
        .order_by(func.sum(Inventory.qty_on_hand * Inventory.unit_price).desc())
        .limit(50)
    )
    by_warehouse = [
        WarehouseStockRow(
            warehouse_id=int(r.wh_id),
            warehouse_name=r.wh_name or f"仓库#{r.wh_id}",
            material_count=int(r.material_count or 0),
            total_qty=Decimal(r.total_qty or 0),
            total_value=Decimal(r.total_value or 0),
        )
        for r in (await db.execute(by_wh_q)).all()
    ]

    # 按物料类别
    by_cat_q = (
        select(
            Material.material_type.label("category"),
            func.count(func.distinct(Inventory.material_id)).label("material_count"),
            func.coalesce(func.sum(Inventory.qty_on_hand), 0).label("total_qty"),
            func.coalesce(
                func.sum(Inventory.qty_on_hand * Inventory.unit_price), 0
            ).label("total_value"),
        )
        .select_from(Inventory)
        .join(Material, and_(*cond))
        .group_by(Material.material_type)
        .order_by(func.sum(Inventory.qty_on_hand * Inventory.unit_price).desc())
        .limit(50)
    )
    by_category = [
        CategoryStockRow(
            category=r.category or "未分类",
            material_count=int(r.material_count or 0),
            total_qty=Decimal(r.total_qty or 0),
            total_value=Decimal(r.total_value or 0),
        )
        for r in (await db.execute(by_cat_q)).all()
    ]

    # 库龄（基于 last_inbound_at）
    now = datetime.now()
    age_expr = case(
        (Inventory.last_inbound_at.is_(None), 99999),
        else_=func.extract("day", now - Inventory.last_inbound_at),
    )
    bucket_expr = case(
        (age_expr <= 30, "0-30d"),
        (age_expr <= 90, "31-90d"),
        (age_expr <= 180, "91-180d"),
        else_="180d+",
    )
    aging_q = (
        select(
            bucket_expr.label("bucket"),
            func.count(func.distinct(Inventory.material_id)).label("material_count"),
            func.coalesce(func.sum(Inventory.qty_on_hand), 0).label("total_qty"),
            func.coalesce(
                func.sum(Inventory.qty_on_hand * Inventory.unit_price), 0
            ).label("total_value"),
        )
        .select_from(Inventory)
        .join(Material, and_(*cond))
        .group_by(bucket_expr)
    )
    bucket_order = ["0-30d", "31-90d", "91-180d", "180d+"]
    rows = {(r.bucket or "180d+"): r for r in (await db.execute(aging_q)).all()}
    aging = [
        AgingBucket(
            bucket=b,
            material_count=int((rows.get(b).material_count if rows.get(b) else 0) or 0),
            total_qty=Decimal((rows.get(b).total_qty if rows.get(b) else 0) or 0),
            total_value=Decimal((rows.get(b).total_value if rows.get(b) else 0) or 0),
        )
        for b in bucket_order
    ]

    # 低库存 Top N（按 qty_on_hand 升序，> 0 优先）
    low_q = (
        select(
            Inventory.material_code,
            Inventory.material_name,
            Inventory.wh_name,
            Inventory.qty_on_hand,
            Material.unit_of_measure,
        )
        .select_from(Inventory)
        .join(Material, and_(*cond))
        .where(Inventory.qty_on_hand > 0)
        .order_by(Inventory.qty_on_hand.asc())
        .limit(low_stock_limit)
    )
    low_stock = [
        LowStockRow(
            material_code=r.material_code,
            material_name=r.material_name,
            warehouse_name=r.wh_name or "",
            qty_on_hand=Decimal(r.qty_on_hand or 0),
            unit=r.unit_of_measure,
        )
        for r in (await db.execute(low_q)).all()
    ]

    # 仓库下拉（distinct wh_id + wh_name）
    wh_dd_q = (
        select(
            Inventory.wh_id,
            func.max(Inventory.wh_name).label("wh_name"),
        )
        .group_by(Inventory.wh_id)
        .order_by(Inventory.wh_id)
    )
    warehouses = [
        {"id": int(r.wh_id), "name": r.wh_name or f"仓库#{r.wh_id}"}
        for r in (await db.execute(wh_dd_q)).all()
    ]

    # 类别下拉（distinct material_type）
    cat_dd_q = (
        select(Material.material_type)
        .where(Material.material_type.isnot(None))
        .group_by(Material.material_type)
        .order_by(Material.material_type)
    )
    categories = [r[0] for r in (await db.execute(cat_dd_q)).all() if r[0]]

    return {
        "kpi": kpi,
        "by_warehouse": by_warehouse,
        "by_category": by_category,
        "aging": aging,
        "low_stock": low_stock,
        "warehouses": warehouses,
        "categories": categories,
    }


from datetime import date, timedelta

from sqlalchemy import and_, or_

from app.models.material.inventory_check import StockCheck, StockCheckItem
from app.schemas.material.inventory_board import (
    ActiveCheckRow,
    RecentDiffRow,
    StockCheckBoardKpi,
    StockCheckTrendPoint,
)


async def get_stock_check_overview(
    db: AsyncSession,
    trend_days: int = 30,
    active_limit: int = 20,
    diff_limit: int = 20,
) -> dict:
    """返回盘点 KPI / 进行中盘点单 / 趋势 / 近期差异"""

    today = date.today()
    first_of_month = today.replace(day=1)

    # KPI: 进行中盘点单数 / 本月完成率 / 本月盘盈 / 本月盘亏
    active_q = select(func.count(StockCheck.id)).where(
        StockCheck.status.in_(("open", "in_progress"))
    )
    active_count = int((await db.execute(active_q)).scalar() or 0)

    # 本月完成率 = 本月已完成 / 本月全部
    month_total_q = select(func.count(StockCheck.id)).where(
        StockCheck.check_date >= first_of_month
    )
    month_done_q = select(func.count(StockCheck.id)).where(
        and_(
            StockCheck.check_date >= first_of_month,
            StockCheck.status == "completed",
        )
    )
    month_total = int((await db.execute(month_total_q)).scalar() or 0)
    month_done = int((await db.execute(month_done_q)).scalar() or 0)
    completion_rate = (month_done / month_total) if month_total > 0 else 0.0

    # 本月盘盈/盘亏（实际盘点数 vs 系统盘点数）
    profit_expr = case(
        (
            and_(
                StockCheckItem.actual_qty.isnot(None),
                StockCheckItem.actual_qty > StockCheckItem.system_qty,
            ),
            StockCheckItem.actual_qty - StockCheckItem.system_qty,
        ),
        else_=0,
    )
    loss_expr = case(
        (
            and_(
                StockCheckItem.actual_qty.isnot(None),
                StockCheckItem.actual_qty < StockCheckItem.system_qty,
            ),
            StockCheckItem.system_qty - StockCheckItem.actual_qty,
        ),
        else_=0,
    )
    month_diff_q = (
        select(
            func.coalesce(func.sum(profit_expr), 0).label("profit"),
            func.coalesce(func.sum(loss_expr), 0).label("loss"),
        )
        .select_from(StockCheckItem)
        .join(StockCheck, StockCheckItem.check_id == StockCheck.id)
        .where(StockCheck.check_date >= first_of_month)
    )
    md_row = (await db.execute(month_diff_q)).one()
    kpi = StockCheckBoardKpi(
        active_checks=active_count,
        month_completion_rate=round(completion_rate, 4),
        month_profit_qty=Decimal(md_row.profit or 0),
        month_loss_qty=Decimal(md_row.loss or 0),
    )

    # 进行中盘点单
    active_rows_q = (
        select(StockCheck)
        .where(StockCheck.status.in_(("open", "in_progress")))
        .order_by(StockCheck.check_date.desc())
        .limit(active_limit)
    )
    today_dt = datetime.now()
    active_rows = []
    for sc in (await db.execute(active_rows_q)).scalars().all():
        age = (today_dt.date() - sc.check_date).days
        rate = (sc.checked_materials / sc.total_materials) if sc.total_materials else 0.0
        active_rows.append(
            ActiveCheckRow(
                check_id=sc.id,
                check_no=sc.check_no,
                status=sc.status,
                total_materials=sc.total_materials,
                checked_materials=sc.checked_materials,
                completion_rate=round(rate, 4),
                check_date=sc.check_date,
                age_days=age,
                created_by=sc.created_by,
                order_no=sc.order_no,
            )
        )

    # 趋势（最近 N 天，按日期聚合完成单数 / 差异行数 / 差异总量）
    days_back = today - timedelta(days=trend_days - 1)
    trend_q = (
        select(
            StockCheck.check_date.label("d"),
            func.count(func.distinct(StockCheck.id)).label("checks_completed"),
            func.count(StockCheckItem.id).label("diff_items_count"),
            func.coalesce(
                func.sum(
                    case(
                        (
                            and_(
                                StockCheckItem.actual_qty.isnot(None),
                                StockCheckItem.actual_qty != StockCheckItem.system_qty,
                            ),
                            StockCheckItem.actual_qty - StockCheckItem.system_qty,
                        ),
                        else_=0,
                    )
                ),
                0,
            ).label("total_diff_qty"),
        )
        .select_from(StockCheck)
        .outerjoin(
            StockCheckItem,
            and_(
                StockCheckItem.check_id == StockCheck.id,
                StockCheckItem.actual_qty.isnot(None),
                StockCheckItem.actual_qty != StockCheckItem.system_qty,
            ),
        )
        .where(StockCheck.check_date >= days_back)
        .group_by(StockCheck.check_date)
        .order_by(StockCheck.check_date)
    )
    trend_rows = (await db.execute(trend_q)).all()
    # 补齐缺失日期为 0
    trend_map = {r.d: r for r in trend_rows}
    trend: List[StockCheckTrendPoint] = []
    for i in range(trend_days):
        d = days_back + timedelta(days=i)
        r = trend_map.get(d)
        trend.append(
            StockCheckTrendPoint(
                date=d,
                checks_completed=int(r.checks_completed if r else 0),
                diff_items_count=int(r.diff_items_count if r else 0),
                total_diff_qty=Decimal(r.total_diff_qty if r else 0),
            )
        )

    # 近期差异 Top N（按检查日期倒序，取有差异的行）
    diff_q = (
        select(
            StockCheck.check_no,
            StockCheck.check_date,
            StockCheckItem.material_code,
            StockCheckItem.material_name,
            StockCheckItem.spec_model,
            StockCheckItem.unit,
            StockCheckItem.system_qty,
            StockCheckItem.actual_qty,
            (StockCheckItem.actual_qty - StockCheckItem.system_qty).label("diff_qty"),
        )
        .select_from(StockCheckItem)
        .join(StockCheck, StockCheckItem.check_id == StockCheck.id)
        .where(
            and_(
                StockCheckItem.actual_qty.isnot(None),
                StockCheckItem.actual_qty != StockCheckItem.system_qty,
            )
        )
        .order_by(StockCheck.check_date.desc(), StockCheckItem.id.desc())
        .limit(diff_limit)
    )
    recent_diffs = [
        RecentDiffRow(
            check_no=r.check_no,
            check_date=r.check_date,
            material_code=r.material_code,
            material_name=r.material_name,
            spec_model=r.spec_model,
            unit=r.unit,
            system_qty=Decimal(r.system_qty or 0),
            actual_qty=Decimal(r.actual_qty) if r.actual_qty is not None else None,
            diff_qty=Decimal(r.diff_qty) if r.diff_qty is not None else None,
        )
        for r in (await db.execute(diff_q)).all()
    ]

    return {
        "kpi": kpi,
        "active_checks": active_rows,
        "trend": trend,
        "recent_diffs": recent_diffs,
    }


async def get_check_coverage(
    db: AsyncSession,
    recent_days: Optional[int] = 30,
) -> dict:
    """盘点覆盖 — 全部「物料×仓库」的已盘 / 未盘（按仓库分组）

    已盘口径与库存页「近期已盘」/ 任务盘点「已盘窗口」一致：
    该 (material_id, wh_id) 在窗口内实盘过（scm_inventory_check_item.actual_qty 非空
    且盘点单未取消），窗口由 _resolve_recent_days 归一（None=系统默认、负数=全部历史）。

    行 = 物料×仓库（与 scm_inventory 行一致，一物料多仓算多行），全仓口径，不做仓库筛选
    —— 前端用仓库 chips 做展示层筛选，避免重复请求。
    """
    # 延迟导入：stock_check_service 体积大，避免模块级循环依赖
    from app.services.material.stock_check_service import (
        _get_recent_checked_by_warehouse,
        _resolve_recent_days,
    )

    cond = _apply_filters(None, None)
    rows_q = (
        select(
            Inventory.material_id,
            Inventory.wh_id,
            func.max(Inventory.wh_name).label("wh_name"),
        )
        .select_from(Inventory)
        .join(Material, and_(*cond))
        .group_by(Inventory.material_id, Inventory.wh_id)
    )

    keys: List[Tuple[int, Optional[int]]] = []
    wh_name_of: Dict[Optional[int], str] = {}
    for r in (await db.execute(rows_q)).all():
        if r.material_id is None:
            continue
        mid = int(r.material_id)
        wid = int(r.wh_id) if r.wh_id is not None else None
        keys.append((mid, wid))
        wh_name_of[wid] = r.wh_name or (f"仓库#{wid}" if wid is not None else "(未入库)")

    skip_days = _resolve_recent_days(recent_days)
    recent_map = await _get_recent_checked_by_warehouse(db, keys) if keys else {}
    today = datetime.now().date()

    acc: Dict[Optional[int], Dict] = {}
    checked_total = 0
    for k in keys:
        recent = recent_map.get(k)
        is_checked = bool(
            recent is not None
            and recent.get("check_date") is not None
            and (today - recent["check_date"]).days <= skip_days
        )
        wid = k[1]
        a = acc.get(wid)
        if a is None:
            a = {"wh_id": wid, "wh_name": wh_name_of.get(wid, ""), "total": 0, "checked": 0}
            acc[wid] = a
        a["total"] += 1
        if is_checked:
            a["checked"] += 1
            checked_total += 1

    total = len(keys)
    warehouses = sorted(acc.values(), key=lambda x: x["total"], reverse=True)
    for w in warehouses:
        w["unchecked"] = w["total"] - w["checked"]
        w["rate"] = round(w["checked"] / w["total"], 4) if w["total"] else 0.0

    return {
        "recent_days": skip_days,
        "total": total,
        "checked": checked_total,
        "unchecked": total - checked_total,
        "rate": round(checked_total / total, 4) if total else 0.0,
        "warehouses": warehouses,
    }