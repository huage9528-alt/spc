# 库存看板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新增 `/inventory-board` 路由，在物料中心菜单下挂载"库存看板"页面，展示原料库存总量/分布/库龄/低库存 Top N 与盘点 KPI/我的任务/盘点趋势/近期差异。

**Architecture:**
- **后端**：FastAPI 路由（`/api/v1/material/inventory-board/*`），service 层聚合 `scm_inventory` + `scm_inventory_check` + `scm_inventory_check_item`，全部走 async SQLAlchemy；不复用任何缓存。
- **前端**：单页双 Tab（库存概览 / 盘点明细），Ant Design 5 + `@ant-design/charts` 复用现有图表风格；筛选条作用于 Tab1 全部。
- **权限**：新增资源 `inventory_board`，read 授权给 admin / manager / purchase_manager / purchaser / planner；不向 supplier 开放。

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy 2.0 async / Pydantic 2 / React 18 / TypeScript / Ant Design 5 / @ant-design/charts / Tailwind / Zustand

## Global Constraints

来自 `AGENTS.md` 与设计文档（[2026-09-15-inventory-board-design.md](../specs/2026-09-15-inventory-board-design.md)）：

1. **响应包络**：后端接口必须返回 `{ code, message, data }`（`app/schemas/common.py` 的 `ResponseModel` / `PageResult`）。
2. **路由前缀**：所有 v1 接口挂在 `/api/v1`（已在 `app/main.py` 设置），子模块自取 prefix。
3. **数据库 schema**：新列必须同时进 SQLAlchemy 模型 **和** `backend/init_database.py` 的 `migrate_columns` 表；本次未新增列。
4. **聚合 SQL 不上 Redis 缓存**，先观察性能；如超时再加。
5. **权限模型**：`permission_registry.py` 中 `declare_permission(...)` 声明资源；`app/core/permissions.py` 中 `ROLE_PERMISSION_ADDITIONS` 给角色授权动作；启动时（`lifespan`）会自动 sync 到 DB。
6. **角色 code**（DB sys_role.role_code）：`admin` / `planner` / `purchaser` / `manager` / `purchase_manager` / `supplier`。登录用户名是 `planner01` / `purchaser01` / `manager01` 等，**不是 role_code**，授权要写到 `ROLE_PERMISSION_ADDITIONS` 时按 role_code 走。
7. **Typecheck only**：`cd frontend && npm run build` 是项目唯一的 typecheck，没有 lint / test / format。
8. **Decimal / datetime 安全**：`main.py` 用 `SafeJSONResponse`，不要绕过。
9. **共享前端约定**：`baseURL='/api/v1'`、Zustand auth/permission store、Ant Design `Spin` + `Empty` 处理加载/空态、`@/services/api` 单一 axios 实例。
10. **图表组件**：使用 `@ant-design/charts`（项目已有 Pie / Bar 用法见 `StockCheck/components/StatsCharts.tsx`）。

---

## Phase 1 — 后端基础（schemas + service）

### Task 1.1 — 创建 Pydantic Schemas

**文件**：`backend/app/schemas/material/inventory_board.py`（新增）

**完整代码**：

```python
"""库存看板 — Pydantic Schemas"""

from datetime import date
from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel


class InventoryBoardKpi(BaseModel):
    material_count: int
    total_qty: Decimal
    total_value: Decimal
    warehouse_count: int


class WarehouseStockRow(BaseModel):
    warehouse_id: int
    warehouse_name: str
    material_count: int
    total_qty: Decimal
    total_value: Decimal


class CategoryStockRow(BaseModel):
    category: str
    material_count: int
    total_qty: Decimal
    total_value: Decimal


class AgingBucket(BaseModel):
    bucket: str
    material_count: int
    total_qty: Decimal
    total_value: Decimal


class LowStockRow(BaseModel):
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    warehouse_name: Optional[str] = None
    qty_on_hand: Decimal
    unit: Optional[str] = None


class StockCheckBoardKpi(BaseModel):
    active_checks: int
    month_completion_rate: float
    month_profit_qty: Decimal
    month_loss_qty: Decimal


class ActiveCheckRow(BaseModel):
    check_id: int
    check_no: str
    status: str
    total_materials: int
    checked_materials: int
    completion_rate: float
    check_date: date
    age_days: int
    created_by: Optional[str] = None
    order_no: Optional[str] = None


class StockCheckTrendPoint(BaseModel):
    date: date
    checks_completed: int
    diff_items_count: int
    total_diff_qty: Decimal


class RecentDiffRow(BaseModel):
    check_no: str
    check_date: date
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit: Optional[str] = None
    system_qty: Decimal
    actual_qty: Optional[Decimal] = None
    diff_qty: Optional[Decimal] = None


class InventoryOverviewResponse(BaseModel):
    kpi: InventoryBoardKpi
    by_warehouse: List[WarehouseStockRow]
    by_category: List[CategoryStockRow]
    aging: List[AgingBucket]
    low_stock: List[LowStockRow]
    warehouses: List[dict]  # 用于筛选条下拉 [{id, name}]
    categories: List[str]  # 用于筛选条下拉（distinct material_type）
```

**验证**：
```bash
cd backend && python -c "from app.schemas.material.inventory_board import InventoryBoardKpi; print(InventoryBoardKpi.model_json_schema())"
```
预期：打印 JSON Schema 不报错。

