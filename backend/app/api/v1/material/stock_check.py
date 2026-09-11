"""物料齐套中心 — 物料盘点 API (scm_inventory_check)"""

import json
import logging
from datetime import date
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query, Request, File, Form, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select, desc, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import AsyncSessionLocal, get_db
from app.core.dependencies import get_current_user
from app.core.security import PermissionChecker
from app.schemas.common import ResponseModel, PageResult
from app.services.common.export_service import GenericExportService, ExportColumn
from app.schemas.material.stock_check import (
    StockCheckCreate,
    StockCheckFromMaterialsCreate,
    StockCheckOut,
    StockCheckListOut,
    StockCheckItemOut,
    StockCheckItemUpdate,
    StockCheckItemBatchUpdate,
    CoCheckersUpdate,
    QuickCountIn,
    PresenceUpdate,
    MaterialHistoryItem,
    MaterialCandidateOut,
    ScanWarehouseOut,
    ResolvedCodeOut,
    StockCheckCountedItemOut,
    StockCheckStats,
    StockCheckKpi,
    StockCheckMyItemOut,
    StockCheckConflictOut,
    StockCheckActionBody,
    K3BillOut,
    K3ImportRequest,
    K3ImportResultOut,
    StockCheckWritebackOut,
    WritebackOverviewOut,
    TaskCoverageOut,
    TaskCoverageMaterialOrdersOut,
    StockCheckExportBody,
)
from app.models.material.inventory_check import StockCheck, StockCheckItem
from app.services.material.stock_check_service import (
    attach_list_extras,
    create_stock_check_from_order,
    create_stock_check_from_materials,
    list_material_candidates,
    list_counted_materials_ledger,
    list_counted_warehouses,
    list_scan_warehouses,
    resolve_material_by_code,
    update_stock_check_item,
    batch_update_items,
    complete_stock_check,
    cancel_stock_check,
    set_co_checkers,
    refresh_order_bom,
    refresh_check_warehouses,
    add_items_to_check,
    quick_count_material,
    get_today_quick_check,
    remove_quick_count_item,
    remove_item_from_check,
    get_stock_check_with_items,
    list_recent_stock_checks,
    list_stock_checks_by_order,
    get_material_history,
    list_co_checker_candidates,
    enrich_items_assoc,
    enrich_live_qty,
    get_stock_check_stats,
    get_stock_check_kpi,
    list_my_stock_check_items,
    get_task_material_coverage,
    get_task_material_order_breakdown,
    _user_can_edit,
    _current_user_id,
    _resolve_user_names,
    writeback_todo_criterion,
    StockCheckPermissionError,
    StockCheckConflictError,
)
from app.services.material.stock_check_k3_service import (
    list_k3_gain_loss_bills,
    import_k3_bills_as_stock_checks,
)
from app.services.material.stock_check_k3_writeback_service import (
    plan_writebacks,
    execute_pending_writebacks,
    get_writeback_overview,
)
from app.services.material.stock_check_broker import subscribe_stream, set_presence, clear_presence

logger = logging.getLogger(__name__)

router = APIRouter()


STOCK_CHECK_EXPORT_COLUMNS: list[ExportColumn] = [
    ExportColumn("material_code", "物料编码", 16),
    ExportColumn("material_name", "物料名称", 24),
    ExportColumn("spec_model", "规格", 16),
    ExportColumn("material_type", "分类", 12),
    ExportColumn("material_property_label", "属性", 10),
    ExportColumn("unit", "单位", 8),
    ExportColumn("system_qty", "快照库存", 12),
    ExportColumn("system_qty_time", "快照时间", 18),
    ExportColumn("live_qty", "即时库存", 12),
    ExportColumn("wh_name", "仓库", 16),
    ExportColumn("req_qty", "应盘数", 12),
    ExportColumn("actual_qty", "盘点数", 12),
    ExportColumn("diff_qty", "差异", 12),
    ExportColumn("is_checked", "已盘", 8),
    ExportColumn("checked_by", "标记人", 12),
    ExportColumn("checked_at", "标记时间", 18),
    ExportColumn("remark", "备注", 20),
]


async def _to_check_out(db: AsyncSession, head: StockCheck, current_user: dict) -> StockCheckOut:
    """构造 StockCheckOut，附带共同盘点人姓名 + can_edit。"""
    out = StockCheckOut.model_validate(head)
    ids = list(head.co_checker_user_ids or [])
    name_map = await _resolve_user_names(db, ids + ([head.created_by_user_id] if head.created_by_user_id else []))
    out.co_checkers = [{"user_id": int(i), "name": name_map.get(int(i), f"user#{i}")} for i in ids]
    out.can_edit = _user_can_edit(head, current_user)
    return out


def _user_can_view(head: Optional[StockCheck], current_user: dict) -> bool:
    """SSE 订阅权限:拥有 materials.stock_check 读权限,或为创建人/共同盘点人/admin。"""
    if current_user.get("role") == "admin":
        return True
    perms = current_user.get("permissions") or {}
    if "materials.stock_check" in perms and "read" in (perms.get("materials.stock_check") or []):
        return True
    return _user_can_edit(head, current_user)


