"""Production schedule plan API."""

from datetime import date, datetime, timedelta
from typing import Optional, List
import math

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.database import get_db
from app.core.security import PermissionChecker
from app.models.production.schedule_plan import ProductionSchedulePlan
from app.models.production.schedule_operation_log import ProductionScheduleOperationLog
from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.models.production.product_process_capacity import ProductProcessCapacity
from app.models.rules.node_standard import NodeStandard
from app.schemas.common import PageResult, ResponseModel
from app.schemas.production.schemas import (
    ProductionSchedulePlanCreate,
    ProductionSchedulePlanOut,
    ProductionSchedulePlanUpdate,
    OrderForSchedulingOut,
    AutoScheduleRequest,
    AutoScheduleResponse,
    SaleOrderLineChangeLogOut,
    UpphImpactPlanOut,
    BatchRescheduleRequest,
    BatchRescheduleResponse,
    BatchRescheduleItemOut,
    ProductionScheduleOperationLogOut,
    MissingUpphProductOut,
    MissingUpphListOut,
    EmptyStateOut,
)
from app.services.production.production_change_service import ProductionChangeService
from app.services.production.upph_calculation_service import UpphCalculationService

router = APIRouter()

async def _log_schedule_operation(
    db: AsyncSession,
    operation_type: str,
    operator: str,
    *,
    plan_id: Optional[int] = None,
    plan_version: Optional[int] = None,
    order_no: Optional[str] = None,
    line_no: Optional[str] = None,
    remark: Optional[str] = None,
    affected_plan_ids: Optional[List[int]] = None,
    previous_version_id: Optional[int] = None,
) -> Optional[ProductionScheduleOperationLog]:
    """记录排产操作日志（日志表缺失时不影响主业务事务）"""
    import json

    try:
        async with db.begin_nested():
            log_item = ProductionScheduleOperationLog(
                plan_id=plan_id,
                plan_version=plan_version,
                order_no=order_no,
                line_no=line_no,
                operation_type=operation_type,
                operator=operator,
                remark=remark,
                affected_plan_ids=json.dumps(affected_plan_ids) if affected_plan_ids else None,
                previous_version_id=previous_version_id,
            )
            db.add(log_item)
            await db.flush([log_item])
            return log_item
    except Exception:
        return None

IMPACT_PRIORITY_MAP = {
    "high": 0,
    "medium": 1,
    "low": 2,
}


async def _get_impact_config(db: AsyncSession) -> dict:
    """获取 UPPH 影响等级配置（默认值兜底）"""
    config_codes = [
        "upph_impact_high_ratio",
        "upph_impact_medium_ratio",
        "upph_impact_high_day_delta",
        "upph_impact_medium_day_delta",
        "upph_impact_medium_score",
        "upph_impact_qty_high",
        "upph_impact_qty_medium",
        "upph_impact_qty_bonus_high",
        "upph_impact_qty_bonus_medium",
        "upph_impact_due_days_urgent",
        "upph_impact_due_days_normal",
        "upph_impact_due_days_loose",
        "upph_impact_due_bonus_urgent",
        "upph_impact_due_bonus_normal",
        "upph_impact_due_bonus_loose",
        "upph_impact_day_bonus",
    ]
    result = await db.execute(
        select(NodeStandard)
        .where(NodeStandard.node_code.in_(config_codes), NodeStandard.is_active == True)
    )
    configs = {item.node_code: item for item in result.scalars().all()}
    
    return {
        "high_ratio": float(configs.get("upph_impact_high_ratio").time_value) if configs.get("upph_impact_high_ratio") else 0.3,
        "medium_ratio": float(configs.get("upph_impact_medium_ratio").time_value) if configs.get("upph_impact_medium_ratio") else 0.1,
        "high_day_delta": int(configs.get("upph_impact_high_day_delta").time_value) if configs.get("upph_impact_high_day_delta") else 2,
        "medium_day_delta": int(configs.get("upph_impact_medium_day_delta").time_value) if configs.get("upph_impact_medium_day_delta") else 1,
        "medium_score": float(configs.get("upph_impact_medium_score").time_value) if configs.get("upph_impact_medium_score") else 30,
        "qty_high": float(configs.get("upph_impact_qty_high").time_value) if configs.get("upph_impact_qty_high") else 1000,
        "qty_medium": float(configs.get("upph_impact_qty_medium").time_value) if configs.get("upph_impact_qty_medium") else 500,
        "qty_bonus_high": float(configs.get("upph_impact_qty_bonus_high").time_value) if configs.get("upph_impact_qty_bonus_high") else 15,
        "qty_bonus_medium": float(configs.get("upph_impact_qty_bonus_medium").time_value) if configs.get("upph_impact_qty_bonus_medium") else 8,
        "due_days_urgent": int(configs.get("upph_impact_due_days_urgent").time_value) if configs.get("upph_impact_due_days_urgent") else 3,
        "due_days_normal": int(configs.get("upph_impact_due_days_normal").time_value) if configs.get("upph_impact_due_days_normal") else 7,
        "due_days_loose": int(configs.get("upph_impact_due_days_loose").time_value) if configs.get("upph_impact_due_days_loose") else 14,
        "due_bonus_urgent": float(configs.get("upph_impact_due_bonus_urgent").time_value) if configs.get("upph_impact_due_bonus_urgent") else 20,
        "due_bonus_normal": float(configs.get("upph_impact_due_bonus_normal").time_value) if configs.get("upph_impact_due_bonus_normal") else 10,
        "due_bonus_loose": float(configs.get("upph_impact_due_bonus_loose").time_value) if configs.get("upph_impact_due_bonus_loose") else 5,
        "day_bonus": float(configs.get("upph_impact_day_bonus").time_value) if configs.get("upph_impact_day_bonus") else 6,
    }


