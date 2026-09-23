"""盘点完结 K3 回写服务 — 按 (盘点单, 类型, 仓库) 分组生成 K3 未审核单据。

设计文档: docs/superpowers/specs/2026-09-01-stockcheck-k3-writeback-design.md

- 盘盈: ICStockBill FTranType=40 (YADJ), 入库仓=盘点行仓库; FQty=盘差, FQtyMust=账面, FQtyActual=实盘
- 盘亏: ICStockBill FTranType=41 (CHG) 仓库调拨, 调出仓=盘点行仓库, 调入仓=库存检查不良仓(92852); FQty=|盘差|
- 全部写未审核单(FCheckerID=0), 由仓管员在 K3 审核生效; 本系统 scm_inventory 不动, 等 ERP 同步回流
- 幂等: (check_id, bill_type, wh_id) 唯一约束; execute 只处理 pending/failed
"""

import asyncio
import logging
import re
import threading
from datetime import datetime
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.material.inventory_check import StockCheck, StockCheckItem
from app.models.material.stock_check_writeback import StockCheckK3Writeback
from app.services.material.stock_check_k3_service import (
    BAD_STOCK_WH_ID,
    K3_DB,
    TRAN_TYPE_GAIN,
    TRAN_TYPE_TRANSFER_LOSS,
    _get_k3_engine,
)

logger = logging.getLogger(__name__)

# 回写目标账套: K3_WRITE_DB 优先, 留空(或空串)回落 K3_DB(同步账套)。
# 同步(读生产)与回写(测试期写测试账套)分离, 避免验证期污染生产数据;
# 回写路径的全部读写(取号/单号/插入/补偿/物料单位)都必须落在同一目标账套。
K3_WRITE_DB = get_settings().K3_WRITE_DB or K3_DB

WRITEBACK_TIMEOUT = 15  # 单张单据写入超时(秒);超时即记 failed,不拖垮完结请求

# 默认值来源: Task 0 K3 核实结论(2026-09-01, 见计划文件末尾)
K3_DEFAULT_BILLER_ID = 16546   # 制单人;盘盈/调拨最新单据常用值
K3_DEFAULT_MANAGER_ID = 34899  # 保管人(FFManagerID/FSManagerID);跨两种单型出现
K3_FENTRYID_STEP = 1           # FEntryID 步长: 生产库实证 1 递增
# 单据模板列(K3 客户端序时簿按模板过滤,缺失则客户端查不到单据;生产库实证 2026-09-01):
# 盘盈单(40) 恒 FInventoryType=36700/FRefType=0; 调拨单(41) 恒 FRefType=12561/FInventoryType=0
K3_GAIN_INVENTORY_TYPE = 36700
K3_TRANSFER_REF_TYPE = 12561

# K3 回写阶段按 wh_name 排除的盘点行。
# 库存检查不良仓是盘亏在 K3 的目标仓(t_Stock.FItemID=92852),其盘点行本身不是
# K3 库存盘点的合法对象;源头候选仓库已通过 stock_check_service.CHECK_EXCLUDED_WH_NAMES
# 排除,此处为双重防御:历史脏数据 / 迁移残留 / 绕过 UI 校验的追加都不会触发 K3 单据。
EXCLUDED_WH_NAMES_FOR_WRITEBACK = {"库存检查不良仓"}


