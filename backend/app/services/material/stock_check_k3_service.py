"""K3 盘盈盘亏单导入 — 从 K3 ICStockBill 拉取已审核单据生成中台盘点单。

设计文档: docs/superpowers/specs/2026-08-19-k3-stock-gain-loss-import-design.md

生产库实证(2026-08-19, 2026-08-20 修订):
- 盘盈 = 盘盈入库单 FTranType=40(单号 YADJ): FQtyMust=账面数, FQtyActual=实盘数
- 盘亏 = 仓库调拨单 FTranType=41(单号 CHG)调入「库存检查不良仓」(t_Stock 92852):
  业务上不用盘亏毁损单(43/KADJ, 已于 2025-12 停用), 盘亏量=调拨数量 FQty;
  SQL 层统一表达为 账面=FQty/实盘=0, diff 自算为 -FQty(负=盘亏), 仓库取源仓库 FSCStockID
- ID 映射: material_id=t_ICItem.FItemID, wh_id=t_Stock.FItemID, 单位 FUnitID->t_MeasureUnit.FMeasureUnitID
- 盘点人/标记人: 取单据保管人 ICStockBill.FFManagerID(发料保管人)->t_Emp.FName, FSManagerID(收料保管人)兜底,
  均缺失时回退「K3」(生产库实证 2026-08-21: 盘盈单 FFManagerID 46/46 有值、FSManagerID 恒空;
  盘亏调拨单两者 177/177 均有值且同人)
- 只导已审核(FCheckerID>0)且未作废(FCancellation=0)的单据
- 注: 仓库 ID 在行表 e.FDCStockID/e.FSCStockID(生产库头表 FDCStockID 恒为 NULL)
"""

import asyncio
import logging
import threading
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from sqlalchemy import create_engine, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.material.inventory_check import StockCheck, StockCheckItem
from app.services.material.stock_check_service import _gen_check_no, _next_seq_for_today

logger = logging.getLogger(__name__)

K3_DB = "k3sv.AIS20161019115614"

TRAN_TYPE_GAIN = 40
TRAN_TYPE_TRANSFER_LOSS = 41
# 盘亏调拨的目标仓:「库存检查不良仓」(t_Stock.FItemID=92852, 编码 131)
BAD_STOCK_WH_ID = 92852

# 盘盈单据列表(预览用): 入库仓库=行表 e.FDCStockID, 同单多仓时取 MAX 保一行
K3_GAIN_BILL_LIST_SQL = f"""
SELECT b.FBillNo AS erp_bill_no,
       b.FInterID AS erp_inter_id,
       b.FTranType AS tran_type,
       b.FDate AS bill_date,
       MAX(s.FName) AS wh_name,
       COUNT(e.FEntryID) AS item_count,
       SUM(e.FQtyActual - e.FQtyMust) AS diff_total
FROM {K3_DB}.dbo.ICStockBill b
JOIN {K3_DB}.dbo.ICStockBillEntry e ON e.FInterID = b.FInterID
LEFT JOIN {K3_DB}.dbo.t_Stock s ON s.FItemID = e.FDCStockID
WHERE b.FTranType = 40
  AND b.FCheckerID > 0
  AND b.FCancellation = 0
  AND b.FDate >= :date_from AND b.FDate < :date_to
GROUP BY b.FBillNo, b.FInterID, b.FTranType, b.FDate
"""

# 盘亏调拨单据列表(预览用): 仅统计调入库存检查不良仓的行; 仓库显示源仓库 FSCStockID;
# 差异 = -调拨数量(负=盘亏), 与明细导入的 账面=FQty/实盘=0 映射一致
K3_TRANSFER_LOSS_BILL_LIST_SQL = f"""
SELECT b.FBillNo AS erp_bill_no,
       b.FInterID AS erp_inter_id,
       b.FTranType AS tran_type,
       b.FDate AS bill_date,
       MAX(s.FName) AS wh_name,
       COUNT(e.FEntryID) AS item_count,
       -SUM(e.FQty) AS diff_total
FROM {K3_DB}.dbo.ICStockBill b
JOIN {K3_DB}.dbo.ICStockBillEntry e
     ON e.FInterID = b.FInterID AND e.FDCStockID = {BAD_STOCK_WH_ID}
LEFT JOIN {K3_DB}.dbo.t_Stock s ON s.FItemID = e.FSCStockID
WHERE b.FTranType = 41
  AND b.FCheckerID > 0
  AND b.FCancellation = 0
  AND b.FDate >= :date_from AND b.FDate < :date_to
GROUP BY b.FBillNo, b.FInterID, b.FTranType, b.FDate
"""

