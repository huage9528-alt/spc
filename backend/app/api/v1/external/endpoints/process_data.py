"""生产工序对外接口

为外部系统提供工序主数据 / 工序异常 / 工序进度查询。
字段集以真实模型列为准（Process / ProcessException / ProcessProgress）。
"""

from datetime import date, datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.models.basicdata.process import Process
from app.models.production.process_exception import ProcessException
from app.models.production.process_progress import ProcessProgress
from app.schemas.common import ResponseModel

from ..common import ExternalPage, PageParamsMixin
from ..deps import external_auth
from ..log_wrap import log_external_call
from ..registry import register_external

router = APIRouter(tags=["生产工序"])


def _f(v):
    """Numeric -> float（JSON 序列化安全）"""
    return float(v) if v is not None else None


# ═══════════════════════════════════════════
# 工序主数据
# ═══════════════════════════════════════════

class ProcessesListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（工序编码 / 工序名称 模糊匹配）")
    process_group: Optional[str] = Field(None, description="工序分组精确匹配")
    work_center: Optional[str] = Field(None, description="工作中心精确匹配")
    is_qc_point: Optional[int] = Field(None, description="是否质检点 0/1")


class ProcessOut(BaseModel):
    """工序主数据（对外精简字段集；scm_process 无 updated_at，不支持增量同步）"""
    id: int = Field(..., description="主键")
    process_code: Optional[str] = Field(None, description="工序编码")
    process_name: Optional[str] = Field(None, description="工序名称")
    process_group: Optional[str] = Field(None, description="工序分组")
    standard_hour: Optional[float] = Field(None, description="标准工时（小时）")
    work_center: Optional[str] = Field(None, description="工作中心")
    is_qc_point: Optional[int] = Field(None, description="是否质检点 0/1")
    description: Optional[str] = Field(None, description="描述")


@router.get("/processes/list", response_model=ResponseModel[ExternalPage[ProcessOut]],
            summary="工序列表", description="endpoint_code: processes.list")
