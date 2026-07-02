from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker

from app.models.production.product_process_capacity import (
    ProductProcessCapacity,
    build_capacity_metadata_remark,
    parse_capacity_metadata,
    resolve_capacity_upph,
)
from app.schemas.common import PageResult, ResponseModel
from app.schemas.production.schemas import (
    ProductProcessCapacityOut,
    ProductProcessCapacityCreate,
    ProductProcessCapacityUpdate,
    ProductProcessCapacitySyncResult,
)
from app.core.audit import log_audit
from app.services.production.product_process_capacity_sync_service import (
    ProductProcessCapacitySyncService,
)
from app.services.production.upph_formula_config_service import UpphFormulaConfigService
from app.services.basicdata.erp_sync_service import ERPConnectionError

router = APIRouter()


def _compose_capacity_metadata(
    *,
    existing_remark: str | None,
    process_type: str | None,
    config_manpower: float | None = None,
    config_hour_price: float | None = None,
    raw_remark: str | None = None,
    manpower: float | None = None,
    hour_price: float | None = None,
    manual_upph: float | None = None,
) -> tuple[dict, str]:
    metadata = parse_capacity_metadata(existing_remark)
    raw_remark_value = metadata.get("raw_remark") if raw_remark is None else raw_remark
    manpower_value = config_manpower if manpower is None else manpower
    hour_price_value = config_hour_price if hour_price is None else hour_price
    if manpower_value is None:
        manpower_value = metadata.get("manpower")
    if hour_price_value is None:
        hour_price_value = metadata.get("hour_price")
    manual_upph_value = metadata.get("manual_upph") if manual_upph is None else manual_upph

    upph_result = resolve_capacity_upph(
        workshop_name=metadata.get("oa_workshop_name"),
        process_type=process_type,
        gjje=metadata.get("gjje"),
        oa_raw_upph=metadata.get("oa_raw_upph"),
        manpower=manpower_value,
        hour_price=hour_price_value,
        manual_upph=manual_upph_value,
    )
    remark = build_capacity_metadata_remark(
        oa_main_id=metadata.get("oa_main_id"),
        oa_workshop_id=metadata.get("oa_workshop_id"),
        oa_workshop_name=metadata.get("oa_workshop_name"),
        gjje=metadata.get("gjje"),
        oa_raw_upph=upph_result.get("oa_raw_upph"),
        formula_upph=upph_result.get("formula_upph"),
        effective_upph=upph_result.get("effective_upph"),
        manual_upph=upph_result.get("manual_upph"),
        upph_source=upph_result.get("upph_source"),
        manpower=upph_result.get("manpower"),
        hour_price=upph_result.get("hour_price"),
        raw_remark=raw_remark_value,
    )
    return upph_result, remark


def _serialize_capacity(record: ProductProcessCapacity) -> ProductProcessCapacityOut:
    metadata = parse_capacity_metadata(record.remark)
    return ProductProcessCapacityOut(
        id=record.id,
        oa_detail_id=record.oa_detail_id,
        bom_code=record.bom_code,
        product_code=record.product_code,
        product_name=record.product_name,
        oa_workshop_id=metadata.get("oa_workshop_id"),
        oa_workshop_name=metadata.get("oa_workshop_name"),
        process_type=record.process_type,
        gjje=metadata.get("gjje"),
        manpower=metadata.get("manpower"),
        hour_price=metadata.get("hour_price"),
        oa_raw_upph=metadata.get("oa_raw_upph"),
        formula_upph=metadata.get("formula_upph"),
        manual_upph=metadata.get("manual_upph"),
        upph_source=metadata.get("upph_source"),
        upph=float(record.upph or 0),
        is_schedulable=bool(metadata.get("is_schedulable", True)),
        exclude_reason=metadata.get("exclude_reason"),
        source=record.source,
        sync_batch_no=record.sync_batch_no,
        last_sync_time=record.last_sync_time,
        is_active=bool(record.is_active),
        remark=metadata.get("raw_remark"),
        updated_at=record.updated_at,
    )


