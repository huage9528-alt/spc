"""物料齐套中心 — 物料盘点 API (scm_inventory_check)"""

import json
from datetime import date
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select, desc, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
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
    PresenceUpdate,
    MaterialHistoryItem,
    MaterialCandidateOut,
    StockCheckCountedItemOut,
    StockCheckStats,
    StockCheckMyItemOut,
    StockCheckConflictOut,
    StockCheckActionBody,
)
from app.models.material.inventory_check import StockCheck, StockCheckItem
from app.services.material.stock_check_service import (
    create_stock_check_from_order,
    create_stock_check_from_materials,
    list_material_candidates,
    list_counted_materials_ledger,
    list_counted_warehouses,
    update_stock_check_item,
    batch_update_items,
    complete_stock_check,
    cancel_stock_check,
    set_co_checkers,
    refresh_order_bom,
    add_items_to_check,
    remove_item_from_check,
    get_stock_check_with_items,
    list_recent_stock_checks,
    list_stock_checks_by_order,
    get_material_history,
    list_co_checker_candidates,
    enrich_items_assoc,
    enrich_live_qty,
    get_stock_check_stats,
    list_my_stock_check_items,
    _user_can_edit,
    _current_user_id,
    _resolve_user_names,
    StockCheckPermissionError,
    StockCheckConflictError,
)
from app.services.material.stock_check_broker import subscribe_stream, set_presence, clear_presence

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


@router.get("/stock-check/counted-warehouses", response_model=ResponseModel[List[dict]])
async def list_counted_warehouses_view(
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """已盘点物料台账涉及的仓库列表（去重），用于仓库列下拉筛选。"""
    items = await list_counted_warehouses(db)
    return ResponseModel(data=items)


@router.get("/stock-check/counted-ledger", response_model=ResponseModel[PageResult[StockCheckCountedItemOut]])
async def list_counted_materials_view(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None, description="搜索物料编码/名称/规格"),
    wh_id: Optional[str] = Query(None, description="仓库ID(int)或名称(string)"),
    date_from: Optional[date] = Query(None, description="盘点日期起点 (YYYY-MM-DD)"),
    date_to: Optional[date] = Query(None, description="盘点日期终点 (YYYY-MM-DD)"),
    check_type: Optional[str] = Query(None, description="盘点类型:order/manual"),
    status: Optional[str] = Query(None, description="状态筛选,逗号分隔(open/in_progress/completed)"),
    check_no: Optional[str] = Query(None, description="盘点单号模糊匹配"),
    counted_by: Optional[str] = Query(None, description="盘点人模糊匹配"),
    material_code: Optional[str] = Query(None, description="物料编码模糊匹配"),
    material_name: Optional[str] = Query(None, description="物料名称模糊匹配"),
    spec_model: Optional[str] = Query(None, description="规格型号模糊匹配"),
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
    check_type: Optional[str] = Query(None, description="盘点类型:order/manual"),
    date_from: Optional[date] = Query(None, description="盘点日期起点 (YYYY-MM-DD)"),
    date_to: Optional[date] = Query(None, description="盘点日期终点 (YYYY-MM-DD)"),
    sort_by: Optional[str] = Query(None, description="排序字段:check_no/order_no/check_date/total_materials/checked_materials/total_diff_qty/created_at"),
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
        date_from=date_from,
        date_to=date_to,
        sort_by=sort_by,
        sort_order=sort_order,
    )
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
    if date_from:
        filter_query = filter_query.where(StockCheck.check_date >= date_from)
    if date_to:
        filter_query = filter_query.where(StockCheck.check_date <= date_to)
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
    check_type: Optional[str] = Query(None, description="盘点类型:order/manual"),
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
    check_type: Optional[str] = Query(None, description="盘点类型:order/manual"),
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
    db: AsyncSession = Depends(get_db),
):
    """共同盘点 SSE 实时同步流。

    客户端用 EventSource 连接,首帧 snapshot,后续 item_updated/status_changed/
    co_checkers_changed/bom_refreshed。每 15s 发心跳注释行。
    """
    current_user = await get_current_user(token=token, db=db)
    head = await get_stock_check_with_items(db, check_id)
    if not head:
        raise HTTPException(status_code=404, detail="盘点单不存在")
    if not _user_can_view(head, current_user):
        raise HTTPException(status_code=403, detail="无查看权限")

    async def gen():
        try:
            async for chunk in subscribe_stream(check_id, db, current_user):
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


@router.post("/stock-check/{check_id}/items", response_model=ResponseModel[dict])
async def add_items(
    check_id: int,
    body: StockCheckFromMaterialsCreate,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    """为进行中的手动盘点单追加物料明细(仅 check_type=manual、open/in_progress)。"""
    try:
        rows = await add_items_to_check(
            db,
            check_id,
            material_ids=body.material_ids,
            items=[(it.material_id, it.wh_id) for it in body.items] if body.items else None,
            current_user=current_user,
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
    """从进行中的手动盘点单移除一条明细。已录入数据的行禁删。"""
    try:
        head = await remove_item_from_check(db, item_id, current_user)
    except StockCheckPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ResponseModel(data={"removed": True, "check_id": head.id})


@router.get("/stock-check/{check_id}/export")
async def export_stock_check(
    check_id: int,
    format: str = Query("xlsx", pattern="^(xlsx|csv)$"),
    columns: Optional[str] = Query(None, description="逗号分隔的导出字段 key,省略=全部"),
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "read")),
    db: AsyncSession = Depends(get_db),
):
    """导出单个盘点单的明细(支持 xlsx/csv 与字段选择)。"""
    head = await get_stock_check_with_items(db, check_id)
    if not head:
        raise HTTPException(status_code=404, detail="盘点单不存在")

    selected_keys = [c.strip() for c in columns.split(",") if c.strip()] if columns else []
    allowed = {c.key for c in STOCK_CHECK_EXPORT_COLUMNS}
    invalid = [k for k in selected_keys if k not in allowed]
    if invalid:
        raise HTTPException(status_code=400, detail=f"无效导出字段: {', '.join(invalid)}")
    selected_columns = [c for c in STOCK_CHECK_EXPORT_COLUMNS if not selected_keys or c.key in selected_keys]
    if not selected_columns:
        raise HTTPException(status_code=400, detail="请选择至少一个有效导出字段")

    export_rows = []
    for it in head.items:
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
            "is_checked": "是" if it.is_checked == 1 else "否",
            "checked_by": it.checked_by or "",
            "checked_at": it.checked_at.strftime("%Y-%m-%d %H:%M") if it.checked_at else "",
            "remark": it.remark or "",
        })

    svc = GenericExportService(selected_columns, export_rows, sheet_name="物料盘点明细")
    if format == "csv":
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


@router.post("/stock-check/{check_id}/refresh-bom", response_model=ResponseModel[StockCheckOut])
async def refresh_bom(
    check_id: int,
    current_user: dict = Depends(PermissionChecker("materials.stock_check", "update")),
    db: AsyncSession = Depends(get_db),
):
    """补入订单盘点单缺失的子BOM物料（仅订单类、仅 open/in_progress）。
    已有明细及已录入数据保留；权限不足或状态不允许时返回 403/400。"""
    try:
        await refresh_order_bom(db, check_id, current_user)
    except StockCheckPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    head = await get_stock_check_with_items(db, check_id)
    await db.refresh(head)
    return ResponseModel(data=await _to_check_out(db, head, current_user))

