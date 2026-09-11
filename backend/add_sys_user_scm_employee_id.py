"""一次性迁移脚本：为 sys_user 添加 scm_employee_id 字段并按 emp_code / display_name 回填 id 值。

用途:
    在已部署但未跑新版本 init_database.py 的环境里手动补字段；
    或作为 init_database.py migrate_columns 的旁路执行通道。
    幂等，可重复执行。

回填规则:
    一级 (emp_code):   emp_code = scm_employee.emp_code
    二级 (display_name): display_name = scm_employee.emp_name
                       仅在 scm_employee.emp_name 全局唯一时启用；
                       同时回填 emp_code 以保持单一事实来源。
    两级都是 scm_employee_id IS NULL 才更新，幂等。

跑法:
    cd backend && python add_sys_user_scm_employee_id.py [--dry-run] [--no-name-match]

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


def add_column(cur) -> bool:
    """ADD COLUMN IF NOT EXISTS; 返回是否新增了列。"""
    cur.execute(
        "ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS scm_employee_id BIGINT"
    )
    print("[DDL] ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS scm_employee_id BIGINT")


def backfill(cur) -> int:
    """按 emp_code 回填 scm_employee_id; 返回更新行数。"""
    cur.execute(
        """
        UPDATE sys_user AS u
           SET scm_employee_id = e.id
          FROM scm_employee AS e
         WHERE u.scm_employee_id IS NULL
           AND u.emp_code IS NOT NULL
           AND u.emp_code <> ''
           AND e.emp_code = u.emp_code
        """
    )
    return cur.rowcount


def backfill_by_name(cur) -> int:
    """二级回填: 在 emp_code 匹配后,剩余无 scm_employee_id 的行按 display_name = emp_name
    匹配,同时回填 emp_code 和 scm_employee_id。前提: scm_employee.emp_name 全局唯一(脚本
    检查),且 display_name 非空非纯角色标签。"""
    cur.execute(
        """
        UPDATE sys_user AS u
           SET scm_employee_id = e.id,
               emp_code = e.emp_code
          FROM scm_employee AS e
         WHERE u.scm_employee_id IS NULL
           AND (u.emp_code IS NULL OR u.emp_code = '')
           AND u.display_name IS NOT NULL
           AND u.display_name <> ''
           AND e.emp_name = u.display_name
        """
    )
    return cur.rowcount


def has_unique_emp_names(cur) -> bool:
    cur.execute(
        """
        SELECT 1
          FROM scm_employee
         GROUP BY emp_name
        HAVING COUNT(*) > 1
         LIMIT 1
        """
    )
    return cur.fetchone() is None


def preview_name_match(cur, with_scm_employee_id: bool) -> list[tuple]:
    """姓名匹配候选预览 (scm_employee_id IS NULL + emp_code 为空 + display_name = emp_name)."""
    extra_select = "u.scm_employee_id," if with_scm_employee_id else "NULL::BIGINT AS scm_employee_id,"
    cur.execute(
        f"""
        SELECT u.id, u.username, u.display_name, u.role_id, {extra_select}
               e.id AS candidate_employee_id, e.emp_code AS candidate_emp_code,
               e.emp_name AS candidate_emp_name, e.erp_user_id AS candidate_erp_user_id
          FROM sys_user u
          JOIN sys_role r ON r.id = u.role_id
          JOIN scm_employee e ON e.emp_name = u.display_name
         WHERE u.scm_employee_id IS NULL
           AND (u.emp_code IS NULL OR u.emp_code = '')
           AND u.display_name IS NOT NULL
           AND u.display_name <> ''
         ORDER BY u.id
        """
    )
    return cur.fetchall()


def preview(cur, with_scm_employee_id: bool) -> list[tuple]:
    """回填前后预览: emp_code 有值的用户 + 候选员工 id.
    with_scm_employee_id=False 时不查询该列(列尚未建时也能跑 dry-run)."""
    extra_select = "u.scm_employee_id," if with_scm_employee_id else "NULL::BIGINT AS scm_employee_id,"
    cur.execute(
        f"""
        SELECT u.id, u.username, u.display_name, u.emp_code, {extra_select}
               e.id AS candidate_employee_id, e.emp_code AS candidate_emp_code,
               e.emp_name AS candidate_emp_name
          FROM sys_user u
          LEFT JOIN scm_employee e ON e.emp_code = u.emp_code
         WHERE u.emp_code IS NOT NULL
           AND u.emp_code <> ''
         ORDER BY u.id
        """
    )
    return cur.fetchall()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只读模式: 打印将回填的行 + 候选员工，但不执行 UPDATE / ALTER",
    )
    parser.add_argument(
        "--no-name-match",
        action="store_true",
        help="跳过二级姓名匹配（仅按 emp_code 回填）。默认开启姓名匹配。",
    )
    args = parser.parse_args()
    name_match_enabled = not args.no_name_match

    load_env()
    url = get_sync_url()
    print(f"[conn] {url.split('@')[-1] if '@' in url else url}")
    print(f"[mode] {'dry-run' if args.dry_run else 'execute'}")
    print(f"[name-match] {'on' if name_match_enabled else 'off'}")

    conn = psycopg2.connect(url)
    try:
        conn.autocommit = False
        with conn.cursor() as cur:
            # 1. 列存在性检查
            existed = column_exists(cur, "sys_user", "scm_employee_id")
            print(f"[check] sys_user.scm_employee_id exists: {existed}")

            # 2. 一级预览：按 emp_code 匹配
            print("\n[preview-1] sys_user rows with emp_code:")
            print(
                "  {:<6} {:<20} {:<16} {:<14} {:<14} {:<16} {:<20}".format(
                    "u.id", "username", "emp_code", "scm_emp_id", "candidate_id", "candidate_code", "candidate_name"
                )
            )
            rows = preview(cur, with_scm_employee_id=existed)
            matched = 0
            unmatched = 0
            already_set = 0
            for r in rows:
                uid, uname, dname, emp, cur_eid, cand_id, cand_code, cand_name = r
                cur_eid_s = "NULL" if cur_eid is None else str(cur_eid)
                cand_id_s = "MISS" if cand_id is None else str(cand_id)
                if cur_eid is not None:
                    already_set += 1
                elif cand_id is not None:
                    matched += 1
                else:
                    unmatched += 1
                print(
                    f"  {uid:<6} {uname:<20} {emp:<16} {cur_eid_s:<14} "
                    f"{cand_id_s:<14} {(cand_code or ''):<16} {(cand_name or ''):<20}"
                )
            print(
                f"\n[summary-1] matched={matched}, unmatched={unmatched}, "
                f"already_set={already_set}"
            )

            # 2.5 二级预览：按 display_name = emp_name 匹配
            if name_match_enabled:
                unique_ok = has_unique_emp_names(cur)
                if not unique_ok:
                    print(
                        "\n[preview-2] SKIPPED: scm_employee.emp_name 存在重名,"
                        "为防误匹配关闭二级回填。请先在 ERP 同步侧消歧。"
                    )
                else:
                    print(
                        "\n[preview-2] name-match 候选 "
                        "(scm_employee_id IS NULL + emp_code 空 + display_name = emp_name):"
                    )
                    print(
                        "  {:<6} {:<20} {:<16} {:<8} {:<12} {:<12} {:<16} {:<14}".format(
                            "u.id", "username", "display_name", "role_id",
                            "cand_eid", "cand_emp_code", "cand_emp_name", "cand_erp_uid"
                        )
                    )
                    nm_rows = preview_name_match(cur, with_scm_employee_id=existed)
                    for r in nm_rows:
                        uid, uname, dname, role_id, cur_eid, cand_id, cand_code, cand_name, cand_erp = r
                        cur_eid_s = "NULL" if cur_eid is None else str(cur_eid)
                        print(
                            f"  {uid:<6} {uname:<20} {dname:<16} {role_id:<8} "
                            f"{cand_id:<12} {cand_code:<12} {cand_name:<16} {cand_erp:<14}"
                        )
                    print(f"\n[summary-2] name-match candidates: {len(nm_rows)}")

            if args.dry_run:
                print("\n[dry-run] 跳过 DDL 与 DML")
                conn.rollback()
                return 0

            # 3. ADD COLUMN
            if not existed:
                add_column(cur)

            # 4. 一级回填
            updated = backfill(cur)
            print(f"\n[backfill-1] emp_code -> scm_employee_id: {updated}")

            # 4.5 二级回填
            if name_match_enabled:
                unique_ok = has_unique_emp_names(cur)
                if not unique_ok:
                    print("[backfill-2] SKIPPED: scm_employee.emp_name 存在重名")
                else:
                    updated2 = backfill_by_name(cur)
                    print(f"[backfill-2] display_name -> scm_employee_id: {updated2}")

            # 5. 提交
            conn.commit()
            print("[commit] ok")

        # 6. 提交后再次核对实际值
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*) FILTER (WHERE scm_employee_id IS NOT NULL) AS filled,
                    COUNT(*) FILTER (WHERE scm_employee_id IS NULL AND emp_code IS NOT NULL AND emp_code <> '') AS unfilled_with_code,
                    COUNT(*) FILTER (WHERE scm_employee_id IS NULL AND (emp_code IS NULL OR emp_code = '')) AS no_emp_code
                  FROM sys_user
                """
            )
            filled, unfilled_with_code, no_emp_code = cur.fetchone()
            print(
                f"[post-check] filled={filled}, "
                f"unfilled_with_code={unfilled_with_code}, "
                f"no_emp_code={no_emp_code}"
            )
        return 0
    except Exception as e:
        conn.rollback()
        print(f"[error] {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())