# 盘盈单张明细(导入用), join 物料/单位/仓库字典
K3_GAIN_BILL_DETAIL_SQL = f"""
SELECT b.FBillNo AS erp_bill_no,
       b.FInterID AS erp_inter_id,
       b.FTranType AS tran_type,
       b.FDate AS bill_date,
       b.FNote AS head_note,
       b.FExplanation AS head_explanation,
       e.FEntryID AS entry_id,
       e.FItemID AS item_id,
       e.FQtyMust AS qty_must,
       e.FQtyActual AS qty_actual,
       e.FBatchNo AS batch_no,
       i.FNumber AS material_code,
       i.FName AS material_name,
       i.FModel AS spec_model,
       mu.FName AS unit_name,
       st.FItemID AS wh_id,
       st.FNumber AS wh_code,
       st.FName AS wh_name,
       COALESCE(kf.FName, ks.FName) AS keeper_name
FROM {K3_DB}.dbo.ICStockBill b
JOIN {K3_DB}.dbo.ICStockBillEntry e ON e.FInterID = b.FInterID
LEFT JOIN {K3_DB}.dbo.t_ICItem i ON i.FItemID = e.FItemID
LEFT JOIN {K3_DB}.dbo.t_MeasureUnit mu ON mu.FMeasureUnitID = e.FUnitID
LEFT JOIN {K3_DB}.dbo.t_Stock st ON st.FItemID = e.FDCStockID
LEFT JOIN {K3_DB}.dbo.t_Emp kf ON kf.FItemID = b.FFManagerID
LEFT JOIN {K3_DB}.dbo.t_Emp ks ON ks.FItemID = b.FSManagerID
WHERE b.FBillNo = :bill_no
  AND b.FTranType = 40
  AND b.FCheckerID > 0
  AND b.FCancellation = 0
ORDER BY e.FEntryID
"""

# 盘亏调拨单张明细(导入用): 只取调入库存检查不良仓的行; 账面=调拨数量/实盘=0(SQL 层统一,
# 服务层 diff 自算得 -FQty); 仓库取源仓库(盘亏实际发生地)
K3_TRANSFER_LOSS_BILL_DETAIL_SQL = f"""
SELECT b.FBillNo AS erp_bill_no,
       b.FInterID AS erp_inter_id,
       b.FTranType AS tran_type,
       b.FDate AS bill_date,
       b.FNote AS head_note,
       b.FExplanation AS head_explanation,
       e.FEntryID AS entry_id,
       e.FItemID AS item_id,
       e.FQty AS qty_must,
       0 AS qty_actual,
       e.FBatchNo AS batch_no,
       i.FNumber AS material_code,
       i.FName AS material_name,
       i.FModel AS spec_model,
       mu.FName AS unit_name,
       st.FItemID AS wh_id,
       st.FNumber AS wh_code,
       st.FName AS wh_name,
       COALESCE(kf.FName, ks.FName) AS keeper_name
FROM {K3_DB}.dbo.ICStockBill b
JOIN {K3_DB}.dbo.ICStockBillEntry e
     ON e.FInterID = b.FInterID AND e.FDCStockID = {BAD_STOCK_WH_ID}
LEFT JOIN {K3_DB}.dbo.t_ICItem i ON i.FItemID = e.FItemID
LEFT JOIN {K3_DB}.dbo.t_MeasureUnit mu ON mu.FMeasureUnitID = e.FUnitID
LEFT JOIN {K3_DB}.dbo.t_Stock st ON st.FItemID = e.FSCStockID
LEFT JOIN {K3_DB}.dbo.t_Emp kf ON kf.FItemID = b.FFManagerID
LEFT JOIN {K3_DB}.dbo.t_Emp ks ON ks.FItemID = b.FSManagerID
WHERE b.FBillNo = :bill_no
  AND b.FTranType = 41
  AND b.FCheckerID > 0
  AND b.FCancellation = 0
ORDER BY e.FEntryID
"""

_engine_lock = threading.Lock()
_k3_engine = None


