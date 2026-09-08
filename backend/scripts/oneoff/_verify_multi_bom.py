"""Quick verification for multi-level BOM expansion.

Run from backend/ dir:
    python scripts\oneoff\_verify_multi_bom.py
"""
import asyncio
import sys
from pathlib import Path

# Ensure backend/ is importable
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # backend/

from sqlalchemy import select, text
from app.core.database import AsyncSessionLocal
from app.models.basicdata.bom import Bom
from app.models.basicdata.bom_detail import BomDetail
from app.models.order.sale_order import SaleOrderLine
from app.services.order.order_materials_service import _expand_bom_tree, get_order_product_materials


async def find_multilevel_order() -> str | None:
    async with AsyncSessionLocal() as db:
        # Find a sale_order_line whose bom has a child material that itself has a BOM
        sql = text("""
            SELECT DISTINCT line.order_no
            FROM sale_order_line line
            JOIN scm_bom_detail d ON d.bom_id = line.bom_id::text
            JOIN scm_bom sub ON sub.material_id = d.material_id
            WHERE line.bom_id IS NOT NULL
            LIMIT 5
        """)
        result = await db.execute(sql)
        rows = result.fetchall()
        if not rows:
            print("[WARN] No multi-level BOM order found; falling back to any order with bom_id")
            sql2 = text("""
                SELECT DISTINCT order_no FROM sale_order_line
                WHERE bom_id IS NOT NULL LIMIT 5
            """)
            result2 = await db.execute(sql2)
            rows = result2.fetchall()
        for r in rows:
            return r[0]
        return None


async def main():
    order_no = await find_multilevel_order()
    if not order_no:
        print("[FAIL] No order with BOM found in DB")
        return
    print(f"[INFO] Testing order_no = {order_no}")

    async with AsyncSessionLocal() as db:
        result = await get_order_product_materials(db, order_no)

    print(f"[INFO] Got {len(result)} product lines")
    total_nodes = 0
    max_depth_seen = 1
    for line in result:
        print(f"\n=== Line {line.line_no}: {line.product_code} ({line.product_name}) ===")
        print(f"    order_qty={line.order_qty}, top-level materials={len(line.materials)}")

        def walk(node, indent=4):
            nonlocal total_nodes, max_depth_seen
            total_nodes += 1
            if node.level > max_depth_seen:
                max_depth_seen = node.level
            sub = " [组件,有子BOM]" if node.has_sub_bom else ""
            child_count = len(node.children)
            print(" " * indent + f"- L{node.level} {node.material_code} | std={node.standard_qty} | req={node.req_qty}{sub} (children={child_count})")
            for c in node.children:
                walk(c, indent + 2)

        for m in line.materials:
            walk(m)

    print(f"\n[SUMMARY] total_nodes={total_nodes}, max_depth={max_depth_seen}")
    if max_depth_seen >= 2:
        print("[PASS] Multi-level expansion confirmed (depth >= 2)")
    else:
        print("[NOTE] Only single level — pick another order or data has no nested BOMs")


if __name__ == "__main__":
    asyncio.run(main())