**提交**：`feat(inventory-board): add pydantic schemas`

---

### Task 1.2 — Service：库存聚合（KPI/仓库/类别/库龄/低库存）

**文件**：`backend/app/services/material/inventory_board_service.py`（新增）

**完整代码**：

```python
"""库存看板 — 库存聚合查询 service"""

from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional, Tuple

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
    now = datetime.now(timezone.utc)
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
```

**验证**：
```bash
cd backend && python -c "from app.services.material.inventory_board_service import get_inventory_overview; print('OK')"
```
预期：输出 `OK`。

**提交**：`feat(inventory-board): add inventory aggregation service`

---

### Task 1.3 — Service：盘点聚合（KPI/盘点单列表/趋势/近期差异）

**同文件追加**：`backend/app/services/material/inventory_board_service.py`（在末尾追加）

**完整代码**（追加在文件末尾）：

```python
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
    today_dt = datetime.now(timezone.utc)
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
```

**验证**：
```bash
cd backend && python -c "from app.services.material.inventory_board_service import get_stock_check_overview; print('OK')"
```
预期：输出 `OK`。

**提交**：`feat(inventory-board): add stock check aggregation service`

---

## Phase 2 — 后端路由 + 权限

### Task 2.1 — 创建 API 路由文件

**文件**：`backend/app/api/v1/material/inventory_board.py`（新增）

**完整代码**：

```python
"""库存看板 — API 路由"""

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.schemas.common import ResponseModel
from app.schemas.material.inventory_board import InventoryOverviewResponse
from app.services.material.inventory_board_service import (
    get_inventory_overview,
    get_stock_check_overview,
)

router = APIRouter()


@router.get("/overview", response_model=ResponseModel[InventoryOverviewResponse])
async def inventory_overview(
    warehouse_id: Optional[int] = Query(None, description="仓库 ID 筛选"),
    category: Optional[str] = Query(None, description="物料类别筛选"),
    current_user: dict = Depends(PermissionChecker("inventory_board", "read")),
    db: AsyncSession = Depends(get_db),
):
    """库存看板 — 库存概览（KPI + 仓库/类别分布 + 库龄 + 低库存 + 筛选下拉）"""
    data = await get_inventory_overview(db, warehouse_id=warehouse_id, category=category)
    return ResponseModel(data=InventoryOverviewResponse(**data))


@router.get("/stock-check", response_model=ResponseModel[dict])
async def stock_check_overview(
    trend_days: int = Query(30, ge=1, le=180),
    active_limit: int = Query(20, ge=1, le=100),
    diff_limit: int = Query(20, ge=1, le=100),
    current_user: dict = Depends(PermissionChecker("inventory_board", "read")),
    db: AsyncSession = Depends(get_db),
):
    """库存看板 — 盘点概览（KPI + 进行中盘点单 + 趋势 + 近期差异）"""
    data = await get_stock_check_overview(
        db,
        trend_days=trend_days,
        active_limit=active_limit,
        diff_limit=diff_limit,
    )
    return ResponseModel(data=data)
```

**验证**：
```bash
cd backend && python -c "from app.api.v1.material.inventory_board import router; print(len(router.routes), 'routes')"
```
预期：`2 routes`。

**提交**：`feat(inventory-board): add api routes`

---

### Task 2.2 — 在 `material/__init__.py` 注册新路由

**修改**：`backend/app/api/v1/material/__init__.py`

**变更**：在文件末尾追加：

```python
from app.api.v1.material.inventory_board import router as inventory_board_router
```

**验证**：
```bash
cd backend && python -c "from app.api.v1.material import inventory_board_router; print('imported')"
```
预期：`imported`。

---

### Task 2.3 — 在 `api/v1/__init__.py` 挂载路由

**修改**：`backend/app/api/v1/__init__.py`

**变更**：在 `# Material center` 区块（line 16-27 附近）的合适位置追加一行（建议放在 `scrap_inventory_router` 之后）：

```python
api_router.include_router(material.inventory_board_router, prefix="/materials/inventory-board", tags=["物料齐套中心-库存看板"])
```

**验证**：
```bash
cd backend && python -c "from app.api.v1 import api_router; routes = [r.path for r in api_router.routes if hasattr(r, 'path')]; import sys; sys.exit(0 if any('/materials/inventory-board' in p for p in routes) else 1); print('mounted')"
```
预期：输出 `mounted`。

**提交**：`feat(inventory-board): wire api router`

---

### Task 2.4 — 注册权限资源

**修改**：`backend/app/core/permission_registry.py`

**变更**：在 `# 物料齐套中心` 区块（line 178-189）末尾追加一行：

```python
declare_permission("materials.inventory_board", "库存看板", module="materials", parent_code="materials", route_path="/inventory-board", sort_order=11)
```

> 注意：`sort_order` 接 `materials.scrap_inventory`（=10）之后；放最后位置以保持向后兼容。

**验证**：
```bash
cd backend && python -c "from app.core.permission_registry import get_all_declared_permissions; print('materials.inventory_board' in get_all_declared_permissions())"
```
预期：`True`。

**提交**：`feat(inventory-board): register permission resource`

---

### Task 2.5 — 授权给角色

**修改**：`backend/app/core/permissions.py`

**变更**：在 `ROLE_PERMISSION_ADDITIONS` 字典的对应角色行追加 `materials.inventory_board`：

