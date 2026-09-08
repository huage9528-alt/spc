"""物料齐套中心 — 委外订单 API"""

import os
import tempfile
from datetime import date as date_type
from fastapi import APIRouter, Depends, Query, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import select, func, delete, or_
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.core.audit import log_audit
from app.models.material.subcontract_order import SubcontractOrder
from app.models.material.subcontract_order_detail import SubcontractOrderDetail
from app.models.basicdata.supplier import Supplier
from app.models.basicdata.material import Material
from app.schemas.common import ResponseModel, PageResult
from app.schemas.material.schemas import (
    SubcontractOrderOut, SubcontractOrderDetailOut,
    SubcontractOrderCreate, SubcontractOrderUpdate,
    SubcontractOrderBatchUpdate,
    SubcontractOrderDetailCreate, SubcontractOrderDetailUpdate,
)
from app.services.material.import_material_csv import import_subcontract_order_csv
from app.services.common.export_service import GenericExportService, ExportColumn

router = APIRouter()

ERP_SOURCE = "erp"
ERP_PROTECTED_FIELDS = {
    "bill_no", "bill_date", "bill_type", "supplier_id", "erp_order_id",
    "voided_flag", "closed_flag", "audit_date", "auditor_id", "settle_date",
}


def _head_to_out(head, details=None, supplier_name=None, supplier_code=None) -> SubcontractOrderOut:
    out = SubcontractOrderOut.model_validate(head)
    out.details = details
    if supplier_name is not None:
        out.supplier_name = supplier_name
    if supplier_code is not None:
        out.supplier_code = supplier_code
    return out


SORTABLE_COLUMNS = {
    "bill_no": SubcontractOrder.bill_no,
    "bill_date": SubcontractOrder.bill_date,
    "bill_type": SubcontractOrder.bill_type,
    "supplier_id": SubcontractOrder.supplier_id,
    "status": SubcontractOrder.status,
    "data_source": SubcontractOrder.data_source,
    "remark": SubcontractOrder.remark,
    "audit_date": SubcontractOrder.audit_date,
    "settle_date": SubcontractOrder.settle_date,
    "close_date": SubcontractOrder.close_date,
    "created_at": SubcontractOrder.created_at,
}


def _build_filters(
    bill_type: Optional[str] = None,
    supplier_id: Optional[int] = None,
    supplier_name: Optional[str] = None,
    status: Optional[str] = None,
    data_source: Optional[str] = None,
    bill_date_start: Optional[str] = None,
    bill_date_end: Optional[str] = None,
    keyword: Optional[str] = None,
    include_voided: bool = False,
) -> list:
    """构建头表筛选条件；supplier_name / status 多值用逗号分隔。"""
    base = []
    if not include_voided:
        base.append((SubcontractOrder.voided_flag != 1) | SubcontractOrder.voided_flag.is_(None))
    if bill_type:
        base.append(SubcontractOrder.bill_type == bill_type)
    if supplier_id is not None:
        base.append(SubcontractOrder.supplier_id == supplier_id)
    if status:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        if len(statuses) == 1:
            base.append(SubcontractOrder.status == statuses[0])
        elif statuses:
            base.append(SubcontractOrder.status.in_(statuses))
    if data_source:
        sources = [s.strip() for s in data_source.split(",") if s.strip()]
        if len(sources) == 1:
            base.append(SubcontractOrder.data_source == sources[0])
        elif sources:
            base.append(SubcontractOrder.data_source.in_(sources))
    if bill_date_start:
        base.append(SubcontractOrder.bill_date >= date_type.fromisoformat(bill_date_start))
    if bill_date_end:
        base.append(SubcontractOrder.bill_date <= date_type.fromisoformat(bill_date_end))
    if keyword:
        like = f"%{keyword}%"
        base.append(
            SubcontractOrder.bill_no.ilike(like)
            | SubcontractOrder.remark.ilike(like)
            | Supplier.supplier_name.ilike(like)
            | Supplier.supplier_code.ilike(like)
        )
    if supplier_name:
        base.append(Supplier.supplier_name.ilike(f"%{supplier_name}%"))
    return base


