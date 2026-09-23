"""物料齐套中心 — 对外齐套计算手动触发与批次查询"""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.models.material.kitting import KittingRun
from app.schemas.common import ResponseModel
from app.services.material import kitting_calc_service

logger = logging.getLogger(__name__)

router = APIRouter()

# 持有后台任务强引用，避免 asyncio.create_task 返回的任务被 GC 回收
_background_tasks: set = set()


def _on_background_task_done(task: asyncio.Task) -> None:
    """后台任务收尾：释放强引用，并记录未捕获异常（否则异常静默丢失）"""
    _background_tasks.discard(task)
    if not task.cancelled() and task.exception() is not None:
        logger.error("齐套重算后台任务异常", exc_info=task.exception())


def _current_user_id(current_user: dict) -> Optional[int]:
    """取当前用户 id：PermissionChecker 返回 JWT payload（id 在 sub），get_current_user 返回 user_id。"""
    raw = current_user.get("user_id") or current_user.get("id") or current_user.get("sub")
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


@router.post("/recompute", response_model=ResponseModel[dict])
async def recompute_kitting(
    current_user: dict = Depends(PermissionChecker("materials.kitting", "manage")),
    db: AsyncSession = Depends(get_db),
):
    """手动触发齐套全量重算（后台执行，返回 allocation_run_id 供轮询）"""
    if kitting_calc_service.is_running():
        raise HTTPException(status_code=409, detail="齐套计算正在进行中，请稍后重试")

    user_id = _current_user_id(current_user)
    run_id = kitting_calc_service.new_run_id()
    db.add(
        KittingRun(
            allocation_run_id=run_id,
            calculation_version=kitting_calc_service.CALCULATION_VERSION,
            trigger_type="manual",
            triggered_by=user_id,
            status="running",
        )
    )
    await db.commit()

    task = asyncio.create_task(
        kitting_calc_service.calculate_kitting(
            allocation_run_id=run_id,
            trigger_type="manual",
            triggered_by=user_id,
        )
    )
    _background_tasks.add(task)
    task.add_done_callback(_on_background_task_done)
    return ResponseModel(data={"allocation_run_id": run_id, "status": "running"})


@router.get("/runs/{allocation_run_id}", response_model=ResponseModel[dict])
async def get_kitting_run(
    allocation_run_id: str,
    current_user: dict = Depends(PermissionChecker("materials.kitting", "read")),
    db: AsyncSession = Depends(get_db),
):
    """查询齐套计算批次状态"""
    run = (
        await db.execute(
            select(KittingRun).where(KittingRun.allocation_run_id == allocation_run_id)
        )
    ).scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail="批次不存在")
    return ResponseModel(
        data={
            "allocation_run_id": run.allocation_run_id,
            "status": run.status,
            "trigger_type": run.trigger_type,
            "demand_count": run.demand_count,
            "full_count": run.full_count,
            "partial_count": run.partial_count,
            "shortage_count": run.shortage_count,
            "pending_count": run.pending_count,
            "blocked_count": run.blocked_count,
            "data_as_of": run.data_as_of.isoformat() if run.data_as_of else None,
            "started_at": run.started_at.isoformat() if run.started_at else None,
            "finished_at": run.finished_at.isoformat() if run.finished_at else None,
            "duration_ms": run.duration_ms,
            "error_message": run.error_message,
        }
    )