- `admin` 行（line 9-20）：在末尾 `}` 前加 `"materials.inventory_board": ["read"],` （admin 通过角色管理可拿到 manage，但 init 时只放 read 是惯例，保持权限位最低开放；`purchaser` / `planner` / `manager` / `purchase_manager` 同理）
- `planner` 行（line 21-26）：追加 `"materials.inventory_board": ["read"],`
- `purchaser` 行（line 27-30）：追加 `"materials.inventory_board": ["read"],`
- `manager` 行（line 31-43）：追加 `"materials.inventory_board": ["read"],`
- `purchase_manager` 行（line 50-52）：追加 `"materials.inventory_board": ["read"],`

完整后该字典应类似：

```python
ROLE_PERMISSION_ADDITIONS: Dict[str, Dict[str, List[str]]] = {
    "admin": {
        "production.schedule_plans": FULL_ACTIONS,
        ... (原有项)
        "deploy_versions": ["read", "manage"],
        "materials.inventory_board": ["read"],
    },
    "planner": {
        ... (原有项)
        "materials.task_stock_check": ["read"],
        "materials.inventory_board": ["read"],
    },
    "purchaser": {
        ... (原有项)
        "materials.task_stock_check": ["read"],
        "materials.inventory_board": ["read"],
    },
    "manager": {
        ... (原有项)
        "materials.task_stock_check": ["read"],
        "materials.inventory_board": ["read"],
    },
    "warehouse_Keeper": { ... },  # 不动
    "quality": { ... },            # 不动
    "purchase_manager": {
        "materials.task_stock_check": ["read"],
        "materials.inventory_board": ["read"],
    },
}
```

**验证**：
```bash
cd backend && python -c "from app.core.permissions import ROLE_PERMISSION_ADDITIONS; print('purchaser' in ROLE_PERMISSION_ADDITIONS and 'materials.inventory_board' in ROLE_PERMISSION_ADDITIONS['purchaser'])"
```
预期：`True`。

**提交**：`feat(inventory-board): grant read to admin/planner/purchaser/manager/purchase_manager`

---

### Task 2.6 — 后端冒烟（数据库可达时）

**前置**：本地 `python init_database.py` 已执行；`.env.local` 配置可达的 Postgres。

```bash
cd backend && uvicorn app.main:app --reload --port 8000 &
sleep 5
curl -s -X POST http://localhost:8000/api/v1/basicdata/auth/login -d "username=admin&password=admin123&login_type=employee" -H "Content-Type: application/x-www-form-urlencoded" | python -c "import sys,json; d=json.load(sys.stdin); print(d['data']['access_token'])" > /tmp/tok
TOK=$(cat /tmp/tok)
curl -s -H "Authorization: Bearer $TOK" http://localhost:8000/api/v1/materials/inventory-board/overview | python -m json.tool | head -30
curl -s -H "Authorization: Bearer $TOK" http://localhost:8000/api/v1/materials/inventory-board/stock-check | python -m json.tool | head -30
```

预期：两次都返回 `{"code":0,"message":"ok","data":{...}}`，data 结构与设计文档 §4 一致。

**无数据库时跳过**，仅执行 `python -c "import app.api.v1.material.inventory_board"` 不报错即可。

---

## Phase 3 — 前端基础设施

### Task 3.1 — 新增 API Client

**修改**：`frontend/src/services/api.ts`

**变更**：在文件末尾、`}` 关闭前追加 `inventoryBoardApi`：

```ts
export const inventoryBoardApi = {
  getOverview: (params?: { warehouse_id?: number; category?: string }) =>
    api.get('/materials/inventory-board/overview', { params }),
  getStockCheck: (params?: { trend_days?: number; active_limit?: number; diff_limit?: number }) =>
    api.get('/materials/inventory-board/stock-check', { params }),
}
```

**验证**：
```bash
cd frontend && npx tsc --noEmit -p . 2>&1 | grep -i "inventoryBoardApi" || echo "OK"
```
预期：`OK`（编译通过无相关错误）。

**提交**：`feat(inventory-board): add api client`

---

### Task 3.2 — 注册路由

**修改**：`frontend/src/App.tsx`

**变更**：在 line 23 附近（紧邻 `ScrapInventory`）追加 import：

```tsx
import InventoryBoard from './pages/MaterialCenter/InventoryBoard'
```

在 line 202 附近（`scrap-inventory` 路由之后）追加 Route：

```tsx
<Route path="inventory-board" element={<InventoryBoard />} />
```

**验证**：
```bash
cd frontend && npx tsc --noEmit -p . 2>&1 | grep -i "InventoryBoard" || echo "OK"
```
预期：`OK`（页面文件尚未创建时会报找不到模块，所以这一步在 Task 4.x 创建 index.tsx 之后才能通过；先继续）。

---

### Task 3.3 — 添加菜单 + 路由映射

**修改**：`frontend/src/layouts/MainLayout.tsx`

**变更**（3 处）：

1. 在 line 218 后追加菜单项：

```tsx
{ key: '/inventory-board', icon: <AppstoreOutlined />, label: '库存看板', permission: 'materials.inventory_board' },
```

2. 在 line 449 后追加（`dynamicPathToGroupKey` 对象内）：

```tsx
'/inventory-board': 'material-center',
```

3. 在 line 519 后追加（`pathToPermission` 路由→权限映射）：

```tsx
'/inventory-board': 'materials.inventory_board',
```

