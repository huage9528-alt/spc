from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker

from app.models.production.product_process_capacity import ProductProcessCapacity
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
from app.services.basicdata.erp_sync_service import ERPConnectionError

router = APIRouter()


@router.get("", response_model=ResponseModel[PageResult[ProductProcessCapacityOut]])
async def list_product_process_capacities(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    bom_code: Optional[str] = Query(None),
    product_code: Optional[str] = Query(None),
    process_type: Optional[str] = Query(None),
    is_active: Optional[bool] = Query(True),
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

    total = (await db.execute(select(func.count(ProductProcessCapacity.id)).where(*conditions))).scalar() or 0
    result = await db.execute(
        select(ProductProcessCapacity)
        .where(*conditions)
        .order_by(ProductProcessCapacity.product_code.asc(), ProductProcessCapacity.process_type.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    items = [ProductProcessCapacityOut.model_validate(row) for row in result.scalars().all()]
    return ResponseModel(data=PageResult(total=total, page=page, page_size=page_size, items=items))


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

    record = ProductProcessCapacity(**data.model_dump())
    db.add(record)
    await db.flush()
    await log_audit(db, "product_process_capacity", record.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(record)
    return ResponseModel(data=ProductProcessCapacityOut.model_validate(record))


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
    for key, value in update_data.items():
        setattr(record, key, value)

    db.add(record)
    await db.flush()
    await log_audit(db, "product_process_capacity", record.id, "update", operator=current_user["username"])
    await db.commit()
    await db.refresh(record)
    return ResponseModel(data=ProductProcessCapacityOut.model_validate(record))


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
