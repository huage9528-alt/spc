"""一次性迁移脚本：为 scm_stock_check_k3_writeback 加 counter_user_id / manager_id 两列,
并重建唯一约束为 (check_id, bill_type, wh_id, counter_user_id)。

用途:
    已部署但未跑新版本 init_database.py 的环境里手动补字段 + 重建唯一约束;
    与 alembic 0118 + init_database.py migrate_columns["scm_stock_check_k3_writeback"]
    + migrate_stock_check_k3_writeback_counter_manager 三处 DDL 完全等价。
    幂等，可重复执行。

跑法:
    cd backend && python migrate_k3_writeback_counter_manager.py [--dry-run]

对应:
    - 设计: docs/superpowers/specs/2026-09-11-stockcheck-k3-manager-dynamic-design.md
    - 实施计划: docs/superpowers/plans/2026-09-11-stockcheck-k3-manager-dynamic.md
    - alembic 旁路: backend/alembic/versions/0118_stock_check_k3_writeback_counter_manager.py

依赖:
    pip install psycopg2-binary
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import psycopg2


_BACKEND_DIR = Path(__file__).resolve().parent
_ROOT_ENV = _BACKEND_DIR.parent / ".env"
_BACKEND_ENV_LOCAL = _BACKEND_DIR / ".env.local"
_BACKEND_ENV = _BACKEND_DIR / ".env"


def load_env() -> None:
    """依次从 .env.local / .env (backend) / .env (root) 加载 env, 后加载的覆盖先加载的。"""
    for env_path in (_BACKEND_ENV_LOCAL, _BACKEND_ENV, _ROOT_ENV):
        if not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())


def get_sync_url() -> str:
    """从 DATABASE_URL_SYNC / DATABASE_URL 解析 psycopg2 可用的 URL。"""
    url = (
        os.environ.get("DATABASE_URL_SYNC")
        or os.environ.get("DATABASE_URL")
        or "postgresql://postgres:postgres@localhost:5432/spc_db"
    )
    return url.replace("postgresql+psycopg2://", "postgresql://").replace(
        "postgresql+asyncpg://", "postgresql://"
    )


def column_exists(cur, table: str, column: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = %s
           AND column_name = %s
        """,
        (table, column),
    )
    return cur.fetchone() is not None


def constraint_exists(cur, table: str, constraint_name: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_schema = current_schema()
           AND table_name = %s
           AND constraint_type = 'UNIQUE'
           AND constraint_name = %s
        """,
        (table, constraint_name),
    )
    return cur.fetchone() is not None


def apply_ddl(cur) -> None:
    """4条幂等 DDL, 与 alembic 0118 / init_database.py 同步。每条独立 try 但同事务。"""
    statements = [
        (
            "ALTER TABLE scm_stock_check_k3_writeback "
            "ADD COLUMN IF NOT EXISTS counter_user_id BIGINT",
            "counter_user_id 列",
        ),
        (
            "ALTER TABLE scm_stock_check_k3_writeback "
            "ADD COLUMN IF NOT EXISTS manager_id BIGINT",
            "manager_id 列",
        ),
        (
            "ALTER TABLE scm_stock_check_k3_writeback "
            "DROP CONSTRAINT IF EXISTS uq_sckw_check_type_wh",
            "DROP 旧唯一约束 uq_sckw_check_type_wh",
        ),
        (
            "ALTER TABLE scm_stock_check_k3_writeback "
            "ADD CONSTRAINT uq_sckw_check_type_wh_user "
            "UNIQUE (check_id, bill_type, wh_id, counter_user_id)",
            "ADD 新唯一约束 uq_sckw_check_type_wh_user",
        ),
    ]
    for sql, label in statements:
        cur.execute(sql)
        print(f"[DDL] {label}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只读模式: 打印目标 DDL 与当前 schema 状态，但不执行 ALTER。",
    )
    args = parser.parse_args()

    load_env()
    url = get_sync_url()
    masked = url.split("@")[-1] if "@" in url else url
    print(f"[conn] {masked}")
    print(f"[mode] {'dry-run' if args.dry_run else 'execute'}")

    conn = psycopg2.connect(url)
    try:
        conn.autocommit = False
        with conn.cursor() as cur:
            pre_cid = column_exists(cur, "scm_stock_check_k3_writeback", "counter_user_id")
            pre_mid = column_exists(cur, "scm_stock_check_k3_writeback", "manager_id")
            pre_old = constraint_exists(cur, "scm_stock_check_k3_writeback", "uq_sckw_check_type_wh")
            pre_new = constraint_exists(cur, "scm_stock_check_k3_writeback", "uq_sckw_check_type_wh_user")
            print(
                f"[pre-check] counter_user_id={pre_cid} manager_id={pre_mid} "
                f"uq_old={pre_old} uq_new={pre_new}"
            )

            if args.dry_run:
                print("\n[plan]")
                if not pre_cid:
                    print("  + ALTER TABLE scm_stock_check_k3_writeback ADD COLUMN counter_user_id BIGINT")
                if not pre_mid:
                    print("  + ALTER TABLE scm_stock_check_k3_writeback ADD COLUMN manager_id BIGINT")
                if pre_old:
                    print("  - ALTER TABLE scm_stock_check_k3_writeback DROP CONSTRAINT uq_sckw_check_type_wh")
                if not pre_new:
                    print("  + ALTER TABLE scm_stock_check_k3_writeback "
                          "ADD CONSTRAINT uq_sckw_check_type_wh_user UNIQUE (check_id, bill_type, wh_id, counter_user_id)")
                if pre_cid and pre_mid and pre_new and not pre_old:
                    print("  (nothing to do — schema already up to date)")
                print("\n[dry-run] 跳过 ALTER")
                conn.rollback()
                return 0

            apply_ddl(cur)
            conn.commit()
            print("[commit] ok")

        with conn.cursor() as cur:
            post_cid = column_exists(cur, "scm_stock_check_k3_writeback", "counter_user_id")
            post_mid = column_exists(cur, "scm_stock_check_k3_writeback", "manager_id")
            post_old = constraint_exists(cur, "scm_stock_check_k3_writeback", "uq_sckw_check_type_wh")
            post_new = constraint_exists(cur, "scm_stock_check_k3_writeback", "uq_sckw_check_type_wh_user")
            print(
                f"[post-check] counter_user_id={post_cid} manager_id={post_mid} "
                f"uq_old={post_old} uq_new={post_new}"
            )
            ok = post_cid and post_mid and post_new and not post_old
            print("[result]", "PASS" if ok else "FAIL — schema mismatch after migration")
            return 0 if ok else 2
    except Exception as e:
        conn.rollback()
        print(f"[error] {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())