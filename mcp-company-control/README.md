# company-control MCP Server

中台只读能力适配器，接入 AEOS Hub。遵循 **AEOS MCP Integration Specification v0.1.0**。

- **名称**：company-control
- **版本**：1.1.0
- **传输**：stdio（默认，由 AEOS Hub 作为 MCP client 拉起）/ streamable-http（远程客户端，静态 Bearer Token）
- **技术栈**：Python 3.12+ / 官方 mcp SDK 2.x（`MCPServer`）/ httpx / pydantic
- **权限等级**：全部 Tool 为 `READ_ONLY`（MCP annotations `readOnlyHint=true` + `server.json` 声明）
- **维护团队**：中台平台组（版本负责人见 `server.json`，Registry 提交前补齐）

## 与规范默认栈的差异说明

规范 §2 默认 Node.js（`.mjs` + Zod）。本项目为 Python 等价实现（stdio 上 JSON-RPC 协议完全一致），
提交 AEOS Registry 审核时需登记此技术栈变更。包目录命名为 `mcp_server/` 而非 `mcp/`，
避免与 SDK 的 `mcp` 包在 `sys.path` 中冲突。

## 启动

```bash
pip install -r requirements.txt
cp .env.example .env    # 填入中台端点与凭证

# stdio（默认）
python -m mcp_server

# streamable-http（需先配置 MCP_HTTP_TOKEN）
python -m mcp_server --transport streamable-http --host 127.0.0.1 --port 8902
```

CLI 参数优先于环境变量（`MCP_TRANSPORT` / `MCP_HTTP_HOST` / `MCP_HTTP_PORT`）。

AEOS Hub 侧接入配置（测试环境）：

```toml
[mcp_servers.company-control]
command = "<python 解释器绝对路径>"
args = ["-m", "mcp_server"]
# 工作目录需为本项目根（mcp-company-control/），并在 Hub 侧注入上述环境变量
```

### HTTP 模式

- 端点：`http://{host}:{port}/mcp`（streamable-http 协议）
- 鉴权：请求头 `Authorization: Bearer <MCP_HTTP_TOKEN>`；无/错 token 返回 401
- `MCP_HTTP_TOKEN` 为空时 HTTP 模式拒绝启动（exit 2）；stdio 模式不受影响
- 默认监听 `127.0.0.1:8902`。如需对外，建议 nginx 反代并保持 Host 一致
  （`proxy_set_header Host 127.0.0.1:8902;`），或直接绑 `0.0.0.0`
- 静态 token 不走 OAuth 发现流程（SDK 的 `AuthSettings` 为静态 token 承载所需，元数据 URL 指向自身）

## 环境变量

| 变量 | 说明 |
|---|---|
| `CONTROL_PLATFORM_BASE_URL` | 中台（SPC）API 地址；生产经 nginx：`http://150.158.13.110:18084/api/v1` |
| `CONTROL_PLATFORM_APP_KEY` / `APP_SECRET` | **数据供给 HMAC API Key（生产推荐，优先级 1）** |
| `CONTROL_PLATFORM_TOKEN` | 静态 Bearer Token（优先级 2） |
| `CONTROL_PLATFORM_CLIENT_ID` / `CLIENT_SECRET` | client_credentials 凭证（优先级 3） |
| `CONTROL_PLATFORM_TOKEN_URL` | 可选，自定义令牌端点 |
| `CONTROL_PLATFORM_TIMEOUT_MS` | 请求超时，默认 15000 |
| `CONTROL_PLATFORM_CONNECT_TIMEOUT_MS` | 连接超时，默认 5000 |
| `MCP_TRANSPORT` | `stdio`（默认）/ `streamable-http` |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | HTTP 监听地址/端口，默认 `127.0.0.1:8902` |
| `MCP_HTTP_TOKEN` | HTTP 模式静态 Bearer Token（必填，为空拒绝启动） |
| `MCP_HTTP_PUBLIC_URL` | 可选，资源元数据 URL，默认 `http://127.0.0.1:{MCP_HTTP_PORT}` |

## SPC 生产对接（数据供给 API Key）

生产认证走 SPC 现成的「数据供给」HMAC 签名机制：