def _to_float(value, default: Optional[float] = None) -> Optional[float]:
    if value is None:
        return default
    return float(value)


def _resolve_priority_by_risk(risk_level: Optional[str]) -> str:
    priority_map = {
        "red": "urgent",
        "yellow": "high",
        "blue": "normal",
        "green": "low",
    }
    return priority_map.get(risk_level or "green", "normal")


def _calculate_delivery_status(
    end_date: Optional[date],
    customer_due_date: Optional[date],
) -> tuple[Optional[int], str]:
    if not end_date or not customer_due_date:
        return None, "unknown"

    delay_days = (end_date - customer_due_date).days
    if delay_days > 0:
        return delay_days, "delayed"

    due_gap = (customer_due_date - date.today()).days
    if 0 <= due_gap <= 3:
        return 0, "upcoming"

    return 0, "normal"


async def _build_promised_date_map(
    db: AsyncSession,
    plans: List[ProductionSchedulePlan],
) -> dict[tuple[str, str], date]:
    missing_keys = {
        (plan.order_no, plan.line_no)
        for plan in plans
        if plan.order_no and plan.line_no and not plan.source_promised_date
    }
    if not missing_keys:
        return {}

    conditions = [
        and_(SaleOrderLine.order_no == order_no, SaleOrderLine.line_no == line_no)
        for order_no, line_no in missing_keys
    ]
    result = await db.execute(
        select(SaleOrderLine)
        .where(or_(*conditions))
        .order_by(SaleOrderLine.id.desc())
    )

    promised_date_map: dict[tuple[str, str], date] = {}
    for row in result.scalars().all():
        key = (row.order_no, row.line_no)
        if key not in promised_date_map and row.promised_date:
            promised_date_map[key] = row.promised_date
    return promised_date_map


def _serialize_schedule_plan(
    plan: ProductionSchedulePlan,
    promised_date_map: Optional[dict[tuple[str, str], date]] = None,
) -> ProductionSchedulePlanOut:
    customer_due_date = plan.source_promised_date
    if not customer_due_date and promised_date_map and plan.order_no and plan.line_no:
        customer_due_date = promised_date_map.get((plan.order_no, plan.line_no))

    delay_days, delivery_status = _calculate_delivery_status(plan.end_date, customer_due_date)
    latest_reschedule_at = plan.created_at if (plan.plan_version or 1) > 1 else None

    payload = ProductionSchedulePlanOut.model_validate(plan)
    return payload.model_copy(update={
        "customer_due_date": customer_due_date,
        "delay_days": delay_days,
        "delivery_status": delivery_status,
        "latest_reschedule_at": latest_reschedule_at,
    })


def _calculate_schedule_result(
    quantity: float,
    upph: float,
    daily_hours: float,
    promised_date: date,
) -> dict:
    total_hours = float(quantity) / float(upph)
    days_needed = max(1, math.ceil(total_hours / float(daily_hours)))

    end_date = promised_date
    start_date = end_date - timedelta(days=days_needed - 1)

    today = date.today()
    warning = ""
    if start_date < today:
        start_date = today
        end_date = start_date + timedelta(days=days_needed - 1)
        warning = f"【延期预警】按产能顺推，预计完工日期({end_date})晚于承诺交期({promised_date})！"

    return {
        "total_hours": round(total_hours, 2),
        "days_needed": days_needed,
        "start_date": start_date,
        "end_date": end_date,
        "warning": warning,
    }


async def _get_latest_sale_order_line(
    db: AsyncSession,
    order_no: Optional[str],
    line_no: Optional[str],
):
    result = await db.execute(
        select(SaleOrderLine, SaleOrder.risk_level)
        .outerjoin(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)
        .where(and_(
            SaleOrderLine.order_no == order_no,
            SaleOrderLine.line_no == line_no,
        ))
        .order_by(SaleOrderLine.id.desc())
        .limit(1)
    )
    return result.first()


async def _reschedule_plan_version(
    db: AsyncSession,
    plan_id: int,
    operator: str,
) -> ProductionSchedulePlan:
    old_plan_result = await db.execute(
        select(ProductionSchedulePlan).where(ProductionSchedulePlan.id == plan_id)
    )
    old_plan = old_plan_result.scalar_one_or_none()
    if not old_plan:
        raise HTTPException(status_code=404, detail="原排产计划不存在")

    row = await _get_latest_sale_order_line(db, old_plan.order_no, old_plan.line_no)
    if not row:
        raise HTTPException(status_code=404, detail="订单行不存在，无法重排")

    current_sale_order_line = row.SaleOrderLine
    risk_level = row.risk_level

    if not current_sale_order_line.promised_date:
        raise HTTPException(status_code=400, detail="订单行没有交期，无法重排")

    if not current_sale_order_line.order_qty or current_sale_order_line.order_qty <= 0:
        raise HTTPException(status_code=400, detail="订单行数量无效，无法重排")

    upph_service = UpphCalculationService(db)
    upph, _ = await upph_service.calculate_total_upph(
        product_code=current_sale_order_line.product_code,
        bom_code=getattr(current_sale_order_line, "bom_code", None),
    )
    if upph is None or upph <= 0:
        raise HTTPException(status_code=400, detail="缺少UPPH数据，请在订单或产品中配置，或手动指定")

    daily_hours = _to_float(old_plan.daily_work_hours)
    if daily_hours is None:
        config_result = await db.execute(select(NodeStandard).where(NodeStandard.node_code == "daily_work_hours"))
        config_item = config_result.scalar_one_or_none()
        daily_hours = float(config_item.time_value) if config_item else 8

    if daily_hours <= 0:
        raise HTTPException(status_code=400, detail="每日工作时间必须大于0")

    calculation_result = _calculate_schedule_result(
        quantity=float(current_sale_order_line.order_qty),
        upph=float(upph),
        daily_hours=float(daily_hours),
        promised_date=current_sale_order_line.promised_date,
    )
    priority = _resolve_priority_by_risk(risk_level)

    new_plan_version = old_plan.plan_version + 1
    plan_date = date.today()
    reschedule_reason = old_plan.reschedule_reason or "手动重排"
    warning = calculation_result["warning"]

    new_schedule_data = ProductionSchedulePlanCreate(
        department=old_plan.department,
        plan_date=plan_date,
        order_no=current_sale_order_line.order_no,
        line_no=current_sale_order_line.line_no,
        product_code=current_sale_order_line.product_code,
        model_code=current_sale_order_line.product_model,
        quantity=float(current_sale_order_line.order_qty or 0),
        start_date=calculation_result["start_date"],
        end_date=calculation_result["end_date"],
        priority=priority,
        status="planned",
        upph=upph,
        daily_work_hours=daily_hours,
        owner=old_plan.owner,
        remark=f"重排：{warning + ' ' if warning else ''}原计划ID:{old_plan.id}, 原因:{reschedule_reason}",
        plan_version=new_plan_version,
        is_active=True,
        source_promised_date=current_sale_order_line.promised_date,
        source_order_qty=float(current_sale_order_line.order_qty or 0),
        source_product_code=current_sale_order_line.product_code,
        source_product_model=current_sale_order_line.product_model,
        source_upph=upph,
        previous_plan_id=old_plan.id,
        needs_reschedule=False,
        reschedule_reason=None,
    )

    new_record = ProductionSchedulePlan(**new_schedule_data.model_dump(), created_by=operator)
    db.add(new_record)

    old_plan.is_active = False
    old_plan.needs_reschedule = False
    old_plan.reschedule_reason = "已重排"
    db.add(old_plan)

    await db.flush()
    await log_audit(
        db,
        "production_schedule_plan",
        new_record.id,
        "reschedule",
        operator=operator,
        old_obj=old_plan,
    )
    return new_record


