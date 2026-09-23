"""清理 E2E 残留测试数据 + 打印通知路由（只做这两件事）。"""
import asyncio

from sqlalchemy import text

from app.core.database import AsyncSessionLocal


async def main() -> None:
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(text(
            "SELECT id, check_no, status, title FROM scm_inventory_check WHERE title LIKE 'E2E%' ORDER BY id"
        ))).fetchall()
        print("E2E 残留:", [(r[0], r[1], r[2], r[3]) for r in rows] or "无")
        if rows:
            ids = [r[0] for r in rows]
            n1 = (await db.execute(text(
                "DELETE FROM notification WHERE ref_type = 'stock_check' AND ref_id = ANY(:ids)"
            ), {"ids": ids})).rowcount
            n2 = (await db.execute(text(
                "DELETE FROM scm_inventory_check WHERE id = ANY(:ids)"
            ), {"ids": ids})).rowcount
            await db.commit()
            print(f"已清理: 盘点单 {n2} 张, 通知 {n1} 条")

    from app.main import app
    paths = sorted({r.path for r in app.routes if "notification" in r.path})
    print("notification 路由:", paths)


if __name__ == "__main__":
    asyncio.run(main())