- 请求头：`X-App-Key`、`X-Timestamp`（秒级，±300s 有效）、`X-Signature`
- 签名串：`timestamp + app_key + endpoint_code + query_string` → `HMAC-SHA256(app_secret)` hex
- `endpoint_code` 为 SPC 注册表代码（内部 `int:` 前缀 / 对外接口无前缀），非 URL 路径
- 路径 → endpoint_code 映射维护在 `mcp_server/upstream_client.py` 的 `_ENDPOINT_CODES`

创建密钥（SPC 管理端）：

1. 登录 SPC → 基础数据中心 → 数据供给 → 新建 API Key
2. 勾选接口：`int:health.ping`、`orders.list`、`order_details.list`、`boms.tree`、
   `materials.list`、`suppliers.list`、`kitting.results`、`kitting.shortages`、
   `kitting.demands`、`inventory.availability`、`material.supplies`
3. IP 白名单：填 MCP 运行主机 IP（本地调试可留空）
4. 保存后复制 AppKey / AppSecret（**AppSecret 仅显示一次**），填入 `.env`

**当前端点状态**：13 个端点已就绪（`/common/ping`、`/external/orders/list`、
`/external/order-details/list`、`/external/boms/tree`、`/external/materials/list`、
`/external/suppliers/list`、`/external/material-kitting/results`、
`/external/material-kitting/shortages`、`/external/material-kitting/demands`、
`/external/inventory/availability`、`/external/material-supplies/list`、
`/external/quality-issues/list`、`/external/quality-trace/list`）；SPC 指标端点尚未开放，
`catalog_metrics_list` / `metric_query` 返回结构化「能力未开放」错误（不返回伪造数据）。

## Tool 清单（16 个，全部 READ_ONLY）

| Tool | 说明 | 关键约束 |
|---|---|---|
| `get_system_health` | 连接自检 | 成功含 ping evidence；降级 `data_confidence=low`；单时间戳（§8/§16） |
| `orders_list` | 订单列表（新版） | 过滤条件全可选；单页 ≤200；`status` 为派生值（`pending_review`/`in_progress`/`partially_closed`/`completed`/`cancelled`，依据 `erp_status` + `delivery_completed_date`） |
| `order_details_list` | 订单明细列表（新版） | 过滤条件全可选；单页 ≤200 |
| `bom_tree` | BOM 多级树（新版） | `bom_id` 必填；返回嵌套树或扁平列表 |
| `detail_orders_list` | 订单风险列表（0.1.0 兼容） | 至少一个过滤条件；`customer`→上游 `keyword`；`date_from/date_to`→合同交期；单页 ≤100；附加 `amount_cny`/`due_date` 别名 |
| `master_material_search` | 物料检索（0.1.0 兼容） | 对接 `/external/materials/list`；单页 ≤100 |
| `master_supplier_get` | 供应商详情（0.1.0 兼容） | 对接 `/external/suppliers/list`（编码精确匹配）；不存在返回 `NOT_FOUND` |
| `catalog_metrics_list` | 指标目录（0.1.0 兼容） | SPC 端点未开放 → `UPSTREAM_UNAVAILABLE`（`retryable=false`） |
| `metric_query` | 指标查询（0.1.0 兼容） | 保留 92 天跨度校验；SPC 端点未开放 → `UPSTREAM_UNAVAILABLE`（`retryable=false`） |
| `material_kitting_results_list` | 齐套结果列表（AEOS 文档 §9） | endpoint_code `kitting.results`；过滤条件全可选；单页 ≤200；含状态/齐套率/预计齐套日期 |
| `material_shortages_list` | 缺料明细列表（AEOS 文档 §9） | endpoint_code `kitting.shortages`；含净缺口/预计可用日期/缺料原因/责任部门 |
| `material_kitting_demands_list` | 齐套需求对象列表（AEOS 文档 §9） | endpoint_code `kitting.demands`；销售订单行，含数量/需求日期/优先级/状态 |
| `inventory_availability_list` | 库存可用量（按物料聚合，AEOS 文档 §9） | endpoint_code `inventory.availability`；`available_qty` = 现存 − 锁定；不暴露单价等敏感字段 |
| `material_supplies_list` | 未来供给列表（AEOS 文档 §9） | endpoint_code `material.supplies`；四源统一：采购在途/委外回货/自制计划/调拨 |
| `quality_issues_list` | 质量异常列表（AEOS 异常与质量中心 §7） | endpoint_code `quality_issues.list`；无数据源字段（severity/inspection_result/batch_no/supplier_code/material_code/line_no/blocking/issue_type）返回 null；单页 ≤200 |
| `quality_trace` | 质量追溯（AEOS 异常与质量中心 §7） | endpoint_code `quality_trace.list`；order_no/product_code/batch_no 三选一；扁平节点（quality_issue/order_line/bom），evidence 用 object_type/object_id |

