"""未来供给对外接口（采购/委外/自制/调拨 四源统一查询，AEOS 只读接入）"""

from datetime import date, datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import Date, String, cast, func, literal, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.basicdata.material import Material
from app.models.basicdata.supplier import Supplier
from app.models.material.mrp_plan_order import MrpPlanOrder
from app.models.material.purchase_order import PurchaseOrder
from app.models.material.subcontract_order import SubcontractOrder
from app.models.material.subcontract_order_detail import SubcontractOrderDetail
from app.models.material.transfer_order import TransferOrder
from app.schemas.common import ResponseModel
from app.services.material.kitting_calc_service import freshness_of, load_source_as_of, min_as_of

from ..common import ExternalDataPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(prefix="/material-supplies", tags=["物料齐套"])

_SUPPLY_SYNC_TYPES = ("purchase_orders", "subcontract_order_details", "mrp_plan_orders", "transfer_orders")


class MaterialSuppliesQuery(PageParamsMixin):
    material_code: Optional[str] = Field(None, description="物料编码精确匹配")
    supply_type: Optional[str] = Field(None, description="供给类型，逗号分隔多选：PURCHASE/OUTSOURCE/PRODUCTION/TRANSFER")
    supply_no: Optional[str] = Field(None, description="供给单号精确匹配")
    expected_date_start: Optional[date] = Field(None, description="预计可用日期起 YYYY-MM-DD（含）")
    expected_date_end: Optional[date] = Field(None, description="预计可用日期止 YYYY-MM-DD（含）")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间（ISO 8601）")
    request_id: Optional[str] = Field(None, description="调用方请求 ID（回显）")


class MaterialSupplyOut(BaseModel):
    supply_type: str
    supply_no: Optional[str] = None
    supply_line_no: Optional[str] = None
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    supply_qty: Optional[float] = None
    available_qty: Optional[float] = None
    expected_available_date: Optional[date] = None
    confirmed_available_date: Optional[date] = None
    supplier_code: Optional[str] = None
    supplier_name: Optional[str] = None
    supply_status: Optional[str] = None
    quality_status: Optional[str] = None


@router.get("/list", response_model=ResponseModel[ExternalDataPage[MaterialSupplyOut]],
            summary="未来供给列表", description="endpoint_code: material.supplies")
