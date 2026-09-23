"""物料占用分析 — 按合同交期升序串行占用库存（BOM 展开口径，实时计算不落库）"""

from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.basicdata.bom import Bom
from app.models.basicdata.bom_detail import BomDetail
from app.models.basicdata.inventory import Inventory
from app.models.basicdata.material import Material
from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.schemas.material.occupancy import (
    MaterialOccupancyResponse,
    MaterialSearchItem,
    OccupancyMaterialRow,
    OccupancyOrderRow,
    OrderLineOccupancy,
    OrderOccupancyResponse,
)

STATUS_MET = "met"
STATUS_PARTIAL = "partial"
STATUS_SHORTAGE = "shortage"


def _status_of(demand: Decimal, allocated: Decimal) -> str:
    if demand <= 0 or allocated >= demand:
        return STATUS_MET
    if allocated <= 0:
        return STATUS_SHORTAGE
    return STATUS_PARTIAL


def _merge_unit(
    target: dict[int, list],
    material_id: int,
    qty: Decimal,
    level: int,
    scrap_rate: Optional[Decimal],
) -> None:
    cur = target.get(material_id)
    if cur is None:
        target[material_id] = [qty, level, scrap_rate]
        return
    cur[0] = cur[0] + qty
    if level < cur[1]:
        cur[1] = level
        cur[2] = scrap_rate


def _expand_bom(
    ctx: dict,
    bom_id: str,
    visited: Optional[set[str]] = None,
) -> dict[int, list]:
    """展开一棵 BOM 树，返回 {material_id: [累计单耗, 最浅层级, 该层级损耗率]}。

    双重防环：memo 命中直接复用；递归过程中对直接父链 visited 做去重，
    防止多步环 (A→B→A) 重复累加。
    """
    if visited is None:
        visited = set()
    memo: dict[str, dict[int, list]] = ctx["unit_qty_memo"]
    if bom_id in memo:
        return memo[bom_id]
    if bom_id in visited:
        return {}
    visited.add(bom_id)
    result: dict[int, list] = {}
    for material_id, standard_qty, scrap_rate in ctx["details_by_bom"].get(bom_id, []):
        _merge_unit(result, material_id, standard_qty, 1, scrap_rate)
        child_bom_id = ctx["child_bom_by_material"].get(material_id)
        if child_bom_id and child_bom_id not in visited:
            for sub_id, sub in _expand_bom(ctx, child_bom_id, visited).items():
                _merge_unit(result, sub_id, standard_qty * sub[0], sub[1] + 1, sub[2])
    visited.discard(bom_id)
    memo[bom_id] = result
    return result


async def _build_context(db: AsyncSession) -> dict:
    """加载全部开放订单产品行 + BOM 图，产出按交期排好序的参与行。

    行级口径：以 sale_order_line 明细行为准（line_no = ERP 行号，BOM 挂在该行），
    join sale_order 头表取 is_closed / is_deleted / customer。
    open_qty 直接取明细行 order_qty（明细行无完工字段，不做已完工扣减）。
    """
    line_rows = (
        await db.execute(
            select(
                SaleOrderLine.order_no,
                SaleOrderLine.line_no,
                SaleOrderLine.product_code,
                SaleOrderLine.product_name,
                SaleOrderLine.promised_date,
                SaleOrderLine.order_qty,
                SaleOrderLine.bom_id,
                SaleOrder.customer,
            )
            .join(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)
            .where(
                SaleOrder.is_closed == 0,
                SaleOrder.is_deleted == 0,
                SaleOrderLine.status != "closed",
            )
        )
    ).all()

    bom_rows = (await db.execute(select(Bom.bom_id, Bom.material_id))).all()
    detail_rows = (
        await db.execute(
            select(
                BomDetail.bom_id,
                BomDetail.material_id,
                BomDetail.standard_qty,
                BomDetail.scrap_rate,
            )
        )
    ).all()

    ctx: dict = {
        "line_rows": [],
        "skipped_lines": 0,
        "details_by_bom": {},
        "child_bom_by_material": {},
        "unit_qty_memo": {},
    }
    for bom_id, material_id in bom_rows:
        if bom_id and material_id is not None:
            ctx["child_bom_by_material"][material_id] = bom_id
    for d in detail_rows:
        if d.bom_id and d.material_id is not None and d.standard_qty is not None:
            ctx["details_by_bom"].setdefault(d.bom_id, []).append(
                (d.material_id, d.standard_qty, d.scrap_rate)
            )

    for ln in line_rows:
        if not ln.order_no or not ln.line_no:
            continue
        open_qty = ln.order_qty or Decimal("0")
        if open_qty <= 0:
            ctx["skipped_lines"] += 1
            continue
        bom_id = str(ln.bom_id) if ln.bom_id is not None else None
        unit_map = _expand_bom(ctx, bom_id) if bom_id else {}
        if not unit_map:
            ctx["skipped_lines"] += 1
            continue
        ctx["line_rows"].append(
            {
                "order_no": ln.order_no,
                "line_no": ln.line_no,
                "customer": ln.customer,
                "product_code": ln.product_code,
                "product_name": ln.product_name,
                "promised_date": ln.promised_date,
                "order_qty": open_qty,
                "completed_qty": Decimal("0"),
                "open_qty": open_qty,
                "bom_id": bom_id,
                "unit_map": unit_map,
            }
        )

    ctx["line_rows"].sort(
        key=lambda r: (
            r["promised_date"] is None,
            r["promised_date"] or date.max,
            r["order_no"],
            r["line_no"],
        )
    )
    return ctx