- 全部 Tool 拒绝未定义字段（严格 Schema，`additionalProperties: false`），带 `readOnlyHint` 标注
- 数据类 Tool 支持可选 `request_id`（≤64 字符）透传上游并在返回包回显，便于审计与链路追踪
- 上游返回 `stale: true` 时统一返回 `STALE_DATA`（retryable），`data_confidence=low` 透传

### 0.1.0 兼容说明

| 0.1.0 工具 | 1.0.0 兼容方式 | 上游 |
|---|---|---|
| `get_system_health` | 保留名称，补 evidence 与降级置信度（方案 §8） | `/common/ping` |
| `detail_orders_list` | 适配到订单表头端点，参数映射 + 字段别名 | `/external/orders/list` |
| `master_material_search` | 功能兼容 | `/external/materials/list` |
| `master_supplier_get` | 功能兼容 | `/external/suppliers/list` |
| `catalog_metrics_list` / `metric_query` | 契约兼容（Schema/信封不变），返回结构化「能力未开放」错误 | SPC 指标端点待开放 |

- 参数映射：`customer`→`keyword`（与 `product_line` 同时提供时优先 `customer`）；`date_from/date_to`→`promised_date_start/end`（语义由下单日期变为合同交期，见工具描述）
- 字段别名：`order_amount`→`amount_cny`、`promised_date`→`due_date`（保留新版原字段）；**不**做 `risk_level`→`risk_probability` 转换
- 旧分页上限保持 100（`page`/`page_size`）；新版工具上限 200

## 输入输出示例

调用 `orders_list`：

```json
{"keyword": "示例客户", "page": 1, "page_size": 20}
```

返回（规范 §8 标准包）：

```json
{
  "source": "company-control",
  "capability": "orders_list",
  "read_only": true,
  "generated_at": "2026-09-21T08:00:00Z",
  "data_confidence": "high",
  "data_as_of": "2026-09-21T08:00:00Z",
  "evidence_refs": ["control-platform://order/SO-2609-001@2026-09-21T08:00:00Z"],
  "data": [{"order_no": "SO-2609-001", "customer": "示例客户A", "status": "in_progress", "erp_status": 1, "delivery_completed_date": null}],
  "page": {"page": 1, "page_size": 20, "total": 1, "truncated": false}
}
```

调用 `bom_tree`：

```json
{"bom_id": "BOM-001", "demand_qty": 100, "flatten": false}
```

错误（规范 §12）：

```json
{
  "source": "company-control",
  "error": {"code": "UPSTREAM_TIMEOUT", "message": "中台端点 /external/orders/list 响应超时（>15000ms）", "retryable": true, "occurred_at": "2026-09-21T08:00:00Z"}
}
```

## 测试

```bash
python scripts/test_company_control.py
```

内置 mock 中台端点，覆盖：stdio 30 项（握手 / tools/list / 结构化返回 / 非法输入 /
未授权 / 超时 / 不可用不崩溃 / evidence / 脱敏 / 无写工具 / 幂等 / 健康检查 / 数据过期 /
0.1.0 兼容工具与旧 Schema / 能力未开放错误 / 92 天跨度校验 / 物料与供应商功能兼容 /
订单参数与字段映射 / 健康检查 evidence 与置信度 / 齐套 5 工具 / 质量列表与追溯 /
质量追溯缺锚点校验 / 质量数据过期映射）
+ HTTP 4 项（无 token 401 / 错误 token 401 / 正确 token 握手 / 未配 token 拒绝启动）。

## 元数据与权限声明

