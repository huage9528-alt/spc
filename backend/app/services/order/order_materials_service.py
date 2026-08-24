from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.basicdata.bom import Bom
from app.models.basicdata.bom_detail import BomDetail
from app.models.basicdata.material import Material
from app.models.material.binding import OrderMaterialPoBinding
from app.models.material.material_demand import MaterialDemand
from app.models.material.purchase_order import PurchaseOrder
from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.schemas.order.schemas import BomDetailItemOut, OrderProductMaterialsOut


MATERIAL_PROPERTY_LABELS = {
    1: "外购",
    2: "自制",
    3: "委外加工",
    5: "虚拟件",
    6: "特征类",
    7: "配置类",
    8: "规划类",
    9: "组装件",
}

STATUS_LABELS = {
    "not_ordered": "未下单",
    "self_made_unlinked": "自制未排产/未关联",
    "pending": "待到料",
    "overdue": "逾期未到",
    "partial_received": "部分到",
    "fully_received": "已到齐",
    "in_stock": "有库存",
}

MAX_BOM_LEVEL = 20


def _line_no_sort_key(line_no: Optional[str]) -> tuple:
    """BOM 行号排序键:数值优先,非数值次之,空值最后。

    用 3 元组确保跨类型不冲突:
      - (0, int, "")    数值行号,如 "1" "2" "10"
      - (1, 0,   str)   非数值行号,如 "1.2" "A1"
      - (2, 0,   "")    空值/None
    """
    if not line_no:
        return (2, 0, "")
    s = str(line_no).strip()
    if not s:
        return (2, 0, "")
    try:
        return (0, int(s), "")
    except ValueError:
        return (1, 0, s)


def _sort_bom_tree(nodes: list[BomDetailItemOut]) -> None:
    """递归按 line_no 升序排序 BOM 树(原地修改)。"""
    nodes.sort(key=lambda n: _line_no_sort_key(n.line_no))
    for n in nodes:
        if n.children:
            _sort_bom_tree(n.children)


@dataclass
class MaterialPoSummary:
    po_no: Optional[str] = None
    supplier_name: Optional[str] = None
    material_property: Optional[int] = None
    material_type_name: Optional[str] = None
    material_name: Optional[str] = None
    po_qty: Optional[Decimal] = None
    received_qty: Optional[Decimal] = None
    first_eta: Optional[date] = None
    latest_eta: Optional[date] = None
    actual_arrival_date: Optional[date] = None
    inspection_date: Optional[date] = None
    po_count: int = 0
    is_closed: int = 0

    @property
    def eta(self) -> Optional[date]:
        return self.first_eta


@dataclass
class MaterialSubSummary:
    """按 (sale_order_no, material_code) 聚合的委外订单汇总。平行于 MaterialPoSummary。"""
    po_no: Optional[str] = None
    po_qty: Optional[Decimal] = None
    received_qty: Optional[Decimal] = None
    first_eta: Optional[date] = None
    latest_eta: Optional[date] = None
    po_count: int = 0
    is_closed: int = 0


@dataclass
class MaterialTaskSummary:
    """按 (sale_order_id, material_code) 聚合的生产任务单汇总。平行于 MaterialPoSummary / MaterialSubSummary。"""
    po_no: Optional[str] = None                       # 任务单号 task_no(多张以 ", " 拼接)
    po_qty: Optional[Decimal] = None                  # 任务数量(等同 task_qty 总和)
    received_qty: Optional[Decimal] = None            # 实做数量(等同 actual_qty 总和)
    first_eta: Optional[date] = None
    latest_eta: Optional[date] = None
    actual_arrival_date: Optional[date] = None
    inspection_date: Optional[date] = None
    po_count: int = 0
    is_closed: int = 0


def _to_float(value) -> Optional[float]:
    if value is None:
        return None
    return float(value)


def _sum_qty(values) -> Optional[Decimal]:
    total = Decimal("0")
    seen = False
    for value in values:
        if value is not None:
            total += value
            seen = True
    return total if seen else None


def _pick_first(values):
    return next((value for value in values if value not in (None, "")), None)


