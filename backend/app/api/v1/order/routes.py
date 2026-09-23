from fastapi import APIRouter, Depends, Query, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import select, func, asc, desc, case, or_
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional
from sqlalchemy.orm import selectinload
from datetime import date, datetime
import io
import logging
import traceback

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.core.audit import log_audit
from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.models.material.material_demand import MaterialDemand
from app.models.material.mrp_plan_order import MrpPlanOrder
from app.models.material.purchase_order import PurchaseOrder
from app.models.material.binding import OrderMaterialPoBinding
from app.models.production.labor_price_audit import ProductionLaborPriceAudit
from app.models.basicdata.customer import Customer
from app.models.basicdata.audit_log import AuditLog
from app.schemas.common import ResponseModel, PageResult
from app.models.exception.risk_issue import RiskIssue
from app.schemas.order.schemas import SaleOrderOut, SaleOrderUpdate, OrderCreate, OrderDetailOut, MaterialDemandOut, BindingOut, PODetail, RiskIssueOut, SaleOrderListOut, SaleOrderLineOut, OrderProductMaterialsOut, ShippingPlanHistoryItem
from app.services.common.export_service import GenericExportService, ExportColumn
from app.services.order.order_materials_service import get_order_product_materials

router = APIRouter()

logger = logging.getLogger(__name__)
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

SORTABLE_COLUMNS = {
    'department': SaleOrder.department,
    'delivery_completed_date': SaleOrder.delivery_completed_date,
    'customer_grade': SaleOrder.customer_grade,
    'customer_code': SaleOrder.customer_code,
    'order_no': SaleOrder.order_no,
    'order_qty': SaleOrder.order_qty,
    'order_amount': SaleOrder.order_amount,
    'completed_qty': SaleOrder.completed_qty,
    'order_date': SaleOrder.order_date,
    'promised_date': SaleOrder.promised_date,
    'shipping_plan': SaleOrder.shipping_plan,
    'customer_inspection_date': SaleOrder.customer_inspection_date,
    'planned_start_date': SaleOrder.planned_start_date,
    'bom_return_date': SaleOrder.bom_return_date,
    'material_ready_date': SaleOrder.material_ready_date,
    'front_process_date': SaleOrder.front_process_date,
    'first_article_date': SaleOrder.first_article_date,
    'assembly_start_date': SaleOrder.assembly_start_date,
    'assembly_complete_date': SaleOrder.assembly_complete_date,
    'risk_score': SaleOrder.risk_score,
}

MATERIAL_KEYS = [
    '电子料', 'SMT上线', '光源', '感应器/电源/控制板',
    '结构', '结构2', '支架', '电缆线', '塑料件', '手杆',
    '彩盒', '说明书', '灯珠', '光源板', '电源板', '包材',
]


def _customer_grade_expr():
    return func.coalesce(
        func.nullif(func.trim(Customer.customer_level), ''),
        func.nullif(func.trim(SaleOrder.customer_grade), ''),
    )


def _customer_grade_filter_expr(grades: list[str]):
    expr = _customer_grade_expr()
    normalized_grades = set()
    for grade in grades:
        text = _clean_text(grade)
        if not text:
            continue
        normalized_grades.add(text)
        if len(text) == 1 and text.upper() in {'A', 'B', 'C', 'D'}:
            upper = text.upper()
            normalized_grades.update({upper, f'{upper}级', f'{upper}类', f'{upper}类客户'})
        elif text[0].upper() in {'A', 'B', 'C', 'D'} and ('类' in text or '级' in text):
            upper = text[0].upper()
            normalized_grades.update({upper, f'{upper}级', f'{upper}类', f'{upper}类客户'})
    grade_values = list(normalized_grades)
    if len(grade_values) == 1:
        return expr == grade_values[0]
    return expr.in_(grade_values)


def _resolve_sort_expr(query, sort_by: str, customer_joined: bool = False):
    if sort_by == 'customer_grade':
        if not customer_joined:
            query = query.outerjoin(Customer, Customer.customer_code == SaleOrder.customer_code)
        return query, _customer_grade_expr()
    return query, SORTABLE_COLUMNS[sort_by]