- `server.json`：Server 元数据（name / version / owner / transport / read_only / required_permissions / 依赖 / 维护团队 / 每 Tool 权限等级），提交 AEOS Registry 使用
- MCP 协议层：`serverInfo.version=1.1.0`；每个 Tool 带 `annotations.readOnlyHint=true`

## 上游系统依赖

SPC 后端（`CONTROL_PLATFORM_BASE_URL`），通过「数据供给」HMAC API Key 调用：

- 已就绪：`GET /common/ping`（`int:health.ping`）、`GET /external/orders/list`（`orders.list`）、
  `GET /external/order-details/list`（`order_details.list`）、`GET /external/boms/tree`（`boms.tree`）、
  `GET /external/materials/list`（`materials.list`）、`GET /external/suppliers/list`（`suppliers.list`）、
  `GET /external/material-kitting/results`（`kitting.results`）、
  `GET /external/material-kitting/shortages`（`kitting.shortages`）、
  `GET /external/material-kitting/demands`（`kitting.demands`）、
  `GET /external/inventory/availability`（`inventory.availability`）、
  `GET /external/material-supplies/list`（`material.supplies`）、
  `GET /external/quality-issues/list`（`quality_issues.list`）、
  `GET /external/quality-trace/list`（`quality_trace.list`）
- 调用方需在 API Key 上勾选对应 endpoint_code + IP 白名单

## 已知限制

- 仅只读；写操作 Tool 待 AEOS Guard 审批流成熟后再评估
- 指标类工具（`catalog_metrics_list` / `metric_query`）为契约兼容：SPC 端点开放后更新
  `_ENDPOINT_CODES` 并替换兼容实现即可恢复功能
- `detail_orders_list` 的 `product_line` 无对应上游过滤（SPC 订单端点不支持产品线），
  与 `customer` 同时提供时按 customer 查询；`date_from/date_to` 上游语义为合同交期
- `master_supplier_get` 通过关键词检索后精确匹配编码（单页 200 条内），超大规模供应商库
  若未命中可先用 `suppliers.list` 增量同步
- BOM 树仅支持按 `bom_id` 查询（上游接口设计），可由 `order_details_list` 返回的 `bom_id` 串联
- HTTP 模式为单一静态 token，轮换需更新 env 并重启
- 旧 `sse` 传输不支持（已被 streamable-http 取代）
- 齐套类工具（kitting/shortages/demands/inventory/supplies）的 OUTSOURCE 供给暂无交期，
  `expected_available_date` 为 null
- 调拨供给为近 120 天窗口快照；本账套直接调拨审核即入库存，不计入齐套未来供给（避免与库存重复）
- 齐套类工具对过期数据返回 `data_confidence=low` + 行级 `expired` 字段（数据照常返回），
  不返回 `STALE_DATA` 错误（与 orders 类工具不同）
- 质量类工具：`quality_issues_list` 的 `severity` / `inspection_result` / `batch_no` /
  `supplier_code` / `material_code` / `line_no` / `blocking` / `issue_type` 无 SPC 数据源，恒为 `null`；
  `quality_trace` 不支持 `supplier_code` 锚点；上游 `stale=true` 返回 `STALE_DATA`（不返回数据，
  与 orders 类工具一致）

## 目录结构

```
mcp-company-control/
├─ mcp_server/            # Server 包（避免与 SDK 包 mcp 同名）
│  ├─ __main__.py         # 入口：传输分发（stdio / streamable-http）
│  ├─ server.py           # mcp 实例 + 新版 Tool（orders/details/bom/health）
│  ├─ kitting.py          # 齐套类 Tool（kitting/短料/需求/库存可用量/未来供给）
│  ├─ quality.py          # 质量类 Tool（质量异常/追溯）
│  ├─ legacy_compat.py    # 0.1.0 兼容 Tool（detail_orders/metrics/material/supplier）
│  ├─ tool_helpers.py     # Tool 公共基础设施（错误信封/校验/列表返回）
│  ├─ orders.py           # 订单表头共享查询 + 兼容字段别名
│  ├─ upstream_client.py  # 中台端点客户端（超时/错误映射/受限重试）
│  └─ contracts.py        # 标准返回包/错误/Evidence/脱敏
├─ scripts/test_company_control.py
├─ requirements.txt / .env.example / CHANGELOG.md
```
