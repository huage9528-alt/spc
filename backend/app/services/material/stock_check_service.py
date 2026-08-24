"""物料盘点 (scm_inventory_check) 业务服务"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Optional, List, Dict, Tuple

from sqlalchemy import select, func, desc, or_, and_, String as SAString, text, case
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.models.basicdata.inventory import Inventory
from app.models.basicdata.material import Material
from app.models.material.inventory_check import StockCheck, StockCheckItem
from app.models.order.sale_order import SaleOrder
from app.services.order.order_materials_service import get_order_product_materials, MATERIAL_PROPERTY_LABELS
from app.services.material.stock_check_broker import publish_event


class StockCheckPermissionError(Exception):
    """盘点单修改权限不足"""
    pass


class StockCheckConflictError(Exception):
    """乐观锁冲突。携带最新版本号与数据快照,供 API 层构造 409。"""
    def __init__(self, resource: str, server_version: int, server_snapshot: dict):
        self.resource = resource
        self.server_version = server_version
        self.server_snapshot = server_snapshot
        super().__init__(f"{resource} version conflict: server_version={server_version}")


def _current_user_id(user: Optional[dict]) -> Optional[int]:
    """从 current_user 取 user_id：PermissionChecker 返回的 JWT payload 用 'sub'，
    get_current_user 用 'user_id'。统一兼容。"""
    if not user:
        return None
    v = user.get("user_id")
    if v is None:
        v = user.get("sub")
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _user_can_edit(head: Optional[StockCheck], user: Optional[dict]) -> bool:
    """创建人 / 共同盘点人 / admin 可改

    旧盘点单(无 created_by_user_id 且无共同盘点人)回退到"有权限即可改"，保持向后兼容。
    """
    if head is None:
        return False
    if not user:
        return True  # 内部调用无 user 上下文，放行（兼容）
    if user.get("role") == "admin":
        return True
    has_owner = head.created_by_user_id is not None or bool(head.co_checker_user_ids)
    if not has_owner:
        return True
    uid = _current_user_id(user)
    if uid is None:
        return False
    if head.created_by_user_id is not None and int(head.created_by_user_id) == uid:
        return True
    co = head.co_checker_user_ids or []
    if any(x is not None and int(x) == uid for x in co):
        return True
    return False


async def _assert_can_edit(db: AsyncSession, check_id: int, user: Optional[dict]) -> None:
    head = (await db.execute(select(StockCheck).where(StockCheck.id == check_id))).scalar_one_or_none()
    if head is None:
        raise ValueError(f"盘点单 {check_id} 不存在")
    if not _user_can_edit(head, user):
        raise StockCheckPermissionError("无修改权限：仅创建人、共同盘点人或管理员可修改")


async def _resolve_user_names(db: AsyncSession, user_ids: List[int]) -> Dict[int, str]:
    """sys_user.id -> 展示名(优先 emp_name，其次 username)"""
    ids = [int(x) for x in (user_ids or []) if x is not None]
    if not ids:
        return {}
    from app.models.basicdata.user import SysUser
    from app.models.basicdata.employee import Employee
    res = await db.execute(
        select(SysUser.id, SysUser.username, Employee.emp_name)
        .outerjoin(Employee, Employee.emp_code == SysUser.emp_code)
        .where(SysUser.id.in_(ids))
    )
    return {int(r.id): (r.emp_name or r.username) for r in res.all()}


async def list_co_checker_candidates(db: AsyncSession) -> List[Dict]:
    """共同盘点人候选：全部在职系统用户（含员工姓名/组织/岗位），用于按组织架构选人。"""
    from app.models.basicdata.user import SysUser
    from app.models.basicdata.employee import Employee
    from app.models.basicdata.organization import Organization
    from app.models.basicdata.position import Position
    from sqlalchemy import cast, String as SAString
    res = await db.execute(
        select(
            SysUser.id, SysUser.username,
            Employee.emp_name, Organization.org_name, Position.position_name,
        )
        .outerjoin(Employee, Employee.emp_code == SysUser.emp_code)
        .outerjoin(Organization, cast(Employee.org_id, SAString) == Organization.oa_org_id)
        .outerjoin(Position, Employee.position_id == Position.id)
        .where(SysUser.is_active.is_(True))
        .order_by(Organization.org_name.nulls_last(), Employee.emp_code)
    )
    out: List[Dict] = []
    for r in res.all():
        out.append({
            "user_id": int(r.id),
            "name": r.emp_name or r.username,
            "org_name": r.org_name or "未分组",
            "position_name": r.position_name,
        })
    return out


def _gen_check_no(seq: int) -> str:
    return f"PD{datetime.now().strftime('%Y%m%d')}-{seq:03d}"


async def _get_stock_by_warehouse(
    db: AsyncSession,
    material_ids: List[int],
) -> Dict[Tuple[int, int], Tuple[str, Decimal, Optional[datetime]]]:
    """按 (material_id, wh_id) 分组聚合 scm_inventory.qty_on_hand。

    同仓多库位的 qty_on_hand 求和；返回 {(mid, wh_id): (wh_name, qty, updated_at)}。
    updated_at 取该组库存的最大更新时间(用于快照库存时间)。
    仅包含 scm_inventory 中存在记录的仓（含 qty=0 的仓）。
    """
    if not material_ids:
        return {}
    result = await db.execute(
        select(
            Inventory.material_id,
            Inventory.wh_id,
            func.max(Inventory.wh_name).label("wh_name"),
            func.coalesce(func.sum(Inventory.qty_on_hand), 0).label("wh_qty"),
            func.max(Inventory.updated_at).label("wh_updated"),
        )
        .where(Inventory.material_id.in_(material_ids))
        .group_by(Inventory.material_id, Inventory.wh_id)
    )
    out: Dict[Tuple[int, int], Tuple[str, Decimal, Optional[datetime]]] = {}
    for row in result.all():
        wh_name = (row.wh_name or "").strip() or f"WH#{row.wh_id}"
        out[(int(row.material_id), int(row.wh_id))] = (
            wh_name,
            Decimal(str(row.wh_qty or 0)),
            row.wh_updated,
        )
    return out


async def _get_stock_aggregated_by_material_id(
    db: AsyncSession,
    material_ids: List[int],
) -> Dict[int, Decimal]:
    """按 material_id 聚合 scm_inventory.qty_on_hand（跨仓求和）。

    用于 MaterialPickerModal 候选列表等需要单值的场景。
    """
    if not material_ids:
        return {}
    result = await db.execute(
        select(
            Inventory.material_id,
            func.coalesce(func.sum(Inventory.qty_on_hand), 0).label("total_qty"),
        )
        .where(Inventory.material_id.in_(material_ids))
        .group_by(Inventory.material_id)
    )
    return {row.material_id: Decimal(str(row.total_qty or 0)) for row in result}


def _split_stock_by_warehouse(
    stock_map: Dict[Tuple[int, int], Tuple[str, Decimal, Optional[datetime]]],
    material_ids: List[int],
) -> Dict[int, List[Tuple[int, str, Decimal, Optional[datetime]]]]:
    """将 _get_stock_by_warehouse 的结果按 material_id 分组成
    {material_id: [(wh_id, wh_name, qty, updated_at), ...]}。
    """
    grouped: Dict[int, List[Tuple[int, str, Decimal, Optional[datetime]]]] = {m: [] for m in material_ids}
    for (mid, wh_id), (wh_name, qty, t) in stock_map.items():
        if mid in grouped:
            grouped[mid].append((wh_id, wh_name, qty, t))
    for mid in grouped:
        grouped[mid].sort(key=lambda x: (x[1], x[0]))
    return grouped


async def _get_recent_checked_by_warehouse(
    db: AsyncSession,
    keys: List[Tuple[Optional[int], Optional[int]]],
) -> Dict[Tuple[Optional[int], Optional[int]], Dict]:
    """对每个 (material_id, wh_id)，查最近一条 actual_qty 非空且所在盘点单未取消的行。

    返回 {(mid, wh_id): {"actual_qty": Decimal, "check_no": str, "check_date": date}}。
    wh_id 为 None 时按 IS NULL 匹配（未入库合成行）。
    PostgreSQL 用 DISTINCT ON 一次取齐。
    """
    if not keys:
        return {}
    mids = [k[0] for k in keys]
    sql = text(
        """
        SELECT DISTINCT ON (ic.material_id, ic.wh_id)
               ic.material_id AS mid,
               ic.wh_id       AS whid,
               ic.actual_qty  AS actual_qty,
               h.check_no     AS check_no,
               h.check_date   AS check_date
        FROM scm_inventory_check_item ic
        JOIN scm_inventory_check h ON h.id = ic.check_id
        WHERE ic.material_id = ANY(:mids)
          AND ic.actual_qty IS NOT NULL
          AND h.status <> 'cancelled'
        ORDER BY ic.material_id, ic.wh_id, h.check_date DESC, h.created_at DESC
        """
    )
    rows = (await db.execute(sql, {"mids": mids})).all()
    out: Dict[Tuple[Optional[int], Optional[int]], Dict] = {}
    for r in rows:
        mid = int(r.mid) if r.mid is not None else None
        whid = int(r.whid) if r.whid is not None else None
        out[(mid, whid)] = {
            "actual_qty": Decimal(str(r.actual_qty)),
            "check_no": r.check_no,
            "check_date": r.check_date,
        }
    return out


async def enrich_items_assoc(db: AsyncSession, items: List[StockCheckItem]) -> None:
    mids = [int(it.material_id) for it in items if it.material_id is not None]
    if not mids:
        for it in items:
            it.material_property_label = None
            it.material_type = None
            it.warehouses = None
        return
    mat_res = await db.execute(
        select(
            Material.erp_material_id,
            Material.material_property,
            Material.material_type,
        ).where(Material.erp_material_id.in_(mids))
    )
    prop_map: Dict[int, Optional[int]] = {}
    type_map: Dict[int, Optional[str]] = {}
    for r in mat_res.all():
        prop_map[int(r.erp_material_id)] = r.material_property
        type_map[int(r.erp_material_id)] = r.material_type
    for it in items:
        mid = int(it.material_id) if it.material_id is not None else None
        mp = prop_map.get(mid) if mid is not None else None
        it.material_property_label = MATERIAL_PROPERTY_LABELS.get(mp, str(mp)) if mp is not None else None
        it.material_type = type_map.get(mid) if mid is not None else None
        it.warehouses = None


async def enrich_live_qty(db: AsyncSession, items: List[StockCheckItem]) -> None:
    """为每条明细注入实时库存 live_qty(读时计算,不落库)。

    优先按与快照相同的 (material_id, wh_id) 查询 scm_inventory.qty_on_hand;
    老盘点单明细无 wh_id 时,回退到按物料跨仓聚合,保证兼容。
    wh_id=NULL 的"(未入库)"合成行,若物料现在已有库存记录,
    额外注入 live_wh_names(实时仓库名,顿号分隔),供前端展示真实仓库。
    未盘点行(actual_qty IS NULL)的快照库存 system_qty 读时覆盖为实时值
    (set_committed_value 不落库),并标记 snapshot_live=True;
    录入盘点数时由 update_stock_check_item 冻结快照写库。
    """
    mids = [int(it.material_id) for it in items if it.material_id is not None]
    stock_map = await _get_stock_by_warehouse(db, mids) if mids else {}
    none_wh_mids = list({
        int(it.material_id) for it in items
        if it.material_id is not None and it.wh_id is None
    })
    agg_map = (
        await _get_stock_aggregated_by_material_id(db, none_wh_mids) if none_wh_mids else {}
    )
    live_wh_map = _split_stock_by_warehouse(stock_map, none_wh_mids) if none_wh_mids else {}
    for it in items:
        mid = int(it.material_id) if it.material_id is not None else None
        wh_id = int(it.wh_id) if it.wh_id is not None else None
        it.live_wh_names = None
        if mid is None:
            it.live_qty = Decimal("0")
        elif wh_id is not None:
            entry = stock_map.get((mid, wh_id))
            it.live_qty = entry[1] if entry else Decimal("0")
        else:
            it.live_qty = agg_map.get(mid, Decimal("0"))
            whs = live_wh_map.get(mid) or []
            if whs:
                it.live_wh_names = "、".join(w[1] for w in whs)
        # 未盘点行: 快照库存跟随实时值(读时覆盖,不落库)
        if it.actual_qty is None and it.material_id is not None:
            set_committed_value(it, "system_qty", it.live_qty)
            it.snapshot_live = True
        else:
            it.snapshot_live = False
        # 仓库展示名: 含实时仓库名,供前端筛选/排序/展示(不落库)
        it.warehouse_display = it.live_wh_names or it.wh_name or "(未入库)"


async def _freeze_snapshot_for_count(
    db: AsyncSession,
    item: StockCheckItem,
    live_cache: Optional[Dict[Tuple[int, Optional[int]], Tuple[Decimal, Optional[datetime]]]] = None,
) -> None:
    """录入盘点数时冻结快照库存:把当前实时库存写入 system_qty/system_qty_time。

    与 enrich_live_qty 同口径: 有 wh_id 按 (物料,仓库),无 wh_id(未入库合成行)
    按物料跨仓聚合(时间取冻结时点)。
    """
    mid = int(item.material_id) if item.material_id is not None else None
    if mid is None:
        item.system_qty = Decimal("0")
        item.system_qty_time = None
        return
    wh_id = int(item.wh_id) if item.wh_id is not None else None
    key = (mid, wh_id)
    if live_cache is not None and key in live_cache:
        q, t = live_cache[key]
    elif wh_id is not None:
        entry = (await _get_stock_by_warehouse(db, [mid])).get((mid, wh_id))
        q, t = (entry[1], entry[2]) if entry else (Decimal("0"), None)
    else:
        q = (await _get_stock_aggregated_by_material_id(db, [mid])).get(mid, Decimal("0"))
        t = datetime.now()
    item.system_qty = q
    item.system_qty_time = t


async def _build_live_freeze_cache(
    db: AsyncSession,
    item_ids: List[int],
) -> Dict[Tuple[int, Optional[int]], Tuple[Decimal, Optional[datetime]]]:
    """批量更新前一次性预取待冻结行的实时库存,避免逐行查询。

    只对 actual_qty IS NULL(将首次录入盘点数)的行建缓存。
    """
    if not item_ids:
        return {}
    rows = (await db.execute(
        select(StockCheckItem.material_id, StockCheckItem.wh_id).where(
            StockCheckItem.id.in_(item_ids),
            StockCheckItem.actual_qty.is_(None),
        )
    )).all()
    keys = {
        (int(r[0]), int(r[1]) if r[1] is not None else None)
        for r in rows if r[0] is not None
    }
    if not keys:
        return {}
    wh_mids = [mid for (mid, wh) in keys if wh is not None]
    agg_mids = [mid for (mid, wh) in keys if wh is None]
    stock_map = await _get_stock_by_warehouse(db, wh_mids) if wh_mids else {}
    agg_map = (
        await _get_stock_aggregated_by_material_id(db, agg_mids) if agg_mids else {}
    )
    cache: Dict[Tuple[int, Optional[int]], Tuple[Decimal, Optional[datetime]]] = {}
    for k in keys:
        mid, wh = k
        if wh is not None:
            e = stock_map.get(k)
            cache[k] = (e[1], e[2]) if e else (Decimal("0"), None)
        else:
            cache[k] = (agg_map.get(mid, Decimal("0")), datetime.now())
    return cache


def _serialize_item(item: StockCheckItem) -> dict:
    """序列化 item 行用于事件 payload(不含关联字段,客户端按 id 合并)。"""
    from app.schemas.material.stock_check import StockCheckItemOut
    return StockCheckItemOut.model_validate(item).model_dump()


async def _refresh_check_aggregates(db: AsyncSession, check_id: int) -> None:
    """刷新头表 total_materials / checked_materials / total_diff_qty

    checked 口径: is_checked=1(已录数/已签收) 或 带近期已盘标记(recent_checked_check_no 非空,
    免盘行,不记录盘点数据但视为无需再盘)。
    """
    items_agg = await db.execute(
        select(
            func.count(StockCheckItem.id).label("total"),
            func.coalesce(func.sum(case(
                (or_(
                    StockCheckItem.is_checked == 1,
                    StockCheckItem.recent_checked_check_no.isnot(None),
                ), 1),
                else_=0,
            )), 0).label("checked"),
            func.coalesce(func.sum(StockCheckItem.diff_qty), 0).label("diff"),
        ).where(StockCheckItem.check_id == check_id)
    )
    row = items_agg.one()
    head = await db.execute(select(StockCheck).where(StockCheck.id == check_id))
    head_obj: Optional[StockCheck] = head.scalar_one_or_none()
    if head_obj:
        head_obj.total_materials = int(row.total or 0)
        head_obj.checked_materials = int(row.checked or 0)
        head_obj.total_diff_qty = Decimal(str(row.diff or 0))


async def _next_seq_for_today(db: AsyncSession) -> int:
    today_prefix = f"PD{datetime.now().strftime('%Y%m%d')}-"
    res = await db.execute(
        select(StockCheck.check_no).where(StockCheck.check_no.like(f"{today_prefix}%"))
    )
    existing = [r[0] for r in res.all()]
    max_seq = 0
    for no in existing:
        try:
            seq = int(no.split("-")[-1])
            if seq > max_seq:
                max_seq = seq
        except (ValueError, IndexError):
            pass
    return max_seq + 1


async def create_stock_check_from_order(
    db: AsyncSession,
    order_no: str,
    current_user: dict,
    *,
    title: Optional[str] = None,
    check_date: Optional[date] = None,
    remark: Optional[str] = None,
    selected_products: Optional[List[Dict[str, Optional[str]]]] = None,
    co_checker_user_ids: Optional[List[int]] = None,
) -> StockCheck:
    """从订单创建盘点单: BOM 多层展开 + 每节点一行 + 写头/行

    selected_products: 每项 {"product_code": str|None, "bom_no": str|None};
        None 表示全部产品行;非空则只展开匹配的产品行。
    co_checker_user_ids: 共同盘点人(sys_user.id)列表，可与创建人共同修改盘点单。
    """
    order = (await db.execute(select(SaleOrder.id).where(SaleOrder.order_no == order_no))).scalar_one_or_none()
    if not order:
        raise ValueError(f"订单 {order_no} 不存在")

    line_materials = await get_order_product_materials(db, order_no=order_no)
    if selected_products:
        sel = {(s.get("product_code"), s.get("bom_no")) for s in selected_products}
        line_materials = [
            lm for lm in line_materials
            if (lm.product_code, lm.bom_no) in sel
        ]
        if not line_materials:
            raise ValueError("所选产品未匹配到任何产品行,无法创建盘点单")
    # 递归展开整棵 BOM，收集所有带 material_id 的节点(含父件/子件各层级)。
    # 每个 BOM 节点写一行盘点明细(不再按 material_id 聚合)，level 标识层级。
    def _walk(nodes, level):
        for n in (nodes or []):
            yield n, level
            yield from _walk(getattr(n, "children", None) or [], level + 1)

    nodes: List = []  # (line_materials_row, bom_node, level)
    for lm in line_materials:
        for n, lvl in _walk(lm.materials or [], 1):
            if n.material_id:
                nodes.append((lm, n, lvl))

    if not nodes:
        raise ValueError(f"订单 {order_no} 未展开出任何物料,无法创建盘点单")

    unique_mids: List[int] = []
    seen: set = set()
    for _, n, _ in nodes:
        mid = int(n.material_id)
        if mid not in seen:
            seen.add(mid)
            unique_mids.append(mid)
    stock_map = await _get_stock_by_warehouse(db, unique_mids)
    warehouses_by_mid = _split_stock_by_warehouse(stock_map, unique_mids)

    # 记录本次盘点覆盖的产品行(用于"该订单哪些产品已盘点"的可追溯性)
    covered_products = [
        {
            "product_code": lm.product_code,
            "bom_no": lm.bom_no,
            "line_no": lm.line_no,
            "product_name": lm.product_name,
            "order_qty": lm.order_qty,
        }
        for lm in line_materials
    ]

    seq = await _next_seq_for_today(db)
    check_no = _gen_check_no(seq)

    head = StockCheck(
        check_no=check_no,
        order_no=order_no,
        title=title or f"{order_no} 盘点 {datetime.now().strftime('%Y-%m-%d')}",
        check_type="order",
        status="in_progress",
        check_date=check_date or date.today(),
        created_by=current_user.get("username", ""),
        created_by_user_id=_current_user_id(current_user),
        remark=remark,
        covered_products=covered_products,
        co_checker_user_ids=co_checker_user_ids,
    )
    db.add(head)
    await db.flush()

    # 1) 收敛：同一 (material_id, wh_id) 跨 BOM 节点/产品只取一行（取首次出现的物料信息）
    dedup_order: List[Tuple[Optional[int], Optional[int]]] = []
    dedup_row_meta: Dict[Tuple[int, Optional[int]], Dict] = {}
    for lm, n, lvl in nodes:
        mid = int(n.material_id)
        warehouses = warehouses_by_mid.get(mid, [])
        if warehouses:
            for wh_id, wh_name, sys_q, sys_t in warehouses:
                k = (mid, wh_id)
                if k in dedup_row_meta:
                    continue
                dedup_row_meta[k] = {
                    "material_code": n.material_code,
                    "material_name": n.material_name,
                    "spec_model": n.spec_model,
                    "unit": n.unit,
                    "system_qty": sys_q,
                    "system_qty_time": sys_t,
                    "wh_name": wh_name,
                }
                dedup_order.append(k)
        else:
            k = (mid, None)
            if k in dedup_row_meta:
                continue
            dedup_row_meta[k] = {
                "material_code": n.material_code,
                "material_name": n.material_name,
                "spec_model": n.spec_model,
                "unit": n.unit,
                "system_qty": Decimal("0"),
                "system_qty_time": None,
                "wh_name": "(未入库)",
            }
            dedup_order.append(k)

    # 2) 查近盘预填补
    from app.core.config import get_settings
    skip_days = int(get_settings().STOCK_CHECK_RECENT_SKIP_DAYS)
    recent_map = await _get_recent_checked_by_warehouse(db, dedup_order)
    today = date.today()

    # 3) 写行
    item_rows: List[StockCheckItem] = []
    for k in dedup_order:
        mid, wh_id = k
        meta = dedup_row_meta[k]
        recent = recent_map.get(k)
        prefill = (
            recent is not None
            and recent["check_date"] is not None
            and (today - recent["check_date"]).days <= skip_days
        )
        if prefill:
            # 近期已盘: 仅打标记,不预填任何盘点数据(实盘数/差异/已盘状态均不记录),
            # 避免旧实盘数与当前库存跨时间点错配产生假差异;需要重盘时走 force_recount。
            item_rows.append(StockCheckItem(
                check_id=head.id,
                line_no=None,
                level=None,
                material_id=mid,
                material_code=meta["material_code"],
                material_name=meta["material_name"],
                spec_model=meta["spec_model"],
                unit=meta["unit"],
                req_qty=Decimal("0"),
                system_qty=meta["system_qty"],
                system_qty_time=meta.get("system_qty_time"),
                wh_id=wh_id,
                wh_name=meta["wh_name"],
                actual_qty=None,
                diff_qty=Decimal("0"),
                is_checked=0,
                recent_checked_check_no=recent["check_no"],
                recent_checked_date=recent["check_date"],
            ))
        else:
            item_rows.append(StockCheckItem(
                check_id=head.id,
                line_no=None,
                level=None,
                material_id=mid,
                material_code=meta["material_code"],
                material_name=meta["material_name"],
                spec_model=meta["spec_model"],
                unit=meta["unit"],
                req_qty=Decimal("0"),
                system_qty=meta["system_qty"],
                system_qty_time=meta.get("system_qty_time"),
                wh_id=wh_id,
                wh_name=meta["wh_name"],
                actual_qty=None,
                diff_qty=Decimal("0"),
                is_checked=0,
            ))
    db.add_all(item_rows)
    await db.flush()

    await _refresh_check_aggregates(db, head.id)
    await db.flush()
    return head


async def create_stock_check_from_materials(
    db: AsyncSession,
    material_ids: Optional[List[int]] = None,
    items: Optional[List[Tuple[int, Optional[int]]]] = None,
    current_user: dict = None,
    *,
    title: Optional[str] = None,
    check_date: Optional[date] = None,
    remark: Optional[str] = None,
    co_checker_user_ids: Optional[List[int]] = None,
) -> StockCheck:
    """从选定的物料清单创建手动盘点单 (check_type='manual', order_no=NULL)。

    items: 按 (material_id, wh_id) 精确盘点, wh_id=None 表示未入库合成行;
    material_ids: 兼容旧方式, 整物料拆全仓库;
    两者可同时提供, 合并去重; 至少提供其一。
    """
    unique_ids, selections = await _resolve_material_selections(db, material_ids, items)

    seq = await _next_seq_for_today(db)
    check_no = _gen_check_no(seq)

    head = StockCheck(
        check_no=check_no,
        order_no=None,
        title=title or f"手动盘点 {datetime.now().strftime('%Y-%m-%d')}",
        check_type="manual",
        status="in_progress",
        check_date=check_date or date.today(),
        created_by=current_user.get("username", "") if current_user else "",
        created_by_user_id=_current_user_id(current_user) if current_user else None,
        remark=remark,
        co_checker_user_ids=co_checker_user_ids,
    )
    db.add(head)
    await db.flush()

    item_rows = await _build_manual_item_rows(db, head.id, selections, unique_ids)
    db.add_all(item_rows)
    await db.flush()

    await _refresh_check_aggregates(db, head.id)
    await db.flush()
    return head


async def _resolve_material_selections(
    db: AsyncSession,
    material_ids: Optional[List[int]] = None,
    items: Optional[List[Tuple[int, Optional[int]]]] = None,
) -> Tuple[List[int], List[Tuple[int, Optional[int]]]]:
    """解析并去重 (material_ids | items) 选料。返回 (unique_ids, selections)。"""
    unique_ids: List[int] = []
    seen_ids = set()
    for mid in material_ids or []:
        try:
            v = int(mid)
        except (TypeError, ValueError):
            continue
        if v > 0 and v not in seen_ids:
            seen_ids.add(v)
            unique_ids.append(v)

    selections: List[Tuple[int, Optional[int]]] = []
    seen_sel = set()
    for it in items or []:
        if isinstance(it, dict):
            mid, wh = it.get("material_id"), it.get("wh_id")
        elif isinstance(it, (tuple, list)) and len(it) >= 2:
            mid, wh = it[0], it[1]
        else:
            mid = getattr(it, "material_id", None)
            wh = getattr(it, "wh_id", None)
        try:
            mid = int(mid)
            if wh is not None:
                wh = int(wh)
        except (TypeError, ValueError):
            continue
        if mid <= 0:
            continue
        key = (mid, wh)
        if key not in seen_sel:
            seen_sel.add(key)
            selections.append(key)
        if mid not in seen_ids:
            seen_ids.add(mid)
            unique_ids.append(mid)

    if not unique_ids:
        raise ValueError("请至少选择一个物料")
    return unique_ids, selections


async def _build_manual_item_rows(
    db: AsyncSession,
    check_id: int,
    selections: List[Tuple[int, Optional[int]]],
    unique_ids: List[int],
) -> List[StockCheckItem]:
    """加载物料与库存快照,按 selections 构建 StockCheckItem 行。"""
    mat_res = await db.execute(
        select(Material).where(
            Material.erp_material_id.in_(unique_ids),
            Material.is_deleted == 0,
        )
    )
    materials = mat_res.scalars().all()
    if not materials:
        raise ValueError("所选物料均不存在或已删除,无法创建盘点单")
    mat_map = {m.erp_material_id: m for m in materials}

    stock_map = await _get_stock_by_warehouse(db, [m.erp_material_id for m in materials])
    warehouses_by_mid = _split_stock_by_warehouse(stock_map, [m.erp_material_id for m in materials])

    item_rows: List[StockCheckItem] = []
    if selections:
        # 严格按用户选中的 (物料, 仓库) 生成行
        for mid, wh_id in selections:
            m = mat_map.get(mid)
            if m is None:
                continue
            if wh_id is None:
                item_rows.append(StockCheckItem(
                    check_id=check_id,
                    line_no=None,
                    material_id=mid,
                    material_code=m.material_code,
                    material_name=m.material_name,
                    spec_model=m.spec_model,
                    unit=m.unit_of_measure,
                    req_qty=Decimal("0"),
                    system_qty=Decimal("0"),
                    wh_id=None,
                    wh_name="(未入库)",
                    actual_qty=None,
                    diff_qty=Decimal("0"),
                    is_checked=0,
                ))
                continue
            meta = stock_map.get((mid, wh_id))
            if meta is None:
                continue
            wh_name, sys_q, sys_t = meta
            item_rows.append(StockCheckItem(
                check_id=check_id,
                line_no=None,
                material_id=mid,
                material_code=m.material_code,
                material_name=m.material_name,
                spec_model=m.spec_model,
                unit=m.unit_of_measure,
                req_qty=Decimal("0"),
                system_qty=sys_q,
                system_qty_time=sys_t,
                wh_id=wh_id,
                wh_name=wh_name,
                actual_qty=None,
                diff_qty=Decimal("0"),
                is_checked=0,
            ))
    else:
        # 整物料拆全仓库
        for m in materials:
            mid = m.erp_material_id
            warehouses = warehouses_by_mid.get(mid, [])
            if warehouses:
                for wh_id, wh_name, sys_q, sys_t in warehouses:
                    item_rows.append(StockCheckItem(
                        check_id=check_id,
                        line_no=None,
                        material_id=mid,
                        material_code=m.material_code,
                        material_name=m.material_name,
                        spec_model=m.spec_model,
                        unit=m.unit_of_measure,
                        req_qty=Decimal("0"),
                        system_qty=sys_q,
                        system_qty_time=sys_t,
                        wh_id=wh_id,
                        wh_name=wh_name,
                        actual_qty=None,
                        diff_qty=Decimal("0"),
                        is_checked=0,
                    ))
            else:
                item_rows.append(StockCheckItem(
                    check_id=check_id,
                    line_no=None,
                    material_id=mid,
                    material_code=m.material_code,
                    material_name=m.material_name,
                    spec_model=m.spec_model,
                    unit=m.unit_of_measure,
                    req_qty=Decimal("0"),
                    system_qty=Decimal("0"),
                    wh_id=None,
                    wh_name="(未入库)",
                    actual_qty=None,
                    diff_qty=Decimal("0"),
                    is_checked=0,
                ))
    return item_rows


async def add_items_to_check(
    db: AsyncSession,
    check_id: int,
    material_ids: Optional[List[int]] = None,
    items: Optional[List[Tuple[int, Optional[int]]]] = None,
    current_user: dict = None,
) -> List[StockCheckItem]:
    """为进行中的手动盘点单追加物料明细。返回新增的行。"""
    head = (await db.execute(select(StockCheck).where(StockCheck.id == check_id).with_for_update())).scalar_one_or_none()
    if not head:
        raise ValueError(f"盘点单 {check_id} 不存在")
    if not _user_can_edit(head, current_user):
        raise StockCheckPermissionError("无修改权限：仅创建人、共同盘点人或管理员可修改")
    if head.check_type != "manual":
        raise ValueError("仅手动盘点单支持自由添加明细")
    if head.status in ("completed", "cancelled"):
        raise ValueError(f"已{head.status}的盘点单不能添加明细")
    unique_ids, selections = await _resolve_material_selections(db, material_ids, items)
    item_rows = await _build_manual_item_rows(db, check_id, selections, unique_ids)
    if not item_rows:
        raise ValueError("所选物料均无可用库存行,请重新选择")
    db.add_all(item_rows)
    await db.flush()
    await _refresh_check_aggregates(db, check_id)
    head.version = int(head.version or 0) + 1
    await db.flush()
    await publish_event(
        check_id,
        "bom_refreshed",
        {
            "check_id": check_id,
            "head_version": int(head.version or 0),
            "new_item_ids": [int(r.id) for r in item_rows],
        },
        _current_user_id(current_user),
    )
    return item_rows


async def remove_item_from_check(
    db: AsyncSession,
    item_id: int,
    current_user: dict,
) -> StockCheck:
    """从进行中的手动盘点单移除一条明细。已录入数据(is_checked=1 或 actual_qty 非空)的行禁删。"""
    item = (await db.execute(select(StockCheckItem).where(StockCheckItem.id == item_id).with_for_update())).scalar_one_or_none()
    if not item:
        raise ValueError(f"盘点行 {item_id} 不存在")
    head = (await db.execute(select(StockCheck).where(StockCheck.id == item.check_id).with_for_update())).scalar_one_or_none()
    if not head:
        raise ValueError(f"盘点单 {item.check_id} 不存在")
    if not _user_can_edit(head, current_user):
        raise StockCheckPermissionError("无修改权限：仅创建人、共同盘点人或管理员可修改")
    if head.check_type != "manual":
        raise ValueError("仅手动盘点单支持自由移除明细")
    if head.status in ("completed", "cancelled"):
        raise ValueError(f"已{head.status}的盘点单不能移除明细")
    if item.is_checked or item.actual_qty is not None:
        raise ValueError("该行已录入盘点数据,请先取消标记/清空实盘数再移除")
    await db.delete(item)
    await db.flush()
    await _refresh_check_aggregates(db, head.id)
    head.version = int(head.version or 0) + 1
    await db.flush()
    await publish_event(
        head.id,
        "bom_refreshed",
        {"check_id": head.id, "head_version": int(head.version or 0), "new_item_ids": []},
        _current_user_id(current_user),
    )
    return head


async def list_material_candidates(
    db: AsyncSession,
    page: int = 1,
    page_size: int = 20,
    keyword: Optional[str] = None,
    wh_id: Optional[str] = None,
) -> tuple[int, List[Dict]]:
    """手动盘点选物料的候选列表: 每个「物料 × 仓库」一行。

    来自 scm_material LEFT JOIN scm_inventory 按 (material_id, wh_id) 分组聚合;
    无库存记录物料的合成行为 wh_id=NULL / wh_name="(未入库)" / system_qty=0。
    wh_id 接受数字(精确 wh_id)或字符串(wh_name 模糊), 与 my-items 一致。
    """
    inv_subq = (
        select(
            Inventory.material_id.label("mid"),
            Inventory.wh_id.label("whid"),
            func.max(Inventory.wh_code).label("wh_code"),
            func.max(Inventory.wh_name).label("wh_name"),
            func.coalesce(func.sum(Inventory.qty_on_hand), 0).label("wh_qty"),
        )
        .group_by(Inventory.material_id, Inventory.wh_id)
        .subquery()
    )

    query = (
        select(
            Material.erp_material_id,
            Material.material_code,
            Material.material_name,
            Material.spec_model,
            Material.unit_of_measure,
            inv_subq.c.whid,
            inv_subq.c.wh_code,
            inv_subq.c.wh_name,
            inv_subq.c.wh_qty,
        )
        .outerjoin(inv_subq, inv_subq.c.mid == Material.erp_material_id)
        .where(Material.is_deleted == 0)
    )

    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(
            Material.material_code.ilike(like),
            Material.material_name.ilike(like),
            Material.spec_model.ilike(like),
        ))

    wh_cond = None
    if wh_id is not None and str(wh_id).strip():
        wh_raw = str(wh_id).strip()
        try:
            wh_int = int(wh_raw)
            wh_cond = inv_subq.c.whid == wh_int
        except (TypeError, ValueError):
            wh_cond = inv_subq.c.wh_name.ilike(f"%{wh_raw}%")
    if wh_cond is not None:
        query = query.where(wh_cond)

    total = (await db.execute(
        select(func.count()).select_from(query.subquery())
    )).scalar() or 0

    rows = (await db.execute(
        query
        .order_by(
            Material.material_code,
            inv_subq.c.wh_name.is_(None),
            inv_subq.c.wh_name,
            inv_subq.c.whid,
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    )).all()

    items: List[Dict] = []
    for r in rows:
        has_inv = r.whid is not None
        if has_inv:
            wh_name = (r.wh_name or "").strip() or f"WH#{r.whid}"
        else:
            wh_name = "(未入库)"
        items.append({
            "erp_material_id": int(r.erp_material_id),
            "material_code": r.material_code,
            "material_name": r.material_name,
            "spec_model": r.spec_model,
            "unit": r.unit_of_measure,
            "system_qty": Decimal(str(r.wh_qty or 0)) if has_inv else Decimal("0"),
            "wh_id": int(r.whid) if has_inv else None,
            "wh_code": r.wh_code if has_inv else None,
            "wh_name": wh_name,
            "recent_checked_check_no": None,
            "recent_checked_date": None,
        })

    # 标记近期已盘过的 (物料, 仓库): 复用仓库感知的最近盘点查询, 排除已取消单
    recent_map = await _get_recent_checked_by_warehouse(
        db, [(it["erp_material_id"], it["wh_id"]) for it in items]
    )
    for it in items:
        recent = recent_map.get((it["erp_material_id"], it["wh_id"]))
        if recent:
            it["recent_checked_check_no"] = recent["check_no"]
            it["recent_checked_date"] = recent["check_date"]

    return int(total), items


async def list_counted_warehouses(db: AsyncSession) -> List[Dict]:
    """已盘点物料台账中涉及的仓库列表（去重），供前端仓库筛选下拉使用。

    只统计 actual_qty 非空 且盘点单未取消 的盘点行；
    "(未入库)"行(wh_id=NULL)额外并入该物料当前在 scm_inventory 中的实时仓库
    (与台账页仓库列展示 live_wh_names 的口径一致,使筛选可选到如"包装仓库")。
    """
    snapshot_stmt = (
        select(StockCheckItem.wh_id, StockCheckItem.wh_name)
        .join(StockCheck, StockCheck.id == StockCheckItem.check_id)
        .where(StockCheckItem.actual_qty.is_not(None))
        .where(StockCheck.status != 'cancelled')
        .where(StockCheckItem.wh_id.is_not(None))
        .group_by(StockCheckItem.wh_id, StockCheckItem.wh_name)
    )
    live_stmt = (
        select(Inventory.wh_id, func.max(Inventory.wh_name).label("wh_name"))
        .select_from(StockCheckItem)
        .join(StockCheck, StockCheck.id == StockCheckItem.check_id)
        .join(Inventory, Inventory.material_id == StockCheckItem.material_id)
        .where(StockCheckItem.actual_qty.is_not(None))
        .where(StockCheck.status != 'cancelled')
        .where(StockCheckItem.wh_id.is_(None))
        .group_by(Inventory.wh_id)
    )
    merged: Dict[int, str] = {}
    for r in (await db.execute(snapshot_stmt)).all():
        merged[int(r[0])] = r[1] or ''
    for r in (await db.execute(live_stmt)).all():
        merged.setdefault(int(r[0]), (r[1] or '').strip() or f"WH#{int(r[0])}")
    return [
        {"wh_id": wid, "wh_name": name}
        for wid, name in sorted(merged.items(), key=lambda kv: kv[1])
    ]


async def list_counted_materials_ledger(
    db: AsyncSession,
    page: int = 1,
    page_size: int = 20,
    keyword: Optional[str] = None,
    wh_id: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    check_type: Optional[str] = None,
    status: Optional[List[str]] = None,
    check_no: Optional[str] = None,
    counted_by: Optional[str] = None,
    material_code: Optional[str] = None,
    material_name: Optional[str] = None,
    spec_model: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = None,
) -> Tuple[int, List[Dict]]:
    """已盘点物料台账: 每个「物料×仓库」取最近一条已盘点记录。

    只统计 actual_qty 非空 且盘点单未取消的盘点行;
    wh_id 接受数字(精确 wh_id)或字符串(wh_name 模糊); 筛选在 ROW_NUMBER 之前,
    即「筛选范围内每组最近一次已盘点记录」。
    sort_by/sort_order 走 CTE 别名的白名单; 默认 material_code / wh_name / material_id。
    返回 (total, [dict, ...])。
    """
    SORTABLE = {
        'material_code': 'material_code',
        'material_name': 'material_name',
        'spec_model': 'spec_model',
        'unit': 'unit',
        'wh_name': 'wh_name',
        'system_qty': 'system_qty',
        'actual_qty': 'actual_qty',
        'diff_qty': 'diff_qty',
        'check_no': 'check_no',
        'check_date': 'check_date',
        'counted_by': 'counted_by',
        'counted_at': 'counted_at',
        'status': 'status',
    }
    conds = ["ic.actual_qty IS NOT NULL", "h.status <> 'cancelled'"]
    params: Dict[str, object] = {}
    if keyword:
        params["kw"] = f"%{keyword}%"
        conds.append("(ic.material_code ILIKE :kw OR ic.material_name ILIKE :kw OR ic.spec_model ILIKE :kw)")
    if wh_id is not None and str(wh_id).strip():
        wh_raw = str(wh_id).strip()
        try:
            params["wh_int"] = int(wh_raw)
            # 未入库行(wh_id=NULL)按物料实时库存所在仓匹配,与仓库列 live_wh_names 口径一致
            conds.append(
                "(ic.wh_id = :wh_int OR (ic.wh_id IS NULL AND EXISTS ("
                "SELECT 1 FROM scm_inventory inv "
                "WHERE inv.material_id = ic.material_id AND inv.wh_id = :wh_int)))"
            )
        except (TypeError, ValueError):
            params["wh_name_like"] = f"%{wh_raw}%"
            conds.append(
                "(ic.wh_name ILIKE :wh_name_like OR (ic.wh_id IS NULL AND EXISTS ("
                "SELECT 1 FROM scm_inventory inv "
                "WHERE inv.wh_name ILIKE :wh_name_like AND inv.material_id = ic.material_id)))"
            )
    if date_from:
        params["date_from"] = date_from
        conds.append("h.check_date >= :date_from")
    if date_to:
        params["date_to"] = date_to
        conds.append("h.check_date <= :date_to")
    if check_type:
        params["check_type"] = check_type
        conds.append("h.check_type = :check_type")
    if check_no:
        params["check_no_like"] = f"%{check_no}%"
        conds.append("h.check_no ILIKE :check_no_like")
    if counted_by:
        params["counted_by_like"] = f"%{counted_by}%"
        conds.append("ic.counted_by ILIKE :counted_by_like")
    if material_code:
        params["mc_like"] = f"%{material_code}%"
        conds.append("ic.material_code ILIKE :mc_like")
    if material_name:
        params["mn_like"] = f"%{material_name}%"
        conds.append("ic.material_name ILIKE :mn_like")
    if spec_model:
        params["sm_like"] = f"%{spec_model}%"
        conds.append("ic.spec_model ILIKE :sm_like")
    if status:
        statuses = [s.strip() for s in status if s and s.strip()]
        if statuses:
            placeholders = ", ".join(f":st{i}" for i in range(len(statuses)))
            for i, s in enumerate(statuses):
                params[f"st{i}"] = s
            conds.append(f"h.status IN ({placeholders})")

    where_sql = "\n".join(f"    AND {c}" for c in conds)
    cte = f"""
