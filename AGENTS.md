# AGENTS.md

Guidance for OpenCode sessions working in this repo. Read before editing.

## Commands

Backend (run from `backend/`, Python 3.12):
```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000        # entrypoint: app/main.py
python init_database.py                          # idempotent schema bootstrap (see below)
```

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
- Permissions are a role-keyed dict (`role.permissions = {resource: [actions]}`), seeded in `init_database.py` and merged at runtime via `merge_role_permission_additions`. `permission_registry` is re-synced to DB on every startup (in `lifespan`).
- **Three APScheduler instances start in `app/main.py` lifespan**: ERP sync (`basicdata.sync_scheduler`), risk scan (`exception.risk_scheduler`), overdue check (`scheduler.overdue_checker`). They start/stop with the app — importing `main` starts them on boot.
- `main.py` overrides the default JSON response class with `SafeJSONResponse` to tolerate non-UTF-8 / `Decimal` / `datetime`. Don't bypass it.
- ERP integration is SQL-driven: sync SQL + field mappings are stored in the `sync_sql_config` / `field_mapping` tables and editable at runtime (see `backend/ERP_INTEGRATION.md`). Manual triggers: `POST /api/v1/basicdata/sync/...`.

## Frontend conventions

- Single axios instance at `src/services/api.ts`, `baseURL: '/api/v1'`, 30s timeout, token from `useAuthStore`. Auth/permission state in **Zustand** stores (`src/store/auth.ts`, `permission.ts`, `theme.ts`) — not Redux/context. Permission tree is fetched once and cached; route→permission mapping lives in `permission.ts`.
- Path alias `@` → `src/` (configured in both `vite.config.ts` and `tsconfig.json`).
- UI: Ant Design 5 + `@ant-design/pro-components` + Tailwind. TS is `strict`; unused locals/params checks are disabled (`noUnusedLocals: false`).
- `npm run build` is the only typecheck — there is **no** `lint`, `test`, or `format` script, and no ESLint/Prettier config. Don't invent one without asking.

## No test suite

There is **no** pytest/jest/vitest configured (not in `requirements.txt` or `package.json`). `backend/test_*.py` and root `check_*.py` / `add_*.py` are standalone scripts run manually against a live DB, not a test framework. Verify changes by starting uvicorn and hitting the endpoint, or by running the relevant script.

## Active investigation notes (read if working in these areas)

Root-level `debug-*.md` files track open, evidence-gathering investigations — do not "fix" the business logic without reading them:
- `debug-login-sudden-401.md` — intermittent 401s on login; unresolved.
- `debug-delete-flow-slow.md` / `debug-delete-only-slow.md` / `debug-delete-preview-slow.md` — slow schedule-plan delete preview/confirm; frontend `refreshAllViews()` failures get misreported as "network error". Touching `frontend/src/pages/ProductionCenter/SchedulePlans/` or `backend/app/services/production/plan_delete_backfill_service.py`? Read these first.

## Key references

- `CODE_WIKI.md` — architecture, module map, model overview (large; skim the TOC).
- `backend/ERP_INTEGRATION.md` — ERP sync SQL/mapping model and manual trigger commands.
- `init_database.py` — seed data (roles, users, risk rules, node standards) and the real migration logic.

## Change reporting format

After every code change session, output a change summary table with these columns:

| 业务模块 | 功能 | 业务价值 / 解决的问题 | 状态 |
|---|---|---|---|
| ... | ... | ... | 已完成 |

The table must be part of the final message before signing off, listing every file touched and its business impact.
