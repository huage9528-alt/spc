"""库存看板 — API 路由"""

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.schemas.common import ResponseModel
from app.schemas.material.inventory_board import (
    CheckCoverageResponse,
    InventoryOverviewResponse,
)
from app.services.material.inventory_board_service import (
    get_check_coverage,
    get_inventory_overview,
    get_stock_check_overview,
)

router = APIRouter()


@router.get("/overview", response_model=ResponseModel[InventoryOverviewResponse])
async def inventory_overview(
    warehouse_id: Optional[int] = Query(None, description="仓库 ID 筛选"),
    category: Optional[str] = Query(None, description="物料类别筛选"),
    current_user: dict = Depends(PermissionChecker("materials.inventory_board", "read")),
    db: AsyncSession = Depends(get_db),
):
    """库存看板 — 库存概览（KPI + 仓库/类别分布 + 库龄 + 低库存 + 筛选下拉）"""
    data = await get_inventory_overview(db, warehouse_id=warehouse_id, category=category)
    return ResponseModel(data=InventoryOverviewResponse(**data))


@router.get("/coverage", response_model=ResponseModel[CheckCoverageResponse])
async def check_coverage(
    recent_days: int = Query(
        30, ge=-1, le=100000, description="已盘判定窗口：7/30；-1=全部历史"
    ),
    current_user: dict = Depends(PermissionChecker("materials.inventory_board", "read")),
    db: AsyncSession = Depends(get_db),
):
    """库存看板 — 盘点覆盖（已盘 / 未盘 物料×仓库，按仓库分组）"""
    data = await get_check_coverage(db, recent_days=recent_days)
    return ResponseModel(data=CheckCoverageResponse(**data))


@router.get("/stock-check", response_model=ResponseModel[dict])
async def stock_check_overview(
    trend_days: int = Query(30, ge=1, le=180),
    active_limit: int = Query(20, ge=1, le=100),
    diff_limit: int = Query(20, ge=1, le=100),
    current_user: dict = Depends(PermissionChecker("materials.inventory_board", "read")),
    db: AsyncSession = Depends(get_db),
):
    """库存看板 — 盘点概览（KPI + 进行中盘点单 + 趋势 + 近期差异）"""
    data = await get_stock_check_overview(
        db,
        trend_days=trend_days,
        active_limit=active_limit,
        diff_limit=diff_limit,
    )
    return ResponseModel(data=data)