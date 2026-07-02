from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.database import get_db
from app.core.security import PermissionChecker
from app.models.production.upph_formula_config import UpphFormulaConfig
from app.schemas.common import ResponseModel
from app.schemas.production.schemas import (
    UpphFormulaConfigCreate,
    UpphFormulaConfigOut,
    UpphFormulaConfigUpdate,
    UpphFormulaRecalculateResult,
)
from app.services.production.upph_formula_config_service import UpphFormulaConfigService

router = APIRouter()


@router.get("", response_model=ResponseModel[list[UpphFormulaConfigOut]])
async def list_upph_formula_configs(
    workshop_name: Optional[str] = Query(None),
    process_type: Optional[str] = Query(None),
    is_active: Optional[bool] = Query(None),
    current_user: dict = Depends(PermissionChecker("production.product_process_capacities", "read")),
    db: AsyncSession = Depends(get_db),
):
    service = UpphFormulaConfigService(db)
    items = await service.list_configs(
        workshop_name=workshop_name,
        process_type=process_type,
        is_active=is_active,
    )
    return ResponseModel(data=[UpphFormulaConfigOut.model_validate(item) for item in items])


@router.post("", response_model=ResponseModel[UpphFormulaConfigOut])
async def create_upph_formula_config(
    data: UpphFormulaConfigCreate,
    current_user: dict = Depends(PermissionChecker("production.product_process_capacities", "update")),
    db: AsyncSession = Depends(get_db),
):
    service = UpphFormulaConfigService(db)
    await service.ensure_table()
    existing = await db.execute(
        select(UpphFormulaConfig).where(
            UpphFormulaConfig.workshop_name == data.workshop_name,
            UpphFormulaConfig.process_type == data.process_type,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="该车间工序配置已存在")

    record = UpphFormulaConfig(**data.model_dump())
    db.add(record)
    await db.flush()
    await log_audit(db, "production_upph_formula_config", record.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(record)
    await service.recalculate_capacities(
        workshop_name=record.workshop_name,
        process_type=None if record.process_type == "*" else record.process_type,
        reason="UPPH 配置已新增",
    )
    return ResponseModel(data=UpphFormulaConfigOut.model_validate(record))


@router.put("/{config_id}", response_model=ResponseModel[UpphFormulaConfigOut])
async def update_upph_formula_config(
    config_id: int,
    data: UpphFormulaConfigUpdate,
    current_user: dict = Depends(PermissionChecker("production.product_process_capacities", "update")),
    db: AsyncSession = Depends(get_db),
):
    service = UpphFormulaConfigService(db)
    await service.ensure_table()
    record = await db.get(UpphFormulaConfig, config_id)
    if not record:
        raise HTTPException(status_code=404, detail="UPPH 配置不存在")

    old_workshop = record.workshop_name
    old_process = record.process_type
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(record, key, value)
    db.add(record)
    await db.flush()
    await log_audit(db, "production_upph_formula_config", record.id, "update", operator=current_user["username"])
    await db.commit()
    await db.refresh(record)

    await service.recalculate_capacities(
        workshop_name=old_workshop,
        process_type=None if old_process == "*" else old_process,
        reason="UPPH 配置已更新",
    )
    if (record.workshop_name, record.process_type) != (old_workshop, old_process):
        await service.recalculate_capacities(
            workshop_name=record.workshop_name,
            process_type=None if record.process_type == "*" else record.process_type,
            reason="UPPH 配置已更新",
        )
    return ResponseModel(data=UpphFormulaConfigOut.model_validate(record))


@router.delete("/{config_id}", response_model=ResponseModel[UpphFormulaRecalculateResult])
async def delete_upph_formula_config(
    config_id: int,
    current_user: dict = Depends(PermissionChecker("production.product_process_capacities", "update")),
    db: AsyncSession = Depends(get_db),
):
    service = UpphFormulaConfigService(db)
    await service.ensure_table()
    record = await db.get(UpphFormulaConfig, config_id)
    if not record:
        raise HTTPException(status_code=404, detail="UPPH 配置不存在")

    workshop_name = record.workshop_name
    process_type = record.process_type
    await log_audit(db, "production_upph_formula_config", record.id, "delete", operator=current_user["username"])
    await db.delete(record)
    await db.commit()
    result = await service.recalculate_capacities(
        workshop_name=workshop_name,
        process_type=None if process_type == "*" else process_type,
        reason="UPPH 配置已删除",
    )
    return ResponseModel(data=UpphFormulaRecalculateResult.model_validate(result))