async def _build_upph_impact_items(
    db: AsyncSession,
    plans: List[ProductionSchedulePlan],
    impact_config: Optional[dict] = None,
) -> List[UpphImpactPlanOut]:
    if impact_config is None:
        impact_config = await _get_impact_config(db)

    product_codes = sorted({
        plan.product_code or plan.source_product_code
        for plan in plans
        if plan.product_code or plan.source_product_code
    })
    current_upph_map = {}
    upph_service = UpphCalculationService(db)
    for product_code in product_codes:
        current_upph, _ = await upph_service.calculate_total_upph(product_code=product_code)
        current_upph_map[product_code] = float(current_upph or 0)

    today = date.today()
    items: List[UpphImpactPlanOut] = []
    for plan in plans:
        product_code = plan.product_code or plan.source_product_code
        source_upph = _to_float(plan.source_upph, _to_float(plan.upph))
        current_upph = float(current_upph_map.get(product_code, 0))

        if not source_upph or source_upph <= 0:
            continue
        if abs(current_upph - source_upph) < 0.0001:
            continue

        quantity = _to_float(plan.source_order_qty, _to_float(plan.quantity, 0)) or 0
        daily_hours = _to_float(plan.daily_work_hours, 8) or 8
        promised_date = plan.source_promised_date

        planned_total_hours = round(quantity / source_upph, 2) if quantity > 0 else None
        planned_days_needed = max(1, math.ceil(planned_total_hours / daily_hours)) if planned_total_hours else None
        current_total_hours = round(quantity / current_upph, 2) if quantity > 0 and current_upph > 0 else None
        current_days_needed = max(1, math.ceil(current_total_hours / daily_hours)) if current_total_hours else None

        upph_delta = round(current_upph - source_upph, 2)
        upph_delta_ratio = round((current_upph - source_upph) / source_upph, 4)
        day_delta = abs((current_days_needed or 0) - (planned_days_needed or 0))

        impact_score = abs(upph_delta_ratio) * 100
        if quantity >= impact_config["qty_high"]:
            impact_score += impact_config["qty_bonus_high"]
        elif quantity >= impact_config["qty_medium"]:
            impact_score += impact_config["qty_bonus_medium"]

        if promised_date:
            due_days = (promised_date - today).days
            if due_days <= impact_config["due_days_urgent"]:
                impact_score += impact_config["due_bonus_urgent"]
            elif due_days <= impact_config["due_days_normal"]:
                impact_score += impact_config["due_bonus_normal"]
            elif due_days <= impact_config["due_days_loose"]:
                impact_score += impact_config["due_bonus_loose"]

        impact_score += day_delta * impact_config["day_bonus"]
        impact_score = round(impact_score, 2)

        if current_upph <= 0 or abs(upph_delta_ratio) >= impact_config["high_ratio"] or day_delta >= impact_config["high_day_delta"]:
            impact_level = "high"
        elif abs(upph_delta_ratio) >= impact_config["medium_ratio"] or day_delta >= impact_config["medium_day_delta"] or impact_score >= impact_config["medium_score"]:
            impact_level = "medium"
        else:
            impact_level = "low"

        reason_parts = [
            f"UPPH {source_upph:.2f} -> {current_upph:.2f}",
            f"变化{upph_delta_ratio * 100:.1f}%",
        ]
        if planned_total_hours is not None and current_total_hours is not None:
            reason_parts.append(f"工时 {planned_total_hours:.2f}h -> {current_total_hours:.2f}h")
        elif current_upph <= 0:
            reason_parts.append("当前无有效UPPH")
        if planned_days_needed is not None and current_days_needed is not None:
            reason_parts.append(f"天数 {planned_days_needed} -> {current_days_needed}")

        items.append(UpphImpactPlanOut(
            id=plan.id,
            department=plan.department,
            order_no=plan.order_no,
            line_no=plan.line_no,
            product_code=product_code,
            model_code=plan.model_code,
            quantity=quantity,
            owner=plan.owner,
            status=plan.status,
            plan_date=plan.plan_date,
            start_date=plan.start_date,
            end_date=plan.end_date,
            source_promised_date=plan.source_promised_date,
            source_upph=source_upph,
            current_upph=round(current_upph, 2),
            upph_delta=upph_delta,
            upph_delta_ratio=upph_delta_ratio,
            planned_total_hours=planned_total_hours,
            current_total_hours=current_total_hours,
            planned_days_needed=planned_days_needed,
            current_days_needed=current_days_needed,
            impact_level=impact_level,
            impact_score=impact_score,
            impact_reason="; ".join(reason_parts),
            needs_reschedule=plan.needs_reschedule,
            reschedule_reason=plan.reschedule_reason,
        ))

    items.sort(
        key=lambda item: (
            IMPACT_PRIORITY_MAP.get(item.impact_level, 99),
            -item.impact_score,
            item.source_promised_date or date.max,
            item.plan_date,
            item.id,
        )
    )
    return items


