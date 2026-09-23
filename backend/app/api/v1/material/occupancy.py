"""物料齐套中心 — 物料占用分析 API"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.schemas.common import ResponseModel
from app.schemas.material.occupancy import (
    MaterialOccupancyResponse,
    MaterialSearchItem,
    OrderOccupancyResponse,
)
from app.services.material.occupancy_service import (
    get_occupancy_by_material,
    get_occupancy_by_order,
    search_materials,
    search_open_orders,
)

router = APIRouter()


@router.get("/by-material", response_model=ResponseModel[MaterialOccupancyResponse])
async def occupancy_by_material(
    material_code: str = Query(..., min_length=1, description="物料编码，精确匹配"),
    current_user: dict = Depends(PermissionChecker("materials.occupancy", "read")),
    db: AsyncSession = Depends(get_db),
):
    """物料占用分析 — 按物料查（订单行按合同交期占用库存）"""
    data = await get_occupancy_by_material(db, material_code=material_code.strip())
    if data is None:
        raise HTTPException(status_code=404, detail="物料不存在")
    return ResponseModel(data=data)


@router.get("/by-order", response_model=ResponseModel[OrderOccupancyResponse])
async def occupancy_by_order(
    order_no: str = Query(..., min_length=1, description="销售订单号"),
    current_user: dict = Depends(PermissionChecker("materials.occupancy", "read")),
    db: AsyncSession = Depends(get_db),
):
    """物料占用分析 — 按订单 BOM 查（各物料在本订单的占用竞争结果）"""
    data = await get_occupancy_by_order(db, order_no=order_no.strip())
    if data is None:
        raise HTTPException(status_code=404, detail="订单不存在")
    return ResponseModel(data=data)


@router.get("/search-materials", response_model=ResponseModel[list[MaterialSearchItem]])
async def occupancy_search_materials(
    keyword: Optional[str] = Query(None, description="物料编码/名称模糊匹配"),
    limit: int = Query(20, ge=1, le=50),
    current_user: dict = Depends(PermissionChecker("materials.occupancy", "read")),
    db: AsyncSession = Depends(get_db),
):
    """物料占用分析 — 物料搜索下拉"""
    return ResponseModel(data=await search_materials(db, keyword=keyword, limit=limit))


@router.get("/search-orders", response_model=ResponseModel[list[str]])
async def occupancy_search_orders(
    keyword: Optional[str] = Query(None, description="订单号模糊匹配（仅未关闭订单）"),
    limit: int = Query(20, ge=1, le=50),
    current_user: dict = Depends(PermissionChecker("materials.occupancy", "read")),
    db: AsyncSession = Depends(get_db),
):
    """物料占用分析 — 订单号搜索下拉"""
    return ResponseModel(data=await search_open_orders(db, keyword=keyword, limit=limit))