async def plan_writebacks(db: AsyncSession, head: StockCheck) -> List[StockCheckK3Writeback]:
    """完结事务内调用:按盘差行×盘点人分组生成 pending 回写记录。幂等(已有记录则跳过)。

    - source='k3' 的单不回写(K3 单据已存在)
    - diff_qty=0 或 wh_id 为空的行不参与;后者由 overview 返回 skipped 清单
    - 分组键: (bill_type, wh_id, counter_user_id);同一仓库同类型多盘点人 → 多张 K3 单
    - counter_user_id=None 的明细落入 counter_user_id=NULL 的 fallback 桶(后续用常量 manager_id)
    - manager_id 一次 JOIN sys_user→scm_employee 取 erp_user_id 落到记录上,避免执行时再查
    """
    if (head.source or "manual") == "k3":
        return []
    existing = (await db.execute(
        select(StockCheckK3Writeback.id).where(StockCheckK3Writeback.check_id == head.id)
    )).scalars().first()
    if existing:
        return []

    items: List[StockCheckItem] = list(getattr(head, "items", None) or [])
    diff_items = [
        it for it in items
        if Decimal(str(it.diff_qty or 0)) != 0 and it.wh_id is not None
    ]
    # K3 回写阶段双重防御:库存检查不良仓本身不是盘点对象,其盘差不生成 K3 单据
    # (这类行通过 get_writeback_overview.skipped_items 透出给前端)
    diff_items = [
        it for it in diff_items
        if (it.wh_name or "").strip() not in EXCLUDED_WH_NAMES_FOR_WRITEBACK
    ]

    # 一次 JOIN 查盘点人 → K3 员工 ID (counter_user_id -> erp_user_id)
    from app.models.basicdata.user import SysUser
    from app.models.basicdata.employee import Employee
    user_ids = {int(it.counted_by_user_id) for it in diff_items if it.counted_by_user_id is not None}
    manager_map: Dict[int, int] = {}
    if user_ids:
        rows = (await db.execute(
            select(SysUser.id, Employee.erp_user_id)
            .join(Employee, SysUser.scm_employee_id == Employee.id)
            .where(SysUser.id.in_(user_ids), Employee.erp_user_id.is_not(None))
        )).all()
        manager_map = {int(uid): int(eid) for uid, eid in rows}

    groups: Dict[Tuple[str, int, Optional[int]], dict] = {}
    for it in diff_items:
        diff = Decimal(str(it.diff_qty or 0))
        bill_type = "gain" if diff > 0 else "loss_transfer"
        cid = int(it.counted_by_user_id) if it.counted_by_user_id is not None else None
        key = (bill_type, int(it.wh_id), cid)
        g = groups.setdefault(key, {
            "bill_type": bill_type, "wh_id": int(it.wh_id),
            "wh_code": it.wh_code, "wh_name": it.wh_name,
            "counter_user_id": cid,
            "manager_id": manager_map.get(cid) if cid is not None else None,
            "item_count": 0, "total_qty": Decimal("0"),
        })
        g["item_count"] += 1
        g["total_qty"] += abs(diff)

    creator = head.checked_by or head.created_by or "系统"
    records: List[StockCheckK3Writeback] = []
    for g in groups.values():
        records.append(StockCheckK3Writeback(
            check_id=head.id, bill_type=g["bill_type"],
            wh_id=g["wh_id"], wh_code=g["wh_code"], wh_name=g["wh_name"],
            counter_user_id=g["counter_user_id"],
            manager_id=g["manager_id"],
            status="pending", item_count=g["item_count"], total_qty=g["total_qty"],
            created_by=creator,
        ))
    db.add_all(records)
    return records


async def get_writeback_overview(db: AsyncSession, check_id: int) -> Dict:
    """回写记录列表 + 跳过清单(含 wh_id=NULL 与 wh_name=库存检查不良仓 的盘差行)。"""
    records = (await db.execute(
        select(StockCheckK3Writeback)
        .where(StockCheckK3Writeback.check_id == check_id)
        .order_by(StockCheckK3Writeback.bill_type, StockCheckK3Writeback.wh_id)
    )).scalars().all()
    skipped = (await db.execute(
        select(StockCheckItem)
        .where(
            StockCheckItem.check_id == check_id,
            StockCheckItem.diff_qty != 0,
        )
    )).scalars().all()
    skipped_items: List[Dict] = []
    for it in skipped:
        reason: Optional[str] = None
        if it.wh_id is None:
            reason = "盘点行无仓库(wh_id=NULL)，不生成 K3 单据"
        elif (it.wh_name or "").strip() in EXCLUDED_WH_NAMES_FOR_WRITEBACK:
            reason = "盘点行仓库为库存检查不良仓，不生成 K3 单据"
        if reason is None:
            continue
        skipped_items.append({
            "material_code": it.material_code,
            "material_name": it.material_name,
            "unit": it.unit,
            "diff_qty": Decimal(str(it.diff_qty or 0)),
            "reason": reason,
        })
    return {
        "writebacks": list(records),
        "skipped_items": skipped_items,
    }


# ---------------------------------------------------------------- K3 写入 --

def _next_k3_bill_no_sync(conn, prefix: str) -> str:
    """按 K3 现有单号规则生成下一号: prefix + 数字后缀零填充(位数对齐现有最大号)。"""
    mx = conn.execute(text(
        f"SELECT MAX(FBillNo) FROM {K3_WRITE_DB}.dbo.ICStockBill WHERE FBillNo LIKE :p"
    ), {"p": prefix + "%"}).scalar()
    width, next_seq = 10, 1
    if mx:
        m = re.search(r"(\d+)$", str(mx))
        if m:
            width = len(m.group(1))
            next_seq = int(m.group(1)) + 1
    return f"{prefix}{str(next_seq).zfill(width)}"


