"""调价单模块 - API 路由"""

import csv
import io
import json
from datetime import date as date_type, datetime
from fastapi import APIRouter, Depends, Query, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker, oauth2_scheme, decode_access_token
from app.schemas.common import ResponseModel
from app.services.purchase.price_change_service import PriceChangeService


async def get_current_username(token: str = Depends(oauth2_scheme)) -> str:
    payload = decode_access_token(token)
    return payload.get("sub", "anonymous")


async def get_current_user_payload(token: str = Depends(oauth2_scheme), db: AsyncSession = Depends(get_db)) -> dict:
    """从 JWT 取完整 payload（含 username / role），供审批端点做角色校验。
    JWT sub 存的是 user_id，这里查库换成真正的 username，日志和比对更直观。
    """
    payload = decode_access_token(token)
    sub = payload.get("sub", "anonymous")
    username = sub
    try:
        row = await db.execute(text("SELECT username FROM sys_user WHERE id=:i"), {"i": int(sub)})
        r = row.fetchone()
        if r and r[0]:
            username = r[0]
    except Exception:
        pass
    return {
        "username": username,
        "role": payload.get("role", ""),
    }

router = APIRouter()


@router.get("", response_model=ResponseModel)
async def list_price_changes(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str = Query(""),
    status: str = Query(""),
    date_start: str = Query(""),
    date_end: str = Query(""),
    applicant: str = Query(""),
    username: str = Depends(get_current_username),
    _: dict = Depends(PermissionChecker("purchase.price_change", "read")),
    db: AsyncSession = Depends(get_db),
):
    service = PriceChangeService(db)
    items, total = await service.list_price_changes(
        page=page, page_size=page_size,
        keyword=keyword or None, status=status or None,
        date_start=date_start or None, date_end=date_end or None,
        applicant=applicant or None,
    )
    return ResponseModel(data={"total": total, "page": page, "page_size": page_size, "items": items})


