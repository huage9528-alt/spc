"""快捷盘点 — Excel 批量导入服务

流程: 解析 xlsx → 内存全量校验(任一失败不写库) → 单事务写入当前用户当日快捷盘点单。
- 实盘数量留空 = 盘平(以导入时账面快照填入 actual_qty)
- 仓库留空: 物料唯一仓库自动选中; 无库存记录 → "(未入库)" 行(数量0);
  多仓库且实盘留空(盘平) → 展开为每仓一行各取本仓快照; 多仓库且填了实盘 → 行报错
- 当日已有同 (物料,仓库) 行 = 覆盖重盘(与快捷盘点扫码重录一致)
- 可选「盘点日期」列: 留空或=今天→导入;≠今天→跳过并在结果汇总(累积文件每日重导场景)。
  无该列的旧模板仍全量导入(全部视作今日)。
- 上限 5000 行; 查询与写入内部按 500 行/批拆分,但仍单事务(整份拒收语义不变)
"""

from __future__ import annotations

import io
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Dict, List, Optional, Tuple

from fastapi import UploadFile
from openpyxl import load_workbook
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.basicdata.material import Material
from app.models.material.inventory_check import StockCheck, StockCheckItem
from app.services.material.stock_check_broker import publish_event
from app.services.material.stock_check_service import (
    QUICK_CHECK_TITLE_PREFIX,
    _close_stale_quick_checks,
    _current_user_id,
    _exclude_check_wh_from_stock_map,
    _gen_check_no,
    _get_stock_by_warehouse,
    _next_seq_for_today,
    _refresh_check_aggregates,
)

QUICK_IMPORT_MAX_ROWS = 5000
# 分批大小: 物料/库存校验查询的 IN 列表、写入阶段的 flush 均按此拆批,
# 避免数千行时单条 SQL 过大 / ORM 会话对象积压。仍为单事务,整份拒收语义不变。
IMPORT_CHUNK_SIZE = 500

# 模板列(表头精确匹配,允许多余列被忽略)
COL_MATERIAL_CODE = "物料编码"
COL_ACTUAL_QTY = "实盘数量"
COL_WAREHOUSE = "仓库"
COL_CHECK_DATE = "盘点日期"
COL_REMARK = "备注"
TEMPLATE_HEADERS = [COL_MATERIAL_CODE, COL_ACTUAL_QTY, COL_WAREHOUSE, COL_CHECK_DATE, COL_REMARK]


class ExcelImportValidationError(Exception):
    """导入校验失败。errors 为行级错误列表(全部错误一次性给出)。"""

    def __init__(self, errors: List[str]):
        self.errors = errors
        super().__init__(f"导入校验失败,共 {len(errors)} 处错误")


def _cell_str(v) -> Optional[str]:
    """单元格转字符串: Excel 数字编码(如 101023.0)转 '101023';空白转 None。"""
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, int):
        return str(v)
    s = str(v).strip()
    return s or None


def _cell_qty(v) -> Optional[Decimal]:
    """单元格转数量: None/空白→None; 数字/数字串→Decimal; 非法→抛 ValueError。"""
    s = _cell_str(v)
    if s is None:
        return None
    try:
        q = Decimal(s)
    except InvalidOperation:
        raise ValueError(f"实盘数量 '{s}' 不是合法数字")
    if q < 0:
        raise ValueError(f"实盘数量 '{s}' 不能为负数")
    return q


def _cell_date(v, today: date) -> Optional[date]:
    """单元格转日期: 空白→None(视作今日); date/datetime→date;
    字符串支持 2026-08-26 / 2026/8/26 / 2026.8.26 / 08-26 / 8/26(补当前年);
    无法识别抛 ValueError。"""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = _cell_str(v)
    if s is None:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    for fmt in ("%m-%d", "%m/%d"):
        try:
            return datetime.strptime(s, fmt).date().replace(year=today.year)
        except ValueError:
            continue
    raise ValueError(f"盘点日期 '{s}' 无法识别(支持 2026-08-26 / 2026/8/26 / 08-26)")


