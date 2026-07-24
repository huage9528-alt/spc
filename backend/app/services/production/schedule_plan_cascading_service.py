"""级联重排服务(场景① 后挪填补 + 场景② 紧急插入推后).

设计目标:
- 纯函数 + DB 读写分离:`compute_reschedule_preview` 只算不写,`apply_reschedule` 才落库
- 支持两种场景:
    ①  目标计划改到更晚日期(后挪) → 原位置空出来 → 后续计划前挪填补
    ②  目标计划改到更早日期(前插/紧急插入) → 占用别人的位置 → 受影响计划顺延

算法步骤:
1. 计算目标计划的新区间
2. 找出同部门、同排产段、跟新区间冲突的计划 → 全部标记为"待让位"
3. 按日期升序,逐个给"待让位"计划找下一个空档
4. 目标计划挪走后,扫描原区间之后的计划,尝试前挪填补空档(只在交期允许时)
5. 冷冻区里的计划:不自动挪,只标记 needs_break_frozen

所有操作都在内存里模拟完成,产出预览(diffs),由调用方决定是否落库。
"""

from __future__ import annotations

import asyncio
import logging
import math
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.production.schedule_plan import ProductionSchedulePlan
from app.services.production.frozen_zone_service import is_plan_in_frozen_zone

logger = logging.getLogger(__name__)

# 默认日工时上限(跟 schedule_plans.py 保持一致)
DEFAULT_STANDARD_DAILY_HOURS = 8.5
DEFAULT_MAX_DAILY_HOURS = 12.0


@dataclass
class PlanMove:
    """单个计划的重排动作(预览/落库都用它描述)"""

    plan_id: int
    order_no: Optional[str] = None
    line_no: Optional[str] = None
    product_code: Optional[str] = None
    old_start: Optional[date] = None
    old_end: Optional[date] = None
    new_start: Optional[date] = None
    new_end: Optional[date] = None
    move_reason: str = ""  # "目标改期" / "冲突推后" / "空档前挪"
    is_target: bool = False  # 是否是用户主动改期的目标计划
    in_frozen_zone: bool = False  # 新位置是否在冷冻区
    warnings: list[str] = field(default_factory=list)
    # 重排后可能更新的属性(只对目标计划有效)
    new_manpower: Optional[int] = None
    new_daily_work_hours: Optional[float] = None
    duration_changed: bool = False  # 工期天数是否变化(由人数/工时变化导致)

    @property
    def has_change(self) -> bool:
        return self.new_start != self.old_start or self.new_end != self.old_end

    @property
    def shift_days(self) -> int:
        if not self.new_start or not self.old_start:
            return 0
        return (self.new_start - self.old_start).days


@dataclass
class ReschedulePreview:
    """重排预览结果"""

    target_plan_id: int
    target_new_start: Optional[date]
    target_new_end: Optional[date]
    moves: list[PlanMove] = field(default_factory=list)  # 包含目标 + 受影响的所有计划
    conflicts_in_frozen_zone: list[int] = field(default_factory=list)  # 涉及冷冻区的 plan_id
    has_warnings: bool = False
    summary: str = ""
    target_manpower: Optional[int] = None  # 目标计划重排后的人数
    target_daily_work_hours: Optional[float] = None  # 目标计划重排后的每日工时

    def to_dict(self) -> dict[str, Any]:
        return {
            "target_plan_id": self.target_plan_id,
            "target_new_start": self.target_new_start.isoformat() if self.target_new_start else None,
            "target_new_end": self.target_new_end.isoformat() if self.target_new_end else None,
            "target_manpower": self.target_manpower,
            "target_daily_work_hours": self.target_daily_work_hours,
            "moves": [
                {
                    "plan_id": m.plan_id,
                    "order_no": m.order_no,
                    "line_no": m.line_no,
                    "product_code": m.product_code,
                    "old_start": m.old_start.isoformat() if m.old_start else None,
                    "old_end": m.old_end.isoformat() if m.old_end else None,
                    "new_start": m.new_start.isoformat() if m.new_start else None,
                    "new_end": m.new_end.isoformat() if m.new_end else None,
                    "shift_days": m.shift_days,
                    "move_reason": m.move_reason,
                    "is_target": m.is_target,
                    "in_frozen_zone": m.in_frozen_zone,
                    "warnings": m.warnings,
                    "new_manpower": m.new_manpower,
                    "new_daily_work_hours": m.new_daily_work_hours,
                    "duration_changed": m.duration_changed,
                }
                for m in self.moves
            ],
            "conflicts_in_frozen_zone": self.conflicts_in_frozen_zone,
            "has_warnings": self.has_warnings,
            "summary": self.summary,
        }


