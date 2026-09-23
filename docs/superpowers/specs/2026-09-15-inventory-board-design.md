# 库存看板 — 设计文档

**日期**：2026-09-15
**状态**：待评审
**作者**：opencode (brainstorming)

## 1. 背景与目标

仓库管理员、物控/采购主管需要在一个页面集中查看**原料库存总量**和**盘点差异**，支持日常巡检（高频）和周度复盘（中频）两种使用场景。

项目已有的相关模块：

- `MaterialCenter/StockCheck`：盘点单 CRUD、盘点工作台
- `MaterialCenter/StockCheck/components/StatsCharts.tsx`：盘点侧已有统计图组件（可参考复用）
- `Dashboard`：现有驾驶舱，但聚焦订单/出货，不展示库存
- `scm_inventory`：原料即时库存表（基础数据中心）
- `scm_inventory_check` + `scm_inventory_check_item`：盘点单头 + 行项

本次新增一个独立页面 `库存看板`，填补"原料库存"维度的空白。

## 2. 范围

### 2.1 包含

- `/inventory-board` 路由 + 物料中心菜单项
- 库存概览 Tab：物料/仓库/类别/库龄/低库存分析
- 盘点明细 Tab：盘点 KPI、我的任务、盘点趋势、近期差异
- 仓库 / 物料类别双筛选
- 权限模型与角色授权

### 2.2 不包含（YAGNI）

- 库存周转率、ABC 分析
- 实时推送 / SSE
- 库存金额的复杂成本计算（仅 `unit_price × qty_on_hand`）
- 图表导出 / 打印
- 移动端专属布局
- 原料以外的成品 / 半成品库存（待后续独立看板）

## 3. 页面设计

**路由**：`/inventory-board`
**权限点**：`materials.inventory_board.read` / `.manage`（manage 预留）
**菜单位置**：物料中心组下，与"物料盘点 / 任务盘点"并列

### 3.1 整体布局

```
┌──────────────────────────────────────────────────────────┐
│ 库存看板                                                  │
│ [库存概览] [盘点明细]   [仓库 ▾] [物料类别 ▾] [刷新]     │
├──────────────────────────────────────────────────────────┤
│ ─── Tab 1: 库存概览 ───                                  │
│                                                          │
│ [物料总数] [库存总量] [库存金额] [仓库数]                  │
│                                                          │
│ [按仓库分布     ] [库龄分布    ]                          │
│ [按物料类别分布 ] [低库存 Top 10]                         │
│                                                          │
│ ─── Tab 2: 盘点明细 ───                                  │
│                                                          │
│ [进行中盘点单] [本月完成率] [本月盘盈] [本月盘亏]         │
│                                                          │
│ [我的盘点任务 ] [盘点单列表                 ]            │
│ [盘点趋势 30 天 — 全宽                                  ]│
│ [近期差异 Top 20 — 全宽                                  ]│
└──────────────────────────────────────────────────────────┘
```

筛选条作用于 Tab 1 全部图表；Tab 2 不受影响。

### 3.2 Tab 1 — 库存概览

| 区块 | 字段 | 数据源 |
|---|---|---|
| KPI 条 | 物料总数、库存总量、库存金额（¥）、仓库数 | `scm_inventory` |
| 按仓库分布 | 仓库名、物料数、库存总量、库存金额 | `scm_inventory` GROUP BY `wh_id` |
| 库龄分布 | 桶 `0-30d / 31-90d / 91-180d / 180d+` 的物料数 / 库存量 / 库存金额 | 用 `last_inbound_at` 计算 |
| 按物料类别分布 | 类别名、物料数、库存量、库存金额 | JOIN `scm_material.material_type` |
| 低库存 Top 10 | 物料编码 / 名称 / 仓库、库存量 | 按 `qty_on_hand` 升序 LIMIT 10 |

> **库龄算法**：`now() - last_inbound_at`，未入库过的物料（`last_inbound_at IS NULL`）归入 `180d+` 桶（视为长期呆滞）。

### 3.3 Tab 2 — 盘点明细

| 区块 | 字段 | 数据源 |
|---|---|---|
| KPI 条 | 进行中盘点单数、本月完成率、本月盘盈量、本月盘亏量 | `scm_inventory_check` + `scm_inventory_check_item` |
| 我的盘点任务 | check_no、物料编码/名称、应盘/已盘/差异、状态、操作 | 复用 `GET /api/v1/material/stock-check/my-items` |
| 盘点单列表 | check_no、状态、应盘/已盘、完成率、盘点日期、创建人 | `scm_inventory_check` WHERE status IN ('open', 'in_progress') |
| 盘点趋势 30 天 | 日期、完成的盘点单数、差异行数、差异总量 | GROUP BY DATE(check_date) |
| 近期差异 Top 20 | check_no、盘点日期、物料编码/名称/规格、单位、系统数、实盘数、差异数 | `scm_inventory_check_item` WHERE `diff_qty != 0` |

