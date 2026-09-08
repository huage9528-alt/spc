from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.core.audit import log_audit
from app.models.order.sale_order import SaleOrder
from app.schemas.common import ResponseModel
from app.services.exception.risk_engine import RiskEngine

router = APIRouter()


@router.post("/scan", response_model=ResponseModel[dict])
async def trigger_risk_scan(
    current_user: dict = Depends(PermissionChecker("orders.risk_pool", "update")),
    db: AsyncSession = Depends(get_db),
):
    """手动触发风险扫描（评估订单 + 生成RiskIssue）"""
    engine = RiskEngine(db)
    result = await engine.run_full_scan(operator=current_user["username"])
    await log_audit(db, "risk_issue", 0, "scan", operator=current_user["username"])
    await db.commit()
    return ResponseModel(data=result)


@router.post("/assess", response_model=ResponseModel[dict])
async def trigger_risk_assess(
    current_user: dict = Depends(PermissionChecker("orders.risk_pool", "update")),
    db: AsyncSession = Depends(get_db),
):
    """仅执行风险评估（不生成RiskIssue，写回risk_level/risk_score/risk_factors）"""
    engine = RiskEngine(db)
    result = await engine.assess_all_orders(operator=current_user["username"])
    await log_audit(db, "sale_order", 0, "risk_assessment", operator=current_user["username"])
    await db.commit()
    return ResponseModel(data=result)


@router.post("/assess/{order_no}", response_model=ResponseModel[dict])
async def assess_single_order(
    order_no: str,
    current_user: dict = Depends(PermissionChecker("orders.risk_pool", "update")),
    db: AsyncSession = Depends(get_db),
):
    """评估单个订单的风险等级"""
    result = await db.execute(
        select(SaleOrder).where(SaleOrder.order_no == order_no).order_by(SaleOrder.id.desc()).limit(1)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")

    engine = RiskEngine(db)
    assessment = await engine.assess_order(order)

    order.risk_level = assessment["risk_level"]
    order.risk_score = assessment["final_score"]
    order.risk_factors = assessment["factors"]
    from datetime import datetime
    order.risk_assessed_at = datetime.now()
    await log_audit(db, "sale_order", order.id, "risk_assessment", field_name="risk_score", new_value=str(assessment["final_score"]), operator=current_user["username"])
    await db.commit()

    return ResponseModel(data=assessment)


@router.get("/assessment-result/{order_no}", response_model=ResponseModel[dict])
async def get_assessment_result(
    order_no: str,
    current_user: dict = Depends(PermissionChecker("orders.risk_pool", "read")),
    db: AsyncSession = Depends(get_db),
):
    """查询单个订单的风险评估结果"""
    result = await db.execute(
        select(SaleOrder).where(SaleOrder.order_no == order_no).order_by(SaleOrder.id.desc()).limit(1)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")

    return ResponseModel(data={
        "order_no": order.order_no,
        "risk_level": order.risk_level,
        "risk_score": float(order.risk_score) if order.risk_score else None,
        "risk_factors": order.risk_factors,
        "risk_assessed_at": order.risk_assessed_at.isoformat() if order.risk_assessed_at else None,
    })
