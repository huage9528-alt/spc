"""生产协同中心 — 372 驾驶舱 KPI 聚合 API

阶段 1a 最小版：接通 today + pending，frozen/material 返回 None，anomalies 空。
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker, decode_access_token, oauth2_scheme
from app.schemas.common import ResponseModel
from app.services.production.kpi_summary_service import get_kpi_summary, get_today_cards, get_workshop_overview

router = APIRouter()


async def _lightweight_auth(token: str = Depends(oauth2_scheme)) -> dict:
    """轻量级鉴权：只验证 token 有效性，不查数据库（驾驶舱数据不敏感，且需要快）"""
    payload = decode_access_token(token)
    return payload


@router.get("", response_model=ResponseModel)
async def get_kpi_summary_endpoint(
    current_user: dict = Depends(_lightweight_auth),
    db: AsyncSession = Depends(get_db),
):
    data = await get_kpi_summary(db)
    return ResponseModel(data=data)


@router.get("/today-cards", response_model=ResponseModel)
async def get_today_cards_endpoint(
    current_user: dict = Depends(_lightweight_auth),
    db: AsyncSession = Depends(get_db),
):
    data = await get_today_cards(db)
    return ResponseModel(data=data)


@router.get("/workshop-overview", response_model=ResponseModel)
async def get_workshop_overview_endpoint(
    process_type: str,
    current_user: dict = Depends(_lightweight_auth),
    db: AsyncSession = Depends(get_db),
):
    """车间概况：统计卡 + 趋势 + TOP 订单（从排产计划自动派生）"""
    if process_type not in ("lean", "assembly", "packaging"):
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="process_type 只支持 lean/assembly/packaging")
    data = await get_workshop_overview(db, process_type)
    return ResponseModel(data=data)