def _clean_text(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _effective_customer_grade(order: SaleOrder, customer_master: Optional[Customer] = None):
    customer_level = _clean_text(customer_master.customer_level if customer_master else None)
    return customer_level or _clean_text(order.customer_grade)


def _kit_risk_level(kit_rate: float) -> str:
    if kit_rate >= 1.0:
        return "green"
    if kit_rate >= 0.8:
        return "yellow"
    return "red"


def _kit_status(risk_level: str) -> str:
    return {
        "green": "齐套",
        "yellow": "部分齐套",
        "red": "缺料严重",
    }.get(risk_level, risk_level)


async def _get_order_kit_map(db: AsyncSession, order_nos: list[str]) -> dict[str, dict]:
    if not order_nos:
        return {}

    result = await db.execute(
        select(
            PurchaseOrder.order_no,
            PurchaseOrder.material_code,
            func.max(
                case(
                    (
                        (PurchaseOrder.received_qty > 0)
                        & PurchaseOrder.po_qty.isnot(None)
                        & (PurchaseOrder.received_qty >= PurchaseOrder.po_qty),
                        1,
                    ),
                    else_=0,
                )
            ).label("received"),
        )
        .where(
            PurchaseOrder.order_no.in_(order_nos),
            PurchaseOrder.material_code.isnot(None),
        )
        .group_by(PurchaseOrder.order_no, PurchaseOrder.material_code)
    )

    grouped: dict[str, dict[str, int]] = {}
    for row in result.all():
        if not row.order_no:
            continue
        grouped.setdefault(row.order_no, {})[row.material_code] = int(row.received or 0)

    kit_map: dict[str, dict] = {}
    for order_no, materials in grouped.items():
        total = len(materials)
        received = sum(1 for value in materials.values() if value)
        kit_rate = round(received / total, 4) if total else 0
        risk_level = _kit_risk_level(kit_rate)
        kit_map[order_no] = {
            "kit_rate": kit_rate,
            "kit_status": _kit_status(risk_level),
            "kit_risk_level": risk_level,
            "kit_total_materials": total,
            "kit_received_materials": received,
        }
    return kit_map


async def _get_order_material_dates_map(db: AsyncSession, order_nos: list[str]) -> dict[str, dict[str, str]]:
    """从齐套分析（MRP计划订单+采购订单）计算各订单的物料分类到料日期。
    
    对每个物料分类，取该分类下所有物料的实际到料日期的最大值。
    """
    if not order_nos:
        return {}

    result = await db.execute(
        select(
            MrpPlanOrder.sale_order_no,
            MrpPlanOrder.material_type,
            func.max(PurchaseOrder.actual_arrival_date).label("max_arrival_date"),
        )
        .join(
            PurchaseOrder,
            (PurchaseOrder.order_no == MrpPlanOrder.sale_order_no)
            & (PurchaseOrder.material_code == MrpPlanOrder.material_code),
        )
        .where(
            MrpPlanOrder.sale_order_no.in_(order_nos),
            MrpPlanOrder.material_type.in_(MATERIAL_KEYS),
            PurchaseOrder.actual_arrival_date.isnot(None),
        )
        .group_by(MrpPlanOrder.sale_order_no, MrpPlanOrder.material_type)
    )

    material_dates_map: dict[str, dict[str, str]] = {}
    for row in result.all():
        ono = row.sale_order_no
        mtype = row.material_type
        max_date = row.max_arrival_date
        if ono and mtype and max_date:
            material_dates_map.setdefault(ono, {})[mtype] = max_date.isoformat()

    return material_dates_map


@router.get("", response_model=ResponseModel[PageResult[SaleOrderListOut]])
async def list_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    risk_level: Optional[str] = Query(None, description="风险等级，多选逗号分隔如 red,yellow"),
    keyword: Optional[str] = Query(None),
    owner: Optional[str] = Query(None),
    customer: Optional[str] = Query(None),
    customer_grade: Optional[str] = Query(None, description="客户等级，多选逗号分隔如 A,B"),
    data_source: Optional[str] = Query(None),
    department: Optional[str] = Query(None, description="销售部门，多选逗号分隔"),
    status: Optional[str] = Query(None, description="订单状态，多选逗号分隔"),
    erp_status: Optional[str] = Query(None, description="ERP订单状态(整型)，多选逗号分隔如 0,1,2,3"),
    inspection_result: Optional[str] = Query(None, description="客检结果，多选逗号分隔"),
    packaging_status: Optional[str] = Query(None, description="包装状态，多选逗号分隔"),
    procurement_status: Optional[str] = Query(None, description="采购状态，多选逗号分隔"),
    delivery_completed: Optional[str] = Query(None, description="发货完成状态: yes/no"),
    is_closed: Optional[str] = Query(None, description="是否关闭，多选逗号分隔如 1,0"),
    promised_date_start: Optional[str] = Query(None, description="合同交期开始日期 YYYY-MM-DD"),
    promised_date_end: Optional[str] = Query(None, description="合同交期结束日期 YYYY-MM-DD"),
    shipping_plan_start: Optional[str] = Query(None, description="出货计划开始日期 YYYY-MM-DD"),
    shipping_plan_end: Optional[str] = Query(None, description="出货计划结束日期 YYYY-MM-DD"),
    order_date_start: Optional[str] = Query(None, description="下单时间开始日期 YYYY-MM-DD"),
    order_date_end: Optional[str] = Query(None, description="下单时间结束日期 YYYY-MM-DD"),
    customer_inspection_date_start: Optional[str] = Query(None, description="客检日期开始 YYYY-MM-DD"),
    customer_inspection_date_end: Optional[str] = Query(None, description="客检日期结束 YYYY-MM-DD"),
    planned_start_date_start: Optional[str] = Query(None, description="计划开始日期开始 YYYY-MM-DD"),
    planned_start_date_end: Optional[str] = Query(None, description="计划开始日期结束 YYYY-MM-DD"),
    material_ready_date_start: Optional[str] = Query(None, description="物料就绪日期开始 YYYY-MM-DD"),
    material_ready_date_end: Optional[str] = Query(None, description="物料就绪日期结束 YYYY-MM-DD"),
    front_process_date_start: Optional[str] = Query(None, description="前制程日期开始 YYYY-MM-DD"),
    front_process_date_end: Optional[str] = Query(None, description="前制程日期结束 YYYY-MM-DD"),
    first_article_date_start: Optional[str] = Query(None, description="首件日期开始 YYYY-MM-DD"),
    first_article_date_end: Optional[str] = Query(None, description="首件日期结束 YYYY-MM-DD"),
    assembly_start_date_start: Optional[str] = Query(None, description="组装开始日期开始 YYYY-MM-DD"),
    assembly_start_date_end: Optional[str] = Query(None, description="组装开始日期结束 YYYY-MM-DD"),
    assembly_complete_date_start: Optional[str] = Query(None, description="组装完成日期开始 YYYY-MM-DD"),
    assembly_complete_date_end: Optional[str] = Query(None, description="组装完成日期结束 YYYY-MM-DD"),
    order_type: Optional[str] = Query(None, description="订单类型，多选逗号分隔：big（大单，HJ开头）, sample（样品单，HJY开头）"),
    year: Optional[int] = Query(None, description="年份，按下单时间筛选"),
    sort_by: Optional[str] = Query("promised_date", description="排序字段"),
    sort_order: Optional[str] = Query("asc", description="排序方向 asc/desc"),
    current_user: dict = Depends(PermissionChecker("orders.list", "read")),
    db: AsyncSession = Depends(get_db),
):
    try:
        query = select(SaleOrder).where(SaleOrder.is_deleted == 0)
        count_query = select(func.count(SaleOrder.id)).where(SaleOrder.is_deleted == 0)
        customer_grade_joined = False
    
        if risk_level:
            levels = [x.strip() for x in risk_level.split(',') if x.strip()]
            if len(levels) == 1:
                query = query.where(SaleOrder.risk_level == levels[0])
                count_query = count_query.where(SaleOrder.risk_level == levels[0])
            elif levels:
                query = query.where(SaleOrder.risk_level.in_(levels))
                count_query = count_query.where(SaleOrder.risk_level.in_(levels))
        if owner:
            query = query.where(SaleOrder.owner == owner)
            count_query = count_query.where(SaleOrder.owner == owner)
        if customer:
            like_expr = f"%{customer}%"
            query = query.where(SaleOrder.customer.ilike(like_expr))
            count_query = count_query.where(SaleOrder.customer.ilike(like_expr))
        if customer_grade:
            grades = [x.strip() for x in customer_grade.split(',') if x.strip()]
            if grades:
                grade_filter = _customer_grade_filter_expr(grades)
                query = query.outerjoin(Customer, Customer.customer_code == SaleOrder.customer_code).where(grade_filter)
                count_query = count_query.outerjoin(Customer, Customer.customer_code == SaleOrder.customer_code).where(grade_filter)
                customer_grade_joined = True
        if data_source:
            query = query.where(SaleOrder.data_source == data_source)
            count_query = count_query.where(SaleOrder.data_source == data_source)
        if department:
            departments = [x.strip() for x in department.split(',') if x.strip()]
            if len(departments) == 1:
                query = query.where(SaleOrder.department == departments[0])
                count_query = count_query.where(SaleOrder.department == departments[0])
            elif departments:
                query = query.where(SaleOrder.department.in_(departments))
                count_query = count_query.where(SaleOrder.department.in_(departments))
        if status:
            statuses = [x.strip() for x in status.split(',') if x.strip()]
            if len(statuses) == 1:
                query = query.where(SaleOrder.status == statuses[0])
                count_query = count_query.where(SaleOrder.status == statuses[0])
            elif statuses:
                query = query.where(SaleOrder.status.in_(statuses))
                count_query = count_query.where(SaleOrder.status.in_(statuses))
        if erp_status:
            erp_statuses = [int(x.strip()) for x in erp_status.split(',') if x.strip() != '']
            if len(erp_statuses) == 1:
                query = query.where(SaleOrder.erp_status == erp_statuses[0])
                count_query = count_query.where(SaleOrder.erp_status == erp_statuses[0])
            elif erp_statuses:
                query = query.where(SaleOrder.erp_status.in_(erp_statuses))
                count_query = count_query.where(SaleOrder.erp_status.in_(erp_statuses))
        if inspection_result:
            results = [x.strip() for x in inspection_result.split(',') if x.strip()]
            if len(results) == 1:
                query = query.where(SaleOrder.inspection_result == results[0])
                count_query = count_query.where(SaleOrder.inspection_result == results[0])
            elif results:
                query = query.where(SaleOrder.inspection_result.in_(results))
                count_query = count_query.where(SaleOrder.inspection_result.in_(results))
        if packaging_status:
            statuses = [x.strip() for x in packaging_status.split(',') if x.strip()]
            if len(statuses) == 1:
                query = query.where(SaleOrder.packaging_status == statuses[0])
                count_query = count_query.where(SaleOrder.packaging_status == statuses[0])
            elif statuses:
                query = query.where(SaleOrder.packaging_status.in_(statuses))
                count_query = count_query.where(SaleOrder.packaging_status.in_(statuses))
        if procurement_status:
            statuses = [x.strip() for x in procurement_status.split(',') if x.strip()]
            if len(statuses) == 1:
                query = query.where(SaleOrder.procurement_status == statuses[0])
                count_query = count_query.where(SaleOrder.procurement_status == statuses[0])
            elif statuses:
                query = query.where(SaleOrder.procurement_status.in_(statuses))
                count_query = count_query.where(SaleOrder.procurement_status.in_(statuses))
        if delivery_completed:
            if delivery_completed == 'yes':
                query = query.where(SaleOrder.delivery_completed_date.isnot(None))
                count_query = count_query.where(SaleOrder.delivery_completed_date.isnot(None))
            elif delivery_completed == 'no':
                query = query.where(SaleOrder.delivery_completed_date.is_(None))
                count_query = count_query.where(SaleOrder.delivery_completed_date.is_(None))
        if is_closed:
            closed_list = [s.strip() for s in is_closed.split(',') if s.strip()]
            closed_conditions = []
            for s in closed_list:
                if s in ('1', 'true', 'True'):
                    closed_conditions.append(SaleOrder.is_closed == 1)
                elif s in ('0', 'false', 'False'):
                    closed_conditions.append(SaleOrder.is_closed == 0)
            if closed_conditions:
                cond = or_(*closed_conditions)
                query = query.where(cond)
                count_query = count_query.where(cond)
        if promised_date_start:
            query = query.where(SaleOrder.promised_date >= datetime.strptime(promised_date_start, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.promised_date >= datetime.strptime(promised_date_start, '%Y-%m-%d').date())
        if promised_date_end:
            query = query.where(SaleOrder.promised_date <= datetime.strptime(promised_date_end, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.promised_date <= datetime.strptime(promised_date_end, '%Y-%m-%d').date())
        if shipping_plan_start:
            query = query.where(SaleOrder.shipping_plan >= datetime.strptime(shipping_plan_start, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.shipping_plan >= datetime.strptime(shipping_plan_start, '%Y-%m-%d').date())
        if shipping_plan_end:
            query = query.where(SaleOrder.shipping_plan <= datetime.strptime(shipping_plan_end, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.shipping_plan <= datetime.strptime(shipping_plan_end, '%Y-%m-%d').date())
        if order_date_start:
            query = query.where(SaleOrder.order_date >= datetime.strptime(order_date_start, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.order_date >= datetime.strptime(order_date_start, '%Y-%m-%d').date())
        if order_date_end:
            query = query.where(SaleOrder.order_date <= datetime.strptime(order_date_end, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.order_date <= datetime.strptime(order_date_end, '%Y-%m-%d').date())
        if year:
            query = query.where(func.extract('year', SaleOrder.order_date) == year)
            count_query = count_query.where(func.extract('year', SaleOrder.order_date) == year)
        if customer_inspection_date_start:
            query = query.where(SaleOrder.customer_inspection_date >= datetime.strptime(customer_inspection_date_start, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.customer_inspection_date >= datetime.strptime(customer_inspection_date_start, '%Y-%m-%d').date())
        if customer_inspection_date_end:
            query = query.where(SaleOrder.customer_inspection_date <= datetime.strptime(customer_inspection_date_end, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.customer_inspection_date <= datetime.strptime(customer_inspection_date_end, '%Y-%m-%d').date())
        if planned_start_date_start:
            query = query.where(SaleOrder.planned_start_date >= datetime.strptime(planned_start_date_start, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.planned_start_date >= datetime.strptime(planned_start_date_start, '%Y-%m-%d').date())
        if planned_start_date_end:
            query = query.where(SaleOrder.planned_start_date <= datetime.strptime(planned_start_date_end, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.planned_start_date <= datetime.strptime(planned_start_date_end, '%Y-%m-%d').date())
        if material_ready_date_start:
            query = query.where(SaleOrder.material_ready_date >= datetime.strptime(material_ready_date_start, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.material_ready_date >= datetime.strptime(material_ready_date_start, '%Y-%m-%d').date())
        if material_ready_date_end:
            query = query.where(SaleOrder.material_ready_date <= datetime.strptime(material_ready_date_end, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.material_ready_date <= datetime.strptime(material_ready_date_end, '%Y-%m-%d').date())
        if front_process_date_start:
            query = query.where(SaleOrder.front_process_date >= datetime.strptime(front_process_date_start, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.front_process_date >= datetime.strptime(front_process_date_start, '%Y-%m-%d').date())
        if front_process_date_end:
            query = query.where(SaleOrder.front_process_date <= datetime.strptime(front_process_date_end, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.front_process_date <= datetime.strptime(front_process_date_end, '%Y-%m-%d').date())
        if first_article_date_start:
            query = query.where(SaleOrder.first_article_date >= datetime.strptime(first_article_date_start, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.first_article_date >= datetime.strptime(first_article_date_start, '%Y-%m-%d').date())
        if first_article_date_end:
            query = query.where(SaleOrder.first_article_date <= datetime.strptime(first_article_date_end, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.first_article_date <= datetime.strptime(first_article_date_end, '%Y-%m-%d').date())
        if assembly_start_date_start:
            query = query.where(SaleOrder.assembly_start_date >= datetime.strptime(assembly_start_date_start, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.assembly_start_date >= datetime.strptime(assembly_start_date_start, '%Y-%m-%d').date())
        if assembly_start_date_end:
            query = query.where(SaleOrder.assembly_start_date <= datetime.strptime(assembly_start_date_end, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.assembly_start_date <= datetime.strptime(assembly_start_date_end, '%Y-%m-%d').date())
        if assembly_complete_date_start:
            query = query.where(SaleOrder.assembly_complete_date >= datetime.strptime(assembly_complete_date_start, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.assembly_complete_date >= datetime.strptime(assembly_complete_date_start, '%Y-%m-%d').date())
        if assembly_complete_date_end:
            query = query.where(SaleOrder.assembly_complete_date <= datetime.strptime(assembly_complete_date_end, '%Y-%m-%d').date())
            count_query = count_query.where(SaleOrder.assembly_complete_date <= datetime.strptime(assembly_complete_date_end, '%Y-%m-%d').date())
        if order_type:
            types = [x.strip() for x in order_type.split(',') if x.strip()]
            if types:
                type_filters = []
                for t in types:
                    if t == 'big':
                        # 大单：HJ开头，排除HJY开头
                        type_filters.append(SaleOrder.order_no.ilike('HJ%') & SaleOrder.order_no.notilike('HJY%'))
                    elif t == 'sample':
                        # 样品单：HJY开头
                        type_filters.append(SaleOrder.order_no.ilike('HJY%'))
                if type_filters:
                    if len(type_filters) == 1:
                        query = query.where(type_filters[0])
                        count_query = count_query.where(type_filters[0])
                    else:
                        query = query.where(or_(*type_filters))
                        count_query = count_query.where(or_(*type_filters))
        if keyword:
            like_expr = f"%{keyword}%"
            query = query.where(
                (SaleOrder.order_no.ilike(like_expr)) | (SaleOrder.customer.ilike(like_expr)) | (SaleOrder.product_name.ilike(like_expr))
            )
            count_query = count_query.where(
                (SaleOrder.order_no.ilike(like_expr)) | (SaleOrder.customer.ilike(like_expr)) | (SaleOrder.product_name.ilike(like_expr))
            )
    
        total_result = await db.execute(count_query)
        total = total_result.scalar()
    
        # 基于筛选条件的统计（用于表格底部合计）
        # 使用与主查询相同的筛选条件
        stats_query = select(
            func.count(SaleOrder.id).label('total'),
            func.sum(case((SaleOrder.risk_level == 'red', 1), else_=0)).label('red_count'),
            func.sum(case((SaleOrder.risk_level == 'yellow', 1), else_=0)).label('yellow_count'),
            func.sum(case((SaleOrder.risk_level == 'blue', 1), else_=0)).label('blue_count'),
            func.sum(case((SaleOrder.risk_level == 'green', 1), else_=0)).label('green_count'),
            func.sum(SaleOrder.order_qty).label('order_qty_total'),
            func.sum(SaleOrder.order_amount).label('order_amount_total'),
        ).where(SaleOrder.is_deleted == 0)
        # 应用与主查询相同的筛选条件
        if risk_level:
            levels = [x.strip() for x in risk_level.split(',') if x.strip()]
            if len(levels) == 1:
                stats_query = stats_query.where(SaleOrder.risk_level == levels[0])
            elif levels:
                stats_query = stats_query.where(SaleOrder.risk_level.in_(levels))
        if owner:
            stats_query = stats_query.where(SaleOrder.owner == owner)
        if customer:
            like_expr = f"%{customer}%"
            stats_query = stats_query.where(SaleOrder.customer.ilike(like_expr))
        if customer_grade:
            grades = [x.strip() for x in customer_grade.split(',') if x.strip()]
            if grades:
                stats_query = stats_query.outerjoin(Customer, Customer.customer_code == SaleOrder.customer_code).where(
                    _customer_grade_filter_expr(grades)
                )
        if data_source:
            stats_query = stats_query.where(SaleOrder.data_source == data_source)
        if department:
            departments = [x.strip() for x in department.split(',') if x.strip()]
            if len(departments) == 1:
                stats_query = stats_query.where(SaleOrder.department == departments[0])
            elif departments:
                stats_query = stats_query.where(SaleOrder.department.in_(departments))
        if status:
            statuses = [x.strip() for x in status.split(',') if x.strip()]
            if len(statuses) == 1:
                stats_query = stats_query.where(SaleOrder.status == statuses[0])
            elif statuses:
                stats_query = stats_query.where(SaleOrder.status.in_(statuses))
        if erp_status:
            erp_statuses = [int(x.strip()) for x in erp_status.split(',') if x.strip() != '']
            if len(erp_statuses) == 1:
                stats_query = stats_query.where(SaleOrder.erp_status == erp_statuses[0])
            elif erp_statuses:
                stats_query = stats_query.where(SaleOrder.erp_status.in_(erp_statuses))
        if inspection_result:
            results = [x.strip() for x in inspection_result.split(',') if x.strip()]
            if len(results) == 1:
                stats_query = stats_query.where(SaleOrder.inspection_result == results[0])
            elif results:
                stats_query = stats_query.where(SaleOrder.inspection_result.in_(results))
        if packaging_status:
            statuses = [x.strip() for x in packaging_status.split(',') if x.strip()]
            if len(statuses) == 1:
                stats_query = stats_query.where(SaleOrder.packaging_status == statuses[0])
            elif statuses:
                stats_query = stats_query.where(SaleOrder.packaging_status.in_(statuses))
        if procurement_status:
            statuses = [x.strip() for x in procurement_status.split(',') if x.strip()]
            if len(statuses) == 1:
                stats_query = stats_query.where(SaleOrder.procurement_status == statuses[0])
            elif statuses:
                stats_query = stats_query.where(SaleOrder.procurement_status.in_(statuses))
        if delivery_completed:
            if delivery_completed == 'yes':
                stats_query = stats_query.where(SaleOrder.delivery_completed_date.isnot(None))
            elif delivery_completed == 'no':
                stats_query = stats_query.where(SaleOrder.delivery_completed_date.is_(None))
        if is_closed:
            closed_list = [s.strip() for s in is_closed.split(',') if s.strip()]
            closed_conditions = []
            for s in closed_list:
                if s in ('1', 'true', 'True'):
                    closed_conditions.append(SaleOrder.is_closed == 1)
                elif s in ('0', 'false', 'False'):
                    closed_conditions.append(SaleOrder.is_closed == 0)
            if closed_conditions:
                stats_query = stats_query.where(or_(*closed_conditions))
        if promised_date_start:
            stats_query = stats_query.where(SaleOrder.promised_date >= datetime.strptime(promised_date_start, '%Y-%m-%d').date())
        if promised_date_end:
            stats_query = stats_query.where(SaleOrder.promised_date <= datetime.strptime(promised_date_end, '%Y-%m-%d').date())
        if shipping_plan_start:
            stats_query = stats_query.where(SaleOrder.shipping_plan >= datetime.strptime(shipping_plan_start, '%Y-%m-%d').date())
        if shipping_plan_end:
            stats_query = stats_query.where(SaleOrder.shipping_plan <= datetime.strptime(shipping_plan_end, '%Y-%m-%d').date())
        if order_date_start:
            stats_query = stats_query.where(SaleOrder.order_date >= datetime.strptime(order_date_start, '%Y-%m-%d').date())
        if order_date_end:
            stats_query = stats_query.where(SaleOrder.order_date <= datetime.strptime(order_date_end, '%Y-%m-%d').date())
        if year:
            stats_query = stats_query.where(func.extract('year', SaleOrder.order_date) == year)
        if customer_inspection_date_start:
            stats_query = stats_query.where(SaleOrder.customer_inspection_date >= datetime.strptime(customer_inspection_date_start, '%Y-%m-%d').date())
        if customer_inspection_date_end:
            stats_query = stats_query.where(SaleOrder.customer_inspection_date <= datetime.strptime(customer_inspection_date_end, '%Y-%m-%d').date())
        if planned_start_date_start:
            stats_query = stats_query.where(SaleOrder.planned_start_date >= datetime.strptime(planned_start_date_start, '%Y-%m-%d').date())
        if planned_start_date_end:
            stats_query = stats_query.where(SaleOrder.planned_start_date <= datetime.strptime(planned_start_date_end, '%Y-%m-%d').date())
        if material_ready_date_start:
            stats_query = stats_query.where(SaleOrder.material_ready_date >= datetime.strptime(material_ready_date_start, '%Y-%m-%d').date())
        if material_ready_date_end:
            stats_query = stats_query.where(SaleOrder.material_ready_date <= datetime.strptime(material_ready_date_end, '%Y-%m-%d').date())
        if front_process_date_start:
            stats_query = stats_query.where(SaleOrder.front_process_date >= datetime.strptime(front_process_date_start, '%Y-%m-%d').date())
        if front_process_date_end:
            stats_query = stats_query.where(SaleOrder.front_process_date <= datetime.strptime(front_process_date_end, '%Y-%m-%d').date())
        if first_article_date_start:
            stats_query = stats_query.where(SaleOrder.first_article_date >= datetime.strptime(first_article_date_start, '%Y-%m-%d').date())
        if first_article_date_end:
            stats_query = stats_query.where(SaleOrder.first_article_date <= datetime.strptime(first_article_date_end, '%Y-%m-%d').date())
        if assembly_start_date_start:
            stats_query = stats_query.where(SaleOrder.assembly_start_date >= datetime.strptime(assembly_start_date_start, '%Y-%m-%d').date())
        if assembly_start_date_end:
            stats_query = stats_query.where(SaleOrder.assembly_start_date <= datetime.strptime(assembly_start_date_end, '%Y-%m-%d').date())
        if assembly_complete_date_start:
            stats_query = stats_query.where(SaleOrder.assembly_complete_date >= datetime.strptime(assembly_complete_date_start, '%Y-%m-%d').date())
        if assembly_complete_date_end:
            stats_query = stats_query.where(SaleOrder.assembly_complete_date <= datetime.strptime(assembly_complete_date_end, '%Y-%m-%d').date())
        if order_type:
            types = [x.strip() for x in order_type.split(',') if x.strip()]
            if types:
                type_filters = []
                for t in types:
                    if t == 'big':
                        type_filters.append(SaleOrder.order_no.ilike('HJ%') & SaleOrder.order_no.notilike('HJY%'))
                    elif t == 'sample':
                        type_filters.append(SaleOrder.order_no.ilike('HJY%'))
                if type_filters:
                    if len(type_filters) == 1:
                        stats_query = stats_query.where(type_filters[0])
                    else:
                        stats_query = stats_query.where(or_(*type_filters))
        if keyword:
            like_expr = f"%{keyword}%"
            stats_query = stats_query.where(
                (SaleOrder.order_no.ilike(like_expr)) | (SaleOrder.customer.ilike(like_expr)) | (SaleOrder.product_name.ilike(like_expr))
            )
    
        stats_result = await db.execute(stats_query)
        stats = stats_result.first()
    
        # 欠料统计
        shortage_stats_result = await db.execute(
            select(func.count(MaterialDemand.id.distinct()).label('shortage_count'))
            .where(MaterialDemand.shortage_flag == True)
        )
        shortage_stats = shortage_stats_result.first()
    
        # 构建排序子句
        order_clauses = []
        if sort_by and sort_by in SORTABLE_COLUMNS:
            query, col = _resolve_sort_expr(query, sort_by, customer_joined=customer_grade_joined)
            if sort_order == 'desc':
                order_clauses.append(col.desc().nullslast())
            else:
                order_clauses.append(col.asc().nullslast())
        # 默认排序
        if not order_clauses:
            order_clauses = [SaleOrder.promised_date.asc().nullslast(), SaleOrder.id.desc()]

        logger.info("list_orders sorting: sort_by=%s, sort_order=%s", sort_by, sort_order)
    
        query = query.options(selectinload(SaleOrder.lines)).order_by(*order_clauses).offset((page - 1) * page_size).limit(page_size)
        result = await db.execute(query)
        orders = result.scalars().all()

        # 出货计划变更次数（来源 audit_log，供总控台历史图标徽标）
        order_ids = [order.id for order in orders]
        change_count_map: dict[int, int] = {}
        if order_ids:
            change_result = await db.execute(
                select(AuditLog.record_id, func.count().label("cnt"))
                .where(
                    AuditLog.table_name == "sale_order",
                    AuditLog.field_name == "shipping_plan",
                    AuditLog.record_id.in_(order_ids),
                )
                .group_by(AuditLog.record_id)
            )
            change_count_map = {row.record_id: row.cnt for row in change_result.all()}
    
        order_nos = [order.order_no for order in orders]
        customer_codes = {order.customer_code for order in orders if order.customer_code}
        customer_map: dict[str, Customer] = {}
        if customer_codes:
            customer_result = await db.execute(
                select(Customer).where(Customer.customer_code.in_(customer_codes))
            )
            customer_map = {customer.customer_code: customer for customer in customer_result.scalars().all()}
    
        shortage_map: dict[str, int] = {}
        kit_map: dict[str, dict] = {}
        if order_nos:
            shortage_result = await db.execute(
                select(
                    MaterialDemand.order_no,
                    func.count(MaterialDemand.id).label("cnt"),
                )
                .where(
                    MaterialDemand.order_no.in_(order_nos),
                    MaterialDemand.shortage_flag == True,
                )
                .group_by(MaterialDemand.order_no)
            )
            shortage_map = {row.order_no: row.cnt for row in shortage_result.all()}
            kit_map = await _get_order_kit_map(db, order_nos)
            material_dates_map = await _get_order_material_dates_map(db, order_nos)
    
        items = []
        for order in orders:
            promised_dates = [line.promised_date for line in order.lines if line.promised_date]
            planned_dates = [line.planned_start_date for line in order.lines if line.planned_start_date]
            order_dict = SaleOrderOut.model_validate(order).model_dump()
            customer_master = customer_map.get(order.customer_code or "")
            computed_dates = material_dates_map.get(order.order_no, {})
            raw_manual_dates = order.material_dates
            if not isinstance(raw_manual_dates, dict):
                if raw_manual_dates is not None:
                    logger.warning(
                        "sale_order.material_dates expected dict, got %s for order_no=%s; ignoring",
                        type(raw_manual_dates).__name__, order.order_no,
                    )
                manual_dates = {}
            else:
                manual_dates = raw_manual_dates
            merged_material_dates = {**computed_dates, **manual_dates} if computed_dates or manual_dates else None
            order_dict.update(
                customer=order.customer or (customer_master.customer_short or customer_master.customer_name if customer_master else None),
                customer_grade=_effective_customer_grade(order, customer_master),
                product_count=len({line.product_code for line in order.lines if line.product_code}),
                line_count=len(order.lines),
                shortage_count=shortage_map.get(order.order_no, 0),
                **kit_map.get(order.order_no, {}),
                promised_date=order.promised_date or (min(promised_dates) if promised_dates else None),
                planned_start_date=order.planned_start_date or (min(planned_dates) if planned_dates else None),
                material_dates=merged_material_dates,
                shipping_plan_change_count=change_count_map.get(order.id, 0),
            )
            items.append(SaleOrderListOut(**order_dict))
    
        page_result = PageResult(total=total, page=page, page_size=page_size, items=items)
        # 将基于筛选条件的统计添加到返回数据中
        page_result.stats = {
            'total': stats.total or 0,
            'red_count': stats.red_count or 0,
            'yellow_count': stats.yellow_count or 0,
            'blue_count': stats.blue_count or 0,
            'green_count': stats.green_count or 0,
            'shortage_count': shortage_stats.shortage_count or 0,
            'order_qty_total': stats.order_qty_total or 0,
            'order_amount_total': stats.order_amount_total or 0,
        }

        return ResponseModel(data=page_result)
    except Exception as e:
        logger.exception("list_orders failed: %s", e)
        return ResponseModel(
            code=500,
            message=f"服务器内部错误: {type(e).__name__}: {e}",
            data=None,
        )


ORDER_EXPORT_COLUMNS = [
    ExportColumn('department', '销售部门', 12),
    ExportColumn('delivery_completed_date', '发货完成', 12),
    ExportColumn('customer_grade', '客户等级', 10),
    ExportColumn('customer_code', '客户', 20),
    ExportColumn('order_no', '订单号', 16),
    ExportColumn('risk_level', '风险等级', 10),
    ExportColumn('order_qty', '数量', 10),
    ExportColumn('completed_qty', '完成数量', 10),
    ExportColumn('order_date', '下单时间', 12),
    ExportColumn('promised_date', '合同交期', 12),
    ExportColumn('shipping_plan', '出货计划', 12),
    ExportColumn('customer_inspection_date', '客户验货时间', 14),
    ExportColumn('planned_start_date', '上线时间', 12),
    ExportColumn('inspection_result', '客检结果', 10),
    ExportColumn('packaging_status', '包装完成状况', 14),
    ExportColumn('bom_return_date', 'BOM 回收', 12),
    ExportColumn('material_ready_date', '料齐套时间', 12),
    ExportColumn('shipping_status_desc', '发货状态即时说明', 18),
    ExportColumn('procurement_status', '采购物料齐套', 14),
    ExportColumn('front_process_date', '前道', 12),
    ExportColumn('first_article_date', '首件检验日期', 14),
    ExportColumn('assembly_start_date', '组装上线日期', 14),
    ExportColumn('assembly_complete_date', '组装完成日期', 14),
    ExportColumn('remark', '备注', 20),
]


# ── 订单导出 ──
@router.get("/export")
async def export_orders(
    format: str = Query("xlsx", pattern="^(xlsx|csv)$"),
    columns: Optional[str] = Query(None, description="要导出的列名，逗号分隔。如不传则导出所有列"),
    risk_level: Optional[str] = Query(None, description="风险等级，多选逗号分隔如 red,yellow"),
    keyword: Optional[str] = Query(None),
    owner: Optional[str] = Query(None),
    customer: Optional[str] = Query(None),
    customer_grade: Optional[str] = Query(None, description="客户等级，多选逗号分隔如 A,B"),
    data_source: Optional[str] = Query(None),
    department: Optional[str] = Query(None, description="销售部门，多选逗号分隔"),
    status: Optional[str] = Query(None, description="订单状态，多选逗号分隔"),
    erp_status: Optional[str] = Query(None, description="ERP订单状态(整型)，多选逗号分隔如 0,1,2,3"),
    inspection_result: Optional[str] = Query(None, description="客检结果，多选逗号分隔"),
    packaging_status: Optional[str] = Query(None, description="包装状态，多选逗号分隔"),
    procurement_status: Optional[str] = Query(None, description="采购状态，多选逗号分隔"),
    delivery_completed: Optional[str] = Query(None, description="发货完成状态：yes/no"),
    is_closed: Optional[str] = Query(None, description="是否关闭，多选逗号分隔如 1,0"),
    promised_date_start: Optional[str] = Query(None, description="合同交期开始日期 YYYY-MM-DD"),
    promised_date_end: Optional[str] = Query(None, description="合同交期结束日期 YYYY-MM-DD"),
    shipping_plan_start: Optional[str] = Query(None, description="出货计划开始日期 YYYY-MM-DD"),
    shipping_plan_end: Optional[str] = Query(None, description="出货计划结束日期 YYYY-MM-DD"),
    order_date_start: Optional[str] = Query(None, description="下单时间开始日期 YYYY-MM-DD"),
    order_date_end: Optional[str] = Query(None, description="下单时间结束日期 YYYY-MM-DD"),
    customer_inspection_date_start: Optional[str] = Query(None, description="客检日期开始 YYYY-MM-DD"),
    customer_inspection_date_end: Optional[str] = Query(None, description="客检日期结束 YYYY-MM-DD"),
    planned_start_date_start: Optional[str] = Query(None, description="计划开始日期开始 YYYY-MM-DD"),
    planned_start_date_end: Optional[str] = Query(None, description="计划开始日期结束 YYYY-MM-DD"),
    material_ready_date_start: Optional[str] = Query(None, description="物料就绪日期开始 YYYY-MM-DD"),
    material_ready_date_end: Optional[str] = Query(None, description="物料就绪日期结束 YYYY-MM-DD"),
    front_process_date_start: Optional[str] = Query(None, description="前制程日期开始 YYYY-MM-DD"),
    front_process_date_end: Optional[str] = Query(None, description="前制程日期结束 YYYY-MM-DD"),
    first_article_date_start: Optional[str] = Query(None, description="首件日期开始 YYYY-MM-DD"),
    first_article_date_end: Optional[str] = Query(None, description="首件日期结束 YYYY-MM-DD"),
    assembly_start_date_start: Optional[str] = Query(None, description="组装开始日期开始 YYYY-MM-DD"),
    assembly_start_date_end: Optional[str] = Query(None, description="组装开始日期结束 YYYY-MM-DD"),
    assembly_complete_date_start: Optional[str] = Query(None, description="组装完成日期开始 YYYY-MM-DD"),
    assembly_complete_date_end: Optional[str] = Query(None, description="组装完成日期结束 YYYY-MM-DD"),
    order_type: Optional[str] = Query(None, description="订单类型，多选逗号分隔：big（大单，HJ开头）, sample（样品单，HJY开头）"),
    year: Optional[int] = Query(None, description="年份，按下单时间筛选"),
    sort_by: Optional[str] = Query("promised_date", description="排序字段"),
    sort_order: Optional[str] = Query("asc", description="排序方向 asc/desc"),
    current_user: dict = Depends(PermissionChecker("orders.list", "read")),
    db: AsyncSession = Depends(get_db),
):
    """导出订单列表（支持筛选 + 排序 + 列选择，不分页）"""
    query = select(SaleOrder)
    customer_grade_joined = False

    if risk_level:
        levels = [x.strip() for x in risk_level.split(',') if x.strip()]
        if len(levels) == 1:
            query = query.where(SaleOrder.risk_level == levels[0])
        elif levels:
            query = query.where(SaleOrder.risk_level.in_(levels))
    if owner:
        query = query.where(SaleOrder.owner == owner)
    if customer:
        like_expr = f"%{customer}%"
        query = query.where(SaleOrder.customer.ilike(like_expr))
    if customer_grade:
        grades = [x.strip() for x in customer_grade.split(',') if x.strip()]
        if grades:
            query = query.outerjoin(Customer, Customer.customer_code == SaleOrder.customer_code).where(
                _customer_grade_filter_expr(grades)
            )
            customer_grade_joined = True
    if data_source:
        query = query.where(SaleOrder.data_source == data_source)
    if department:
        departments = [x.strip() for x in department.split(',') if x.strip()]
        if len(departments) == 1:
            query = query.where(SaleOrder.department == departments[0])
        elif departments:
            query = query.where(SaleOrder.department.in_(departments))
    if status:
        statuses = [x.strip() for x in status.split(',') if x.strip()]
        if len(statuses) == 1:
            query = query.where(SaleOrder.status == statuses[0])
        elif statuses:
            query = query.where(SaleOrder.status.in_(statuses))
    if erp_status:
        erp_statuses = [int(x.strip()) for x in erp_status.split(',') if x.strip() != '']
        if len(erp_statuses) == 1:
            query = query.where(SaleOrder.erp_status == erp_statuses[0])
        elif erp_statuses:
            query = query.where(SaleOrder.erp_status.in_(erp_statuses))
    if inspection_result:
        results = [x.strip() for x in inspection_result.split(',') if x.strip()]
        if len(results) == 1:
            query = query.where(SaleOrder.inspection_result == results[0])
        elif results:
            query = query.where(SaleOrder.inspection_result.in_(results))
    if packaging_status:
        statuses = [x.strip() for x in packaging_status.split(',') if x.strip()]
        if len(statuses) == 1:
            query = query.where(SaleOrder.packaging_status == statuses[0])
        elif statuses:
            query = query.where(SaleOrder.packaging_status.in_(statuses))
    if procurement_status:
        statuses = [x.strip() for x in procurement_status.split(',') if x.strip()]
        if len(statuses) == 1:
            query = query.where(SaleOrder.procurement_status == statuses[0])
        elif statuses:
            query = query.where(SaleOrder.procurement_status.in_(statuses))
    if delivery_completed:
        if delivery_completed == 'yes':
            query = query.where(SaleOrder.delivery_completed_date.isnot(None))
        elif delivery_completed == 'no':
            query = query.where(SaleOrder.delivery_completed_date.is_(None))
    if is_closed:
        closed_list = [s.strip() for s in is_closed.split(',') if s.strip()]
        closed_conditions = []
        for s in closed_list:
            if s in ('1', 'true', 'True'):
                closed_conditions.append(SaleOrder.is_closed == 1)
            elif s in ('0', 'false', 'False'):
                closed_conditions.append(SaleOrder.is_closed == 0)
        if closed_conditions:
            query = query.where(or_(*closed_conditions))
    if promised_date_start:
        query = query.where(SaleOrder.promised_date >= datetime.strptime(promised_date_start, '%Y-%m-%d').date())
    if promised_date_end:
        query = query.where(SaleOrder.promised_date <= datetime.strptime(promised_date_end, '%Y-%m-%d').date())
    if shipping_plan_start:
        query = query.where(SaleOrder.shipping_plan >= datetime.strptime(shipping_plan_start, '%Y-%m-%d').date())
    if shipping_plan_end:
        query = query.where(SaleOrder.shipping_plan <= datetime.strptime(shipping_plan_end, '%Y-%m-%d').date())
    if order_date_start:
        query = query.where(SaleOrder.order_date >= datetime.strptime(order_date_start, '%Y-%m-%d').date())
    if order_date_end:
        query = query.where(SaleOrder.order_date <= datetime.strptime(order_date_end, '%Y-%m-%d').date())
    if year:
        query = query.where(func.extract('year', SaleOrder.order_date) == year)
    if customer_inspection_date_start:
        query = query.where(SaleOrder.customer_inspection_date >= datetime.strptime(customer_inspection_date_start, '%Y-%m-%d').date())
    if customer_inspection_date_end:
        query = query.where(SaleOrder.customer_inspection_date <= datetime.strptime(customer_inspection_date_end, '%Y-%m-%d').date())
    if planned_start_date_start:
        query = query.where(SaleOrder.planned_start_date >= datetime.strptime(planned_start_date_start, '%Y-%m-%d').date())
    if planned_start_date_end:
        query = query.where(SaleOrder.planned_start_date <= datetime.strptime(planned_start_date_end, '%Y-%m-%d').date())
    if material_ready_date_start:
        query = query.where(SaleOrder.material_ready_date >= datetime.strptime(material_ready_date_start, '%Y-%m-%d').date())
    if material_ready_date_end:
        query = query.where(SaleOrder.material_ready_date <= datetime.strptime(material_ready_date_end, '%Y-%m-%d').date())
    if front_process_date_start:
        query = query.where(SaleOrder.front_process_date >= datetime.strptime(front_process_date_start, '%Y-%m-%d').date())
    if front_process_date_end:
        query = query.where(SaleOrder.front_process_date <= datetime.strptime(front_process_date_end, '%Y-%m-%d').date())
    if first_article_date_start:
        query = query.where(SaleOrder.first_article_date >= datetime.strptime(first_article_date_start, '%Y-%m-%d').date())
    if first_article_date_end:
        query = query.where(SaleOrder.first_article_date <= datetime.strptime(first_article_date_end, '%Y-%m-%d').date())
    if assembly_start_date_start:
        query = query.where(SaleOrder.assembly_start_date >= datetime.strptime(assembly_start_date_start, '%Y-%m-%d').date())
    if assembly_start_date_end:
        query = query.where(SaleOrder.assembly_start_date <= datetime.strptime(assembly_start_date_end, '%Y-%m-%d').date())
    if assembly_complete_date_start:
        query = query.where(SaleOrder.assembly_complete_date >= datetime.strptime(assembly_complete_date_start, '%Y-%m-%d').date())
    if assembly_complete_date_end:
        query = query.where(SaleOrder.assembly_complete_date <= datetime.strptime(assembly_complete_date_end, '%Y-%m-%d').date())
    if order_type:
        types = [x.strip() for x in order_type.split(',') if x.strip()]
        if types:
            type_filters = []
            for t in types:
                if t == 'big':
                    type_filters.append(SaleOrder.order_no.ilike('HJ%') & SaleOrder.order_no.notilike('HJY%'))
                elif t == 'sample':
                    type_filters.append(SaleOrder.order_no.ilike('HJY%'))
            if type_filters:
                if len(type_filters) == 1:
                    query = query.where(type_filters[0])
                else:
                    query = query.where(or_(*type_filters))
    if keyword:
        like_expr = f"%{keyword}%"
        query = query.where(
            (SaleOrder.order_no.ilike(like_expr)) | (SaleOrder.customer.ilike(like_expr)) | (SaleOrder.product_name.ilike(like_expr))
        )

    order_clauses = []
    if sort_by and sort_by in SORTABLE_COLUMNS:
        query, col = _resolve_sort_expr(query, sort_by, customer_joined=customer_grade_joined)
        if sort_order == 'desc':
            order_clauses.append(col.desc().nullslast())
        else:
            order_clauses.append(col.asc().nullslast())
    if not order_clauses:
        order_clauses = [SaleOrder.promised_date.asc().nullslast(), SaleOrder.id.desc()]

    query = query.options(selectinload(SaleOrder.lines)).order_by(*order_clauses)
    result = await db.execute(query)
    orders = result.scalars().all()

    customer_codes = {order.customer_code for order in orders if order.customer_code}
    customer_map: dict[str, Customer] = {}
    if customer_codes:
        customer_result = await db.execute(
            select(Customer).where(Customer.customer_code.in_(customer_codes))
        )
        customer_map = {customer.customer_code: customer for customer in customer_result.scalars().all()}

    export_rows = []
    for order in orders:
        customer_master = customer_map.get(order.customer_code or "")
        promised_dates = [line.promised_date for line in order.lines if line.promised_date]
        planned_dates = [line.planned_start_date for line in order.lines if line.planned_start_date]
        sale_order_out = SaleOrderOut.model_validate(order)
        order_dict = sale_order_out.model_dump()
        order_dict.update(
            product_count=len({line.product_code for line in order.lines if line.product_code}),
            line_count=len(order.lines),
            promised_date=order.promised_date or (min(promised_dates) if promised_dates else None),
            planned_start_date=order.planned_start_date or (min(planned_dates) if planned_dates else None),
        )
        export_rows.append({
            'department': order.department or '',
            'delivery_completed_date': str(order.delivery_completed_date) if order.delivery_completed_date else '',
            'customer_grade': _effective_customer_grade(order, customer_master) or '',
            'customer_code': order.customer_code or '',
            'order_no': order.order_no or '',
            'risk_level': order.risk_level or '',
            'order_qty': order.order_qty if order.order_qty is not None else '',
            'completed_qty': order.completed_qty if order.completed_qty is not None else '',
            'order_date': str(order.order_date) if order.order_date else '',
            'promised_date': str(order_dict.get('promised_date')) if order_dict.get('promised_date') else '',
            'shipping_plan': str(order.shipping_plan) if order.shipping_plan else '',
            'customer_inspection_date': str(order.customer_inspection_date) if order.customer_inspection_date else '',
            'planned_start_date': str(order_dict.get('planned_start_date')) if order_dict.get('planned_start_date') else '',
            'inspection_result': order.inspection_result or '',
            'packaging_status': order.packaging_status or '',
            'bom_return_date': str(order.bom_return_date) if order.bom_return_date else '',
            'material_ready_date': str(order.material_ready_date) if order.material_ready_date else '',
            'shipping_status_desc': order.shipping_status_desc or '',
            'procurement_status': order.procurement_status or '',
            'front_process_date': str(order.front_process_date) if order.front_process_date else '',
            'first_article_date': str(order.first_article_date) if order.first_article_date else '',
            'assembly_start_date': str(order.assembly_start_date) if order.assembly_start_date else '',
            'assembly_complete_date': str(order.assembly_complete_date) if order.assembly_complete_date else '',
            'remark': order.remark or '',
        })

    if columns:
        selected_columns = [c.strip() for c in columns.split(',') if c.strip()]
        export_columns = [col for col in ORDER_EXPORT_COLUMNS if col.key in selected_columns]
    else:
        export_columns = ORDER_EXPORT_COLUMNS

    svc = GenericExportService(export_columns, export_rows, sheet_name='订单总控台')

    if format == 'csv':
        output = svc.to_csv()
        return StreamingResponse(
            output,
            media_type='text/csv; charset=utf-8',
            headers={"Content-Disposition": "attachment; filename=orders_export.csv"},
        )
    else:
        output = svc.to_xlsx()
        return StreamingResponse(
            output,
            media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            headers={"Content-Disposition": "attachment; filename=orders_export.xlsx"},
        )


# ── 内销订单 ──
@router.get("/domestic", response_model=ResponseModel[PageResult[SaleOrderListOut]])
async def list_domestic_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    sort_by: Optional[str] = Query("promised_date", description="排序字段"),
    sort_order: Optional[str] = Query("asc", description="排序方向 asc/desc"),
    current_user: dict = Depends(PermissionChecker("orders.list", "read")),
    db: AsyncSession = Depends(get_db),
):
    """内销订单 — 过滤department='内销部'"""
    base_filter = SaleOrder.department == '内销部'
    query = select(SaleOrder).where(base_filter)
    count_query = select(func.count(SaleOrder.id)).where(base_filter)

    if status:
        query = query.where(SaleOrder.status == status)
        count_query = count_query.where(SaleOrder.status == status)
    if keyword:
        like_expr = f"%{keyword}%"
        kw_filter = (SaleOrder.order_no.ilike(like_expr)) | (SaleOrder.customer.ilike(like_expr))
        query = query.where(kw_filter)
        count_query = count_query.where(kw_filter)

    total_result = await db.execute(count_query)
    total = total_result.scalar()

    # 构建排序子句
    order_clauses = []
    if sort_by and sort_by in SORTABLE_COLUMNS:
        query, col = _resolve_sort_expr(query, sort_by)
        if sort_order == 'desc':
            order_clauses.append(col.desc().nullslast())
        else:
            order_clauses.append(col.asc().nullslast())
    if not order_clauses:
        order_clauses = [SaleOrder.promised_date.asc().nullslast(), SaleOrder.id.desc()]

    query = query.options(selectinload(SaleOrder.lines)).order_by(*order_clauses).offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    orders = result.scalars().all()

    items = []
    for order in orders:
        order_dict = SaleOrderOut.model_validate(order).model_dump()
        order_dict.update(product_count=0, line_count=len(order.lines), shortage_count=0)
        items.append(SaleOrderListOut(**order_dict))

    return ResponseModel(data=PageResult(total=total, page=page, page_size=page_size, items=items))


# ── 内销出货 ──
@router.get("/domestic-shipment", response_model=ResponseModel[PageResult[SaleOrderListOut]])
async def list_domestic_shipment(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None),
    shipped: Optional[bool] = Query(None),
    sort_by: Optional[str] = Query("shipping_plan", description="排序字段"),
    sort_order: Optional[str] = Query("desc", description="排序方向 asc/desc"),
    current_user: dict = Depends(PermissionChecker("orders.list", "read")),
    db: AsyncSession = Depends(get_db),
):
    """内销出货 — 内销部订单的发货视图"""
    base_filter = SaleOrder.department == '内销部'
    query = select(SaleOrder).where(base_filter)
    count_query = select(func.count(SaleOrder.id)).where(base_filter)

    if shipped is True:
        query = query.where(SaleOrder.delivery_completed_date.isnot(None))
        count_query = count_query.where(SaleOrder.delivery_completed_date.isnot(None))
    elif shipped is False:
        query = query.where(SaleOrder.delivery_completed_date.is_(None))
        count_query = count_query.where(SaleOrder.delivery_completed_date.is_(None))
    if keyword:
        like_expr = f"%{keyword}%"
        kw_filter = (SaleOrder.order_no.ilike(like_expr)) | (SaleOrder.customer.ilike(like_expr))
        query = query.where(kw_filter)
        count_query = count_query.where(kw_filter)

    total_result = await db.execute(count_query)
    total = total_result.scalar()

    # 全局统计（用于统计卡片）
    global_stats_query = select(
        func.count(SaleOrder.id).label('total'),
        func.sum(case((SaleOrder.delivery_completed_date.isnot(None), 1), else_=0)).label('shipped_count'),
    ).where(base_filter)
    # 全局统计不受 keyword/shipped 筛选影响
    global_stats_result = await db.execute(global_stats_query)
    global_stats = global_stats_result.first()

    # 构建排序子句
    order_clauses = []
    if sort_by and sort_by in SORTABLE_COLUMNS:
        query, col = _resolve_sort_expr(query, sort_by)
        if sort_order == 'desc':
            order_clauses.append(col.desc().nullslast())
        else:
            order_clauses.append(col.asc().nullslast())
    if not order_clauses:
        order_clauses = [SaleOrder.shipping_plan.desc().nullslast(), SaleOrder.id.desc()]

    query = query.options(selectinload(SaleOrder.lines)).order_by(*order_clauses).offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    orders = result.scalars().all()

    items = []
    for order in orders:
        order_dict = SaleOrderOut.model_validate(order).model_dump()
        order_dict.update(product_count=0, line_count=len(order.lines), shortage_count=0)
        items.append(SaleOrderListOut(**order_dict))

    page_result = PageResult(total=total, page=page, page_size=page_size, items=items)
    # 将全局统计添加到返回数据中
    page_result.stats = {
        'total': global_stats.total or 0,
        'shipped_count': global_stats.shipped_count or 0,
        'pending_count': (global_stats.total or 0) - (global_stats.shipped_count or 0),
    }

    return ResponseModel(data=page_result)


# ── 订单风险池 ──
@router.get("/risk-pool", response_model=ResponseModel[PageResult[SaleOrderListOut]])
async def list_risk_pool(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: Optional[str] = Query(None),
    risk_level: Optional[str] = Query(None, description="风险等级，多选逗号分隔如 red,yellow"),
    sort_by: Optional[str] = Query("promised_date", description="排序字段"),
    sort_order: Optional[str] = Query("asc", description="排序方向 asc/desc"),
    current_user: dict = Depends(PermissionChecker("orders.risk_pool", "read")),
    db: AsyncSession = Depends(get_db),
):
    """订单风险池 — 延期 + 高/中风险订单"""
    today = date.today()
    risk_filter = or_(
        SaleOrder.risk_level.in_(['red', 'yellow']),
        (SaleOrder.promised_date < today) & (SaleOrder.status != 'closed'),
    )
    query = select(SaleOrder).where(risk_filter)
    count_query = select(func.count(SaleOrder.id)).where(risk_filter)

    if risk_level:
        levels = [x.strip() for x in risk_level.split(',') if x.strip()]
        if len(levels) == 1:
            query = query.where(SaleOrder.risk_level == levels[0])
            count_query = count_query.where(SaleOrder.risk_level == levels[0])
        elif levels:
            query = query.where(SaleOrder.risk_level.in_(levels))
            count_query = count_query.where(SaleOrder.risk_level.in_(levels))
    if keyword:
        like_expr = f"%{keyword}%"
        kw_filter = (SaleOrder.order_no.ilike(like_expr)) | (SaleOrder.customer.ilike(like_expr))
        query = query.where(kw_filter)
        count_query = count_query.where(kw_filter)

    total_result = await db.execute(count_query)
    total = total_result.scalar()

    # 全局风险等级统计（用于统计卡片）
    global_stats_query = select(
        func.count(SaleOrder.id).label('total'),
        func.sum(case((SaleOrder.risk_level == 'red', 1), else_=0)).label('red_count'),
        func.sum(case((SaleOrder.risk_level == 'yellow', 1), else_=0)).label('yellow_count'),
        func.sum(case((SaleOrder.risk_level == 'blue', 1), else_=0)).label('blue_count'),
        func.sum(case((SaleOrder.risk_level == 'green', 1), else_=0)).label('green_count'),
        func.sum(case(((SaleOrder.promised_date < today) & (SaleOrder.status != 'closed'), 1), else_=0)).label('overdue_count'),
    ).where(risk_filter)

    # 全局统计不受 keyword 和 risk_level 筛选影响
    global_stats_result = await db.execute(global_stats_query)
    global_stats = global_stats_result.first()

    # 构建排序子句
    order_clauses = []
    if sort_by and sort_by in SORTABLE_COLUMNS:
        query, col = _resolve_sort_expr(query, sort_by)
        if sort_order == 'desc':
            order_clauses.append(col.desc().nullslast())
        else:
            order_clauses.append(col.asc().nullslast())
    # 默认排序
    if not order_clauses:
        order_clauses = [SaleOrder.promised_date.asc().nullslast(), SaleOrder.id.desc()]

    import logging
    logger = logging.getLogger(__name__)
    logger.info(f"Sorting: sort_by={sort_by}, sort_order={sort_order}, order_clauses={order_clauses}")

    query = query.options(selectinload(SaleOrder.lines)).order_by(*order_clauses).offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    orders = result.scalars().all()

    items = []
    for order in orders:
        order_dict = SaleOrderOut.model_validate(order).model_dump()
        order_dict.update(product_count=0, line_count=len(order.lines), shortage_count=0)
        items.append(SaleOrderListOut(**order_dict))

    page_result = PageResult(total=total, page=page, page_size=page_size, items=items)
    # 将全局统计添加到返回数据中
    page_result.stats = {
        'total': global_stats.total or 0,
        'red_count': global_stats.red_count or 0,
        'yellow_count': global_stats.yellow_count or 0,
        'blue_count': global_stats.blue_count or 0,
        'green_count': global_stats.green_count or 0,
        'overdue_count': global_stats.overdue_count or 0,
    }

    return ResponseModel(data=page_result)


# ── 出货分析图表 ──
@router.get("/shipping-analytics", response_model=ResponseModel[dict])
async def get_shipping_analytics(
    current_user: dict = Depends(PermissionChecker("orders.list", "read")),
    db: AsyncSession = Depends(get_db),
):
    change_result = await db.execute(
        select(AuditLog.record_id, func.count().label("cnt"))
        .where(AuditLog.table_name == "sale_order", AuditLog.field_name == "shipping_plan", AuditLog.action == "update")
        .group_by(AuditLog.record_id)
    )
    order_change_map: dict[int, int] = {}
    for row in change_result.all():
        order_change_map[row.record_id] = row.cnt

    all_orders_result = await db.execute(
        select(SaleOrder.id, SaleOrder.department, SaleOrder.customer, SaleOrder.shipping_plan, SaleOrder.delivery_completed_date)
    )
    all_orders = all_orders_result.all()

    buckets = {"0次": 0, "1次": 0, "2次": 0, "3次+": 0}
    for o in all_orders:
        cnt = order_change_map.get(o.id, 0)
        if cnt >= 3:
            buckets["3次+"] += 1
        elif cnt == 2:
            buckets["2次"] += 1
        elif cnt == 1:
            buckets["1次"] += 1
        else:
            buckets["0次"] += 1
    change_distribution = [{"name": k, "value": v} for k, v in buckets.items()]

    dept_changes: dict[str, list[int]] = {}
    for o in all_orders:
        dept = o.department or "未知部门"
        cnt = order_change_map.get(o.id, 0)
        dept_changes.setdefault(dept, []).append(cnt)
    change_by_dept = [
        {"name": dept, "value": round(sum(counts) / len(counts), 2)}
        for dept, counts in dept_changes.items()
    ]
    change_by_dept.sort(key=lambda x: x["value"], reverse=True)

    customer_changes: dict[str, list[int]] = {}
    for o in all_orders:
        cust = o.customer or "未知客户"
        cnt = order_change_map.get(o.id, 0)
        customer_changes.setdefault(cust, []).append(cnt)
    change_by_customer = [
        {"name": cust, "value": round(sum(counts) / len(counts), 2)}
        for cust, counts in customer_changes.items()
    ]
    change_by_customer.sort(key=lambda x: x["value"], reverse=True)

    completed_orders = [o for o in all_orders if o.delivery_completed_date and o.shipping_plan]
    early = sum(1 for o in completed_orders if o.delivery_completed_date < o.shipping_plan)
    ontime = sum(1 for o in completed_orders if o.delivery_completed_date == o.shipping_plan)
    late = sum(1 for o in completed_orders if o.delivery_completed_date > o.shipping_plan)
    delivery_stats = [
        {"name": "提前完成", "value": early, "color": "#16a34a"},
        {"name": "准时完成", "value": ontime, "color": "#6366f1"},
        {"name": "延期完成", "value": late, "color": "#e11d48"},
    ]

    dept_delivery: dict[str, dict] = {}
    for o in completed_orders:
        dept = o.department or "未知部门"
        d = dept_delivery.setdefault(dept, {"total": 0, "ok": 0})
        d["total"] += 1
        if o.delivery_completed_date <= o.shipping_plan:
            d["ok"] += 1
    delivery_by_dept = [
        {"name": dept, "value": round(d["ok"] / d["total"], 2) if d["total"] else 0}
        for dept, d in dept_delivery.items()
    ]
    delivery_by_dept.sort(key=lambda x: x["value"], reverse=True)

    cust_delivery: dict[str, dict] = {}
    for o in completed_orders:
        cust = o.customer or "未知客户"
        d = cust_delivery.setdefault(cust, {"total": 0, "ok": 0})
        d["total"] += 1
        if o.delivery_completed_date <= o.shipping_plan:
            d["ok"] += 1
    delivery_by_customer = [
        {"name": cust, "value": round(d["ok"] / d["total"], 2) if d["total"] else 0}
        for cust, d in cust_delivery.items()
    ]
    delivery_by_customer.sort(key=lambda x: x["value"], reverse=True)

    return ResponseModel(data={
        "change_distribution": change_distribution,
        "change_by_dept": change_by_dept,
        "change_by_customer": change_by_customer,
        "delivery_stats": delivery_stats,
        "delivery_by_dept": delivery_by_dept,
        "delivery_by_customer": delivery_by_customer,
    })


@router.get("/{order_no}/product-materials", response_model=ResponseModel[list[OrderProductMaterialsOut]])
async def get_order_product_materials_view(
    order_no: str,
    line_no: Optional[str] = Query(None),
    current_user: dict = Depends(PermissionChecker("orders.list", "read")),
    db: AsyncSession = Depends(get_db),
):
    items = await get_order_product_materials(db, order_no=order_no, line_no=line_no)
    if not items:
        exists = await db.execute(select(SaleOrder.id).where(SaleOrder.order_no == order_no).limit(1))
        if not exists.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="订单不存在")
    return ResponseModel(data=items)


# ── 出货计划变更时间线（来源 audit_log）──
@router.get("/shipping-plan-history", response_model=ResponseModel[list[ShippingPlanHistoryItem]])
async def get_shipping_plan_history(
    record_id: int = Query(..., description="sale_order.id"),
    current_user: dict = Depends(PermissionChecker("orders.list", "read")),
    db: AsyncSession = Depends(get_db),
):
    """订单出货计划变更时间线，按操作时间倒序"""
    result = await db.execute(
        select(AuditLog)
        .where(
            AuditLog.table_name == "sale_order",
            AuditLog.field_name == "shipping_plan",
            AuditLog.record_id == record_id,
        )
        .order_by(AuditLog.operated_at.desc(), AuditLog.id.desc())
    )
    items = [
        ShippingPlanHistoryItem(
            id=log.id,
            old_value=log.old_value,
            new_value=log.new_value,
            operator=log.operator,
            operated_at=log.operated_at.strftime("%Y-%m-%d %H:%M:%S") if log.operated_at else None,
        )
        for log in result.scalars().all()
    ]
    return ResponseModel(data=items)


@router.get("/{order_no}", response_model=ResponseModel[OrderDetailOut])
@router.get("/{order_no}/lines/{line_no}", response_model=ResponseModel[OrderDetailOut])
async def get_order_detail(
    order_no: str,
    line_no: Optional[str] = None,
    current_user: dict = Depends(PermissionChecker("orders.list", "read")),
    db: AsyncSession = Depends(get_db),
):
    q = select(SaleOrder).options(selectinload(SaleOrder.lines)).where(SaleOrder.order_no == order_no)
    if line_no:
        q = q.where(SaleOrder.line_no == line_no)
    result = await db.execute(q.order_by(SaleOrder.id.desc()).limit(1))
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")

    line_nos = [line.line_no for line in order.lines]

    md_result = await db.execute(
        select(MaterialDemand).where(
            MaterialDemand.order_no == order_no,
            MaterialDemand.line_no.in_(line_nos) if line_nos else False,
        )
    )
    materials = [MaterialDemandOut.model_validate(m) for m in md_result.scalars().all()]

    shortage_count = sum(1 for m in materials if m.shortage_flag)

    # Fetch bindings with PO details
    binding_result = await db.execute(
        select(OrderMaterialPoBinding)
        .options(selectinload(OrderMaterialPoBinding.purchase_order))
        .where(
            OrderMaterialPoBinding.order_no == order_no,
            OrderMaterialPoBinding.line_no.in_(line_nos) if line_nos else False,
        )
    )
    bindings = []
    for binding in binding_result.scalars().all():
        po_detail = None
        if binding.purchase_order:
            po_detail = PODetail.model_validate(binding.purchase_order)

        binding_out = BindingOut(
            id=binding.id,
            order_no=binding.order_no,
            line_no=binding.line_no,
            material_code=binding.material_code,
            po_no=binding.po_no,
            bound_qty=binding.bound_qty,
            bind_status=binding.bind_status,
            bind_source=binding.bind_source,
            po_detail=po_detail,
            created_at=binding.created_at,
        )
        bindings.append(binding_out)

    # Calculate in_transit_count and latest_eta from bindings
    in_transit_count = 0
    latest_eta = None
    today = date.today()
    for binding in bindings:
        if binding.po_detail and binding.po_detail.eta:
            po_status = binding.po_detail.po_status
            actual_arrival = binding.po_detail.actual_arrival_date
            eta = binding.po_detail.eta

            if (po_status not in ['received', 'cancelled'] and
                actual_arrival is None and
                eta >= today):
                in_transit_count += 1
                if latest_eta is None or eta > latest_eta:
                    latest_eta = eta

    # 查询该订单行的风险问题
    issue_result = await db.execute(
        select(RiskIssue).where(
            RiskIssue.order_no == order_no,
            RiskIssue.line_no.in_(line_nos) if line_nos else False,
        ).order_by(RiskIssue.created_at.desc())
    )
    issues = [RiskIssueOut.model_validate(i) for i in issue_result.scalars().all()]

    bom_no_to_normalized: dict[str, str] = {}
    normalized_codes: set[str] = set()
    for line in order.lines:
        bn = line.bom_no
        if bn:
            normalized = bn[2:] if bn.startswith(("P-", "Y-")) else bn
            bom_no_to_normalized[bn] = normalized
            normalized_codes.add(normalized)
    labor_price_map: dict[str, float] = {}
    if normalized_codes:
        lp_result = await db.execute(
            select(ProductionLaborPriceAudit.bom_code, ProductionLaborPriceAudit.labor_price_amount).where(
                ProductionLaborPriceAudit.bom_code.in_(normalized_codes),
                ProductionLaborPriceAudit.labor_price_amount.isnot(None),
            )
        )
        for row in lp_result.all():
            if row[1] is not None:
                labor_price_map[row[0]] = labor_price_map.get(row[0], 0.0) + float(row[1])

    detail = OrderDetailOut(
        **SaleOrderOut.model_validate(order).model_dump(),
        lines=[
            SaleOrderLineOut.model_validate(line).model_copy(update={
                "labor_price_amount": labor_price_map.get(bom_no_to_normalized.get(line.bom_no, "")),
            })
            for line in order.lines
        ],
        material_demands=materials,
        bindings=bindings,
        shortage_count=shortage_count,
        in_transit_count=in_transit_count,
        latest_eta=latest_eta,
        issues=issues,
    )
    return ResponseModel(data=detail)


@router.post("", response_model=ResponseModel[SaleOrderOut])
async def create_order(
    data: OrderCreate,
    current_user: dict = Depends(PermissionChecker("orders.list", "create")),
    db: AsyncSession = Depends(get_db),
):
    if data.sale_order.erp_id is not None:
        exists = await db.execute(
            select(SaleOrder.id).where(SaleOrder.erp_id == data.sale_order.erp_id).limit(1)
        )
        if exists.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="ERP订单ID已存在")

    order = SaleOrder(**data.sale_order.model_dump())
    db.add(order)
    await db.flush()
    for line in data.lines:
        db.add(SaleOrderLine(order_no=order.order_no, **line.model_dump()))
    await db.flush()
    await log_audit(db, "sale_order", order.id, "create", operator=current_user["username"])
    await db.commit()
    await db.refresh(order)
    return ResponseModel(data=SaleOrderOut.model_validate(order))


@router.put("/{order_no}", response_model=ResponseModel[SaleOrderOut])
async def update_order(
    order_no: str,
    data: SaleOrderUpdate,
    current_user: dict = Depends(PermissionChecker("orders.list", "update")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(SaleOrder).where(SaleOrder.order_no == order_no).order_by(SaleOrder.id.desc()).limit(1)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")

    update_data = data.model_dump(exclude_unset=True)
    await log_audit(db, "sale_order", order.id, "update", old_obj=order, update_data=update_data, operator=current_user["username"])
    for field, value in update_data.items():
        setattr(order, field, value)
    await db.commit()
    await db.refresh(order)
    return ResponseModel(data=SaleOrderOut.model_validate(order))


# ── CSV导入 ──
@router.post("/import/inspection", response_model=ResponseModel)
async def import_inspection_csv_endpoint(
    filepath: str = Query(..., description="服务器上1.点检.csv的路径"),
    current_user: dict = Depends(PermissionChecker("orders.list", "import")),
    db: AsyncSession = Depends(get_db),
):
    """从1.点检.csv导入数据到SaleOrder表"""
    from app.services.order.import_csv import import_inspection_csv
    result = await import_inspection_csv(filepath, db)
    await log_audit(db, "sale_order", 0, "import", field_name="inspection_csv", new_value=filepath, operator=current_user["username"])
    await db.commit()
    return ResponseModel(data=result)


@router.post("/import/run-order", response_model=ResponseModel)
async def import_run_order_csv_endpoint(
    filepath: str = Query(..., description="服务器上2.跑单.csv的路径"),
    current_user: dict = Depends(PermissionChecker("orders.run_orders", "import")),
    db: AsyncSession = Depends(get_db),
):
    """从2.跑单.csv导入数据到RunOrder表"""
    from app.services.order.import_csv import import_run_order_csv
    result = await import_run_order_csv(filepath, db)
    await log_audit(db, "run_order", 0, "import", field_name="run_order_csv", new_value=filepath, operator=current_user["username"])
    await db.commit()
    return ResponseModel(data=result)


# ── 出货计划导入 ──
@router.post("/import/shipping-plan", response_model=ResponseModel[dict])
async def import_shipping_plan_endpoint(
    file: UploadFile = File(...),
    current_user: dict = Depends(PermissionChecker("orders.list", "import")),
    db: AsyncSession = Depends(get_db),
):
    """导入出货计划表（表头含「销售订单号」「计划时间」），只更新订单头 shipping_plan"""
    from app.services.order.import_csv import import_shipping_plan

    filename = file.filename or ""
    if not filename.lower().endswith((".csv", ".xlsx")):
        raise HTTPException(status_code=400, detail="仅支持 .csv 或 .xlsx 文件")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="文件为空")
    try:
        result = await import_shipping_plan(content, filename, db, operator=current_user["username"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ResponseModel(data=result)