def _resolve_workshop_tab(item: ProductProcessCapacityOut) -> str:
    workshop = item.oa_workshop_name or ""
    process_type = item.process_type or ""
    is_assembly_process = process_type in {"组装", "组装前加工"}
    is_packaging_process = process_type in {"包装", "包装前加工"}

    if workshop == "精益车间":
        return "lean"
    if workshop == "装配车间" and is_assembly_process:
        return "assembly"
    if workshop == "装配车间" and is_packaging_process:
        return "packaging"
    return "others"


@router.get("", response_model=ResponseModel[PageResult[ProductProcessCapacityOut]])
async def list_product_process_capacities(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    bom_code: Optional[str] = Query(None),
    product_code: Optional[str] = Query(None),
    process_type: Optional[str] = Query(None),
    workshop_tab: Optional[str] = Query(None, pattern="^(lean|assembly|packaging|others)$"),
    is_active: Optional[bool] = Query(True),
    schedulable: Optional[bool] = Query(None),
    current_user: dict = Depends(PermissionChecker("production.product_process_capacities", "read")),
    db: AsyncSession = Depends(get_db),
):
    """获取产品工序产能列表"""
    conditions = []
    if bom_code:
        conditions.append(ProductProcessCapacity.bom_code.ilike(f"%{bom_code}%"))
    if product_code:
        conditions.append(ProductProcessCapacity.product_code.ilike(f"%{product_code}%"))
    if process_type:
        conditions.append(ProductProcessCapacity.process_type == process_type)
    if is_active is not None:
        conditions.append(ProductProcessCapacity.is_active == is_active)

    result = await db.execute(
        select(ProductProcessCapacity)
        .where(*conditions)
        .order_by(ProductProcessCapacity.product_code.asc(), ProductProcessCapacity.process_type.asc())
    )
    all_items = [_serialize_capacity(row) for row in result.scalars().all()]
    if schedulable is not None:
        all_items = [item for item in all_items if item.is_schedulable == schedulable]

    stats = {
        "all": len(all_items),
        "lean": 0,
        "assembly": 0,
        "packaging": 0,
        "others": 0,
    }
    for item in all_items:
        stats[_resolve_workshop_tab(item)] += 1

    filtered_items = all_items
    if workshop_tab:
        filtered_items = [item for item in all_items if _resolve_workshop_tab(item) == workshop_tab]

    total = len(filtered_items)
    start = (page - 1) * page_size
    end = start + page_size
    items = filtered_items[start:end]
    return ResponseModel(data=PageResult(total=total, page=page, page_size=page_size, items=items, stats=stats))


@router.post("", response_model=ResponseModel[ProductProcessCapacityOut])
async def create_product_process_capacity(
    data: ProductProcessCapacityCreate,
    current_user: dict = Depends(PermissionChecker("production.product_process_capacities", "create")),
    db: AsyncSession = Depends(get_db),
):
    """创建产品工序产能"""
    # 第一阶段先按 BOM编码+工序 或 产品编码+工序 做幂等保护
    duplicate_conditions = [ProductProcessCapacity.process_type == data.process_type]
    if data.bom_code:
        duplicate_conditions.append(ProductProcessCapacity.bom_code == data.bom_code)
    else:
        duplicate_conditions.append(ProductProcessCapacity.product_code == data.product_code)

    existing = await db.execute(
        select(ProductProcessCapacity).where(and_(*duplicate_conditions))
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="该产品工序产能已存在")

    config_service = UpphFormulaConfigService(db)
    await config_service.ensure_table()
    config_manpower, config_hour_price = await config_service.resolve_formula_inputs(None, data.process_type)
    upph_result, remark = _compose_capacity_metadata(
        existing_remark=data.remark,
        process_type=data.process_type,
        config_manpower=config_manpower,
        config_hour_price=config_hour_price,
        raw_remark=data.remark,
        manpower=data.manpower,
        hour_price=data.hour_price,
        manual_upph=data.upph,
    )
    payload = data.model_dump(exclude={"upph", "manpower", "hour_price", "remark"})
    record = ProductProcessCapacity(
        **payload,
        upph=upph_result.get("effective_upph") or 0,
        remark=remark,
    )
    db.add(record)
    await db.flush()
    await log_audit(db, "product_process_capacity", record.id, "create", operator=current_user["username"])
    if record.product_code:
        await ProductProcessCapacitySyncService.mark_affected_schedule_plans(
            db,
            {record.product_code},
            reason="UPPH 数据已新增或更新",
        )
    await db.commit()
    await db.refresh(record)
    return ResponseModel(data=_serialize_capacity(record))


