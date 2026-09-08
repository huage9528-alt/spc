# oneoff — 一次性后端脚本

存放**一次性**的数据修复 / 回填 / 验证调试脚本。用完即删，不要演化为常驻功能。

## 约定

- **命名**：动词_对象.py（如 `add_xxx.py`、`fix_xxx.py`、`verify_xxx.py`、`check_xxx.py`）。
- **运行方式**：在 `backend/` 目录下、使用后端 venv 执行：

  ```bash
  python -m scripts.oneoff.add_xxx
  # 或
  python scripts/oneoff/add_xxx.py
  ```

  脚本内的 `sys.path` 已指向 `backend/`，可直接 `from app...` 导入；配置走 `backend/.env.local`（取决于 CWD）。

- **生命周期**：确认效果后尽快删除；确需保留的验收脚本可留，但需在文件头 docstring 注明用途与最后验证日期。
- **不要**在此新增 schema 变更脚本——新列请同时加到 SQLAlchemy model 和 `init_database.py` 的 `migrate_columns`（见根 AGENTS.md）。
- **禁止**硬编码数据库口令等敏感信息，一律走 `app.core.config.Settings`。

## 与其它目录的分工

| 目录 | 用途 |
|---|---|
| `backend/scripts/oneoff/` | 一次性 Python 脚本（数据修复、回填、验证） |
| `backend/alembic/` | 手动执行的增量迁移 |
| `backend/tests/` | 可重复运行的测试 |
| 根 `scripts/` | 部署 / 运维脚本（deploy-remote.ps1、run-*-local.ps1 等） |
