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
from app.core.security import oauth2_scheme, decode_access_token
from app.schemas.common import ResponseModel
from app.services.purchase.price_change_service import PriceChangeService

router = APIRouter()


async def get_current_username(token: str = Depends(oauth2_scheme)) -> str:
    payload = decode_access_token(token)
    return payload.get("sub", "anonymous")


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
async def list_pending_approvals(username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    service = PriceChangeService(db)
    items = await service.pending_approvals()
    return ResponseModel(data=items)


# ---------- 通用审批配置（支持多 biz_type）----------
@router.get("/approval-configs", response_model=ResponseModel)
async def list_approval_configs(username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    rows = await db.execute(
        text("SELECT biz_type, biz_name, nodes, is_active, updated_by, updated_at FROM approval_config ORDER BY biz_type")
    )
    items = []
    for r in rows:
        d = dict(r._mapping)
        if isinstance(d.get("nodes"), str):
            d["nodes"] = json.loads(d["nodes"] or "[]")
        if isinstance(d.get("updated_at"), datetime):
            d["updated_at"] = d["updated_at"].isoformat()
        items.append(d)
    return ResponseModel(data={"items": items})


@router.get("/approval-configs/{biz_type}", response_model=ResponseModel)
async def get_approval_config(biz_type: str, username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    row = await db.execute(
        text("SELECT biz_type, biz_name, nodes, is_active, updated_by, updated_at FROM approval_config WHERE biz_type=:bt LIMIT 1"),
        {"bt": biz_type},
    )
    r = row.fetchone()
    if not r:
        return ResponseModel(data={"biz_type": biz_type, "nodes": []})
    d = dict(r._mapping)
    if isinstance(d.get("nodes"), str):
        d["nodes"] = json.loads(d["nodes"] or "[]")
    if isinstance(d.get("updated_at"), datetime):
        d["updated_at"] = d["updated_at"].isoformat()
    return ResponseModel(data=d)


@router.put("/approval-configs/{biz_type}", response_model=ResponseModel)
async def save_approval_config(biz_type: str, data: dict, username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
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
async def delete_approval_config(biz_type: str, username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    await db.execute(text("DELETE FROM approval_config WHERE biz_type=:bt"), {"bt": biz_type})
    await db.commit()
    return ResponseModel(data={"biz_type": biz_type}, message="已删除")


@router.get("/{change_id}", response_model=ResponseModel)
async def get_price_change(change_id: int, username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    service = PriceChangeService(db)
    record = await service.get_price_change(change_id)
    if not record:
        raise HTTPException(status_code=404, detail="调价单不存在")
    return ResponseModel(data=record)


@router.post("", response_model=ResponseModel)
async def create_price_change(data: dict, username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    service = PriceChangeService(db)
    submit = data.pop("submit", False)
    main_data = {k: v for k, v in data.items() if k not in ("items", "submit")}
    if main_data.get("change_date") and isinstance(main_data["change_date"], str):
        try:
            main_data["change_date"] = date_type.fromisoformat(main_data["change_date"][:10])
        except Exception:
            pass
    items_data = data.get("items", [])
    record = await service.create_price_change(main_data, items_data, submit=submit, applicant=username)
    await db.commit()
    return ResponseModel(data=record, message="创建成功")


@router.put("/{change_id}", response_model=ResponseModel)
async def update_price_change(change_id: int, data: dict, username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
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
async def submit_for_approval(change_id: int, username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    service = PriceChangeService(db)
    record = await service.submit_for_approval(change_id, applicant=username)
    if not record:
        raise HTTPException(status_code=400, detail="仅草稿/已驳回/已撤回状态可提交")
    await db.commit()
    return ResponseModel(data=record, message="已提交审批")


@router.post("/{change_id}/ai-analyze", response_model=ResponseModel)
async def rerun_ai_analysis(change_id: int, username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    service = PriceChangeService(db)
    record = await service.rerun_ai_analysis(change_id)
    if not record:
        raise HTTPException(status_code=404, detail="调价单不存在")
    await db.commit()
    return ResponseModel(data=record, message="AI 分析已刷新")


@router.post("/{change_id}/approve", response_model=ResponseModel)
async def approve_price_change(change_id: int, data: dict, username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    service = PriceChangeService(db)
    result = await service.approve(change_id, approver=username, comment=data.get("comment", ""))
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    await db.commit()
    msg = "审批通过，已归档" if result["finished"] else f"第{result['level']}级审批通过"
    return ResponseModel(message=msg)


@router.post("/{change_id}/reject", response_model=ResponseModel)
async def reject_price_change(change_id: int, data: dict, username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    service = PriceChangeService(db)
    result = await service.reject(change_id, approver=username, comment=data.get("comment", ""))
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    await db.commit()
    return ResponseModel(message="已驳回")


@router.post("/{change_id}/recall", response_model=ResponseModel)
async def recall_price_change(change_id: int, username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    service = PriceChangeService(db)
    ok = await service.recall(change_id)
    if not ok:
        raise HTTPException(status_code=400, detail="仅审批中状态可撤回")
    await db.commit()
    return ResponseModel(message="已撤回")


@router.delete("/{change_id}", response_model=ResponseModel)
async def delete_price_change(change_id: int, username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    service = PriceChangeService(db)
    ok = await service.delete(change_id)
    if not ok:
        raise HTTPException(status_code=400, detail="仅草稿/已驳回/已撤回状态可删除")
    await db.commit()
    return ResponseModel(message="已删除")


@router.get("/supplier-last-price", response_model=ResponseModel)
async def get_supplier_last_price(material_code: str = Query(""), supplier_code: str = Query(""), username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    if not material_code:
        return ResponseModel(data=None)
    from sqlalchemy import text
    result = await db.execute(text("SELECT price, order_date FROM purchase_order WHERE material_code=:mat AND supplier_code=:sup ORDER BY order_date DESC LIMIT 1"), {"mat": material_code, "sup": supplier_code or ""})
    row = result.fetchone()
    if row:
        return ResponseModel(data={"old_price": float(row[0]), "old_price_date": str(row[1])})
@router.get("/employees/search", response_model=ResponseModel)
async def search_employees(keyword: str = Query(""), page: int = Query(1, ge=1), page_size: int = Query(10, ge=1, le=50), username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    """轻量级员工搜索（不查权限，直接查 scm_employee 表）"""
    from sqlalchemy import text
    if keyword:
        like = f'%{keyword}%'
        total_row = await db.execute(text("SELECT COUNT(*) FROM scm_employee WHERE status=1 AND (emp_name ILIKE :kw OR emp_code ILIKE :kw)"), {"kw": like})
        total = total_row.scalar() or 0
        rows = await db.execute(
            text("SELECT id, emp_code, emp_name as display_name, position as position_name, org_id FROM scm_employee WHERE status=1 AND (emp_name ILIKE :kw OR emp_code ILIKE :kw) ORDER BY emp_code LIMIT :lim OFFSET :off"),
            {"kw": like, "lim": page_size, "off": (page - 1) * page_size},
        )
    else:
        total_row = await db.execute(text("SELECT COUNT(*) FROM scm_employee WHERE status=1"))
        total = total_row.scalar() or 0
        rows = await db.execute(
            text("SELECT id, emp_code, emp_name as display_name, position as position_name, org_id FROM scm_employee WHERE status=1 ORDER BY emp_code LIMIT :lim OFFSET :off"),
            {"lim": page_size, "off": (page - 1) * page_size},
        )
    items = [dict(r._mapping) for r in rows]
    return ResponseModel(data={"items": items, "total": total})


@router.get("/suppliers/search", response_model=ResponseModel)
async def search_suppliers(keyword: str = Query(""), page: int = Query(1, ge=1), page_size: int = Query(10, ge=1, le=50), username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    """轻量级供应商搜索（不查权限，直接查 scm_supplier 表）"""
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
async def search_materials(keyword: str = Query(""), page: int = Query(1, ge=1), page_size: int = Query(10, ge=1, le=50), username: str = Depends(get_current_username), db: AsyncSession = Depends(get_db)):
    from sqlalchemy import text
    if keyword:
        like = f"%{keyword}%"
        total_row = await db.execute(text("SELECT COUNT(*) FROM scm_material WHERE status=1 AND is_deleted=0 AND (material_name ILIKE :kw OR material_code ILIKE :kw)"), {"kw": like})
        total = total_row.scalar() or 0
        rows = await db.execute(text("SELECT material_code, material_name, spec_model as spec, unit_of_measure as unit, brand FROM scm_material WHERE status=1 AND is_deleted=0 AND (material_name ILIKE :kw OR material_code ILIKE :kw) ORDER BY material_code LIMIT :lim OFFSET :off"), {"kw": like, "lim": page_size, "off": (page - 1) * page_size})
    else:
        total_row = await db.execute(text("SELECT COUNT(*) FROM scm_material WHERE status=1 AND is_deleted=0"))
        total = total_row.scalar() or 0
        rows = await db.execute(text("SELECT material_code, material_name, spec_model as spec, unit_of_measure as unit, brand FROM scm_material WHERE status=1 AND is_deleted=0 ORDER BY material_code LIMIT :lim OFFSET :off"), {"lim": page_size, "off": (page - 1) * page_size})
    items = [dict(r._mapping) for r in rows]
    return ResponseModel(data={"items": items, "total": total})


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
