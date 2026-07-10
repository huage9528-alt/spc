# 计划排产工作台性能排查记录

## 背景

本轮排查围绕 `计划排产工作台` 与 `已排计划` 页面切换慢的问题展开，目标是让接口尽量回归到“快照表 / 计划表直读”，避免列表切换时再做大量动态计算。

## 已做的优化

### 1. 列表查询减少回表补查

- 将订单行补查从长串 `OR` 条件改为基于 `(order_no, line_no)` 的批量键查询。
- 优先使用快照表和计划表内已固化字段，减少对 `SaleOrderLine` 的重复回表。

### 2. 列表逻辑向快照直读收敛

- `已排计划` 列表去掉了不必要的动态重排状态计算，直接信任计划表已固化字段。
- `待处理工作台` 优先使用快照中的 `bom_no`、`promised_date`、状态字段，不再在热点路径中临时拼大量订单侧信息。

### 3. 加入前后端短缓存

- 前端为 `todo-workbench`、`plan-board` 增加了短缓存与 in-flight 请求复用。
- 后端为对应列表接口增加了短时页缓存，减轻重复切页时的重复查询。

### 4. 增加分段耗时埋点

- 前端日志增加了：
  - `SchedulePlans:todo-workbench-loaded`
  - `SchedulePlans:plan-board-loaded`
  - `cache-hit`
- 后端返回增加了：
  - `dependencyTimingsMs`
  - `backendTimingsMs`
  - `backendStatsSummary`

## 已验证的性能结论

### 1. `plan-board` 列表本体已经不重

在数据库可用时，`plan-board` 的后端业务处理耗时已经压到百毫秒级，典型数据如下：

```json
{
  "count_query": 44.31,
  "page_query": 54.88,
  "serialize_items": 5.16,
  "total": 104.88
}
```

说明：

- `已排计划` 当前主要不慢在列表 SQL 本体。
- 当权限缓存命中时，页面首开已明显变快。

### 2. `todo-workbench` 业务段已明显下降

在数据库正常联通时，`todo-workbench` 的业务处理曾下降到几百毫秒级，典型数据如下：

```json
{
  "ensure_snapshot_table": 86.9,
  "sync_scheduled_snapshots": 116.81,
  "snapshot_stats": 84.43,
  "reschedule_plan_query": 50.31,
  "reschedule_supporting_queries": 36.19,
  "snapshot_page_query": 40.2,
  "snapshot_serialize": 0.61,
  "total": 417.03
}
```

说明：

- `待处理工作台` 的热点已经从“列表主体 SQL”收敛到了“依赖 / 鉴权 / 环境”这一层。
- 纯业务查询本体不是当前最大的慢点。

### 3. 依赖阶段一度是主要耗时来源

在数据库可用的排查阶段，`dependencyTimingsMs` 曾显示：

```json
{
  "permission_cache_hit": false,
  "permission_checker": 2488.0,
  "total": 2488.04
}
```

而当本地读权限缓存命中后，`plan-board` 可下降到：

```json
{
  "permission_cache_hit": true,
  "permission_checker": 0.02,
  "total": 0.08
}
```

说明：

- 冷启动时的权限依赖阶段曾明显重于接口本体。
- 命中本地只读权限缓存后，接口首屏速度会明显改善。

## 当前环境限制

### 1. 数据库地址不可直达

当前后端配置中的 PostgreSQL 地址为：

```text
192.168.0.127:5432 / spc_db
```

该地址属于服务器侧内网地址，当前本机环境无法直接联通。

### 2. 当前多接口 500 的根因判断

在独立后端进程中已抓到数据库连接异常：

```text
ConnectionError: unexpected connection_lost() call
```

同时连通性测试结果为：

```text
Test-NetConnection 192.168.0.127 -Port 5432
TcpTestSucceeded : False
```

因此当前这些 500 更像是环境侧数据库不可达导致，而不是最近这轮生产协同代码改动直接引起。受影响接口包括但不限于：

- `permissions/tree`
- `basicdata/auth/me`
- `notifications/unread-count`
- `production/schedule-plans/todo-workbench`
- `production/schedule-plans/work-hours-config`

## 当前代码侧保留结论

在数据库恢复可达后，建议优先复测以下两条日志：

- `SchedulePlans:todo-workbench-loaded`
- `SchedulePlans:plan-board-loaded`

重点关注字段：

- `dependencyTimingsMsText`
- `backendTimingsMsText`

优先判断顺序：

1. `permission_cache_hit` 是否命中
2. `permission_checker` 是否仍明显偏高
3. `todo-workbench` 的 `backendTimingsMs.total` 是否维持在几百毫秒级
4. `plan-board` 的 `backendTimingsMs.total` 是否维持在百毫秒级

## 后续建议

### 环境恢复后优先验证

1. 恢复到可访问 `192.168.0.127:5432` 的网络环境后，再测一次页面首开和切页。
2. 重新采集 `todo-workbench` 与 `plan-board` 的完整前端日志。
3. 若 `dependencyTimingsMs` 仍大，再决定是否继续优化只读权限链路。
4. 若 `backendTimingsMs` 才重新升高，再回到具体 SQL 路径继续压测。

### 当前不建议误判的点

- 现阶段不要把当前批量 `500` 误判成排产功能本身异常。
- 现阶段也不要仅依据当前这批 `500` 去回滚本轮生产协同性能优化。