> "我的盘点任务"点击行 → 跳转 `/stock-check/workbench/:checkId`（沿用现有工作台）。

## 4. 后端 API 设计

新增文件 `backend/app/api/v1/material/inventory_board.py`，挂载到 `/api/v1/material/inventory-board`。所有接口权限 `materials.inventory_board.read`。

### 4.1 端点清单

| # | Method & Path | 用途 | 入参 |
|---|---|---|---|
| 1 | `GET /overview-kpi` | Tab1 KPI 条 | `warehouse_id?`, `category?` |
| 2 | `GET /by-warehouse` | 库存按仓库分布 | 同上 |
| 3 | `GET /by-category` | 库存按物料类别分布 | 同上 |
| 4 | `GET /aging` | 库龄分布 | 同上 |
| 5 | `GET /low-stock` | 低库存 Top N | `warehouse_id?`, `category?`, `limit=10` |
| 6 | `GET /stock-check-kpi` | Tab2 KPI 条 | — |
| 7 | `GET /active-checks` | 进行中盘点单 | `limit=20` |
| 8 | `GET /stock-check-trend` | 盘点 30 天趋势 | `days=30` |
| 9 | — | 我的盘点任务 | **前端直接调用** `GET /api/v1/material/stock-check/my-items`（已存在，见 `stock_check.py:567`） |
| 10 | `GET /recent-diffs` | 近期差异 Top N | `limit=20` |

### 4.2 响应约定

遵循项目 ResponseModel 约定：

```python
class ResponseModel(BaseModel):
    code: int = 0
    message: str = "ok"
    data: T
```

### 4.3 关键 Pydantic Schemas（`backend/app/schemas/material/inventory_board.py`）

```python
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
    bucket: str  # "0-30d" | "31-90d" | "91-180d" | "180d+"
    material_count: int
    total_qty: Decimal
    total_value: Decimal

class LowStockRow(BaseModel):
    material_code: str
    material_name: str
    warehouse_name: str
    qty_on_hand: Decimal
    unit: Optional[str]

class StockCheckBoardKpi(BaseModel):
    active_checks: int
    month_completion_rate: float  # 0-1
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
    created_by: Optional[str]
    order_no: Optional[str]

class StockCheckTrendPoint(BaseModel):
    date: date
    checks_completed: int
    diff_items_count: int
    total_diff_qty: Decimal

class RecentDiffRow(BaseModel):
    check_no: str
    check_date: date
    material_code: Optional[str]
    material_name: Optional[str]
    spec_model: Optional[str]
    unit: Optional[str]
    system_qty: Decimal
    actual_qty: Optional[Decimal]
    diff_qty: Optional[Decimal]
```

## 5. 数据源

| 表 | 用途 |
|---|---|
| `scm_inventory` | 即时库存（qty_on_hand / unit_price / last_inbound_at / wh_id / material_id） |
| `scm_material` | 物料名 / 类别（material_type）/ 单位 |
| `scm_inventory_check` | 盘点单头（status / check_date / total_materials / checked_materials） |
| `scm_inventory_check_item` | 盘点行（system_qty / actual_qty / diff_qty / material_code） |

> 库存金额计算：`SUM(qty_on_hand * unit_price)`，单位 Decimal，遵守 SafeJSONResponse 处理。
> 盘点完成率：`checked_materials / total_materials`，单据内计算后返回前端。

## 6. 权限模型

### 6.1 资源与动作

- 资源键：`inventory_board`
- 动作：`read`（查看）、`manage`（预留，目前与 read 一致）

### 6.2 角色授权

在 `backend/init_database.py` 的 `ROLE_PERMISSION_ADDITIONS` 中给以下角色开通 `inventory_board.read`：

- `admin`（默认全通）
- `manager01`（厂长/经理）
- `purchase_mgr01`（采购主管）
- `purchaser01`（采购员）
- `planner01`（计划员）

**不**对 `supplier_*` 系列开通。

### 6.3 前端路由权限映射

在 `frontend/src/store/permission.ts` 中新增：

```ts
'/inventory-board': 'materials.inventory_board',
```