@router.get("", response_model=ResponseModel[PageResult[ProductionSchedulePlanOut]])
async def list_schedule_plans(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    department: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    date_start: Optional[date] = Query(None),
    date_end: Optional[date] = Query(None),
    keyword: Optional[str] = Query(None),
    needs_reschedule: Optional[bool] = Query(None),
    is_active: Optional[bool] = Query(True),
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    conditions = []
    if department:
        conditions.append(ProductionSchedulePlan.department == department)
    if status:
        conditions.append(ProductionSchedulePlan.status == status)
    if date_start:
        conditions.append(ProductionSchedulePlan.plan_date >= date_start)
    if date_end:
        conditions.append(ProductionSchedulePlan.plan_date <= date_end)
    if keyword:
        like = f"%{keyword}%"
        conditions.append(
            or_(
                ProductionSchedulePlan.order_no.ilike(like),
                ProductionSchedulePlan.product_code.ilike(like),
                ProductionSchedulePlan.model_code.ilike(like),
                ProductionSchedulePlan.owner.ilike(like),
                ProductionSchedulePlan.remark.ilike(like),
            )
        )
    if needs_reschedule is not None:
        conditions.append(ProductionSchedulePlan.needs_reschedule == needs_reschedule)
    if is_active is not None:
        conditions.append(ProductionSchedulePlan.is_active == is_active)

    total = (await db.execute(select(func.count(ProductionSchedulePlan.id)).where(*conditions))).scalar() or 0
    result = await db.execute(
        select(ProductionSchedulePlan)
        .where(*conditions)
        .order_by(ProductionSchedulePlan.plan_date.desc(), ProductionSchedulePlan.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    plans = list(result.scalars().all())
    promised_date_map = await _build_promised_date_map(db, plans)
    items = [_serialize_schedule_plan(plan, promised_date_map) for plan in plans]
    return ResponseModel(data=PageResult(total=total, page=page, page_size=page_size, items=items))


@router.post("", response_model=ResponseModel[ProductionSchedulePlanOut])
async def create_schedule_plan(
    data: ProductionSchedulePlanCreate,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "create")),
    db: AsyncSession = Depends(get_db),
):
    record = ProductionSchedulePlan(**data.model_dump(), created_by=current_user["username"])
    db.add(record)
    await db.flush()
    await log_audit(db, "production_schedule_plan", record.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(record)
    return ResponseModel(data=ProductionSchedulePlanOut.model_validate(record))


@router.put("/{record_id}", response_model=ResponseModel[ProductionSchedulePlanOut])
async def update_schedule_plan(
    record_id: int,
    data: ProductionSchedulePlanUpdate,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "update")),
    db: AsyncSession = Depends(get_db),
):
    record = (await db.execute(select(ProductionSchedulePlan).where(ProductionSchedulePlan.id == record_id))).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="计划不存在")

    update_data = data.model_dump(exclude_unset=True)
    await log_audit(db, "production_schedule_plan", record.id, "update", old_obj=record, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(record, field, value)
    await db.commit()
    await db.refresh(record)
    return ResponseModel(data=ProductionSchedulePlanOut.model_validate(record))


@router.delete("/{record_id}", response_model=ResponseModel[dict])
async def delete_schedule_plan(
    record_id: int,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "delete")),
    db: AsyncSession = Depends(get_db),
):
    record = (await db.execute(select(ProductionSchedulePlan).where(ProductionSchedulePlan.id == record_id))).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="计划不存在")

    await log_audit(db, "production_schedule_plan", record.id, "delete", operator=current_user["username"])
    await _log_schedule_operation(
        db,
        "delete",
        current_user["username"],
        plan_id=record_id,
        order_no=record.order_no,
        line_no=record.line_no,
        remark="删除排产计划",
    )
    await db.delete(record)
    await db.commit()
    return ResponseModel(data={"deleted": record_id})


@router.post("/detect-changes", response_model=ResponseModel[List[SaleOrderLineChangeLogOut]])
async def detect_sale_order_line_changes(
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "update")),
    db: AsyncSession = Depends(get_db),
):
    """检测销售订单行变更并记录日志，同时标记相关排产计划需要重排"""
    service = ProductionChangeService(db)
    changed_logs = await service.detect_and_log_sale_order_line_changes()
    affected_plan_ids = [log.plan_id for log in changed_logs if log.plan_id]
    await _log_schedule_operation(
        db,
        "check_changes",
        current_user["username"],
        affected_plan_ids=affected_plan_ids if affected_plan_ids else None,
        remark=f"检测到 {len(changed_logs)} 条订单行变更",
    )
    await db.commit()
    return ResponseModel(data=[log for log in changed_logs])


