"""基础数据与集成中心 — 数据供给 API 路由"""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.schemas.common import ResponseModel
from app.schemas.basicdata.data_supply_schemas import (
    DataSupplyApiKeyCreate, DataSupplyApiKeyUpdate, DataSupplyApiKeyOut,
    DataSupplyApiKeyCreateResult,
    DataSupplyCallLogOut,
    DataSupplyCallStatistics,
)
from app.models.basicdata.data_supply import DataSupplyApiKey, DataSupplyCallLog
from app.services.basicdata.data_supply_service import (
    get_call_statistics,
    generate_api_key, generate_app_key, generate_app_secret,
)

router = APIRouter()


# ═══════════════════════════════════════════
# 管理接口（需要登录 + 权限）
# ═══════════════════════════════════════════

# ── API Key 管理 ──

@router.get("/endpoints", response_model=ResponseModel[list])
async def list_registered_endpoints(
    current_user: dict = Depends(PermissionChecker("basicdata.data_supply", "read")),
):
    """获取所有已注册的对外接口 endpoint 清单（供 API Key 表单勾选）"""
    from app.api.v1.external.registry import list_endpoint_dicts
    return ResponseModel(data=list_endpoint_dicts())


@router.get("/api-keys", response_model=ResponseModel[dict])
async def list_api_keys(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: dict = Depends(PermissionChecker("basicdata.data_supply", "read")),
    db: AsyncSession = Depends(get_db),
):
    """查询 API Key 列表"""
    query = select(DataSupplyApiKey).order_by(desc(DataSupplyApiKey.id))
    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = [DataSupplyApiKeyOut.model_validate(r) for r in result.scalars().all()]
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.post("/api-keys", response_model=ResponseModel[DataSupplyApiKeyCreateResult])
async def create_api_key(
    data: DataSupplyApiKeyCreate,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data_supply", "create")),
):
    """创建 API Key（AppKey + AppSecret 仅在创建时返回一次）"""
    api_key = generate_api_key()
    app_key = generate_app_key()
    app_secret = generate_app_secret()
    db_item = DataSupplyApiKey(
        key_name=data.key_name,
        api_key=api_key,
        app_key=app_key,
        app_secret=app_secret,
        description=data.description,
        is_active=True,
        allowed_endpoints_json=data.allowed_endpoints_json,
        rate_limit=data.rate_limit,
        expires_at=data.expires_at,
        ip_whitelist_json=data.ip_whitelist_json,
        created_by=current_user.get("username", ""),
    )
    db.add(db_item)
    await db.commit()
    await db.refresh(db_item)
    return ResponseModel(data=DataSupplyApiKeyCreateResult.model_validate(db_item))


@router.put("/api-keys/{key_id}", response_model=ResponseModel[DataSupplyApiKeyOut])
async def update_api_key(
    key_id: int,
    data: DataSupplyApiKeyUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data_supply", "update")),
):
    """更新 API Key"""
    result = await db.execute(select(DataSupplyApiKey).where(DataSupplyApiKey.id == key_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="API Key 不存在")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(db_item, field, value)
    await db.commit()
    await db.refresh(db_item)
    return ResponseModel(data=DataSupplyApiKeyOut.model_validate(db_item))


@router.delete("/api-keys/{key_id}", response_model=ResponseModel)
async def delete_api_key(
    key_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(PermissionChecker("basicdata.data_supply", "delete")),
):
    """删除 API Key"""
    result = await db.execute(select(DataSupplyApiKey).where(DataSupplyApiKey.id == key_id))
    db_item = result.scalar_one_or_none()
    if not db_item:
        raise HTTPException(status_code=404, detail="API Key 不存在")
    await db.delete(db_item)
    await db.commit()
    return ResponseModel(message="删除成功")


# ── 调用日志 ──

@router.get("/call-logs", response_model=ResponseModel[dict])
async def list_call_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    api_key_id: Optional[int] = Query(None),
    data_type: Optional[str] = Query(None),
    start_date: Optional[str] = Query(None, description="开始日期 (YYYY-MM-DD)"),
    end_date: Optional[str] = Query(None, description="结束日期 (YYYY-MM-DD)"),
    current_user: dict = Depends(PermissionChecker("basicdata.data_supply", "read")),
    db: AsyncSession = Depends(get_db),
):
    """查询调用日志"""
    query = select(DataSupplyCallLog).order_by(desc(DataSupplyCallLog.called_at))
    if api_key_id:
        query = query.where(DataSupplyCallLog.api_key_id == api_key_id)
    if data_type:
        query = query.where(DataSupplyCallLog.data_type == data_type)
    if start_date:
        query = query.where(DataSupplyCallLog.called_at >= datetime.fromisoformat(start_date))
    if end_date:
        query = query.where(DataSupplyCallLog.called_at <= datetime.fromisoformat(end_date + "T23:59:59"))

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = [DataSupplyCallLogOut.model_validate(r) for r in result.scalars().all()]
    return ResponseModel(data={"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/statistics", response_model=ResponseModel[dict])
async def get_statistics(
    api_key_id: Optional[int] = Query(None),
    data_type: Optional[str] = Query(None, description="按接口筛选 (endpoint_code)"),
    start_date: Optional[str] = Query(None, description="开始日期 (YYYY-MM-DD)"),
    end_date: Optional[str] = Query(None, description="结束日期 (YYYY-MM-DD)"),
    current_user: dict = Depends(PermissionChecker("basicdata.data_supply", "read")),
    db: AsyncSession = Depends(get_db),
):
    """获取调用统计"""
    sd = datetime.fromisoformat(start_date) if start_date else None
    ed = datetime.fromisoformat(end_date + "T23:59:59") if end_date else None
    result = await get_call_statistics(db, api_key_id, sd, ed, data_type=data_type)
    return ResponseModel(data=result)


@router.get("/exposable-internal-endpoints", response_model=ResponseModel)
async def list_exposable_internal_endpoints(
    current_user: dict = Depends(PermissionChecker("basicdata.data_supply", "read")),
):
    """列出所有 @exposable 标记的内部接口，给 API Key 表单勾选用。"""
    from app.services.basicdata.exposable_registry import list_exposable_endpoints
    return ResponseModel(
        code=0,
        message="ok",
        data=list_exposable_endpoints(),
    )