@router.get("/pending", response_model=ResponseModel)
async def list_pending_approvals(
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("purchase.price_change.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    service = PriceChangeService(db)
    items = await service.pending_approvals(
        approver_username=user["username"],
        approver_role=user["role"],
    )
    return ResponseModel(data=items)


@router.get("/my-approved", response_model=ResponseModel)
async def list_my_approved(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("purchase.price_change.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    """我已审批列表"""
    service = PriceChangeService(db)
    items, total = await service.my_approved(
        user["username"],
        approver_role=user["role"],
        page=page, page_size=page_size,
    )
    return ResponseModel(data={"total": total, "page": page, "page_size": page_size, "items": items})


# ---------- 通用审批配置（支持多 biz_type）----------
@router.get("/approval-configs", response_model=ResponseModel)
async def list_approval_configs(
    username: str = Depends(get_current_username),
    _: dict = Depends(PermissionChecker("purchase.price_change.config", "read")),
    db: AsyncSession = Depends(get_db),
):
    rows = await db.execute(
        text("SELECT biz_type, biz_name, nodes, is_active, updated_by, updated_at FROM approval_config ORDER BY biz_type")
    )
    items = []
    for r in rows:
        d = dict(r._mapping)
        if isinstance(d.get("nodes"), str):
            d["nodes"] = json.loads(d.get("nodes") or "[]")
        if isinstance(d.get("updated_at"), datetime):
            d["updated_at"] = d["updated_at"].isoformat()
        items.append(d)
    return ResponseModel(data={"items": items})


@router.get("/approval-configs/{biz_type}", response_model=ResponseModel)
async def get_approval_config(
    biz_type: str,
    username: str = Depends(get_current_username),
    _: dict = Depends(PermissionChecker("purchase.price_change.config", "read")),
    db: AsyncSession = Depends(get_db),
):
    row = await db.execute(
        text("SELECT biz_type, biz_name, nodes, is_active, updated_by, updated_at FROM approval_config WHERE biz_type=:bt LIMIT 1"),
        {"bt": biz_type},
    )
    r = row.fetchone()
    if not r:
        return ResponseModel(data={"biz_type": biz_type, "nodes": []})
    d = dict(r._mapping)
    if isinstance(d.get("nodes"), str):
        d["nodes"] = json.loads(d.get("nodes") or "[]")
    if isinstance(d.get("updated_at"), datetime):
        d["updated_at"] = d["updated_at"].isoformat()
    return ResponseModel(data=d)


@router.put("/approval-configs/{biz_type}", response_model=ResponseModel)
async def save_approval_config(
    biz_type: str,
    data: dict,
    username: str = Depends(get_current_username),
    _: dict = Depends(PermissionChecker("purchase.price_change.config", "update")),
    db: AsyncSession = Depends(get_db),
):
    nodes = data.get("nodes", [])
    biz_name = data.get("biz_name", "")
    is_active = data.get("is_active", True)
    row = await db.execute(
        text("SELECT id FROM approval_config WHERE biz_type=:bt LIMIT 1"), {"bt": biz_type}
    )
    existing = row.fetchone()
    if existing:
        await db.execute(
            text("UPDATE approval_config SET biz_name=:bn, nodes=:nodes, is_active=:ia, updated_by=:ub, updated_at=NOW() WHERE biz_type=:bt"),
            {"bn": biz_name, "nodes": json.dumps(nodes), "ia": is_active, "ub": username, "bt": biz_type},
        )
    else:
        await db.execute(
            text("INSERT INTO approval_config (biz_type, biz_name, nodes, is_active, updated_by) VALUES (:bt, :bn, :nodes, :ia, :ub)"),
            {"bt": biz_type, "bn": biz_name, "nodes": json.dumps(nodes), "ia": is_active, "ub": username},
        )
    await db.commit()
    return ResponseModel(data={"biz_type": biz_type, "nodes": nodes}, message="保存成功")


@router.delete("/approval-configs/{biz_type}", response_model=ResponseModel)
async def delete_approval_config(
    biz_type: str,
    username: str = Depends(get_current_username),
    _: dict = Depends(PermissionChecker("purchase.price_change.config", "delete")),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(text("DELETE FROM approval_config WHERE biz_type=:bt"), {"bt": biz_type})
    await db.commit()
    return ResponseModel(data={"biz_type": biz_type}, message="已删除")


# ===== 静态路由（必须在 /{change_id} 前面）=====

@router.get("/supplier-last-price", response_model=ResponseModel)
async def get_supplier_last_price(
    material_code: str = Query(""),
    supplier_code: str = Query(""),
    username: str = Depends(get_current_username),
    _: dict = Depends(PermissionChecker("purchase.price_change", "read")),
    db: AsyncSession = Depends(get_db),
):
    if not material_code:
        return ResponseModel(data=None)
    from sqlalchemy import text
    result = await db.execute(text("SELECT price, order_date FROM purchase_order WHERE material_code=:mat AND supplier_code=:sup ORDER BY order_date DESC LIMIT 1"), {"mat": material_code, "sup": supplier_code or ""})
    row = result.fetchone()
    if row:
        return ResponseModel(data={"old_price": float(row[0]), "old_price_date": str(row[1])})


@router.get("/material-price-history", response_model=ResponseModel)
async def get_material_price_history(
    material_code: str = Query(""),
    username: str = Depends(get_current_username),
    _: dict = Depends(PermissionChecker("purchase.price_change", "read")),
    db: AsyncSession = Depends(get_db),
):
    """查询所有供应商对该物料的历史报价"""
    if not material_code:
        return ResponseModel(data={"prices": []})
    from sqlalchemy import text
    rows = await db.execute(
        text("""SELECT DISTINCT ON (pc.supplier_name)
                pc.supplier_name, pci.new_price, pci.old_price, pc.change_date, pc.price_direction
            FROM purchase_price_change_item pci
            JOIN purchase_price_change pc ON pc.id = pci.change_id
            WHERE pci.material_code = :mc AND pc.approval_status = 'approved'
            ORDER BY pc.supplier_name, pc.change_date DESC"""),
        {"mc": material_code},
    )
    prices = []
    for r in rows:
        prices.append({
            "supplier_name": r[0],
            "latest_price": float(r[1]) if r[1] else None,
            "previous_price": float(r[2]) if r[2] else None,
            "change_date": r[3].isoformat() if r[3] else None,
            "price_direction": r[4],
        })
    return ResponseModel(data={"material_code": material_code, "prices": prices})


@router.get("/erp-material-prices", response_model=ResponseModel)
async def get_erp_material_prices(
    material_code: str = Query(""),
    username: str = Depends(get_current_username),
):
    """直接从ERP查询所有供应商对该物料的价格"""
    if not material_code:
        return ResponseModel(data={"prices": []})
    try:
        from sqlalchemy import text, create_engine
        from app.core.config import get_settings
        settings = get_settings()
        if not settings.ERP_DB_URL:
            return ResponseModel(data={"prices": [], "error": "ERP未配置"})

        url = settings.ERP_DB_URL
        for param in ["TrustServerCertificate=yes", "Encrypt=no"]:
            if param.split("=")[0] not in url:
                url += f"&{param}" if "?" in url else f"?{param}"
        erp_engine = create_engine(url, connect_args={"login_timeout": 10, "timeout": 15})
        with erp_engine.connect() as conn:
            item_row = conn.execute(
                text("SELECT FItemID FROM k3sv.AIS20161019115614.dbo.t_ICItem WHERE FNumber = :mc AND FDeleted = 0"),
                {"mc": material_code},
            ).fetchone()
            if not item_row:
                erp_engine.dispose()
                return ResponseModel(data={"prices": [], "error": "ERP未找到该物料"})

            rows = conn.execute(text("""
                SELECT s.FNumber as supplier_code, s.FName as supplier_name,
                       se.FPrice as price,
                       se.FStartQty as qty_min, se.FEndQty as qty_max,
                       se.FQuoteTime as start_date, se.FDisableDate as end_date
                FROM k3sv.AIS20161019115614.dbo.t_Supplier s
                JOIN k3sv.AIS20161019115614.dbo.t_Supply sp ON sp.FSupID = s.FItemID
                JOIN k3sv.AIS20161019115614.dbo.t_SupplyEntry se ON se.FSupID = sp.FSupID AND se.FItemID = sp.FItemID
                WHERE sp.FItemID = :fid
                ORDER BY s.FName, se.FQuoteTime DESC
            """), {"fid": item_row[0]})
            prices = []
            for r in rows:
                prices.append({
                    "supplier_code": r[0],
                    "supplier_name": r[1],
                    "price": float(r[2]) if r[2] else None,
                    "qty_min": float(r[3]) if r[3] else None,
                    "qty_max": float(r[4]) if r[4] else None,
                    "start_date": str(r[5]) if r[5] else None,
                    "end_date": str(r[6]) if r[6] else None,
                })
        erp_engine.dispose()
        return ResponseModel(data={"material_code": material_code, "prices": prices})
    except Exception as e:
        return ResponseModel(data={"prices": [], "error": str(e)})


@router.get("/employees/search", response_model=ResponseModel)
async def search_employees(
    keyword: str = Query(""),
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    username: str = Depends(get_current_username),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import text
    if keyword:
        like = f"%{keyword}%"
        total_row = await db.execute(text("SELECT COUNT(*) FROM scm_employee WHERE (display_name ILIKE :kw OR emp_code ILIKE :kw OR username ILIKE :kw)"), {"kw": like})
        total = total_row.scalar() or 0
        rows = await db.execute(text("SELECT id, emp_code, display_name, username, position_name FROM scm_employee WHERE display_name ILIKE :kw OR emp_code ILIKE :kw OR username ILIKE :kw ORDER BY emp_code LIMIT :lim OFFSET :off"), {"kw": like, "lim": page_size, "off": (page - 1) * page_size})
    else:
        total_row = await db.execute(text("SELECT COUNT(*) FROM scm_employee"))
        total = total_row.scalar() or 0
        rows = await db.execute(text("SELECT id, emp_code, display_name, username, position_name FROM scm_employee ORDER BY emp_code LIMIT :lim OFFSET :off"), {"lim": page_size, "off": (page - 1) * page_size})
    items = [dict(r._mapping) for r in rows]
    return ResponseModel(data={"items": items, "total": total})


@router.get("/suppliers/search", response_model=ResponseModel)
async def search_suppliers(
    keyword: str = Query(""),
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    username: str = Depends(get_current_username),
    _: dict = Depends(PermissionChecker("purchase.price_change", "read")),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import text
    if keyword:
        like = f'%{keyword}%'
        total_row = await db.execute(text("SELECT COUNT(*) FROM scm_supplier WHERE status=1 AND (supplier_name ILIKE :kw OR supplier_code ILIKE :kw)"), {"kw": like})
        total = total_row.scalar() or 0
        rows = await db.execute(
            text("SELECT * FROM scm_supplier WHERE status=1 AND (supplier_name ILIKE :kw OR supplier_code ILIKE :kw) ORDER BY supplier_code LIMIT :lim OFFSET :off"),
            {"kw": like, "lim": page_size, "off": (page - 1) * page_size},
        )
    else:
        total_row = await db.execute(text("SELECT COUNT(*) FROM scm_supplier WHERE status=1"))
        total = total_row.scalar() or 0
        rows = await db.execute(
            text("SELECT * FROM scm_supplier WHERE status=1 ORDER BY supplier_code LIMIT :lim OFFSET :off"),
            {"lim": page_size, "off": (page - 1) * page_size},
        )
    items = [dict(r._mapping) for r in rows]
    return ResponseModel(data={"items": items, "total": total})


@router.get("/materials/search", response_model=ResponseModel)
async def search_materials(
    keyword: str = Query(""),
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    username: str = Depends(get_current_username),
):
    """从ERP视图查询物料（含采购报价）"""
    from sqlalchemy import text, create_engine
    from app.core.config import get_settings
    try:
        settings = get_settings()
        url = settings.ERP_DB_URL
        if not url:
            return ResponseModel(data={"items": [], "total": 0})
        for param in ["TrustServerCertificate=yes", "Encrypt=no"]:
            if param.split("=")[0] not in url:
                url += f"&{param}" if "?" in url else f"?{param}"
        erp_engine = create_engine(url, connect_args={"login_timeout": 10, "timeout": 15})

        with erp_engine.connect() as conn:
            base_sql = """SELECT rowid AS id, [物料代码] AS material_code, [物料名称] AS material_name,
                [规格型号] AS spec, [单位] AS unit, [采购报价] AS purchase_price, [供应商] AS supplier
                FROM k3sv.AIS20161019115614.dbo.h_v_K3_WGICItem"""
            count_sql = "SELECT COUNT(*) FROM k3sv.AIS20161019115614.dbo.h_v_K3_WGICItem"

            if keyword:
                like = f"%{keyword}%"
                where = " WHERE [物料代码] LIKE :kw OR [物料名称] LIKE :kw"
                total = conn.execute(text(count_sql + where), {"kw": like}).scalar() or 0
                rows = conn.execute(
                    text(base_sql + where + " ORDER BY material_code OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY"),
                    {"kw": like, "lim": page_size, "off": (page - 1) * page_size},
                )
            else:
                total = conn.execute(text(count_sql)).scalar() or 0
                rows = conn.execute(
                    text(base_sql + " ORDER BY material_code OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY"),
                    {"lim": page_size, "off": (page - 1) * page_size},
                )

            items = []
            for r in rows:
                items.append({
                    "id": r[0],
                    "material_code": r[1] or "",
                    "material_name": r[2] or "",
                    "spec": r[3] or "",
                    "unit": r[4] or "",
                    "purchase_price": float(r[5]) if r[5] else None,
                    "supplier": r[6] or "",
                })
        erp_engine.dispose()
        return ResponseModel(data={"items": items, "total": int(total)})
    except Exception as e:
        return ResponseModel(data={"items": [], "total": 0, "error": str(e)})


@router.get("/export", response_class=StreamingResponse)
async def export_price_changes(
    keyword: str = Query(""),
    status: str = Query(""),
    date_start: str = Query(""),
    date_end: str = Query(""),
    applicant: str = Query(""),
    username: str = Depends(get_current_username),
    db: AsyncSession = Depends(get_db),
):
    service = PriceChangeService(db)
    items = await service.export_list(
        keyword=keyword or None, status=status or None,
        date_start=date_start or None, date_end=date_end or None,
        applicant=applicant or None,
    )
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["调价单号", "标题", "供应商", "类型", "调价日期", "状态", "申请人", "创建时间", "付款方式", "结算方式", "税率", "备注"])
    for r in items:
        writer.writerow([
            r.get("change_no", ""), r.get("title", ""), r.get("supplier_name", ""),
            r.get("price_direction", ""), r.get("change_date", ""), r.get("approval_status", ""),
            r.get("applicant", ""), r.get("created_at", ""), r.get("payment_method", ""),
            r.get("settlement_method", ""), r.get("tax_rate", ""), r.get("remark", ""),
        ])
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": "attachment; filename=price_changes.csv"},
    )


# ===== 动态路由 =====

@router.get("/{change_id}", response_model=ResponseModel)
async def get_price_change(
    change_id: int,
    username: str = Depends(get_current_username),
    _: dict = Depends(PermissionChecker("purchase.price_change", "read")),
    db: AsyncSession = Depends(get_db),
):
    service = PriceChangeService(db)
    record = await service.get_price_change(change_id)
    if not record:
        raise HTTPException(status_code=404, detail="调价单不存在")
    return ResponseModel(data=record)


@router.post("", response_model=ResponseModel)
async def create_price_change(
    data: dict,
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("purchase.price_change", "create")),
    db: AsyncSession = Depends(get_db),
):
    service = PriceChangeService(db)
    submit = data.pop("submit", False)
    main_data = {k: v for k, v in data.items() if k not in ("items", "submit")}
    if main_data.get("change_date") and isinstance(main_data["change_date"], str):
        try:
            main_data["change_date"] = date_type.fromisoformat(main_data["change_date"][:10])
        except Exception:
            pass
    items_data = data.get("items", [])
    record = await service.create_price_change(main_data, items_data, submit=submit, applicant=user["username"])
    await db.commit()
    return ResponseModel(data=record, message="创建成功")


@router.put("/{change_id}", response_model=ResponseModel)
async def update_price_change(
    change_id: int,
    data: dict,
    username: str = Depends(get_current_username),
    _: dict = Depends(PermissionChecker("purchase.price_change", "update")),
    db: AsyncSession = Depends(get_db),
):
    service = PriceChangeService(db)
    main_data = {k: v for k, v in data.items() if k not in ("items", "submit")}
    if main_data.get("change_date") and isinstance(main_data["change_date"], str):
        try:
            main_data["change_date"] = date_type.fromisoformat(main_data["change_date"][:10])
        except Exception:
            pass
    items_data = data.get("items", [])
    record = await service.update_price_change(change_id, main_data, items_data)
    if not record:
        raise HTTPException(status_code=400, detail="仅草稿/已驳回/已撤回状态可编辑")
    await db.commit()
    return ResponseModel(data=record, message="更新成功")


@router.post("/{change_id}/submit", response_model=ResponseModel)
async def submit_for_approval(
    change_id: int,
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("purchase.price_change", "update")),
    db: AsyncSession = Depends(get_db),
):
    service = PriceChangeService(db)
    record = await service.submit_for_approval(change_id, applicant=user["username"])
    if not record:
        raise HTTPException(status_code=400, detail="仅草稿/已驳回/已撤回状态可提交")
    await db.commit()
    return ResponseModel(data=record, message="已提交审批")


@router.post("/{change_id}/ai-analyze", response_model=ResponseModel)
async def rerun_ai_analysis(
    change_id: int,
    username: str = Depends(get_current_username),
    _: dict = Depends(PermissionChecker("purchase.price_change", "update")),
    db: AsyncSession = Depends(get_db),
):
    service = PriceChangeService(db)
    record = await service.rerun_ai_analysis(change_id)
    if not record:
        raise HTTPException(status_code=404, detail="调价单不存在")
    await db.commit()
    return ResponseModel(data=record, message="AI 分析已刷新")


@router.post("/{change_id}/approve", response_model=ResponseModel)
async def approve_price_change(
    change_id: int,
    data: dict,
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("purchase.price_change.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    service = PriceChangeService(db)
    result = await service.approve(
        change_id,
        approver=user["username"],
        approver_role=user["role"],
        comment=data.get("comment", ""),
        expected_version=data.get("expected_version"),
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    await db.commit()
    extra = result.get("message_extra", "")
    if result["finished"]:
        msg = f"审批通过，已归档{extra}"
    else:
        msg = f"第{result['level']}级审批通过{extra}"
    return ResponseModel(message=msg)


@router.post("/{change_id}/reject", response_model=ResponseModel)
async def reject_price_change(
    change_id: int,
    data: dict,
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("purchase.price_change.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    service = PriceChangeService(db)
    result = await service.reject(
        change_id,
        approver=user["username"],
        approver_role=user["role"],
        comment=data.get("comment", ""),
        expected_version=data.get("expected_version"),
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    await db.commit()
    return ResponseModel(message="已驳回")


@router.post("/{change_id}/recall", response_model=ResponseModel)
async def recall_price_change(
    change_id: int,
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("purchase.price_change", "update")),
    db: AsyncSession = Depends(get_db),
):
    service = PriceChangeService(db)
    ok = await service.recall(change_id, applicant=user["username"])
    if not ok:
        raise HTTPException(status_code=400, detail="仅审批中状态可撤回")
    await db.commit()
    return ResponseModel(message="已撤回")


@router.post("/{change_id}/revoke-approval", response_model=ResponseModel)
async def revoke_approval(
    change_id: int,
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("purchase.price_change.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    """反审核：撤回自己刚做出的审批"""
    service = PriceChangeService(db)
    result = await service.revoke_approval(
        change_id,
        revoker=user["username"],
        revoker_role=user["role"],
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    await db.commit()
    return ResponseModel(message=f"已撤回审批，单子回退到第{result['rollback_level']}级")


@router.delete("/{change_id}", response_model=ResponseModel)
async def delete_price_change(
    change_id: int,
    username: str = Depends(get_current_username),
    _: dict = Depends(PermissionChecker("purchase.price_change", "delete")),
    db: AsyncSession = Depends(get_db),
):
    service = PriceChangeService(db)
    ok = await service.delete(change_id)
    if not ok:
        raise HTTPException(status_code=400, detail="仅草稿/已驳回/已撤回状态可删除")
    await db.commit()
    return ResponseModel(message="已删除")