WITH ranked AS (
    SELECT
        h.id                   AS check_id,
        h.check_no             AS check_no,
        h.check_date           AS check_date,
        h.check_type           AS check_type,
        h.status               AS status,
        ic.material_id         AS material_id,
        ic.material_code       AS material_code,
        ic.material_name       AS material_name,
        ic.spec_model          AS spec_model,
        ic.unit                AS unit,
        ic.wh_id               AS wh_id,
        ic.wh_code             AS wh_code,
        ic.wh_name             AS wh_name,
        ic.system_qty          AS system_qty,
        ic.system_qty_time     AS system_qty_time,
        ic.actual_qty          AS actual_qty,
        ic.diff_qty            AS diff_qty,
        ic.counted_by          AS counted_by,
        ic.counted_at          AS counted_at,
        ic.checked_at          AS checked_at,
        ROW_NUMBER() OVER (
            PARTITION BY ic.material_id, ic.wh_id
            ORDER BY h.check_date DESC, h.created_at DESC, ic.id DESC
        ) AS rn
    FROM scm_inventory_check_item ic
    JOIN scm_inventory_check h ON h.id = ic.check_id
    WHERE ic.actual_qty IS NOT NULL
      AND h.status <> 'cancelled'
{where_sql}
)
"""
    total = (await db.execute(
        text(f"{cte} SELECT count(*) AS c FROM ranked WHERE rn = 1"), params
    )).scalar() or 0

    if sort_by and sort_by in SORTABLE:
        col = SORTABLE[sort_by]
        direction = "DESC" if sort_order == "desc" else "ASC"
        order_sql = f"{col} {direction}, material_id ASC"
    else:
        order_sql = "material_code ASC, wh_name ASC, material_id ASC"

    rows = (await db.execute(
        text(f"{cte} SELECT * FROM ranked WHERE rn = 1 ORDER BY {order_sql} OFFSET :off LIMIT :lim"),
        {**params, "off": (page - 1) * page_size, "lim": page_size},
    )).all()

    items: List[Dict] = []
    for r in rows:
        items.append({
            "check_id": r.check_id,
            "check_no": r.check_no,
            "check_date": r.check_date,
            "check_type": r.check_type,
            "status": r.status,
            "material_id": r.material_id,
            "material_code": r.material_code,
            "material_name": r.material_name,
            "spec_model": r.spec_model,
            "unit": r.unit,
            "wh_id": r.wh_id,
            "wh_code": r.wh_code,
            "wh_name": r.wh_name or "(未入库)",
            "system_qty": r.system_qty,
            "system_qty_time": r.system_qty_time,
            "actual_qty": r.actual_qty,
            "diff_qty": r.diff_qty,
            "counted_by": r.counted_by,
            "counted_at": r.counted_at,
            "checked_at": r.checked_at,
        })

    # 实时库存(读时计算,不落库): 按 (material_id, wh_id) 查 scm_inventory;
    # 无仓库(未入库/老数据)回退按物料跨仓聚合,与明细页 enrich_live_qty 一致。
    # 未入库行若物料现在已有库存记录,注入 live_wh_names 供前端展示真实仓库。
    ledger_mids = [int(it["material_id"]) for it in items if it["material_id"] is not None]
    stock_map = await _get_stock_by_warehouse(db, ledger_mids) if ledger_mids else {}
    none_wh_mids = list({
        int(it["material_id"]) for it in items if it["material_id"] is not None and it["wh_id"] is None
    })
    agg_map = (
        await _get_stock_aggregated_by_material_id(db, none_wh_mids) if none_wh_mids else {}
    )
    live_wh_map = _split_stock_by_warehouse(stock_map, none_wh_mids) if none_wh_mids else {}
    for it in items:
        mid = int(it["material_id"]) if it["material_id"] is not None else None
        wh = int(it["wh_id"]) if it["wh_id"] is not None else None
        it["live_wh_names"] = None
        if mid is None:
            it["live_qty"] = Decimal("0")
        elif wh is not None:
            entry = stock_map.get((mid, wh))
            it["live_qty"] = entry[1] if entry else Decimal("0")
        else:
            it["live_qty"] = agg_map.get(mid, Decimal("0"))
            whs = live_wh_map.get(mid) or []
            if whs:
                it["live_wh_names"] = "、".join(w[1] for w in whs)

    return int(total), items


async def update_stock_check_item(
    db: AsyncSession,
    item_id: int,
    *,
    actual_qty: Optional[Decimal] = None,
    actual_qty_provided: bool = False,
    is_checked: Optional[int] = None,
    remark: Optional[str] = None,
    force_recount: Optional[bool] = None,
    expected_version: Optional[int] = None,
    current_user: Optional[dict] = None,
    live_cache: Optional[Dict[Tuple[int, Optional[int]], Tuple[Decimal, Optional[datetime]]]] = None,
) -> StockCheckItem:
    item = (await db.execute(select(StockCheckItem).where(StockCheckItem.id == item_id).with_for_update())).scalar_one_or_none()
    if not item:
        raise ValueError(f"盘点行 {item_id} 不存在")
    # 状态守卫(修场景 8):已完结/取消的单子不允许再改行
    head_for_guard = (await db.execute(select(StockCheck).where(StockCheck.id == item.check_id).with_for_update())).scalar_one_or_none()
    if head_for_guard and head_for_guard.status in ("completed", "cancelled"):
        raise StockCheckPermissionError(f"盘点单已{head_for_guard.status},不可修改")
    await _assert_can_edit(db, item.check_id, current_user)
    # 乐观锁校验(with_for_update 已保证此处读到的 version 是已锁行的最新值)
    if expected_version is not None and int(item.version or 0) != int(expected_version):
        raise StockCheckConflictError("item", int(item.version or 0), _serialize_item(item))
    old_actual_qty = Decimal(str(item.actual_qty)) if item.actual_qty is not None else None
    old_is_checked = int(item.is_checked or 0)
    actual_qty_changed = False
    if force_recount:
        item.recent_checked_check_no = None
        item.recent_checked_date = None
        item.is_checked = 0
        item.checked_at = None
        item.checked_by = None
    if actual_qty_provided:
        if actual_qty is None:
            item.actual_qty = None
            item.counted_by_user_id = None
            item.counted_by = None
            item.counted_at = None
        else:
            new_actual_qty = Decimal(str(actual_qty))
            item.actual_qty = new_actual_qty
            if old_actual_qty is None:
                # 首次录入盘点数 → 冻结快照库存为当前实时值;
                # 若该行带近期已盘标记,真实盘点已取代免盘,同步撤销标记
                await _freeze_snapshot_for_count(db, item, live_cache)
                if item.recent_checked_check_no is not None:
                    item.recent_checked_check_no = None
                    item.recent_checked_date = None
            if new_actual_qty != old_actual_qty or force_recount:
                actual_qty_changed = True
                item.counted_by_user_id = _current_user_id(current_user)
                item.counted_by = current_user.get("username", "") if current_user else None
                item.counted_at = datetime.now()
    if remark is not None:
        item.remark = remark
    if is_checked is not None:
        new_is_checked = int(is_checked)
        if new_is_checked == 1:
            item.is_checked = 1
            # 标记人覆盖规则:仅 0→1 新签收,或 1→1 且实盘数变了(改数者代为重新签收)才记;
            # 1→1 且实盘数未变时保留原标记人,防止整行保存误覆盖
            if old_is_checked != 1 or actual_qty_changed:
                item.checked_at = datetime.now()
                if current_user:
                    item.checked_by = current_user.get("username", "")
        else:
            item.is_checked = 0
            item.checked_at = None
            item.checked_by = None
    # 盘点数联动:盘点数非空 → 自动勾选已盘;清空 → 自动取消勾选
    # 仅当实际提交了盘点数且 is_checked 未被显式设置时生效,避免覆盖 force_recount / 手动勾选
    if actual_qty_provided and is_checked is None:
        if item.actual_qty is not None and item.is_checked != 1:
            item.is_checked = 1
        elif item.actual_qty is None and item.is_checked != 0:
            item.is_checked = 0
    if item.actual_qty is not None and item.system_qty is not None:
        item.diff_qty = Decimal(str(item.actual_qty)) - Decimal(str(item.system_qty))
    elif actual_qty_provided:
        item.diff_qty = Decimal("0")
    item.version = int(item.version or 0) + 1
    await _refresh_check_aggregates(db, item.check_id)
    await db.flush()
    # 发布事件(全量快照 payload:完整 item + 头 aggregates)
    head_after = head_for_guard
    if head_after is None:
        head_after = (await db.execute(select(StockCheck).where(StockCheck.id == item.check_id))).scalar_one_or_none()
    await publish_event(
        item.check_id,
        "item_updated",
        {
            "item_id": item.id,
            "version": int(item.version or 0),
            "item": _serialize_item(item),
            "head_aggregates": {
                "checked_materials": int(head_after.checked_materials or 0) if head_after else 0,
                "total_materials": int(head_after.total_materials or 0) if head_after else 0,
                "total_diff_qty": float(head_after.total_diff_qty or 0) if head_after else 0,
            },
        },
        _current_user_id(current_user),
    )
    return item


async def batch_update_items(
    db: AsyncSession,
    check_id: int,
    items: List[dict],
    current_user: dict,
) -> int:
    # 预取待首次录入行的实时库存,避免逐行查询
    ids = [int(it["id"]) for it in items if it.get("id") is not None]
    live_cache = await _build_live_freeze_cache(db, ids)
    n = 0
    for it in items:
        if it.get("id") is None:
            continue
        await update_stock_check_item(
            db,
            int(it["id"]),
            actual_qty=it.get("actual_qty"),
            actual_qty_provided="actual_qty" in it,
            is_checked=it.get("is_checked"),
            remark=it.get("remark"),
            force_recount=it.get("force_recount"),
            expected_version=it.get("expected_version"),
            current_user=current_user,
            live_cache=live_cache,
        )
        n += 1
    return n


async def complete_stock_check(
    db: AsyncSession,
    check_id: int,
    current_user: dict,
    *,
    expected_version: Optional[int] = None,
) -> StockCheck:
    head = (await db.execute(select(StockCheck).where(StockCheck.id == check_id).with_for_update())).scalar_one_or_none()
    if not head:
        raise ValueError(f"盘点单 {check_id} 不存在")
    if not _user_can_edit(head, current_user):
        raise StockCheckPermissionError("无修改权限：仅创建人、共同盘点人或管理员可修改")
    if expected_version is not None and int(head.version or 0) != int(expected_version):
        raise StockCheckConflictError("head", int(head.version or 0), {"check_id": check_id})
    if head.status == "cancelled":
        raise ValueError("已取消的盘点单不能完结")
    if head.status == "completed":
        raise ValueError("已完结的盘点单不能再次完结")
    items_res = await db.execute(
        select(StockCheckItem).where(StockCheckItem.check_id == check_id).order_by(StockCheckItem.id)
    )
    head.items = list(items_res.scalars().all())
    total = (await db.execute(
        select(func.count(StockCheckItem.id)).where(StockCheckItem.check_id == check_id)
    )).scalar_one()
    checked = (await db.execute(
        select(func.count(StockCheckItem.id)).where(
            StockCheckItem.check_id == check_id,
            or_(
                StockCheckItem.is_checked == 1,
                StockCheckItem.recent_checked_check_no.isnot(None),
            ),
        )
    )).scalar_one()
    if int(total or 0) == 0:
        raise ValueError("盘点单无物料行,无法完结")
    if int(checked or 0) < int(total or 0):
        raise ValueError(f"还有 {int(total) - int(checked)} 行未盘点,无法完结")

    for item in head.items:
        # 近期已盘免盘行(recent 标记未撤销且未录入实盘数)不强制录入
        if item.actual_qty is None and not item.recent_checked_check_no:
            raise ValueError(f"物料 {item.material_code or item.material_id} 还未录入实盘数,请先填写再完结")

    head.status = "completed"
    head.completed_at = datetime.now()
    head.checked_by = current_user.get("username", "")
    head.version = int(head.version or 0) + 1
    await db.flush()
    await publish_event(
        check_id,
        "status_changed",
        {
            "check_id": check_id,
            "status": "completed",
            "head_version": int(head.version or 0),
            "checked_by": head.checked_by,
            "completed_at": head.completed_at.isoformat() if head.completed_at else None,
        },
        _current_user_id(current_user),
    )
    return head


async def cancel_stock_check(
    db: AsyncSession,
    check_id: int,
    current_user: dict,
    *,
    expected_version: Optional[int] = None,
) -> StockCheck:
    head = (await db.execute(select(StockCheck).where(StockCheck.id == check_id).with_for_update())).scalar_one_or_none()
    if not head:
        raise ValueError(f"盘点单 {check_id} 不存在")
    if not _user_can_edit(head, current_user):
        raise StockCheckPermissionError("无修改权限：仅创建人、共同盘点人或管理员可修改")
    if expected_version is not None and int(head.version or 0) != int(expected_version):
        raise StockCheckConflictError("head", int(head.version or 0), {"check_id": check_id})
    if head.status == "completed":
        raise ValueError("已完结的盘点单不能取消")
    head.status = "cancelled"
    head.version = int(head.version or 0) + 1
    await db.flush()
    await publish_event(
        check_id,
        "status_changed",
        {"check_id": check_id, "status": "cancelled", "head_version": int(head.version or 0)},
        _current_user_id(current_user),
    )
    return head


async def set_co_checkers(
    db: AsyncSession,
    check_id: int,
    user_ids: List[int],
    current_user: dict,
    *,
    expected_version: Optional[int] = None,
) -> StockCheck:
    """设置共同盘点人名单(仅创建人/admin 可改名单)。"""
    head = (await db.execute(select(StockCheck).where(StockCheck.id == check_id).with_for_update())).scalar_one_or_none()
    if not head:
        raise ValueError(f"盘点单 {check_id} 不存在")
    uid = _current_user_id(current_user)
    is_creator = (
        head.created_by_user_id is not None
        and uid is not None
        and int(head.created_by_user_id) == uid
    )
    if not (current_user.get("role") == "admin" or is_creator):
        raise StockCheckPermissionError("仅创建人或管理员可修改共同盘点人名单")
    if expected_version is not None and int(head.version or 0) != int(expected_version):
        raise StockCheckConflictError("head", int(head.version or 0), {"check_id": check_id})
    cleaned: List[int] = []
    seen: set = set()
    for x in (user_ids or []):
        try:
            v = int(x)
        except (TypeError, ValueError):
            continue
        if v > 0 and v not in seen:
            seen.add(v)
            cleaned.append(v)
    head.co_checker_user_ids = cleaned
    head.version = int(head.version or 0) + 1
    await db.flush()
    co_names = await _resolve_user_names(db, cleaned)
    await publish_event(
        check_id,
        "co_checkers_changed",
        {
            "check_id": check_id,
            "head_version": int(head.version or 0),
            "co_checker_user_ids": cleaned,
            "co_checkers": [{"user_id": i, "name": co_names.get(i, f"user#{i}")} for i in cleaned],
        },
        _current_user_id(current_user),
    )
    return head


async def refresh_order_bom(db: AsyncSession, check_id: int, current_user: dict) -> StockCheck:
    """对 in-progress 的订单盘点单重新展开 BOM，补入之前未纳入的子 BOM 物料。

    - 仅订单盘点单、仅 open/in_progress 状态可用。
    - 按 head.covered_products 筛选产品行（为空则全部）。
    - 保留已有明细及已录入数据；缺失的 material_id 取首次出现位置补入一行（带 level）。
    - 权限：创建人 / 共同盘点人 / admin（沿用 _user_can_edit）。
    """
    head = (await db.execute(select(StockCheck).where(StockCheck.id == check_id))).scalar_one_or_none()
    if not head:
        raise ValueError(f"盘点单 {check_id} 不存在")
    if head.check_type != "order" or not head.order_no:
        raise ValueError("仅订单盘点单支持刷新BOM")
    if head.status not in ("open", "in_progress"):
        raise ValueError("仅待盘点/盘点中的单据可刷新BOM")
    if not _user_can_edit(head, current_user):
        raise StockCheckPermissionError("无修改权限：仅创建人、共同盘点人或管理员可修改")

    line_materials = await get_order_product_materials(db, order_no=head.order_no)
    if head.covered_products:
        sel = {(c.get("product_code"), c.get("bom_no")) for c in head.covered_products}
        line_materials = [lm for lm in line_materials if (lm.product_code, lm.bom_no) in sel]
    if not line_materials:
        raise ValueError("所覆盖的产品行未展开出任何物料")

    existing_res = await db.execute(
        select(StockCheckItem.material_id).where(StockCheckItem.check_id == check_id)
    )
    existing_mids = {int(mid) for mid in existing_res.scalars().all() if mid is not None}

    def _walk(nodes, level):
        for n in (nodes or []):
            if n.material_id:
                yield n, level
            yield from _walk(getattr(n, "children", None) or [], level + 1)

    candidates = []
    added_mids: set = set()
    for lm in line_materials:
        for n, lvl in _walk(lm.materials or [], 1):
            mid = int(n.material_id)
            if mid in existing_mids or mid in added_mids:
                continue
            added_mids.add(mid)
            candidates.append((mid, n, lvl))
    if not candidates:
        return head

    stock_map = await _get_stock_by_warehouse(db, list(added_mids))
    warehouses_by_mid = _split_stock_by_warehouse(stock_map, list(added_mids))

    # 收敛新增 (material_id, wh_id)，跳过已存在的
    new_keys: List[Tuple[int, Optional[int]]] = []
    new_meta: Dict[Tuple[int, Optional[int]], Dict] = {}
    for mid, n, lvl in candidates:
        warehouses = warehouses_by_mid.get(mid, [])
        if warehouses:
            for wh_id, wh_name, sys_q, sys_t in warehouses:
                k = (mid, wh_id)
                if k in new_meta:
                    continue
                exists = (await db.execute(
                    select(func.count(StockCheckItem.id)).where(
                        StockCheckItem.check_id == check_id,
                        StockCheckItem.material_id == mid,
                        StockCheckItem.wh_id == wh_id,
                    )
                )).scalar_one()
                if exists:
                    continue
                new_meta[k] = {
                    "material_code": n.material_code,
                    "material_name": n.material_name,
                    "spec_model": n.spec_model,
                    "unit": n.unit,
                    "system_qty": sys_q,
                    "system_qty_time": sys_t,
                    "wh_name": wh_name,
                }
                new_keys.append(k)
        else:
            k = (mid, None)
            if k in new_meta:
                continue
            exists = (await db.execute(
                select(func.count(StockCheckItem.id)).where(
                    StockCheckItem.check_id == check_id,
                    StockCheckItem.material_id == mid,
                    StockCheckItem.wh_id.is_(None),
                )
            )).scalar_one()
            if exists:
                continue
            new_meta[k] = {
                "material_code": n.material_code,
                "material_name": n.material_name,
                "spec_model": n.spec_model,
                "unit": n.unit,
                "system_qty": Decimal("0"),
                "system_qty_time": None,
                "wh_name": "(未入库)",
            }
            new_keys.append(k)

    if not new_keys:
        await db.flush()
        await _refresh_check_aggregates(db, check_id)
        await db.flush()
        return head

    from app.core.config import get_settings
    skip_days = int(get_settings().STOCK_CHECK_RECENT_SKIP_DAYS)
    recent_map = await _get_recent_checked_by_warehouse(db, new_keys)
    today = date.today()

    for k in new_keys:
        mid, wh_id = k
        meta = new_meta[k]
        recent = recent_map.get(k)
        prefill = (
            recent is not None
            and recent["check_date"] is not None
            and (today - recent["check_date"]).days <= skip_days
        )
        if prefill:
            # 近期已盘: 仅打标记,不预填任何盘点数据(与 create_stock_check_from_order 同口径)
            db.add(StockCheckItem(
                check_id=check_id,
                line_no=None,
                level=None,
                material_id=mid,
                material_code=meta["material_code"],
                material_name=meta["material_name"],
                spec_model=meta["spec_model"],
                unit=meta["unit"],
                req_qty=Decimal("0"),
                system_qty=meta["system_qty"],
                system_qty_time=meta.get("system_qty_time"),
                wh_id=wh_id,
                wh_name=meta["wh_name"],
                actual_qty=None,
                diff_qty=Decimal("0"),
                is_checked=0,
                recent_checked_check_no=recent["check_no"],
                recent_checked_date=recent["check_date"],
            ))
        else:
            db.add(StockCheckItem(
                check_id=check_id,
                line_no=None,
                level=None,
                material_id=mid,
                material_code=meta["material_code"],
                material_name=meta["material_name"],
                spec_model=meta["spec_model"],
                unit=meta["unit"],
                req_qty=Decimal("0"),
                system_qty=meta["system_qty"],
                system_qty_time=meta.get("system_qty_time"),
                wh_id=wh_id,
                wh_name=meta["wh_name"],
                actual_qty=None,
                diff_qty=Decimal("0"),
                is_checked=0,
            ))
    await db.flush()
    await _refresh_check_aggregates(db, check_id)
    head.version = int(head.version or 0) + 1
    await db.flush()
    # 发布事件(new_item_ids 留空,客户端整体重拉)
    await publish_event(
        check_id,
        "bom_refreshed",
        {"check_id": check_id, "head_version": int(head.version or 0), "new_item_ids": []},
        _current_user_id(current_user),
    )
    return head


async def refresh_check_warehouses(db: AsyncSession, check_id: int, current_user: dict) -> Dict:
    """将进行中盘点单的"(未入库)"明细行按当前库存刷新为具体仓库行(订单/手动盘点单通用)。

    - 仅 open/in_progress 状态可用;权限:创建人 / 共同盘点人 / admin。
    - 仅处理 wh_id IS NULL 且未录入数据(actual_qty IS NULL 且 is_checked=0)的行;
      已录入数据的"(未入库)"行保持原样,避免改变已盘数据的差异归属口径。
    - 物料当前有 1 个仓库: UPDATE 原行仓库三列,并把该行快照库存刷新为刷新时点数量;
      ≥2 个仓库: 原行更新为库存最大的仓,其余仓 INSERT 新行(快照=刷新时点数量);
      仍无库存: 保持"(未入库)"不动。
    - 防重: 单内已存在同 (material_id, wh_id) 行的仓不再写入;同物料多行"(未入库)"
      老数据整体跳过(护栏,与回填脚本一致)。
    - 完成后重算头表汇总、head.version+1、广播 warehouses_refreshed 事件(客户端整体重拉)。
    """
    head = (await db.execute(select(StockCheck).where(StockCheck.id == check_id))).scalar_one_or_none()
    if not head:
        raise ValueError(f"盘点单 {check_id} 不存在")
    if head.status not in ("open", "in_progress"):
        raise ValueError("仅待盘点/盘点中的单据可刷新仓库")
    if not _user_can_edit(head, current_user):
        raise StockCheckPermissionError("无修改权限：仅创建人、共同盘点人或管理员可修改")

    pending = (await db.execute(
        select(StockCheckItem).where(
            StockCheckItem.check_id == check_id,
            StockCheckItem.wh_id.is_(None),
            StockCheckItem.material_id.isnot(None),
            StockCheckItem.actual_qty.is_(None),
            or_(StockCheckItem.is_checked == 0, StockCheckItem.is_checked.is_(None)),
        ).order_by(StockCheckItem.id)
    )).scalars().all()
    stats = {"pending": len(pending), "updated": 0, "split": 0, "inserted": 0,
             "no_stock": 0, "skipped_existing": 0, "guard_skip": 0}
    if not pending:
        return stats

    # 单内已有 (material_id, wh_id) 行集合(防重复写入)
    existing_res = await db.execute(
        select(StockCheckItem.material_id, StockCheckItem.wh_id)
        .where(StockCheckItem.check_id == check_id, StockCheckItem.wh_id.isnot(None))
    )
    existing_keys = {
        (int(r[0]), int(r[1])) for r in existing_res.all() if r[0] is not None
    }
    # 护栏: 同单内同一 material_id 有多行"(未入库)"老明细 → 全部跳过
    mid_count: Dict[int, int] = {}
    for it in pending:
        mid_count[int(it.material_id)] = mid_count.get(int(it.material_id), 0) + 1

    mids = list(mid_count.keys())
    stock_res = await db.execute(
        select(
            Inventory.material_id,
            Inventory.wh_id,
            func.max(Inventory.wh_code).label("wh_code"),
            func.max(Inventory.wh_name).label("wh_name"),
            func.coalesce(func.sum(Inventory.qty_on_hand), 0).label("qty"),
            func.max(Inventory.updated_at).label("wh_updated"),
        )
        .where(Inventory.material_id.in_(mids))
        .group_by(Inventory.material_id, Inventory.wh_id)
    )
    wh_map: Dict[int, List[Dict]] = {}
    for r in stock_res.all():
        wh_map.setdefault(int(r.material_id), []).append({
            "wh_id": int(r.wh_id),
            "wh_code": (r.wh_code or "").strip() or None,
            "wh_name": (r.wh_name or "").strip() or f"WH#{r.wh_id}",
            "qty": Decimal(str(r.qty or 0)),
            "updated_at": r.wh_updated,
        })
    for mid in wh_map:
        wh_map[mid].sort(key=lambda w: (-w["qty"], w["wh_id"]))

    for item in pending:
        mid = int(item.material_id)
        if mid_count[mid] > 1:
            stats["guard_skip"] += 1
            continue
        whs = [
            w for w in wh_map.get(mid, [])
            if (mid, w["wh_id"]) not in existing_keys
        ]
        if not wh_map.get(mid):
            stats["no_stock"] += 1
            continue
        if not whs:
            # 目标仓均已存在行,原"(未入库)"行冗余但不动(保留供人工确认)
            stats["skipped_existing"] += 1
            continue

        first = whs[0]
        item.wh_id = first["wh_id"]
        item.wh_code = first["wh_code"]
        item.wh_name = first["wh_name"]
        item.system_qty = first["qty"]
        item.system_qty_time = first["updated_at"]
        item.diff_qty = Decimal("0")
        item.version = int(item.version or 0) + 1
        stats["updated"] += 1

        for extra in whs[1:]:
            db.add(StockCheckItem(
                check_id=check_id,
                line_no=item.line_no,
                level=item.level,
                material_id=item.material_id,
                material_code=item.material_code,
                material_name=item.material_name,
                spec_model=item.spec_model,
                unit=item.unit,
                req_qty=Decimal("0"),
                system_qty=extra["qty"],
                system_qty_time=extra["updated_at"],
                wh_id=extra["wh_id"],
                wh_code=extra["wh_code"],
                wh_name=extra["wh_name"],
                actual_qty=None,
                diff_qty=Decimal("0"),
                is_checked=0,
            ))
            stats["inserted"] += 1
        if len(whs) > 1:
            stats["split"] += 1

    await db.flush()
    await _refresh_check_aggregates(db, check_id)
    head.version = int(head.version or 0) + 1
    await db.flush()
    await publish_event(
        check_id,
        "warehouses_refreshed",
        {"check_id": check_id, "head_version": int(head.version or 0), "stats": stats},
        _current_user_id(current_user),
    )
    return stats


async def get_stock_check_with_items(db: AsyncSession, check_id: int) -> Optional[StockCheck]:
    head = (await db.execute(select(StockCheck).where(StockCheck.id == check_id))).scalar_one_or_none()
    if not head:
        return None
    items_res = await db.execute(
        select(StockCheckItem).where(StockCheckItem.check_id == check_id).order_by(StockCheckItem.id)
    )
    head.items = list(items_res.scalars().all())
    await enrich_items_assoc(db, head.items)
    await enrich_live_qty(db, head.items)
    return head


async def list_recent_stock_checks(
    db: AsyncSession,
    page: int = 1,
    page_size: int = 10,
    *,
    keyword: Optional[str] = None,
    status: Optional[List[str]] = None,
    check_type: Optional[str] = None,
    source: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = None,
) -> List[StockCheck]:
    SORTABLE = {
        'check_no': StockCheck.check_no,
        'order_no': StockCheck.order_no,
        'check_date': StockCheck.check_date,
        'total_materials': StockCheck.total_materials,
        'checked_materials': StockCheck.checked_materials,
        'total_diff_qty': StockCheck.total_diff_qty,
        'created_at': StockCheck.created_at,
    }
    query = select(StockCheck)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(
            StockCheck.check_no.ilike(like),
            StockCheck.order_no.ilike(like),
            StockCheck.title.ilike(like),
        ))
    if status:
        statuses = [s.strip() for s in status if s and s.strip()]
        if statuses:
            query = query.where(StockCheck.status.in_(statuses))
    if check_type:
        query = query.where(StockCheck.check_type == check_type)
    if source:
        query = query.where(StockCheck.source == source)
    if date_from:
        query = query.where(StockCheck.check_date >= date_from)
    if date_to:
        query = query.where(StockCheck.check_date <= date_to)
    if sort_by and sort_by in SORTABLE:
        col = SORTABLE[sort_by]
        if sort_order == 'asc':
            query = query.order_by(col.asc().nullslast())
        else:
            query = query.order_by(col.desc().nullslast())
    else:
        query = query.order_by(StockCheck.created_at.desc())
    rows = (await db.execute(
        query.offset((page - 1) * page_size).limit(page_size)
    )).scalars().all()
    return list(rows)


async def list_stock_checks_by_order(db: AsyncSession, order_no: str) -> List[StockCheck]:
    res = await db.execute(
        select(StockCheck).where(StockCheck.order_no == order_no).order_by(desc(StockCheck.created_at))
    )
    return list(res.scalars().all())


async def get_material_history(
    db: AsyncSession,
    material_id: int,
    limit: int = 100,
) -> List[Dict]:
    """查询某物料被哪些盘点单盘点过的历史记录 (不含已取消)。
    返回字典列表,字段与 MaterialHistoryItem 一致;含 customer 来自 sale_order。"""
    sql = (
        select(
            StockCheck.check_no,
            StockCheck.order_no,
            StockCheck.status,
            StockCheck.check_date,
            StockCheck.completed_at,
            StockCheck.created_at,
            StockCheck.created_by,
            StockCheckItem.actual_qty,
        )
        .join(StockCheck, StockCheck.id == StockCheckItem.check_id)
        .where(StockCheckItem.material_id == material_id)
        .where(StockCheck.status != "cancelled")
        .order_by(StockCheck.completed_at.desc().nulls_last(), StockCheck.created_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(sql)).all()

    if not rows:
        return []

    order_nos = sorted({r.order_no for r in rows if r.order_no})
    customer_map: Dict[str, Optional[str]] = {}
    if order_nos:
        from app.models.order.sale_order import SaleOrder
        so_rows = (await db.execute(
            select(SaleOrder.order_no, SaleOrder.customer)
            .where(SaleOrder.order_no.in_(order_nos))
        )).all()
        for so_r in so_rows:
            customer_map.setdefault(so_r.order_no, so_r.customer)

    return [
        {
            "check_no": r.check_no,
            "order_no": r.order_no,
            "customer": customer_map.get(r.order_no),
            "status": r.status,
            "check_date": r.check_date,
            "completed_at": r.completed_at,
            "actual_qty": r.actual_qty,
            "created_at": r.created_at,
            "created_by": r.created_by,
        }
        for r in rows
    ]


async def get_stock_check_stats(
    db: AsyncSession,
    *,
    check_type: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    status: Optional[List[str]] = None,
) -> Dict:
    """盘盈盘亏统计（仅 is_checked=1 的已盘点行，排除已取消单）。
    返回 dict 供路由层构造 StockCheckStats。"""
    conds = [
        StockCheckItem.is_checked == 1,
        StockCheck.status != "cancelled",
    ]
    if check_type:
        conds.append(StockCheck.check_type == check_type)
    if date_from:
        conds.append(StockCheck.check_date >= date_from)
    if date_to:
        conds.append(StockCheck.check_date <= date_to)
    if status:
        conds.append(StockCheck.status.in_(status))

    gain_c = func.sum(case((StockCheckItem.diff_qty > 0, 1), else_=0)).label("gain_count")
    loss_c = func.sum(case((StockCheckItem.diff_qty < 0, 1), else_=0)).label("loss_count")
    flat_c = func.sum(case((StockCheckItem.diff_qty == 0, 1), else_=0)).label("flat_count")
    total_gain = func.coalesce(
        func.sum(case((StockCheckItem.diff_qty > 0, StockCheckItem.diff_qty), else_=0)), 0
    ).label("total_gain_qty")
    total_loss = func.coalesce(
        func.sum(case((StockCheckItem.diff_qty < 0, StockCheckItem.diff_qty), else_=0)), 0
    ).label("total_loss_qty")
    total_checked = func.count(StockCheckItem.id).label("total_checked")

    q1 = (
        select(gain_c, loss_c, flat_c, total_gain, total_loss, total_checked)
        .join(StockCheck, StockCheck.id == StockCheckItem.check_id)
        .where(*conds)
    )
    row = (await db.execute(q1)).one()

    q2 = (
        select(
            StockCheckItem.material_code,
            func.max(StockCheckItem.material_name).label("material_name"),
            func.max(StockCheckItem.unit).label("unit"),
            func.sum(StockCheckItem.diff_qty).label("diff_qty"),
        )
        .join(StockCheck, StockCheck.id == StockCheckItem.check_id)
        .where(*conds, StockCheckItem.material_code.isnot(None))
        .group_by(StockCheckItem.material_code)
        .order_by(func.abs(func.sum(StockCheckItem.diff_qty)).desc())
        .limit(10)
    )
    top_rows = (await db.execute(q2)).all()

    return {
        "total_checked": int(row.total_checked or 0),
        "gain_count": int(row.gain_count or 0),
        "loss_count": int(row.loss_count or 0),
        "flat_count": int(row.flat_count or 0),
        "total_gain_qty": float(row.total_gain_qty or 0),
        "total_loss_qty": float(row.total_loss_qty or 0),
        "top_diff_materials": [
            {
                "material_code": r.material_code or "",
                "material_name": r.material_name or "",
                "diff_qty": float(r.diff_qty or 0),
                "unit": r.unit,
            }
            for r in top_rows
        ],
    }


async def list_my_stock_check_items(
    db: AsyncSession,
    user_id: int,
    page: int = 1,
    page_size: int = 20,
    keyword: Optional[str] = None,
    wh_id: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    check_no: Optional[str] = None,
    check_type: Optional[str] = None,
    status: Optional[List[str]] = None,
    order_no: Optional[str] = None,
    material_code: Optional[str] = None,
    material_name: Optional[str] = None,
    spec_model: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = None,
) -> Tuple[int, List[Dict]]:
    """个人盘点台账：以 StockCheckItem.counted_by_user_id == user_id
    作为唯一个人范围条件，关联盘点单头（排除 cancelled）。
    wh_id 接受数字（按 wh_id 精确匹配）或字符串（按 wh_name 模糊匹配）。
    sort_by/sort_order 走 SORTABLE 白名单；默认按 counted_at desc / id desc。
    返回 (total, [dict, ...])，供路由层构 PageResult[StockCheckMyItemOut]。"""
    SORTABLE = {
        'counted_at': StockCheckItem.counted_at,
        'check_no': StockCheck.check_no,
        'order_no': StockCheck.order_no,
        'check_date': StockCheck.check_date,
        'material_code': StockCheckItem.material_code,
        'material_name': StockCheckItem.material_name,
        'spec_model': StockCheckItem.spec_model,
        'wh_name': StockCheckItem.wh_name,
        'system_qty': StockCheckItem.system_qty,
        'actual_qty': StockCheckItem.actual_qty,
        'diff_qty': StockCheckItem.diff_qty,
        'status': StockCheck.status,
    }
    conds = [
        StockCheckItem.counted_by_user_id == user_id,
        StockCheck.status != "cancelled",
    ]
    if keyword:
        like = f"%{keyword}%"
        conds.append(or_(
            StockCheckItem.material_code.ilike(like),
            StockCheckItem.material_name.ilike(like),
            StockCheck.check_no.ilike(like),
        ))
    if check_no:
        conds.append(StockCheck.check_no.ilike(f"%{check_no}%"))
    if order_no:
        conds.append(StockCheck.order_no.ilike(f"%{order_no}%"))
    if material_code:
        conds.append(StockCheckItem.material_code.ilike(f"%{material_code}%"))
    if material_name:
        conds.append(StockCheckItem.material_name.ilike(f"%{material_name}%"))
    if spec_model:
        conds.append(StockCheckItem.spec_model.ilike(f"%{spec_model}%"))
    if check_type:
        conds.append(StockCheck.check_type == check_type)
    if date_from:
        conds.append(StockCheck.check_date >= date_from)
    if date_to:
        conds.append(StockCheck.check_date <= date_to)
    if status:
        statuses = [s.strip() for s in status if s and s.strip()]
        if statuses:
            conds.append(StockCheck.status.in_(statuses))
    if wh_id is not None and str(wh_id).strip():
        wh_raw = str(wh_id).strip()
        try:
            wh_int = int(wh_raw)
            live_exists = select(1).where(
                Inventory.material_id == StockCheckItem.material_id,
                Inventory.wh_id == wh_int,
            ).exists()
            # 未入库行(wh_id=NULL)按物料实时库存所在仓匹配,与台账页口径一致
            conds.append(or_(
                StockCheckItem.wh_id == wh_int,
                and_(StockCheckItem.wh_id.is_(None), live_exists),
            ))
        except (TypeError, ValueError):
            live_name_exists = select(1).where(
                Inventory.material_id == StockCheckItem.material_id,
                Inventory.wh_name.ilike(f"%{wh_raw}%"),
            ).exists()
            conds.append(or_(
                StockCheckItem.wh_name.ilike(f"%{wh_raw}%"),
                and_(StockCheckItem.wh_id.is_(None), live_name_exists),
            ))

    if sort_by and sort_by in SORTABLE:
        col = SORTABLE[sort_by]
        if sort_order == 'asc':
            order_by = (col.asc().nullslast(), StockCheckItem.id.asc())
        else:
            order_by = (col.desc().nullslast(), StockCheckItem.id.desc())
    else:
        order_by = (StockCheckItem.counted_at.desc().nulls_last(), StockCheckItem.id.desc())

    base_q = (
        select(StockCheckItem, StockCheck)
        .join(StockCheck, StockCheck.id == StockCheckItem.check_id)
        .where(*conds)
        .order_by(*order_by)
    )
    count_q = select(func.count(StockCheckItem.id)).join(
        StockCheck, StockCheck.id == StockCheckItem.check_id
    ).where(*conds)
    total = (await db.execute(count_q)).scalar() or 0
    rows = (await db.execute(
        base_q.offset((page - 1) * page_size).limit(page_size)
    )).all()

    items: List[Dict] = []
    for it, head in rows:
        items.append({
            "item_id": int(it.id),
            "check_id": int(head.id),
            "check_no": head.check_no,
            "order_no": head.order_no,
            "title": head.title,
            "check_type": head.check_type,
            "status": head.status,
            "check_date": head.check_date,
            "completed_at": head.completed_at,
            "material_id": it.material_id,
            "material_code": it.material_code,
            "material_name": it.material_name,
            "spec_model": it.spec_model,
            "unit": it.unit,
            "wh_id": it.wh_id,
            "wh_name": it.wh_name,
            "wh_code": it.wh_code,
            "system_qty": it.system_qty,
            "actual_qty": it.actual_qty,
            "diff_qty": it.diff_qty,
            "counted_by_user_id": it.counted_by_user_id,
            "counted_by": it.counted_by,
            "counted_at": it.counted_at,
            "recent_checked_check_no": it.recent_checked_check_no,
            "recent_checked_date": it.recent_checked_date,
        })
    return int(total), items
