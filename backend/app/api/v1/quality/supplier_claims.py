"""品质管理 - 供应商索赔通知单 API"""

from fastapi import APIRouter, Depends, Query, Body
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker, oauth2_scheme, decode_access_token
from app.schemas.common import ResponseModel
from app.services.quality.supplier_claim_service import SupplierClaimService


async def get_current_user_payload(token: str = Depends(oauth2_scheme), db: AsyncSession = Depends(get_db)) -> dict:
    """JWT sub 存 user_id，查库换成 username，供审批节点权限校验与单据归属记录。"""
    payload = decode_access_token(token)
    sub = payload.get("sub", "anonymous")
    username = sub
    try:
        row = await db.execute(text("SELECT username FROM sys_user WHERE id = :i"), {"i": int(sub)})
        r = row.fetchone()
        if r and r[0]:
            username = r[0]
    except Exception:
        pass
    return {"username": username, "role": payload.get("role", "")}


router = APIRouter()


@router.get("", response_model=ResponseModel)
async def list_claims(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str = Query(""),
    status: str = Query(""),
    date_start: str = Query(""),
    date_end: str = Query(""),
    applicant: str = Query(""),
    supplier: str = Query(""),
    _: dict = Depends(PermissionChecker("quality.supplier_claim", "read")),
    db: AsyncSession = Depends(get_db),
):
    service = SupplierClaimService(db)
    try:
        items, total = await service.list_claims(
            page=page, page_size=page_size, keyword=keyword or None, status=status or None,
            date_start=date_start or None, date_end=date_end or None,
            applicant=applicant or None, supplier=supplier or None,
        )
    except ValueError as e:
        return ResponseModel(code=1, message=str(e))
    return ResponseModel(data={"total": total, "page": page, "page_size": page_size, "items": items})


@router.get("/suppliers/search", response_model=ResponseModel)
async def search_suppliers(
    keyword: str = Query(""),
    _: dict = Depends(PermissionChecker("quality.supplier_claim", "read")),
    db: AsyncSession = Depends(get_db),
):
    kw = f"%{keyword}%"
    rows = await db.execute(text("""
        SELECT id, supplier_code, supplier_name, supplier_short
        FROM scm_supplier
        WHERE status = 1 AND (supplier_name ILIKE :kw OR supplier_code ILIKE :kw OR supplier_short ILIKE :kw)
        ORDER BY supplier_name LIMIT 10
    """), {"kw": kw})
    return ResponseModel(data={"items": [dict(r._mapping) for r in rows]})


@router.get("/{claim_id}", response_model=ResponseModel)
async def get_claim(
    claim_id: int,
    _: dict = Depends(PermissionChecker("quality.supplier_claim", "read")),
    db: AsyncSession = Depends(get_db),
):
    service = SupplierClaimService(db)
    record = await service.get_claim(claim_id)
    if not record:
        return ResponseModel(code=1, message="索赔单不存在")
    return ResponseModel(data=record)


@router.post("", response_model=ResponseModel)
async def create_claim(
    data: dict = Body(...),
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("quality.supplier_claim", "create")),
    db: AsyncSession = Depends(get_db),
):
    service = SupplierClaimService(db)
    try:
        record = await service.create_claim(data, applicant=user["username"], submit=bool(data.get("submit")))
    except ValueError as e:
        # 提交失败（如审批链未配置/已停用）时丢弃本次插入的草稿，避免留下用户看不到的孤儿单
        await db.rollback()
        return ResponseModel(code=1, message=str(e))
    await db.commit()
    return ResponseModel(data=record, message="已提交审批" if data.get("submit") else "保存成功")


@router.put("/{claim_id}", response_model=ResponseModel)
async def update_claim(
    claim_id: int,
    data: dict = Body(...),
    _: dict = Depends(PermissionChecker("quality.supplier_claim", "update")),
    db: AsyncSession = Depends(get_db),
):
    service = SupplierClaimService(db)
    try:
        record = await service.update_claim(claim_id, data)
    except ValueError as e:
        return ResponseModel(code=1, message=str(e))
    if not record:
        return ResponseModel(code=1, message="仅草稿/驳回/撤回状态可编辑")
    await db.commit()
    return ResponseModel(data=record, message="保存成功")