@router.post("/stock-check/from-order/{order_no}", response_model=ResponseModel[StockCheckOut])
async def create_from_order(
    order_no: str,
    body: Optional[StockCheckCreate] = None,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    body = body or StockCheckCreate(order_no=order_no)
    try:
        head = await create_stock_check_from_order(
            db,
            order_no=order_no,
            current_user=current_user,
            title=body.title,
            check_date=body.check_date,
            remark=body.remark,
            selected_products=(
                [s.model_dump() for s in body.selected_products]
                if body.selected_products else None
            ),
            co_checker_user_ids=body.co_checker_user_ids,
            recent_days=body.recent_days,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    head = await get_stock_check_with_items(db, head.id)
    return ResponseModel(data=await _to_check_out(db, head, current_user))


@router.post("/stock-check/from-materials", response_model=ResponseModel[StockCheckOut])
async def create_from_materials(
    body: StockCheckFromMaterialsCreate,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    has_ids = bool(body.material_ids)
    has_items = bool(body.items)
    if not has_ids and not has_items:
        raise HTTPException(status_code=400, detail="请选择 1~500 个物料")
    if (has_ids and len(body.material_ids) > 500) or (has_items and len(body.items) > 500):
        raise HTTPException(status_code=400, detail="一次最多创建 500 个盘点项，请减少勾选数量")
    try:
        head = await create_stock_check_from_materials(
            db,
            material_ids=body.material_ids,
            items=[(it.material_id, it.wh_id) for it in body.items] if body.items else None,
            current_user=current_user,
            title=body.title,
            check_date=body.check_date,
            remark=body.remark,
            co_checker_user_ids=body.co_checker_user_ids,
            recent_days=body.recent_days,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    head = await get_stock_check_with_items(db, head.id)
    return ResponseModel(data=await _to_check_out(db, head, current_user))


@router.get("/stock-check/material-candidates", response_model=ResponseModel[PageResult[MaterialCandidateOut]])
async def list_material_candidates_view(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索物料编码/名称/规格"),
    wh_id: Optional[str] = Query(None, description="仓库ID(int)或名称(string)"),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    total, items = await list_material_candidates(
        db, page=page, page_size=page_size, keyword=keyword, wh_id=wh_id
    )
    return ResponseModel(data=PageResult(
        total=total,
        page=page,
        page_size=page_size,
        items=[MaterialCandidateOut(**it) for it in items],
    ))


@router.get("/stock-check/task-coverage", response_model=ResponseModel[TaskCoverageOut])
async def get_task_stock_coverage_view(
    start_date: date = Query(..., description="计划开工日期-起"),
    end_date: date = Query(..., description="计划开工日期-止"),
    status: str = Query("all", pattern="^(all|checked|unchecked)$"),
    keyword: Optional[str] = Query(None, description="物料编码/名称/规格"),
    wh_id: Optional[int] = Query(None, description="按仓库过滤行"),
    wh_ids: Optional[str] = Query(None, description="按仓库多选过滤行(逗号分隔; -1 表示 (未入库) 合成行)"),
    unstocked: bool = Query(False, description="仅看(未入库)合成行(wh_id 为空)"),
    sort_by: Optional[str] = Query(None, description="排序列: material_code/material_name/spec_model/wh_name/system_qty/req_qty/task_count/recent_check_date"),
    sort_order: str = Query("asc", pattern="^(asc|desc)$"),
    include_sample: bool = Query(False, description="包含样品单(HJY开头销售订单)对应的任务，默认排除"),
    recent_days: Optional[int] = Query(None, ge=-1, le=100000, description="「已盘」判定窗口=近 N 天内实盘过;-1 或 99999=不限(全部历史);省略=服务端配置默认(7 天)"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    current_user: dict = Depends(PermissionChecker("materials.task_stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """生产任务单物料盘点覆盖: 按计划开工日期范围查未关闭任务单所需物料的已盘/未盘状态（平铺行 + 仓库汇总）。"""
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="开始日期不能晚于结束日期")
    allowed_sorts = ("material_code", "material_name", "spec_model", "wh_name", "system_qty", "req_qty", "task_count", "recent_check_date", "is_checked")
    if sort_by is not None and sort_by not in allowed_sorts:
        raise HTTPException(status_code=400, detail=f"sort_by 仅支持: {', '.join(allowed_sorts)}")
    ids: Optional[List[int]] = None
    if wh_ids:
        parts = [p.strip() for p in wh_ids.split(",") if p.strip()]
        try:
            ids = [int(p) for p in parts]
        except ValueError:
            raise HTTPException(status_code=400, detail="wh_ids 需为逗号分隔的仓库ID")
    data = await get_task_material_coverage(
        db, start_date=start_date, end_date=end_date,
        status=status, keyword=keyword, page=page, page_size=page_size,
        wh_id=None if unstocked else wh_id,
        wh_ids=None if unstocked else ids,
        unstocked=unstocked,
        sort_by=sort_by, sort_order=sort_order,
        include_sample=include_sample,
        recent_days=recent_days,
    )
    return ResponseModel(data=TaskCoverageOut(**data))


@router.get("/stock-check/task-coverage/material-orders", response_model=ResponseModel[TaskCoverageMaterialOrdersOut])
async def get_task_coverage_material_orders_view(
    start_date: date = Query(..., description="计划开工日期-起"),
    end_date: date = Query(..., description="计划开工日期-止"),
    material_id: int = Query(..., description="物料ID(erp_material_id)"),
    include_sample: bool = Query(False, description="包含样品单(HJY开头销售订单)对应的任务，默认排除"),
    current_user: dict = Depends(PermissionChecker("materials.task_stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """任务盘点覆盖 · 单物料「订单×需求量」明细（点击物料代码钻取，口径与列表一致）。"""
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="开始日期不能晚于结束日期")
    data = await get_task_material_order_breakdown(
        db, start_date=start_date, end_date=end_date,
        material_id=material_id, include_sample=include_sample,
    )
    if data is None:
        raise HTTPException(status_code=404, detail="该日期范围内未找到此物料的需求记录")
    return ResponseModel(data=TaskCoverageMaterialOrdersOut(**data))


TASK_COVERAGE_EXPORT_COLUMNS = [
    ExportColumn("material_code", "物料编码", 18),
    ExportColumn("material_name", "物料名称", 26),
    ExportColumn("spec_model", "规格", 18),
    ExportColumn("unit", "单位", 8),
    ExportColumn("wh_name", "仓库", 16),
    ExportColumn("system_qty", "当前库存", 12),
    ExportColumn("req_qty", "需求总量", 12),
    ExportColumn("is_checked", "盘点状态", 10),
    ExportColumn("recent_check_no", "最近盘点单", 18),
    ExportColumn("recent_check_date", "最近盘点日期", 14),
    ExportColumn("task_nos", "关联任务单", 36),
    ExportColumn("order_nos", "关联订单", 36),
]


@router.get("/stock-check/task-coverage/export")
async def export_task_stock_coverage(
    format: str = Query("xlsx", pattern="^(xlsx|csv)$"),
    columns: Optional[str] = Query(None, description="要导出的列 key，逗号分隔；不传则导出全部列"),
    start_date: date = Query(..., description="计划开工日期-起"),
    end_date: date = Query(..., description="计划开工日期-止"),
    status: str = Query("all", pattern="^(all|checked|unchecked)$"),
    keyword: Optional[str] = Query(None, description="物料编码/名称/规格"),
    wh_id: Optional[int] = Query(None, description="按仓库过滤行"),
    wh_ids: Optional[str] = Query(None, description="按仓库多选过滤行(逗号分隔; -1 表示 (未入库) 合成行)"),
    unstocked: bool = Query(False, description="仅看(未入库)合成行(wh_id 为空)"),
    sort_by: Optional[str] = Query(None, description="排序列: material_code/material_name/spec_model/wh_name/system_qty/req_qty/task_count/recent_check_date"),
    sort_order: str = Query("asc", pattern="^(asc|desc)$"),
    include_sample: bool = Query(False, description="包含样品单(HJY开头销售订单)对应的任务，默认排除"),
    recent_days: Optional[int] = Query(None, ge=-1, le=100000, description="「已盘」判定窗口=近 N 天内实盘过;-1 或 99999=不限(全部历史);省略=服务端配置默认(7 天)"),
    current_user: dict = Depends(PermissionChecker("materials.task_stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """任务盘点覆盖导出（支持格式 xlsx/csv + 列选择，跟随与列表视图一致的筛选，不分页截断）。"""
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="开始日期不能晚于结束日期")
    allowed_sorts = ("material_code", "material_name", "spec_model", "wh_name", "system_qty", "req_qty", "task_count", "recent_check_date", "is_checked")
    if sort_by is not None and sort_by not in allowed_sorts:
        raise HTTPException(status_code=400, detail=f"sort_by 仅支持: {', '.join(allowed_sorts)}")
    ids: Optional[List[int]] = None
    if wh_ids:
        parts = [p.strip() for p in wh_ids.split(",") if p.strip()]
        try:
            ids = [int(p) for p in parts]
        except ValueError:
            raise HTTPException(status_code=400, detail="wh_ids 需为逗号分隔的仓库ID")
    data = await get_task_material_coverage(
        db, start_date=start_date, end_date=end_date,
        status=status, keyword=keyword, page=1, page_size=1_000_000,
        wh_id=None if unstocked else wh_id,
        wh_ids=None if unstocked else ids,
        unstocked=unstocked,
        sort_by=sort_by, sort_order=sort_order,
        include_sample=include_sample,
        recent_days=recent_days,
    )

    export_rows = []
    for r in data["items"]:
        export_rows.append({
            "material_code": r["material_code"] or "",
            "material_name": r["material_name"] or "",
            "spec_model": r["spec_model"] or "",
            "unit": r["unit"] or "",
            "wh_name": r["wh_name"] or "",
            "system_qty": float(r["system_qty"]) if r["system_qty"] is not None else "",
            "req_qty": float(r["req_qty"]) if r["req_qty"] is not None else "",
            "is_checked": "已盘" if r["is_checked"] else "未盘",
            "recent_check_no": r["recent_check_no"] or "",
            "recent_check_date": str(r["recent_check_date"]) if r["recent_check_date"] else "",
            "task_nos": " ".join(r["task_nos"] or []),
            "order_nos": " ".join(r["order_nos"] or []),
        })

    if columns:
        selected_keys = [c.strip() for c in columns.split(",") if c.strip()]
        export_columns = [col for col in TASK_COVERAGE_EXPORT_COLUMNS if col.key in selected_keys]
    else:
        export_columns = TASK_COVERAGE_EXPORT_COLUMNS

    svc = GenericExportService(export_columns, export_rows, sheet_name="任务盘点")

    if format == "csv":
        output = svc.to_csv()
        return StreamingResponse(
            output,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=task_stock_coverage_export.csv"},
        )
    output = svc.to_xlsx()
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=task_stock_coverage_export.xlsx"},
    )


@router.get("/stock-check/counted-warehouses", response_model=ResponseModel[List[dict]])
async def list_counted_warehouses_view(
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """已盘点物料台账涉及的仓库列表（去重），用于仓库列下拉筛选。"""
    items = await list_counted_warehouses(db)
    return ResponseModel(data=items)


@router.get("/stock-check/scan-warehouses", response_model=ResponseModel[List[ScanWarehouseOut]])
async def list_scan_warehouses_view(
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """扫码盘点: 顶部仓库选择器选项(scm_inventory 去重仓库)。"""
    items = await list_scan_warehouses(db)
    return ResponseModel(data=[ScanWarehouseOut(**w) for w in items])


@router.get("/stock-check/resolve-code", response_model=ResponseModel[ResolvedCodeOut])
async def resolve_stock_check_code(
    code: str = Query(..., description="扫出的编码(物料编码或SKU条码)"),
    wh_id: Optional[int] = Query(None, description="仓库ID(可选)"),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """扫码盘点: 编码精确解析为物料(+所选仓库系统库存)。未找到返回 404。"""
    try:
        data = await resolve_material_by_code(db, code=code, wh_id=wh_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return ResponseModel(data=ResolvedCodeOut(**data))


@router.get("/stock-check/counted-ledger", response_model=ResponseModel[PageResult[StockCheckCountedItemOut]])
async def list_counted_materials_view(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索物料编码/名称/规格"),
    wh_id: Optional[str] = Query(None, description="仓库ID(int)或名称(string)"),
    date_from: Optional[date] = Query(None, description="盘点日期起点 (YYYY-MM-DD)"),
    date_to: Optional[date] = Query(None, description="盘点日期终点 (YYYY-MM-DD)"),
    check_type: Optional[str] = Query(None, description="盘点类型:order/manual/quick"),
    status: Optional[str] = Query(None, description="状态筛选,逗号分隔(open/in_progress/completed)"),
    check_no: Optional[str] = Query(None, description="盘点单号模糊匹配"),
    counted_by: Optional[str] = Query(None, description="盘点人模糊匹配"),
    material_code: Optional[str] = Query(None, description="物料编码模糊匹配"),
    material_name: Optional[str] = Query(None, description="物料名称模糊匹配"),
    spec_model: Optional[str] = Query(None, description="规格型号模糊匹配"),
    only_mine: Optional[bool] = Query(False, description="仅当前用户盘点过的行"),
    diff_only: Optional[bool] = Query(False, description="仅差异行(diff_qty != 0)"),
    sort_by: Optional[str] = Query(None, description="排序字段:material_code/material_name/spec_model/unit/wh_name/system_qty/actual_qty/diff_qty/check_no/check_date/counted_by/counted_at/status"),
    sort_order: Optional[str] = Query(None, description="排序方向:asc/desc"),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """已盘点物料台账: 每个「物料×仓库」最近一条已盘点记录(排除已取消单)"""
    statuses = [s.strip() for s in (status or "").split(",") if s.strip()] or None
    total, items = await list_counted_materials_ledger(
        db,
        page=page,
        page_size=page_size,
        keyword=keyword,
        wh_id=wh_id,
        date_from=date_from,
        date_to=date_to,
        check_type=check_type,
        status=statuses,
        check_no=check_no,
        counted_by=counted_by,
        material_code=material_code,
        material_name=material_name,
        spec_model=spec_model,
        only_mine=bool(only_mine),
        diff_only=bool(diff_only),
        current_user_id=_current_user_id(current_user),
        sort_by=sort_by,
        sort_order=sort_order,
    )
    return ResponseModel(data=PageResult(
        total=total,
        page=page,
        page_size=page_size,
        items=[StockCheckCountedItemOut(**it) for it in items],
    ))


@router.get("/stock-check/material-history", response_model=ResponseModel[list[MaterialHistoryItem]])
async def get_material_history_view(
    material_id: int = Query(..., description="物料ID"),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    rows = await get_material_history(db, material_id=material_id)
    return ResponseModel(data=[MaterialHistoryItem(**r) for r in rows])


@router.get("/stock-check/recent", response_model=ResponseModel[PageResult[StockCheckListOut]])
async def recent(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索盘点单号/订单号/标题"),
    status: Optional[str] = Query(None, description="状态筛选,逗号分隔(open/in_progress/completed/cancelled)"),
    check_type: Optional[str] = Query(None, description="盘点类型:order/manual/quick"),
    source: Optional[str] = Query(None, description="数据来源:k3/manual"),
    date_from: Optional[date] = Query(None, description="盘点日期起点 (YYYY-MM-DD)"),
    date_to: Optional[date] = Query(None, description="盘点日期终点 (YYYY-MM-DD)"),
    writeback_todo: Optional[bool] = Query(None, description="仅看 K3 待回写(已完结且存在 pending/failed 回写记录)"),
    sort_by: Optional[str] = Query(None, description="排序字段:check_no/order_no/check_date/total_materials/checked_materials/total_diff_qty/created_at/updated_at"),
    sort_order: Optional[str] = Query(None, description="asc/desc,默认 desc"),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    statuses = [s.strip() for s in (status or "").split(",") if s.strip()] or None
    rows = await list_recent_stock_checks(
        db,
        page=page,
        page_size=page_size,
        keyword=keyword,
        status=statuses,
        check_type=check_type,
        source=source,
        date_from=date_from,
        date_to=date_to,
        sort_by=sort_by,
        sort_order=sort_order,
        writeback_todo=bool(writeback_todo),
    )
    await attach_list_extras(db, rows)
    filter_query = select(StockCheck)
    if keyword:
        like = f"%{keyword}%"
        filter_query = filter_query.where(or_(
            StockCheck.check_no.ilike(like),
            StockCheck.order_no.ilike(like),
            StockCheck.title.ilike(like),
        ))
    if statuses:
        filter_query = filter_query.where(StockCheck.status.in_(statuses))
    if check_type:
        filter_query = filter_query.where(StockCheck.check_type == check_type)
    if source:
        filter_query = filter_query.where(StockCheck.source == source)
    if date_from:
        filter_query = filter_query.where(StockCheck.check_date >= date_from)
    if date_to:
        filter_query = filter_query.where(StockCheck.check_date <= date_to)
    if writeback_todo:
        filter_query = filter_query.where(*writeback_todo_criterion())
    total = (await db.execute(
        select(func.count()).select_from(filter_query.subquery())
    )).scalar() or 0
    return ResponseModel(data=PageResult(
        total=int(total),
        page=page,
        page_size=page_size,
        items=[StockCheckListOut.model_validate(r) for r in rows],
    ))


@router.get("/stock-check/by-order/{order_no}", response_model=ResponseModel[List[StockCheckListOut]])
async def list_by_order(
    order_no: str,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    rows = await list_stock_checks_by_order(db, order_no)
    return ResponseModel(data=[StockCheckListOut.model_validate(r) for r in rows])


@router.get("/stock-check/co-checker-candidates", response_model=ResponseModel[list])
async def co_checker_candidates(
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    return ResponseModel(data=await list_co_checker_candidates(db))


@router.get("/stock-check/my-items", response_model=ResponseModel[PageResult[StockCheckMyItemOut]])
async def list_my_items(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索物料编码/名称/盘点单号"),
    wh_id: Optional[str] = Query(None, description="仓库ID(int)或名称(string)"),
    date_from: Optional[date] = Query(None, description="盘点日期起点 (YYYY-MM-DD)"),
    date_to: Optional[date] = Query(None, description="盘点日期终点 (YYYY-MM-DD)"),
    check_no: Optional[str] = Query(None, description="盘点单号模糊匹配"),
    check_type: Optional[str] = Query(None, description="盘点类型:order/manual/quick"),
    status: Optional[str] = Query(None, description="状态筛选,逗号分隔(open/in_progress/completed)"),
    order_no: Optional[str] = Query(None, description="订单号模糊匹配"),
    material_code: Optional[str] = Query(None, description="物料编码模糊匹配"),
    material_name: Optional[str] = Query(None, description="物料名称模糊匹配"),
    spec_model: Optional[str] = Query(None, description="规格型号模糊匹配"),
    sort_by: Optional[str] = Query(None, description="排序字段:counted_at/check_no/order_no/check_date/material_code/material_name/spec_model/wh_name/system_qty/actual_qty/diff_qty/status"),
    sort_order: Optional[str] = Query(None, description="排序方向:asc/desc"),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """个人盘点台账：按当前登录用户(JWT)汇总其录入的盘点行。
    user_id 取自 JWT，不接受客户端参数；无稳定 ID 返回 401。"""
    user_id = _current_user_id(current_user)
    if user_id is None:
        raise HTTPException(status_code=401, detail="无法识别当前用户身份")
    statuses = [s.strip() for s in (status or "").split(",") if s.strip()] or None
    total, items = await list_my_stock_check_items(
        db,
        user_id=user_id,
        page=page,
        page_size=page_size,
        keyword=keyword,
        wh_id=wh_id,
        date_from=date_from,
        date_to=date_to,
        check_no=check_no,
        check_type=check_type,
        status=statuses,
        order_no=order_no,
        material_code=material_code,
        material_name=material_name,
        spec_model=spec_model,
        sort_by=sort_by,
        sort_order=sort_order,
    )
    return ResponseModel(data=PageResult(
        total=total,
        page=page,
        page_size=page_size,
        items=[StockCheckMyItemOut(**it) for it in items],
    ))


@router.get("/stock-check/stats", response_model=ResponseModel[StockCheckStats])
async def stock_check_stats(
    check_type: Optional[str] = Query(None, description="盘点类型:order/manual/quick"),
    date_from: Optional[date] = Query(None, description="盘点日期起点 (YYYY-MM-DD)"),
    date_to: Optional[date] = Query(None, description="盘点日期终点 (YYYY-MM-DD)"),
    status: Optional[str] = Query(None, description="状态筛选,逗号分隔(open/in_progress/completed);cancelled 始终排除"),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """盘盈盘亏统计（仅已盘点行 is_checked=1，排除已取消单）。"""
    statuses = [s.strip() for s in (status or "").split(",") if s.strip()] or None
    data = await get_stock_check_stats(
        db,
        check_type=check_type,
        date_from=date_from,
        date_to=date_to,
        status=statuses,
    )
    return ResponseModel(data=StockCheckStats(**data))


@router.get("/stock-check/kpi", response_model=ResponseModel[StockCheckKpi])
async def stock_check_kpi(
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """盘点台账页 KPI 行(全局汇总,不带筛选)。"""
    return ResponseModel(data=StockCheckKpi(**await get_stock_check_kpi(db)))


@router.get("/stock-check/{check_id}", response_model=ResponseModel[StockCheckOut])
async def get_detail(
    check_id: int,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    head = await get_stock_check_with_items(db, check_id)
    if not head:
        raise HTTPException(status_code=404, detail="盘点单不存在")
    return ResponseModel(data=await _to_check_out(db, head, current_user))


@router.get("/stock-check/{check_id}/events")
async def stream_check_events(
    check_id: int,
    request: Request,
    token: str = Query(..., description="JWT token (EventSource 无法设 header)"),
):
    """共同盘点 SSE 实时同步流。

    客户端用 EventSource 连接,首帧 snapshot,后续 item_updated/status_changed/
    co_checkers_changed/bom_refreshed/warehouses_refreshed。每 15s 发心跳注释行。
    鉴权/快照用短命会话,不挂 Depends(get_db):流可活几小时,不能占住池连接。
    """
    async with AsyncSessionLocal() as db:
        current_user = await get_current_user(token=token, db=db)
        head = await get_stock_check_with_items(db, check_id)
        if not head:
            raise HTTPException(status_code=404, detail="盘点单不存在")
        if not _user_can_view(head, current_user):
            raise HTTPException(status_code=403, detail="无查看权限")

    async def gen():
        try:
            async for chunk in subscribe_stream(check_id, current_user):
                if await request.is_disconnected():
                    break
                yield chunk
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/stock-check/{check_id}/presence", response_model=ResponseModel[dict])
async def update_presence(
    check_id: int,
    body: PresenceUpdate,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    """协作存在感:声明当前用户正在编辑 item_id(None=离开)。无 DB 写,仅 Redis + 广播。"""
    head = await get_stock_check_with_items(db, check_id)
    if not head:
        raise HTTPException(status_code=404, detail="盘点单不存在")
    if not _user_can_view(head, current_user):
        raise HTTPException(status_code=403, detail="无查看权限")
    uid = _current_user_id(current_user)
    name = current_user.get("username", "")
    if uid is None:
        raise HTTPException(status_code=400, detail="无法识别当前用户")
    if body.item_id is not None:
        await set_presence(check_id, uid, name, body.item_id)
    else:
        await clear_presence(check_id, uid, name)
    return ResponseModel(data={"ok": True})


@router.get("/stock-check/{check_id}/items", response_model=ResponseModel[PageResult[StockCheckItemOut]])
async def list_items(
    check_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    base = select(StockCheckItem).where(StockCheckItem.check_id == check_id).order_by(StockCheckItem.id)
    total = (await db.execute(
        select(func.count(StockCheckItem.id)).where(StockCheckItem.check_id == check_id)
    )).scalar_one()
    rows = (await db.execute(base.offset((page - 1) * page_size).limit(page_size))).scalars().all()
    await enrich_items_assoc(db, list(rows))
    return ResponseModel(data=PageResult(
        total=int(total or 0),
        page=page,
        page_size=page_size,
        items=[StockCheckItemOut.model_validate(r) for r in rows],
    ))


@router.put("/stock-check/items/{item_id}", response_model=ResponseModel[StockCheckItemOut])
async def update_item(
    item_id: int,
    body: StockCheckItemUpdate,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    actual_qty_provided = "actual_qty" in body.model_fields_set
    try:
        await update_stock_check_item(
            db,
            item_id,
            actual_qty=body.actual_qty,
            actual_qty_provided=actual_qty_provided,
            is_checked=body.is_checked,
            remark=body.remark,
            force_recount=body.force_recount,
            expected_version=body.expected_version,
            current_user=current_user,
        )
    except StockCheckPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except StockCheckConflictError as e:
        raise HTTPException(
            status_code=409,
            detail={
                "code": 409,
                "message": "该行已被他人修改,请基于最新值重试",
                "data": StockCheckConflictOut(
                    resource=e.resource,
                    item_id=e.server_snapshot.get("id") if e.resource == "item" else None,
                    check_id=e.server_snapshot.get("check_id") if e.resource == "head" else None,
                    server_version=e.server_version,
                    server_item=e.server_snapshot if e.resource == "item" else None,
                ).model_dump(),
            },
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    item = (await db.execute(select(StockCheckItem).where(StockCheckItem.id == item_id))).scalar_one()
    await enrich_items_assoc(db, [item])
    await enrich_live_qty(db, [item])
    return ResponseModel(data=StockCheckItemOut.model_validate(item))


@router.post("/stock-check/items/batch", response_model=ResponseModel[dict])
async def batch_update(
    body: StockCheckItemBatchUpdate,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    try:
        n = await batch_update_items(
            db,
            body.check_id,
            [it.model_dump(exclude_unset=True) for it in body.items],
            current_user,
        )
    except StockCheckPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ResponseModel(data={"updated": n})


@router.post("/stock-check/{check_id}/complete", response_model=ResponseModel[StockCheckOut])
async def complete(
    check_id: int,
    body: StockCheckActionBody = StockCheckActionBody(),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    try:
        head = await complete_stock_check(
            db, check_id, current_user, expected_version=body.expected_version,
        )
        writebacks = await plan_writebacks(db, head)
    except StockCheckPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except StockCheckConflictError as e:
        raise HTTPException(
            status_code=409,
            detail={
                "code": 409,
                "message": "盘点单刚被他人修改,请刷新后重试",
                "data": {"resource": e.resource, "server_version": e.server_version},
            },
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # 完结+回写计划先落库;K3 写入改为手动触发(工作台「K3 回写」卡片),完结请求不触 K3
    await db.commit()
    summary = {"total": len(writebacks), "success": 0, "failed": 0, "pending": len(writebacks)}
    head_out = await get_stock_check_with_items(db, check_id)
    out = await _to_check_out(db, head_out, current_user)
    out.writeback_summary = summary
    return ResponseModel(data=out)


@router.post("/stock-check/{check_id}/cancel", response_model=ResponseModel[StockCheckOut])
async def cancel(
    check_id: int,
    body: StockCheckActionBody = StockCheckActionBody(),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    try:
        head = await cancel_stock_check(
            db, check_id, current_user, expected_version=body.expected_version,
        )
    except StockCheckPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except StockCheckConflictError as e:
        raise HTTPException(
            status_code=409,
            detail={
                "code": 409,
                "message": "盘点单刚被他人修改,请刷新后重试",
                "data": {"resource": e.resource, "server_version": e.server_version},
            },
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    head_out = await get_stock_check_with_items(db, check_id)
    await db.refresh(head_out)
    return ResponseModel(data=await _to_check_out(db, head_out, current_user))


@router.get("/stock-check/{check_id}/writebacks", response_model=ResponseModel[WritebackOverviewOut])
async def get_writebacks(
    check_id: int,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """盘点单 K3 回写记录总览(含无仓库被跳过的盘差行清单)"""
    head = await db.get(StockCheck, check_id)
    if not head:
        raise HTTPException(status_code=404, detail="盘点单不存在")
    overview = await get_writeback_overview(db, check_id)
    return ResponseModel(data=WritebackOverviewOut.model_validate(overview))


@router.post("/stock-check/{check_id}/writebacks/retry", response_model=ResponseModel[WritebackOverviewOut])
async def retry_writebacks(
    check_id: int,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    """重试 pending/failed 的 K3 回写(success 不重复生成)"""
    head = await db.get(StockCheck, check_id)
    if not head:
        raise HTTPException(status_code=404, detail="盘点单不存在")
    if head.status != "completed":
        raise HTTPException(status_code=400, detail="仅已完结的盘点单可重试 K3 回写")
    try:
        await execute_pending_writebacks(db, check_id, current_user)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    overview = await get_writeback_overview(db, check_id)
    return ResponseModel(data=WritebackOverviewOut.model_validate(overview))


@router.put("/stock-check/{check_id}/co-checkers", response_model=ResponseModel[StockCheckOut])
async def update_co_checkers(
    check_id: int,
    body: CoCheckersUpdate,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    try:
        head = await set_co_checkers(
            db, check_id, body.co_checker_user_ids, current_user,
            expected_version=body.expected_version,
        )
    except StockCheckPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except StockCheckConflictError as e:
        raise HTTPException(
            status_code=409,
            detail={
                "code": 409,
                "message": "盘点单刚被他人修改,请刷新后重试",
                "data": {"resource": e.resource, "server_version": e.server_version},
            },
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    head_out = await get_stock_check_with_items(db, check_id)
    await db.refresh(head_out)
    return ResponseModel(data=await _to_check_out(db, head_out, current_user))


@router.post("/stock-check/quick-count", response_model=ResponseModel[dict])
async def quick_count(
    body: QuickCountIn,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    """快捷盘点: 搜索物料直接录入实盘数,自动写入当前用户当日的「快捷盘点」单。"""
    try:
        head, item = await quick_count_material(
            db,
            current_user,
            material_id=body.material_id,
            wh_id=body.wh_id,
            actual_qty=body.actual_qty,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ResponseModel(data={
        "check_id": head.id,
        "check_no": head.check_no,
        "item": {
            "id": item.id,
            "material_code": item.material_code,
            "material_name": item.material_name,
            "wh_name": item.wh_name,
            "system_qty": float(item.system_qty or 0),
            "actual_qty": float(item.actual_qty or 0),
            "diff_qty": float(item.diff_qty or 0),
        },
    })


@router.get("/stock-check/quick-count/today", response_model=ResponseModel[dict])
async def quick_count_today(
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """当前用户当日快捷盘点单(含明细);无则 data 为 null。"""
    found = await get_today_quick_check(db, current_user)
    if found is None:
        return ResponseModel(data=None)
    head, items = found
    return ResponseModel(data={
        "check_id": head.id,
        "check_no": head.check_no,
        "title": head.title,
        "items": [
            {
                "id": it.id,
                "material_id": it.material_id,
                "material_code": it.material_code,
                "material_name": it.material_name,
                "spec_model": it.spec_model,
                "unit": it.unit,
                "wh_id": it.wh_id,
                "wh_name": it.wh_name,
                "system_qty": float(it.system_qty or 0),
                "actual_qty": float(it.actual_qty) if it.actual_qty is not None else None,
                "diff_qty": float(it.diff_qty or 0),
                "counted_by": it.counted_by,
                "counted_at": it.counted_at.isoformat() if it.counted_at else None,
            }
            for it in items
        ],
    })


@router.delete("/stock-check/quick-count/items/{item_id}", response_model=ResponseModel[dict])
async def quick_count_remove_item(
    item_id: int,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    """快捷盘点: 移除当日快捷盘点单中的一条已录入明细(仅限本人进行中的快捷单)。"""
    try:
        head = await remove_quick_count_item(db, item_id, current_user)
    except StockCheckPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ResponseModel(data={"removed": True, "check_id": head.id})


@router.get("/stock-check/quick-count/import-template")
async def quick_count_import_template(
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
):
    """快捷盘点 Excel 导入模板下载。"""
    from urllib.parse import quote

    from fastapi.responses import Response

    from app.services.material.stock_check_excel_import import build_import_template

    content = build_import_template()
    filename = quote("快捷盘点导入模板.xlsx")
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


@router.post("/stock-check/quick-count/import-preview", response_model=ResponseModel[dict])
async def quick_count_import_preview(
    file: UploadFile = File(...),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
):
    """快捷盘点: Excel 导入前预览 — 只解析文件,返回各盘点日期的行数分布,
    前端据此渲染日期勾选。不做任何 DB 校验/写入。"""
    from fastapi.responses import JSONResponse

    from app.services.material.stock_check_excel_import import (
        summarize_dates,
        parse_quick_import_excel,
    )

    try:
        rows = parse_quick_import_excel(await file.read())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not rows:
        raise HTTPException(status_code=400, detail="文件中没有数据行")
    return ResponseModel(data={"total": len(rows), "dates": summarize_dates(rows)})


@router.post("/stock-check/quick-count/import", response_model=ResponseModel[dict])
async def quick_count_import(
    file: UploadFile = File(...),
    dates: str = Form("", description="逗号分隔 ISO 日期;留空=只导今日"),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    """快捷盘点: Excel 批量导入到当前用户当日快捷单(全部成功或全部回滚)。

    dates: 逗号分隔的 ISO 日期列表(导入预览中勾选的日期);
    留空=只导入今日(含未填日期行)。所选日期的数据均并入今日单。
    校验失败返回 HTTP 200 + code=1 + data.errors(行级错误,全部给出);
    前端请求带 skipErrorToast,由弹窗渲染错误列表。
    """
    from datetime import date as _date

    from fastapi.responses import JSONResponse

    from app.services.material.stock_check_excel_import import (
        ExcelImportValidationError,
        import_quick_count_excel,
    )

    selected_dates = None
    if dates and dates.strip():
        selected_dates = []
        for token in dates.split(","):
            token = token.strip()
            if not token:
                continue
            try:
                selected_dates.append(_date.fromisoformat(token))
            except ValueError:
                raise HTTPException(status_code=400, detail=f"日期参数无效: {token}")

    try:
        result = await import_quick_count_excel(db, current_user, file, selected_dates)
    except ExcelImportValidationError as e:
        return JSONResponse(status_code=200, content={
            "code": 1,
            "message": f"导入失败,共 {len(e.errors)} 处错误,未导入任何数据",
            "data": {"errors": e.errors},
        })
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ResponseModel(data=result)


@router.post("/stock-check/{check_id}/items", response_model=ResponseModel[dict])
async def add_items(
    check_id: int,
    body: StockCheckFromMaterialsCreate,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    """为进行中的手动盘点单追加物料明细(仅 check_type=manual、open/in_progress)。
    recent_days: 省略=不标记近期已盘;>=0=窗口天数;-1=不限。"""
    try:
        rows = await add_items_to_check(
            db,
            check_id,
            material_ids=body.material_ids,
            items=[(it.material_id, it.wh_id) for it in body.items] if body.items else None,
            current_user=current_user,
            recent_days=body.recent_days,
        )
    except StockCheckPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ResponseModel(data={"added": len(rows)})


@router.delete("/stock-check/items/{item_id}", response_model=ResponseModel[dict])
async def remove_item(
    item_id: int,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    """从进行中的手动/订单盘点单移除一条未盘明细。已录入数据的行禁删。"""
    try:
        head = await remove_item_from_check(db, item_id, current_user)
    except StockCheckPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ResponseModel(data={"removed": True, "check_id": head.id})


async def _export_check_file(
    db: AsyncSession,
    check_id: int,
    fmt: str,
    selected_keys: List[str],
    item_ids: Optional[List[int]] = None,
) -> StreamingResponse:
    """盘点单明细导出公共实现。item_ids 非空时只导出这些行(前端客户端筛选后的可见行)。"""
    head = await get_stock_check_with_items(db, check_id)
    if not head:
        raise HTTPException(status_code=404, detail="盘点单不存在")

    allowed = {c.key for c in STOCK_CHECK_EXPORT_COLUMNS}
    invalid = [k for k in selected_keys if k not in allowed]
    if invalid:
        raise HTTPException(status_code=400, detail=f"无效导出字段: {', '.join(invalid)}")
    selected_columns = [c for c in STOCK_CHECK_EXPORT_COLUMNS if not selected_keys or c.key in selected_keys]
    if not selected_columns:
        raise HTTPException(status_code=400, detail="请选择至少一个有效导出字段")

    export_items = head.items
    if item_ids is not None:
        id_set = {int(i) for i in item_ids}
        export_items = [it for it in head.items if it.id in id_set]
        if not export_items:
            raise HTTPException(status_code=400, detail="所选明细行不存在或已被移除")

    export_rows = []
    for it in export_items:
        snap_time = it.system_qty_time or head.created_at
        export_rows.append({
            "material_code": it.material_code or "",
            "material_name": it.material_name or "",
            "spec_model": it.spec_model or "",
            "material_type": it.material_type or "",
            "material_property_label": it.material_property_label or "",
            "unit": it.unit or "",
            "system_qty": it.system_qty if it.system_qty is not None else "",
            "system_qty_time": snap_time.strftime("%Y-%m-%d %H:%M") if snap_time else "",
            "live_qty": it.live_qty if it.live_qty is not None else "",
            "wh_name": it.wh_name or "",
            "req_qty": it.req_qty if it.req_qty is not None else "",
            "actual_qty": it.actual_qty if it.actual_qty is not None else "",
            "diff_qty": it.diff_qty if it.diff_qty is not None else "",
            # 已盘口径与头表汇总一致: is_checked=1 或 近期已盘免盘行(recent 标记未撤销)
            "is_checked": "是" if (it.is_checked == 1 or it.recent_checked_check_no) else "否",
            "checked_by": it.checked_by or "",
            "checked_at": it.checked_at.strftime("%Y-%m-%d %H:%M") if it.checked_at else "",
            "remark": it.remark or "",
        })

    svc = GenericExportService(selected_columns, export_rows, sheet_name="物料盘点明细")
    if fmt == "csv":
        output = svc.to_csv()
        return StreamingResponse(
            output,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename=stock_check_{check_id}.csv"},
        )
    output = svc.to_xlsx()
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=stock_check_{check_id}.xlsx"},
    )


@router.get("/stock-check/{check_id}/export")
async def export_stock_check(
    check_id: int,
    format: str = Query("xlsx", pattern="^(xlsx|csv)$"),
    columns: Optional[str] = Query(None, description="逗号分隔的导出字段 key,省略=全部"),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """导出单个盘点单的全部明细(支持 xlsx/csv 与字段选择)。"""
    selected_keys = [c.strip() for c in columns.split(",") if c.strip()] if columns else []
    return await _export_check_file(db, check_id, format, selected_keys)


@router.post("/stock-check/{check_id}/export")
async def export_stock_check_filtered(
    check_id: int,
    body: StockCheckExportBody,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """导出单个盘点单的明细(POST 版): 页面筛选为客户端筛选,传 item_ids 只导出当前可见行。"""
    if body.format not in ("xlsx", "csv"):
        raise HTTPException(status_code=400, detail="format 仅支持 xlsx/csv")
    selected_keys = [c.strip() for c in (body.columns or []) if c.strip()]
    return await _export_check_file(db, check_id, body.format, selected_keys, item_ids=body.item_ids)


@router.post("/stock-check/{check_id}/refresh-warehouses", response_model=ResponseModel[dict])
async def refresh_warehouses(
    check_id: int,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    """将"(未入库)"明细行按当前库存更新/拆分为具体仓库行（订单/手动盘点单均可用，仅 open/in_progress）。

    仅处理未录入数据的"(未入库)"行；已录入数据的行不动。
    返回统计 {pending, updated, split, inserted, no_stock, skipped_existing, guard_skip}。
    权限不足或状态不允许时返回 403/400。"""
    try:
        stats = await refresh_check_warehouses(db, check_id, current_user)
    except StockCheckPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ResponseModel(data=stats)


@router.post("/stock-check/{check_id}/refresh-bom", response_model=ResponseModel[StockCheckOut])
async def refresh_bom(
    check_id: int,
    recent_days: Optional[int] = Query(None, ge=-1, le=3650, description="近 N 天内已盘视为近期已盘(免盘);-1=不限(全部历史);省略=服务端配置默认"),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    """补入订单盘点单缺失的子BOM物料（仅订单类、仅 open/in_progress）。
    已有明细及已录入数据保留；权限不足或状态不允许时返回 403/400。"""
    try:
        await refresh_order_bom(db, check_id, current_user, recent_days=recent_days)
    except StockCheckPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    head = await get_stock_check_with_items(db, check_id)
    await db.refresh(head)
    return ResponseModel(data=await _to_check_out(db, head, current_user))


@router.get("/stock-check/k3/bills", response_model=ResponseModel)
async def list_k3_bills(
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    tran_type: str = Query("all", pattern="^(all|40|41)$"),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """K3 盘盈单(40)/盘亏调拨单(41,调入库存检查不良仓)预览(已审核未作废),带本系统已导入标记"""
    try:
        bills = await list_k3_gain_loss_bills(
            db, date_from=date_from, date_to=date_to, tran_type=tran_type
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return ResponseModel(data=[K3BillOut.model_validate(b).model_dump() for b in bills])


@router.post("/stock-check/k3/import", response_model=ResponseModel[K3ImportResultOut])
async def import_k3_bills(
    body: K3ImportRequest,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    """将勾选的 K3 盘盈盘亏单导入为已完结盘点单(一张 K3 单 -> 一张盘点单)"""
    if not body.bill_nos:
        raise HTTPException(status_code=400, detail="请至少选择一张 K3 单据")
    if len(body.bill_nos) > 50:
        raise HTTPException(status_code=400, detail="一次最多导入 50 张单据")
    try:
        result = await import_k3_bills_as_stock_checks(db, list(dict.fromkeys(body.bill_nos)), current_user)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return ResponseModel(data=result)

