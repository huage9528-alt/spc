from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.production.base_condition import ProductionBaseCondition
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

# 基础条件支持的排产阶段
BASE_CONDITION_BUCKETS = ["lean", "assembly", "packaging", "mixed"]
BASE_CONDITION_BUCKET_LABELS = {
    "lean": "精益",
    "assembly": "组装",
    "packaging": "包装",
    "mixed": "混合",
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

    # ---------------- 基础条件 (车间排产默认) ----------------

    async def get_base_conditions(self) -> list[dict]:
        """读取所有排产阶段的基础条件 (人数/工时/周日排产).

        缺失的桶自动补默认行 (内存返回, 不落库).
        """
        result = await self.db.execute(
            select(ProductionBaseCondition).where(
                ProductionBaseCondition.is_active == True
            ).order_by(ProductionBaseCondition.schedule_bucket)
        )
        rows = {r.schedule_bucket: r for r in result.scalars().all()}

        out: list[dict] = []
        for bucket in BASE_CONDITION_BUCKETS:
            row = rows.get(bucket)
            if row:
                out.append({
                    "schedule_bucket": row.schedule_bucket,
                    "bucket_label": row.bucket_label or BASE_CONDITION_BUCKET_LABELS.get(bucket, bucket),
                    "default_manpower": int(row.default_manpower or 10),
                    "daily_work_hours": float(row.daily_work_hours or 8),
                    "include_sunday": bool(row.include_sunday),
                })
            else:
                out.append({
                    "schedule_bucket": bucket,
                    "bucket_label": BASE_CONDITION_BUCKET_LABELS.get(bucket, bucket),
                    "default_manpower": 10,
                    "daily_work_hours": 8.0,
                    "include_sunday": False,
                })
        return out

    async def get_base_condition(self, schedule_bucket: Optional[str]) -> dict:
        """取单个桶的基础条件, 缺失返回安全默认."""
        if not schedule_bucket or schedule_bucket not in BASE_CONDITION_BUCKETS:
            return {"default_manpower": 10, "daily_work_hours": 8.0, "include_sunday": False}
        result = await self.db.execute(
            select(ProductionBaseCondition).where(
                ProductionBaseCondition.schedule_bucket == schedule_bucket,
                ProductionBaseCondition.is_active == True,
            )
        )
        row = result.scalars().first()
        if not row:
            return {"default_manpower": 10, "daily_work_hours": 8.0, "include_sunday": False}
        return {
            "default_manpower": int(row.default_manpower or 10),
            "daily_work_hours": float(row.daily_work_hours or 8),
            "include_sunday": bool(row.include_sunday),
        }

    async def save_base_conditions(self, items: list[dict], operator: Optional[str] = None) -> None:
        """保存基础条件 (按 schedule_bucket upsert).

        items: [{ schedule_bucket, default_manpower, daily_work_hours, include_sunday }, ...]
        """
        for it in items:
            bucket = it.get("schedule_bucket")
            if not bucket or bucket not in BASE_CONDITION_BUCKETS:
                continue
            result = await self.db.execute(
                select(ProductionBaseCondition).where(
                    ProductionBaseCondition.schedule_bucket == bucket
                )
            )
            row = result.scalars().first()
            manpower = int(it.get("default_manpower") or 10)
            hours = float(it.get("daily_work_hours") or 8)
            # 工时 clamp 到 [1, 24], 人数 clamp 到 [1, 200]
            manpower = max(1, min(manpower, 200))
            hours = max(1.0, min(hours, 24.0))
            sunday = bool(it.get("include_sunday"))
            if row:
                row.default_manpower = manpower
                row.daily_work_hours = hours
                row.include_sunday = sunday
                row.bucket_label = BASE_CONDITION_BUCKET_LABELS.get(bucket, row.bucket_label)
            else:
                self.db.add(ProductionBaseCondition(
                    schedule_bucket=bucket,
                    bucket_label=BASE_CONDITION_BUCKET_LABELS.get(bucket, bucket),
                    default_manpower=manpower,
                    daily_work_hours=hours,
                    include_sunday=sunday,
                    is_active=True,
                    created_by=operator,
                ))