def _plan_duration_days(plan: ProductionSchedulePlan) -> int:
    """计划区间天数(含首尾)。"""
    if not plan.start_date or not plan.end_date:
        return 1
    return max((plan.end_date - plan.start_date).days + 1, 1)


def _plan_overlaps(a_start: Optional[date], a_end: Optional[date],
                   b_start: Optional[date], b_end: Optional[date]) -> bool:
    if not (a_start and a_end and b_start and b_end):
        return False
    return a_start <= b_end and b_start <= a_end


def _production_dates(start: Optional[date], end: Optional[date]) -> list[date]:
    """枚举生产日(暂不区分周日,由调用方决定是否过滤)."""
    if not start or not end or end < start:
        return []
    days = []
    cur = start
    while cur <= end:
        days.append(cur)
        cur += timedelta(days=1)
    return days


async def _load_siblings(
    db: AsyncSession,
    *,
    department: str,
    source_process_type: str,
    around_date: date,
    window_days: int = 90,
    exclude_plan_ids: Optional[list[int]] = None,
) -> list[ProductionSchedulePlan]:
    """加载同一部门同排产段、在 around_date 附近 ±window_days 的活跃计划."""
    start_bound = around_date - timedelta(days=window_days)
    end_bound = around_date + timedelta(days=window_days)
    conditions = [
        ProductionSchedulePlan.is_active == True,
        ProductionSchedulePlan.department == department,
        ProductionSchedulePlan.source_process_type == source_process_type,
        ProductionSchedulePlan.start_date >= start_bound,
        ProductionSchedulePlan.start_date <= end_bound,
    ]
    if exclude_plan_ids:
        conditions.append(ProductionSchedulePlan.id.notin_(exclude_plan_ids))
    result = await db.execute(
        select(ProductionSchedulePlan)
        .where(*conditions)
        .order_by(ProductionSchedulePlan.start_date.asc(), ProductionSchedulePlan.id.asc())
    )
    return list(result.scalars().all())


