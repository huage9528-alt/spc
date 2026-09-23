# AGENTS.md

Guidance for OpenCode sessions working in this repo. Read before editing.

## Commands

Backend (run from `backend/`, Python 3.12):
```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000        # entrypoint: app/main.py
python init_database.py                          # idempotent schema bootstrap (see below)
python check_deploy_agent.py                     # deploy_agent 冒烟（mock docker/git/health，见部署运维章节）
```

Deploy Agent（独立进程，跑在生产主机上，供后端驱动部署，见 `backend/deploy_agent/README.md`）:
```bash
cd backend && pip install -r deploy_agent/requirements.txt
python -m deploy_agent                            # 默认 127.0.0.1:8901；生产用 systemd unit (deploy_agent/scripts/deploy-agent.service)
```

Docker dev（`docker-compose.yml`）里 deploy_agent 是独立服务（复用 spc-v2-backend 镜像 + `python -m deploy_agent`，挂 /var/run/docker.sock 与 ./data/deploy 工作目录）；backend 通过 `DEPLOY_AGENT_URL=http://deploy-agent:8901` 访问它。健康检查用 compose 服务名 `http://backend:8000` / `http://frontend:80`。dev 首次会显示空版本列表属正常（工作目录无 versions/）。

Frontend (run from `frontend/`, Node 20):
```bash
npm install
npm run dev        # Vite dev server on :3000, proxies /api and /uploads to :8000
npm run build      # = `tsc -b && vite build` — this is the ONLY typecheck; run before finishing
```

Docker (from repo root): `docker-compose up -d` (prod, :8000/:3000) or `docker-compose -f docker-compose-dev.yml up -d` (dev, :8001/:3001). The backend container command is `python init_database.py && uvicorn ...`, so `init_database.py` runs on every container start.

Default seeded logins (password `admin123` for all): `admin`, `planner01`, `purchaser01`, `manager01`, `purchase_mgr01`. Login endpoint is `POST /api/v1/basicdata/auth/login` (form-urlencoded, field `login_type` = `employee` | `supplier`).

## Database & migrations — read this before touching schema

There are TWO schema mechanisms and they are NOT equivalent:

