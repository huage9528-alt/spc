"""产能时间槽服务.

负责:
- book_slots: 排产时占用时间槽(支持复用同天空闲工时)
- release_slots_for_plan: 取消/改期时释放占用
- get_capacity_usage: 查询某段日期的产能占用情况
- find_slot_bookings: 给定总工时和目标完成日, 计算需要占用哪些日期多少小时

核心规则:
- 一天标准产能 8.5h, 加班上限 12h
- 排产时从目标完成日往前贪心占: 优先用满空闲天, 然后用部分空闲天
- 多订单可以共享同一天(各占几小时)
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.production.capacity_slot import CapacitySlot

logger = logging.getLogger(__name__)

# 标准日工时和加班上限(跟 schedule_simulation_service 保持一致)
STANDARD_DAILY_HOURS = 8.5
MAX_DAILY_HOURS = 12.0


def _to_float(v: Any) -> float:
    if v is None:
        return 0.0
    if isinstance(v, Decimal):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _is_production_day(d: date, include_sunday: bool = False) -> bool:
    """生产日判定: 周一到周六, 周日默认休(除非显式启用)."""
    if d.weekday() == 6:  # Sunday
        return include_sunday
    return True


def _previous_production_day(d: date, include_sunday: bool = False) -> date:
    cur = d - timedelta(days=1)
    while not _is_production_day(cur, include_sunday):
        cur -= timedelta(days=1)
    return cur


async def get_capacity_usage(
    db: AsyncSession,
    *,
    department: str,
    schedule_bucket: str,
    start_date: date,
    end_date: date,
    daily_capacity: float = STANDARD_DAILY_HOURS,
    exclude_plan_id: Optional[int] = None,
) -> list[dict[str, Any]]:
    """查询某段日期的产能使用情况.

    返回每天的占用明细:
        [
            {"date": "2026-08-12", "capacity": 8.5, "booked": 8.5, "available": 0.0, "utilization": 1.0},
            ...
        ]
    """
    conditions = [
        CapacitySlot.department == department,
        CapacitySlot.schedule_bucket == schedule_bucket,
        CapacitySlot.is_active == True,
        func.date(CapacitySlot.slot_date) >= start_date,
        func.date(CapacitySlot.slot_date) <= end_date,
    ]
    if exclude_plan_id is not None:
        conditions.append(CapacitySlot.plan_id != exclude_plan_id)

    rows = await db.execute(
        select(
            func.date(CapacitySlot.slot_date).label("d"),
            func.sum(CapacitySlot.hours).label("booked"),
        )
        .where(*conditions)
        .group_by(func.date(CapacitySlot.slot_date))
        .order_by(func.date(CapacitySlot.slot_date).asc())
    )

    booked_map: dict[date, float] = {}
    for r in rows.all():
        d = r[0]
        if isinstance(d, str):
            d = date.fromisoformat(d)
        booked_map[d] = _to_float(r[1])

    result: list[dict[str, Any]] = []
    cur = start_date
    while cur <= end_date:
        booked = booked_map.get(cur, 0.0)
        available = max(0.0, daily_capacity - booked)
        result.append({
            "date": cur,
            "capacity": daily_capacity,
            "booked": round(booked, 2),
            "available": round(available, 2),
            "utilization": round(booked / daily_capacity, 2) if daily_capacity > 0 else 0,
        })
        cur += timedelta(days=1)
    return result


async def find_slot_bookings(
    db: AsyncSession,
    *,
    department: str,
    schedule_bucket: str,
    total_hours: float,
    target_end_date: date,
    daily_capacity: float = STANDARD_DAILY_HOURS,
    include_sunday: bool = False,
    max_lookback_days: int = 90,
    exclude_plan_id: Optional[int] = None,
    serial_mode: bool = False,
    current_order_no: Optional[str] = None,
) -> list[dict[str, Any]]:
    """给定总工时和目标完成日, 计算占用哪些日期的多少小时.

    安全保障: daily_capacity 自动 clamp 到 [1, MAX_DAILY_HOURS=12],
    防止调用方传错导致同一天累加超过 12 小时.

    算法: 从 target_end_date 往前贪心占
      - 每天先看已占多少, 算出剩余可用
      - 如果剩余 >= 还需要的工时: 当天就够, 占用所需工时
      - 否则: 占满当天剩余, 继续往前找

    串行模式(serial_mode=True):
      - 同一天同一个工序段, 如果有"其他订单"还没做完, 不插队
      - "做完"的判定: 该订单所有计划的总工时 <= 已占工时
      - 只有做完的订单腾出的空位才能被新订单使用
      - 效果: A订单先连续做完, B订单才接上, 不交叉混排

    返回: [{"date": date, "hours": float, "is_full_day": bool}, ...]
           按日期升序
    """
    if total_hours <= 0:
        return []

    # 安全保障: daily_capacity 强制限制在 [1, MAX_DAILY_HOURS],
    # 防止调用方传错(比如传 0 或负数), 或者传 > 12 导致累加超载.
    daily_capacity = max(1.0, min(float(daily_capacity), MAX_DAILY_HOURS))

    remaining = float(total_hours)
    bookings: list[dict[str, Any]] = []
    cur_date = target_end_date
    days_tried = 0

    while remaining > 0.01 and days_tried < max_lookback_days:
        if not _is_production_day(cur_date, include_sunday):
            cur_date = _previous_production_day(cur_date, include_sunday)
            days_tried += 1
            continue

        # 查这天已占
        usage = await get_capacity_usage(
            db,
            department=department,
            schedule_bucket=schedule_bucket,
            start_date=cur_date,
            end_date=cur_date,
            daily_capacity=daily_capacity,
            exclude_plan_id=exclude_plan_id,
        )
        booked_today = usage[0]["booked"] if usage else 0.0
        available_today = max(0.0, daily_capacity - booked_today)

        # 串行模式: 检查这天有没有"其他订单"还没做完
        can_book = True
        if serial_mode and available_today > 0.01:
            can_book = await _check_serial_available(
                db,
                department=department,
                schedule_bucket=schedule_bucket,
                check_date=cur_date,
                current_order_no=current_order_no,
                exclude_plan_id=exclude_plan_id,
            )

        if can_book and available_today > 0.01:
            take = min(available_today, remaining)
            bookings.append({
                "date": cur_date,
                "hours": round(take, 2),
                "is_full_day": take >= available_today - 0.01,
                "available_before": round(available_today, 2),
            })
            remaining -= take

        cur_date = _previous_production_day(cur_date, include_sunday)
        days_tried += 1

    # 按日期升序返回
    bookings.sort(key=lambda b: b["date"])

    # 兜底: 如果串行模式下没找到任何空位(全部被其他订单锁住),
    # 放宽约束, 用非串行模式重新找(总比排不上好)
    if serial_mode and not bookings and total_hours > 0:
        return await find_slot_bookings(
            db,
            department=department,
            schedule_bucket=schedule_bucket,
            total_hours=total_hours,
            target_end_date=target_end_date,
            daily_capacity=daily_capacity,
            include_sunday=include_sunday,
            max_lookback_days=max_lookback_days,
            exclude_plan_id=exclude_plan_id,
            serial_mode=False,
            current_order_no=current_order_no,
        )

    return bookings


async def _check_serial_available(
    db: AsyncSession,
    *,
    department: str,
    schedule_bucket: str,
    check_date: date,
    current_order_no: Optional[str] = None,
    exclude_plan_id: Optional[int] = None,
) -> bool:
    """串行模式检查: 这天有没有'其他订单'还没做完.

    用单条 SQL 一次性查出: 这天的其他计划 + 总需求 + 总占用 + 之后占槽.
    避免循环查询导致批量排产慢.
    """
    from app.models.production.schedule_plan import ProductionSchedulePlan

    # 单条 SQL: 查这天占槽的其他计划的完成状态
    # 条件: 非自己 + 非同订单
    other_condition = CapacitySlot.plan_id.isnot(None)
    if exclude_plan_id:
        other_condition = (CapacitySlot.plan_id != exclude_plan_id)

    rows = await db.execute(
        select(
            CapacitySlot.plan_id,
            CapacitySlot.order_no,
        )
        .where(
            CapacitySlot.department == department,
            CapacitySlot.schedule_bucket == schedule_bucket,
            func.date(CapacitySlot.slot_date) == check_date,
            CapacitySlot.is_active == True,
            other_condition,
        )
        .distinct()
    )
    other_slots = rows.all()
    if not other_slots:
        return True

    # 过滤掉同订单的
    other_plan_ids = []
    for r in other_slots:
        order_no = str(r[1] or "")
        if current_order_no and order_no == current_order_no:
            continue
        other_plan_ids.append(r[0])

    if not other_plan_ids:
        return True

    # 批量查这些计划的总需求
    plan_rows = await db.execute(
        select(
            ProductionSchedulePlan.id,
            ProductionSchedulePlan.quantity,
            ProductionSchedulePlan.upph,
            ProductionSchedulePlan.manpower,
        )
        .where(
            ProductionSchedulePlan.id.in_(other_plan_ids),
            ProductionSchedulePlan.is_active == True,
        )
    )
    plans_needs = {}
    for p in plan_rows.all():
        qty = float(p[1] or 0)
        upph = float(p[2] or 0)
        mp = int(p[3] or 10)
        needed = qty / (upph * mp) if upph > 0 and mp > 0 else 0
        plans_needs[p[0]] = needed

    if not plans_needs:
        return True

    # 批量查总占用 + 之后占槽 (2条SQL, 不再循环)
    booked_rows = await db.execute(
        select(CapacitySlot.plan_id, func.sum(CapacitySlot.hours))
        .where(
            CapacitySlot.plan_id.in_(list(plans_needs.keys())),
            CapacitySlot.is_active == True,
        )
        .group_by(CapacitySlot.plan_id)
    )
    booked_map = {r[0]: _to_float(r[1]) for r in booked_rows.all()}

    later_rows = await db.execute(
        select(CapacitySlot.plan_id, func.sum(CapacitySlot.hours))
        .where(
            CapacitySlot.plan_id.in_(list(plans_needs.keys())),
            CapacitySlot.is_active == True,
            func.date(CapacitySlot.slot_date) > check_date,
        )
        .group_by(CapacitySlot.plan_id)
    )
    later_map = {r[0]: _to_float(r[1]) for r in later_rows.all()}

    # 判定: 最严格串行
    # 规则: 同一天同一工段, 只允许一个订单
    # 除非那个订单"做完了"(总占槽 >= 总需求) 且 "这天是最后一天"(之后没占槽)
    # 且这天它的占槽 < 12h(还有剩余空位)
    for plan_id, needed in plans_needs.items():
        total_booked = booked_map.get(plan_id, 0.0)
        later_booked = later_map.get(plan_id, 0.0)
        # 没做完 → 绝对不能插
        if total_booked < needed - 0.5:
            return False
        # 之后还有占槽 → 不是最后一天, 不能插
        if later_booked > 0.01:
            return False
        # 做完了且是最后一天 → 检查这天的剩余空位
        # (这天的占槽 + 新订单 <= 12h 才允许)
        # 这部分在 find_slot_bookings 的 available_today 里已经算了

    return True


async def book_slots(
    db: AsyncSession,
    *,
    plan_id: int,
    order_no: Optional[str],
    line_no: Optional[str],
    bookings: list[dict[str, Any]],
) -> int:
    """根据 find_slot_bookings 的结果, 实际写占用记录.

    返回写入的记录数.
    """
    count = 0
    for b in bookings:
        slot = CapacitySlot(
            department="",  # 由调用方在 bookings 里带上, 见下方完整版
            schedule_bucket="",
            slot_date=b["date"],
            hours=b["hours"],
            plan_id=plan_id,
            order_no=order_no,
            line_no=line_no,
            is_active=True,
            remark=b.get("remark"),
        )
        # 从 b 里补 department/bucket(更灵活)
        slot.department = b.get("department", "")
        slot.schedule_bucket = b.get("schedule_bucket", "")
        db.add(slot)
        count += 1
    return count


async def release_slots_for_plan(
    db: AsyncSession,
    plan_id: int,
) -> int:
    """释放某计划占用的所有时间槽(改期/取消时调用)."""
    rows = await db.execute(
        select(CapacitySlot).where(
            CapacitySlot.plan_id == plan_id,
            CapacitySlot.is_active == True,
        )
    )
    count = 0
    for slot in rows.scalars().all():
        slot.is_active = False
        db.add(slot)
        count += 1
    return count


async def recompute_plan_slots(
    db: AsyncSession,
    *,
    plan_id: int,
    department: str,
    schedule_bucket: str,
    order_no: Optional[str],
    line_no: Optional[str],
    total_hours: float,
    target_end_date: date,
    daily_capacity: float = STANDARD_DAILY_HOURS,
    include_sunday: bool = False,
    serial_mode: bool = True,
) -> list[dict[str, Any]]:
    """重算并刷新某计划的时间槽占用.

    用于:
    - 排产时: 第一次占槽
    - 改期时: 释放旧槽, 占新槽
    - 改人数时: 释放旧槽(总工时变了), 占新槽

    串行模式(serial_mode=True, 默认):
      同一天同一个工序段, 如果有其他订单还没做完, 不插队.
      效果: A订单先连续做完, B订单才接上, 不交叉混排.

    返回新的占用明细.
    """
    # 1. 释放旧占用
    await release_slots_for_plan(db, plan_id)

    # 2. 计算新占用
    bookings = await find_slot_bookings(
        db,
        department=department,
        schedule_bucket=schedule_bucket,
        total_hours=total_hours,
        target_end_date=target_end_date,
        daily_capacity=daily_capacity,
        include_sunday=include_sunday,
        exclude_plan_id=plan_id,
        serial_mode=serial_mode,
        current_order_no=order_no,
    )

    # 3. 补全 bookings 里的 department/bucket, 写入
    for b in bookings:
        b["department"] = department
        b["schedule_bucket"] = schedule_bucket
    await book_slots(
        db,
        plan_id=plan_id,
        order_no=order_no,
        line_no=line_no,
        bookings=bookings,
    )
    return bookings