async def compute_reschedule_preview(
    db: AsyncSession,
    *,
    plan_id: int,
    new_start: date,
    new_end: Optional[date] = None,
    today: Optional[date] = None,
    manpower: Optional[int] = None,
    daily_work_hours: Optional[float] = None,
) -> ReschedulePreview:
    """计算把指定计划挪到 new_start 后的连锁影响, 不写库.

    返回 ReschedulePreview, 包含目标 + 所有受影响的计划的挪动明细.
    落库由 apply_reschedule 完成.

    重算规则:
    - 如果传了 manpower 或 daily_work_hours, 用新值重算目标计划的工期天数
      (公式: 天数 = ceil(数量 / (UPPH × 人数 × 每日工时)))
    - 否则按原工期天数平移
    """
    today = today or date.today()

    # 1. 加载目标计划
    target_result = await db.execute(
        select(ProductionSchedulePlan).where(ProductionSchedulePlan.id == plan_id)
    )
    target = target_result.scalar_one_or_none()
    if not target:
        raise ValueError(f"计划 {plan_id} 不存在")
    if not target.is_active:
        raise ValueError(f"计划 {plan_id} 已失效, 不能重排")

    department = str(target.department or "")
    bucket = str(target.source_process_type or "")

    # 2. 计算工期天数
    # 如果传了新人数/工时, 重算; 否则用原工期平移
    effective_manpower = int(manpower) if manpower and manpower > 0 else None
    effective_hours = float(daily_work_hours) if daily_work_hours and daily_work_hours > 0 else None
    duration_changed = False
    original_duration = _plan_duration_days(target)

    if effective_manpower is not None or effective_hours is not None:
        # 至少有一个参数变了, 尝试重算
        used_manpower = effective_manpower or int(target.manpower or 10)
        used_hours = effective_hours or float(target.daily_work_hours or 8.5)
        used_upph = float(target.upph or 0)
        used_qty = float(target.quantity or 0)
        if used_upph > 0 and used_qty > 0 and used_manpower > 0 and used_hours > 0:
            total_hours = used_qty / (used_upph * used_manpower)
            recomputed_duration = max(1, math.ceil(total_hours / used_hours))
            if recomputed_duration != original_duration:
                duration_changed = True
            duration = recomputed_duration
        else:
            duration = original_duration
    else:
        duration = original_duration

    if new_end is None:
        new_end = new_start + timedelta(days=duration - 1)
    target_old_start = target.start_date
    target_old_end = target.end_date

    # 2. 加载周围所有同段计划(排除目标)
    siblings = await _load_siblings(
        db,
        department=department,
        source_process_type=bucket,
        around_date=min(new_start, target_old_start or new_start),
        window_days=120,
        exclude_plan_ids=[plan_id],
    )

    moves_by_id: dict[int, PlanMove] = {}
    target_move = PlanMove(
        plan_id=plan_id,
        order_no=target.order_no,
        line_no=target.line_no,
        product_code=target.product_code,
        old_start=target_old_start,
        old_end=target_old_end,
        new_start=new_start,
        new_end=new_end,
        move_reason="目标改期",
        is_target=True,
        in_frozen_zone=is_plan_in_frozen_zone(new_start, today),
        new_manpower=effective_manpower if effective_manpower is not None else int(target.manpower or 10),
        new_daily_work_hours=effective_hours if effective_hours is not None else float(target.daily_work_hours or 8.5),
        duration_changed=duration_changed,
    )
    if duration_changed:
        target_move.warnings.append(
            f"因人数/工时变化, 工期从 {original_duration} 天变为 {duration} 天"
        )
    if target_move.in_frozen_zone:
        target_move.warnings.append("目标日期在冷冻区内, 应用时需要破冻理由")
    moves_by_id[plan_id] = target_move

    # 3. 找出跟新区间冲突的计划 → 标记为待让位
    pending_push: list[ProductionSchedulePlan] = []
    for sib in siblings:
        if _plan_overlaps(new_start, new_end, sib.start_date, sib.end_date):
            pending_push.append(sib)

    # 4. 推后:按日期升序, 逐个找下一个不冲突的空位
    # 占用区间集合(已确定不能动的位置)
    occupied: list[tuple[date, date]] = [(new_start, new_end)]
    pending_push.sort(key=lambda p: (p.start_date or date.max, p.id))

    for sib in pending_push:
        sib_duration = _plan_duration_days(sib)
        # 从 sib 原 start_date 开始往后找, 找到第一个不跟 occupied 重叠的位置
        candidate_start = sib.start_date or new_end + timedelta(days=1)
        # 如果 sib 原本在目标前面(不应该发生, 因为冲突判定), 直接跳过
        # 通常冲突计划都在目标后面或重叠
        candidate_start = max(candidate_start, new_end + timedelta(days=0))
        # 向后逐日试
        max_attempts = 365
        for _ in range(max_attempts):
            candidate_end = candidate_start + timedelta(days=sib_duration - 1)
            conflict = any(_plan_overlaps(candidate_start, candidate_end, o[0], o[1]) for o in occupied)
            if not conflict:
                break
            candidate_start += timedelta(days=1)

        move = PlanMove(
            plan_id=sib.id,
            order_no=sib.order_no,
            line_no=sib.line_no,
            product_code=sib.product_code,
            old_start=sib.start_date,
            old_end=sib.end_date,
            new_start=candidate_start,
            new_end=candidate_end,
            move_reason="冲突推后",
            in_frozen_zone=is_plan_in_frozen_zone(candidate_start, today),
        )
        if move.in_frozen_zone:
            move.warnings.append("被推入冷冻区, 应用时需要破冻理由")
        if sib.source_promised_date and candidate_end > sib.source_promised_date:
            overrun_days = (candidate_end - sib.source_promised_date).days
            move.warnings.append(f"超出交期 {overrun_days} 天")
        moves_by_id[sib.id] = move
        occupied.append((candidate_start, candidate_end))
        occupied.sort()

    # 5. 前挪填补:目标挪走后, 在原位置后面的计划, 尝试往前挪
    # 算法:扫所有 sibling(未冲突的), 如果它 new_start(暂等于 old_start)前面有空档, 就前挪
    # 空档判定: 在它前面、不在 occupied(目标新位置 + 已推后位置 + 未动计划自身区间) 内
    all_occupied_initial: list[tuple[date, date]] = []
    # 占位 = 目标新区间 + 所有 sibling 的当前区间(除了 pending_push 里已被推后的)
    all_occupied_initial.append((new_start, new_end))
    for sib in siblings:
        if sib.id in {p.id for p in pending_push}:
            continue  # 已经在推后逻辑里处理
        if sib.start_date and sib.end_date:
            all_occupied_initial.append((sib.start_date, sib.end_date))
    all_occupied_initial.sort()

    # 候选前挪对象:在目标原位置之后、未冲突的计划
    # 关键约束: 不能动过去的计划(start_date <= today 的不动),
    # 也不能把任何计划前挪到 today 之前(过去日期排产无意义).
    pull_candidates = [
        sib for sib in siblings
        if sib.id not in {p.id for p in pending_push}
        and sib.start_date
        and target_old_end
        and sib.start_date > target_old_end
        and sib.start_date > today
    ]
    pull_candidates.sort(key=lambda p: (p.start_date or date.max, p.id))

    for sib in pull_candidates:
        sib_duration = _plan_duration_days(sib)
        original_start = sib.start_date
        original_end = sib.end_date

        # 找最早的可放置位置(从 target_old_start 开始往后扫)
        # 但不能早于 today(过去日期不能排产)
        earliest = max(target_old_start or original_start, today + timedelta(days=1))
        candidate_start = earliest
        max_attempts = 365
        for _ in range(max_attempts):
            candidate_end = candidate_start + timedelta(days=sib_duration - 1)
            # 不能超过原 start(不能让前挪反而延后), 也不能进入别的占位
            if candidate_start > original_start:
                break  # 找不到更早的, 放弃前挪
            conflict = any(_plan_overlaps(candidate_start, candidate_end, o[0], o[1]) for o in all_occupied_initial)
            if not conflict:
                break
            candidate_start += timedelta(days=1)

        # 只有真的能前挪, 才记录
        if candidate_start < original_start:
            move = PlanMove(
                plan_id=sib.id,
                order_no=sib.order_no,
                line_no=sib.line_no,
                product_code=sib.product_code,
                old_start=original_start,
                old_end=original_end,
                new_start=candidate_start,
                new_end=candidate_end,
                move_reason="空档前挪",
            )
            # 前挪后也要检查交期(前挪一般不会超期, 只检查冷冻区)
            if is_plan_in_frozen_zone(candidate_start, today):
                move.warnings.append("被前挪进冷冻区, 应用时需要破冻理由")
            moves_by_id[sib.id] = move
            # 把新位置加入占位, 避免后续前挪跟它冲突
            all_occupied_initial.append((candidate_start, candidate_end))
            all_occupied_initial.sort()
            # 同时把原位置从占位移除(已经空出来)
            if (original_start, original_end) in all_occupied_initial:
                all_occupied_initial.remove((original_start, original_end))

    # 6. 汇总
    moves_list = list(moves_by_id.values())
    moves_list.sort(key=lambda m: (m.new_start or date.max, m.plan_id))
    conflicts_in_frozen = [m.plan_id for m in moves_list if m.in_frozen_zone]
    has_warnings = any(m.warnings for m in moves_list)

    push_count = sum(1 for m in moves_list if m.move_reason == "冲突推后")
    pull_count = sum(1 for m in moves_list if m.move_reason == "空档前挪")
    summary_parts = [f"目标计划挪到 {new_start.isoformat()}"]
    if push_count:
        summary_parts.append(f"{push_count} 条冲突计划推后")
    if pull_count:
        summary_parts.append(f"{pull_count} 条计划前挪填补空档")
    if conflicts_in_frozen:
        summary_parts.append(f"{len(conflicts_in_frozen)} 条涉及冷冻区(需破冻理由)")
    summary = "; ".join(summary_parts)

    return ReschedulePreview(
        target_plan_id=plan_id,
        target_new_start=new_start,
        target_new_end=new_end,
        moves=moves_list,
        conflicts_in_frozen_zone=conflicts_in_frozen,
        has_warnings=has_warnings,
        summary=summary,
        target_manpower=effective_manpower if effective_manpower is not None else int(target.manpower or 10),
        target_daily_work_hours=effective_hours if effective_hours is not None else float(target.daily_work_hours or 8.5),
    )