@router.get("", response_model=ResponseModel[PageResult[SubcontractOrderOut]])
async def list_subcontract_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    keyword: Optional[str] = Query(None, description="模糊匹配 bill_no/remark/supplier_name/supplier_code"),
    include_voided: bool = Query(False, description="是否包含 voided_flag=1 的单"),
    bill_type: Optional[str] = Query(None, description="单据类型精确匹配"),
    supplier_id: Optional[int] = Query(None, description="供应商ID精确匹配"),
    supplier_name: Optional[str] = Query(None, description="供应商名称模糊匹配"),
    status: Optional[str] = Query(None, description="状态多值逗号分隔,如 0,1,2,3"),
    data_source: Optional[str] = Query(None, description="数据来源多值逗号分隔,如 erp,manual"),
    bill_date_start: Optional[str] = Query(None, description="日期起始 YYYY-MM-DD"),
    bill_date_end: Optional[str] = Query(None, description="日期截止 YYYY-MM-DD"),
    sort_by: Optional[str] = Query(None, description="排序字段:bill_no/bill_date/bill_type/supplier_id/supplier_name/status/data_source/remark/audit_date/settle_date/close_date/detail_count/total_qty/created_at"),
    sort_order: Optional[str] = Query(None, description="asc / desc"),
    current_user: dict = Depends(PermissionChecker("materials.subcontract_orders", "read")),
    db: AsyncSession = Depends(get_db),
):
    base = _build_filters(
        bill_type=bill_type,
        supplier_id=supplier_id,
        supplier_name=supplier_name,
        status=status,
        data_source=data_source,
        bill_date_start=bill_date_start,
        bill_date_end=bill_date_end,
        keyword=keyword,
        include_voided=include_voided,
    )

    def _stats_count(extra_cond):
        return select(func.count(SubcontractOrder.id)).outerjoin(
            Supplier, SubcontractOrder.supplier_id == Supplier.erp_supply_id
        ).where(extra_cond, *base)

    count_query = (
        select(func.count(SubcontractOrder.id))
        .outerjoin(Supplier, SubcontractOrder.supplier_id == Supplier.erp_supply_id)
        .where(*base)
    )
    total = (await db.execute(count_query)).scalar() or 0

    audited = (await db.execute(_stats_count(SubcontractOrder.status == "1"))).scalar() or 0
    pending = (await db.execute(_stats_count(SubcontractOrder.status.in_(["0", None, ""])))).scalar() or 0
    closed = (await db.execute(_stats_count(SubcontractOrder.closed_flag == 1))).scalar() or 0
    voided = (await db.execute(_stats_count(SubcontractOrder.voided_flag == 1))).scalar() or 0
    stats = {"total": total, "audited": audited, "pending": pending, "closed": closed, "voided": voided}

    detail_subq = (
        select(
            SubcontractOrderDetail.erp_order_id.label("oid"),
            func.count(SubcontractOrderDetail.id).label("cnt"),
            func.sum(SubcontractOrderDetail.qty).label("qty"),
        )
        .group_by(SubcontractOrderDetail.erp_order_id)
        .subquery()
    )

    direction = "desc" if (sort_order or "desc").lower() == "desc" else "asc"
    order_clauses = []
    if sort_by == "detail_count":
        col = func.coalesce(detail_subq.c.cnt, 0)
        order_clauses.append(col.desc().nullslast() if direction == "desc" else col.asc().nullslast())
    elif sort_by == "total_qty":
        col = func.coalesce(detail_subq.c.qty, 0)
        order_clauses.append(col.desc().nullslast() if direction == "desc" else col.asc().nullslast())
    elif sort_by == "supplier_name":
        col = Supplier.supplier_name
        order_clauses.append(col.desc().nullslast() if direction == "desc" else col.asc().nullslast())
    elif sort_by in SORTABLE_COLUMNS:
        col = SORTABLE_COLUMNS[sort_by]
        order_clauses.append(col.desc().nullslast() if direction == "desc" else col.asc().nullslast())
    if not order_clauses:
        order_clauses = [SubcontractOrder.bill_date.desc().nullslast(), SubcontractOrder.id.desc()]

    query = (
        select(
            SubcontractOrder,
            func.coalesce(detail_subq.c.cnt, 0),
            func.coalesce(detail_subq.c.qty, 0),
            Supplier.supplier_name,
            Supplier.supplier_code,
        )
        .outerjoin(Supplier, SubcontractOrder.supplier_id == Supplier.erp_supply_id)
        .outerjoin(detail_subq, detail_subq.c.oid == SubcontractOrder.erp_order_id)
        .where(*base)
        .order_by(*order_clauses)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(query)).all()
    items = []
    for head, cnt, qty, sup_name, sup_code in rows:
        out = SubcontractOrderOut.model_validate(head)
        out.detail_count = int(cnt or 0)
        out.total_qty = float(qty) if qty is not None else None
        out.supplier_name = sup_name
        out.supplier_code = sup_code
        items.append(out)
    return ResponseModel(data=PageResult(total=total, page=page, page_size=page_size, items=items, stats=stats))