def _summarize_pos(pos: list[PurchaseOrder]) -> Optional[MaterialPoSummary]:
    if not pos:
        return None
    etas = [po.eta for po in pos if po.eta]
    arrivals = [po.actual_arrival_date for po in pos if po.actual_arrival_date]
    inspections = [po.inspection_date for po in pos if po.inspection_date]
    return MaterialPoSummary(
        po_no=", ".join(dict.fromkeys([po.po_no for po in pos if po.po_no])) or None,
        supplier_name=_pick_first([po.supplier_name for po in pos]),
        material_property=_pick_first([po.material_property for po in pos]),
        material_type_name=_pick_first([po.material_type_name for po in pos]),
        material_name=_pick_first([po.material_name for po in pos]),
        po_qty=_sum_qty([po.po_qty for po in pos]),
        received_qty=_sum_qty([po.received_qty for po in pos]),
        first_eta=min(etas) if etas else None,
        latest_eta=max(etas) if etas else None,
        actual_arrival_date=max(arrivals) if arrivals else None,
        inspection_date=max(inspections) if inspections else None,
        po_count=len(pos),
        is_closed=1 if any(po.is_closed for po in pos) else 0,
    )


def _summarize_subs(subs: list) -> Optional[MaterialSubSummary]:
    """聚合多条委外订单明细行。同 (sale_order_no, material_code) 已在外层做好分组,这里只是聚合。

    subs 每条可以是 ORM 实例或 SimpleNamespace;为兼容仅使用 getattr 读取。
    """
    if not subs:
        return None
    return MaterialSubSummary(
        po_no=", ".join(dict.fromkeys([s.bill_no for s in subs if getattr(s, "bill_no", None)])) or None,
        po_qty=_sum_qty([getattr(s, "qty", None) for s in subs]),
        received_qty=_sum_qty([getattr(s, "received_qty", None) for s in subs]),
        first_eta=min([s.eta for s in subs if getattr(s, "eta", None)], default=None) if subs else None,
        latest_eta=max([s.eta for s in subs if getattr(s, "eta", None)], default=None) if subs else None,
        po_count=len(subs),
        is_closed=1 if any(getattr(s, "closed_flag", 0) for s in subs) else 0,
    )


def _subcontract_status(sub_summary: Optional[MaterialSubSummary]) -> str:
    """委外物料齐套状态。4 出口,与 _status 对齐:已到齐/部分到/待到料/未下单。"""
    if not sub_summary or sub_summary.po_count == 0:
        return "not_ordered"
    received = sub_summary.received_qty
    qty = sub_summary.po_qty
    if received is not None and received > 0:
        if qty is not None and received >= qty:
            return "fully_received"
        return "partial_received"
    return "pending"


def _summarize_tasks(tasks: list) -> Optional[MaterialTaskSummary]:
    """聚合多条 ProductionTaskOrder 行。同 (sale_order_id, material_code) 已在外层做好分组,这里只是聚合。

    tasks 每条可以是 ORM 实例或 SimpleNamespace;为兼容仅使用 getattr 读取。

    映射规则:
      - po_qty = sum(task_qty)
      - received_qty = sum(actual_qty)
      - first_eta / latest_eta = planned_start_date / planned_end_date
      - actual_arrival_date = max(actual_end_date)
      - is_closed = 1 if any is_closed=1
    """
    if not tasks:
        return None
    return MaterialTaskSummary(
        po_no=", ".join(dict.fromkeys([getattr(t, "task_no", None) for t in tasks if getattr(t, "task_no", None)])) or None,
        po_qty=_sum_qty([getattr(t, "task_qty", None) for t in tasks]),
        received_qty=_sum_qty([getattr(t, "actual_qty", None) for t in tasks]),
        first_eta=min([getattr(t, "planned_start_date", None) for t in tasks if getattr(t, "planned_start_date", None)], default=None),
        latest_eta=max([getattr(t, "planned_end_date", None) for t in tasks if getattr(t, "planned_end_date", None)], default=None),
        actual_arrival_date=max([getattr(t, "actual_end_date", None) for t in tasks if getattr(t, "actual_end_date", None)], default=None),
        inspection_date=None,
        po_count=len(tasks),
        is_closed=1 if any(getattr(t, "is_closed", 0) for t in tasks) else 0,
    )