# K3 客户端序时簿可见性关键列形态(测试账套 e2e 实证 2026-09-08, 对照原生未审核单):
# - 未审核约定 FCheckerID=NULL(非 0): 客户端「未审核」过滤为 IS NULL, 写 0 会被当成已审核
# - FDeptID/FEmpID 及体表仓位/序列号列用 0 占位而非 NULL: 序时簿 join 基础资料表时 NULL 整行被过滤
INSERT_HEAD_SQL = f"""
INSERT INTO {K3_WRITE_DB}.dbo.ICStockBill
    (FInterID, FBrNo, FBrID, FBillNo, FDate, FTranType, FNote, FExplanation,
     FBillerID, FCheckerID, FCancellation, FFManagerID, FSManagerID,
     FDeptID, FEmpID, FInventoryType, FRefType)
VALUES
    (:FInterID, '0', :FBrID, :FBillNo, :FDate, :FTranType, :FNote, :FExplanation,
     :FBillerID, NULL, 0, :FManagerID, :FManagerID,
     0, 0, :FInventoryType, :FRefType)
"""

INSERT_ENTRY_SQL = f"""
INSERT INTO {K3_WRITE_DB}.dbo.ICStockBillEntry
    (FInterID, FEntryID, FBrNo, FItemID, FUnitID, FQty, FQtyMust, FQtyActual,
     FPrice, FAmount, FDCStockID, FSCStockID, FBatchNo, FDCSPID, FSCSPID, FSnListID)
VALUES
    (:FInterID, :FEntryID, '0', :FItemID, :FUnitID, :FQty, :FQtyMust, :FQtyActual,
     0, 0, :FDCStockID, :FSCStockID, '', 0, 0, 0)
"""

GAIN_PREFIX, TRANSFER_PREFIX = "YADJ", "CHG"

# 写路径进程内锁: 把「预检→取号→插入→补偿」整体串行化(单 worker 部署下足够)。
# 取号与 K3 客户端同源(ICMaxNum 原子推进), 跨进程天然不撞号; 锁只防本服务并发完结/重试互踩。
_K3_WRITE_LOCK = threading.Lock()

# Fallback 分组无盘点人 warning 去重: 每 (check_id, bill_type, wh_id) 仅打一次,
# 防止 pending 记录 retry 时同一缺失映射反复刷日志(单 worker 部署内足够)。
_WARNED_FALLBACKS: "set[tuple]" = set()

# 与 K3 客户端同源原子取号: 单条 UPDATE 链式赋值推 ICMaxNum(成对预留, 与 K3 客户端
# IC_MaxNum 每用户成对占号的实证足迹一致), 返回预留对中的低号。
# 反面教训(2026-09 生产事故): MAX(FInterID)+1 直插不推计数器, K3 客户端下次保存取到
# 已占用 ID → 主键重复报错, 单据被迫人工删除重录。
ALLOC_INTER_ID_SQL = f"""
SET NOCOUNT ON;
DECLARE @n INT;
UPDATE {K3_WRITE_DB}.dbo.ICMaxNum SET @n = FMaxNum = FMaxNum + 2 WHERE FTableName = 'ICStockBill';
SELECT ISNULL(@n, 0) AS new_max;
"""

# 写入前预检: 计数器落后于实际 MAX(FInterID) 说明有人绕过计数器直插过单据,
# 此时继续写入迟早与 K3 客户端撞号, 直接拒绝并给出修复指引。
CHECK_COUNTER_SQL = f"""
SELECT c.FMaxNum, (SELECT MAX(b.FInterID) FROM {K3_WRITE_DB}.dbo.ICStockBill b) AS max_id
FROM {K3_WRITE_DB}.dbo.ICMaxNum c WHERE c.FTableName = 'ICStockBill'
"""


def _alloc_inter_id_sync(conn) -> int:
    """原子推 ICMaxNum 并返回新 FInterID(成对预留中的低号)。计数器行缺失/取号失败即抛错。"""
    new_max = int(conn.execute(text(ALLOC_INTER_ID_SQL)).scalar() or 0)
    if new_max < 2:
        raise RuntimeError(f"K3 ICMaxNum 缺少 ICStockBill 计数器行(或取号失败), 拒绝写入({K3_WRITE_DB})")
    return new_max - 1