def _get_k3_engine():
    """ERP 只读同步引擎(懒加载缓存)。与 erp_sync_service._connect_erp_sync 同款连接参数。"""
    global _k3_engine
    if _k3_engine is not None:
        return _k3_engine
    with _engine_lock:
        if _k3_engine is not None:
            return _k3_engine
        settings = get_settings()
        if not settings.ERP_SYNC_ENABLED:
            raise RuntimeError("ERP 同步未启用(ERP_SYNC_ENABLED)，无法访问 K3")
        if not settings.ERP_DB_URL:
            raise RuntimeError("ERP_DB_URL 未配置，无法访问 K3")
        url = settings.ERP_DB_URL
        for param in ["TrustServerCertificate=yes", "Encrypt=no"]:
            if param.split("=")[0] not in url:
                url += f"&{param}" if "?" in url else f"?{param}"
        connect_args = {"login_timeout": 15, "timeout": 30}
        if "mssql+pyodbc" in url:
            connect_args["charset"] = "utf-8"
        _k3_engine = create_engine(
            url, echo=False, pool_size=2, max_overflow=2,
            pool_pre_ping=True, connect_args=connect_args,
        )
        return _k3_engine


def _fetch_sync(sql: str, params: Dict) -> List[Dict]:
    with _get_k3_engine().connect() as conn:
        return [dict(m) for m in conn.execute(text(sql), params).mappings().all()]


async def _execute_k3(sql: str, params: Dict) -> List[Dict]:
    """线程池执行 K3 查询，受 ERP_SYNC_QUERY_TIMEOUT 约束(同 erp_sync_service)。"""
    timeout = getattr(get_settings(), "ERP_SYNC_QUERY_TIMEOUT", 600)
    try:
        return await asyncio.wait_for(asyncio.to_thread(_fetch_sync, sql, params), timeout=timeout)
    except asyncio.TimeoutError:
        raise RuntimeError(f"K3 查询超时（{timeout}秒），请稍后重试或检查 K3 负载")
    except (OperationalError, DBAPIError) as e:
        raise RuntimeError(f"K3 数据库连接/查询失败: {str(e.orig)[:200]}")


def _clean_str(v) -> Optional[str]:
    if v is None:
        return None
    s = str(v).replace("\ufffd", "").strip()
    return s or None


def _to_date(v) -> Optional[date]:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return None


async def list_k3_gain_loss_bills(
    db: AsyncSession,
    *,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    tran_type: str = "all",
) -> List[Dict]:
    """预览 K3 盘盈/盘亏调拨单(带 imported 标记)。默认近 30 天(含端点日)。"""
    today = date.today()
    date_from = date_from or (today - timedelta(days=30))
    date_to = date_to or today
    params = {"date_from": date_from, "date_to": date_to + timedelta(days=1)}
    queries = []
    if tran_type in ("all", "40"):
        queries.append(K3_GAIN_BILL_LIST_SQL)
    if tran_type in ("all", "41"):
        queries.append(K3_TRANSFER_LOSS_BILL_LIST_SQL)
    rows: List[Dict] = []
    for q in queries:
        rows.extend(await _execute_k3(q, params))
    rows.sort(key=lambda r: int(r["erp_inter_id"]), reverse=True)

    bill_nos = [r["erp_bill_no"] for r in rows]
    existing: set = set()
    if bill_nos:
        res = await db.execute(select(StockCheck.erp_bill_no).where(StockCheck.erp_bill_no.in_(bill_nos)))
        existing = set(res.scalars())

    out: List[Dict] = []
    for r in rows:
        tt = int(r["tran_type"])
        out.append({
            "erp_bill_no": r["erp_bill_no"],
            "erp_inter_id": int(r["erp_inter_id"]),
            "tran_type": tt,
            "type_label": "盘盈" if tt == TRAN_TYPE_GAIN else "盘亏调拨",
            "bill_date": _to_date(r["bill_date"]),
            "wh_name": _clean_str(r["wh_name"]),
            "item_count": int(r["item_count"] or 0),
            "diff_total": Decimal(str(r["diff_total"] or 0)),
            "imported": r["erp_bill_no"] in existing,
        })
    return out