def _task_status(task_summary: Optional[MaterialTaskSummary]) -> str:
    """自制物料齐套状态。5 出口,与 _status 对齐:已到齐/部分到/待到料/未下单/逾期。
    
    推导规则(对齐 _status):
      - 无 task_summary → not_ordered
      - actual_qty >= task_qty (或 is_closed=1) → fully_received
      - actual_qty > 0 (部分做) → partial_received
      - actual_qty 缺失或 0,但 planned_end_date 已过 → overdue
      - 否则 → pending
    """
    if not task_summary or task_summary.po_count == 0:
        return "not_ordered"
    received = task_summary.received_qty
    qty = task_summary.po_qty
    if received is not None and received > 0:
        if qty is not None and received >= qty:
            return "fully_received"
        return "partial_received"
    # 已开工但未产出,planned_end_date 已过则逾期
    if task_summary.latest_eta and task_summary.latest_eta < date.today():
        return "overdue"
    return "pending"


def _infer_material_property(demand: MaterialDemand, po_summary: Optional[MaterialPoSummary], master: Optional[Material]) -> Optional[int]:
    if getattr(demand, "material_property", None):
        return demand.material_property
    if po_summary and po_summary.material_property:
        return po_summary.material_property
    if master:
        if master.is_purchase:
            return 1
        if master.is_produce:
            return 2
    return None


def _material_property_label(material_property: Optional[int]) -> Optional[str]:
    if material_property is None:
        return None
    return MATERIAL_PROPERTY_LABELS.get(material_property, str(material_property))


def _status(material_property: Optional[int], po_summary: Optional[MaterialPoSummary]) -> str:
    if material_property == 2:
        return "not_ordered"
    if not po_summary or po_summary.po_count == 0:
        return "not_ordered"
    received_qty = po_summary.received_qty
    po_qty = po_summary.po_qty
    # 状态纯按收料数量推导（已到料状态已移除）
    if received_qty is not None and received_qty > 0:
        if po_qty is not None and received_qty >= po_qty:
            return "fully_received"
        return "partial_received"
    if po_summary.eta and po_summary.eta < date.today():
        return "overdue"
    return "pending"


def _kit_met(status: str, material_property: Optional[int]) -> bool:
    # 「已到齐」或「有库存」均视为齐套；部分到（缺量）不计入
    return status in ("fully_received", "in_stock")


async def get_order_product_materials(
    db: AsyncSession,
    order_no: str,
    line_no: Optional[str] = None,
) -> list[OrderProductMaterialsOut]:
    line_query = select(SaleOrderLine).where(SaleOrderLine.order_no == order_no)
    if line_no:
        line_query = line_query.where(SaleOrderLine.line_no == line_no)
    line_result = await db.execute(line_query.order_by(SaleOrderLine.id))
    lines = line_result.scalars().all()

    if not lines:
        order_query = select(SaleOrder).where(SaleOrder.order_no == order_no)
        if line_no:
            order_query = order_query.where(SaleOrder.line_no == line_no)
        order = (await db.execute(order_query)).scalar_one_or_none()
        if order:
            lines = [
                SimpleNamespace(
                    order_no=order.order_no,
                    line_no=order.line_no,
                    product_code=order.product_code,
                    product_name=order.product_name,
                    product_model=None,
                    order_qty=order.order_qty,
                    promised_date=order.promised_date,
                    bom_id=None,
                )
            ]

    # 按 (product_code, bom_id) 合并重复产品行:
    #   - order_qty 求和,BOM 树只展开一次,需求量按合并后总量计算(数学上正确)
    #   - line_no 以逗号聚合,保留所有原始行号供追溯
    #   - promised_date 取最早(保守)
    #   - 同产品不同 BOM 仍保持多行(展开内容不同,合并会误导)
    groups: dict[tuple[str, str], list] = {}
    for line in lines:
        line_bom_id = str(line.bom_id) if getattr(line, "bom_id", None) else None
        key = (line.product_code or "", line_bom_id or "")
        groups.setdefault(key, []).append(line)

    result: list[OrderProductMaterialsOut] = []
    for (product_code_key, bom_id_key), group_lines in groups.items():
        first = group_lines[0]
        total_qty = Decimal("0")
        line_nos: list[str] = []
        promised: Optional[date] = None
        for ln in group_lines:
            qty = ln.order_qty if ln.order_qty is not None else 0
            total_qty += Decimal(str(qty))
            if ln.line_no is not None:
                line_nos.append(str(ln.line_no))
            pd = ln.promised_date
            if pd is not None and (promised is None or pd < promised):
                promised = pd
        merged_bom_id = bom_id_key or None
        tree = await _expand_bom_tree(db, merged_bom_id, total_qty)
        result.append(OrderProductMaterialsOut(
            line_no=",".join(line_nos) if line_nos else None,
            product_code=first.product_code,
            product_name=first.product_name,
            product_model=getattr(first, "product_model", None),
            bom_no=getattr(first, "bom_no", None),
            bom_id=merged_bom_id,
            order_qty=_to_float(total_qty),
            promised_date=promised,
            total_materials=len(tree),
            materials=tree,
        ))
    return result


