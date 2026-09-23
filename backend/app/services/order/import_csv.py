"""订单导入服务 — 解析 1.点检.csv / 2.跑单.csv / 出货计划表(CSV/XLSX) 到数据库"""

import csv
import io
import re
from datetime import date, datetime
from pathlib import Path
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.audit import log_audit
from app.models.order.sale_order import SaleOrder
from app.models.order.run_order import RunOrder


MATERIAL_KEYS = [
    '电子料', 'SMT上线', '光源', '感应器/电源/控制板',
    '结构', '结构2', '支架', '电缆线', '塑料件', '手杆',
    '彩盒', '说明书', '灯珠', '光源板', '电源板', '包材',
]


def _parse_date(val: str) -> Optional[date]:
    """尝试多种日期格式解析"""
    if not val or not val.strip():
        return None
    val = val.strip()
    for fmt in ('%Y-%m-%d', '%Y/%m/%d', '%m/%d', '%m月%d日', '%Y.%m.%d'):
        try:
            d = datetime.strptime(val, fmt)
            if d.year == 1900:
                d = d.replace(year=date.today().year)
            return d.date()
        except ValueError:
            continue
    return None


def _parse_float(val: str) -> Optional[float]:
    if not val or not val.strip():
        return None
    val = val.strip().replace(',', '')
    try:
        return float(val)
    except ValueError:
        return None


def _parse_int(val: str) -> Optional[int]:
    if not val or not val.strip():
        return None
    val = val.strip().replace(',', '')
    try:
        return int(float(val))
    except ValueError:
        return None