async def _build_check_from_rows(
    db: AsyncSession,
    rows: List[Dict],
    importer: str,
) -> Tuple[StockCheck, int]:
    """按字段映射把 K3 单据行集构建为已完结盘点单(头+明细)。

    返回 (盘点单头, 因物料/仓库字典缺失被跳过的明细行数)。rows 非空由调用方保证。
    """
    first = rows[0]
    tt = int(first["tran_type"])
    title_prefix = "K3盘盈单" if tt == TRAN_TYPE_GAIN else "K3盘亏调拨单"
    bill_no = first["erp_bill_no"]
    bill_date = _to_date(first["bill_date"])
    bill_dt = first["bill_date"] if isinstance(first["bill_date"], datetime) else None
    notes = [n for n in (_clean_str(first.get("head_note")), _clean_str(first.get("head_explanation"))) if n]
    keeper = _clean_str(first.get("keeper_name")) or "K3"

    items: List[StockCheckItem] = []
    for r in rows:
        if r["item_id"] is None or not r["material_code"] or r["wh_id"] is None:
            continue  # 物料/仓库字典缺失的行跳过(计入 skipped_items)
        qty_must = Decimal(str(r["qty_must"] or 0))
        qty_actual = Decimal(str(r["qty_actual"] or 0))
        batch = _clean_str(r["batch_no"])
        items.append(StockCheckItem(
            material_id=int(r["item_id"]),
            material_code=_clean_str(r["material_code"]),
            material_name=_clean_str(r["material_name"]),
            spec_model=_clean_str(r["spec_model"]),
            unit=_clean_str(r["unit_name"]),
            req_qty=qty_must,
            system_qty=qty_must,
            actual_qty=qty_actual,
            diff_qty=qty_actual - qty_must,
            is_checked=1,
            checked_at=bill_dt,
            checked_by=keeper,
            counted_by=keeper,
            counted_at=bill_dt,
            wh_id=int(r["wh_id"]),
            wh_code=_clean_str(r["wh_code"]),
            wh_name=_clean_str(r["wh_name"]),
            remark=f"批次:{batch}" if batch else None,
        ))
    if not items:
        raise ValueError("单据所有明细行的物料/仓库字典均缺失，无法生成盘点明细")

    seq = await _next_seq_for_today(db)
    head = StockCheck(
        check_no=_gen_check_no(seq),
        order_no=None,
        title=f"{title_prefix} {bill_no} 导入",
        check_type="manual",
        status="completed",
        check_date=bill_date or date.today(),
        total_materials=len(items),
        checked_materials=len(items),
        total_diff_qty=sum((i.diff_qty for i in items), Decimal("0")),
        created_by=importer,
        checked_by=importer,
        completed_at=datetime.now(),
        remark="；".join(notes) or None,
        source="k3",
        erp_bill_no=bill_no,
        erp_inter_id=int(first["erp_inter_id"]),
    )
    db.add(head)
    await db.flush()
    for i in items:
        i.check_id = head.id
    db.add_all(items)
    return head, len(rows) - len(items)


async def import_k3_bills_as_stock_checks(
    db: AsyncSession,
    bill_nos: List[str],
    current_user: dict,
) -> Dict:
    """逐张导入 K3 单据为已完结盘点单。一张失败不影响其余(逐单 savepoint)。"""
    importer = (current_user.get("username") or current_user.get("name") or "系统")
    created: List[Dict] = []
    skipped: List[str] = []
    failed: List[Dict] = []
    for bill_no in bill_nos:
        bill_no = (bill_no or "").strip()
        if not bill_no:
            continue
        try:
            exists = (await db.execute(
                select(StockCheck.id).where(StockCheck.erp_bill_no == bill_no)
            )).scalar_one_or_none()
            if exists:
                skipped.append(bill_no)
                continue
            # 先按盘盈单查, 未命中再按盘亏调拨单查(两类单号 YADJ/CHG 不会同时命中)
            rows = await _execute_k3(K3_GAIN_BILL_DETAIL_SQL, {"bill_no": bill_no})
            if not rows:
                rows = await _execute_k3(K3_TRANSFER_LOSS_BILL_DETAIL_SQL, {"bill_no": bill_no})
            if not rows:
                failed.append({"erp_bill_no": bill_no, "reason": "K3 中未找到该已审核未作废的盘盈单/盘亏调拨单(调入库存检查不良仓)"})
                continue
            async with db.begin_nested():
                head, skipped_cnt = await _build_check_from_rows(db, rows, importer)
                await db.flush()
            created.append({
                "check_no": head.check_no,
                "erp_bill_no": bill_no,
                "skipped_items": skipped_cnt,
            })
        except IntegrityError as e:
            # 并发竞态触发 erp_bill_no 唯一索引冲突时按已导入跳过（spec §6 幂等兜底）
            logger.info(f"K3 单 {bill_no} 唯一索引冲突,按已导入跳过: {e}")
            skipped.append(bill_no)
        except Exception as e:
            logger.warning(f"K3 单 {bill_no} 导入失败: {e}")
            failed.append({"erp_bill_no": bill_no, "reason": str(e)[:200]})
    return {"created": created, "skipped": skipped, "failed": failed}