4. （如有 `pathname.startsWith('/inventory-board/')` 检查）追加同样一行。

**验证**：
```bash
cd frontend && npx tsc --noEmit -p . 2>&1 | grep -i "MainLayout" || echo "OK"
```

**提交**：`feat(inventory-board): add menu and route mapping`

---

## Phase 4 — 前端组件

### Task 4.1 — KpiStrip 通用组件

**文件**：`frontend/src/pages/MaterialCenter/InventoryBoard/components/KpiStrip.tsx`（新增）

**完整代码**：

```tsx
import { Spin } from 'antd'

interface KpiItem {
  label: string
  value: string | number
  unit?: string
  tone?: 'default' | 'good' | 'bad' | 'warn'
}

interface Props {
  items: KpiItem[]
  loading?: boolean
}

function fmt(n: string | number): string {
  if (typeof n === 'string') return n
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString()
}

export default function KpiStrip({ items, loading }: Props) {
  return (
    <Spin spinning={!!loading}>
      <div className="grid g4" style={{ gap: 12 }}>
        {items.map((it, i) => (
          <div key={i} className="card stat-card" style={{
            ['--accent' as any]: it.tone === 'good' ? 'var(--brand-500, #10b981)'
              : it.tone === 'bad' ? '#ef4444'
              : it.tone === 'warn' ? '#f59e0b'
              : 'var(--brand-500, #3b82f6)',
            ['--accent-bg' as any]: it.tone === 'good' ? '#ecfdf5'
              : it.tone === 'bad' ? '#fef2f2'
              : it.tone === 'warn' ? '#fffbeb'
              : '#eff6ff',
          }}>
            <div className="stat-main">
              <div className="label">{it.label}</div>
              <div className="value">
                {fmt(it.value)}
                {it.unit && <small style={{ marginLeft: 4 }}>{it.unit}</small>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Spin>
  )
}
```

**验证**：在 Task 4.7 中整体编译。

---

### Task 4.2 — ByWarehouseChart

**文件**：`frontend/src/pages/MaterialCenter/InventoryBoard/components/ByWarehouseChart.tsx`（新增）

**完整代码**：

```tsx
import { Empty, Spin } from 'antd'
import { Bar } from '@ant-design/charts'

interface Row {
  warehouse_id: number
  warehouse_name: string
  material_count: number
  total_qty: number
  total_value: number
}

interface Props {
  data: Row[]
  loading?: boolean
}

export default function ByWarehouseChart({ data, loading }: Props) {
  const chartData = (data || []).slice(0, 15).map((d) => ({
    warehouse: d.warehouse_name,
    value: Number(d.total_value) || 0,
  }))
  return (
    <Spin spinning={!!loading}>
      <div className="card" style={{ padding: 16, height: '100%' }}>
        <h3 className="text-sm font-semibold m-0 mb-3" style={{ color: '#475569' }}>按仓库库存金额 Top 15</h3>
        {chartData.length > 0 ? (
          <Bar
            data={chartData}
            xField="value"
            yField="warehouse"
            colorField="warehouse"
            legend={false}
            barStyle={{ radius: [0, 4, 4, 0] }}
            axis={{ x: { label: { style: { fontSize: 10 } } }, y: { label: { style: { fontSize: 10 }, autoEllipsis: true } } }}
            tooltip={{ items: [{ name: '金额', field: 'value' }] }}
            height={260}
          />
        ) : (
          <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty description={loading ? '加载中…' : '暂无数据'} />
          </div>
        )}
      </div>
    </Spin>
  )
}
```

---

### Task 4.3 — ByCategoryChart

**文件**：`frontend/src/pages/MaterialCenter/InventoryBoard/components/ByCategoryChart.tsx`（新增）

**完整代码**：

```tsx
import { Empty, Spin } from 'antd'
import { Pie } from '@ant-design/charts'

interface Row {
  category: string
  material_count: number
  total_qty: number
  total_value: number
}

interface Props {
  data: Row[]
  loading?: boolean
}

export default function ByCategoryChart({ data, loading }: Props) {
  const chartData = (data || []).slice(0, 10).map((d) => ({
    type: d.category,
    value: Number(d.total_value) || 0,
  }))
  return (
    <Spin spinning={!!loading}>
      <div className="card" style={{ padding: 16, height: '100%' }}>
        <h3 className="text-sm font-semibold m-0 mb-3" style={{ color: '#475569' }}>按物料类别金额占比 Top 10</h3>
        {chartData.length > 0 ? (
          <Pie
            data={chartData}
            angleField="value"
            colorField="type"
            radius={0.85}
            innerRadius={0.55}
            legend={{ color: { position: 'bottom', layout: { justifyContent: 'center' } } }}
            label={{ text: (d: { type: string; value: number }) => `${d.type}`, style: { fontSize: 11 } }}
            height={260}
          />
        ) : (
          <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty description={loading ? '加载中…' : '暂无数据'} />
          </div>
        )}
      </div>
    </Spin>
  )
}
```

---

### Task 4.4 — AgingChart

**文件**：`frontend/src/pages/MaterialCenter/InventoryBoard/components/AgingChart.tsx`（新增）

**完整代码**：

