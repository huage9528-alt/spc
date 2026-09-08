"""Unit tests for _expand_bom_tree BFS recursion using a mock DB session.

Run from backend/ dir:
    python scripts\oneoff\_test_bom_bfs.py

Covers:
- empty root
- 3-level tree with base_qty scaling
- cycle protection
- multi-BOM-per-material selection (pick the one with details)
- leaf when no sub-BOM has details
"""
import asyncio
import sys
from pathlib import Path
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # backend/

from app.services.order.order_materials_service import _expand_bom_tree


class FakeDB:
    """Routes each .execute() to a canned result by matching SQL substrings.

    Matchers are checked in insertion order; first hit wins. Each matcher's
    queue is consumed in FIFO order (one entry per execute call).
    """
    def __init__(self, matchers):
        # matchers: list of (substring, [canned scalar lists]) — order matters
        self._matchers = matchers
        self.calls = []

    async def execute(self, stmt):
        sql_text = str(stmt)
        self.calls.append(sql_text)
        for key, queue in self._matchers:
            if key in sql_text and queue:
                canned = queue.pop(0)
                mock = MagicMock()
                mock.scalars.return_value.all.return_value = canned
                # for SELECT DISTINCT col queries, the result also needs fetchall()
                mock.fetchall.return_value = canned
                return mock
        mock = MagicMock()
        mock.scalars.return_value.all.return_value = []
        mock.fetchall.return_value = []
        return mock


def mk_bom(bom_id, material_id, base_qty=Decimal("1"), is_audited=1, void_flag=0, disabled_status=0):
    return SimpleNamespace(
        bom_id=bom_id, material_id=material_id, base_qty=base_qty,
        is_audited=is_audited, void_flag=void_flag, disabled_status=disabled_status,
    )


def mk_detail(bom_id, line_no, material_id, standard_qty):
    return SimpleNamespace(
        bom_id=bom_id, line_no=line_no, material_id=material_id,
        standard_qty=Decimal(standard_qty), aux_qty=None, material_type=None,
        config_type=None, lead_offset_days=None, back_flush=0, scrap_rate=None,
        oper_sn=None, process_id=None, warehouse_id=None, valid_date=None,
        invalid_date=None, kit_flag=0,
    )


def mk_material(erp_material_id, code):
    return SimpleNamespace(
        erp_material_id=erp_material_id, material_code=code, material_name=f"name-{code}",
        spec_model=None, unit_of_measure="PCS", material_type=None,
        material_property=None,
    )


def mk_detail_id_row(bom_id):
    """A row from SELECT DISTINCT bom_id — real SQLAlchemy Row supports row[0]."""
    return (bom_id,)


async def test_three_level_tree():
    """ROOT -> A (subA, base_qty=2) -> A1 ; ROOT -> B (leaf).

    纯连乘公式（无 base_qty 除法）：
      factor(root) = 订单数量 = 10
      req(A)  = std(A)  × factor = 4 × 10 = 40
      req(A1) = std(A1) × req(A) = 5 × 40 = 200
    """
    db = FakeDB([
        # 1) Full BomDetail rows per level (3 calls expected: but detail-id queries
        #    also match "scm_bom_detail" — put DISTINCT first so it wins those)
        ("DISTINCT scm_bom_detail.bom_id", [
            [mk_detail_id_row("SUBA")],   # L1: candidate sub-boms with details
            [],                            # L2: A1 has no sub-boms
        ]),
        ("FROM scm_bom_detail", [
            [mk_detail("R", "1", 100, "4"), mk_detail("R", "2", 200, "1")],  # L1 details
            [mk_detail("SUBA", "1", 999, "5")],                                # L2 details
        ]),
        ("FROM scm_material", [
            [mk_material(100, "CODE-A"), mk_material(200, "CODE-B")],
            [mk_material(999, "CODE-A1")],
        ]),
        ("FROM scm_bom", [
            [mk_bom("SUBA", 100, base_qty=Decimal("2"))],
            [],
        ]),
    ])
    tree = await _expand_bom_tree(db, "R", Decimal("10"))
    assert len(tree) == 2
    a_node = next(n for n in tree if n.material_code == "CODE-A")
    b_node = next(n for n in tree if n.material_code == "CODE-B")
    assert a_node.req_qty == 40.0, f"A req_qty should be 4*10=40, got {a_node.req_qty}"
    assert a_node.has_sub_bom is True
    assert b_node.has_sub_bom is False
    assert b_node.req_qty == 10.0
    assert len(a_node.children) == 1
    a1 = a_node.children[0]
    assert a1.level == 2
    assert a1.req_qty == 200.0, f"A1 req_qty should be 5*40=200 (pure multiplication, no /base_qty), got {a1.req_qty}"
    assert a1.parent_material_id == 100
    assert a1.has_sub_bom is False
    print("[PASS] 3-level tree: ROOT -> A(req=40) -> A1(req=200); B leaf")