def parse_quick_import_excel(content: bytes) -> List[Dict]:
    """解析 xlsx 首个 sheet。首行为表头(精确匹配模板列名,多余列忽略)。
    返回 [{code, actual_qty, wh_raw, check_date, remark}, ...];结构错误抛 ValueError。"""
    if not content:
        raise ValueError("文件为空")
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception as e:
        raise ValueError(f"Excel 解析失败: {e}")
    try:
        ws = wb.active
        rows_iter = ws.iter_rows(values_only=True)
        try:
            headers = [str(h).strip() if h is not None else "" for h in next(rows_iter)]
        except StopIteration:
            raise ValueError("Excel 为空(缺少表头行)")
        idx = {name: i for i, name in enumerate(headers)}
        if COL_MATERIAL_CODE not in idx:
            raise ValueError(
                f"缺少必需列「{COL_MATERIAL_CODE}」,模板列为: {'、'.join(TEMPLATE_HEADERS)}"
            )
        out: List[Dict] = []
        today = date.today()
        for rowno, row in enumerate(rows_iter, start=2):  # 数据从第2行(表头为第1行)
            def cell(name, _row=row):
                i = idx.get(name)
                return _row[i] if i is not None and i < len(_row) else None
            code = _cell_str(cell(COL_MATERIAL_CODE))
            if code is None and all(
                _cell_str(cell(c)) is None
                for c in (COL_ACTUAL_QTY, COL_WAREHOUSE, COL_CHECK_DATE, COL_REMARK)
            ):
                continue  # 整行空白跳过
            try:
                qty = _cell_qty(cell(COL_ACTUAL_QTY))
            except ValueError as e:
                raise ValueError(f"第{rowno}行 实盘数量列错误: {e}")
            try:
                check_date = _cell_date(cell(COL_CHECK_DATE), today)
            except ValueError as e:
                raise ValueError(f"第{rowno}行 {e}")
            out.append({
                "rowno": rowno,
                "code": code,
                "actual_qty": qty,
                "wh_raw": _cell_str(cell(COL_WAREHOUSE)),
                "check_date": check_date,
                "remark": _cell_str(cell(COL_REMARK)),
            })
        return out
    finally:
        wb.close()


def build_import_template() -> bytes:
    """生成导入模板 xlsx(示例行 + 说明 sheet)。"""
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "盘点导入"
    ws.append(TEMPLATE_HEADERS)
    ws.append(["M-0001", None, None, None, "留空实盘数量=盘平;仓库留空=唯一仓库自动匹配(多仓库且盘平时自动展开);盘点日期留空=今日"])
    ws.append(["M-0002", 120, "原材料仓", date.today().isoformat(), "实盘120;今日数据会被导入"])
    ws.append(["M-0003", 80, "原材料仓", (date.today() - timedelta(days=1)).isoformat(), "昨日数据会被跳过(累积文件可每天整份重导)"])
    for col, width in zip("ABCDE", (18, 12, 14, 12, 46)):
        ws.column_dimensions[col].width = width
    info = wb.create_sheet("填写说明")
    lines = [
        ["列名", "必填", "说明"],
        [COL_MATERIAL_CODE, "是", "系统物料编码;不存在或已删除将整单拒收"],
        [COL_ACTUAL_QTY, "否", "实盘数量,≥0;留空=盘平(自动取导入时账面数;多仓库物料每仓各取本仓账面数)"],
        [COL_WAREHOUSE, "否", "仓库名或仓库ID;留空=唯一仓库自动匹配;物料在多个仓库时:实盘数量也留空(盘平)则自动展开为每仓一行,填了实盘数量则必须填写仓库"],
        [COL_CHECK_DATE, "否", "该行盘点日期;留空或=今天→导入今日单;其他日期→跳过该行(每天往同一文件追加、整份重导时只会导入今日数据)"],
        [COL_REMARK, "否", "行备注"],
        ["", "", f"上限 {QUICK_IMPORT_MAX_ROWS} 行(按导入今日的行数计);任一行错误则整份文件不导入"],
    ]
    for line in lines:
        info.append(line)
    info.column_dimensions["A"].width = 12
    info.column_dimensions["B"].width = 8
    info.column_dimensions["C"].width = 62
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def summarize_dates(rows: List[Dict]) -> List[Dict]:
    """按盘点日期汇总行数(用于导入前预览)。留空日期并入"今天"桶。"""
    today_d = date.today()
    buckets: Dict[str, int] = {}
    for r in rows:
        d = r.get("check_date") or today_d
        buckets[d.isoformat()] = buckets.get(d.isoformat(), 0) + 1
    out = [
        {"date": k, "rows": n, "is_today": k == today_d.isoformat()}
        for k, n in sorted(buckets.items(), reverse=True)
    ]
    return out