@router.post("/{plan_id}/reschedule", response_model=ResponseModel[ProductionSchedulePlanOut])
async def reschedule_plan(
    plan_id: int,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "update")),
    db: AsyncSession = Depends(get_db),
):
    """重新排产一个已存在的计划"""
    new_record = await _reschedule_plan_version(db, plan_id, current_user["username"])
    await _log_schedule_operation(
        db,
        "reschedule",
        current_user["username"],
        plan_id=new_record.id,
        plan_version=new_record.plan_version,
        order_no=new_record.order_no,
        line_no=new_record.line_no,
        previous_version_id=plan_id,
        remark="单条手动重排",
    )
    await db.commit()
    await db.refresh(new_record)
    return ResponseModel(data=ProductionSchedulePlanOut.model_validate(new_record))


@router.get("/upph-impact", response_model=ResponseModel[PageResult[UpphImpactPlanOut]])
async def list_upph_impact_plans(
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(20, ge=1, le=200, description="每页数量"),
    department: Optional[str] = Query(None, description="部门筛选"),
    impact_level: Optional[str] = Query(None, description="影响程度筛选（high/medium/low）"),
    keyword: Optional[str] = Query(None, description="关键字筛选（订单/行号/产品/型号/负责人）"),
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    """
    获取 UPPH 变更影响的排产计划列表（动态计算）
    
    比较当前活跃排产计划中“排产时快照 UPPH”与“当前最新 UPPH”的差异，按影响程度排序，
    用于展示产能变化对已排计划的影响面，支持按部门、影响程度、关键字筛选，支持分页。
    """
    conditions = [ProductionSchedulePlan.is_active == True]
    if department:
        conditions.append(ProductionSchedulePlan.department == department)
    if keyword:
        like = f"%{keyword}%"
        conditions.append(
            or_(
                ProductionSchedulePlan.order_no.ilike(like),
                ProductionSchedulePlan.line_no.ilike(like),
                ProductionSchedulePlan.product_code.ilike(like),
                ProductionSchedulePlan.model_code.ilike(like),
                ProductionSchedulePlan.owner.ilike(like),
            )
        )

    # 先一次性取配置，避免多次查询
    impact_config = await _get_impact_config(db)

    result = await db.execute(
        select(ProductionSchedulePlan)
        .where(*conditions)
        .order_by(ProductionSchedulePlan.plan_date.desc(), ProductionSchedulePlan.id.desc())
    )
    plans = list(result.scalars().all())
    items = await _build_upph_impact_items(db, plans, impact_config=impact_config)

    if impact_level:
        items = [item for item in items if item.impact_level == impact_level]

    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    return ResponseModel(
        data=PageResult(
            total=total,
            page=page,
            page_size=page_size,
            items=items[start:end],
        )
    )


@router.post("/batch-reschedule", response_model=ResponseModel[BatchRescheduleResponse])
async def batch_reschedule_plans(
    data: BatchRescheduleRequest,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "update")),
    db: AsyncSession = Depends(get_db),
):
    """
    批量重排多个排产计划
    
    对选中的计划逐一按最新订单数据和最新 UPPH 重算，生成新版本计划并标记旧版本为非活跃，
    支持两种模式：
        all_or_none=True：任一条失败则全部回滚
        all_or_none=False：成功几条算几条，失败的单独回滚并记录原因
    """
    plan_ids = list(dict.fromkeys(data.plan_ids))
    if not plan_ids:
        raise HTTPException(status_code=400, detail="请选择需要重排的计划")

    items: List[BatchRescheduleItemOut] = []
    success_count = 0
    new_plan_ids_map = {}

    if data.all_or_none:
        # 模式一：全成功全回滚
        try:
            for plan_id in plan_ids:
                plan_snapshot = await db.get(ProductionSchedulePlan, plan_id)
                if not plan_snapshot:
                    items.append(BatchRescheduleItemOut(
                        plan_id=plan_id,
                        success=False,
                        message="原排产计划不存在",
                    ))
                    raise HTTPException(status_code=400, detail=f"计划 {plan_id} 不存在")
                order_no = plan_snapshot.order_no
                line_no = plan_snapshot.line_no
                new_record = await _reschedule_plan_version(db, plan_id, current_user["username"])
                success_count += 1
                new_plan_ids_map[plan_id] = new_record.id
                items.append(BatchRescheduleItemOut(
                    plan_id=plan_id,
                    new_plan_id=new_record.id,
                    order_no=order_no,
                    line_no=line_no,
                    success=True,
                    message="重排成功",
                ))

            # 全部成功后再统一写操作日志和提交
            await _log_schedule_operation(
                db,
                "batch_reschedule",
                current_user["username"],
                affected_plan_ids=plan_ids,
                remark=f"批量重排 {len(plan_ids)} 条计划（全成功全回滚模式）",
            )
            await db.commit()

            # 刷新 new record
            for new_plan_id in new_plan_ids_map.values():
                new_record = await db.get(ProductionSchedulePlan, new_plan_id)
                if new_record:
                    await db.refresh(new_record)

        except Exception as exc:
            await db.rollback()
            # 清掉部分成功的结果，全失败
            items = []
            success_count = 0
            for plan_id in plan_ids:
                result = await db.execute(
                    select(ProductionSchedulePlan.order_no, ProductionSchedulePlan.line_no)
                    .where(ProductionSchedulePlan.id == plan_id)
                )
                row = result.first()
                order_no = row.order_no if row else None
                line_no = row.line_no if row else None
                items.append(BatchRescheduleItemOut(
                    plan_id=plan_id,
                    order_no=order_no,
                    line_no=line_no,
                    success=False,
                    message=str(exc.detail) if isinstance(exc, HTTPException) else f"批量重排失败: {exc}",
                ))
    else:
        # 模式二：成功几条算几条（默认）
        for plan_id in plan_ids:
            plan_snapshot = await db.get(ProductionSchedulePlan, plan_id)
            if not plan_snapshot:
                items.append(BatchRescheduleItemOut(
                    plan_id=plan_id,
                    success=False,
                    message="原排产计划不存在",
                ))
                continue
            order_no = plan_snapshot.order_no
            line_no = plan_snapshot.line_no

            try:
                new_record = await _reschedule_plan_version(db, plan_id, current_user["username"])
                new_plan_ids_map[plan_id] = new_record.id
                await _log_schedule_operation(
                    db,
                    "reschedule",
                    current_user["username"],
                    plan_id=new_record.id,
                    plan_version=new_record.plan_version,
                    order_no=new_record.order_no,
                    line_no=new_record.line_no,
                    previous_version_id=plan_id,
                    remark="批量重排中的单条",
                )
                await db.commit()
                await db.refresh(new_record)
                success_count += 1
                items.append(BatchRescheduleItemOut(
                    plan_id=plan_id,
                    new_plan_id=new_record.id,
                    order_no=order_no,
                    line_no=line_no,
                    success=True,
                    message="重排成功",
                ))
            except HTTPException as exc:
                await db.rollback()
                items.append(BatchRescheduleItemOut(
                    plan_id=plan_id,
                    order_no=order_no,
                    line_no=line_no,
                    success=False,
                    message=str(exc.detail),
                ))
            except Exception as exc:
                await db.rollback()
                items.append(BatchRescheduleItemOut(
                    plan_id=plan_id,
                    order_no=order_no,
                    line_no=line_no,
                    success=False,
                    message=f"重排异常: {exc}",
                ))
        # 批量操作后再写一条总的批量日志
        if success_count > 0:
            await _log_schedule_operation(
                db,
                "batch_reschedule",
                current_user["username"],
                affected_plan_ids=list(new_plan_ids_map.keys()),
                remark=f"批量重排 {len(plan_ids)} 条计划，成功 {success_count} 条",
            )
            await db.commit()

    # 统计产生新延期预警的条数
    delay_warning_count = 0
    for new_plan_id in new_plan_ids_map.values():
        new_record = await db.get(ProductionSchedulePlan, new_plan_id)
        if new_record and new_record.remark and "延期预警" in new_record.remark:
            delay_warning_count += 1

    return ResponseModel(data=BatchRescheduleResponse(
        total=len(plan_ids),
        success_count=success_count,
        failed_count=len(plan_ids) - success_count,
        delay_warning_count=delay_warning_count,
        items=items,
    ))


