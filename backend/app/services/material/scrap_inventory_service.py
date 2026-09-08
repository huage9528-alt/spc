"""报废物料清单 — 库存关联查询服务（一次性查询工具，无状态，不写库）。

- 粘贴/文件输入物料代码清单（CSV 支持 GBK/UTF-8，XLSX 取首两列）
- 关联 scm_inventory 按物料合计 qty_on_hand；无库存行的代码回查 scm_material 区分
  「库存为零」（中台有此物料但无库存记录/合计为0）与「中台无此物料」
- 结果保持输入顺序；未匹配行名称回退用清单里的名称
"""

from __future__ import annotations

import csv
import io
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from openpyxl import load_workbook
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.basicdata.inventory import Inventory
from app.models.basicdata.material import Material

SCRAP_MAX_CODES = 2000
SCRAP_QUERY_CHUNK = 500

STATUS_HAS_STOCK = "有库存"
STATUS_ZERO_STOCK = "库存为零"
STATUS_NOT_FOUND = "中台无此物料"

# 与 scm_inventory.material_code / scm_material.material_code 列宽对齐
_CODE_MAX_LEN = 50


def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def normalize_code_list(codes: List[str]) -> List[Tuple[str, str]]:
    """粘贴输入的代码列表 → [(code, "")]。strip / 去空 / 去重(保持首现顺序) / 上限校验。"""
    seen: set = set()
    ordered: List[str] = []
    for raw in codes or []:
        code = (raw or "").strip()
        if not code or code in seen:
            continue
        seen.add(code)
        ordered.append(code)
    if not ordered:
        raise ValueError("物料代码列表为空")
    if len(ordered) > SCRAP_MAX_CODES:
        raise ValueError(f"物料代码数量超过上限 {SCRAP_MAX_CODES}（当前 {len(ordered)}）")
    return [(c, "") for c in ordered]


def _decode_text(content: bytes) -> str:
    """CSV 解码：去 UTF-8 BOM → UTF-8 严格解码 → GBK 回退。"""
    if content.startswith(b"\xef\xbb\xbf"):
        return content[3:].decode("utf-8")
    for enc in ("utf-8", "gbk"):
        try:
            return content.decode(enc)
        except UnicodeDecodeError:
            continue
    raise ValueError("文件编码无法识别（支持 UTF-8 / GBK）")


def _cell_str(v) -> Optional[str]:
    """单元格转字符串：Excel 数字编码(如 101023.0)转 '101023'；空白转 None。"""
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, int):
        return str(v)
    s = str(v).strip()
    return s or None


def _is_header(code_cell: str) -> bool:
    return any(k in code_cell for k in ("物料", "代码", "编码"))


def _finalize_rows(pairs: List[Tuple[Optional[str], Optional[str]]]) -> Tuple[List[Tuple[str, str]], List[str], int]:
    """[(code, name) or (None, None)] → 去空行/跳表头/去重/长度校验。返回 (rows, invalid 行提示, 重复数)。

    表头识别：首格含「物料/代码/编码」的行全部跳过（清单常有多行表头：标题行 + 列头行，
    真实物料代码不含这些字样，全跳是安全的）。"""
    rows: List[Tuple[str, str]] = []
    invalid: List[str] = []
    dup = 0
    seen: set = set()
    for rowno, (code, name) in enumerate(pairs, start=1):
        if code is None:
            continue
        if _is_header(code):
            continue
        if len(code) > _CODE_MAX_LEN:
            invalid.append(f"第 {rowno} 行代码超长（>{_CODE_MAX_LEN}字符），已忽略：{code[:30]}…")
            continue
        if code in seen:
            dup += 1
            continue
        seen.add(code)
        rows.append((code, name or ""))
    return rows, invalid, dup


def _parse_csv(content: bytes) -> List[Tuple[Optional[str], Optional[str]]]:
    text = _decode_text(content)
    sample = ""
    for line in text.splitlines():
        if line.strip():
            sample = line
            break
    counts = {",": sample.count(","), "\t": sample.count("\t"), ";": sample.count(";")}
    delimiter = max(counts, key=counts.get)
    if max(counts.values()) == 0:
        delimiter = ","
    dialect = "excel-tab" if delimiter == "\t" else "excel"
    if delimiter == ";":
        class _SemicolonDialect(csv.excel):
            delimiter = ";"
        dialect = _SemicolonDialect
    out: List[Tuple[Optional[str], Optional[str]]] = []
    for rec in csv.reader(io.StringIO(text), dialect=dialect):
        if not rec:
            out.append((None, None))
            continue
        code = (rec[0] or "").strip() or None
        name = (rec[1].strip() if len(rec) > 1 and rec[1] else None)
        out.append((code, name))
    return out


def _parse_xlsx(content: bytes) -> List[Tuple[Optional[str], Optional[str]]]:
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception as e:
        raise ValueError(f"Excel 解析失败: {e}")
    try:
        ws = wb.active
        out: List[Tuple[Optional[str], Optional[str]]] = []
        for rec in ws.iter_rows(values_only=True):
            code = _cell_str(rec[0]) if len(rec) > 0 else None
            name = _cell_str(rec[1]) if len(rec) > 1 else None
            out.append((code, name))
        return out
    finally:
        wb.close()