async def apply_reschedule(
    db: AsyncSession,
    preview: ReschedulePreview,
    *,
    operator: str,
    break_frozen_reason: Optional[str] = None,
) -> list[ProductionSchedulePlan]:
    """把预览结果落库.

    - 对每个有变化的计划:旧版本置 is_active=False, 创建新版本(plan_version+1)
    - 如果涉及冷冻区, 必须提供 break_frozen_reason
    - 返回新建的活跃计划列表
    """
    if preview.conflicts_in_frozen_zone and not (break_frozen_reason and break_frozen_reason.strip()):
        raise ValueError(
            f"重排涉及冷冻区计划 {preview.conflicts_in_frozen_zone}, "
            "必须提供 break_frozen_reason"
        )

    affected_ids = [m.plan_id for m in preview.moves if m.has_change]
    if not affected_ids:
        return []

    # 加载所有要改的计划
    result = await db.execute(
        select(ProductionSchedulePlan).where(ProductionSchedulePlan.id.in_(affected_ids))
    )
    plans_by_id = {p.id: p for p in result.scalars().all()}

    new_plans: list[ProductionSchedulePlan] = []
    remark_suffix = f"(破冻理由: {break_frozen_reason})" if break_frozen_reason else ""

    for move in preview.moves:
        if not move.has_change:
            continue
        old_plan = plans_by_id.get(move.plan_id)
        if not old_plan:
            continue

        # 旧版本失效
        old_plan.is_active = False
        old_plan.reschedule_reason = (
            f"{move.move_reason}: 被改为 {move.new_start.isoformat() if move.new_start else '?'}~"
            f"{move.new_end.isoformat() if move.new_end else '?'}{remark_suffix}"
        )
        db.add(old_plan)

        # 释放旧计划占用的产能时间槽
        try:
            from app.services.production.capacity_slot_service import release_slots_for_plan
            await release_slots_for_plan(db, old_plan.id)
        except Exception:
            pass

        # 创建新版本
        new_plan_version = int(old_plan.plan_version or 1) + 1
        # 目标计划: 用 move 里的新人数/工时(用户可能改过); 其他计划: 沿用原值
        applied_manpower = (
            move.new_manpower if (move.is_target and move.new_manpower is not None)
            else old_plan.manpower
        )
        applied_hours = (
            move.new_daily_work_hours if (move.is_target and move.new_daily_work_hours is not None)
            else old_plan.daily_work_hours
        )
        new_plan = ProductionSchedulePlan(
            department=old_plan.department,
            plan_date=move.new_start or old_plan.plan_date,
            order_no=old_plan.order_no,
            line_no=old_plan.line_no,
            product_code=old_plan.product_code,
            model_code=old_plan.model_code,
            quantity=old_plan.quantity,
            owner=old_plan.owner,
            start_date=move.new_start,
            end_date=move.new_end,
            priority=old_plan.priority,
            status=old_plan.status,
            upph=old_plan.upph,
            manpower=applied_manpower,
            daily_work_hours=applied_hours,
            plan_version=new_plan_version,
            is_active=True,
            source_promised_date=old_plan.source_promised_date,
            source_order_qty=old_plan.source_order_qty,
            planned_qty=old_plan.planned_qty,
            source_product_code=old_plan.source_product_code,
            source_product_model=old_plan.source_product_model,
            source_upph=old_plan.source_upph,
            source_process_type=old_plan.source_process_type,
            needs_reschedule=False,
            reschedule_reason=None,
            previous_plan_id=old_plan.id,
            sync_batch_no=old_plan.sync_batch_no,
            remark=f"{move.move_reason}{remark_suffix}".strip("()") or None,
            created_by=operator,
        )
        db.add(new_plan)
        await db.flush()  # 拿到 new_plan.id 才能占槽
        new_plans.append(new_plan)

        # 为新计划占用产能时间槽
        try:
            from app.services.production.capacity_slot_service import recompute_plan_slots
            qty = float(new_plan.quantity or 0)
            upph = float(new_plan.upph or 0)
            mp = int(new_plan.manpower or 10)
            bucket = str(new_plan.source_process_type or "").strip()
            if bucket and qty > 0 and upph > 0 and mp > 0 and new_plan.end_date:
                total_hours = qty / (upph * mp)
                await recompute_plan_slots(
                    db,
                    plan_id=new_plan.id,
                    department=str(new_plan.department or ""),
                    schedule_bucket=bucket,
                    order_no=new_plan.order_no,
                    line_no=new_plan.line_no,
                    total_hours=total_hours,
                    target_end_date=new_plan.end_date,
                    # 固定用车间最大上限 12h, 防止跨订单累加超载
                    daily_capacity=12.0,
                )
        except Exception:
            pass

    return new_plans
