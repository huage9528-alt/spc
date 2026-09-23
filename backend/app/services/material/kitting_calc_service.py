"""物料齐套中心 — 对外齐套计算引擎（AEOS 只读接入口径）

按《SPC 物料齐套中心接入 AEOS 开发文档 v1.1》§5 计算规则，全量重算销售订单齐套结果，
持久化到 kitting_run / kitting_result / kitting_shortage。

与页面口径 kit_analysis_service 的差异（有意为之，勿合并）：
- 毛需求 = 标准用量 × (1+损耗率) 逐层复合；页面口径不做损耗复合
- 可用库存 = Σ (qty_on_hand − locked_qty)（现存 − 锁定；本账套 K3 FQtyLock/FBal 恒 0，
  故实际等于现存；映射修正后锁定自动生效）
- 自制(2)/委外(3) 物料计入需求并由 PRODUCTION/OUTSOURCE 供给满足，不向下展开其 BOM；
  虚拟件(5) 仅展开不占需求
- 产出净缺口 / 预计齐套日期 / 数量齐套率 / 四类供给，页面口径无这些字段
- 直接调拨（本账套全部调拨）审核即入库存快照，不计入未来供给，避免与库存重复计算
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import Counter
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import AsyncSessionLocal, engine
from app.models.basicdata.bom import Bom
from app.models.basicdata.bom_detail import BomDetail
from app.models.basicdata.inventory import Inventory
from app.models.basicdata.material import Material
from app.models.basicdata.sync_sql_config import SyncSqlConfig
from app.models.material.kitting import KittingResult, KittingRun, KittingShortage
from app.models.material.long_lead_material import LongLeadMaterial
from app.models.material.mrp_plan_order import MrpPlanOrder
from app.models.material.purchase_order import PurchaseOrder
from app.models.material.subcontract_order import SubcontractOrder
from app.models.material.subcontract_order_detail import SubcontractOrderDetail
from app.models.material.transfer_order import TransferOrder
from app.models.order.sale_order import SaleOrder, SaleOrderLine

logger = logging.getLogger(__name__)

CALCULATION_VERSION = "1.0.0"
STALE_HOURS = 24
_ZERO = Decimal("0")
_MAX_BOM_DEPTH = 12

# 触发齐套重算的源数据类型（同步成功后 hook）
KITTING_SOURCE_SYNC_TYPES = (
    "orders",
    "order_details",
    "materials",
    "materials_masterdata",
    "boms",
    "bom_details",
    "inventory",
    "purchase_orders",
    "subcontract_orders",
    "subcontract_order_details",
    "mrp_plan_orders",
    "transfer_orders",
)

# 齐套结果 data_as_of 对应的源数据（对外接口口径）
KITTING_RESULT_SYNC_TYPES = (
    "orders",
    "materials_masterdata",
    "boms",
    "bom_details",
    "inventory",
    "purchase_orders",
    "subcontract_order_details",
    "mrp_plan_orders",
    "transfer_orders",
)

_calc_lock = asyncio.Lock()

# 跨进程 single-flight：PG advisory lock 固定 key（任意稳定大整数）
_ADVISORY_LOCK_KEY = 20260922


def is_running() -> bool:
    return _calc_lock.locked()


def new_run_id() -> str:
    return uuid.uuid4().hex


def freshness_of(data_as_of: Optional[datetime]) -> tuple[str, bool]:
    """返回 (data_confidence, stale)。6h 内 high，24h 内 medium，超 24h 或缺失 low/stale。"""
    if data_as_of is None:
        return "low", True
    age = datetime.now() - data_as_of
    if age <= timedelta(hours=6):
        return "high", False
    if age <= timedelta(hours=STALE_HOURS):
        return "medium", False
    return "low", True


async def load_source_as_of(db: AsyncSession, sync_types: tuple[str, ...]) -> dict[str, Optional[datetime]]:
    """各源最近成功同步时间（sync_sql_config.last_sync_time）。"""
    rows = (
        await db.execute(
            select(SyncSqlConfig.sync_type, SyncSqlConfig.last_sync_time).where(
                SyncSqlConfig.sync_type.in_(sync_types)
            )
        )
    ).all()
    result: dict[str, Optional[datetime]] = {t: None for t in sync_types}
    for sync_type, last_time in rows:
        if sync_type in result:
            result[sync_type] = last_time
    return result


def min_as_of(source_as_of: dict[str, Optional[datetime]]) -> Optional[datetime]:
    values = [v for v in source_as_of.values() if v is not None]
    return min(values) if values else None


def _owner_department(prop: Optional[int]) -> Optional[str]:
    if prop == 1:
        return "采购部"
    if prop == 3:
        return "采购部"
    if prop == 2:
        return "生产部"
    return None


def _merge_unit(target: dict[int, Decimal], material_id: int, qty: Decimal) -> None:
    target[material_id] = target.get(material_id, _ZERO) + qty


def _expand_bom_unit(ctx: dict, bom_id: str, visited: frozenset) -> dict[int, Decimal]:
    """按 factor=1 展开 BOM 的「单位用量」映射（子件需求 = 父单位用量 × 标准用量 × (1+损耗率)）。

    虚拟件(5) 不占需求、继续展开；自制(2)/委外(3) 计入需求但不再向下展开。
    结果按 bom_id 缓存于 ctx["unit_qty_memo"]（同一 BOM 的单位用量与调用路径无关）。
    """
    if not bom_id or bom_id in visited or len(visited) > _MAX_BOM_DEPTH:
        return {}
    memo = ctx["unit_qty_memo"]
    if bom_id in memo:
        return memo[bom_id]
    visited = visited | {bom_id}
    result: dict[int, Decimal] = {}
    for material_id, standard_qty, scrap_rate, prop in ctx["details_by_bom"].get(bom_id, []):
        if material_id is None or standard_qty is None:
            continue
        qty = standard_qty * (Decimal("1") + (scrap_rate or _ZERO))
        if prop == 5:
            child = ctx["child_bom_by_material"].get(material_id)
            if child:
                for sub_id, sub_qty in _expand_bom_unit(ctx, child, visited).items():
                    _merge_unit(result, sub_id, sub_qty * qty)
            continue
        _merge_unit(result, material_id, qty)
        if prop in (2, 3):
            continue
        child = ctx["child_bom_by_material"].get(material_id)
        if child:
            for sub_id, sub_qty in _expand_bom_unit(ctx, child, visited).items():
                _merge_unit(result, sub_id, sub_qty * qty)
    memo[bom_id] = result
    return result


def _expand_bom(ctx: dict, bom_id: str, factor: Decimal, visited: frozenset) -> dict[int, Decimal]:
    """逐层展开 BOM：子件需求 = 父需求 × 标准用量 × (1+损耗率)。

    单位用量由 _expand_bom_unit 缓存，本函数仅按 factor 放大。
    """
    if not bom_id:
        return {}
    unit = _expand_bom_unit(ctx, bom_id, visited)
    return {material_id: qty * factor for material_id, qty in unit.items()}


def _add_supply(
    ctx: dict,
    material_code: str,
    supply_type: str,
    supply_no: str,
    line_no,
    qty: Decimal,
    expected_date: Optional[date],
    supplier_code: Optional[str] = None,
    supplier_name: Optional[str] = None,
) -> None:
    if not material_code or qty <= 0:
        return
    ctx["supplies"].setdefault(material_code, []).append(
        {
            "supply_type": supply_type,
            "supply_no": supply_no or "",
            "line_no": line_no,
            "qty": qty,
            "date": expected_date,
            "supplier_code": supplier_code,
            "supplier_name": supplier_name,
        }
    )


async def _load_context(db: AsyncSession) -> dict:
    ctx: dict = {
        "demands": [],
        "details_by_bom": {},
        "child_bom_by_material": {},
        "bom_version_by_id": {},
        "material_property_by_id": {},
        "code_by_mid": {},
        "mid_by_code": {},
        "material_name": {},
        "price_by_code": {},
        "key_codes": set(),
        "blocked_codes": set(),
        "inv_avail": {},
        "supplies": {},
        "inventory_snapshot_exists": False,
        "unit_qty_memo": {},
    }

    material_rows = (
        await db.execute(
            select(
                Material.erp_material_id,
                Material.material_code,
                Material.material_name,
                Material.material_property,
                Material.order_unit_price,
                Material.status,
                Material.is_deleted,
            )
        )
    ).all()
    for mid, code, name, prop, price, status, is_deleted in material_rows:
        if mid is not None:
            ctx["material_property_by_id"][mid] = prop
            if code:
                ctx["code_by_mid"][mid] = code
        if code:
            ctx["mid_by_code"][code] = mid
            ctx["material_name"][code] = name
            if price is not None:
                ctx["price_by_code"][code] = Decimal(str(price))
            if status != 1 or is_deleted == 1:
                ctx["blocked_codes"].add(code)

    bom_rows = (await db.execute(select(Bom.bom_id, Bom.material_id, Bom.bom_version))).all()
    for bom_id, material_id, bom_version in bom_rows:
        if bom_id and material_id is not None:
            ctx["child_bom_by_material"].setdefault(material_id, bom_id)
            ctx["bom_version_by_id"][bom_id] = bom_version

    detail_rows = (
        await db.execute(
            select(
                BomDetail.bom_id,
                BomDetail.material_id,
                BomDetail.standard_qty,
                BomDetail.scrap_rate,
                BomDetail.kit_flag,
            )
        )
    ).all()
    for d in detail_rows:
        if d.bom_id and d.material_id is not None and d.standard_qty is not None:
            prop = ctx["material_property_by_id"].get(d.material_id)
            ctx["details_by_bom"].setdefault(d.bom_id, []).append(
                (d.material_id, d.standard_qty, d.scrap_rate, prop)
            )
            if d.kit_flag == 1:
                code = ctx["code_by_mid"].get(d.material_id)
                if code:
                    ctx["key_codes"].add(code)

    long_lead_rows = (await db.execute(select(LongLeadMaterial.material_code))).all()
    for (code,) in long_lead_rows:
        if code:
            ctx["key_codes"].add(code)

    inv_rows = (
        await db.execute(
            select(
                Inventory.material_code,
                func.sum(Inventory.qty_on_hand - Inventory.locked_qty),
            )
            .where(Inventory.material_code.isnot(None))
            .group_by(Inventory.material_code)
        )
    ).all()
    ctx["inventory_snapshot_exists"] = bool(inv_rows)
    for code, qty in inv_rows:
        ctx["inv_avail"][code] = qty or _ZERO

    price_rows = (
        await db.execute(
            select(Inventory.material_code, func.avg(Inventory.unit_price))
            .where(Inventory.material_code.isnot(None), Inventory.unit_price > 0)
            .group_by(Inventory.material_code)
        )
    ).all()
    for code, avg_price in price_rows:
        if avg_price is not None:
            ctx["price_by_code"][code] = Decimal(str(avg_price))

    mrp_rows = (
        await db.execute(
            select(
                MrpPlanOrder.material_code,
                MrpPlanOrder.base_plan_qty,
                MrpPlanOrder.stock_qty,
                MrpPlanOrder.need_date,
                MrpPlanOrder.bill_type,
                MrpPlanOrder.sale_order_no,
            ).where(MrpPlanOrder.is_closed == 0)
        )
    ).all()
    outsource_dates: dict[str, date] = {}
    for code, plan_qty, stock_qty, need_date, bill_type, sale_order_no in mrp_rows:
        if not code:
            continue
        if bill_type == 11011:
            qty = (plan_qty or _ZERO) - (stock_qty or _ZERO)
            _add_supply(ctx, code, "PRODUCTION", sale_order_no or f"MRP-{code}", None, qty, need_date)
        elif bill_type == 11012 and need_date:
            prev = outsource_dates.get(code)
            if prev is None or need_date < prev:
                outsource_dates[code] = need_date

    po_rows = (
        await db.execute(
            select(
                PurchaseOrder.po_no,
                PurchaseOrder.detail_id,
                PurchaseOrder.material_code,
                PurchaseOrder.po_qty,
                PurchaseOrder.received_qty,
                PurchaseOrder.eta,
                PurchaseOrder.po_date,
                PurchaseOrder.supplier_code,
                PurchaseOrder.supplier_name,
            ).where(PurchaseOrder.is_closed == 0, PurchaseOrder.material_code.isnot(None))
        )
    ).all()
    for r in po_rows:
        qty = (r.po_qty or _ZERO) - (r.received_qty or _ZERO)
        _add_supply(
            ctx, r.material_code, "PURCHASE", r.po_no, r.detail_id, qty,
            r.eta or r.po_date, r.supplier_code, r.supplier_name,
        )

    sub_rows = (
        await db.execute(
            select(
                SubcontractOrder.bill_no,
                SubcontractOrderDetail.detail_id,
                SubcontractOrderDetail.material_id,
                SubcontractOrderDetail.qty,
                SubcontractOrderDetail.received_qty,
                SubcontractOrderDetail.returned_qty,
            )
            .join(SubcontractOrder, SubcontractOrderDetail.erp_order_id == SubcontractOrder.erp_order_id)
            .where(
                (SubcontractOrder.closed_flag == 0) | (SubcontractOrder.closed_flag.is_(None)),
                (SubcontractOrder.voided_flag == 0) | (SubcontractOrder.voided_flag.is_(None)),
            )
        )
    ).all()
    for bill_no, detail_id, material_id, qty, received_qty, returned_qty in sub_rows:
        code = ctx["code_by_mid"].get(material_id)
        if not code:
            continue
        outstanding = (qty or _ZERO) - (received_qty or _ZERO) - (returned_qty or _ZERO)
        _add_supply(ctx, code, "OUTSOURCE", bill_no, detail_id, outstanding, outsource_dates.get(code))

    tr_rows = (
        await db.execute(
            select(
                TransferOrder.transfer_no,
                TransferOrder.entry_id,
                TransferOrder.material_code,
                TransferOrder.qty,
                TransferOrder.transfer_date,
                TransferOrder.expected_arrival_date,
                TransferOrder.status,
            ).where(TransferOrder.is_deleted == 0)
        )
    ).all()
    for r in tr_rows:
        if r.status != "in_transit":
            continue
        _add_supply(
            ctx, r.material_code, "TRANSFER", r.transfer_no, r.entry_id,
            r.qty or _ZERO, r.expected_arrival_date or r.transfer_date,
        )

    for supplies in ctx["supplies"].values():
        supplies.sort(key=lambda s: (s["date"] is None, s["date"] or date.max))

    line_rows = (
        await db.execute(
            select(
                SaleOrderLine.order_no,
                SaleOrderLine.line_no,
                SaleOrderLine.product_code,
                SaleOrderLine.order_qty,
                SaleOrderLine.order_amount.label("line_order_amount"),
                SaleOrderLine.promised_date.label("line_promised_date"),
                SaleOrderLine.bom_id,
                SaleOrder.customer_code,
                SaleOrder.order_amount.label("header_order_amount"),
                SaleOrder.material_ready_date,
                SaleOrder.shipping_plan,
                SaleOrder.promised_date.label("header_promised_date"),
            )
            .join(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)
            .where(
                SaleOrder.is_closed == 0,
                SaleOrder.is_deleted == 0,
                SaleOrderLine.status != "closed",
            )
        )
    ).all()
    for ln in line_rows:
        order_no = ln.order_no
        line_no = ln.line_no or ""
        qty = Decimal(str(ln.order_qty)) if ln.order_qty is not None else _ZERO
        if not order_no or qty <= 0:
            continue
        bom_id = str(ln.bom_id) if ln.bom_id is not None else None
        need_map = _expand_bom(ctx, bom_id, Decimal("1"), frozenset()) if bom_id else {}
        if need_map:
            need_map = {mid: q * qty for mid, q in need_map.items()}
        order_amount = ln.line_order_amount if ln.line_order_amount is not None else ln.header_order_amount
        required_date = (
            ln.material_ready_date or ln.shipping_plan or ln.header_promised_date or ln.line_promised_date
        )
        ctx["demands"].append(
            {
                "order_no": order_no,
                "line_no": line_no,
                "customer_code": ln.customer_code,
                "product_code": ln.product_code,
                "order_qty": qty,
                "order_amount": order_amount,
                "required_date": required_date,
                "bom_id": bom_id,
                "need_map": need_map,
                "bom_missing": not bool(need_map),
            }
        )
    ctx["demands"].sort(
        key=lambda d: (
            d["required_date"] is None,
            d["required_date"] or date.max,
            d["order_no"],
            d["line_no"],
        )
    )
    return ctx


def _allocate_demand(ctx: dict, demand: dict, run_id: str, calculated_at: datetime, data_as_of):
    order_no = demand["order_no"]
    line_no = demand["line_no"]
    required_date = demand["required_date"]

    need_by_code: dict[str, Decimal] = {}
    for mid, qty in demand["need_map"].items():
        code = ctx["code_by_mid"].get(mid)
        if not code:
            continue
        need_by_code[code] = need_by_code.get(code, _ZERO) + qty

    total_items = len(need_by_code)
    total_qty = sum(need_by_code.values(), _ZERO)
    satisfied_items = 0
    satisfied_qty = _ZERO
    shortages: list[dict] = []
    key_shortage = False
    est_dates: list[date] = []
    est_unknown = False
    shortage_amount = _ZERO
    amount_priced = False

    for code, need in need_by_code.items():
        available = ctx["inv_avail"].get(code, _ZERO)
        if available < _ZERO:
            available = _ZERO
        take_stock = min(available, need)
        ctx["inv_avail"][code] = available - take_stock
        remaining = need - take_stock
        future_taken = _ZERO
        last_used = None

        if remaining > 0:
            for s in ctx["supplies"].get(code, []):
                if remaining <= 0:
                    break
                if s["date"] is not None and required_date is not None and s["date"] <= required_date:
                    take = min(s["qty"], remaining)
                    if take <= 0:
                        continue
                    s["qty"] -= take
                    remaining -= take
                    future_taken += take
                    last_used = s

        shortage = remaining
        if shortage <= 0:
            satisfied_items += 1
            satisfied_qty += need
            continue

        satisfied_qty += need - shortage

        est_date = None
        acc = _ZERO
        for s in ctx["supplies"].get(code, []):
            if s["qty"] <= 0 or s["date"] is None:
                continue
            acc += s["qty"]
            if acc >= shortage:
                est_date = s["date"]
                break
        if est_date is None:
            est_unknown = True
        else:
            est_dates.append(est_date)

        is_key = code in ctx["key_codes"]
        if is_key:
            key_shortage = True

        supply_list = ctx["supplies"].get(code, [])
        if take_stock > 0 and not supply_list:
            reason = "INSUFFICIENT_STOCK"
        elif not supply_list and take_stock <= 0:
            reason = "NO_STOCK"
        elif est_date is None:
            reason = "NO_SUPPLY"
        else:
            reason = "SUPPLY_LATE"
        src = last_used or next((s for s in supply_list if s["qty"] > 0), None)
        supply_source = None
        if src and src["supply_no"]:
            supply_source = f"{src['supply_type']}:{src['supply_no']}"
            if src["line_no"] is not None:
                supply_source += f"/{src['line_no']}"

        price = ctx["price_by_code"].get(code)
        if price:
            shortage_amount += shortage * price
            amount_priced = True

        prop = ctx["material_property_by_id"].get(ctx["mid_by_code"].get(code))
        shortages.append(
            {
                "demand_type": "SALES_ORDER",
                "demand_no": order_no,
                "demand_line_no": line_no,
                "material_code": code,
                "material_name": ctx["material_name"].get(code),
                "required_qty": need,
                "available_qty": take_stock,
                "future_supply_qty": future_taken,
                "shortage_qty": shortage,
                "required_date": required_date,
                "estimated_available_date": est_date,
                "shortage_days": (est_date - required_date).days if (est_date and required_date) else None,
                "shortage_reason": reason,
                "supply_source": supply_source,
                "supplier_code": src["supplier_code"] if src else None,
                "supplier_name": src["supplier_name"] if src else None,
                "is_key_material": 1 if is_key else 0,
                "owner_department": _owner_department(prop),
                "owner": None,
                "alert_status": "OPEN",
                "allocation_run_id": run_id,
                "is_deleted": 0,
            }
        )

    blocked = any(code in ctx["blocked_codes"] for code in need_by_code)
    if demand["bom_missing"] or not ctx["inventory_snapshot_exists"]:
        status = "PENDING"
    elif blocked:
        status = "BLOCKED"
    elif key_shortage:
        status = "SHORTAGE"
    elif shortages:
        status = "PARTIAL"
    else:
        status = "FULL"

    if total_items:
        rate_item = (Decimal(satisfied_items) / Decimal(total_items) * 100).quantize(Decimal("0.01"))
    else:
        rate_item = _ZERO
    if total_qty > 0:
        rate_qty = (satisfied_qty / total_qty * 100).quantize(Decimal("0.01"))
    else:
        rate_qty = _ZERO

    risk_level = {
        "FULL": "green",
        "PARTIAL": "yellow",
        "SHORTAGE": "red",
        "BLOCKED": "red",
        "PENDING": "yellow",
    }.get(status, "yellow")

    row = {
        "demand_type": "SALES_ORDER",
        "demand_no": order_no,
        "demand_line_no": line_no,
        "customer_code": demand["customer_code"],
        "product_code": demand["product_code"],
        "required_date": required_date,
        "kit_status": status,
        "kit_rate_by_item": rate_item,
        "kit_rate_by_qty": rate_qty,
        "estimated_kit_date": max(est_dates) if (est_dates and not est_unknown) else None,
        "shortage_item_count": len(shortages),
        "shortage_amount": shortage_amount if amount_priced else None,
        "affected_order_amount": demand["order_amount"],
        "risk_level": risk_level,
        "key_material_shortage": 1 if key_shortage else 0,
        "bom_id": demand["bom_id"],
        "bom_version": ctx["bom_version_by_id"].get(demand["bom_id"]),
        "allocation_run_id": run_id,
        "calculation_version": CALCULATION_VERSION,
        "calculated_at": calculated_at,
        "data_as_of": data_as_of,
        "is_deleted": 0,
    }
    return row, shortages


async def _upsert_results(db: AsyncSession, rows: dict, now: datetime) -> None:
    existing_rows = (await db.execute(select(KittingResult))).scalars().all()
    existing = {(r.demand_no, r.demand_line_no): r for r in existing_rows}
    seen = set()
    for key, data in rows.items():
        seen.add(key)
        obj = existing.get(key)
        if obj is None:
            db.add(KittingResult(**data))
        else:
            for field, value in data.items():
                setattr(obj, field, value)
            obj.updated_at = now
    for key, obj in existing.items():
        if key not in seen and not obj.is_deleted:
            obj.is_deleted = 1
            obj.updated_at = now


async def _upsert_shortages(db: AsyncSession, rows: dict, now: datetime) -> None:
    existing_rows = (await db.execute(select(KittingShortage))).scalars().all()
    existing = {(r.demand_no, r.demand_line_no, r.material_code): r for r in existing_rows}
    seen = set()
    for key, data in rows.items():
        seen.add(key)
        obj = existing.get(key)
        if obj is None:
            db.add(KittingShortage(**data))
        else:
            for field, value in data.items():
                setattr(obj, field, value)
            obj.updated_at = now
    for key, obj in existing.items():
        if key not in seen and not obj.is_deleted:
            obj.is_deleted = 1
            obj.updated_at = now


async def _get_or_create_run(
    db: AsyncSession,
    run_id: str,
    trigger_type: str,
    triggered_by: Optional[int],
    started: datetime,
) -> KittingRun:
    run = (
        await db.execute(select(KittingRun).where(KittingRun.allocation_run_id == run_id))
    ).scalar_one_or_none()
    if run is not None:
        return run
    run = KittingRun(
        allocation_run_id=run_id,
        calculation_version=CALCULATION_VERSION,
        trigger_type=trigger_type,
        triggered_by=triggered_by,
        status="running",
        started_at=started,
    )
    db.add(run)
    await db.flush()
    return run


async def _mark_run_skipped(allocation_run_id: str, reason: str) -> None:
    async with AsyncSessionLocal() as db:
        run = (
            await db.execute(
                select(KittingRun).where(KittingRun.allocation_run_id == allocation_run_id)
            )
        ).scalar_one_or_none()
        if run is not None and run.status == "running":
            run.status = "skipped"
            run.error_message = reason
            run.finished_at = datetime.now()
            await db.commit()


async def calculate_kitting(
    allocation_run_id: Optional[str] = None,
    trigger_type: str = "manual",
    triggered_by: Optional[int] = None,
) -> dict:
    """全量重算齐套结果并落库。single-flight 双层防重：进程内 asyncio 锁 + 跨进程 PG advisory 锁。

    结果/缺料表按 (需求对象, 行) 主键 upsert；每轮无条件刷新 updated_at 是有意行为：
    provenance 字段（allocation_run_id/calculated_at）每轮都变，AEOS 按 updated_at 增量
    拉取最新批次；结果表规模 = 活跃需求数，全量刷新的写入量可控。
    """
    if _calc_lock.locked():
        logger.info("[齐套计算] 本进程已有计算进行中，本次跳过")
        if allocation_run_id:
            await _mark_run_skipped(allocation_run_id, "已有计算进行中，本次跳过")
        return {"skipped": True, "reason": "calculation_in_progress"}

    async with _calc_lock:
        run_id = allocation_run_id or new_run_id()
        started = datetime.now()
        lock_conn = await engine.connect()
        try:
            acquired = bool(
                await lock_conn.scalar(
                    text("SELECT pg_try_advisory_lock(:key)"), {"key": _ADVISORY_LOCK_KEY}
                )
            )
            if not acquired:
                logger.info("[齐套计算] 其他实例计算进行中（advisory lock），本次跳过")
                if allocation_run_id:
                    await _mark_run_skipped(allocation_run_id, "已有计算进行中，本次跳过")
                return {"skipped": True, "reason": "calculation_in_progress"}
            return await _calculate_with_run(run_id, trigger_type, triggered_by, started)
        finally:
            await lock_conn.close()


async def _calculate_with_run(
    run_id: str,
    trigger_type: str,
    triggered_by: Optional[int],
    started: datetime,
) -> dict:
    async with AsyncSessionLocal() as db:
        run = await _get_or_create_run(db, run_id, trigger_type, triggered_by, started)
        try:
            ctx = await _load_context(db)
            source_as_of = await load_source_as_of(db, KITTING_RESULT_SYNC_TYPES)
            data_as_of = min_as_of(source_as_of)
            calculated_at = datetime.now()

            result_rows: dict[tuple, dict] = {}
            shortage_rows: dict[tuple, dict] = {}
            for demand in ctx["demands"]:
                row, shorts = _allocate_demand(ctx, demand, run_id, calculated_at, data_as_of)
                result_rows[(demand["order_no"], demand["line_no"])] = row
                for s in shorts:
                    shortage_rows[(demand["order_no"], demand["line_no"], s["material_code"])] = s

            await _upsert_results(db, result_rows, calculated_at)
            await _upsert_shortages(db, shortage_rows, calculated_at)

            counts = Counter(r["kit_status"] for r in result_rows.values())
            run.status = "success"
            run.demand_count = len(result_rows)
            run.full_count = counts.get("FULL", 0)
            run.partial_count = counts.get("PARTIAL", 0)
            run.shortage_count = counts.get("SHORTAGE", 0)
            run.pending_count = counts.get("PENDING", 0)
            run.blocked_count = counts.get("BLOCKED", 0)
            run.data_as_of = data_as_of
            run.source_as_of = {k: (v.isoformat() if v else None) for k, v in source_as_of.items()}
            run.finished_at = datetime.now()
            run.duration_ms = int((run.finished_at - started).total_seconds() * 1000)
            await db.commit()
            logger.info(
                f"[齐套计算] 完成 run={run_id} 需求={run.demand_count} "
                f"FULL={run.full_count} PARTIAL={run.partial_count} "
                f"SHORTAGE={run.shortage_count} PENDING={run.pending_count} "
                f"BLOCKED={run.blocked_count}"
            )
            return {
                "skipped": False,
                "run_id": run_id,
                "status": "success",
                "demand_count": run.demand_count,
                "full_count": run.full_count,
                "partial_count": run.partial_count,
                "shortage_count": run.shortage_count,
                "pending_count": run.pending_count,
                "blocked_count": run.blocked_count,
                "data_as_of": data_as_of.isoformat() if data_as_of else None,
            }
        except Exception as exc:
            await db.rollback()
            run = await _get_or_create_run(db, run_id, trigger_type, triggered_by, started)
            run.status = "failed"
            run.error_message = str(exc)[:2000]
            run.finished_at = datetime.now()
            run.duration_ms = int((run.finished_at - started).total_seconds() * 1000)
            await db.commit()
            logger.exception(f"[齐套计算] 失败 run={run_id}")
            raise
