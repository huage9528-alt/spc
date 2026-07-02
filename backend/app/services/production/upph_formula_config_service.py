from __future__ import annotations

from decimal import Decimal
from typing import Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.production.product_process_capacity import (
    ProductProcessCapacity,
    build_capacity_metadata_remark,
    parse_capacity_metadata,
    resolve_capacity_upph,
)
from app.models.production.upph_formula_config import UpphFormulaConfig


class UpphFormulaConfigService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def ensure_table(self) -> None:
        await self.db.execute(text("""
        CREATE TABLE IF NOT EXISTS production_upph_formula_config (
            id SERIAL PRIMARY KEY,
            workshop_name VARCHAR(64) NOT NULL,
            process_type VARCHAR(64) NOT NULL,
            manpower NUMERIC(10, 2) NOT NULL,
            hour_price NUMERIC(10, 2) NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            remark TEXT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_production_upph_formula_config UNIQUE (workshop_name, process_type)
        )
        """))
        await self.db.commit()

    async def list_configs(
        self,
        workshop_name: Optional[str] = None,
        process_type: Optional[str] = None,
        is_active: Optional[bool] = None,
    ) -> list[UpphFormulaConfig]:
        await self.ensure_table()
        stmt = select(UpphFormulaConfig).order_by(
            UpphFormulaConfig.workshop_name.asc(),
            UpphFormulaConfig.process_type.asc(),
            UpphFormulaConfig.id.asc(),
        )
        if workshop_name:
            stmt = stmt.where(UpphFormulaConfig.workshop_name.ilike(f"%{workshop_name}%"))
        if process_type:
            stmt = stmt.where(UpphFormulaConfig.process_type.ilike(f"%{process_type}%"))
        if is_active is not None:
            stmt = stmt.where(UpphFormulaConfig.is_active == is_active)
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def get_active_config_map(self) -> dict[tuple[str, str], UpphFormulaConfig]:
        configs = await self.list_configs(is_active=True)
        return {(item.workshop_name, item.process_type): item for item in configs}

    async def resolve_formula_inputs(
        self,
        workshop_name: Optional[str],
        process_type: Optional[str],
        config_map: Optional[dict[tuple[str, str], UpphFormulaConfig]] = None,
    ) -> tuple[float | None, float | None]:
        if not workshop_name:
            return None, None
        if config_map is None:
            config_map = await self.get_active_config_map()
        config = None
        if process_type:
            config = config_map.get((workshop_name, process_type))
        if config is None:
            config = config_map.get((workshop_name, "*"))
        if config is None:
            return None, None
        return float(config.manpower), float(config.hour_price)

    async def recalculate_capacities(
        self,
        workshop_name: Optional[str] = None,
        process_type: Optional[str] = None,
        reason: str = "UPPH 配置已更新",
    ) -> dict[str, int]:
        await self.ensure_table()
        config_map = await self.get_active_config_map()
        stmt = select(ProductProcessCapacity).where(ProductProcessCapacity.is_active == True)
        result = await self.db.execute(stmt)
        capacities = list(result.scalars().all())

        recalculated = 0
        updated = 0
        changed_product_codes: set[str] = set()

        for capacity in capacities:
            metadata = parse_capacity_metadata(capacity.remark)
            current_workshop_name = metadata.get("oa_workshop_name")
            current_process_type = capacity.process_type
            if workshop_name and current_workshop_name != workshop_name:
                continue
            if process_type and current_process_type != process_type:
                continue

            manpower, hour_price = await self.resolve_formula_inputs(
                current_workshop_name,
                current_process_type,
                config_map,
            )
            upph_result = resolve_capacity_upph(
                workshop_name=current_workshop_name,
                process_type=current_process_type,
                gjje=metadata.get("gjje"),
                oa_raw_upph=metadata.get("oa_raw_upph"),
                manpower=manpower,
                hour_price=hour_price,
                manual_upph=metadata.get("manual_upph"),
            )
            new_upph = Decimal(str(upph_result.get("effective_upph") or 0))
            new_remark = build_capacity_metadata_remark(
                oa_main_id=metadata.get("oa_main_id"),
                oa_workshop_id=metadata.get("oa_workshop_id"),
                oa_workshop_name=current_workshop_name,
                gjje=metadata.get("gjje"),
                oa_raw_upph=upph_result.get("oa_raw_upph"),
                formula_upph=upph_result.get("formula_upph"),
                effective_upph=upph_result.get("effective_upph"),
                manual_upph=upph_result.get("manual_upph"),
                upph_source=upph_result.get("upph_source"),
                manpower=upph_result.get("manpower"),
                hour_price=upph_result.get("hour_price"),
                raw_remark=metadata.get("raw_remark"),
            )
            recalculated += 1
            if capacity.upph != new_upph or capacity.remark != new_remark:
                capacity.upph = new_upph
                capacity.remark = new_remark
                self.db.add(capacity)
                updated += 1
                if capacity.product_code:
                    changed_product_codes.add(capacity.product_code)

        from app.services.production.product_process_capacity_sync_service import ProductProcessCapacitySyncService

        affected = await ProductProcessCapacitySyncService.mark_affected_schedule_plans(
            self.db,
            changed_product_codes,
            reason=reason,
        )
        await self.db.commit()
        return {
            "recalculated": recalculated,
            "updated": updated,
            "affected_schedule_plans_marked": affected,
        }