`MainLayout.tsx` 菜单项：

```ts
{ key: '/inventory-board', icon: <AppstoreOutlined />, label: '库存看板', permission: 'materials.inventory_board' }
```

## 7. 刷新与性能

- Tab 懒加载：进入页面默认加载 Tab 1，切换到 Tab 2 才请求盘点数据
- 库存概览：30 分钟自动刷新一次（参照现有 Dashboard）
- 盘点明细：5 分钟自动刷新一次（盘点单状态变化更频繁）
- 后端初始不上 Redis 缓存，单查询预期 < 500ms；性能不达标再加

## 8. 文件改动清单

### 8.1 新增

**后端**
- `backend/app/api/v1/material/inventory_board.py`
- `backend/app/services/material/inventory_board_service.py`
- `backend/app/schemas/material/inventory_board.py`

**前端**
- `frontend/src/pages/MaterialCenter/InventoryBoard/index.tsx`
- `frontend/src/pages/MaterialCenter/InventoryBoard/OverviewTab.tsx`
- `frontend/src/pages/MaterialCenter/InventoryBoard/StockCheckTab.tsx`
- `frontend/src/pages/MaterialCenter/InventoryBoard/components/KpiStrip.tsx`
- `frontend/src/pages/MaterialCenter/InventoryBoard/components/ByWarehouseChart.tsx`
- `frontend/src/pages/MaterialCenter/InventoryBoard/components/ByCategoryChart.tsx`
- `frontend/src/pages/MaterialCenter/InventoryBoard/components/AgingChart.tsx`
- `frontend/src/pages/MaterialCenter/InventoryBoard/components/LowStockList.tsx`
- `frontend/src/pages/MaterialCenter/InventoryBoard/components/ActiveChecksTable.tsx`
- `frontend/src/pages/MaterialCenter/InventoryBoard/components/StockCheckTrend.tsx`
- `frontend/src/pages/MaterialCenter/InventoryBoard/components/RecentDiffsTable.tsx`

### 8.2 修改

**后端**
- `backend/app/api/v1/material/__init__.py`：注册新路由
- `backend/app/core/permissions.py`：注册 `inventory_board` 资源到 `permission_registry`
- `backend/init_database.py`：在 `ROLE_PERMISSION_ADDITIONS` 中加入 `inventory_board.read` 给授权角色

**前端**
- `frontend/src/services/api.ts`：新增 `inventoryBoardApi`
- `frontend/src/App.tsx`：注册路由 `/inventory-board`
- `frontend/src/layouts/MainLayout.tsx`：菜单项 + 路由→分组映射 + 路由→权限映射
- `frontend/src/store/permission.ts`：新增 `'/inventory-board': 'materials.inventory_board'`

## 9. 验收标准

1. **路由可达**：`/inventory-board` 可访问，未授权用户返回 403 或无权限提示。
2. **Tab 切换**：两个 Tab 独立加载，加载态 / 空态有降级 UI（骨架屏 / "暂无数据"）。
3. **筛选生效**：仓库 / 类别切换后 Tab 1 全部图表数据同步更新。
4. **跳转正确**：Tab 2 的"我的盘点任务"点击行可跳转 `/stock-check/workbench/:checkId`。
5. **权限正确**：以 `purchaser01` / `manager01` 角色登录可访问；以 `supplier_*` 角色登录访问返回 403。
6. **Typecheck**：`cd frontend && npm run build` 通过。
7. **后端启动**：`python -m uvicorn app.main:app` 无报错，权限点出现在「角色管理」UI。
8. **数据一致性**：抽样比对 1-2 个仓库的库存金额与 ERP 系统导出值一致。

## 10. 风险与回退

| 风险 | 缓解 |
|---|---|
| 聚合 SQL 性能差（千万行库存） | 先做 GROUP BY 简单聚合；若超时加索引 `(wh_id, material_id)` 或物化视图 |
| `unit_price` 大量为 0 或 NULL 导致金额失真 | 在 KPI 中同时展示"有价库存金额 / 总库存量"，避免误导 |
| 盘点趋势 30 天数据稀疏 | 后端自动补齐缺失日期为 0，前端折线图保持连续 |
| `last_inbound_at` 缺失导致库龄全进 `180d+` | 文档明确告知，并附筛选条件 |

## 11. 后续迭代（不进本次范围）

- 库存周转率（按物料出库量 / 平均库存）
- ABC 分析（按库存金额占比分类）
- 实时推送（WebSocket / SSE）
- 移动端响应式优化
- 库存预警规则引擎