async def _load_materials_by_ids(db: AsyncSession, material_ids: set[int]) -> dict[int, Material]:
    if not material_ids:
        return {}
    rows = (
        await db.execute(select(Material).where(Material.erp_material_id.in_(material_ids)))
    ).scalars().all()
    return {m.erp_material_id: m for m in rows}


async def _stock_and_transit(db: AsyncSession, material_codes: list[str]) -> dict[str, tuple[Decimal, Decimal]]:
    if not material_codes:
        return {}
    result = await db.execute(
        select(
            Inventory.material_code,
            func.sum(Inventory.balance_qty).label("balance"),
            func.sum(Inventory.qty_in_transit).label("transit"),
        )
        .where(Inventory.material_code.in_(material_codes))
        .group_by(Inventory.material_code)
    )
    out: dict[str, tuple[Decimal, Decimal]] = {}
    for row in result:
        if row.material_code:
            out[row.material_code] = (
                Decimal(str(row.balance or 0)),
                Decimal(str(row.transit or 0)),
            )
    return out


async def get_occupancy_by_material(
    db: AsyncSession, material_code: str
) -> Optional[MaterialOccupancyResponse]:
    material = (
        await db.execute(select(Material).where(Material.material_code == material_code))
    ).scalars().first()
    if material is None:
        return None

    ctx = await _build_context(db)
    target_id = material.erp_material_id

    stock_map = await _stock_and_transit(db, [material.material_code])
    stock_qty, transit_qty = stock_map.get(material.material_code, (Decimal("0"), Decimal("0")))

    rows: list[OccupancyOrderRow] = []
    remaining = stock_qty
    total_demand = Decimal("0")
    total_allocated = Decimal("0")
    for lr in ctx["line_rows"]:
        unit = lr["unit_map"].get(target_id)
        if unit is None:
            continue
        unit_qty, _level, scrap_rate = unit
        demand = unit_qty * lr["open_qty"]
        available = remaining
        allocated = demand if demand < available else available
        shortage = demand - allocated if demand > allocated else Decimal("0")
        rows.append(
            OccupancyOrderRow(
                order_no=lr["order_no"],
                line_no=lr["line_no"],
                customer=lr["customer"],
                product_code=lr["product_code"],
                product_name=lr["product_name"],
                promised_date=lr["promised_date"],
                order_qty=lr["order_qty"],
                completed_qty=lr["completed_qty"],
                open_qty=lr["open_qty"],
                unit_qty=unit_qty,
                scrap_rate=scrap_rate,
                demand_qty=demand,
                available_qty=available,
                allocated_qty=allocated,
                shortage_qty=shortage,
                status=_status_of(demand, allocated),
            )
        )
        remaining -= allocated
        total_demand += demand
        total_allocated += allocated

    return MaterialOccupancyResponse(
        material_code=material.material_code,
        material_name=material.material_name,
        spec_model=material.spec_model,
        unit_of_measure=material.unit_of_measure,
        material_property=material.material_property,
        stock_qty=stock_qty,
        transit_qty=transit_qty,
        order_count=len(rows),
        total_demand_qty=total_demand,
        total_allocated_qty=total_allocated,
        total_shortage_qty=total_demand - total_allocated,
        rows=rows,
        skipped_lines=ctx["skipped_lines"],
    )


