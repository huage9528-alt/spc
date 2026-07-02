from datetime import timedelta
from typing import Optional

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.order.sale_order import SaleOrderLine
from app.models.production.schedule_plan import ProductionSchedulePlan
from app.schemas.production.schemas import ProductionSchedulePlanCreate
from app.services.production.upph_calculation_service import UpphCalculationService


class PlanDeleteAndBackfillService:
    """一期先收敛为：删除计划后识别释放窗口，并给出按 plan_date 顺延的候选补位预览。"""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.upph_service = UpphCalculationService(db)

    @staticmethod
    def get_order_line_bom_code(order_line) -> Optional[str]:
        return getattr(order_line, "bom_no", None) or getattr(order_line, "bom_code", None)

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

    async def resolve_plan_schedule_context(
        self,
        plan: ProductionSchedulePlan,
    ) -> dict:
        order_line = await self.get_latest_sale_order_line(plan.order_no, plan.line_no)
        product_code = (
            getattr(order_line, "product_code", None)
            or plan.product_code
            or plan.source_product_code
        )
        bom_code = self.get_order_line_bom_code(order_line) if order_line else None
        if not product_code and not bom_code:
            return {
                "schedule_bucket": "pending",
                "total_upph": None,
            }
        return await self.upph_service.summarize_schedule_context(
            product_code=product_code,
            bom_code=bom_code,
        )

    @staticmethod
    def can_participate_backfill(plan: ProductionSchedulePlan) -> bool:
        if not plan.is_active:
            return False
        if plan.status != "planned":
            return False
        if plan.locked_by:
            return False
        return True

    async def build_delete_preview(
        self,
        plan: ProductionSchedulePlan,
    ) -> dict:
        schedule_context = await self.resolve_plan_schedule_context(plan)
        release_bucket = schedule_context.get("schedule_bucket")

        result = await self.db.execute(
            select(ProductionSchedulePlan)
            .where(
                ProductionSchedulePlan.is_active == True,
                ProductionSchedulePlan.department == plan.department,
                ProductionSchedulePlan.id != plan.id,
                ProductionSchedulePlan.plan_date >= plan.plan_date,
            )
            .order_by(ProductionSchedulePlan.plan_date.asc(), ProductionSchedulePlan.id.asc())
        )
        candidate_plans = list(result.scalars().all())

        release_plan_date = plan.plan_date
        items: list[dict] = []
        affected_plan_ids: list[int] = []

        for candidate in candidate_plans:
            if not self.can_participate_backfill(candidate):
                continue
            candidate_context = await self.resolve_plan_schedule_context(candidate)
            if candidate_context.get("schedule_bucket") != release_bucket:
                continue
            if not candidate.plan_date or candidate.plan_date <= release_plan_date:
                continue

            items.append({
                "plan_id": candidate.id,
                "order_no": candidate.order_no,
                "line_no": candidate.line_no,
                "current_plan_date": candidate.plan_date,
                "suggested_plan_date": release_plan_date,
                "current_start_date": candidate.start_date,
                "current_end_date": candidate.end_date,
                "schedule_bucket": candidate_context.get("schedule_bucket"),
            })
            affected_plan_ids.append(candidate.id)
            release_plan_date = candidate.plan_date

        return {
            "release_plan_date": plan.plan_date,
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