1. **`backend/init_database.py` is the runtime source of truth.** It does `Base.metadata.create_all` plus a hand-maintained `migrate_columns` dict that runs `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / drops. It runs on every container start and is idempotent. **A new column added only as an Alembic migration will NOT appear after a container restart** unless you also register it in `init_database.py` (or it's a fresh table created by `create_all`).
2. **Alembic** (`backend/alembic/`, ~50 migration files) exists but is **not run on startup**. It is used ad hoc / manually. `alembic.ini` has a hardcoded DB URL that drifts from `.env`.

When adding a column: add it to the SQLAlchemy model AND to `init_database.py`'s `migrate_columns[table]` dict. That is the dominant, verified pattern in this repo.

Models live under `backend/app/models/<domain>/`. `alembic/env.py` imports `app.models` to register all tables on `Base.metadata`; new model modules must be imported there (or via the package `__init__`) to be picked up by `create_all`.

- App code uses **async** SQLAlchemy (`asyncpg`) via `get_db()` in `app/core/database.py`, which **auto-commits on success and rolls back on exception** — do not commit manually inside endpoints unless you also manage the session.
- Alembic / `init_database.py` / ERP reads use **sync** engines (`psycopg2`, `pyodbc`).
- ERP sync only overwrites rows where `data_source = 'erp'`. It never touches `manual` / `excel` rows. Preserve this guard when editing sync code in `app/services/basicdata/`.

## Environment & config

- `app/core/config.py` (`Settings`, pydantic-settings) reads env from `(".env.local", ".env")` **relative to the CWD uvicorn runs in** (the `backend/` dir). So local dev actually uses `backend/.env.local`; Docker injects env from the **root** `.env` via `docker-compose.yml` `${VAR}` substitution. The two `.env` files point at different DB hosts — don't assume which one is live.
- `get_settings()` is `@lru_cache`'d — config is fixed for the process lifetime; restart to pick up env changes.
- Secrets (DB creds, `AI_OPENAI_API_KEY`) are present in `.env`, `backend/.env.local`, and even committed defaults in `alembic.ini` / `config.py`. **Never print, log, or commit new secrets.** Reference them via `Settings`, never hardcode.

## Backend conventions

- **Response envelope is mandatory client-side.** The frontend axios interceptor (`frontend/src/services/api.ts`) treats `response.data.code !== 0` as a failure. Successful endpoints must return `{ code, message, data }` — see `ResponseModel` / `PageResult` in `app/schemas/common.py`. A bare list/dict return will be rejected by the client even though HTTP is 200.
- All routes mount under `/api/v1` (set by `API_PREFIX`); sub-router prefixes are wired in `app/api/v1/__init__.py`. Domains: `dashboard, order, material, production, exception, rules, basicdata, meeting, npi, assistant, common`.
- **Auth = JWT + two invalidation layers.** Tokens carry `login_version` and `jti`; `app/core/dependencies.py` (`get_current_user` / `get_current_user_or_share`) rejects tokens whose `login_version` != DB value or whose `jti` is blacklisted (`app/core/token_blacklist.py`, Redis-backed). Re-login bumps `sys_user.login_version`. Force-logout responses send header `X-Force-Logout: true`. **Share tokens** (`share: true` in JWT) bypass permission + login_version checks — use `get_current_user_or_share` for share-accessible routes.
- Permissions are a role-keyed dict (`role.permissions = {resource: [actions]}`), seeded in `init_database.py` and merged at runtime via `merge_role_permission_additions`. `permission_registry` is re-synced to DB on every startup (in `lifespan`). **`seed_roles` only sets `permissions` when creating a role** — for existing roles it refreshes `role_name` only, so runtime grants made in 角色管理 survive container restarts. Do not restore the old `role.permissions = role_data["permissions"]` overwrite; new base permissions belong in `ROLE_PERMISSION_ADDITIONS` (`app/core/permissions.py`).
- **Six background schedulers start in `app/main.py` lifespan**: ERP sync (`basicdata.sync_scheduler`), risk scan (`exception.risk_scheduler`), overdue check (`scheduler.overdue_checker`), capacity sync (`scheduler.capacity_sync_scheduler`), data supply alert (`scheduler.data_supply_alert`), approval timeout reminder (`scheduler.approval_timeout_reminder`). They are **not APScheduler-based** (the `apscheduler` dependency sits unused in `requirements.txt`): each is a hand-written `asyncio.create_task` + `while running: await asyncio.sleep(...)` loop. They start/stop with the app — importing `main` starts them on boot.
- `main.py` overrides the default JSON response class with `SafeJSONResponse` to tolerate non-UTF-8 / `Decimal` / `datetime`. Don't bypass it.
- ERP integration is SQL-driven: sync SQL + field mappings are stored in the `sync_sql_config` / `field_mapping` tables and editable at runtime (see `backend/ERP_INTEGRATION.md`). Manual triggers: `POST /api/v1/basicdata/sync/...`.

- **部署运维（deploy_versions）**: 后端 `app/api/v1/system/deploy_versions.py` 是一层薄代理，转发到本机 `deploy_agent`（`backend/deploy_agent/`，独立进程，默认 `127.0.0.1:8901`，与后端共享 `SECRET_KEY`）。权限模型：`deploy_versions.read` 可查看（list/status/detail/SSE 流），`deploy_versions.manage` 可执行动作（rollback/switch/deploy-new）；两者都按角色在「角色管理」中授予，**不限定 admin**（admin 自动通过）。GET/POST 走 header Bearer；SSE（`/jobs/{id}/stream`）因前端用 fetch+ReadableStream 也走 header Bearer（与 notifications 的 EventSource query-token 惯例不同，勿改回）。agent 把 git pull / docker build / compose up / 健康检查封装为 job + SSE 事件（`step` / `phase` / `log` / `end`）。加 agent 新命令时保持 `_run_step` 输出约定。冒烟脚本 `backend/check_deploy_agent.py`（mock docker/git/health）。

- **审批中心（approval）**: 待办工作台（待我审批 / 我已审批 / 我发起的 三 Tab）+ 审批链配置，独立一级菜单。新业务流程接入只需在 `backend/app/services/common/approval_providers.py` 注册一个 provider（`biz_type` / 名称 / 归一化取数函数，参考 supplier_claim），统一端点 `GET /api/v1/approvals/pending` 自动聚合（分页 + keyword / biz_type / 日期 / wait_level / today_only 筛选，返回 `stats` 且 stats 恒为全量口径）；provider 可选能力 `fetch_approved` / `fetch_submitted` / `preview` / `approve` / `reject`，未实现的业务只做聚合与深链跳转。审批动作可在中心内联完成（`POST /api/v1/approvals/items/{biz_type}/{id}/approve|reject`、`POST /api/v1/approvals/batch-approve` 逐条 SAVEPOINT 隔离），业务详情页入口保留。审批链配置只允许操作**已注册**的 biz_type（`PUT /api/v1/approvals/configs/{biz_type}` 会拒绝未注册业务，防止与其它模块配置页产生双写路径；调价单未注册、维持原入口）。权限域：`approval.pending`（审批人，节点权限在引擎内二次校验）、`approval.config`（配置管理员）。审批链支持「按角色 / 指定人员」「多条件 AND」「节点超时小时数（0=不提醒）」「启用停用（停用后不再产生新待办，在途按冻结快照继续）」；超时提醒由 `app/services/scheduler/approval_timeout_reminder.py` 每小时扫描，站内信 + 企微推送当前节点审批人，Redis 按「单据+节点」24h 去重，Redis/企微不可用时降级。

## Frontend conventions

- Single axios instance at `src/services/api.ts`, `baseURL: '/api/v1'`, 30s timeout, token from `useAuthStore`. Auth/permission state in **Zustand** stores (`src/store/auth.ts`, `permission.ts`, `theme.ts`) — not Redux/context. Permission tree is fetched once and cached; route→permission mapping lives in `permission.ts`.
- Path alias `@` → `src/` (configured in both `vite.config.ts` and `tsconfig.json`).
- UI: Ant Design 5 + `@ant-design/pro-components` + Tailwind. TS is `strict`; unused locals/params checks are disabled (`noUnusedLocals: false`).
- `npm run build` is the only typecheck — there is **no** `lint`, `test`, or `format` script, and no ESLint/Prettier config. Don't invent one without asking.

## 代码整洁与防重复守则（所有代码改动适用）

写任何代码前、中、后必须遵守以下规则，违反须在交付前自我纠正：

**动手前：先查再写**
- 写任何新函数/组件/工具类之前，先在代码库中搜索是否已有相似实现（按功能关键词、相似命名、相邻模块查找）；有就复用或扩展，禁止重复造轮子。
- 新增第三方依赖前，先确认标准库和项目现有依赖无法满足；能不加就不加。
- 修改代码前先读上下文（同目录相邻文件、import、调用方），理解并遵循项目现有约定（命名风格、错误处理、返回结构、目录组织），不另起炉灶。
- 需求有歧义时先提问澄清，不靠猜。

**写代码时：整洁铁律**
- DRY：同一段逻辑禁止复制第二次；出现第二处相似即提取为公共函数/组件/常量，并替换所有调用点。
- 但不过度抽象：只有单一调用方的逻辑不预先提取（Rule of Three）；禁止为"将来可能用到"写代码（YAGNI）。
- 命名见名知义、与项目风格一致：禁止 `data1` / `tmp` / `foo` / `handle2` 这类命名；布尔值用 is/has/can 前缀；函数名用动词，类/名词用名词。
- 函数单一职责：一个函数只做一件事；超过约 40 行或嵌套超过 3 层必须拆分；参数超过 3 个时收拢为对象/配置。
- 不留任何"代码垃圾"：不留 `console.log` / `print` / 调试输出；不留注释掉的旧代码（git 有历史，直接删）；不留无用 import、无用变量、空 catch、空函数；不写复述代码的废话注释，注释只解释"为什么"。
- 最小改动原则：只改与当前任务相关的代码；不顺手重排格式、不重构无关文件、不修改无关空行，保证 diff 干净可审。

**交付前：自查清单（逐项执行）**
- 全局搜索本次新写的函数名/关键代码片段，确认与已有代码无重复；发现重复立即合并。
- 删除所有调试代码、临时代码、被注释的旧实现。
- 运行项目的校验命令并确保通过（本项目：前端 `npm run build` 是唯一 typecheck；后端起 uvicorn 验证端点，见 No test suite 章节）。
- 新代码的错误处理、日志、边界情况与项目现有模式一致。
- 汇报改动时说明：改了哪些文件、为什么、复用了哪些已有代码。

**硬性禁令**
- 禁止复制本会话早前写的或代码库已有的代码片段来"快速实现"新功能。
- 禁止"先这样，以后再改"：写出来就必须是最终正确形态。
- 禁止引入项目中未使用的框架、模式或架构；与代码库保持一致，不炫技。
- 禁止在未说明的情况下留下 TODO；留 TODO 必须写清原因和负责人。

## Tests

Backend has a pytest suite (`backend/pytest.ini`, `testpaths = tests`); frontend still has **no** test runner (`npm run build` remains the only frontend check).

```bash
cd backend && pip install -r requirements-dev.txt   # pytest / pytest-asyncio（生产镜像不装）
python -m pytest -v                                  # 全量：86 个用例
python -m pytest tests/unit tests/integration -v     # 只跑供应商索赔/审批中心套件
```

- `tests/unit/` + `tests/integration/` — 供应商索赔单 + 审批中心自动化测试（2026-09 新增）：独立测试库 `spc_test`（conftest 自动建库+最小种子+每用例清表，**不碰开发库**），ASGI 内存客户端直打 FastAPI app，不起 uvicorn。
- **`pytest.ini` 里的 `asyncio_default_fixture_loop_scope = session` / `asyncio_default_test_loop_scope = session` 是硬性前提**：全局异步引擎池跨事件循环会损坏连接，删掉这两行会导致全部集成用例报 "Future attached to a different loop"。
- `tests/test_*.py` 根下其余文件（`test_context_manager.py`、`test_cancellation.py` 等）是既有单测；`test_external_*.py` 是针对活服务的独立脚本（无 test_ 函数，pytest 只导入不执行）。
- 改审批引擎/索赔单/审批中心代码后必须跑 `python -m pytest`。

其余验证方式不变：起 uvicorn 打端点，或跑 `backend/test_*.py`、根 `check_*.py` / `add_*.py` 等独立脚本。

## Active investigation notes (read if working in these areas)

Root-level `debug-*.md` files track open, evidence-gathering investigations — do not "fix" the business logic without reading them:
- `debug-login-sudden-401.md` — intermittent 401s on login; unresolved.
- `debug-delete-flow-slow.md` / `debug-delete-only-slow.md` / `debug-delete-preview-slow.md` — slow schedule-plan delete preview/confirm; frontend `refreshAllViews()` failures get misreported as "network error". Touching `frontend/src/pages/ProductionCenter/SchedulePlans/` or `backend/app/services/production/plan_delete_backfill_service.py`? Read these first.

## Key references

- `CODE_WIKI.md` — architecture, module map, model overview (large; skim the TOC).
- `backend/ERP_INTEGRATION.md` — ERP sync SQL/mapping model and manual trigger commands.
- `init_database.py` — seed data (roles, users, risk rules, node standards) and the real migration logic.
- `docs/最易出错约束点复盘-2026-07.md` — July 2026 session audit: the most error-prone constraint points (int/string ID mismatch, init_database-vs-Alembic drift, ERP sync correctness, connection pool, permissions) with real error strings. Read before touching models/sync/permissions.
- `docs/开发约束预检清单.md` — actionable, checkable constraint conditions (CC-A1..F2) mapped by requirement type, each with trigger / rule / pass criteria / real error / verify command. Run the applicable checklist before starting and before sign-off.

## Change reporting format

After every code change session, output a change summary table with these columns:

| 业务模块 | 功能 | 业务价值 / 解决的问题 | 状态 |
|---|---|---|---|
| ... | ... | ... | 已完成 |

The table must be part of the final message before signing off, listing every file touched and its business impact.