async def test_cycle_protection():
    """Cyclic BOM (R -> A -> back to R-equivalent) must terminate."""
    db = FakeDB([
        ("DISTINCT scm_bom_detail.bom_id", [
            [mk_detail_id_row("SUBA")],
            [],
        ]),
        ("FROM scm_bom_detail", [
            [mk_detail("R", "1", 100, "1")],
            [mk_detail("SUBA", "1", 100, "1")],
        ]),
        ("FROM scm_material", [
            [mk_material(100, "CODE-A")],
            [],
        ]),
        ("FROM scm_bom", [
            [mk_bom("SUBA", 100)],
            [],
        ]),
    ])
    tree = await _expand_bom_tree(db, "R", Decimal("1"))
    assert len(tree) == 1
    assert len(tree[0].children) == 1
    print("[PASS] Cycle protection: terminates without infinite loop")


async def test_empty_root():
    db = FakeDB([])
    tree = await _expand_bom_tree(db, None, Decimal("1"))
    assert tree == []
    print("[PASS] Empty root returns []")


async def test_multi_bom_picks_one_with_details():
    """Material 100 has TWO boms: EMPTY (no details) and SUBA (has details).
    BFS must pick SUBA, not EMPTY. has_sub_bom=True, children non-empty.
    """
    db = FakeDB([
        # detail-id probe for L1 candidates: only SUBA has details
        ("DISTINCT scm_bom_detail.bom_id", [
            [mk_detail_id_row("SUBA")],
            [],
        ]),
        ("FROM scm_bom_detail", [
            [mk_detail("R", "1", 100, "4")],            # L1: one child A
            [mk_detail("SUBA", "1", 999, "2")],          # L2: SUBA's details
        ]),
        ("FROM scm_material", [
            [mk_material(100, "CODE-A")],
            [mk_material(999, "CODE-A1")],
        ]),
        # Bom query returns BOTH EMPTY and SUBA for material 100
        ("FROM scm_bom", [
            [mk_bom("EMPTY", 100, base_qty=Decimal("1")),
             mk_bom("SUBA", 100, base_qty=Decimal("1"))],
            [],
        ]),
    ])
    tree = await _expand_bom_tree(db, "R", Decimal("1"))
    assert len(tree) == 1
    a = tree[0]
    assert a.material_code == "CODE-A"
    assert a.has_sub_bom is True, "should be True because SUBA (with details) exists"
    assert len(a.children) == 1, "should expand via SUBA, not EMPTY"
    assert a.children[0].material_code == "CODE-A1"
    # The chosen sub-bom must be SUBA (reflected via child's bom_id)
    assert a.children[0].bom_id == "SUBA", f"should pick SUBA, got {a.children[0].bom_id}"
    print("[PASS] Multi-BOM: picks SUBA (with details) over EMPTY (leaf)")


async def test_no_details_means_leaf():
    """Material 100 has a BOM header but NO details anywhere.
    has_sub_bom should be False (nothing to expand), children empty.
    """
    db = FakeDB([
        ("DISTINCT scm_bom_detail.bom_id", [
            [],  # no candidate has details
        ]),
        ("FROM scm_bom_detail", [
            [mk_detail("R", "1", 100, "4")],  # L1 child A
        ]),
        ("FROM scm_material", [
            [mk_material(100, "CODE-A")],
        ]),
        ("FROM scm_bom", [
            [mk_bom("BOM100", 100)],  # header exists, but no details
        ]),
    ])
    tree = await _expand_bom_tree(db, "R", Decimal("1"))
    assert len(tree) == 1
    a = tree[0]
    assert a.has_sub_bom is False, "no details → must be leaf, not '组件'"
    assert a.children == []
    print("[PASS] BOM header without details → leaf (has_sub_bom=False)")


async def main():
    await test_empty_root()
    await test_three_level_tree()
    await test_cycle_protection()
    await test_multi_bom_picks_one_with_details()
    await test_no_details_means_leaf()
    print("\nAll BFS tests passed.")


if __name__ == "__main__":
    asyncio.run(main())
