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


def _next_production_day(d: date, include_sunday: bool = False) -> date:
    """下一个生产日(默认跳过周日)."""
    cur = d + timedelta(days=1)
    while not _is_production_day(cur, include_sunday):
        cur += timedelta(days=1)
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
    target_start_date: date,
    daily_capacity: float = STANDARD_DAILY_HOURS,
    include_sunday: bool = False,
    max_lookforward_days: int = 180,
    target_end_date: Optional[date] = None,
    exclude_plan_id: Optional[int] = None,
    serial_mode: bool = False,
    current_order_no: Optional[str] = None,
    earliest_fill_date: Optional[date] = None,
    max_backfill_days: int = 7,
) -> list[dict[str, Any]]:
    """给定总工时和目标开工日, 计算占用哪些日期的多少小时.

    方向: 从 target_start_date **往后** 贪心占(车间习惯: 开工日先满, 完成日补尾工).
    旧版(从 end 往前)会导致"首日 2.22h + 次日 12h"倒挂, 且后续订单不会主动来填前面空位.

    超期前填(双向夹逼):
      - 主路径占完后, 若 actual_end > target_end_date(超期) 且 target_end_date 已知,
        从 target_start_date **往前**找空位补, 把超期工时尽量压回 target_end_date 之前
      - 前填仍严格执行串行检查(_check_serial_available), 不挤走别人, 只填真空位
      - earliest_fill_date 控制前填下限:
          None  = 不限(测试用, 可排到7月甚至更早的空位)
          today = 上线默认, 不能排到过去
      - 前填不影响主路径"首日满尾日补"的形态, 只是给超期部分找个更早的家

    安全保障: daily_capacity 自动 clamp 到 [1, MAX_DAILY_HOURS=12].

    算法:
      1. 从 target_start_date 往后逐日占, 每天占满 daily_capacity 剩余
      2. 若超期 + target_end_date 已知 + earliest_fill_date 允许:
         从 target_start_date 往前逐日找空位, 填进 bookings 头部

    串行模式(serial_mode=True):
      同一天同一个工序段, 如果有"其他订单"还没做完, 不插队.

    返回: [{"date": date, "hours": float, "is_full_day": bool, "available_before": float}, ...]
           按日期升序
    """
    if total_hours <= 0:
        return []

    daily_capacity = max(1.0, min(float(daily_capacity), MAX_DAILY_HOURS))

    remaining = float(total_hours)
    bookings: list[dict[str, Any]] = []

    # === 第一步: 主路径, 从 target_start_date 往后占 ===
    cur_date = target_start_date
    days_tried = 0
    while remaining > 0.01 and days_tried < max_lookforward_days:
        if not _is_production_day(cur_date, include_sunday):
            cur_date = _next_production_day(cur_date, include_sunday)
            days_tried += 1
            continue

        booked_today = await _get_day_booked(
            db, department=department, schedule_bucket=schedule_bucket,
            cur_date=cur_date, exclude_plan_id=exclude_plan_id,
        )
        available_today = max(0.0, daily_capacity - booked_today)

        can_book = True
        if serial_mode and available_today > 0.01:
            can_book = await _check_serial_available(
                db, department=department, schedule_bucket=schedule_bucket,
                check_date=cur_date, current_order_no=current_order_no,
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

        cur_date = _next_production_day(cur_date, include_sunday)
        days_tried += 1

    # === 第二步: 超期前填 ===
    # 主路径排完后如果还超期, 且 target_end_date 已知, 尝试往前找空位补
    # 注意: 主路径排满后 remaining 通常=0; 超期指的是 actual_end > target_end_date
    #       (即使 remaining=0, 排得太靠后也算超期, 要前填压缩)
    actual_end = max((b["date"] for b in bookings), default=None)
    need_backfill = bool(
        target_end_date
        and bookings
        and actual_end
        and actual_end > target_end_date
    )
    if need_backfill:
        # 前填下限: earliest_fill_date=None 表示不限(测试), 否则不能早于该日
        # 同时限制最多往前找 max_backfill_days 天, 避免产能不足时疯狂前填导致全局乱
        # (前填本意是"偶尔超期1-2天往前挪", 不是"产能不够就抢前面所有空位")
        hard_floor = target_start_date - timedelta(days=max_backfill_days)
        if earliest_fill_date and earliest_fill_date > hard_floor:
            hard_floor = earliest_fill_date
        # 从 target_start_date 往前一天开始, 逐日往前找空位
        back_fill: list[dict[str, Any]] = []
        back_cur = target_start_date - timedelta(days=1)
        back_guard = 0
        # 把主路径占的日期记下来, 前填时跳过(同一天主路径已占的不重复占)
        main_dates = {b["date"] for b in bookings}
        while back_cur >= hard_floor and back_guard < max_backfill_days + 5:
            back_guard += 1
            if not _is_production_day(back_cur, include_sunday):
                back_cur = _previous_production_day(back_cur, include_sunday)
                continue
            if back_cur in main_dates:
                back_cur = _previous_production_day(back_cur, include_sunday)
                continue

            booked_today = await _get_day_booked(
                db, department=department, schedule_bucket=schedule_bucket,
                cur_date=back_cur, exclude_plan_id=exclude_plan_id,
            )
            available_today = max(0.0, daily_capacity - booked_today)

            can_book = True
            if serial_mode and available_today > 0.01:
                can_book = await _check_serial_available(
                    db, department=department, schedule_bucket=schedule_bucket,
                    check_date=back_cur, current_order_no=current_order_no,
                    exclude_plan_id=exclude_plan_id,
                )

            if can_book and available_today > 0.01:
                # 前填只能填"超期"的天数对应的工时
                # 计算超期多少天 = actual_end - target_end_date (生产日)
                # 简化: 直接把 target_end_date 之后的占槽往前提, 直到填满前面空位或没超期可挪
                take = min(available_today, _backfill_hours_available(bookings, target_end_date))
                if take > 0.01:
                    back_fill.append({
                        "date": back_cur,
                        "hours": round(take, 2),
                        "is_full_day": take >= available_today - 0.01,
                        "available_before": round(available_today, 2),
                    })
                    # 从主路径尾部(最晚的日子)扣除相应工时
                    _drain_from_tail(bookings, take)
                    # 重新算 actual_end
                    actual_end = max((b["date"] for b in bookings if b["hours"] > 0.01), default=None)
                    if not actual_end or actual_end <= target_end_date:
                        break

            back_cur = _previous_production_day(back_cur, include_sunday)

        if back_fill:
            bookings.extend(back_fill)
            # 清掉主路径中被扣到 0 的槽位(它们已挪到前面)
            bookings = [b for b in bookings if b["hours"] > 0.01]

    # 按日期升序返回
    bookings.sort(key=lambda b: b["date"])

    # 兜底: 串行模式下完全没排上 → 放宽串行重试(原逻辑保留)
    if serial_mode and not bookings and total_hours > 0:
        return await find_slot_bookings(
            db, department=department, schedule_bucket=schedule_bucket,
            total_hours=total_hours, target_start_date=target_start_date,
            daily_capacity=daily_capacity, include_sunday=include_sunday,
            max_lookforward_days=max_lookforward_days, target_end_date=target_end_date,
            exclude_plan_id=exclude_plan_id, serial_mode=False,
            current_order_no=current_order_no, earliest_fill_date=earliest_fill_date,
        )

    return bookings


async def _get_day_booked(
    db: AsyncSession, *, department: str, schedule_bucket: str,
    cur_date: date, exclude_plan_id: Optional[int] = None,
) -> float:
    """查某天某工段已占工时(给 find_slot_bookings 主路径/前填复用, 避免重复代码)."""
    usage = await get_capacity_usage(
        db, department=department, schedule_bucket=schedule_bucket,
        start_date=cur_date, end_date=cur_date,
        daily_capacity=MAX_DAILY_HOURS, exclude_plan_id=exclude_plan_id,
    )
    return usage[0]["booked"] if usage else 0.0


def _backfill_hours_available(bookings: list[dict[str, Any]], target_end_date: date) -> float:
    """计算主路径中"超过 target_end_date 的占槽"总工时 —— 前填只能挪这部分."""
    return sum(b["hours"] for b in bookings if b["date"] > target_end_date)


def _drain_from_tail(bookings: list[dict[str, Any]], hours: float) -> None:
    """从 bookings 最晚的日期开始, 扣除 hours 工时(前填时用). 就地修改."""
    need = float(hours)
    # 按日期降序处理(最晚的先扣)
    for b in sorted(bookings, key=lambda x: x["date"], reverse=True):
        if need <= 0.01:
            break
        give = min(b["hours"], need)
        b["hours"] = round(b["hours"] - give, 2)
        need -= give


async def _check_serial_available(
    db: AsyncSession,
    *,
    department: str,
    schedule_bucket: str,
    check_date: date,
    current_order_no: Optional[str] = None,
    exclude_plan_id: Optional[int] = None,
) -> bool:
    """串行模式检查: 这个工段(department+schedule_bucket)有没有'其他订单'还没做完.

    严格串行语义: 只要工段里有任何一个其他订单"没做完"(总占槽 < 总需求),
    新订单就不能在任何一天插队 —— 不管新订单想插哪天, 也不管那天有没有别人的占槽.
    这样避免"长单占槽不连续时, 别人在空隙里钻进来"破坏串行.

    只有当工段里所有其他订单都"做完了"(总占槽 >= 总需求 - 0.5h 容差),
    才允许新订单进来填空位.
    """
    from app.models.production.schedule_plan import ProductionSchedulePlan

    # 1. 查这个工段所有 active 占槽涉及的其他订单(排除自己/同订单)
    other_condition = CapacitySlot.plan_id.isnot(None)
    if exclude_plan_id:
        other_condition = (CapacitySlot.plan_id != exclude_plan_id)

    rows = await db.execute(
        select(CapacitySlot.plan_id, CapacitySlot.order_no)
        .where(
            CapacitySlot.department == department,
            CapacitySlot.schedule_bucket == schedule_bucket,
            CapacitySlot.is_active == True,
            other_condition,
        )
        .distinct()
    )
    other_slots = rows.all()
    if not other_slots:
        return True

    other_plan_ids = []
    for r in other_slots:
        order_no = str(r[1] or "")
        if current_order_no and order_no == current_order_no:
            continue
        other_plan_ids.append(r[0])

    if not other_plan_ids:
        return True

    # 2. 查这些订单的总需求(从 plan 表)
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

    # 3. 查这些订单的总占槽(整个工段, 不限日期)
    booked_rows = await db.execute(
        select(CapacitySlot.plan_id, func.sum(CapacitySlot.hours))
        .where(
            CapacitySlot.plan_id.in_(list(plans_needs.keys())),
            CapacitySlot.is_active == True,
        )
        .group_by(CapacitySlot.plan_id)
    )
    booked_map = {r[0]: _to_float(r[1]) for r in booked_rows.all()}

    # 4. 判定: 只要有一个其他订单没做完 → 拒绝(返回 False)
    #    "做完" = 总占槽 >= 总需求 - 0.5h 容差
    #    不再区分"当天有没有占槽"或"之后有没有占槽" —— 没做完就一律挡
    for plan_id, needed in plans_needs.items():
        total_booked = booked_map.get(plan_id, 0.0)
        if total_booked < needed - 0.5:
            return False

    # 所有其他订单都做完了 → 允许新订单进来填空位
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
    target_start_date: date,
    daily_capacity: float = STANDARD_DAILY_HOURS,
    include_sunday: bool = False,
    serial_mode: bool = True,
    target_end_date: Optional[date] = None,
    earliest_fill_date: Optional[date] = None,
) -> list[dict[str, Any]]:
    """重算并刷新某计划的时间槽占用.

    方向: 从 target_start_date **往后** 贪心占(开工日先满, 完成日补尾工).
    旧版从 end 往前占已废弃, 避免首日补尾工倒挂 + 后续单不主动填前面空位.

    超期前填: 主路径占完若 actual_end > target_end_date, 从 target_start_date 往前
    找空位补(串行不破). earliest_fill_date 控制前填下限:
      None  = 测试阶段, 不限(可排到7月空位)
      today = 上线默认, 不能排到过去

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

    # 2. 计算新占用 (从开工日往后 + 超期前填)
    bookings = await find_slot_bookings(
        db,
        department=department,
        schedule_bucket=schedule_bucket,
        total_hours=total_hours,
        target_start_date=target_start_date,
        daily_capacity=daily_capacity,
        include_sunday=include_sunday,
        target_end_date=target_end_date,
        exclude_plan_id=plan_id,
        serial_mode=serial_mode,
        current_order_no=order_no,
        earliest_fill_date=earliest_fill_date,
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