def parse_scrap_list_file(content: bytes, filename: str) -> Tuple[List[Tuple[str, str]], List[str], int]:
    """解析上传的清单文件 → ([(code, name)], 无效行提示列表, 重复行数)。第 1 列代码、第 2 列名称(可选)。"""
    if not content:
        raise ValueError("文件为空")
    name = (filename or "").lower()
    if name.endswith(".csv"):
        pairs = _parse_csv(content)
    elif name.endswith((".xlsx", ".xlsm")):
        pairs = _parse_xlsx(content)
    elif name.endswith(".xls"):
        raise ValueError("不支持旧版 .xls，请另存为 .xlsx 或 .csv 后重试")
    else:
        try:
            pairs = _parse_xlsx(content)
        except ValueError:
            pairs = _parse_csv(content)
    rows, invalid, dup = _finalize_rows(pairs)
    if not rows and not invalid:
        raise ValueError("文件中没有数据行")
    if len(rows) > SCRAP_MAX_CODES:
        raise ValueError(f"物料代码数量超过上限 {SCRAP_MAX_CODES}（当前 {len(rows)}）")
    return rows, invalid, dup


async def query_scrap_inventory(db: AsyncSession, rows: List[Tuple[str, str]]) -> dict:
    """按物料代码清单查询即时库存合计 + 仓库分布明细。

    返回 {items, stats, codes}，items 保持输入顺序；
    items[].warehouses 为按数量降序的仓库明细（含锁定/在途/最近出入库，供明细抽屉使用）；
    stats.total_qty 为有库存行的在库合计。"""
    codes = [c for c, _ in rows]

    wh_rows_by_code: Dict[str, List[dict]] = {}
    name_by_code: Dict[str, str] = {}
    for chunk in _chunks(codes, SCRAP_QUERY_CHUNK):
        res = await db.execute(
            select(
                Inventory.material_code,
                Inventory.material_name,
                Inventory.wh_id,
                Inventory.wh_code,
                Inventory.wh_name,
                Inventory.qty_on_hand,
                Inventory.locked_qty,
                Inventory.qty_in_transit,
                Inventory.last_inbound_at,
                Inventory.last_outbound_at,
            )
            .where(Inventory.material_code.in_(chunk))
        )
        for code, mname, wh_id, wh_code, wh_name, qty, locked, transit, last_in, last_out in res.all():
            if code is None:
                continue
            wh_rows_by_code.setdefault(code, []).append({
                "wh_id": wh_id,
                "wh_code": wh_code,
                "wh_name": wh_name,
                "qty": round(float(qty if qty is not None else Decimal(0)), 2),
                "locked_qty": round(float(locked if locked is not None else Decimal(0)), 2),
                "qty_in_transit": round(float(transit if transit is not None else Decimal(0)), 2),
                "last_inbound_at": last_in.strftime("%m-%d %H:%M") if last_in else None,
                "last_outbound_at": last_out.strftime("%m-%d %H:%M") if last_out else None,
            })
            if mname and code not in name_by_code:
                name_by_code[code] = mname

    qty_by_code: Dict[str, float] = {}
    for code, wh_rows in wh_rows_by_code.items():
        qty_by_code[code] = round(sum(r["qty"] for r in wh_rows), 2)

    remaining = [c for c in codes if c not in qty_by_code]
    material_existing: set = set()
    if remaining:
        for chunk in _chunks(remaining, SCRAP_QUERY_CHUNK):
            res = await db.execute(
                select(Material.material_code, Material.material_name)
                .where(Material.material_code.in_(chunk), Material.is_deleted == 0)
            )
            for code, mname in res.all():
                material_existing.add(code)
                if mname:
                    name_by_code[code] = mname

    items: List[dict] = []
    stats = {"total": len(rows), "has_stock": 0, "zero_stock": 0, "not_found": 0, "total_qty": 0.0}
    for code, input_name in rows:
        name = name_by_code.get(code) or input_name or ""
        warehouses = sorted(wh_rows_by_code.get(code, []), key=lambda r: r["qty"], reverse=True)
        if code in qty_by_code and qty_by_code[code] > 0:
            status = STATUS_HAS_STOCK
            stats["has_stock"] += 1
            total_qty = qty_by_code[code]
            stats["total_qty"] = round(stats["total_qty"] + total_qty, 2)
        elif code in qty_by_code or code in material_existing:
            status = STATUS_ZERO_STOCK
            stats["zero_stock"] += 1
            total_qty = 0.0
        else:
            status = STATUS_NOT_FOUND
            stats["not_found"] += 1
            total_qty = 0.0
        items.append({
            "material_code": code,
            "material_name": name,
            "total_qty": total_qty,
            "status": status,
            "warehouses": warehouses,
        })
    return {"items": items, "stats": stats, "codes": codes}
