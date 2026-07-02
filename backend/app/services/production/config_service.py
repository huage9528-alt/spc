from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.rules.node_standard import NodeStandard

READY_OFFSET_DAYS = 2
LEAN_STANDARD_DAILY_HOURS = 8.5
LEAN_MAX_DAILY_HOURS = 12.0

SCHEDULE_BUCKET_WORK_HOUR_CODES = {
    "lean": "daily_work_hours_lean",
    "assembly": "daily_work_hours_assembly",
    "packaging": "daily_work_hours_packaging",
    "mixed": "daily_work_hours_mixed",
    "pending": "daily_work_hours_pending",
}

LEAN_CAPACITY_LOAD_LABELS = {
    "normal": "正常",
    "overtime": "需加班",
    "sunday_production": "周日生产",
    "move_earlier": "需前挪",
}


class ProductionScheduleConfigService:
    """一期规则先写死，但统一通过服务读取，便于后续配置化扩展。"""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_work_hours_config(self) -> dict:
        config_codes = ["daily_work_hours", *SCHEDULE_BUCKET_WORK_HOUR_CODES.values()]
        config_result = await self.db.execute(
            select(NodeStandard).where(
                NodeStandard.node_code.in_(config_codes),
                NodeStandard.is_active == True,
            )
        )
        config_map = {item.node_code: item for item in config_result.scalars().all()}
        default_item = config_map.get("daily_work_hours")
        default_daily_work_hours = float(default_item.time_value) if default_item else 8
        work_hours_by_bucket = {
            bucket: (
                float(config_map[config_code].time_value)
                if config_map.get(config_code)
                else default_daily_work_hours
            )
            for bucket, config_code in SCHEDULE_BUCKET_WORK_HOUR_CODES.items()
        }
        return {
            "default_daily_work_hours": default_daily_work_hours,
            "work_hours_by_bucket": work_hours_by_bucket,
            "lean_standard_daily_hours": LEAN_STANDARD_DAILY_HOURS,
            "lean_max_daily_hours": LEAN_MAX_DAILY_HOURS,
            "ready_offset_days": READY_OFFSET_DAYS,
        }

    async def get_default_daily_work_hours(self, schedule_bucket: Optional[str] = None) -> float:
        work_hours_config = await self.get_work_hours_config()
        if schedule_bucket:
            return float(
                work_hours_config["work_hours_by_bucket"].get(
                    schedule_bucket,
                    work_hours_config["default_daily_work_hours"],
                )
            )
        return float(work_hours_config["default_daily_work_hours"])