async def _expand_bom_tree(
    db: AsyncSession,
    root_bom_id: Optional[str],
    root_demand_factor: Decimal,
) -> list[BomDetailItemOut]:
    """BFS 展开多层 BOM，返回顶层节点列表（children 已递归挂载）。

    每层三步查询：
      1) BomDetail WHERE bom_id IN (本层)
      2) Material  WHERE erp_material_id IN (新子件)  [增量缓存]
      3) Bom       WHERE material_id IN (本层子件)    [回查主表，判断是否继续展开]

    算法对齐 kit_analysis_service._get_bom_demand_map：
      - visited 防环；MAX_BOM_LEVEL 深度上限
      - 需求量公式（纯连乘，无除法）：
          factor(root) = 订单数量
          req(N)        = N.standard_qty × factor(N)
          factor(child) = req(parent)
        即：req(N) = N.standard_qty × 订单数量 × Π(所有父级 standard_qty)
      - 父子挂载延迟到 BFS 结束后统一执行（子节点此时已全部创建）
    """
    if not root_bom_id:
        return []

    master_by_mid: dict[int, Material] = {}
    node_by_key: dict[tuple[str, str], BomDetailItemOut] = {}
    parent_links: list[tuple[tuple[str, str], tuple[str, str]]] = []
    top_keys: list[tuple[str, str]] = []
    visited: set[str] = set()

    queue: list[tuple[str, Decimal, Optional[int], Optional[tuple[str, str]], int]] = [
        (root_bom_id, root_demand_factor, None, None, 1)
    ]

    while queue:
        level_bom_ids = {
            item[0] for item in queue
            if item[0] not in visited and item[4] <= MAX_BOM_LEVEL
        }
        if not level_bom_ids:
            break
        visited.update(level_bom_ids)

        detail_result = await db.execute(
            select(BomDetail)
            .where(BomDetail.bom_id.in_(level_bom_ids))
            .order_by(BomDetail.bom_id, BomDetail.line_no)
        )
        details_by_bom: dict[str, list[BomDetail]] = {}
        for d in detail_result.scalars().all():
            details_by_bom.setdefault(d.bom_id, []).append(d)

        new_mids = {
            d.material_id for details in details_by_bom.values()
            for d in details if d.material_id
        } - master_by_mid.keys()
        if new_mids:
            mat_result = await db.execute(
                select(Material).where(Material.erp_material_id.in_(new_mids))
            )
            for m in mat_result.scalars().all():
                master_by_mid[m.erp_material_id] = m

        child_mids = {
            d.material_id for details in details_by_bom.values()
            for d in details if d.material_id
        }
        # 收集每个子件物料的所有候选 BOM（同一物料可能有多个版本/类型）
        sub_bom_candidates: dict[int, list[Bom]] = {}
        if child_mids:
            bom_result = await db.execute(
                select(Bom).where(Bom.material_id.in_(child_mids))
            )
            for b in bom_result.scalars().all():
                sub_bom_candidates.setdefault(b.material_id, []).append(b)

        # 查询哪些候选 bom_id 真正有明细行（可展开）
        candidate_bom_ids = [b.bom_id for boms in sub_bom_candidates.values() for b in boms]
        detail_bom_ids: set[str] = set()
        if candidate_bom_ids:
            det_id_result = await db.execute(
                select(BomDetail.bom_id).where(BomDetail.bom_id.in_(candidate_bom_ids)).distinct()
            )
            detail_bom_ids = {row[0] for row in det_id_result.fetchall()}

        # 每个物料挑一个"可展开"的 BOM：优先有明细且未作废/未禁用，其次有明细的任意一条
        # 没有任何带明细的 BOM → 不入 sub_bom_by_mid → 视为叶子（has_sub_bom=False）
        sub_bom_by_mid: dict[int, Bom] = {}
        for mid, boms in sub_bom_candidates.items():
            with_details = [b for b in boms if b.bom_id in detail_bom_ids]
            if not with_details:
                continue
            clean = [b for b in with_details if not b.void_flag and not b.disabled_status]
            pool = clean if clean else with_details
            pool.sort(key=lambda b: (-(b.is_audited or 0), b.bom_id))
            sub_bom_by_mid[mid] = pool[0]

        next_queue: list[tuple[str, Decimal, Optional[int], Optional[tuple[str, str]], int]] = []
        for bom_id, factor, parent_mid, parent_key, level in queue:
            if bom_id not in level_bom_ids:
                continue
            for d in details_by_bom.get(bom_id, []):
                master = master_by_mid.get(d.material_id) if d.material_id else None
                if d.standard_qty is not None and factor is not None:
                    req_qty_decimal: Optional[Decimal] = d.standard_qty * factor
                else:
                    req_qty_decimal = d.standard_qty

                sub_bom = sub_bom_by_mid.get(d.material_id) if d.material_id else None
                key = (bom_id, d.line_no or "")
                node_by_key[key] = BomDetailItemOut(
                    material_id=str(d.material_id) if d.material_id is not None else None,
                    material_code=master.material_code if master else None,
                    material_name=master.material_name if master else None,
                    spec_model=master.spec_model if master else None,
                    unit=master.unit_of_measure if master else None,
                    material_type=d.material_type or (master.material_type if master else None),
                    material_property=master.material_property if master else None,
                    line_no=d.line_no,
                    standard_qty=_to_float(d.standard_qty),
                    aux_qty=_to_float(d.aux_qty),
                    config_type=d.config_type,
                    lead_offset_days=d.lead_offset_days,
                    back_flush=d.back_flush,
                    scrap_rate=_to_float(d.scrap_rate),
                    oper_sn=d.oper_sn,
                    process_id=d.process_id,
                    warehouse_id=d.warehouse_id,
                    valid_date=d.valid_date,
                    invalid_date=d.invalid_date,
                    kit_flag=d.kit_flag,
                    req_qty=_to_float(req_qty_decimal),
                    level=level,
                    bom_id=d.bom_id,
                    parent_material_id=parent_mid,
                    has_sub_bom=sub_bom is not None,
                    children=[],
                )
                if parent_key is None:
                    top_keys.append(key)
                else:
                    parent_links.append((parent_key, key))

                if sub_bom and sub_bom.bom_id not in visited:
                    next_factor = req_qty_decimal or Decimal("0")
                    next_queue.append((
                        sub_bom.bom_id,
                        next_factor,
                        d.material_id,
                        key,
                        level + 1,
                    ))

        queue = next_queue

    for parent_key, child_key in parent_links:
        parent_node = node_by_key.get(parent_key)
        if parent_node is not None and child_key in node_by_key:
            parent_node.children.append(node_by_key[child_key])

    top_nodes = [node_by_key[k] for k in top_keys]
    _sort_bom_tree(top_nodes)
    return top_nodes