@router.delete("/{claim_id}", response_model=ResponseModel)
async def delete_claim(
    claim_id: int,
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("quality.supplier_claim", "delete")),
    db: AsyncSession = Depends(get_db),
):
    # 已归档单删除：admin 或持有「索赔单归档删除」权限者才可（实时查库，避免依赖 JWT 旧权限，防止客户端传参绕过）
    can_archive_delete = user["role"] == "admin"
    if not can_archive_delete:
        row = await db.execute(
            text("""SELECT r.role_code, r.permissions
                    FROM sys_role r JOIN sys_user u ON u.role_id = r.id
                    WHERE u.username = :un LIMIT 1"""),
            {"un": user["username"]},
        )
        r = row.fetchone()
        if r:
            perms = r[1] if isinstance(r[1], dict) else {}
            from app.core.permissions import merge_role_permission_additions
            perms = merge_role_permission_additions(r[0], perms)
            can_archive_delete = "delete" in (perms.get("quality.supplier_claim.archive_delete") or [])
    service = SupplierClaimService(db)
    result = await service.delete_claim(claim_id, can_archive_delete=can_archive_delete)
    if not result["success"]:
        return ResponseModel(code=1, message=result["message"])
    await db.commit()
    return ResponseModel(data=None, message=result["message"])


@router.post("/{claim_id}/submit", response_model=ResponseModel)
async def submit_claim(
    claim_id: int,
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("quality.supplier_claim", "update")),
    db: AsyncSession = Depends(get_db),
):
    service = SupplierClaimService(db)
    try:
        record = await service.submit_claim(claim_id, user["username"], caller_role=user["role"])
    except ValueError as e:
        return ResponseModel(code=1, message=str(e))
    if not record:
        return ResponseModel(code=1, message="仅草稿/驳回/撤回状态可提交")
    await db.commit()
    return ResponseModel(data=record, message="已提交审批")


@router.post("/{claim_id}/approve", response_model=ResponseModel)
async def approve_claim(
    claim_id: int,
    data: dict = Body(default={}),
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("approval.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    service = SupplierClaimService(db)
    result = await service.approve(
        claim_id, user["username"], data.get("comment", ""),
        approver_role=user["role"], expected_version=data.get("expected_version"),
    )
    if not result["success"]:
        return ResponseModel(code=1, message=result["message"])
    await db.commit()
    msg = "审批通过，已归档" if result.get("finished") else "审批通过"
    if result.get("skipped"):
        msg += f"（自动跳过 L{','.join(map(str, result['skipped']))} 同人节点）"
    return ResponseModel(data=result, message=msg)


@router.post("/{claim_id}/reject", response_model=ResponseModel)
async def reject_claim(
    claim_id: int,
    data: dict = Body(default={}),
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("approval.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    service = SupplierClaimService(db)
    result = await service.reject(
        claim_id, user["username"], data.get("comment", ""),
        approver_role=user["role"], expected_version=data.get("expected_version"),
    )
    if not result["success"]:
        return ResponseModel(code=1, message=result["message"])
    await db.commit()
    return ResponseModel(data=result, message="已驳回")


@router.post("/{claim_id}/recall", response_model=ResponseModel)
async def recall_claim(
    claim_id: int,
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("quality.supplier_claim", "update")),
    db: AsyncSession = Depends(get_db),
):
    service = SupplierClaimService(db)
    try:
        ok = await service.recall(claim_id, user["username"], caller_role=user["role"])
    except ValueError as e:
        return ResponseModel(code=1, message=str(e))
    if not ok:
        return ResponseModel(code=1, message="仅审批中状态可撤回")
    await db.commit()
    return ResponseModel(data=None, message="已撤回")


@router.post("/{claim_id}/revoke-approval", response_model=ResponseModel)
async def revoke_claim_approval(
    claim_id: int,
    user: dict = Depends(get_current_user_payload),
    _: dict = Depends(PermissionChecker("approval.pending", "read")),
    db: AsyncSession = Depends(get_db),
):
    service = SupplierClaimService(db)
    result = await service.revoke(claim_id, user["username"], revoker_role=user["role"])
    if not result["success"]:
        return ResponseModel(code=1, message=result["message"])
    await db.commit()
    return ResponseModel(data=result, message="已撤回审批")