def _check_counter_synced(conn) -> None:
    """预检: ICMaxNum.FMaxNum 必须 >= MAX(FInterID), 否则拒绝回写(把撞号拦在写入之前)。"""
    row = conn.execute(text(CHECK_COUNTER_SQL)).mappings().first()
    if row is None:
        raise RuntimeError(f"K3 ICMaxNum 缺少 ICStockBill 计数器行, 拒绝回写({K3_WRITE_DB})")
    fmax, max_id = int(row["FMaxNum"] or 0), int(row["max_id"] or 0)
    if fmax < max_id:
        raise RuntimeError(
            f"K3 计数器落后(FMaxNum={fmax} < MAX(FInterID)={max_id}), "
            f"继续写入会与 K3 客户端撞 ID; 请先将 ICMaxNum.FMaxNum 推到 MAX 以上再重试"
        )


def _check_master_data_sync(conn, item_ids: set, stock_ids: set) -> None:
    """预检: 回写涉及的物料/仓库必须在目标账套存在(t_ICItem/t_Stock)。

    序时簿按基础资料 join 显示, 缺失会导致"写入成功但客户端整行不可见"
    (测试账套实证 2026-09-08: 调入仓 92852 缺失时调拨单序时簿查不到)。
    """
    missing = []
    if item_ids:
        ids = ",".join(str(int(i)) for i in sorted(item_ids))
        found = {int(r[0]) for r in conn.execute(text(
            f"SELECT FItemID FROM {K3_WRITE_DB}.dbo.t_ICItem WHERE FItemID IN ({ids})"))}
        missing += [f"物料{i}" for i in sorted(item_ids - found)]
    stocks = {int(s) for s in stock_ids if s}
    if stocks:
        ids = ",".join(str(i) for i in sorted(stocks))
        found = {int(r[0]) for r in conn.execute(text(
            f"SELECT FItemID FROM {K3_WRITE_DB}.dbo.t_Stock WHERE FItemID IN ({ids})"))}
        missing += [f"仓库{i}" for i in sorted(stocks - found)]
    if missing:
        raise RuntimeError(
            f"K3 回写目标账套({K3_WRITE_DB})缺少基础资料: {', '.join(missing)}; "
            f"单据写入后 K3 客户端序时簿将不可见, 请先在 K3 维护后重试"
        )


def _write_bill_sync(rec: StockCheckK3Writeback, entries: List[dict], manager_id: int) -> Tuple[str, int]:
    """同步写一张 K3 未审核单(头+体)。entries 由调用方按明细行构造。

    连接经链接服务器(k3sv)访问 K3: 显式事务内跨链接服务器 INSERT 会报
    7395(OLE DB 提供程序不支持嵌套事务), 故写路径用 AUTOCOMMIT 逐句提交,
    失败时以补偿删除清理残留(未审核单无下游影响, 删除安全)。
    取号与 K3 客户端同源(ICMaxNum 原子推进+成对预留), 跨进程不撞号;
    写入失败补偿删单时不回退计数器 —— 跳号对 K3 无害, 回退反而有并发风险。
    """
    inter_id: Optional[int] = None
    bill_no: Optional[str] = None
    with _K3_WRITE_LOCK, _get_k3_engine().connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        try:
            _check_counter_synced(conn)
            item_ids = {int(e["item_id"]) for e in entries}
            stock_ids = {int(e["dc_stock"] or 0) for e in entries} | {int(e["sc_stock"] or 0) for e in entries}
            _check_master_data_sync(conn, item_ids, stock_ids)
            inter_id = _alloc_inter_id_sync(conn)
            # FDetailID 是 IDENTITY 自增列(链接服务器下显式插入报 7344 无列权限), 交给 SQL Server 生成
            is_gain = rec.bill_type == "gain"
            prefix = GAIN_PREFIX if is_gain else TRANSFER_PREFIX
            bill_no = _next_k3_bill_no_sync(conn, prefix)
            conn.execute(text(INSERT_HEAD_SQL), {
                "FInterID": inter_id, "FBrID": 0, "FBillNo": bill_no,
                "FDate": entries[0]["fdate"], "FTranType": TRAN_TYPE_GAIN if is_gain else TRAN_TYPE_TRANSFER_LOSS,
                "FNote": entries[0]["fnote"], "FExplanation": "",
                "FBillerID": K3_DEFAULT_BILLER_ID, "FManagerID": int(manager_id),
                "FInventoryType": K3_GAIN_INVENTORY_TYPE if is_gain else 0,
                "FRefType": 0 if is_gain else K3_TRANSFER_REF_TYPE,
            })
            for idx, e in enumerate(entries, start=1):
                conn.execute(text(INSERT_ENTRY_SQL), {
                    "FInterID": inter_id,
                    "FEntryID": idx * K3_FENTRYID_STEP,
                    "FItemID": e["item_id"], "FUnitID": e["unit_id"],
                    "FQty": e["qty"], "FQtyMust": e["qty_must"], "FQtyActual": e["qty_actual"],
                    "FDCStockID": e["dc_stock"], "FSCStockID": e["sc_stock"],
                })
            return bill_no, inter_id
        except Exception as e:
            # 补偿清理: 删掉可能已插入的头/体残留(未审核单无下游影响)。
            # 头表删除限定 FBillNo, 防止极端并发下误删他人已提交的同 FInterID 单据。
            if inter_id is not None:
                try:
                    conn.execute(text(
                        f"DELETE FROM {K3_WRITE_DB}.dbo.ICStockBillEntry WHERE FInterID = :i"
                    ), {"i": inter_id})
                    conn.execute(text(
                        f"DELETE FROM {K3_WRITE_DB}.dbo.ICStockBill WHERE FInterID = :i AND FBillNo = :b"
                    ), {"i": inter_id, "b": bill_no})
                except Exception:
                    raise RuntimeError(
                        f"K3 写入失败且补偿删除失败(残留未审核单 FInterID={inter_id} {bill_no}),"
                        f"请人工在 K3 删除后重试; 原错误: {str(e)[:200]}"
                    ) from e
            raise