```tsx
import { Empty, Spin } from 'antd'
import { Column } from '@ant-design/charts'

interface Bucket {
  bucket: string
  material_count: number
  total_qty: number
  total_value: number
}

interface Props {
  data: Bucket[]
  loading?: boolean
}

export default function AgingChart({ data, loading }: Props) {
  const chartData = (data || []).map((d) => ({
    bucket: d.bucket,
    value: Number(d.total_value) || 0,
  }))
  return (
    <Spin spinning={!!loading}>
      <div className="card" style={{ padding: 16, height: '100%' }}>
        <h3 className="text-sm font-semibold m-0 mb-3" style={{ color: '#475569' }}>库龄分布（按库存金额）</h3>
        {chartData.length > 0 ? (
          <Column
            data={chartData}
            xField="bucket"
            yField="value"
            colorField="bucket"
            legend={false}
            columnStyle={{ radius: [4, 4, 0, 0] }}
            axis={{ x: { label: { style: { fontSize: 11 } } }, y: { label: { style: { fontSize: 10 } } } }}
            tooltip={{ items: [{ name: '金额', field: 'value' }] }}
            height={260}
          />
        ) : (
          <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty description={loading ? '加载中…' : '暂无数据'} />
          </div>
        )}
      </div>
    </Spin>
  )
}
```

---

### Task 4.5 — LowStockList

**文件**：`frontend/src/pages/MaterialCenter/InventoryBoard/components/LowStockList.tsx`（新增）

**完整代码**：

```tsx
import { Empty, Spin, Table } from 'antd'

interface Row {
  material_code?: string
  material_name?: string
  warehouse_name?: string
  qty_on_hand: number
  unit?: string
}

interface Props {
  data: Row[]
  loading?: boolean
}

export default function LowStockList({ data, loading }: Props) {
  return (
    <Spin spinning={!!loading}>
      <div className="card" style={{ padding: 16, height: '100%' }}>
        <h3 className="text-sm font-semibold m-0 mb-3" style={{ color: '#475569' }}>低库存 Top 10</h3>
        <Table<Row>
          size="small"
          rowKey={(r, i) => `${r.material_code}-${r.warehouse_name}-${i}`}
          dataSource={data || []}
          pagination={false}
          locale={{ emptyText: <Empty description={loading ? '加载中…' : '暂无数据'} /> }}
          columns={[
            { title: '物料编码', dataIndex: 'material_code', width: 120, ellipsis: true },
            { title: '物料名称', dataIndex: 'material_name', ellipsis: true },
            { title: '仓库', dataIndex: 'warehouse_name', width: 100, ellipsis: true },
            {
              title: '在库量',
              dataIndex: 'qty_on_hand',
              width: 100,
              align: 'right',
              render: (v: number, r) => <span style={{ color: '#ef4444', fontWeight: 600 }}>{(Number(v) || 0).toLocaleString()}{r.unit ? ` ${r.unit}` : ''}</span>,
            },
          ]}
        />
      </div>
    </Spin>
  )
}
```

---

### Task 4.6 — ActiveChecksTable

**文件**：`frontend/src/pages/MaterialCenter/InventoryBoard/components/ActiveChecksTable.tsx`（新增）

**完整代码**：

```tsx
import { useNavigate } from 'react-router-dom'
import { Empty, Progress, Spin, Table, Tag, Tooltip } from 'antd'

interface Row {
  check_id: number
  check_no: string
  status: string
  total_materials: number
  checked_materials: number
  completion_rate: number
  check_date: string
  age_days: number
  created_by?: string
  order_no?: string
}

interface Props {
  data: Row[]
  loading?: boolean
}

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  open: { color: 'blue', text: '待开始' },
  in_progress: { color: 'gold', text: '进行中' },
}

export default function ActiveChecksTable({ data, loading }: Props) {
  const navigate = useNavigate()
  return (
    <Spin spinning={!!loading}>
      <div className="card" style={{ padding: 16 }}>
        <h3 className="text-sm font-semibold m-0 mb-3" style={{ color: '#475569' }}>进行中盘点单</h3>
        <Table<Row>
          size="small"
          rowKey="check_id"
          dataSource={data || []}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          locale={{ emptyText: <Empty description={loading ? '加载中…' : '暂无进行中盘点单'} /> }}
          onRow={(r) => ({ onClick: () => navigate(`/stock-check/${r.check_id}`), style: { cursor: 'pointer' } })}
          columns={[
            { title: '盘点单号', dataIndex: 'check_no', width: 160, ellipsis: true },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (s: string) => <Tag color={STATUS_TAG[s]?.color}>{STATUS_TAG[s]?.text || s}</Tag>,
            },
            { title: '关联订单', dataIndex: 'order_no', width: 130, ellipsis: true },
            {
              title: '进度',
              width: 200,
              render: (_, r) => (
                <Tooltip title={`${r.checked_materials}/${r.total_materials}`}>
                  <Progress percent={Math.round((r.completion_rate || 0) * 100)} size="small" status="active" />
                </Tooltip>
              ),
            },
            {
              title: '已盘/应盘',
              width: 110,
              align: 'right',
              render: (_, r) => `${r.checked_materials}/${r.total_materials}`,
            },
            { title: '盘点日期', dataIndex: 'check_date', width: 110 },
            { title: '创建人', dataIndex: 'created_by', width: 100, ellipsis: true },
            {
              title: '已存续',
              dataIndex: 'age_days',
              width: 80,
              align: 'right',
              render: (n: number) => <span style={{ color: n > 7 ? '#f59e0b' : '#64748b' }}>{n} 天</span>,
            },
          ]}
        />
      </div>
    </Spin>
  )
}
```