async def import_quick_count_excel(
    db: AsyncSession,
    current_user: dict,
    file: UploadFile,
    selected_dates: Optional[List[date]] = None,
) -> dict:
    rows = parse_quick_import_excel(await file.read())
    if not rows:
        raise ExcelImportValidationError(["文件中没有数据行"])

    # ---- 盘点日期过滤: 默认只导入 今日/留空 的行;调用方传 selected_dates 时只导入所选日期
    # (留空行视作今日,跟随"今天"是否被选)。其余跳过并汇总(累积文件每日重导场景)。 ----
    today_d = date.today()
    selected_set = set(selected_dates) if selected_dates is not None else {today_d}
    skipped_dates: Dict[str, int] = {}
    today_rows: List[Dict] = []
    for r in rows:
        d = r.get("check_date")
        effective = d or today_d
        if effective in selected_set:
            today_rows.append(r)
        else:
            k = effective.isoformat()
            skipped_dates[k] = skipped_dates.get(k, 0) + 1
    if not today_rows and skipped_dates:
        raise ExcelImportValidationError(
            [f"共 {len(rows)} 行,所选日期均无数据({', '.join(sorted(skipped_dates))}),未导入任何行"]
        )
    rows = today_rows

    if len(rows) > QUICK_IMPORT_MAX_ROWS:
        raise ExcelImportValidationError(
            [f"共 {len(rows)} 行(今日),超过上限 {QUICK_IMPORT_MAX_ROWS} 行,请拆分为多个文件分次导入"]
        )

    errors: List[str] = []

    # ---- 校验1: 物料编码存在(批量查询,按批拆分 IN 列表) ----
    codes = [r["code"] for r in rows]
    mat_map: Dict[str, object] = {}
    for i in range(0, len(codes), IMPORT_CHUNK_SIZE):
        mat_res = await db.execute(
            select(
                Material.erp_material_id,
                Material.material_code,
                Material.material_name,
                Material.spec_model,
                Material.unit_of_measure,
            ).where(
                Material.material_code.in_(codes[i:i + IMPORT_CHUNK_SIZE]),
                Material.is_deleted == 0,
            )
        )
        for r in mat_res.all():
            mat_map[r.material_code] = r
    for r in rows:  # 行号取解析时记录的 Excel 原始行号(日期过滤后仍与文件对齐)
        if r["code"] not in mat_map:
            errors.append(f"第{r['rowno']}行: 物料编码 {r['code']} 不存在或已删除")

    # ---- 校验2: 仓库解析(基于 _get_stock_by_warehouse 快照,按批拆分) ----
    mids = [int(r.erp_material_id) for r in mat_map.values()]
    stock_map: Dict[Tuple[int, int], Tuple[str, Decimal, Optional[datetime]]] = {}
    for i in range(0, len(mids), IMPORT_CHUNK_SIZE):
        stock_map.update(await _get_stock_by_warehouse(db, mids[i:i + IMPORT_CHUNK_SIZE]))
    # 库存检查不良仓不纳入快捷盘点(与搜索/录入口径一致): 自动匹配/展开/精确名匹配均跳过
    stock_map = _exclude_check_wh_from_stock_map(stock_map)
    whs_by_mid: Dict[int, List[Tuple[int, str]]] = {}
    for (mid, wh_id), (wh_name, _q, _t) in stock_map.items():
        whs_by_mid.setdefault(mid, []).append((wh_id, wh_name))

    resolved: List[Tuple[int, int, Optional[int], Dict]] = []  # (行号, mid, wh_id|None, row)
    seen_keys: Dict[Tuple[str, Optional[str]], int] = {}

    def _resolve_one(rowno: int, mid: int, wh_id: Optional[int], r: Dict) -> None:
        dup_key = (r["code"], str(wh_id) if wh_id is not None else "")
        if dup_key in seen_keys:
            errors.append(f"第{rowno}行: 与第{seen_keys[dup_key]}行重复(物料+仓库相同)")
            return
        seen_keys[dup_key] = rowno
        resolved.append((rowno, mid, wh_id, r))

    for r in rows:
        i = r["rowno"]  # Excel 原始行号
        m = mat_map.get(r["code"])
        if m is None:
            continue
        mid = int(m.erp_material_id)
        cand_whs = whs_by_mid.get(mid, [])
        wh_raw = r["wh_raw"]
        if wh_raw is None or wh_raw in ("(未入库)", "未入库"):
            if len(cand_whs) == 1:
                _resolve_one(i, mid, cand_whs[0][0], r)
            elif len(cand_whs) == 0:
                _resolve_one(i, mid, None, r)
            elif wh_raw is None and r["actual_qty"] is None:
                for wh_x, _n in cand_whs:
                    _resolve_one(i, mid, wh_x, r)
            else:
                names = "、".join(w[1] for w in cand_whs)
                errors.append(
                    f"第{i}行: 物料 {r['code']} 存在于多个仓库({names}),"
                    "请填写仓库列(仓库与实盘数量均留空时将按盘平自动展开全部仓库)"
                )
                continue
        else:
            # 数字 → 视为 wh_id;文本 → 在该物料的仓库中精确名匹配,再唯一模糊匹配
            matched: Optional[int] = None
            try:
                wh_int = int(wh_raw)
            except ValueError:
                wh_int = None
            if wh_int is not None:
                for wh_id2, _n in cand_whs:
                    if wh_id2 == wh_int:
                        matched = wh_id2
                        break
                if matched is None:
                    errors.append(
                        f"第{i}行: 物料 {r['code']} 在仓库ID {wh_int} 无库存记录"
                    )
                    continue
            else:
                exact = [w for w in cand_whs if w[1] == wh_raw]
                fuzzy = [w for w in cand_whs if wh_raw in w[1]] if not exact else []
                if len(exact) == 1:
                    matched = exact[0][0]
                elif len(fuzzy) == 1:
                    matched = fuzzy[0][0]
                elif not exact and not fuzzy:
                    errors.append(
                        f"第{i}行: 物料 {r['code']} 在仓库「{wh_raw}」无库存记录"
                    )
                    continue
                else:
                    errors.append(f"第{i}行: 仓库「{wh_raw}」匹配到多个仓库,请写全仓库名")
                    continue
            _resolve_one(i, mid, matched, r)

    if errors:
        raise ExcelImportValidationError(errors)

    if len(resolved) > QUICK_IMPORT_MAX_ROWS:
        raise ExcelImportValidationError(
            [
                f"多仓库盘平展开后共 {len(resolved)} 行(文件 {len(rows)} 行),"
                f"超过上限 {QUICK_IMPORT_MAX_ROWS} 行,请拆分为多个文件分次导入"
            ]
        )

    # ---- 写入: 找到/创建当日快捷单(与 quick_count_material 同识别条件+锁) ----
    uid = _current_user_id(current_user)
    today = date.today()
    title = f"{QUICK_CHECK_TITLE_PREFIX} {today.strftime('%Y-%m-%d')}"
    head: Optional[StockCheck] = None
    if uid is not None:
        head = (await db.execute(
            select(StockCheck)
            .where(
                StockCheck.check_type == "quick",
                StockCheck.created_by_user_id == uid,
                StockCheck.check_date == today,
                StockCheck.status.in_(("open", "in_progress")),
            )
            .order_by(StockCheck.id.desc())
            .limit(1)
            .with_for_update()
        )).scalar_one_or_none()
    if head is None:
        await _close_stale_quick_checks(db, current_user)
        seq = await _next_seq_for_today(db)
        head = StockCheck(
            check_no=_gen_check_no(seq),
            order_no=None,
            title=title,
            check_type="quick",
            status="in_progress",
            check_date=today,
            created_by=current_user.get("username", "") if current_user else "",
            created_by_user_id=uid,
            remark="快捷盘点(搜索物料直接录入)",
        )
        db.add(head)
        await db.flush()

    # 当日已有行 → 覆盖重盘
    existing = (await db.execute(
        select(StockCheckItem).where(StockCheckItem.check_id == head.id)
    )).scalars().all()
    item_map = {
        (int(it.material_id), int(it.wh_id) if it.wh_id is not None else None): it
        for it in existing
    }

    username = current_user.get("username", "") if current_user else ""
    now = datetime.now()
    added = 0
    overwritten = 0
    stat = {"balanced": 0, "loss": 0, "gain": 0}

    for n, (_rowno, mid, wh_id, r) in enumerate(resolved, start=1):
        m = mat_map[r["code"]]
        key = (mid, wh_id)
        item = item_map.get(key)
        # 快照: 有仓→stock_map;无仓(未入库)→0
        if wh_id is not None:
            wh_name, sys_q, sys_t = stock_map[key]
        else:
            wh_name, sys_q, sys_t = "(未入库)", Decimal("0"), None
        actual = r["actual_qty"] if r["actual_qty"] is not None else sys_q  # 留空=盘平
        diff = actual - sys_q

        if item is None:
            item = StockCheckItem(
                check_id=head.id,
                line_no=None,
                material_id=mid,
                material_code=m.material_code,
                material_name=m.material_name,
                spec_model=m.spec_model,
                unit=m.unit_of_measure,
                req_qty=Decimal("0"),
                system_qty=sys_q,
                system_qty_time=sys_t,
                wh_id=wh_id,
                wh_name=wh_name,
                actual_qty=actual,
                diff_qty=diff,
                is_checked=1,
                checked_at=now,
                checked_by=username or None,
                counted_by_user_id=uid,
                counted_by=username or None,
                counted_at=now,
                remark=r["remark"],
                version=1,
            )
            db.add(item)
            item_map[key] = item
            added += 1
        else:
            item.system_qty = sys_q
            item.system_qty_time = sys_t
            item.actual_qty = actual
            item.diff_qty = diff
            item.is_checked = 1
            item.checked_at = now
            item.checked_by = username or None
            item.counted_by_user_id = uid
            item.counted_by = username or None
            item.counted_at = now
            if r["remark"]:
                item.remark = r["remark"]
            item.recent_checked_check_no = None
            item.recent_checked_date = None
            item.version = int(item.version or 0) + 1
            overwritten += 1
        if diff == 0:
            stat["balanced"] += 1
        elif diff < 0:
            stat["loss"] += 1
        else:
            stat["gain"] += 1
        # 分批 flush: 避免数千个新 ORM 对象积压在会话中一次性发射超大事务
        if n % IMPORT_CHUNK_SIZE == 0:
            await db.flush()

    await _refresh_check_aggregates(db, head.id)
    head.version = int(head.version or 0) + 1
    await db.flush()
    await publish_event(
        head.id,
        "bom_refreshed",
        {
            "check_id": head.id,
            "head_version": int(head.version or 0),
            "new_item_ids": [],
            "source": "excel_import",
        },
        uid,
    )
    return {
        "check_id": head.id,
        "check_no": head.check_no,
        "total": len(resolved),
        "added": added,
        "overwritten": overwritten,
        "skipped_not_today": sum(skipped_dates.values()),
        "skipped_dates": skipped_dates,
        **stat,
    }
