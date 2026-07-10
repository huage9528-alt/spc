"""冷冻区干预机制工具（v2 第 4 层）

判断计划是否在冷冻区，以及破冻操作的支持。
"""
from datetime import date, timedelta
from typing import Optional


def is_plan_in_frozen_zone(plan_date: Optional[date], today: Optional[date] = None) -> bool:
    """判断计划是否在冷冻区（plan_date 在 today+1 到 today+3 之间）

    v2 R1: 冷冻区口径 = plan_date 归属（不是区间相交）
    """
    if not plan_date:
        return False
    today = today or date.today()
    frozen_start = today + timedelta(days=1)
    frozen_end = today + timedelta(days=3)
    return frozen_start <= plan_date <= frozen_end


def require_break_frozen_reason(
    plan_date: Optional[date],
    break_frozen_reason: Optional[str],
    today: Optional[date] = None,
) -> None:
    """如果计划在冷冻区，必须提供破冻理由，否则抛 HTTPException

    用法（在删除/修改接口里）：
        from fastapi import HTTPException
        require_break_frozen_reason(record.plan_date, break_frozen_reason)
    """
    from fastapi import HTTPException
    if is_plan_in_frozen_zone(plan_date, today):
        if not break_frozen_reason or not break_frozen_reason.strip():
            raise HTTPException(
                status_code=403,
                detail="该计划在冷冻区（1-3 天内开工），必须填写破冻理由才能操作",
            )