---

### Task 4.7 — StockCheckTrend

**文件**：`frontend/src/pages/MaterialCenter/InventoryBoard/components/StockCheckTrend.tsx`（新增）

**完整代码**：

```tsx
import { Empty, Spin } from 'antd'
import { Line } from '@ant-design/charts'

interface Point {
  date: string
  checks_completed: number
  diff_items_count: number
  total_diff_qty: number
}

interface Props {
  data: Point[]
  loading?: boolean
}

export default function StockCheckTrend({ data, loading }: Props) {
  const chartData = (data || []).flatMap((d) => [
    { date: d.date, type: '完成盘点单', value: d.checks_completed },
    { date: d.date, type: '差异行数', value: d.diff_items_count },
  ])
  return (
    <Spin spinning={!!loading}>
      <div className="card" style={{ padding: 16 }}>
        <h3 className="text-sm font-semibold m-0 mb-3" style={{ color: '#475569' }}>盘点趋势（最近 30 天）</h3>
        {chartData.length > 0 ? (
          <Line
            data={chartData}
            xField="date"
            yField="value"
            colorField="type"
            shapeField="smooth"
            point={{ shapeField: 'circle', sizeField: 3 }}
            axis={{ x: { label: { style: { fontSize: 10 } } }, y: { label: { style: { fontSize: 10 } } } }}
            height={260}
          />
        ) : (
          <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty description={loading ? '加载中…' : '暂无数据'} />
          </div>
        )}
      </div>
    </Spin>
  )
}
```

---

### Task 4.8 — RecentDiffsTable

**文件**：`frontend/src/pages/MaterialCenter/InventoryBoard/components/RecentDiffsTable.tsx`（新增）

**完整代码**：

```tsx
import { Empty, Spin, Table, Tag } from 'antd'

interface Row {
  check_no: string
  check_date: string
  material_code?: string
  material_name?: string
  spec_model?: string
  unit?: string
  system_qty: number
  actual_qty?: number | null
  diff_qty?: number | null
}

interface Props {
  data: Row[]
  loading?: boolean
}

function fmt(n?: number | null): string {
  if (n == null) return '—'
  return Number(n).toLocaleString()
}

export default function RecentDiffsTable({ data, loading }: Props) {
  return (
    <Spin spinning={!!loading}>
      <div className="card" style={{ padding: 16 }}>
        <h3 className="text-sm font-semibold m-0 mb-3" style={{ color: '#475569' }}>近期差异 Top 20</h3>
        <Table<Row>
          size="small"
          rowKey={(r, i) => `${r.check_no}-${r.material_code}-${i}`}
          dataSource={data || []}
          pagination={false}
          locale={{ emptyText: <Empty description={loading ? '加载中…' : '暂无差异'} /> }}
          scroll={{ x: 900 }}
          columns={[
            { title: '盘点单号', dataIndex: 'check_no', width: 160, ellipsis: true, fixed: 'left' },
            { title: '日期', dataIndex: 'check_date', width: 110 },
            { title: '物料编码', dataIndex: 'material_code', width: 120, ellipsis: true },
            { title: '物料名称', dataIndex: 'material_name', ellipsis: true },
            { title: '规格', dataIndex: 'spec_model', width: 140, ellipsis: true },
            { title: '系统', dataIndex: 'system_qty', width: 90, align: 'right', render: fmt },
            { title: '实盘', dataIndex: 'actual_qty', width: 90, align: 'right', render: fmt },
            {
              title: '差异',
              dataIndex: 'diff_qty',
              width: 110,
              align: 'right',
              render: (v: number | null | undefined, r) => {
                if (v == null) return '—'
                const positive = Number(v) >= 0
                return (
                  <Tag color={positive ? 'green' : 'red'}>
                    {positive ? '+' : ''}{fmt(v)}{r.unit ? ` ${r.unit}` : ''}
                  </Tag>
                )
              },
            },
          ]}
        />
      </div>
    </Spin>
  )
}
```

---

### Task 4.9 — OverviewTab 组合组件

**文件**：`frontend/src/pages/MaterialCenter/InventoryBoard/OverviewTab.tsx`（新增）

**完整代码**：