@register_external(
    "material.supplies", "未来供给列表", method="GET", path="/material-supplies/list",
    description="四类未来供给统一查询（采购在途/委外回货/自制计划/调拨），支持增量同步",
    tags=["物料齐套"],
)
@log_external_call("material.supplies")
async def material_supplies_list(
    request: Request,
    q: Annotated[MaterialSuppliesQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("material.supplies")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    po_q = select(
        literal("PURCHASE").label("supply_type"),
        PurchaseOrder.po_no.label("supply_no"),
        cast(PurchaseOrder.detail_id, String).label("supply_line_no"),
        PurchaseOrder.material_code.label("material_code"),
        PurchaseOrder.material_name.label("material_name"),
        PurchaseOrder.po_qty.label("supply_qty"),
        (func.coalesce(PurchaseOrder.po_qty, 0) - func.coalesce(PurchaseOrder.received_qty, 0)).label("available_qty"),
        func.coalesce(PurchaseOrder.eta, PurchaseOrder.po_date).label("expected_available_date"),
        func.coalesce(PurchaseOrder.eta, PurchaseOrder.po_date).label("confirmed_available_date"),
        PurchaseOrder.supplier_code.label("supplier_code"),
        PurchaseOrder.supplier_name.label("supplier_name"),
        PurchaseOrder.po_status.label("supply_status"),
        literal(None, String).label("quality_status"),
        PurchaseOrder.updated_at.label("updated_at"),
    ).where(
        PurchaseOrder.is_closed == 0,
        (func.coalesce(PurchaseOrder.po_qty, 0) - func.coalesce(PurchaseOrder.received_qty, 0)) > 0,
    )

    sub_q = (
        select(
            literal("OUTSOURCE").label("supply_type"),
            SubcontractOrder.bill_no.label("supply_no"),
            cast(SubcontractOrderDetail.detail_id, String).label("supply_line_no"),
            Material.material_code.label("material_code"),
            Material.material_name.label("material_name"),
            SubcontractOrderDetail.qty.label("supply_qty"),
            (
                func.coalesce(SubcontractOrderDetail.qty, 0)
                - func.coalesce(SubcontractOrderDetail.received_qty, 0)
                - func.coalesce(SubcontractOrderDetail.returned_qty, 0)
            ).label("available_qty"),
            func.cast(None, Date).label("expected_available_date"),
            func.cast(None, Date).label("confirmed_available_date"),
            Supplier.supplier_code.label("supplier_code"),
            Supplier.supplier_name.label("supplier_name"),
            literal("confirmed").label("supply_status"),
            literal(None, String).label("quality_status"),
            SubcontractOrder.updated_at.label("updated_at"),
        )
        .select_from(SubcontractOrderDetail)
        .join(SubcontractOrder, SubcontractOrderDetail.erp_order_id == SubcontractOrder.erp_order_id)
        .outerjoin(Material, Material.erp_material_id == SubcontractOrderDetail.material_id)
        .outerjoin(Supplier, Supplier.erp_supply_id == SubcontractOrder.supplier_id)
        .where(
            (SubcontractOrder.closed_flag == 0) | (SubcontractOrder.closed_flag.is_(None)),
            (SubcontractOrder.voided_flag == 0) | (SubcontractOrder.voided_flag.is_(None)),
            (
                func.coalesce(SubcontractOrderDetail.qty, 0)
                - func.coalesce(SubcontractOrderDetail.received_qty, 0)
                - func.coalesce(SubcontractOrderDetail.returned_qty, 0)
            ) > 0,
        )
    )

    mrp_q = select(
        literal("PRODUCTION").label("supply_type"),
        MrpPlanOrder.sale_order_no.label("supply_no"),
        MrpPlanOrder.material_id.label("supply_line_no"),
        MrpPlanOrder.material_code.label("material_code"),
        MrpPlanOrder.material_name.label("material_name"),
        MrpPlanOrder.base_plan_qty.label("supply_qty"),
        (func.coalesce(MrpPlanOrder.base_plan_qty, 0) - func.coalesce(MrpPlanOrder.stock_qty, 0)).label("available_qty"),
        MrpPlanOrder.need_date.label("expected_available_date"),
        MrpPlanOrder.need_date.label("confirmed_available_date"),
        func.cast(None, String).label("supplier_code"),
        func.cast(None, String).label("supplier_name"),
        literal("planned").label("supply_status"),
        literal(None, String).label("quality_status"),
        MrpPlanOrder.updated_at.label("updated_at"),
    ).where(
        MrpPlanOrder.is_closed == 0,
        MrpPlanOrder.bill_type == 11011,
        (func.coalesce(MrpPlanOrder.base_plan_qty, 0) - func.coalesce(MrpPlanOrder.stock_qty, 0)) > 0,
    )

    tr_q = select(
        literal("TRANSFER").label("supply_type"),
        TransferOrder.transfer_no.label("supply_no"),
        cast(TransferOrder.entry_id, String).label("supply_line_no"),
        TransferOrder.material_code.label("material_code"),
        TransferOrder.material_name.label("material_name"),
        TransferOrder.qty.label("supply_qty"),
        TransferOrder.qty.label("available_qty"),
        func.coalesce(TransferOrder.expected_arrival_date, TransferOrder.transfer_date).label("expected_available_date"),
        func.coalesce(TransferOrder.expected_arrival_date, TransferOrder.transfer_date).label("confirmed_available_date"),
        func.cast(None, String).label("supplier_code"),
        func.cast(None, String).label("supplier_name"),
        TransferOrder.status.label("supply_status"),
        literal(None, String).label("quality_status"),
        TransferOrder.updated_at.label("updated_at"),
    ).where(TransferOrder.is_deleted == 0)

    union_q = union_all(po_q, sub_q, mrp_q, tr_q).subquery()

    conditions = []
    if q.material_code:
        conditions.append(union_q.c.material_code == q.material_code)
    if q.supply_type:
        conditions.append(
            union_q.c.supply_type.in_([s.strip().upper() for s in q.supply_type.split(",") if s.strip()])
        )
    if q.supply_no:
        conditions.append(union_q.c.supply_no == q.supply_no)
    if q.expected_date_start:
        conditions.append(union_q.c.expected_available_date >= q.expected_date_start)
    if q.expected_date_end:
        conditions.append(union_q.c.expected_available_date <= q.expected_date_end)
    if q.updated_after:
        conditions.append(union_q.c.updated_at >= q.updated_after)

    base = select(union_q)
    for cond in conditions:
        base = base.where(cond)

    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
    rows = (
        await db.execute(
            base.order_by(
                union_q.c.expected_available_date.asc().nulls_last(),
                union_q.c.supply_no.asc(),
                union_q.c.supply_type.asc(),
                union_q.c.supply_line_no.asc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()

    items = [
        {
            "supply_type": r.supply_type,
            "supply_no": r.supply_no,
            "supply_line_no": str(r.supply_line_no) if r.supply_line_no is not None else None,
            "material_code": r.material_code,
            "material_name": r.material_name,
            "supply_qty": float(r.supply_qty) if r.supply_qty is not None else None,
            "available_qty": float(r.available_qty) if r.available_qty is not None else None,
            "expected_available_date": r.expected_available_date,
            "confirmed_available_date": r.confirmed_available_date,
            "supplier_code": r.supplier_code,
            "supplier_name": r.supplier_name,
            "supply_status": r.supply_status,
            "quality_status": r.quality_status,
        }
        for r in rows
    ]

    source_as_of = await load_source_as_of(db, _SUPPLY_SYNC_TYPES)
    data_as_of = min_as_of(source_as_of)
    confidence, stale = freshness_of(data_as_of)
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "data_as_of": data_as_of.isoformat() if data_as_of else None,
        "data_confidence": confidence,
        "stale": stale,
        "request_id": q.request_id,
    }