async def get_occupancy_by_order(
    db: AsyncSession, order_no: str
) -> Optional[OrderOccupancyResponse]:
    ctx = await _build_context(db)
    target_rows = [r for r in ctx["line_rows"] if r["order_no"] == order_no]

    header_exists = (
        await db.execute(
            select(func.count()).select_from(SaleOrder).where(
                SaleOrder.order_no == order_no,
                SaleOrder.is_closed == 0,
                SaleOrder.is_deleted == 0,
            )
        )
    ).scalar() or 0
    if not target_rows and header_exists == 0:
        return None

    open_line_count = (
        await db.execute(
            select(func.count())
            .select_from(SaleOrderLine)
            .join(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)
            .where(
                SaleOrderLine.order_no == order_no,
                SaleOrder.is_closed == 0,
                SaleOrder.is_deleted == 0,
                SaleOrderLine.status != "closed",
            )
        )
    ).scalar() or 0

    material_ids: set[int] = set()
    for tr in target_rows:
        material_ids.update(tr["unit_map"].keys())
    masters = await _load_materials_by_ids(db, material_ids)
    material_ids = {mid for mid in material_ids if mid in masters}
    codes = [masters[mid].material_code for mid in material_ids if masters[mid].material_code]
    stock_map = await _stock_and_transit(db, codes)

    material_line_results: dict[int, dict[tuple[str, str], dict]] = {}
    for mid in material_ids:
        code = masters[mid].material_code
        remaining = stock_map.get(code, (Decimal("0"), Decimal("0")))[0]
        results: dict[tuple[str, str], dict] = {}
        for lr in ctx["line_rows"]:
            unit = lr["unit_map"].get(mid)
            if unit is None:
                continue
            demand = unit[0] * lr["open_qty"]
            available = remaining
            allocated = demand if demand < available else available
            shortage = demand - allocated if demand > allocated else Decimal("0")
            results[(lr["order_no"], lr["line_no"])] = {
                "demand": demand,
                "available": available,
                "allocated": allocated,
                "shortage": shortage,
            }
            remaining -= allocated
        material_line_results[mid] = results

    lines_out: list[OrderLineOccupancy] = []
    shortage_materials: set[int] = set()
    for tr in target_rows:
        rows_out: list[OccupancyMaterialRow] = []
        ordered_mids = sorted(
            tr["unit_map"].items(), key=lambda kv: (kv[1][1], masters[kv[0]].material_code or "")
        )
        for mid, unit in ordered_mids:
            if mid not in material_ids:
                continue
            master = masters[mid]
            code = master.material_code
            stock_qty = stock_map.get(code, (Decimal("0"), Decimal("0")))[0]
            res = material_line_results[mid][(tr["order_no"], tr["line_no"])]
            if res["shortage"] > 0:
                shortage_materials.add(mid)
            rows_out.append(
                OccupancyMaterialRow(
                    level=unit[1],
                    material_id=mid,
                    material_code=code,
                    material_name=master.material_name,
                    spec_model=master.spec_model,
                    unit_of_measure=master.unit_of_measure,
                    scrap_rate=unit[2],
                    unit_qty=unit[0],
                    demand_qty=res["demand"],
                    stock_qty=stock_qty,
                    prior_allocated_qty=stock_qty - res["available"],
                    available_qty=res["available"],
                    allocated_qty=res["allocated"],
                    shortage_qty=res["shortage"],
                    status=_status_of(res["demand"], res["allocated"]),
                )
            )
        lines_out.append(
            OrderLineOccupancy(
                line_no=tr["line_no"],
                product_code=tr["product_code"],
                product_name=tr["product_name"],
                promised_date=tr["promised_date"],
                order_qty=tr["order_qty"],
                completed_qty=tr["completed_qty"],
                open_qty=tr["open_qty"],
                bom_id=tr["bom_id"],
                rows=rows_out,
            )
        )

    return OrderOccupancyResponse(
        order_no=order_no,
        customer=target_rows[0]["customer"] if target_rows else None,
        skipped_lines=open_line_count - len(target_rows),
        shortage_material_count=len(shortage_materials),
        lines=lines_out,
    )


async def search_materials(
    db: AsyncSession, keyword: Optional[str], limit: int = 20
) -> list[MaterialSearchItem]:
    q = select(Material).where(Material.is_deleted == 0)
    kw = (keyword or "").strip()
    if kw:
        like = f"%{kw}%"
        q = q.where(or_(Material.material_code.ilike(like), Material.material_name.ilike(like)))
    q = q.order_by(Material.material_code).limit(limit)
    rows = (await db.execute(q)).scalars().all()
    return [
        MaterialSearchItem(
            material_code=m.material_code,
            material_name=m.material_name,
            spec_model=m.spec_model,
            unit_of_measure=m.unit_of_measure,
        )
        for m in rows
        if m.material_code
    ]


async def search_open_orders(db: AsyncSession, keyword: Optional[str], limit: int = 20) -> list[str]:
    q = (
        select(SaleOrder.order_no)
        .where(SaleOrder.is_closed == 0, SaleOrder.is_deleted == 0)
        .distinct()
    )
    kw = (keyword or "").strip()
    if kw:
        q = q.where(SaleOrder.order_no.ilike(f"%{kw}%"))
    q = q.order_by(SaleOrder.order_no).limit(limit)
    rows = (await db.execute(q)).all()
    return [r.order_no for r in rows if r.order_no]
