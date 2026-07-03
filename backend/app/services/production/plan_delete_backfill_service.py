from datetime import date, timedelta
import logging
from time import perf_counter
from typing import Optional

from sqlalchemy import and_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.order.sale_order import SaleOrderLine
from app.models.production.schedule_plan import ProductionSchedulePlan
from app.schemas.production.schemas import ProductionSchedulePlanCreate
from app.services.production.upph_calculation_service import UpphCalculationService

logger = logging.getLogger(__name__)
KNOWN_SCHEDULE_BUCKETS = {"lean", "assembly", "packaging", "mixed", "pending"}


class PlanDeleteAndBackfillService:
    """一期先收敛为：删除计划后识别释放窗口，并给出按 plan_date 顺延的候选补位预览。"""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.upph_service = UpphCalculationService(db)

    @staticmethod
    def get_order_line_bom_code(order_line) -> Optional[str]:
        return getattr(order_line, "bom_no", None) or getattr(order_line, "bom_code", None)

    @staticmethod
    def get_plan_source_bucket(plan: ProductionSchedulePlan) -> Optional[str]:
        normalized = str(getattr(plan, "source_process_type", None) or "").strip()
        if normalized in KNOWN_SCHEDULE_BUCKETS:
            return normalized
        return None

    @classmethod
    def build_line_schedule_bucket_map(
        cls,
        plans: list[ProductionSchedulePlan],
    ) -> dict[tuple[str, str], str]:
        stage_map: dict[tuple[str, str], set[str]] = {}
        direct_bucket_map: dict[tuple[str, str], str] = {}
        for plan in plans:
            if not plan.order_no or not plan.line_no:
                continue
            key = (str(plan.order_no), str(plan.line_no))
            bucket = cls.get_plan_source_bucket(plan)
            if bucket in {"assembly", "packaging"}:
                stage_map.setdefault(key, set()).add(bucket)
            elif bucket:
                direct_bucket_map[key] = bucket

        result: dict[tuple[str, str], str] = {}
        for key in set(stage_map.keys()) | set(direct_bucket_map.keys()):
            direct_bucket = direct_bucket_map.get(key)
            if direct_bucket in {"lean", "mixed", "pending"}:
                result[key] = direct_bucket
                continue
            stages = stage_map.get(key, set())
            if "assembly" in stages and "packaging" in stages:
                result[key] = "mixed"
            elif len(stages) == 1:
                result[key] = next(iter(stages))
        return result

    @classmethod
    def get_plan_fast_schedule_bucket(
        cls,
        plan: ProductionSchedulePlan,
        line_bucket_map: dict[tuple[str, str], str],
    ) -> Optional[str]:
        if plan.order_no and plan.line_no:
            derived_bucket = line_bucket_map.get((str(plan.order_no), str(plan.line_no)))
            if derived_bucket:
                return derived_bucket
        return cls.get_plan_source_bucket(plan)

    async def get_latest_sale_order_line(
        self,
        order_no: Optional[str],
        line_no: Optional[str],
    ) -> Optional[SaleOrderLine]:
        if not order_no or not line_no:
            return None
        result = await self.db.execute(
            select(SaleOrderLine)
            .where(
                and_(
                    SaleOrderLine.order_no == order_no,
                    SaleOrderLine.line_no == line_no,
                )
            )
            .order_by(SaleOrderLine.id.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def get_latest_sale_order_line_map(
        self,
        keys: set[tuple[str, str]],
    ) -> dict[tuple[str, str], SaleOrderLine]:
        if not keys:
            return {}
        latest_line_subq = (
            select(
                SaleOrderLine.order_no,
                SaleOrderLine.line_no,
                SaleOrderLine.id.label("line_id"),
            )
            .where(tuple_(SaleOrderLine.order_no, SaleOrderLine.line_no).in_(list(keys)))
            .distinct(SaleOrderLine.order_no, SaleOrderLine.line_no)
            .order_by(
                SaleOrderLine.order_no.asc(),
                SaleOrderLine.line_no.asc(),
                SaleOrderLine.id.desc(),
            )
            .subquery()
        )
        result = await self.db.execute(
            select(SaleOrderLine)
            .join(
                latest_line_subq,
                SaleOrderLine.id == latest_line_subq.c.line_id,
            )
        )
        return {
            (row.order_no, row.line_no): row
            for row in result.scalars().all()
        }

    async def get_active_line_schedule_bucket_map(
        self,
        keys: set[tuple[str, str]],
    ) -> dict[tuple[str, str], str]:
        if not keys:
            return {}
        result = await self.db.execute(
            select(
                ProductionSchedulePlan.order_no,
                ProductionSchedulePlan.line_no,
                ProductionSchedulePlan.source_process_type,
            )
            .where(
                ProductionSchedulePlan.is_active == True,
                tuple_(ProductionSchedulePlan.order_no, ProductionSchedulePlan.line_no).in_(list(keys)),
            )
        )
        plans = [
            ProductionSchedulePlan(
                order_no=row.order_no,
                line_no=row.line_no,
                source_process_type=row.source_process_type,
            )
            for row in result.all()
            if row.order_no and row.line_no
        ]
        return self.build_line_schedule_bucket_map(plans)

    async def resolve_plan_schedule_context(
        self,
        plan: ProductionSchedulePlan,
        *,
        order_line_map: Optional[dict[tuple[str, str], SaleOrderLine]] = None,
        schedule_context_cache: Optional[dict[tuple[str, str], dict]] = None,
    ) -> dict:
        order_line = None
        if plan.order_no and plan.line_no and order_line_map is not None:
            order_line = order_line_map.get((plan.order_no, plan.line_no))
        if order_line is None:
            order_line = await self.get_latest_sale_order_line(plan.order_no, plan.line_no)
        product_code = (
            getattr(order_line, "product_code", None)
            or plan.product_code
            or plan.source_product_code
        )
        bom_code = self.get_order_line_bom_code(order_line) if order_line else None
        cache_key = (str(product_code or ""), str(bom_code or ""))
        if schedule_context_cache is not None and cache_key in schedule_context_cache:
            return schedule_context_cache[cache_key]
        if not product_code and not bom_code:
            summary = {
                "schedule_bucket": "pending",
                "total_upph": None,
            }
        else:
            summary = await self.upph_service.summarize_schedule_context(
                product_code=product_code,
                bom_code=bom_code,
            )
        if schedule_context_cache is not None:
            schedule_context_cache[cache_key] = summary
        return summary

    @staticmethod
    def can_participate_backfill(plan: ProductionSchedulePlan) -> bool:
        if not plan.is_active:
            return False
        if plan.status != "planned":
            return False
        if plan.locked_by:
            return False
        return True

    @staticmethod
    def get_earliest_backfill_plan_date(reference_date: Optional[date] = None) -> date:
        # Backfill must not move plans into already elapsed dates.
        earliest_allowed_date = date.today()
        if earliest_allowed_date.weekday() == 6:
            earliest_allowed_date += timedelta(days=1)
        if reference_date and reference_date > earliest_allowed_date:
            return reference_date
        return earliest_allowed_date

    async def build_delete_preview(
        self,
        plan: ProductionSchedulePlan,
    ) -> dict:
        preview_started_at = perf_counter()
        original_release_plan_date = plan.plan_date
        earliest_backfill_date = self.get_earliest_backfill_plan_date(original_release_plan_date)
        candidate_from_date = earliest_backfill_date
        if original_release_plan_date and original_release_plan_date > candidate_from_date:
            candidate_from_date = original_release_plan_date
        query_started_at = perf_counter()
        result = await self.db.execute(
            select(ProductionSchedulePlan)
            .where(
                ProductionSchedulePlan.is_active == True,
                ProductionSchedulePlan.department == plan.department,
                ProductionSchedulePlan.id != plan.id,
                ProductionSchedulePlan.status == "planned",
                ProductionSchedulePlan.locked_by.is_(None),
                ProductionSchedulePlan.plan_date >= candidate_from_date,
            )
            .order_by(ProductionSchedulePlan.plan_date.asc(), ProductionSchedulePlan.id.asc())
        )
        candidate_plans = list(result.scalars().all())
        candidate_query_ms = round((perf_counter() - query_started_at) * 1000, 2)

        line_bucket_map = await self.get_active_line_schedule_bucket_map(
            {
                (str(item.order_no), str(item.line_no))
                for item in [plan, *candidate_plans]
                if item.order_no and item.line_no
            }
        )
        release_bucket = self.get_plan_fast_schedule_bucket(plan, line_bucket_map)
        candidate_bucket_map = {
            int(candidate.id): self.get_plan_fast_schedule_bucket(candidate, line_bucket_map)
            for candidate in candidate_plans
            if candidate.id is not None
        }
        needs_context_resolution = release_bucket is None or any(
            bucket is None for bucket in candidate_bucket_map.values()
        )

        order_line_map: dict[tuple[str, str], SaleOrderLine] = {}
        order_line_prefetch_ms = 0.0
        if needs_context_resolution:
            prefetch_started_at = perf_counter()
            order_line_map = await self.get_latest_sale_order_line_map(
                {
                    (item.order_no, item.line_no)
                    for item in [plan, *candidate_plans]
                    if item.order_no and item.line_no
                }
            )
            order_line_prefetch_ms = round((perf_counter() - prefetch_started_at) * 1000, 2)
        schedule_context_cache: dict[tuple[str, str], dict] = {}

        release_context_ms = 0.0
        if release_bucket is None:
            release_context_started_at = perf_counter()
            schedule_context = await self.resolve_plan_schedule_context(
                plan,
                order_line_map=order_line_map,
                schedule_context_cache=schedule_context_cache,
            )
            release_context_ms = round((perf_counter() - release_context_started_at) * 1000, 2)
            release_bucket = schedule_context.get("schedule_bucket")

        next_available_plan_date = earliest_backfill_date
        items: list[dict] = []
        affected_plan_ids: list[int] = []
        context_query_count = 0
        loop_started_at = perf_counter()

        for candidate in candidate_plans:
            if not self.can_participate_backfill(candidate):
                continue
            candidate_bucket = candidate_bucket_map.get(int(candidate.id)) if candidate.id is not None else None
            if candidate_bucket is None:
                context_query_count += 1
                candidate_context = await self.resolve_plan_schedule_context(
                    candidate,
                    order_line_map=order_line_map,
                    schedule_context_cache=schedule_context_cache,
                )
                candidate_bucket = candidate_context.get("schedule_bucket")
            if candidate_bucket != release_bucket:
                continue
            if not candidate.plan_date or candidate.plan_date <= next_available_plan_date:
                continue

            items.append({
                "plan_id": candidate.id,
                "order_no": candidate.order_no,
                "line_no": candidate.line_no,
                "current_plan_date": candidate.plan_date,
                "suggested_plan_date": next_available_plan_date,
                "current_start_date": candidate.start_date,
                "current_end_date": candidate.end_date,
                "schedule_bucket": candidate_bucket,
            })
            affected_plan_ids.append(candidate.id)
            next_available_plan_date = candidate.plan_date

        logger.warning(
            "delete-preview timing plan_id=%s release_bucket=%s candidate_total=%s context_queries=%s timings_ms=%s",
            plan.id,
            release_bucket,
            len(candidate_plans),
            context_query_count,
            {
                "candidate_query": candidate_query_ms,
                "order_line_prefetch": order_line_prefetch_ms,
                "release_context": release_context_ms,
                "candidate_loop": round((perf_counter() - loop_started_at) * 1000, 2),
                "fast_path_candidates": sum(1 for bucket in candidate_bucket_map.values() if bucket is not None),
                "unique_schedule_contexts": len(schedule_context_cache),
                "total": round((perf_counter() - preview_started_at) * 1000, 2),
            },
        )

        return {
            "release_plan_date": original_release_plan_date,
            "earliest_backfill_date": earliest_backfill_date,
            "release_bucket": release_bucket,
            "affected_count": len(items),
            "affected_plan_ids": affected_plan_ids,
            "items": items,
        }

    async def execute_backfill(
        self,
        *,
        items: list[dict],
        operator: str,
        remark: Optional[str] = None,
    ) -> list[dict]:
        results: list[dict] = []
        for item in items:
            plan_id = item.get("plan_id")
            suggested_plan_date = item.get("suggested_plan_date")
            earliest_allowed_date = self.get_earliest_backfill_plan_date()
            old_plan = await self.db.get(ProductionSchedulePlan, plan_id)
            if not old_plan:
                results.append({
                    "old_plan_id": plan_id,
                    "success": False,
                    "message": "原计划不存在",
                })
                continue
            if not suggested_plan_date:
                results.append({
                    "old_plan_id": plan_id,
                    "success": False,
                    "message": "缺少建议计划日",
                })
                continue
            if suggested_plan_date < earliest_allowed_date:
                suggested_plan_date = earliest_allowed_date

            duration_days = 0
            if old_plan.start_date and old_plan.end_date:
                duration_days = max((old_plan.end_date - old_plan.start_date).days, 0)
            new_start_date = suggested_plan_date
            new_end_date = suggested_plan_date + timedelta(days=duration_days)
            new_plan_version = int(old_plan.plan_version or 1) + 1
            new_schedule_data = ProductionSchedulePlanCreate(
                department=old_plan.department,
                plan_date=suggested_plan_date,
                order_no=old_plan.order_no,
                line_no=old_plan.line_no,
                product_code=old_plan.product_code,
                model_code=old_plan.model_code,
                quantity=float(old_plan.quantity or 0),
                owner=old_plan.owner,
                start_date=new_start_date,
                end_date=new_end_date,
                priority=old_plan.priority,
                status=old_plan.status,
                upph=float(old_plan.upph or 0) if old_plan.upph is not None else None,
                daily_work_hours=float(old_plan.daily_work_hours or 0) if old_plan.daily_work_hours is not None else None,
                remark=(f"删除补位前滚：{remark}" if remark else "删除补位前滚"),
                plan_version=new_plan_version,
                is_active=True,
                source_promised_date=old_plan.source_promised_date,
                source_order_qty=float(old_plan.source_order_qty or 0) if old_plan.source_order_qty is not None else None,
                source_product_code=old_plan.source_product_code,
                source_product_model=old_plan.source_product_model,
                source_upph=float(old_plan.source_upph or 0) if old_plan.source_upph is not None else None,
                source_process_type=old_plan.source_process_type,
                previous_plan_id=old_plan.id,
                needs_reschedule=False,
                reschedule_reason=None,
            )
            new_record = ProductionSchedulePlan(**new_schedule_data.model_dump(), created_by=operator)
            self.db.add(new_record)

            old_plan.is_active = False
            old_plan.reschedule_reason = "已执行删除补位前滚"
            self.db.add(old_plan)
            await self.db.flush()

            results.append({
                "old_plan_id": old_plan.id,
                "new_plan_id": new_record.id,
                "order_no": old_plan.order_no,
                "line_no": old_plan.line_no,
                "old_plan_date": old_plan.plan_date,
                "new_plan_date": new_record.plan_date,
                "success": True,
                "message": "补位前滚成功",
            })
        return results