def _load_unit_ids_sync(item_ids: List[int]) -> Dict[int, int]:
    """物料默认单位: t_ICItem.FUnitID(批量查,缺失回退 0)。"""
    if not item_ids:
        return {}
    ids = ",".join(str(int(i)) for i in item_ids)
    with _get_k3_engine().connect() as conn:
        rows = conn.execute(text(
            f"SELECT FItemID, FUnitID FROM {K3_WRITE_DB}.dbo.t_ICItem WHERE FItemID IN ({ids})"
        )).mappings().all()
    return {int(r["FItemID"]): int(r["FUnitID"] or 0) for r in rows}


async def _execute_one(db: AsyncSession, rec: StockCheckK3Writeback, head: StockCheck) -> None:
    """生成一张 K3 单并更新记录状态(单张独立成败,异常记 failed 不抛出)。

    全部 K3 访问(单位装载/单据写入)都在 try 内:K3 不可达只置本记录 failed,
    不中断同批其余记录,也不让 retry 端点 500。
    """
    try:
        # manager_id 优先级: 记录上的 manager_id → fallback 到常量(NULL 组)
        from app.models.basicdata.user import SysUser
        if rec.counter_user_id is not None and rec.manager_id is None:
            username = (await db.execute(
                select(SysUser.username).where(SysUser.id == rec.counter_user_id)
            )).scalar_one_or_none() or f"id={rec.counter_user_id}"
            rec.status = "failed"
            rec.error_msg = (
                f"盘点人 {username}(sys_user.id={rec.counter_user_id}) 未关联 K3 员工 ID"
                f"(scm_employee.erp_user_id 为空),请到 [员工管理] 维护映射后再重试"
            )
            rec.retry_count = int(rec.retry_count or 0) + 1
            logger.warning(
                f"K3 回写失败:盘点人缺映射 check={rec.check_id} type={rec.bill_type} "
                f"wh={rec.wh_id} counter_user_id={rec.counter_user_id}"
            )
            return
        if rec.counter_user_id is None:
            fb_key = (rec.check_id, rec.bill_type, rec.wh_id)
            if fb_key not in _WARNED_FALLBACKS:
                _WARNED_FALLBACKS.add(fb_key)
                logger.warning(
                    f"K3 回写: 分组无盘点人, fallback 默认保管人={K3_DEFAULT_MANAGER_ID}; "
                    f"check={rec.check_id} type={rec.bill_type} wh={rec.wh_id}, 建议补全映射"
                )
        items = (await db.execute(
            select(StockCheckItem).where(
                StockCheckItem.check_id == rec.check_id,
                StockCheckItem.wh_id == rec.wh_id,
                StockCheckItem.diff_qty != 0,
            ).order_by(StockCheckItem.id)
        )).scalars().all()
        diff_rows = [it for it in items if (Decimal(str(it.diff_qty or 0)) > 0) == (rec.bill_type == "gain")]
        diff_rows = [it for it in diff_rows if it.material_id is not None]  # K3 FItemID 必需
        if not diff_rows:
            rec.status = "failed"
            rec.error_msg = "未找到对应的盘差明细行(或行均无物料ID)"
            return
        unit_ids = await asyncio.to_thread(
            _load_unit_ids_sync, [int(it.material_id) for it in diff_rows])
        no_unit = sorted({int(it.material_id) for it in diff_rows
                          if unit_ids.get(int(it.material_id), 0) == 0})
        if no_unit:
            rec.status = "failed"
            rec.error_msg = (
                f"物料 {no_unit} 在 K3 目标账套无计量单位(t_ICItem 缺失或 FUnitID 为空), 拒绝回写"
            )
            return
        fdate = head.check_date
        # FNote 加 ASCII 前缀, 保证跨编码环境可按 "SPC %" 检索中台写入的单据
        fnote = f"SPC {head.check_no} 盘点完结自动生成"
        entries = []
        for it in diff_rows:
            diff = Decimal(str(it.diff_qty or 0))
            qty = abs(diff)
            if rec.bill_type == "gain":
                entries.append({
                    "item_id": int(it.material_id), "unit_id": unit_ids.get(int(it.material_id), 0),
                    "qty": qty, "qty_must": Decimal(str(it.system_qty or 0)),
                    "qty_actual": Decimal(str(it.actual_qty or 0)),
                    "dc_stock": rec.wh_id, "sc_stock": 0,
                    "fdate": fdate, "fnote": fnote,
                })
            else:
                entries.append({
                    "item_id": int(it.material_id), "unit_id": unit_ids.get(int(it.material_id), 0),
                    "qty": qty, "qty_must": qty, "qty_actual": 0,
                    "dc_stock": BAD_STOCK_WH_ID, "sc_stock": rec.wh_id,
                    "fdate": fdate, "fnote": fnote,
                })
        manager_id_for_bill = rec.manager_id if rec.manager_id is not None else K3_DEFAULT_MANAGER_ID
        bill_no, inter_id = await asyncio.wait_for(
            asyncio.to_thread(_write_bill_sync, rec, entries, manager_id_for_bill),
            timeout=WRITEBACK_TIMEOUT)
        rec.status = "success"
        rec.erp_bill_no = bill_no
        rec.k3_inter_id = inter_id
        rec.written_at = datetime.now()
        rec.error_msg = None
    except asyncio.TimeoutError:
        rec.status = "failed"
        rec.error_msg = (
            f"K3 写入超时({WRITEBACK_TIMEOUT}s);写入可能仍在后台完成,重试前请先在 K3 核实是否已生成单据"
        )
        rec.retry_count = int(rec.retry_count or 0) + 1
        logger.warning(f"K3 回写超时 check={rec.check_id} type={rec.bill_type} wh={rec.wh_id}")
    except Exception as e:  # 单张失败不中断其余
        rec.status = "failed"
        rec.error_msg = str(e)[:500]
        rec.retry_count = int(rec.retry_count or 0) + 1
        logger.warning(f"K3 回写失败 check={rec.check_id} type={rec.bill_type} wh={rec.wh_id}: {e}")