@router.get("/operation-logs", response_model=ResponseModel[PageResult[ProductionScheduleOperationLogOut]])
async def list_operation_logs(
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(20, ge=1, le=200, description="每页数量"),
    plan_id: Optional[int] = Query(None, description="排产计划ID筛选"),
    order_no: Optional[str] = Query(None, description="订单号筛选"),
    operation_type: Optional[str] = Query(None, description="操作类型筛选"),
    operator: Optional[str] = Query(None, description="操作人筛选"),
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    """查询排产操作日志（表不存在时返回空）"""
    try:
        conditions = []
        if plan_id:
            conditions.append(ProductionScheduleOperationLog.plan_id == plan_id)
        if order_no:
            conditions.append(ProductionScheduleOperationLog.order_no == order_no)
        if operation_type:
            conditions.append(ProductionScheduleOperationLog.operation_type == operation_type)
        if operator:
            conditions.append(ProductionScheduleOperationLog.operator == operator)

        # 先查总数
        count_stmt = select(func.count(ProductionScheduleOperationLog.id))
        if conditions:
            count_stmt = count_stmt.where(*conditions)
        count_result = await db.execute(count_stmt)
        total = count_result.scalar()

        # 再查分页数据
        stmt = (
            select(ProductionScheduleOperationLog)
            .order_by(ProductionScheduleOperationLog.operation_at.desc(), ProductionScheduleOperationLog.id.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
        if conditions:
            stmt = stmt.where(*conditions)
        result = await db.execute(stmt)
        items = result.scalars().all()
        serialized_items = [ProductionScheduleOperationLogOut.model_validate(log) for log in items]

        return ResponseModel(
            data=PageResult(
                total=total,
                page=page,
                page_size=page_size,
                items=serialized_items,
            )
        )
    except Exception as exc:
        # 表不存在或其他数据库错误时返回空列表
        from sqlalchemy.exc import ProgrammingError
        if isinstance(exc, ProgrammingError) and "does not exist" in str(exc):
            return ResponseModel(
                data=PageResult(
                    total=0,
                    page=page,
                    page_size=page_size,
                    items=[],
                )
            )
        raise


# ============ 一键排产相关API ============

@router.get("/orders-for-scheduling", response_model=ResponseModel[PageResult[OrderForSchedulingOut]])
async def list_orders_for_scheduling(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    keyword: Optional[str] = Query(None),
    risk_level: Optional[str] = Query(None),
    only_unscheduled: bool = Query(False),
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    """获取当月交期的订单列表，用于排产"""
    today = date.today()
    target_year = year or today.year
    target_month = month or today.month
    
    first_day = date(target_year, target_month, 1)
    if target_month == 12:
        last_day = date(target_year + 1, 1, 1) - timedelta(days=1)
    else:
        last_day = date(target_year, target_month + 1, 1) - timedelta(days=1)
    
    conditions = [
        SaleOrderLine.promised_date >= first_day,
        SaleOrderLine.promised_date <= last_day,
        SaleOrderLine.status != "closed",
    ]
    
    if keyword:
        like = f"%{keyword}%"
        conditions.append(
            or_(
                SaleOrderLine.order_no.ilike(like),
                SaleOrderLine.product_code.ilike(like),
            )
        )
    
    # Note: risk_level is on SaleOrder, we might need a join if we want to filter by it
    # For now, we'll skip risk_level filtering on lines or join with SaleOrder
    
    # 使用子查询去重，只取每个 order_no + line_no 的最新一条
    subq = (
        select(
            SaleOrderLine.order_no,
            SaleOrderLine.line_no,
            func.max(SaleOrderLine.id).label('max_id')
        )
        .where(*conditions)
        .group_by(SaleOrderLine.order_no, SaleOrderLine.line_no)
        .subquery()
    )

    total = (await db.execute(select(func.count()).select_from(subq))).scalar() or 0
    
    result = await db.execute(
        select(SaleOrderLine, SaleOrder.customer, SaleOrder.risk_level)
        .join(
            subq,
            and_(
                SaleOrderLine.order_no == subq.c.order_no,
                SaleOrderLine.line_no == subq.c.line_no,
                SaleOrderLine.id == subq.c.max_id
            )
        )
        .outerjoin(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)
        .order_by(SaleOrderLine.promised_date.asc(), SaleOrderLine.order_no.asc(), SaleOrderLine.line_no.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    
    rows = result.all()
    
    # 查询所有相关产品的UPPH，并计算综合UPPH (直接累加法)
    product_codes = [row.SaleOrderLine.product_code for row in rows if row.SaleOrderLine.product_code]
    product_upph_map = {}
    if product_codes:
        upph_service = UpphCalculationService(db)
        for product_code in product_codes:
            if product_code and product_code not in product_upph_map:
                total_upph, _ = await upph_service.calculate_total_upph(product_code=product_code)
                if total_upph:
                    product_upph_map[product_code] = total_upph
    
    # 查询已有排产计划的订单行
    order_nos = [row.SaleOrderLine.order_no for row in rows]
    line_nos = [row.SaleOrderLine.line_no for row in rows]
    scheduled_set = set()
    if order_nos and line_nos:
        schedule_result = await db.execute(
            select(ProductionSchedulePlan.order_no, ProductionSchedulePlan.line_no)
            .where(
                ProductionSchedulePlan.order_no.in_(order_nos),
                ProductionSchedulePlan.line_no.in_(line_nos),
                ProductionSchedulePlan.is_active == True
            )
        )
        for order_no, line_no in schedule_result.all():
            scheduled_set.add(f"{order_no}_{line_no}")
    
    items = []
    for row in rows:
        order_line = row.SaleOrderLine
        customer = row.customer
        risk_level = row.risk_level
        
        has_schedule = f"{order_line.order_no}_{order_line.line_no}" in scheduled_set
        if only_unscheduled and has_schedule:
            continue
            
        items.append(OrderForSchedulingOut(
            order_no=order_line.order_no,
            line_no=order_line.line_no,
            customer=customer,
            product_code=order_line.product_code,
            product_model=order_line.product_model,
            order_qty=float(order_line.order_qty or 0),
            promised_date=order_line.promised_date,
            risk_level=risk_level,
            status=order_line.status,
            upph=product_upph_map.get(order_line.product_code, 0) if order_line.product_code else 0,
            has_schedule=has_schedule,
        ))
    
    return ResponseModel(data=PageResult(total=total, page=page, page_size=page_size, items=items))


@router.get("/work-hours-config", response_model=ResponseModel[dict])
async def get_work_hours_config(
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    """获取每日工作时间配置"""
    config = await db.execute(select(NodeStandard).where(NodeStandard.node_code == "daily_work_hours"))
    config_item = config.scalar_one_or_none()
    return ResponseModel(data={
        "daily_work_hours": float(config_item.time_value) if config_item else 8
    })


@router.post("/auto-schedule", response_model=ResponseModel[AutoScheduleResponse])
async def auto_schedule(
    data: AutoScheduleRequest,
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "create")),
    db: AsyncSession = Depends(get_db),
):
    """一键排产"""
    # 1. 获取订单信息 (去重，只取最新的一条)
    order_result = await db.execute(
        select(SaleOrderLine, SaleOrder.risk_level)
        .outerjoin(SaleOrder, SaleOrderLine.sale_order_id == SaleOrder.id)
        .where(and_(
            SaleOrderLine.order_no == data.order_no,
            SaleOrderLine.line_no == data.line_no,
        ))
        .order_by(SaleOrderLine.id.desc())
        .limit(1)
    )
    row = order_result.first()
    if not row:
        raise HTTPException(status_code=404, detail="订单行不存在")
    
    order_line = row.SaleOrderLine
    risk_level = row.risk_level
    
    if not order_line.promised_date:
        raise HTTPException(status_code=400, detail="订单行没有交期")
    
    if not order_line.order_qty or order_line.order_qty <= 0:
        raise HTTPException(status_code=400, detail="订单行数量无效")
    
    # 2. 获取或使用指定的UPPH
    upph = data.upph
    if upph is None and order_line.product_code:
        upph_service = UpphCalculationService(db)
        upph, _ = await upph_service.calculate_total_upph(
            product_code=order_line.product_code,
            bom_code=getattr(order_line, "bom_code", None),  # 等同事补了字段之后直接用
        )
    
    if upph is None or upph <= 0:
        raise HTTPException(status_code=400, detail="缺少UPPH数据，请在订单或产品中配置，或手动指定")
    
    # 3. 获取每日工作时间
    daily_hours = data.daily_work_hours
    if daily_hours is None:
        config_result = await db.execute(select(NodeStandard).where(NodeStandard.node_code == "daily_work_hours"))
        config_item = config_result.scalar_one_or_none()
        daily_hours = float(config_item.time_value) if config_item else 8
    
    if daily_hours <= 0:
        raise HTTPException(status_code=400, detail="每日工作时间必须大于0")

    calculation_result = _calculate_schedule_result(
        quantity=float(order_line.order_qty),
        upph=float(upph),
        daily_hours=float(daily_hours),
        promised_date=order_line.promised_date,
    )
    priority = _resolve_priority_by_risk(risk_level)

    # 6. 检查是否已有排产计划，处理版本
    existing_plan_result = await db.execute(
        select(ProductionSchedulePlan)
        .where(
            ProductionSchedulePlan.order_no == data.order_no,
            ProductionSchedulePlan.line_no == data.line_no,
            ProductionSchedulePlan.is_active == True
        )
    )
    existing_plan = existing_plan_result.scalar_one_or_none()
    
    plan_version = 1
    previous_plan_id = None
    if existing_plan:
        plan_version = existing_plan.plan_version + 1
        previous_plan_id = existing_plan.id
        existing_plan.is_active = False
        db.add(existing_plan)
    
    # 7. 创建排产计划
    plan_date = data.plan_date or date.today()
    schedule_data = ProductionSchedulePlanCreate(
        department=data.department,
        plan_date=plan_date,
        order_no=order_line.order_no,
        line_no=order_line.line_no,
        product_code=order_line.product_code,
        model_code=order_line.product_model,
        quantity=float(order_line.order_qty),
        start_date=calculation_result["start_date"],
        end_date=calculation_result["end_date"],
        priority=priority,
        status="planned",
        upph=upph,
        daily_work_hours=daily_hours,
        owner=data.owner,
        remark=calculation_result["warning"] or None,
        
        # 快照数据
        plan_version=plan_version,
        is_active=True,
        source_promised_date=order_line.promised_date,
        source_order_qty=float(order_line.order_qty),
        source_product_code=order_line.product_code,
        source_product_model=order_line.product_model,
        source_upph=upph,
        previous_plan_id=previous_plan_id,
    )
    
    record = ProductionSchedulePlan(**schedule_data.model_dump(), created_by=current_user["username"])
    db.add(record)
    await db.flush()
    await log_audit(db, "production_schedule_plan", record.id, "create", operator=current_user["username"])
    await _log_schedule_operation(
        db,
        "create",
        current_user["username"],
        plan_id=record.id,
        plan_version=plan_version,
        order_no=record.order_no,
        line_no=record.line_no,
        previous_version_id=previous_plan_id,
        remark=calculation_result["warning"] or "自动排产创建",
    )
    await db.commit()
    await db.refresh(record)
    
    calculation_result = {
        "total_hours": calculation_result["total_hours"],
        "days_needed": calculation_result["days_needed"],
        "upph": upph,
        "daily_work_hours": daily_hours,
    }
    
    return ResponseModel(data=AutoScheduleResponse(
        success=True,
        message=schedule_data.remark or "排产成功",
        schedule_plan=ProductionSchedulePlanOut.model_validate(record),
        calculation_result=calculation_result,
    ))


@router.get("/missing-upph-products", response_model=ResponseModel[MissingUpphListOut])
async def list_missing_upph_products(
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    keyword: Optional[str] = Query(None),
    current_user: dict = Depends(PermissionChecker("production.schedule_plans", "read")),
    db: AsyncSession = Depends(get_db),
):
    """获取当月订单中缺少UPPH的产品列表"""
    today = date.today()
    target_year = year or today.year
    target_month = month or today.month

    first_day = date(target_year, target_month, 1)
    if target_month == 12:
        last_day = date(target_year + 1, 1, 1) - timedelta(days=1)
    else:
        last_day = date(target_year, target_month + 1, 1) - timedelta(days=1)

    month_conditions = [
        SaleOrderLine.promised_date >= first_day,
        SaleOrderLine.promised_date <= last_day,
    ]
    month_total = (
        await db.execute(select(func.count(SaleOrderLine.id)).where(*month_conditions))
    ).scalar() or 0

    stmt = select(SaleOrderLine).where(*month_conditions)
    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(
            or_(
                SaleOrderLine.order_no.ilike(like),
                SaleOrderLine.product_code.ilike(like),
                SaleOrderLine.product_model.ilike(like),
            )
        )

    result = await db.execute(stmt)
    rows = result.scalars().all()

    if not rows:
        empty_state = EmptyStateOut(
            code="no_orders_in_month" if month_total == 0 else "no_match_for_filter",
            message="本月没有订单数据，请先确认订单范围。"
            if month_total == 0
            else "当前筛选条件下没有匹配订单，请调整年份、月份或关键字后重试。",
        )
        return ResponseModel(data=MissingUpphListOut(items=[], empty_state=empty_state))

    product_map = {}
    upph_service = UpphCalculationService(db)
    upph_cache: dict[str, float] = {}

    for order_line in rows:
        product_code = order_line.product_code
        if not product_code:
            continue

        if product_code not in upph_cache:
            current_upph, _ = await upph_service.calculate_total_upph(
                product_code=product_code,
                bom_code=getattr(order_line, "bom_code", None),
            )
            upph_cache[product_code] = float(current_upph or 0)

        if upph_cache[product_code] > 0:
            continue

        if product_code not in product_map:
            product_map[product_code] = {
                "product_code": product_code,
                "product_model": order_line.product_model,
                "order_count": 0,
                "total_quantity": 0,
                "latest_promised_date": order_line.promised_date,
                "first_order_no": order_line.order_no,
            }
        entry = product_map[product_code]
        entry["order_count"] += 1
        entry["total_quantity"] += float(order_line.order_qty or 0)
        if order_line.promised_date > entry["latest_promised_date"]:
            entry["latest_promised_date"] = order_line.promised_date

    products = sorted(
        product_map.values(),
        key=lambda x: x["latest_promised_date"] or date.max,
    )

    empty_state = None
    if not products:
        empty_state = EmptyStateOut(
            code="all_have_upph",
            message="当前筛选范围内订单都已匹配到UPPH。"
            if keyword
            else "本月订单都已匹配到UPPH。",
        )

    return ResponseModel(data=MissingUpphListOut(items=products, empty_state=empty_state))
