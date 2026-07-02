import math
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.production.config_service import (
    LEAN_CAPACITY_LOAD_LABELS,
    LEAN_MAX_DAILY_HOURS,
    LEAN_STANDARD_DAILY_HOURS,
    ProductionScheduleConfigService,
    READY_OFFSET_DAYS,
)


class ScheduleSimulationService:
    """统一承接排产试算，先算建议，再由接口决定是否落计划。"""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.config_service = ProductionScheduleConfigService(db)

    @staticmethod
    def calculate_target_ready_date(promised_date: Optional[date]) -> Optional[date]:
        if not promised_date:
            return None
        return promised_date - timedelta(days=READY_OFFSET_DAYS)

    @staticmethod
    def is_production_day(target_date: date, include_sunday: bool) -> bool:
        return include_sunday or target_date.weekday() != 6

    @classmethod
    def get_previous_production_day(cls, target_date: date, include_sunday: bool) -> date:
        current_date = target_date
        while not cls.is_production_day(current_date, include_sunday):
            current_date -= timedelta(days=1)
        return current_date

    @classmethod
    def get_next_production_day(cls, target_date: date, include_sunday: bool) -> date:
        current_date = target_date
        while not cls.is_production_day(current_date, include_sunday):
            current_date += timedelta(days=1)
        return current_date

    @classmethod
    def shift_production_days(
        cls,
        anchor_date: date,
        shift_days: int,
        *,
        include_sunday: bool,
        forward: bool,
    ) -> date:
        current_date = anchor_date
        moved_days = 0
        step = 1 if forward else -1
        while moved_days < shift_days:
            current_date += timedelta(days=step)
            if cls.is_production_day(current_date, include_sunday):
                moved_days += 1
        return current_date

    @classmethod
    def count_production_days(
        cls,
        start_date: Optional[date],
        end_date: Optional[date],
        *,
        include_sunday: bool,
    ) -> int:
        if not start_date or not end_date or end_date < start_date:
            return 0
        current_date = start_date
        production_days = 0
        while current_date <= end_date:
            if cls.is_production_day(current_date, include_sunday):
                production_days += 1
            current_date += timedelta(days=1)
        return production_days

    @classmethod
    def build_lean_workhour_plan(
        cls,
        *,
        quantity: float,
        upph: float,
        promised_date: Optional[date],
    ) -> dict:
        if not promised_date or not quantity or quantity <= 0 or not upph or upph <= 0:
            return {}

        today = date.today()
        target_ready_date = cls.calculate_target_ready_date(promised_date)
        total_hours = round(float(quantity) / float(upph), 2)
        end_without_sunday = cls.get_previous_production_day(target_ready_date, False)
        end_with_sunday = cls.get_previous_production_day(target_ready_date, True)
        actual_today_without_sunday = cls.get_next_production_day(today, False)
        actual_today_with_sunday = cls.get_next_production_day(today, True)
        available_days_without_sunday = cls.count_production_days(
            actual_today_without_sunday,
            end_without_sunday,
            include_sunday=False,
        )
        available_days_with_sunday = cls.count_production_days(
            actual_today_with_sunday,
            end_with_sunday,
            include_sunday=True,
        )
        required_daily_hours_without_sunday = (
            round(total_hours / available_days_without_sunday, 2)
            if available_days_without_sunday > 0
            else None
        )
        required_daily_hours_with_sunday = (
            round(total_hours / available_days_with_sunday, 2)
            if available_days_with_sunday > 0
            else None
        )

        def build_candidate(*, max_daily_hours: float, include_sunday: bool) -> dict:
            candidate_end_date = cls.get_previous_production_day(target_ready_date, include_sunday)
            candidate_days_needed = max(1, math.ceil(total_hours / max_daily_hours))
            candidate_start_date = cls.shift_production_days(
                candidate_end_date,
                candidate_days_needed - 1,
                include_sunday=include_sunday,
                forward=False,
            )
            candidate_today = cls.get_next_production_day(today, include_sunday)
            candidate_available_days = cls.count_production_days(
                candidate_today,
                candidate_end_date,
                include_sunday=include_sunday,
            )
            return {
                "days_needed": candidate_days_needed,
                "start_date": candidate_start_date,
                "end_date": candidate_end_date,
                "available_days": candidate_available_days,
                "required_daily_hours": round(total_hours / candidate_days_needed, 2),
                "feasible": candidate_start_date >= candidate_today,
            }

        def build_candidate_plan(
            candidate: dict,
            *,
            status_key: str,
            include_sunday: bool,
            note: str,
        ) -> dict:
            return {
                "days_needed": candidate["days_needed"],
                "suggested_start_date": candidate["start_date"],
                "suggested_end_date": candidate["end_date"],
                "available_production_days": candidate["available_days"],
                "recommended_daily_hours": round(candidate["required_daily_hours"], 2),
                "capacity_load_status": status_key,
                "capacity_load_status_label": LEAN_CAPACITY_LOAD_LABELS[status_key],
                "sunday_rest_allowed": not include_sunday,
                "needs_sunday_work": include_sunday,
                "needs_move_earlier": False,
                "move_earlier_days": 0,
                "feasible": candidate["feasible"],
                "work_hour_summary": "；".join([
                    f"建议 {candidate['required_daily_hours']:.2f} 小时/天",
                    f"总工时 {total_hours:.2f} 小时",
                    f"连续生产 {candidate['days_needed']} 天",
                    note,
                ]),
            }

        normal_candidate = build_candidate(
            max_daily_hours=LEAN_STANDARD_DAILY_HOURS,
            include_sunday=False,
        )
        overtime_candidate = build_candidate(
            max_daily_hours=LEAN_MAX_DAILY_HOURS,
            include_sunday=False,
        )
        sunday_candidate = build_candidate(
            max_daily_hours=LEAN_MAX_DAILY_HOURS,
            include_sunday=True,
        )
        candidate_plans = {
            "normal": build_candidate_plan(
                normal_candidate,
                status_key="normal",
                include_sunday=False,
                note="周日可休",
            ),
            "overtime": build_candidate_plan(
                overtime_candidate,
                status_key="overtime",
                include_sunday=False,
                note="周日可休，但需加班",
            ),
            "sunday_production": build_candidate_plan(
                sunday_candidate,
                status_key="sunday_production",
                include_sunday=True,
                note="需启用周日生产",
            ),
        }

        chosen_candidate = sunday_candidate
        capacity_load_status = "move_earlier"
        sunday_rest_allowed = False
        needs_sunday_work = True
        needs_move_earlier = True
        move_earlier_days = max(
            sunday_candidate["days_needed"] - max(sunday_candidate["available_days"], 0),
            0,
        )

        if normal_candidate["feasible"]:
            chosen_candidate = normal_candidate
            capacity_load_status = "normal"
            sunday_rest_allowed = True
            needs_sunday_work = False
            needs_move_earlier = False
            move_earlier_days = 0
        elif overtime_candidate["feasible"]:
            chosen_candidate = overtime_candidate
            capacity_load_status = "overtime"
            sunday_rest_allowed = True
            needs_sunday_work = False
            needs_move_earlier = False
            move_earlier_days = 0
        elif sunday_candidate["feasible"]:
            chosen_candidate = sunday_candidate
            capacity_load_status = "sunday_production"
            sunday_rest_allowed = False
            needs_sunday_work = True
            needs_move_earlier = False
            move_earlier_days = 0

        recommended_daily_hours = chosen_candidate["required_daily_hours"]
        available_production_days = chosen_candidate["available_days"]
        required_daily_hours = (
            required_daily_hours_with_sunday if needs_sunday_work else required_daily_hours_without_sunday
        )

        summary_parts = [
            f"建议 {recommended_daily_hours:.2f} 小时/天",
            f"总工时 {total_hours:.2f} 小时",
            f"连续生产 {chosen_candidate['days_needed']} 天",
        ]
        if capacity_load_status == "normal":
            summary_parts.append("周日可休")
        elif capacity_load_status == "overtime":
            summary_parts.append("周日可休，但需加班")
        elif capacity_load_status == "sunday_production":
            summary_parts.append("需启用周日生产")
        else:
            summary_parts.append(f"按 12 小时/天且周日生产仍需前挪 {move_earlier_days} 天")

        return {
            "target_ready_date": target_ready_date,
            "ready_offset_days": READY_OFFSET_DAYS,
            "total_hours": total_hours,
            "available_production_days": available_production_days,
            "required_daily_hours": required_daily_hours,
            "required_daily_hours_without_sunday": required_daily_hours_without_sunday,
            "required_daily_hours_with_sunday": required_daily_hours_with_sunday,
            "recommended_daily_hours": round(recommended_daily_hours, 2),
            "capacity_load_status": capacity_load_status,
            "capacity_load_status_label": LEAN_CAPACITY_LOAD_LABELS[capacity_load_status],
            "sunday_rest_allowed": sunday_rest_allowed,
            "needs_sunday_work": needs_sunday_work,
            "needs_move_earlier": needs_move_earlier,
            "move_earlier_days": move_earlier_days,
            "days_needed": chosen_candidate["days_needed"],
            "suggested_start_date": chosen_candidate["start_date"],
            "suggested_end_date": chosen_candidate["end_date"],
            "work_hour_summary": "；".join(summary_parts),
            "candidate_plans": candidate_plans,
        }

    @classmethod
    def build_bucket_workhour_plan(
        cls,
        *,
        quantity: float,
        upph: float,
        promised_date: Optional[date],
        schedule_bucket: Optional[str] = None,
    ) -> dict:
        plan = cls.build_lean_workhour_plan(
            quantity=quantity,
            upph=upph,
            promised_date=promised_date,
        )
        if plan:
            plan["schedule_bucket"] = schedule_bucket
        return plan

    @staticmethod
    def calculate_delivery_status(
        end_date: Optional[date],
        target_ready_date: Optional[date],
    ) -> tuple[Optional[int], str]:
        if not end_date or not target_ready_date:
            return None, "unknown"

        delay_days = (end_date - target_ready_date).days
        if delay_days > 0:
            return delay_days, "delayed"

        ahead_days = (target_ready_date - end_date).days
        if ahead_days >= 2:
            return -ahead_days, "early"

        due_gap = (target_ready_date - date.today()).days
        if 1 <= due_gap <= 3:
            return 0, "upcoming"

        return 0, "normal"

    def calculate_schedule_result(
        self,
        *,
        quantity: float,
        upph: float,
        daily_hours: float,
        promised_date: date,
        schedule_bucket: Optional[str] = None,
        lean_workhour_plan: Optional[dict] = None,
    ) -> dict:
        total_hours = float(quantity) / float(upph)
        recommended_daily_hours = round(float(daily_hours), 2)
        days_needed = max(1, math.ceil(total_hours / float(daily_hours)))

        target_ready_date = self.calculate_target_ready_date(promised_date)
        today = date.today()
        include_sunday = True
        use_workhour_plan = bool(
            lean_workhour_plan
            and lean_workhour_plan.get("suggested_start_date")
            and lean_workhour_plan.get("suggested_end_date")
        )
        if use_workhour_plan:
            include_sunday = bool(lean_workhour_plan and lean_workhour_plan.get("needs_sunday_work"))
            use_suggested_window = (
                lean_workhour_plan
                and lean_workhour_plan.get("suggested_start_date")
                and lean_workhour_plan.get("suggested_end_date")
                and abs(recommended_daily_hours - float(lean_workhour_plan.get("recommended_daily_hours") or 0)) < 0.01
            )
            if use_suggested_window:
                days_needed = int(lean_workhour_plan.get("days_needed") or days_needed)
                start_date = lean_workhour_plan["suggested_start_date"]
                end_date = lean_workhour_plan["suggested_end_date"]
            else:
                end_date = self.get_previous_production_day(target_ready_date, include_sunday)
                start_date = self.shift_production_days(
                    end_date,
                    days_needed - 1,
                    include_sunday=include_sunday,
                    forward=False,
                )
        else:
            end_date = target_ready_date
            start_date = end_date - timedelta(days=days_needed - 1)

        warning = ""
        actual_today_start = self.get_next_production_day(today, include_sunday) if use_workhour_plan else today
        if start_date < actual_today_start:
            start_date = actual_today_start
            if use_workhour_plan:
                end_date = self.shift_production_days(
                    start_date,
                    days_needed - 1,
                    include_sunday=include_sunday,
                    forward=True,
                )
            else:
                end_date = start_date + timedelta(days=days_needed - 1)

            if use_workhour_plan and lean_workhour_plan and lean_workhour_plan.get("needs_move_earlier"):
                warning = (
                    f"【前挪预警】按精益最高 {LEAN_MAX_DAILY_HOURS} 小时/天"
                    f"{'且启用周日生产' if include_sunday else ''} 仍需整体前挪 "
                    f"{lean_workhour_plan.get('move_earlier_days') or 0} 天；"
                    f"当前若从 {start_date} 开始，预计备货完成日为 {end_date}。"
                )
            else:
                warning = (
                    f"【延期预警】按产能顺推，预计备货完成日({end_date})"
                    f"晚于备货目标日({target_ready_date})，客户交期({promised_date})！"
                )

        return {
            "total_hours": round(total_hours, 2),
            "days_needed": days_needed,
            "start_date": start_date,
            "end_date": end_date,
            "target_ready_date": target_ready_date,
            "ready_offset_days": READY_OFFSET_DAYS,
            "recommended_daily_hours": recommended_daily_hours,
            "needs_sunday_work": bool(lean_workhour_plan and lean_workhour_plan.get("needs_sunday_work")),
            "needs_move_earlier": bool(lean_workhour_plan and lean_workhour_plan.get("needs_move_earlier")),
            "capacity_load_status": lean_workhour_plan.get("capacity_load_status") if lean_workhour_plan else None,
            "capacity_load_status_label": lean_workhour_plan.get("capacity_load_status_label") if lean_workhour_plan else None,
            "move_earlier_days": lean_workhour_plan.get("move_earlier_days") if lean_workhour_plan else None,
            "work_hour_summary": lean_workhour_plan.get("work_hour_summary") if lean_workhour_plan else None,
            "warning": warning,
        }

    async def resolve_daily_work_hours(
        self,
        *,
        schedule_bucket: Optional[str],
        daily_work_hours: Optional[float],
        lean_workhour_plan: Optional[dict] = None,
    ) -> float:
        resolved_daily_hours = daily_work_hours
        if resolved_daily_hours is None:
            if lean_workhour_plan and lean_workhour_plan.get("recommended_daily_hours"):
                resolved_daily_hours = lean_workhour_plan["recommended_daily_hours"]
            else:
                resolved_daily_hours = await self.config_service.get_default_daily_work_hours(schedule_bucket)
        return float(resolved_daily_hours)