@router.post("", response_model=ResponseModel[SubcontractOrderOut])
async def create_subcontract_order(
    data: SubcontractOrderCreate,
    current_user: dict = Depends(PermissionChecker("materials.subcontract_orders", "create")),
    db: AsyncSession = Depends(get_db),
):
    existing = (await db.execute(select(SubcontractOrder).where(SubcontractOrder.bill_no == data.bill_no))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail=f"bill_no={data.bill_no} 已存在")

    head = SubcontractOrder(
        **data.model_dump(exclude={"details"}),
        data_source="manual",
    )
    db.add(head)
    await db.flush()
    head.erp_order_id = head.id  # 让两表始终能 JOIN

    created_details = []
    if data.details:
        for idx, d in enumerate(data.details, start=1):
            det = SubcontractOrderDetail(
                erp_order_id=head.erp_order_id,
                detail_id=idx,
                line_no=idx,
                data_source="manual",
                **d.model_dump(exclude_unset=True),
            )
            db.add(det)
            created_details.append(det)
        await db.flush()

    await log_audit(db, "subcontract_order", head.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(head)
    return ResponseModel(data=_head_to_out(head, [SubcontractOrderDetailOut.model_validate(d) for d in created_details]))


@router.post("/import", response_model=ResponseModel[dict])
async def import_subcontract_orders(
    file: UploadFile = File(...),
    current_user: dict = Depends(PermissionChecker("materials.subcontract_orders", "import")),
    db: AsyncSession = Depends(get_db),
):
    suffix = os.path.splitext(file.filename or '')[1] or '.csv'
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name
    try:
        result = await import_subcontract_order_csv(tmp_path, db)
    finally:
        os.unlink(tmp_path)
    await log_audit(db, "subcontract_order", 0, "import", field_name="csv", new_value=file.filename, operator=current_user["username"])
    await db.commit()
    return ResponseModel(data=result)


@router.get("/export")
async def export_subcontract_orders(
    format: str = Query("xlsx", pattern="^(xlsx|csv)$"),
    keyword: Optional[str] = Query(None),
    include_voided: bool = Query(False),
    bill_type: Optional[str] = Query(None),
    supplier_id: Optional[int] = Query(None),
    supplier_name: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    data_source: Optional[str] = Query(None),
    bill_date_start: Optional[str] = Query(None),
    bill_date_end: Optional[str] = Query(None),
    current_user: dict = Depends(PermissionChecker("materials.subcontract_orders", "read")),
    db: AsyncSession = Depends(get_db),
):
    base = _build_filters(
        bill_type=bill_type,
        supplier_id=supplier_id,
        supplier_name=supplier_name,
        status=status,
        data_source=data_source,
        bill_date_start=bill_date_start,
        bill_date_end=bill_date_end,
        keyword=keyword,
        include_voided=include_voided,
    )

    detail_subq = (
        select(
            SubcontractOrderDetail.erp_order_id.label("oid"),
            func.count(SubcontractOrderDetail.id).label("cnt"),
            func.sum(SubcontractOrderDetail.qty).label("qty"),
        )
        .group_by(SubcontractOrderDetail.erp_order_id)
        .subquery()
    )
    query = (
        select(
            SubcontractOrder,
            func.coalesce(detail_subq.c.cnt, 0),
            func.coalesce(detail_subq.c.qty, 0),
            Supplier.supplier_name,
            Supplier.supplier_code,
        )
        .outerjoin(Supplier, SubcontractOrder.supplier_id == Supplier.erp_supply_id)
        .outerjoin(detail_subq, detail_subq.c.oid == SubcontractOrder.erp_order_id)
        .where(*base)
        .order_by(SubcontractOrder.bill_date.desc().nullslast())
    )
    rows = (await db.execute(query)).all()
    export_rows = []
    for head, cnt, qty, sup_name, sup_code in rows:
        export_rows.append({
            'bill_no': head.bill_no,
            'bill_date': str(head.bill_date) if head.bill_date else '',
            'bill_type': head.bill_type or '',
            'supplier_id': head.supplier_id or '',
            'supplier_name': sup_name or '',
            'status': head.status or '',
            'detail_count': int(cnt or 0),
            'total_qty': float(qty) if qty is not None else '',
            'remark': head.remark or '',
            'data_source': head.data_source or '',
        })
    svc = GenericExportService(SUBCONTRACT_EXPORT_COLUMNS, export_rows, sheet_name='委外订单')
    if format == 'csv':
        return StreamingResponse(svc.to_csv(), media_type='text/csv; charset=utf-8',
                                 headers={'Content-Disposition': 'attachment; filename=subcontract_orders.csv'})
    return StreamingResponse(svc.to_xlsx(),
                             media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                             headers={'Content-Disposition': 'attachment; filename=subcontract_orders.xlsx'})


@router.put("/batch", response_model=ResponseModel[dict])
async def batch_update_subcontract_orders(
    data: SubcontractOrderBatchUpdate,
    current_user: dict = Depends(PermissionChecker("materials.subcontract_orders", "update")),
    db: AsyncSession = Depends(get_db),
):
    if not data.ids:
        raise HTTPException(status_code=400, detail="请选择要更新的记录")
    if data.status is None and data.remark is None:
        raise HTTPException(status_code=400, detail="请至少填写一个更新字段")
    update_fields = {k: v for k, v in {"status": data.status, "remark": data.remark}.items() if v is not None}
    result = await db.execute(
        select(SubcontractOrder).where(SubcontractOrder.id.in_(data.ids))
    )
    heads = result.scalars().all()
    for h in heads:
        for k, v in update_fields.items():
            setattr(h, k, v)
    await log_audit(
        db, "subcontract_order", 0, "batch_update",
        field_name="batch_status_remark",
        new_value=f"ids={data.ids}, {update_fields}",
        operator=current_user["username"],
    )
    await db.commit()
    return ResponseModel(data={"updated": len(heads)})


@router.get("/{order_id}", response_model=ResponseModel[SubcontractOrderOut])
async def get_subcontract_order(
    order_id: int,
    current_user: dict = Depends(PermissionChecker("materials.subcontract_orders", "read")),
    db: AsyncSession = Depends(get_db),
):
    head = (await db.execute(select(SubcontractOrder).where(SubcontractOrder.id == order_id))).scalar_one_or_none()
    if not head:
        raise HTTPException(status_code=404, detail="委外订单不存在")
    sup_row = (await db.execute(
        select(Supplier.supplier_name, Supplier.supplier_code)
        .where(Supplier.erp_supply_id == head.supplier_id)
    )).first()
    sup_name = sup_row[0] if sup_row else None
    sup_code = sup_row[1] if sup_row else None
    detail_rows = (
        await db.execute(
            select(SubcontractOrderDetail, Material.material_code, Material.material_name)
            .outerjoin(Material, SubcontractOrderDetail.material_id == Material.erp_material_id)
            .where(SubcontractOrderDetail.erp_order_id == head.erp_order_id)
            .order_by(SubcontractOrderDetail.line_no.asc().nullslast(), SubcontractOrderDetail.id.asc())
        )
    ).all()
    detail_items = []
    for det, mat_code, mat_name in detail_rows:
        out = SubcontractOrderDetailOut.model_validate(det)
        out.material_code = mat_code
        out.material_name = mat_name
        detail_items.append(out)
    return ResponseModel(data=_head_to_out(head, detail_items, supplier_name=sup_name, supplier_code=sup_code))


@router.get("/{order_id}/details", response_model=ResponseModel[PageResult[SubcontractOrderDetailOut]])
async def list_subcontract_order_details(
    order_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    material_code: Optional[str] = Query(None, description="物料编码模糊匹配"),
    material_name: Optional[str] = Query(None, description="物料名称模糊匹配"),
    sale_order_no: Optional[str] = Query(None, description="销售订单号精确匹配"),
    data_source: Optional[str] = Query(None, description="数据来源多值逗号分隔"),
    mrp_closed: Optional[bool] = Query(None, description="MRP关闭标志: true=已关闭 / false=未关闭"),
    qty_min: Optional[float] = Query(None, description="数量下限"),
    qty_max: Optional[float] = Query(None, description="数量上限"),
    delivery_qty_min: Optional[float] = Query(None, description="交货数量下限"),
    delivery_qty_max: Optional[float] = Query(None, description="交货数量上限"),
    received_qty_min: Optional[float] = Query(None, description="已收数量下限"),
    received_qty_max: Optional[float] = Query(None, description="已收数量上限"),
    sort_by: Optional[str] = Query(None, description="排序字段:line_no/material_id/material_code/material_name/qty/delivery_qty/received_qty/price/amount/sale_order_no/sale_order_line_no/data_source"),
    sort_order: Optional[str] = Query(None, description="asc / desc"),
    current_user: dict = Depends(PermissionChecker("materials.subcontract_orders", "read")),
    db: AsyncSession = Depends(get_db),
):
    head = (await db.execute(select(SubcontractOrder).where(SubcontractOrder.id == order_id))).scalar_one_or_none()
    if not head:
        raise HTTPException(status_code=404, detail="委外订单不存在")

    base = [SubcontractOrderDetail.erp_order_id == head.erp_order_id]
    if material_code:
        base.append(Material.material_code.ilike(f"%{material_code}%"))
    if material_name:
        base.append(Material.material_name.ilike(f"%{material_name}%"))
    if sale_order_no:
        base.append(SubcontractOrderDetail.sale_order_no == sale_order_no)
    if data_source:
        sources = [s.strip() for s in data_source.split(",") if s.strip()]
        if len(sources) == 1:
            base.append(SubcontractOrderDetail.data_source == sources[0])
        elif sources:
            base.append(SubcontractOrderDetail.data_source.in_(sources))
    if mrp_closed is True:
        base.append(SubcontractOrderDetail.mrp_closed_flag == 1)
    elif mrp_closed is False:
        base.append(or_(SubcontractOrderDetail.mrp_closed_flag == 0, SubcontractOrderDetail.mrp_closed_flag.is_(None)))
    if qty_min is not None:
        base.append(SubcontractOrderDetail.qty >= qty_min)
    if qty_max is not None:
        base.append(SubcontractOrderDetail.qty <= qty_max)
    if delivery_qty_min is not None:
        base.append(SubcontractOrderDetail.delivery_qty >= delivery_qty_min)
    if delivery_qty_max is not None:
        base.append(SubcontractOrderDetail.delivery_qty <= delivery_qty_max)
    if received_qty_min is not None:
        base.append(SubcontractOrderDetail.received_qty >= received_qty_min)
    if received_qty_max is not None:
        base.append(SubcontractOrderDetail.received_qty <= received_qty_max)

    DETAIL_SORTABLE = {
        "line_no": SubcontractOrderDetail.line_no,
        "material_id": SubcontractOrderDetail.material_id,
        "material_code": Material.material_code,
        "material_name": Material.material_name,
        "qty": SubcontractOrderDetail.qty,
        "delivery_qty": SubcontractOrderDetail.delivery_qty,
        "received_qty": SubcontractOrderDetail.received_qty,
        "returned_qty": SubcontractOrderDetail.returned_qty,
        "price": SubcontractOrderDetail.price,
        "amount": SubcontractOrderDetail.amount,
        "mrp_closed_flag": SubcontractOrderDetail.mrp_closed_flag,
        "sale_order_line_no": SubcontractOrderDetail.sale_order_line_no,
        "sale_order_no": SubcontractOrderDetail.sale_order_no,
        "data_source": SubcontractOrderDetail.data_source,
        "id": SubcontractOrderDetail.id,
    }
    direction = "desc" if (sort_order or "asc").lower() == "desc" else "asc"
    order_clauses = []
    if sort_by and sort_by in DETAIL_SORTABLE:
        col = DETAIL_SORTABLE[sort_by]
        order_clauses.append(col.desc().nullslast() if direction == "desc" else col.asc().nullslast())
    if not order_clauses:
        order_clauses = [SubcontractOrderDetail.line_no.asc().nullslast(), SubcontractOrderDetail.id.asc()]

    count_query = (
        select(func.count(SubcontractOrderDetail.id))
        .outerjoin(Material, SubcontractOrderDetail.material_id == Material.erp_material_id)
        .where(*base)
    )
    total = (await db.execute(count_query)).scalar() or 0

    rows = (
        await db.execute(
            select(SubcontractOrderDetail, Material.material_code, Material.material_name)
            .outerjoin(Material, SubcontractOrderDetail.material_id == Material.erp_material_id)
            .where(*base)
            .order_by(*order_clauses)
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    items = []
    for det, mat_code, mat_name in rows:
        out = SubcontractOrderDetailOut.model_validate(det)
        out.material_code = mat_code
        out.material_name = mat_name
        items.append(out)
    return ResponseModel(data=PageResult(total=total, page=page, page_size=page_size, items=items))


@router.put("/{order_id}", response_model=ResponseModel[SubcontractOrderOut])
async def update_subcontract_order(
    order_id: int,
    data: SubcontractOrderUpdate,
    current_user: dict = Depends(PermissionChecker("materials.subcontract_orders", "update")),
    db: AsyncSession = Depends(get_db),
):
    head = (await db.execute(select(SubcontractOrder).where(SubcontractOrder.id == order_id))).scalar_one_or_none()
    if not head:
        raise HTTPException(status_code=404, detail="委外订单不存在")

    update_data = data.model_dump(exclude_unset=True)
    if head.data_source == ERP_SOURCE:
        blocked = ERP_PROTECTED_FIELDS & update_data.keys()
        if blocked:
            raise HTTPException(
                status_code=400,
                detail=f"ERP 同步行不可修改字段: {','.join(sorted(blocked))}",
            )

    await log_audit(db, "subcontract_order", head.id, "update", old_obj=head, update_data=update_data, operator=current_user["username"])
    for k, v in update_data.items():
        setattr(head, k, v)
    await db.commit()
    await db.refresh(head)
    return ResponseModel(data=_head_to_out(head))


@router.delete("/{order_id}", response_model=ResponseModel[dict])
async def delete_subcontract_order(
    order_id: int,
    current_user: dict = Depends(PermissionChecker("materials.subcontract_orders", "delete")),
    db: AsyncSession = Depends(get_db),
):
    head = (await db.execute(select(SubcontractOrder).where(SubcontractOrder.id == order_id))).scalar_one_or_none()
    if not head:
        raise HTTPException(status_code=404, detail="委外订单不存在")
    if head.data_source == ERP_SOURCE:
        raise HTTPException(status_code=409, detail="ERP 同步行不可删除（请在 ERP 系统作废）")

    await db.execute(
        delete(SubcontractOrderDetail).where(SubcontractOrderDetail.erp_order_id == head.erp_order_id)
    )
    await log_audit(db, "subcontract_order", head.id, "delete", old_obj=head, operator=current_user["username"])
    await db.delete(head)
    await db.commit()
    return ResponseModel(data={"deleted": order_id})


@router.post("/{order_id}/details", response_model=ResponseModel[SubcontractOrderDetailOut])
async def add_subcontract_order_detail(
    order_id: int,
    data: SubcontractOrderDetailCreate,
    current_user: dict = Depends(PermissionChecker("materials.subcontract_orders", "update")),
    db: AsyncSession = Depends(get_db),
):
    head = (await db.execute(select(SubcontractOrder).where(SubcontractOrder.id == order_id))).scalar_one_or_none()
    if not head:
        raise HTTPException(status_code=404, detail="委外订单不存在")
    if head.data_source == ERP_SOURCE:
        raise HTTPException(status_code=400, detail="ERP 同步单据不可添加明细")
    max_detail = (await db.execute(
        select(func.max(SubcontractOrderDetail.detail_id))
        .where(SubcontractOrderDetail.erp_order_id == head.erp_order_id)
    )).scalar() or 0
    det = SubcontractOrderDetail(
        erp_order_id=head.erp_order_id,
        detail_id=max_detail + 1,
        line_no=max_detail + 1,
        data_source="manual",
        **data.model_dump(exclude_unset=True),
    )
    db.add(det)
    await db.flush()
    await log_audit(db, "subcontract_order_detail", det.id, "create", new_value=str(data.model_dump()), operator=current_user["username"])
    await db.commit()
    await db.refresh(det)
    return ResponseModel(data=SubcontractOrderDetailOut.model_validate(det))


@router.put("/{order_id}/details/{detail_id}", response_model=ResponseModel[SubcontractOrderDetailOut])
async def update_subcontract_order_detail(
    order_id: int,
    detail_id: int,
    data: SubcontractOrderDetailUpdate,
    current_user: dict = Depends(PermissionChecker("materials.subcontract_orders", "update")),
    db: AsyncSession = Depends(get_db),
):
    head = (await db.execute(select(SubcontractOrder).where(SubcontractOrder.id == order_id))).scalar_one_or_none()
    if not head:
        raise HTTPException(status_code=404, detail="委外订单不存在")
    det = (await db.execute(
        select(SubcontractOrderDetail).where(
            SubcontractOrderDetail.erp_order_id == head.erp_order_id,
            SubcontractOrderDetail.id == detail_id,
        )
    )).scalar_one_or_none()
    if not det:
        raise HTTPException(status_code=404, detail="明细不存在")
    if head.data_source == ERP_SOURCE or det.data_source == ERP_SOURCE:
        raise HTTPException(status_code=400, detail="ERP 同步明细不可修改")
    update_data = data.model_dump(exclude_unset=True)
    await log_audit(db, "subcontract_order_detail", det.id, "update", old_obj=det, update_data=update_data, operator=current_user["username"])
    for k, v in update_data.items():
        setattr(det, k, v)
    await db.commit()
    await db.refresh(det)
    return ResponseModel(data=SubcontractOrderDetailOut.model_validate(det))


@router.delete("/{order_id}/details/{detail_id}", response_model=ResponseModel[dict])
async def delete_subcontract_order_detail(
    order_id: int,
    detail_id: int,
    current_user: dict = Depends(PermissionChecker("materials.subcontract_orders", "update")),
    db: AsyncSession = Depends(get_db),
):
    head = (await db.execute(select(SubcontractOrder).where(SubcontractOrder.id == order_id))).scalar_one_or_none()
    if not head:
        raise HTTPException(status_code=404, detail="委外订单不存在")
    det = (await db.execute(
        select(SubcontractOrderDetail).where(
            SubcontractOrderDetail.erp_order_id == head.erp_order_id,
            SubcontractOrderDetail.id == detail_id,
        )
    )).scalar_one_or_none()
    if not det:
        raise HTTPException(status_code=404, detail="明细不存在")
    if head.data_source == ERP_SOURCE or det.data_source == ERP_SOURCE:
        raise HTTPException(status_code=400, detail="ERP 同步明细不可删除")
    await log_audit(db, "subcontract_order_detail", det.id, "delete", old_obj=det, operator=current_user["username"])
    await db.delete(det)
    await db.commit()
    return ResponseModel(data={"deleted": detail_id})


SUBCONTRACT_EXPORT_COLUMNS = [
    ExportColumn('bill_no', '单据编号', 20),
    ExportColumn('bill_date', '日期', 12),
    ExportColumn('bill_type', '类型', 14),
    ExportColumn('supplier_id', '供应商ID', 12),
    ExportColumn('supplier_name', '供应商名称', 24),
    ExportColumn('status', '状态', 14),
    ExportColumn('detail_count', '明细数', 8),
    ExportColumn('total_qty', '总数量', 12),
    ExportColumn('remark', '摘要', 30),
    ExportColumn('data_source', '数据来源', 10),
]