@register_external(
    "processes.list", "工序列表", method="GET", path="/processes/list",
    description="工序主数据列表查询，支持关键字、工序分组、工作中心、质检点筛选",
    tags=["生产工序"],
)
@log_external_call("processes.list")
async def processes_list(
    request: Request,
    q: Annotated[ProcessesListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("processes.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(Process)
    count_query = select(func.count()).select_from(Process)

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(Process.process_code.ilike(like_expr), Process.process_name.ilike(like_expr))
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.process_group:
        query = query.where(Process.process_group == q.process_group)
        count_query = count_query.where(Process.process_group == q.process_group)

    if q.work_center:
        query = query.where(Process.work_center == q.work_center)
        count_query = count_query.where(Process.work_center == q.work_center)

    if q.is_qc_point is not None:
        query = query.where(Process.is_qc_point == q.is_qc_point)
        count_query = count_query.where(Process.is_qc_point == q.is_qc_point)

    total = (await db.execute(count_query)).scalar() or 0
    query = query.order_by(Process.id.asc()).offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(query)).scalars().all()

    items = [{
        "id": r.id,
        "process_code": r.process_code,
        "process_name": r.process_name,
        "process_group": r.process_group,
        "standard_hour": _f(r.standard_hour),
        "work_center": r.work_center,
        "is_qc_point": r.is_qc_point,
        "description": r.description,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ═══════════════════════════════════════════
# 工序异常
# ═══════════════════════════════════════════

class ProcessExceptionsListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（异常单号 / 订单号 / 型号 模糊匹配）")
    exception_type: Optional[str] = Field(None, description="异常类型精确匹配")
    severity: Optional[str] = Field(None, description="严重程度精确匹配")
    status: Optional[str] = Field(None, description="状态精确匹配，多选逗号分隔，如 open,processing")
    order_no: Optional[str] = Field(None, description="订单号精确匹配")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间的记录（ISO 8601）")


class ProcessExceptionOut(BaseModel):
    """工序异常（对外精简字段集）"""
    id: int = Field(..., description="主键")
    exception_no: Optional[str] = Field(None, description="异常单号")
    process_type: Optional[str] = Field(None, description="工序类型")
    order_no: Optional[str] = Field(None, description="订单号")
    model_code: Optional[str] = Field(None, description="产品型号")
    exception_type: Optional[str] = Field(None, description="异常类型")
    severity: Optional[str] = Field(None, description="严重程度")
    description: Optional[str] = Field(None, description="异常描述")
    responsible_dept: Optional[str] = Field(None, description="责任部门")
    responsible_person: Optional[str] = Field(None, description="责任人")
    status: Optional[str] = Field(None, description="状态")
    resolved_at: Optional[date] = Field(None, description="解决日期")
    created_at: Optional[datetime] = Field(None, description="创建时间")
    updated_at: Optional[datetime] = Field(None, description="更新时间（增量同步锚点）")


@router.get("/process-exceptions/list", response_model=ResponseModel[ExternalPage[ProcessExceptionOut]],
            summary="工序异常列表", description="endpoint_code: process_exceptions.list")
@register_external(
    "process_exceptions.list", "工序异常列表", method="GET", path="/process-exceptions/list",
    description="生产工序异常记录查询，支持关键字、异常类型、严重程度、状态、订单号、增量同步",
    tags=["生产工序"],
)
@log_external_call("process_exceptions.list")
async def process_exceptions_list(
    request: Request,
    q: Annotated[ProcessExceptionsListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("process_exceptions.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(ProcessException)
    count_query = select(func.count()).select_from(ProcessException)

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            ProcessException.exception_no.ilike(like_expr),
            ProcessException.order_no.ilike(like_expr),
            ProcessException.model_code.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.exception_type:
        query = query.where(ProcessException.exception_type == q.exception_type)
        count_query = count_query.where(ProcessException.exception_type == q.exception_type)

    if q.severity:
        query = query.where(ProcessException.severity == q.severity)
        count_query = count_query.where(ProcessException.severity == q.severity)

    if q.status:
        statuses = [s.strip() for s in q.status.split(",") if s.strip()]
        if len(statuses) == 1:
            query = query.where(ProcessException.status == statuses[0])
            count_query = count_query.where(ProcessException.status == statuses[0])
        elif statuses:
            query = query.where(ProcessException.status.in_(statuses))
            count_query = count_query.where(ProcessException.status.in_(statuses))

    if q.order_no:
        query = query.where(ProcessException.order_no == q.order_no)
        count_query = count_query.where(ProcessException.order_no == q.order_no)

    if q.updated_after:
        query = query.where(ProcessException.updated_at >= q.updated_after)
        count_query = count_query.where(ProcessException.updated_at >= q.updated_after)

    total = (await db.execute(count_query)).scalar() or 0
    query = query.order_by(ProcessException.id.desc()).offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(query)).scalars().all()

    items = [{
        "id": r.id,
        "exception_no": r.exception_no,
        "process_type": r.process_type,
        "order_no": r.order_no,
        "model_code": r.model_code,
        "exception_type": r.exception_type,
        "severity": r.severity,
        "description": r.description,
        "responsible_dept": r.responsible_dept,
        "responsible_person": r.responsible_person,
        "status": r.status,
        "resolved_at": r.resolved_at.isoformat() if r.resolved_at else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ═══════════════════════════════════════════
# 工序进度
# ═══════════════════════════════════════════

class ProcessProgressListQuery(PageParamsMixin):
    keyword: Optional[str] = Field(None, description="关键字（订单号 / 产品编码 / 型号 模糊匹配）")
    process_type: Optional[str] = Field(None, description="工序类型精确匹配（前道/贴片/精益/组装/包装）")
    status: Optional[str] = Field(None, description="状态精确匹配")
    order_no: Optional[str] = Field(None, description="订单号精确匹配")
    product_code: Optional[str] = Field(None, description="产品编码精确匹配")
    plan_date_start: Optional[date] = Field(None, description="计划日期范围起 YYYY-MM-DD")
    plan_date_end: Optional[date] = Field(None, description="计划日期范围止 YYYY-MM-DD")
    updated_after: Optional[datetime] = Field(None, description="增量同步，仅返回 updated_at >= 此时间的记录（ISO 8601）")


class ProcessProgressOut(BaseModel):
    """工序进度（对外通用字段集，覆盖各工序类型公共列）"""
    id: int = Field(..., description="主键")
    process_type: Optional[str] = Field(None, description="工序类型")
    seq_no: Optional[int] = Field(None, description="序号")
    plan_date: Optional[date] = Field(None, description="计划日期")
    order_no: Optional[str] = Field(None, description="订单号")
    product_code: Optional[str] = Field(None, description="产品编码")
    line_no: Optional[str] = Field(None, description="线体")
    model_code: Optional[str] = Field(None, description="产品型号")
    color_spec: Optional[str] = Field(None, description="颜色规格")
    qty: Optional[float] = Field(None, description="数量")
    planned_qty: Optional[float] = Field(None, description="计划数量")
    kit_qty: Optional[float] = Field(None, description="齐套数量")
    online_date: Optional[date] = Field(None, description="上线日期")
    daily_plan_qty: Optional[float] = Field(None, description="日计划数量")
    daily_complete_qty: Optional[float] = Field(None, description="日完成数量")
    completion_rate: Optional[str] = Field(None, description="完成率")
    work_hours: Optional[float] = Field(None, description="工时")
    status: Optional[str] = Field(None, description="状态")
    created_at: Optional[datetime] = Field(None, description="创建时间")
    updated_at: Optional[datetime] = Field(None, description="更新时间（增量同步锚点）")


@router.get("/process-progress/list", response_model=ResponseModel[ExternalPage[ProcessProgressOut]],
            summary="工序进度列表", description="endpoint_code: process_progress.list")
@register_external(
    "process_progress.list", "工序进度列表", method="GET", path="/process-progress/list",
    description="生产工序进度查询，支持关键字、工序类型、状态、订单号、产品编码、计划日期范围、增量同步",
    tags=["生产工序"],
)
@log_external_call("process_progress.list")
async def process_progress_list(
    request: Request,
    q: Annotated[ProcessProgressListQuery, Query()],
    db: AsyncSession = Depends(get_db),
    key: DataSupplyApiKey = Depends(external_auth("process_progress.list")),
):
    page = max(q.page or 1, 1)
    page_size = min(max(q.page_size if q.page_size is not None else 20, 1), 200)

    query = select(ProcessProgress)
    count_query = select(func.count()).select_from(ProcessProgress)

    if q.keyword:
        like_expr = f"%{q.keyword}%"
        kw_cond = or_(
            ProcessProgress.order_no.ilike(like_expr),
            ProcessProgress.product_code.ilike(like_expr),
            ProcessProgress.model_code.ilike(like_expr),
        )
        query = query.where(kw_cond)
        count_query = count_query.where(kw_cond)

    if q.process_type:
        query = query.where(ProcessProgress.process_type == q.process_type)
        count_query = count_query.where(ProcessProgress.process_type == q.process_type)

    if q.status:
        query = query.where(ProcessProgress.status == q.status)
        count_query = count_query.where(ProcessProgress.status == q.status)

    if q.order_no:
        query = query.where(ProcessProgress.order_no == q.order_no)
        count_query = count_query.where(ProcessProgress.order_no == q.order_no)

    if q.product_code:
        query = query.where(ProcessProgress.product_code == q.product_code)
        count_query = count_query.where(ProcessProgress.product_code == q.product_code)

    if q.plan_date_start:
        query = query.where(ProcessProgress.plan_date >= q.plan_date_start)
        count_query = count_query.where(ProcessProgress.plan_date >= q.plan_date_start)

    if q.plan_date_end:
        query = query.where(ProcessProgress.plan_date <= q.plan_date_end)
        count_query = count_query.where(ProcessProgress.plan_date <= q.plan_date_end)

    if q.updated_after:
        query = query.where(ProcessProgress.updated_at >= q.updated_after)
        count_query = count_query.where(ProcessProgress.updated_at >= q.updated_after)

    total = (await db.execute(count_query)).scalar() or 0
    query = query.order_by(ProcessProgress.id.desc()).offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(query)).scalars().all()

    items = [{
        "id": r.id,
        "process_type": r.process_type,
        "seq_no": r.seq_no,
        "plan_date": r.plan_date.isoformat() if r.plan_date else None,
        "order_no": r.order_no,
        "product_code": r.product_code,
        "line_no": r.line_no,
        "model_code": r.model_code,
        "color_spec": r.color_spec,
        "qty": _f(r.qty),
        "planned_qty": _f(r.planned_qty),
        "kit_qty": _f(r.kit_qty),
        "online_date": r.online_date.isoformat() if r.online_date else None,
        "daily_plan_qty": _f(r.daily_plan_qty),
        "daily_complete_qty": _f(r.daily_complete_qty),
        "completion_rate": r.completion_rate,
        "work_hours": _f(r.work_hours),
        "status": r.status,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    } for r in rows]

    return {"items": items, "total": total, "page": page, "page_size": page_size}
