"""BOM 多级树 对外接口

为外部系统提供"已组装好的"多级 BOM 树，免去下游自行 BFS 拼装。

组装逻辑直接复用 app.services.order.order_materials_service._expand_bom_tree，
与系统内部订单物料展开口径完全一致：
  - 层级靠 material_id 桥接（BomDetail.material_id → Bom.material_id 反查子 BOM），
    不使用 Bom.parent_bom_id 建树；
  - 需求量纯连乘：req(N) = standard_qty × demand_qty × Π(祖先 standard_qty)，不除 base_qty；
  - visited 防环，MAX_BOM_LEVEL=20 限深；
  - 一物料多 BOM 时优先取「有明细行 / 未作废 / 未禁用 / 已审核」的一条继续展开。

输出两种形态：
  - 默认：嵌套树 tree（节点含 children）
  - flatten=true：扁平列表 items（保留 bom_id / level / parent_material_id 供下游还原关系）
"""

from decimal import Decimal, InvalidOperation
from typing import Annotated, List, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.bom import Bom
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.schemas.common import ResponseModel
from app.schemas.order.schemas import BomDetailItemOut
from app.services.order.order_materials_service import _expand_bom_tree

from ..common import ExternalQuery
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="/boms", tags=["主数据"])


class BomsTreeQuery(ExternalQuery):
    bom_id: str = Field(..., description="顶层 BOM ID（必填），以其为根向下展开多级")
    demand_qty: Optional[str] = Field(None, description="根需求量（订单数量），数字字符串。缺省取根 BOM 的 base_qty，再缺省取 1")
    flatten: Optional[str] = Field(None, description="true/1 时返回扁平列表 items，否则返回嵌套树 tree")


class BomTreeData(BaseModel):
    """BOM 多级树查询结果"""
    bom_id: Optional[str] = Field(None, description="顶层 BOM ID")
    bom_no: Optional[str] = Field(None, description="顶层 BOM 编号")
    material_id: Optional[int] = Field(None, description="顶层物料 id")
    base_qty: Optional[float] = Field(None, description="根 BOM 基础用量")
    demand_qty: Optional[float] = Field(None, description="根需求量")
    bom_version: Optional[str] = Field(None, description="BOM 版本号")
    bom_type: Optional[str] = Field(None, description="BOM 类型")
    flatten: bool = Field(False, description="是否扁平列表形态")
    total_nodes: int = Field(0, description="节点总数")
    max_level: int = Field(0, description="最大层级")
    message: Optional[str] = Field(None, description="提示信息（如未找到 BOM 时）")
    tree: Optional[List[BomDetailItemOut]] = Field(None, description="嵌套树（flatten=false 时返回）")
    items: Optional[List[BomDetailItemOut]] = Field(None, description="扁平列表（flatten=true 时返回，含 bom_id/level/parent_material_id 供还原关系）")


def _to_decimal(value, default: Decimal) -> Decimal:
    if value is None or value == "":
        return default
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return default


def _pick_root_bom(boms: List[Bom]) -> Optional[Bom]:
    """bom_id 唯一，候选至多一条；存在即返回。"""
    return boms[0] if boms else None


async def _resolve_root_bom(db, bom_id: Optional[str]) -> Optional[Bom]:
    """按 bom_id 精确解析顶层 BOM。外部接口仅支持 bom_id 查询（不接受 material_code）。"""
    if not bom_id:
        return None
    result = await db.execute(select(Bom).where(Bom.bom_id == bom_id))
    return _pick_root_bom(list(result.scalars().all()))


def _walk_stats(nodes) -> tuple:
    """DFS 统计节点总数与最大层级。"""
    count = 0
    max_level = 0
    stack = list(nodes)
    while stack:
        n = stack.pop()
        count += 1
        lvl = getattr(n, "level", None) or 0
        if lvl > max_level:
            max_level = lvl
        for c in (getattr(n, "children", None) or []):
            stack.append(c)
    return count, max_level


def _flatten_nodes(nodes) -> list:
    """DFS 拍平树，去掉 children，保留 bom_id/level/parent_material_id 供下游还原关系。"""
    flat: list = []

    def walk(ns):
        for n in ns:
            d = n.model_dump(mode="json")
            d.pop("children", None)
            flat.append(d)
            children = getattr(n, "children", None) or []
            if children:
                walk(children)

    walk(nodes)
    return flat


@router.get("/tree", response_model=ResponseModel[BomTreeData],
            summary="BOM多级树", description="endpoint_code: boms.tree")
@register_external(
    "boms.tree",
    "BOM多级树",
    method="GET",
    path="/boms/tree",
    description="返回已组装好的多级 BOM 树（仅按 bom_id 查询），层级靠 material_id 桥接",
    tags=["主数据"],
)
@log_external_call("boms.tree")
async def boms_tree(
    request: Request,
    q: Annotated[BomsTreeQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("boms.tree")),
):
    """BOM 多级树（外部定制版）

    根需求量缺省取根 BOM 的 base_qty，再缺省取 1；
    子件需求量 = standard_qty × 父级需求量（沿树纯连乘，不除 base_qty）。
    """
    flatten = str(q.flatten if q.flatten is not None else "").lower() in ("1", "true", "yes")

    root_bom = await _resolve_root_bom(db, q.bom_id)
    if not root_bom:
        return {
            "bom_id": q.bom_id,
            "flatten": flatten,
            "total_nodes": 0,
            "max_level": 0,
            "message": "未找到该 bom_id 对应的 BOM",
        }

    # 根需求量：显式参数 > 根 BOM base_qty > 1
    if q.demand_qty not in (None, ""):
        factor = _to_decimal(q.demand_qty, Decimal("1"))
    elif root_bom.base_qty:
        factor = Decimal(str(root_bom.base_qty))
    else:
        factor = Decimal("1")

    tree = await _expand_bom_tree(db, root_bom.bom_id, factor)
    total_nodes, max_level = _walk_stats(tree)

    root_info = {
        "bom_id": root_bom.bom_id,
        "bom_no": root_bom.bom_no,
        "material_id": root_bom.material_id,
        "base_qty": float(root_bom.base_qty) if root_bom.base_qty is not None else None,
        "demand_qty": float(factor),
        "bom_version": root_bom.bom_version,
        "bom_type": root_bom.bom_type,
        "flatten": flatten,
        "total_nodes": total_nodes,
        "max_level": max_level,
    }

    if flatten:
        return {**root_info, "items": _flatten_nodes(tree)}
    return {**root_info, "tree": [n.model_dump(mode="json") for n in tree]}