@router.post("/sync-oa", response_model=ResponseModel[ProductProcessCapacitySyncResult])
async def sync_product_process_capacities_from_oa(
    current_user: dict = Depends(PermissionChecker("production.product_process_capacities", "update")),
    db: AsyncSession = Depends(get_db),
):
    """手动从 OA 同步产品工序产能。"""
    service = ProductProcessCapacitySyncService(db)
    try:
        result = await service.sync_from_oa()
    except ERPConnectionError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    await log_audit(
        db,
        "product_process_capacity",
        0,
        "sync",
        field_name="oa_sync",
        new_value=str(result),
        operator=current_user["username"],
    )
    await db.commit()
    return ResponseModel(data=ProductProcessCapacitySyncResult.model_validate(result))


@router.put("/{capacity_id}", response_model=ResponseModel[ProductProcessCapacityOut])
async def update_product_process_capacity(
    capacity_id: int,
    data: ProductProcessCapacityUpdate,
    current_user: dict = Depends(PermissionChecker("production.product_process_capacities", "update")),
    db: AsyncSession = Depends(get_db),
):
    """更新产品工序产能"""
    record = await db.get(ProductProcessCapacity, capacity_id)
    if not record:
        raise HTTPException(status_code=404, detail="产品工序产能不存在")

    update_data = data.model_dump(exclude_unset=True)
    old_product_code = record.product_code
    old_upph = float(record.upph or 0)
    metadata = parse_capacity_metadata(record.remark)
    config_service = UpphFormulaConfigService(db)
    await config_service.ensure_table()
    current_workshop_name = metadata.get("oa_workshop_name")
    config_manpower, config_hour_price = await config_service.resolve_formula_inputs(
        current_workshop_name,
        update_data.get("process_type", record.process_type),
    )
    upph_result, remark = _compose_capacity_metadata(
        existing_remark=record.remark,
        process_type=update_data.get("process_type", record.process_type),
        config_manpower=config_manpower,
        config_hour_price=config_hour_price,
        raw_remark=update_data.pop("remark", metadata.get("raw_remark")),
        manpower=update_data.pop("manpower", metadata.get("manpower")),
        hour_price=update_data.pop("hour_price", metadata.get("hour_price")),
        manual_upph=update_data.pop("upph", metadata.get("manual_upph")),
    )
    for key, value in update_data.items():
        setattr(record, key, value)
    record.upph = upph_result.get("effective_upph") or 0
    record.remark = remark

    db.add(record)
    await db.flush()
    await log_audit(db, "product_process_capacity", record.id, "update", operator=current_user["username"])
    if abs(float(record.upph or 0) - old_upph) > 0.0001:
        await ProductProcessCapacitySyncService.mark_affected_schedule_plans(
            db,
            {code for code in {old_product_code, record.product_code} if code},
            reason="UPPH 参数已更新",
        )
    await db.commit()
    await db.refresh(record)
    return ResponseModel(data=_serialize_capacity(record))


@router.delete("/{capacity_id}", response_model=ResponseModel[dict])
async def delete_product_process_capacity(
    capacity_id: int,
    current_user: dict = Depends(PermissionChecker("production.product_process_capacities", "delete")),
    db: AsyncSession = Depends(get_db),
):
    """软删除产品工序产能"""
    record = await db.get(ProductProcessCapacity, capacity_id)
    if not record:
        raise HTTPException(status_code=404, detail="产品工序产能不存在")

    record.is_active = False
    db.add(record)
    await db.flush()
    await log_audit(db, "product_process_capacity", capacity_id, "delete", operator=current_user["username"])
    await db.commit()
    return ResponseModel(data={"deleted": capacity_id})