```tsx
import { useEffect, useState } from 'react'
import { Select } from 'antd'
import KpiStrip from './components/KpiStrip'
import ByWarehouseChart from './components/ByWarehouseChart'
import ByCategoryChart from './components/ByCategoryChart'
import AgingChart from './components/AgingChart'
import LowStockList from './components/LowStockList'
import { inventoryBoardApi } from '@/services/api'

interface OverviewData {
  kpi: {
    material_count: number
    total_qty: number
    total_value: number
    warehouse_count: number
  }
  by_warehouse: any[]
  by_category: any[]
  aging: any[]
  low_stock: any[]
  warehouses: { id: number; name: string }[]
  categories: string[]
}

interface Props {
  onLoadingChange?: (loading: boolean) => void
}

export default function OverviewTab({ onLoadingChange }: Props) {
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [warehouseId, setWarehouseId] = useState<number | undefined>()
  const [category, setCategory] = useState<string | undefined>()

  const fetchData = async () => {
    setLoading(true)
    onLoadingChange?.(true)
    try {
      const res: any = await inventoryBoardApi.getOverview({
        warehouse_id: warehouseId,
        category,
      })
      setData(res.data)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
      onLoadingChange?.(false)
    }
  }

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId, category])

  return (
    <div>
      {/* 筛选条 */}
      <div className="card mb12" style={{ padding: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ color: '#475569', fontSize: 13 }}>仓库:</span>
        <Select
          allowClear
          placeholder="全部仓库"
          style={{ width: 180 }}
          value={warehouseId}
          onChange={(v) => setWarehouseId(v)}
          options={(data?.warehouses || []).map((w) => ({ label: w.name, value: w.id }))}
        />
        <span style={{ color: '#475569', fontSize: 13 }}>物料类别:</span>
        <Select
          allowClear
          placeholder="全部类别"
          style={{ width: 180 }}
          value={category}
          onChange={(v) => setCategory(v)}
          options={(data?.categories || []).map((c) => ({ label: c, value: c }))}
        />
      </div>

      {/* KPI */}
      <KpiStrip
        loading={loading}
        items={[
          { label: '物料种类', value: data?.kpi.material_count ?? 0, unit: '种' },
          { label: '库存总量', value: data?.kpi.total_qty ?? 0, unit: '' },
          { label: '库存金额', value: data?.kpi.total_value ?? 0, unit: '¥' },
          { label: '覆盖仓库', value: data?.kpi.warehouse_count ?? 0, unit: '个' },
        ]}
      />

      {/* 图表区 */}
      <div className="grid g2 mt12">
        <ByWarehouseChart data={data?.by_warehouse || []} loading={loading} />
        <AgingChart data={data?.aging || []} loading={loading} />
      </div>
      <div className="grid g2 mt12">
        <ByCategoryChart data={data?.by_category || []} loading={loading} />
        <LowStockList data={data?.low_stock || []} loading={loading} />
      </div>
    </div>
  )
}
```

---

### Task 4.10 — StockCheckTab 组合组件

**文件**：`frontend/src/pages/MaterialCenter/InventoryBoard/StockCheckTab.tsx`（新增）

**完整代码**：

```tsx
import { useEffect, useState } from 'react'
import { Empty, Spin, Table, Tag } from 'antd'
import KpiStrip from './components/KpiStrip'
import ActiveChecksTable from './components/ActiveChecksTable'
import StockCheckTrend from './components/StockCheckTrend'
import RecentDiffsTable from './components/RecentDiffsTable'
import { inventoryBoardApi, materialApi } from '@/services/api'

interface OverviewData {
  kpi: {
    active_checks: number
    month_completion_rate: number
    month_profit_qty: number
    month_loss_qty: number
  }
  active_checks: any[]
  trend: any[]
  recent_diffs: any[]
}

interface Props {
  onLoadingChange?: (loading: boolean) => void
}

export default function StockCheckTab({ onLoadingChange }: Props) {
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [myTasks, setMyTasks] = useState<any[]>([])
  const [myLoading, setMyLoading] = useState(false)

  const fetchOverview = async () => {
    setLoading(true)
    onLoadingChange?.(true)
    try {
      const res: any = await inventoryBoardApi.getStockCheck()
      setData(res.data)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
      onLoadingChange?.(false)
    }
  }

  const fetchMyTasks = async () => {
    setMyLoading(true)
    try {
      const res: any = await materialApi.listMyStockCheckItems({ page: 1, page_size: 20 })
      setMyTasks(res.data?.items || [])
    } catch {
      setMyTasks([])
    } finally {
      setMyLoading(false)
    }
  }

  useEffect(() => {
    fetchOverview()
    fetchMyTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div>
      {/* KPI */}
      <KpiStrip
        loading={loading}
        items={[
          { label: '进行中盘点单', value: data?.kpi.active_checks ?? 0, unit: '单' },
          {
            label: '本月完成率',
            value: data ? `${Math.round((data.kpi.month_completion_rate || 0) * 100)}%` : '—',
            tone: (data?.kpi.month_completion_rate ?? 0) >= 0.8 ? 'good' : (data?.kpi.month_completion_rate ?? 0) >= 0.5 ? 'warn' : 'bad',
          },
          { label: '本月盘盈', value: data?.kpi.month_profit_qty ?? 0, tone: 'good' },
          { label: '本月盘亏', value: data?.kpi.month_loss_qty ?? 0, tone: 'bad' },
        ]}
      />

      <div className="grid g2-1 mt12">
        {/* 我的盘点任务 */}
        <div className="card" style={{ padding: 16 }}>
          <h3 className="text-sm font-semibold m-0 mb-3" style={{ color: '#475569' }}>我的盘点任务</h3>
          <Spin spinning={myLoading}>
            <Table
              size="small"
              rowKey="id"
              dataSource={myTasks}
              pagination={false}
              locale={{ emptyText: <Empty description={myLoading ? '加载中…' : '暂无待盘点任务'} /> }}
              columns={[
                { title: '盘点单号', dataIndex: 'check_no', width: 140, ellipsis: true },
                { title: '物料', dataIndex: 'material_name', ellipsis: true },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 90,
                  render: (s: string) => <Tag color={s === 'counted' ? 'green' : 'blue'}>{s === 'counted' ? '已盘' : '待盘'}</Tag>,
                },
                { title: '应盘', dataIndex: 'req_qty', width: 80, align: 'right' },
                { title: '实盘', dataIndex: 'actual_qty', width: 80, align: 'right', render: (v: any) => v ?? '—' },
              ]}
            />
          </Spin>
        </div>
        <ActiveChecksTable data={data?.active_checks || []} loading={loading} />
      </div>

      <div className="mt12">
        <StockCheckTrend data={data?.trend || []} loading={loading} />
      </div>

      <div className="mt12">
        <RecentDiffsTable data={data?.recent_diffs || []} loading={loading} />
      </div>
    </div>
  )
}
```