async def import_inspection_csv(filepath: str, db: AsyncSession) -> dict:
    """导入 1.点检.csv 到 SaleOrder 表

    CSV结构: 前9行为表头/说明, 第10行(index 9)为列头, 第11行起为数据
    列序: 销售部门,发货完成,客户等级,客户,单号,数量,合同交期,出货计划,
          客户验货时间,上线时间,客检结果,包装完成状况,(BOM回收),料齐套时间,
          发货状态即时说明,采购物料齐套,电子料,SMT上线,光源,感应器/电源/控制板,
          结构,结构2,支架,电缆线,塑料件,手杆,彩盒,说明书,灯珠,光源板,电源板,
          包材,前道,首件检验日期,组装上线日期,组装完成日期,,备注
    """
    path = Path(filepath)
    if not path.exists():
        raise FileNotFoundError(f"文件不存在: {filepath}")

    with open(path, 'r', encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        rows = list(reader)

    created = 0
    updated = 0
    skipped = 0

    for row_idx, row in enumerate(rows):
        if row_idx < 10:
            continue
        if len(row) < 6:
            skipped += 1
            continue

        order_no = (row[4] or '').strip()
        if not order_no:
            skipped += 1
            continue

        department = (row[0] or '').strip() or None
        delivery_completed_date = _parse_date(row[1] if len(row) > 1 else '')
        customer_grade = (row[2] or '').strip() or None
        customer_code = (row[3] or '').strip() or None
        order_qty = _parse_float(row[5] if len(row) > 5 else '')
        promised_date = _parse_date(row[6] if len(row) > 6 else '')
        shipping_plan = _parse_date(row[7] if len(row) > 7 else '')
        customer_inspection_date = _parse_date(row[8] if len(row) > 8 else '')
        planned_start_date = _parse_date(row[9] if len(row) > 9 else '')
        inspection_result = (row[10] or '').strip() if len(row) > 10 else None
        packaging_status = (row[11] or '').strip() if len(row) > 11 else None
        bom_return_date = _parse_date(row[12] if len(row) > 12 else '')
        material_ready_date = _parse_date(row[13] if len(row) > 13 else '')
        shipping_status_desc = (row[14] or '').strip() if len(row) > 14 else None
        procurement_status = (row[15] or '').strip() if len(row) > 15 else None

        material_dates = {}
        for i, key in enumerate(MATERIAL_KEYS):
            col_idx = 16 + i
            if col_idx < len(row) and row[col_idx].strip():
                material_dates[key] = row[col_idx].strip()
        if not material_dates:
            material_dates = None

        front_process_date = _parse_date(row[32] if len(row) > 32 else '')
        first_article_date = _parse_date(row[33] if len(row) > 33 else '')
        assembly_start_date = _parse_date(row[34] if len(row) > 34 else '')
        assembly_complete_date = _parse_date(row[35] if len(row) > 35 else '')
        remark = (row[37] or '').strip() if len(row) > 37 else None

        result = await db.execute(
            select(SaleOrder).where(SaleOrder.order_no == order_no, SaleOrder.line_no == '10')
            .order_by(SaleOrder.id.desc()).limit(1)
        )
        existing = result.scalar_one_or_none()

        if existing:
            existing.department = department
            existing.delivery_completed_date = delivery_completed_date
            existing.customer_grade = customer_grade
            existing.customer_code = customer_code
            existing.order_qty = order_qty
            existing.promised_date = promised_date
            existing.shipping_plan = shipping_plan
            existing.customer_inspection_date = customer_inspection_date
            existing.planned_start_date = planned_start_date
            existing.inspection_result = inspection_result
            existing.packaging_status = packaging_status
            existing.bom_return_date = bom_return_date
            existing.material_ready_date = material_ready_date
            existing.shipping_status_desc = shipping_status_desc
            existing.procurement_status = procurement_status
            existing.material_dates = material_dates
            existing.front_process_date = front_process_date
            existing.first_article_date = first_article_date
            existing.assembly_start_date = assembly_start_date
            existing.assembly_complete_date = assembly_complete_date
            existing.remark = remark
            existing.data_source = 'csv_inspection'
            updated += 1
        else:
            order = SaleOrder(
                order_no=order_no,
                line_no='10',
                department=department,
                delivery_completed_date=delivery_completed_date,
                customer_grade=customer_grade,
                customer_code=customer_code,
                customer=customer_code,
                order_qty=order_qty,
                promised_date=promised_date,
                shipping_plan=shipping_plan,
                customer_inspection_date=customer_inspection_date,
                planned_start_date=planned_start_date,
                inspection_result=inspection_result,
                packaging_status=packaging_status,
                bom_return_date=bom_return_date,
                material_ready_date=material_ready_date,
                shipping_status_desc=shipping_status_desc,
                procurement_status=procurement_status,
                material_dates=material_dates,
                front_process_date=front_process_date,
                first_article_date=first_article_date,
                assembly_start_date=assembly_start_date,
                assembly_complete_date=assembly_complete_date,
                remark=remark,
                status='open',
                data_source='csv_inspection',
            )
            db.add(order)
            created += 1

    await db.flush()
    return {'created': created, 'updated': updated, 'skipped': skipped}


async def import_run_order_csv(filepath: str, db: AsyncSession) -> dict:
    """导入 2.跑单.csv 到 RunOrder 表

    CSV结构: 第1行为标题, 第2行(index 1)为列头, 第3行起为数据
    列序: 客户代码,订单号,数量,订单性质,合同日期,交付日期,跑单日期,跑单时间,
          订单金额,包材未投放,下单时间,齐套时间,采购周期,完成,发货,订单状态,
          未及时原因分析,,备注,,内销单号,...
    """
    path = Path(filepath)
    if not path.exists():
        raise FileNotFoundError(f"文件不存在: {filepath}")

    with open(path, 'r', encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        rows = list(reader)

    created = 0
    updated = 0
    skipped = 0

    for row_idx, row in enumerate(rows):
        if row_idx < 2:
            continue
        if len(row) < 3:
            skipped += 1
            continue

        order_no = (row[1] or '').strip()
        if not order_no:
            skipped += 1
            continue

        customer_code = (row[0] or '').strip() or None
        order_qty = _parse_float(row[2] if len(row) > 2 else '')
        order_type = (row[3] or '').strip() if len(row) > 3 else None
        contract_date = _parse_date(row[4] if len(row) > 4 else '')
        delivery_date = _parse_date(row[5] if len(row) > 5 else '')
        run_date = _parse_date(row[6] if len(row) > 6 else '')
        run_days = _parse_int(row[7] if len(row) > 7 else '')
        order_amount = _parse_float(row[8] if len(row) > 8 else '')
        packaging_not_released = (row[9] or '').strip() if len(row) > 9 else None
        po_placed_date = _parse_date(row[10] if len(row) > 10 else '')
        material_ready_date = _parse_date(row[11] if len(row) > 11 else '')
        procurement_cycle = _parse_int(row[12] if len(row) > 12 else '')
        completed_date = _parse_date(row[13] if len(row) > 13 else '')
        shipped_date = _parse_date(row[14] if len(row) > 14 else '')
        order_status = (row[15] or '').strip() if len(row) > 15 else None
        delay_reason = (row[16] or '').strip() if len(row) > 16 else None
        remark = (row[18] or '').strip() if len(row) > 18 else None

        result = await db.execute(
            select(RunOrder).where(RunOrder.order_no == order_no)
        )
        existing = result.scalar_one_or_none()

        if existing:
            existing.customer_code = customer_code
            existing.order_qty = order_qty
            existing.order_type = order_type
            existing.contract_date = contract_date
            existing.delivery_date = delivery_date
            existing.run_date = run_date
            existing.run_days = run_days
            existing.order_amount = order_amount
            existing.packaging_not_released = packaging_not_released
            existing.po_placed_date = po_placed_date
            existing.material_ready_date = material_ready_date
            existing.procurement_cycle = procurement_cycle
            existing.completed_date = completed_date
            existing.shipped_date = shipped_date
            existing.order_status = order_status
            existing.delay_reason = delay_reason
            existing.remark = remark
            existing.is_domestic = False
            updated += 1
        else:
            run_order = RunOrder(
                customer_code=customer_code,
                order_no=order_no,
                order_qty=order_qty,
                order_type=order_type,
                contract_date=contract_date,
                delivery_date=delivery_date,
                run_date=run_date,
                run_days=run_days,
                order_amount=order_amount,
                packaging_not_released=packaging_not_released,
                po_placed_date=po_placed_date,
                material_ready_date=material_ready_date,
                procurement_cycle=procurement_cycle,
                completed_date=completed_date,
                shipped_date=shipped_date,
                order_status=order_status,
                delay_reason=delay_reason,
                remark=remark,
                is_domestic=False,
            )
            db.add(run_order)
            created += 1

        # 内销跑单(列21-27)
        if len(row) > 20:
            domestic_order_no = (row[20] or '').strip()
            if domestic_order_no:
                domestic_qty = _parse_float(row[21] if len(row) > 21 else '')
                domestic_type = (row[22] or '').strip() if len(row) > 22 else None
                domestic_run_days = _parse_int(row[23] if len(row) > 23 else '')
                domestic_delivery = _parse_date(row[24] if len(row) > 24 else '')
                domestic_po_placed = _parse_date(row[25] if len(row) > 25 else '')
                domestic_material_ready = _parse_date(row[26] if len(row) > 26 else '')

                d_result = await db.execute(
                    select(RunOrder).where(RunOrder.order_no == domestic_order_no)
                )
                d_existing = d_result.scalar_one_or_none()
                if not d_existing:
                    db.add(RunOrder(
                        customer_code=customer_code,
                        order_no=domestic_order_no,
                        order_qty=domestic_qty,
                        order_type=domestic_type,
                        run_days=domestic_run_days,
                        delivery_date=domestic_delivery,
                        po_placed_date=domestic_po_placed,
                        material_ready_date=domestic_material_ready,
                        is_domestic=True,
                    ))
                    created += 1

    await db.flush()
    return {'created': created, 'updated': updated, 'skipped': skipped}


# ── 出货计划表导入（销售订单号 + 计划时间 → sale_order.shipping_plan）──

SHIPPING_PLAN_ORDER_COLUMN = "销售订单号"
SHIPPING_PLAN_DATE_COLUMN = "计划时间"
IMPORT_HEADER_SCAN_ROWS = 10


def _decode_upload_text(content: bytes) -> str:
    """上传文件解码：优先 UTF-8(BOM)，回退 GBK/GB18030（出货计划表常为 GBK）"""
    for encoding in ("utf-8-sig", "gbk", "gb18030"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def _read_upload_rows(content: bytes, filename: str) -> list[list[str]]:
    """读取上传的 .csv / .xlsx 为二维字符串表（单元格去空白，日期归一为 YYYY-MM-DD）"""
    if filename.lower().endswith(".xlsx"):
        from openpyxl import load_workbook

        def to_text(cell) -> str:
            if cell is None:
                return ""
            if isinstance(cell, datetime):
                return cell.strftime("%Y-%m-%d")
            if isinstance(cell, date):
                return cell.isoformat()
            return str(cell).strip()

        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        try:
            sheet = workbook.active
            return [[to_text(cell) for cell in row] for row in sheet.iter_rows(values_only=True)]
        finally:
            workbook.close()
    return [
        [(cell or "").strip() for cell in row]
        for row in csv.reader(io.StringIO(_decode_upload_text(content)))
    ]


def _locate_header(rows: list[list[str]]) -> Optional[tuple[int, int, int]]:
    """在前 N 行内找含「销售订单号」「计划时间」的表头行，返回 (表头行索引, 订单号列, 计划时间列)"""
    for idx, row in enumerate(rows[:IMPORT_HEADER_SCAN_ROWS]):
        if SHIPPING_PLAN_ORDER_COLUMN in row and SHIPPING_PLAN_DATE_COLUMN in row:
            return idx, row.index(SHIPPING_PLAN_ORDER_COLUMN), row.index(SHIPPING_PLAN_DATE_COLUMN)
    return None


async def import_shipping_plan(content: bytes, filename: str, db: AsyncSession, operator: str = "system") -> dict:
    """导入出货计划表：按表头名取「销售订单号」「计划时间」，只更新订单头 shipping_plan。

    - 支持 .csv(UTF-8/GBK) 与 .xlsx；计划时间无年份按当前年（复用 _parse_date）
    - 重号订单取最新一条（id 最大），与 1.点检导入一致
    - 实际变更写 audit_log，供订单总控台「出货计划变更时间线」展示
    """
    rows = _read_upload_rows(content, filename)
    located = _locate_header(rows)
    if not located:
        raise ValueError(
            f"未找到表头：前 {IMPORT_HEADER_SCAN_ROWS} 行需同时包含"
            f"「{SHIPPING_PLAN_ORDER_COLUMN}」和「{SHIPPING_PLAN_DATE_COLUMN}」两列"
        )
    header_idx, order_col, date_col = located
    header = rows[header_idx]
    customer_col = header.index("客户编号") if "客户编号" in header else None
    qty_col = header.index("数量") if "数量" in header else None

    def cell(row: list[str], col: Optional[int]) -> str:
        return row[col].strip() if col is not None and col < len(row) else ""

    updated = unchanged = not_found = invalid = 0
    result_rows: list[dict] = []

    for row_no, row in enumerate(rows[header_idx + 1:], start=header_idx + 2):
        order_no = cell(row, order_col)
        plan_raw = cell(row, date_col)
        if not order_no and not plan_raw:
            continue

        row_result = {
            "row_no": row_no,
            "order_no": order_no,
            "customer_code": cell(row, customer_col),
            "qty": cell(row, qty_col),
            "plan_date": None,
        }

        if not order_no:
            invalid += 1
            result_rows.append({**row_result, "status": "invalid", "message": "销售订单号为空"})
            continue

        plan_date = _parse_date(plan_raw)
        if plan_date is None:
            invalid += 1
            result_rows.append({**row_result, "status": "invalid", "message": f"计划时间无法解析：{plan_raw or '(空)'}"})
            continue
        row_result["plan_date"] = plan_date.isoformat()

        order_result = await db.execute(
            select(SaleOrder).where(SaleOrder.order_no == order_no).order_by(SaleOrder.id.desc()).limit(1)
        )
        order = order_result.scalar_one_or_none()
        if not order:
            not_found += 1
            result_rows.append({**row_result, "status": "not_found", "message": "订单不存在"})
            continue

        if order.shipping_plan == plan_date:
            unchanged += 1
            result_rows.append({**row_result, "status": "unchanged", "message": "出货计划无变化"})
            continue

        old_plan = order.shipping_plan
        await log_audit(
            db, "sale_order", order.id, "update",
            old_obj=order, update_data={"shipping_plan": plan_date}, operator=operator,
        )
        order.shipping_plan = plan_date
        updated += 1
        result_rows.append({
            **row_result,
            "status": "updated",
            "message": f"{old_plan.isoformat() if old_plan else '(空)'} → {plan_date.isoformat()}",
        })

    await db.flush()
    return {
        "updated": updated,
        "unchanged": unchanged,
        "not_found": not_found,
        "invalid": invalid,
        "rows": result_rows,
    }