async def execute_pending_writebacks(
    db: AsyncSession, check_id: int, current_user: Optional[dict] = None,
) -> Dict:
    """执行(或重试)该盘点单所有 pending/failed 回写记录;success 不动。返回统计。"""
    head = (await db.execute(select(StockCheck).where(StockCheck.id == check_id))).scalar_one_or_none()
    if not head:
        raise ValueError(f"盘点单 {check_id} 不存在")
    if head.status != "completed":
        raise ValueError("仅已完结的盘点单可执行 K3 回写")
    recs = (await db.execute(
        select(StockCheckK3Writeback).where(
            StockCheckK3Writeback.check_id == check_id,
            StockCheckK3Writeback.status.in_(("pending", "failed")),
        ).order_by(StockCheckK3Writeback.id)
    )).scalars().all()
    for rec in recs:
        await _execute_one(db, rec, head)
    await db.commit()  # 状态更新立即落库(自管事务;get_db 结束时再 commit 幂等)
    all_recs = (await db.execute(
        select(StockCheckK3Writeback).where(StockCheckK3Writeback.check_id == check_id)
    )).scalars().all()
    return {
        "total": len(all_recs),
        "success": sum(1 for r in all_recs if r.status == "success"),
        "failed": sum(1 for r in all_recs if r.status == "failed"),
        "pending": sum(1 for r in all_recs if r.status == "pending"),
    }