**注**：以上代码用了 `materialApi.listMyStockCheckItems`，该方法在 `frontend/src/services/api.ts` 中已存在（参考 `stock-check/my-items` 已实现的客户端方法）；若实际方法名不同，改为对应名称即可。

---

### Task 4.11 — 页面入口 index.tsx

**文件**：`frontend/src/pages/MaterialCenter/InventoryBoard/index.tsx`（新增）

**完整代码**：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Tabs, Button } from 'antd'
import OverviewTab from './OverviewTab'
import StockCheckTab from './StockCheckTab'

type TabKey = 'overview' | 'stock_check'

const REFRESH_OVERVIEW = 30 * 60 * 1000  // 30 分钟
const REFRESH_CHECK = 5 * 60 * 1000      // 5 分钟

export default function InventoryBoard() {
  const [tab, setTab] = useState<TabKey>('overview')
  const [refreshKey, setRefreshKey] = useState(0)
  const [loading, setLoading] = useState(false)

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  // 自动刷新
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    const interval = tab === 'overview' ? REFRESH_OVERVIEW : REFRESH_CHECK
    timerRef.current = setInterval(() => setRefreshKey((k) => k + 1), interval)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [tab])

  return (
    <div>
      <div className="card mb12" style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as TabKey)}
          items={[
            { key: 'overview', label: '库存概览' },
            { key: 'stock_check', label: '盘点明细' },
          ]}
          style={{ flex: 1 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {loading && <span style={{ fontSize: 12, color: '#94a3b8' }}>加载中…</span>}
          <Button size="small" onClick={handleRefresh}>刷新</Button>
        </div>
      </div>

      <div key={`${tab}-${refreshKey}`}>
        {tab === 'overview' ? (
          <OverviewTab onLoadingChange={setLoading} />
        ) : (
          <StockCheckTab onLoadingChange={setLoading} />
        )}
      </div>
    </div>
  )
}
```

---

### Task 4.12 — 整体 Typecheck

```bash
cd frontend && npm run build
```

预期：编译通过，无 TS 错误。

**如果有 `materialApi.listMyStockCheckItems` 命名不匹配**：grep `frontend/src/services/api.ts` 找盘点任务相关方法（很可能是 `getMyStockCheckItems` 或 `listMyStockCheckItems`），改 Task 4.10 的调用为对应方法名。

**提交**：`feat(inventory-board): add frontend page and components`

---

## Phase 5 — 验证

### Task 5.1 — 启动后端 + 前端 dev server，手动烟测

```bash
# 终端 1：后端
cd backend && uvicorn app.main:app --reload --port 8000

# 终端 2：前端
cd frontend && npm run dev
```

**验证步骤**：
1. 打开 `http://localhost:3000/inventory-board`
2. 菜单"物料齐套中心 → 库存看板"可正常显示
3. 默认 Tab 为"库存概览"，KPI / 图表 / 低库存列表渲染
4. 切换"仓库 / 物料类别"筛选，图表与 KPI 联动更新
5. 切换到"盘点明细" Tab：KPI / 表格 / 趋势 / 近期差异渲染
6. 点击"我的盘点任务"行 → 跳转到 `/stock-check/:checkId` 工作台
7. 点击"进行中盘点单"行 → 跳转工作台
8. 刷新按钮可触发数据重新加载
9. 用 `purchaser01` / `manager01` 登录可访问；用 supplier 角色登录访问 `http://localhost:3000/inventory-board` 应被权限拦截或菜单不可见
10. `npm run build` 通过

### Task 5.2 — 检查权限注册生效

`admin` 登录后访问"角色管理" → 应能看到 `库存看板`（`materials.inventory_board`）权限点，且能勾选/取消。

### Task 5.3 — 提交所有改动

```bash
cd D:\wanghuazheng\project\SPC-v2
git status
git add backend/app/schemas/material/inventory_board.py
git add backend/app/services/material/inventory_board_service.py
git add backend/app/api/v1/material/inventory_board.py
git add backend/app/api/v1/material/__init__.py
git add backend/app/api/v1/__init__.py
git add backend/app/core/permission_registry.py
git add backend/app/core/permissions.py
git add frontend/src/services/api.ts
git add frontend/src/App.tsx
git add frontend/src/layouts/MainLayout.tsx
git add frontend/src/pages/MaterialCenter/InventoryBoard/
git commit -m "feat(inventory-board): add inventory board feature (backend API + frontend page)"
```

---

## 验收清单（与设计文档 §9 对齐）

- [ ] `/inventory-board` 路由可访问；未授权用户 403 / 菜单不可见
- [ ] 两个 Tab 独立加载；加载态 / 空态降级 UI 正常
- [ ] 仓库 / 类别筛选作用于 Tab1 全部图表
- [ ] 盘点单 / 我的任务行点击跳转 `/stock-check/:checkId`
- [ ] `purchaser01` / `manager01` 可访问；`supplier_*` 不可访问
- [ ] `cd frontend && npm run build` 通过
- [ ] 后端启动无报错；权限点出现在「角色管理」UI
