"""供应链驾驶舱 — 仪表盘服务"""

from datetime import date, timedelta, datetime
from sqlalchemy import select, func, and_, or_, case, DateTime
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.order.sale_order import SaleOrder
from app.models.material.material_demand import MaterialDemand
from app.models.material.purchase_order import PurchaseOrder
from app.models.material.mrp_plan_order import MrpPlanOrder
from app.models.exception.risk_issue import RiskIssue
from app.schemas.dashboard.schemas import (
    DashboardData, RiskSummary, OrderRiskRow, RiskDistribution,
    TodayOverview, TodayDueOrder,
    RollingRiskDay, RollingRiskData,
    RiskDimensionItem, RiskFactorDistributionItem, OrderRiskDistributionData,
    ClosureAchievement,
    BoardItem, ProcurementBoardData,
    ShipmentBoardItem, ShipmentBoardData,
)
from app.services.exception.risk_engine import FACTOR_MAX, FACTOR_LABELS
from app.services.common.sync_filter import get_purchase_order_sync_filters


class DashboardService:
    def __init__(self, db: AsyncSession):
        self.db = db

    # ===== 基础：总览摘要 =====

    async def get_summary(self) -> DashboardData:
        red_count = (await self.db.execute(
            select(func.count(SaleOrder.id)).where(SaleOrder.risk_level == "red")
        )).scalar() or 0
        yellow_count = (await self.db.execute(
            select(func.count(SaleOrder.id)).where(SaleOrder.risk_level == "yellow")
        )).scalar() or 0
        green_count = (await self.db.execute(
            select(func.count(SaleOrder.id)).where(SaleOrder.risk_level == "green")
        )).scalar() or 0

        summary = RiskSummary(
            red_count=red_count,
            yellow_count=yellow_count,
            green_count=green_count,
            total_count=red_count + yellow_count + green_count,
        )

        recent_issues_result = await self.db.execute(
            select(RiskIssue).order_by(RiskIssue.created_at.desc()).limit(10)
        )
        recent_issues = [
            {
                "issue_no": i.issue_no,
                "issue_type": i.issue_type,
                "risk_level": i.risk_level,
                "description": i.description,
                "status": i.status,
            }
            for i in recent_issues_result.scalars().all()
        ]

        return DashboardData(risk_summary=summary, recent_issues=recent_issues)

    # ===== 今日总览 =====

    async def get_today_overview(self) -> TodayOverview:
        today = date.today()

        # 今日应交订单
        due_today_q = await self.db.execute(
            select(func.count(SaleOrder.id)).where(SaleOrder.promised_date == today)
        )
        due_today = due_today_q.scalar() or 0

        # 今日应交中红/黄灯
        due_today_red_q = await self.db.execute(
            select(func.count(SaleOrder.id)).where(
                SaleOrder.promised_date == today, SaleOrder.risk_level == "red"
            )
        )
        due_today_red = due_today_red_q.scalar() or 0

        due_today_yellow_q = await self.db.execute(
            select(func.count(SaleOrder.id)).where(
                SaleOrder.promised_date == today, SaleOrder.risk_level == "yellow"
            )
        )
        due_today_yellow = due_today_yellow_q.scalar() or 0

        # 欠料订单数（有 shortage_flag=True 的物料需求的订单）
        shortage_orders_q = await self.db.execute(
            select(func.count(func.distinct(MaterialDemand.order_no))).where(
                MaterialDemand.shortage_flag == True
            )
        )
        shortage_orders = shortage_orders_q.scalar() or 0

        # 待关闭异常
        pending_close_q = await self.db.execute(
            select(func.count(RiskIssue.id)).where(
                RiskIssue.status.in_(["open", "processing", "pending_review"])
            )
        )
        pending_close_issues = pending_close_q.scalar() or 0

        # 超时任务（commit_date < today 且未关闭）
        overdue_tasks_q = await self.db.execute(
            select(func.count(RiskIssue.id)).where(
                RiskIssue.commit_date < today,
                RiskIssue.status.notin_(["closed", "resolved"]),
            )
        )
        overdue_tasks = overdue_tasks_q.scalar() or 0

        # 在途 PO:ERP 原始在途状态,或基于收料数量推导的部分收料(未关闭且未收齐)
        in_transit_q = await self.db.execute(
            select(func.count(PurchaseOrder.id)).where(
                PurchaseOrder.is_closed == 0,
                or_(
                    PurchaseOrder.po_status.in_(["in_transit", "shipped"]),
                    and_(
                        PurchaseOrder.received_qty > 0,
                        PurchaseOrder.received_qty < PurchaseOrder.po_qty,
                    ),
                ),
            )
        )
        in_transit_po = in_transit_q.scalar() or 0

        # ETA 超期 PO
        eta_overdue_q = await self.db.execute(
            select(func.count(PurchaseOrder.id)).where(
                PurchaseOrder.eta < today,
                PurchaseOrder.po_status.notin_(["received", "completed", "closed"]),
            )
        )
        eta_overdue_po = eta_overdue_q.scalar() or 0

        # 全局订单风险计数
        total_orders_q = await self.db.execute(select(func.count(SaleOrder.id)))
        total_orders = total_orders_q.scalar() or 0

        red_orders_q = await self.db.execute(
            select(func.count(SaleOrder.id)).where(SaleOrder.risk_level == "red")
        )
        red_orders = red_orders_q.scalar() or 0

        yellow_orders_q = await self.db.execute(
            select(func.count(SaleOrder.id)).where(SaleOrder.risk_level == "yellow")
        )
        yellow_orders = yellow_orders_q.scalar() or 0

        green_orders_q = await self.db.execute(
            select(func.count(SaleOrder.id)).where(SaleOrder.risk_level == "green")
        )
        green_orders = green_orders_q.scalar() or 0

        blue_orders_q = await self.db.execute(
            select(func.count(SaleOrder.id)).where(SaleOrder.risk_level == "blue")
        )
        blue_orders = blue_orders_q.scalar() or 0

        return TodayOverview(
            due_today=due_today,
            due_today_red=due_today_red,
            due_today_yellow=due_today_yellow,
            shortage_orders=shortage_orders,
            pending_close_issues=pending_close_issues,
            overdue_tasks=overdue_tasks,
            in_transit_po=in_transit_po,
            eta_overdue_po=eta_overdue_po,
            total_orders=total_orders,
            red_orders=red_orders,
            yellow_orders=yellow_orders,
            blue_orders=blue_orders,
            green_orders=green_orders,
        )

    async def get_today_due_orders(self, *, page=1, page_size=50) -> dict:
        """今日应交订单列表"""
        today = date.today()
        query = select(SaleOrder).where(SaleOrder.promised_date == today)
        count_query = select(func.count(SaleOrder.id)).where(SaleOrder.promised_date == today)

        total = (await self.db.execute(count_query)).scalar() or 0
        # 红灯排最前，黄灯次之
        risk_order = case(
            (SaleOrder.risk_level == "red", 0),
            (SaleOrder.risk_level == "yellow", 1),
            else_=2,
        )
        query = query.order_by(risk_order, SaleOrder.updated_at.desc()).offset((page - 1) * page_size).limit(page_size)

        result = await self.db.execute(query)
        orders = result.scalars().all()

        items = []
        for order in orders:
            items.append(TodayDueOrder(
                order_no=order.order_no,
                line_no=order.line_no,
                customer=order.customer,
                product_name=order.product_name,
                order_qty=order.order_qty,
                promised_date=order.promised_date,
                risk_level=order.risk_level,
                owner=order.owner,
            ))

        from app.schemas.common import PageResult
        return PageResult(total=total, page=page, page_size=page_size, items=items)

    # ===== 14天滚动风险 =====

    async def get_rolling_risk(self) -> RollingRiskData:
        today = date.today()
        days = []
        total_due = 0
        total_red = 0
        total_yellow = 0
        total_blue = 0

        for i in range(14):
            d = today + timedelta(days=i)
            due_q = await self.db.execute(
                select(func.count(SaleOrder.id)).where(SaleOrder.promised_date == d)
            )
            due_count = due_q.scalar() or 0

            red_q = await self.db.execute(
                select(func.count(SaleOrder.id)).where(
                    SaleOrder.promised_date == d, SaleOrder.risk_level == "red"
                )
            )
            red_count = red_q.scalar() or 0

            yellow_q = await self.db.execute(
                select(func.count(SaleOrder.id)).where(
                    SaleOrder.promised_date == d, SaleOrder.risk_level == "yellow"
                )
            )
            yellow_count = yellow_q.scalar() or 0

            blue_q = await self.db.execute(
                select(func.count(SaleOrder.id)).where(
                    SaleOrder.promised_date == d, SaleOrder.risk_level == "blue"
                )
            )
            blue_count = blue_q.scalar() or 0

            # 取该日前5个风险订单
            risk_orders_q = await self.db.execute(
                select(SaleOrder).where(SaleOrder.promised_date == d)
                .order_by(SaleOrder.risk_level).limit(5)
            )
            risk_orders_result = risk_orders_q.scalars().all()

            risk_orders = []
            for order in risk_orders_result:
                risk_orders.append(TodayDueOrder(
                    order_no=order.order_no,
                    line_no=order.line_no,
                    customer=order.customer,
                    product_name=order.product_name,
                    order_qty=order.order_qty,
                    promised_date=order.promised_date,
                    risk_level=order.risk_level,
                    owner=order.owner,
                    risk_score=order.risk_score,
                    risk_factors=order.risk_factors,
                    risk_assessed_at=order.risk_assessed_at,
                ))

            days.append(RollingRiskDay(
                date=d,
                due_count=due_count,
                red_count=red_count,
                yellow_count=yellow_count,
                blue_count=blue_count,
                orders=risk_orders,
            ))
            total_due += due_count
            total_red += red_count
            total_yellow += yellow_count
            total_blue += blue_count

        return RollingRiskData(
            days=days,
            total_due=total_due,
            total_red=total_red,
            total_yellow=total_yellow,
            total_blue=total_blue,
        )

    # ===== 订单风险分布 =====

    async def get_order_risk_distribution(self) -> OrderRiskDistributionData:
        # 按客户
        by_customer_q = await self.db.execute(
            select(
                SaleOrder.customer,
                func.count(SaleOrder.id),
                func.sum(case((SaleOrder.risk_level == "red", 1), else_=0)),
                func.sum(case((SaleOrder.risk_level == "yellow", 1), else_=0)),
                func.sum(case((SaleOrder.risk_level == "blue", 1), else_=0)),
                func.sum(case((SaleOrder.risk_level == "green", 1), else_=0)),
            ).group_by(SaleOrder.customer).order_by(func.count(SaleOrder.id).desc()).limit(10)
        )
        by_customer = [
            RiskDimensionItem(
                name=row[0] or "未知",
                total_count=row[1],
                red_count=row[2] or 0,
                yellow_count=row[3] or 0,
                blue_count=row[4] or 0,
                green_count=row[5] or 0,
            )
            for row in by_customer_q.all()
        ]

        # 按产品
        by_product_q = await self.db.execute(
            select(
                SaleOrder.product_name,
                func.count(SaleOrder.id),
                func.sum(case((SaleOrder.risk_level == "red", 1), else_=0)),
                func.sum(case((SaleOrder.risk_level == "yellow", 1), else_=0)),
                func.sum(case((SaleOrder.risk_level == "blue", 1), else_=0)),
                func.sum(case((SaleOrder.risk_level == "green", 1), else_=0)),
            ).group_by(SaleOrder.product_name).order_by(func.count(SaleOrder.id).desc()).limit(10)
        )
        by_product = [
            RiskDimensionItem(
                name=row[0] or "未知",
                total_count=row[1],
                red_count=row[2] or 0,
                yellow_count=row[3] or 0,
                blue_count=row[4] or 0,
                green_count=row[5] or 0,
            )
            for row in by_product_q.all()
        ]

        # 按责任人
        by_owner_q = await self.db.execute(
            select(
                SaleOrder.owner,
                func.count(SaleOrder.id),
                func.sum(case((SaleOrder.risk_level == "red", 1), else_=0)),
                func.sum(case((SaleOrder.risk_level == "yellow", 1), else_=0)),
                func.sum(case((SaleOrder.risk_level == "blue", 1), else_=0)),
                func.sum(case((SaleOrder.risk_level == "green", 1), else_=0)),
            ).group_by(SaleOrder.owner).order_by(func.count(SaleOrder.id).desc()).limit(10)
        )
        by_owner = [
            RiskDimensionItem(
                name=row[0] or "未分配",
                total_count=row[1],
                red_count=row[2] or 0,
                yellow_count=row[3] or 0,
                blue_count=row[4] or 0,
                green_count=row[5] or 0,
            )
            for row in by_owner_q.all()
        ]

        # 按部门
        by_dept_q = await self.db.execute(
            select(
                SaleOrder.department,
                func.count(SaleOrder.id),
                func.sum(case((SaleOrder.risk_level == "red", 1), else_=0)),
                func.sum(case((SaleOrder.risk_level == "yellow", 1), else_=0)),
                func.sum(case((SaleOrder.risk_level == "blue", 1), else_=0)),
                func.sum(case((SaleOrder.risk_level == "green", 1), else_=0)),
            ).group_by(SaleOrder.department).order_by(func.count(SaleOrder.id).desc()).limit(10)
        )
        by_department = [
            RiskDimensionItem(
                name=row[0] or "未分配",
                total_count=row[1],
                red_count=row[2] or 0,
                yellow_count=row[3] or 0,
                blue_count=row[4] or 0,
                green_count=row[5] or 0,
            )
            for row in by_dept_q.all()
        ]

        # 按风险等级
        by_risk_q = await self.db.execute(
            select(
                SaleOrder.risk_level,
                func.count(SaleOrder.id),
            ).group_by(SaleOrder.risk_level)
        )
        by_risk_level = [
            RiskDimensionItem(
                name=row[0] or "未评估",
                total_count=row[1],
                red_count=row[1] if row[0] == "red" else 0,
                yellow_count=row[1] if row[0] == "yellow" else 0,
                blue_count=row[1] if row[0] == "blue" else 0,
                green_count=row[1] if row[0] == "green" else 0,
            )
            for row in by_risk_q.all()
        ]

        # 按风险因子分布（基于 risk_factors JSONB）
        by_factor = []
        factor_rows_q = await self.db.execute(
            select(SaleOrder.risk_factors, SaleOrder.risk_level)
            .where(SaleOrder.risk_factors != None)
        )
        factor_data = factor_rows_q.all()

        factor_stats: dict[str, dict] = {}
        for factors_json, risk_level in factor_data:
            if not factors_json or not isinstance(factors_json, dict):
                continue
            for fkey, fval in factors_json.items():
                if fkey not in FACTOR_LABELS:
                    continue
                if fkey not in factor_stats:
                    factor_stats[fkey] = {"red": 0, "yellow": 0, "blue": 0, "green": 0, "total": 0, "score_sum": 0}
                factor_stats[fkey]["total"] += 1
                factor_stats[fkey]["score_sum"] += float(fval or 0)
                if risk_level == "red":
                    factor_stats[fkey]["red"] += 1
                elif risk_level == "yellow":
                    factor_stats[fkey]["yellow"] += 1
                elif risk_level == "blue":
                    factor_stats[fkey]["blue"] += 1
                else:
                    factor_stats[fkey]["green"] += 1

        for fkey in FACTOR_LABELS:
            st = factor_stats.get(fkey, {"red": 0, "yellow": 0, "blue": 0, "green": 0, "total": 0, "score_sum": 0})
            avg = round(st["score_sum"] / st["total"], 1) if st["total"] > 0 else 0.0
            by_factor.append(RiskFactorDistributionItem(
                factor=fkey,
                factor_label=FACTOR_LABELS[fkey],
                red_count=st["red"],
                yellow_count=st["yellow"],
                blue_count=st["blue"],
                green_count=st["green"],
                total_count=st["total"],
                avg_score=avg,
            ))

        return OrderRiskDistributionData(
            by_customer=by_customer,
            by_product=by_product,
            by_owner=by_owner,
            by_department=by_department,
            by_risk_level=by_risk_level,
            by_factor=by_factor,
        )

    # ===== 闭环达成看板 =====

    async def get_closure_achievement(self) -> ClosureAchievement:
        today = date.today()
        seven_days_ago = today - timedelta(days=7)
        thirty_days_ago = today - timedelta(days=30)

        # 新增异常（近7天）
        new_q = await self.db.execute(
            select(func.count(RiskIssue.id)).where(RiskIssue.created_at >= seven_days_ago)
        )
        new_issues = new_q.scalar() or 0

        # 已关闭异常（近7天）
        closed_q = await self.db.execute(
            select(func.count(RiskIssue.id)).where(
                RiskIssue.closed_at != None,
                RiskIssue.closed_at >= seven_days_ago,
            )
        )
        closed_issues = closed_q.scalar() or 0

        # 逾期异常（commit_date < today 且未关闭）
        overdue_q = await self.db.execute(
            select(func.count(RiskIssue.id)).where(
                RiskIssue.commit_date < today,
                RiskIssue.status.notin_(["closed", "resolved"]),
            )
        )
        overdue_issues = overdue_q.scalar() or 0

        # 升级异常
        escalated_q = await self.db.execute(
            select(func.count(RiskIssue.id)).where(
                RiskIssue.risk_level == "red",
                RiskIssue.status.notin_(["closed", "resolved"]),
            )
        )
        escalated_issues = escalated_q.scalar() or 0

        # 重复异常（同一 order_no 出现多次未关闭）
        repeated_q = await self.db.execute(
            select(func.count(func.distinct(RiskIssue.order_no))).where(
                RiskIssue.order_no != None,
                RiskIssue.status.notin_(["closed", "resolved"]),
            ).group_by(RiskIssue.order_no).having(func.count(RiskIssue.id) > 1)
        )
        repeated_issues = len(repeated_q.all())

        # 闭环率
        total_open_q = await self.db.execute(
            select(func.count(RiskIssue.id)).where(RiskIssue.created_at >= thirty_days_ago)
        )
        total_open = total_open_q.scalar() or 0
        total_closed_q = await self.db.execute(
            select(func.count(RiskIssue.id)).where(
                RiskIssue.closed_at != None,
                RiskIssue.closed_at >= thirty_days_ago,
            )
        )
        total_closed = total_closed_q.scalar() or 0
        closure_rate = round(total_closed / total_open, 4) if total_open > 0 else 0.0

        # 按时关闭率
        on_time_closed_q = await self.db.execute(
            select(func.count(RiskIssue.id)).where(
                RiskIssue.closed_at != None,
                RiskIssue.closed_at <= func.cast(RiskIssue.commit_date, DateTime),
                RiskIssue.closed_at >= thirty_days_ago,
            )
        )
        on_time_closed = on_time_closed_q.scalar() or 0
        on_time_rate = round(on_time_closed / total_closed, 4) if total_closed > 0 else 0.0

        # 按类型分布
        by_type_q = await self.db.execute(
            select(
                RiskIssue.issue_type,
                func.count(RiskIssue.id),
                func.sum(case((RiskIssue.risk_level == "red", 1), else_=0)),
                func.sum(case((RiskIssue.risk_level == "yellow", 1), else_=0)),
                func.sum(case((RiskIssue.risk_level == "green", 1), else_=0)),
            ).group_by(RiskIssue.issue_type).order_by(func.count(RiskIssue.id).desc()).limit(10)
        )
        by_type = [
            RiskDimensionItem(
                name=row[0] or "未知",
                total_count=row[1],
                red_count=row[2] or 0,
                yellow_count=row[3] or 0,
                green_count=row[4] or 0,
            )
            for row in by_type_q.all()
        ]

        # 按责任人分布
        by_owner_q = await self.db.execute(
            select(
                RiskIssue.owner,
                func.count(RiskIssue.id),
                func.sum(case((RiskIssue.risk_level == "red", 1), else_=0)),
                func.sum(case((RiskIssue.risk_level == "yellow", 1), else_=0)),
                func.sum(case((RiskIssue.risk_level == "green", 1), else_=0)),
            ).group_by(RiskIssue.owner).order_by(func.count(RiskIssue.id).desc()).limit(10)
        )
        by_owner = [
            RiskDimensionItem(
                name=row[0] or "未分配",
                total_count=row[1],
                red_count=row[2] or 0,
                yellow_count=row[3] or 0,
                green_count=row[4] or 0,
            )
            for row in by_owner_q.all()
        ]

        # 近7天趋势
        trend = []
        for i in range(7):
            d = today - timedelta(days=6 - i)
            day_new_q = await self.db.execute(
                select(func.count(RiskIssue.id)).where(
                    func.date(RiskIssue.created_at) == d
                )
            )
            day_closed_q = await self.db.execute(
                select(func.count(RiskIssue.id)).where(
                    RiskIssue.closed_at != None,
                    func.date(RiskIssue.closed_at) == d,
                )
            )
            trend.append({
                "date": d.isoformat(),
                "new": day_new_q.scalar() or 0,
                "closed": day_closed_q.scalar() or 0,
            })

        return ClosureAchievement(
            new_issues=new_issues,
            closed_issues=closed_issues,
            overdue_issues=overdue_issues,
            escalated_issues=escalated_issues,
            repeated_issues=repeated_issues,
            closure_rate=closure_rate,
            on_time_rate=on_time_rate,
            by_type=by_type,
            by_owner=by_owner,
            trend=trend,
        )

    # ===== 订单风险列表（原有） =====

    async def get_order_risk_list(self, *, page=1, page_size=20, risk_level=None, owner=None, keyword=None, status=None, data_source=None) -> dict:
        query = select(SaleOrder)
        count_query = select(func.count(SaleOrder.id))

        if risk_level:
            query = query.where(SaleOrder.risk_level == risk_level)
            count_query = count_query.where(SaleOrder.risk_level == risk_level)
        if owner:
            query = query.where(SaleOrder.owner == owner)
            count_query = count_query.where(SaleOrder.owner == owner)
        if status:
            query = query.where(SaleOrder.status == status)
            count_query = count_query.where(SaleOrder.status == status)
        if data_source:
            query = query.where(SaleOrder.data_source == data_source)
            count_query = count_query.where(SaleOrder.data_source == data_source)
        if keyword:
            like_expr = f"%{keyword}%"
            query = query.where(
                (SaleOrder.order_no.ilike(like_expr)) | (SaleOrder.customer.ilike(like_expr))
            )
            count_query = count_query.where(
                (SaleOrder.order_no.ilike(like_expr)) | (SaleOrder.customer.ilike(like_expr))
            )

        total = (await self.db.execute(count_query)).scalar() or 0
        query = query.order_by(SaleOrder.updated_at.desc()).offset((page - 1) * page_size).limit(page_size)
        result = await self.db.execute(query)
        orders = result.scalars().all()

        items = []
        for order in orders:
            shortage_result = await self.db.execute(
                select(func.count(MaterialDemand.id)).where(
                    MaterialDemand.order_no == order.order_no,
                    MaterialDemand.shortage_flag == True,
                )
            )
            shortage_count = shortage_result.scalar() or 0
            items.append(OrderRiskRow(
                order_no=order.order_no,
                line_no=order.line_no,
                customer=order.customer,
                product_code=order.product_code,
                product_name=order.product_name,
                order_qty=order.order_qty,
                promised_date=order.promised_date,
                planned_start_date=order.planned_start_date,
                owner=order.owner,
                status=order.status,
                risk_level=order.risk_level,
                shortage_count=shortage_count,
            ))

        from app.schemas.common import PageResult
        return PageResult(total=total, page=page, page_size=page_size, items=items)

    # ===== 风险分布（原有） =====

    async def get_risk_distribution(self) -> list[RiskDistribution]:
        result = await self.db.execute(
            select(RiskIssue.risk_level, RiskIssue.issue_type, func.count(RiskIssue.id))
            .group_by(RiskIssue.risk_level, RiskIssue.issue_type)
        )
        return [
            RiskDistribution(risk_level=row[0], issue_type=row[1], count=row[2])
            for row in result.all()
        ]

    # ===== 采购看板（大屏 - 7日备料白板） =====

    async def get_procurement_board(self, target_date: date | None = None) -> ProcurementBoardData:
        # 基准日始终为当天，target_date 仅用于"查看某一天的到料情况"
        today = date.today()
        target = target_date or today

        # 查询范围：7 日滚动窗口（选中日 ~ 选中日+6）应到的 PO + 所有 ETA 早于今天且未齐套的 PO（历史逾期未齐）
        window_end = target + timedelta(days=6)

        # 构建物料→订单→部门(车位)的映射：从MaterialDemand找到对应订单的部门
        md_q = await self.db.execute(
            select(
                MaterialDemand.material_code,
                SaleOrder.department,
                func.max(SaleOrder.owner).label("owner"),
            ).join(
                SaleOrder, MaterialDemand.order_no == SaleOrder.order_no, isouter=True
            ).where(
                MaterialDemand.shortage_flag == True
            ).group_by(MaterialDemand.material_code, SaleOrder.department)
        )
        md_map: dict[str, dict] = {}
        for row in md_q.all():
            mat_code = row[0]
            md_map[mat_code] = {
                "department": row[1],
                "order_owner": row[2],
            }

        # 查PO数据：逾期30天 ~ 未来7天应到且未关闭，逾期排最前
        # 同步过滤：ERP中已删除的记录在上次同步中未被更新，应排除（CSV数据不受影响）
        sync_filters = await get_purchase_order_sync_filters(self.db)
        po_conditions = [
            PurchaseOrder.eta != None,
            PurchaseOrder.is_closed == 0,
            or_(
                # 1) 7 日窗口内应到的 PO（含已齐套，供"已齐套"列展示）
                PurchaseOrder.eta.between(target, window_end),
                # 2) 真正逾期（ETA 早于今天）且未齐套的 PO
                (
                    (PurchaseOrder.eta < today)
                    & (PurchaseOrder.po_qty.isnot(None))
                    & (PurchaseOrder.po_qty > 0)
                    & (PurchaseOrder.received_qty.isnot(None))
                    & (PurchaseOrder.received_qty < PurchaseOrder.po_qty)
                ),
            ),
        ]
        if sync_filters:
            # 只显示更新时间在上次同步-30分钟之后的记录
            po_conditions.append(and_(*sync_filters))

        # 排除已关闭的销售订单关联的PO，且未关联销售订单的PO也不显示
        closed_order_q = await self.db.execute(
            select(SaleOrder.order_no).where(
                SaleOrder.order_no != None,
                SaleOrder.is_closed == 1,
            )
        )
        closed_order_nos = set(closed_order_q.scalars().all())
        po_conditions.append(PurchaseOrder.order_no != None)
        po_conditions.append(PurchaseOrder.order_no != "")
        if closed_order_nos:
            po_conditions.append(PurchaseOrder.order_no.notin_(closed_order_nos))

        po_q = await self.db.execute(
            select(PurchaseOrder).where(*po_conditions).order_by(
                case((PurchaseOrder.eta < today, 0), else_=1),
                PurchaseOrder.eta.asc(),
                PurchaseOrder.po_no.asc(),
            )
        )
        all_pos = po_q.scalars().all()

        # 收集本次涉及的物料编码和订单号
        material_codes = {p.material_code for p in all_pos if p.material_code}
        order_nos = {p.order_no for p in all_pos if p.order_no}

        # 1) 库存数量：按物料维度查询（stock_qty 是物料级库存，不是订单维度，不能按订单SUM累加）
        stock_map: dict[str, float] = {}
        if material_codes:
            stock_q = await self.db.execute(
                select(
                    MrpPlanOrder.material_code,
                    func.max(MrpPlanOrder.stock_qty),
                ).where(
                    MrpPlanOrder.material_code.in_(material_codes),
                    MrpPlanOrder.stock_qty != None,
                ).group_by(
                    MrpPlanOrder.material_code,
                )
            )
            for row in stock_q.all():
                if row[1] is not None:
                    stock_map[row[0]] = float(row[1])

        # 2) MRP计划数量：按 销售订单+物料 维度匹配（base_plan_qty 是订单维度的需求量）
        mrp_qty_map: dict[tuple[str, str], float] = {}
        if order_nos:
            mrp_q = await self.db.execute(
                select(
                    MrpPlanOrder.sale_order_no,
                    MrpPlanOrder.material_code,
                    func.sum(MrpPlanOrder.base_plan_qty),
                ).where(
                    MrpPlanOrder.sale_order_no.in_(order_nos),
                ).group_by(
                    MrpPlanOrder.sale_order_no,
                    MrpPlanOrder.material_code,
                )
            )
            for row in mrp_q.all():
                if row[2] is not None:
                    mrp_qty_map[(row[0], row[1])] = float(row[2])

        # 3) 缺料数量：按物料维度批量查询，避免N+1
        shortage_map: dict[str, float] = {}
        if material_codes:
            short_q = await self.db.execute(
                select(
                    MaterialDemand.material_code,
                    func.sum(MaterialDemand.shortage_qty),
                ).where(
                    MaterialDemand.material_code.in_(material_codes),
                    MaterialDemand.shortage_flag == True,
                ).group_by(
                    MaterialDemand.material_code,
                )
            )
            for row in short_q.all():
                if row[1] is not None and float(row[1]) > 0:
                    shortage_map[row[0]] = float(row[1])

        items: list[BoardItem] = []
        for po in all_pos:
            received_qty = float(po.received_qty) if po.received_qty is not None else 0
            po_qty = float(po.po_qty) if po.po_qty is not None else 0

            # is_closed/已齐套判断：覆盖所有"已完成"状态
            is_ready = (
                po.is_closed == 1
                or po.po_status in ("received", "completed", "fully_received")
                or (po_qty > 0 and received_qty >= po_qty)
            )

            is_overdue = False
            overdue_days = 0
            if po.eta and po.eta < today and not is_ready:
                is_overdue = True
                overdue_days = (today - po.eta).days

            # 欠料：通过MaterialDemand判断
            md_info = md_map.get(po.material_code, {})
            is_shortage = po.material_code in md_map and not is_ready
            shortage_qty_val = shortage_map.get(po.material_code) if is_shortage else None

            # 车位/产线：从订单部门映射，没有则留空
            workstation = md_info.get("department") or ""

            # 单号优先显示order_no（销售订单），没有则显示po_no
            doc_no = po.order_no or po.po_no

            # 库存从物料维度map取；MRP数量从(订单,物料)维度map取
            stock_qty_val = stock_map.get(po.material_code)
            mrp_qty_val = mrp_qty_map.get((po.order_no, po.material_code)) if po.order_no else None

            items.append(BoardItem(
                id=po.id,
                board_date=po.eta,
                doc_no=doc_no,
                material_code=po.material_code,
                material_name=po.material_name,
                spec_model=po.spec_model,
                qty=po_qty if po_qty > 0 else None,
                received_qty=received_qty if received_qty >= 0 else 0,
                stock_qty=stock_qty_val,
                mrp_qty=mrp_qty_val,
                is_ready=is_ready,
                shortage_qty=shortage_qty_val,
                is_shortage=is_shortage,
                is_overdue=is_overdue,
                overdue_days=overdue_days,
                owner=po.owner,
                responsible=md_info.get("order_owner"),
                workstation=workstation,
                remark=po.arrival_hour_note or po.supplier_name,
            ))

        return ProcurementBoardData(
            items=items,
            last_updated=datetime.now(),
        )

    async def get_shipment_board(self) -> ShipmentBoardData:
        """出货计划看板：7 日滚动窗口（逾期 + 今明后 6 日）+ 近 7 日已完成"""
        today = date.today()
        window_end = today + timedelta(days=6)
        done_since = today - timedelta(days=6)

        # 查询：有出货计划日期、订单未关闭，且满足其一：
        #   1) 未发货完成且出货计划 <= today+6（逾期 / 今日 / 明日 / 未来）
        #   2) 已发货完成且完成日期在近 7 日内（本周已完成）
        q = await self.db.execute(
            select(SaleOrder).where(
                SaleOrder.shipping_plan != None,
                SaleOrder.is_closed == 0,
                or_(
                    (SaleOrder.delivery_completed_date == None) & (SaleOrder.shipping_plan <= window_end),
                    (SaleOrder.delivery_completed_date != None) & (SaleOrder.delivery_completed_date >= done_since),
                ),
            ).order_by(
                # 逾期排最前（shipping_plan 升序 = 最早的最逾期），同日内按单号
                SaleOrder.shipping_plan.asc(),
                SaleOrder.order_no.asc(),
            )
        )
        orders = q.scalars().all()

        items: list[ShipmentBoardItem] = []
        for o in orders:
            is_overdue = False
            overdue_days = 0
            if o.shipping_plan and o.shipping_plan < today and o.delivery_completed_date is None:
                is_overdue = True
                overdue_days = (today - o.shipping_plan).days

            items.append(ShipmentBoardItem(
                id=o.id,
                order_no=o.order_no,
                line_no=o.line_no,
                shipping_plan=o.shipping_plan,
                is_overdue=is_overdue,
                overdue_days=overdue_days,
                customer=o.customer,
                customer_code=o.customer_code,
                product_code=o.product_code,
                product_name=o.product_name,
                order_qty=float(o.order_qty) if o.order_qty is not None else None,
                completed_qty=float(o.completed_qty) if o.completed_qty is not None else None,
                promised_date=o.promised_date,
                risk_level=o.risk_level,
                owner=o.owner,
                shipping_status_desc=o.shipping_status_desc,
                status=o.status,
                is_done=o.delivery_completed_date is not None,
                completed_date=o.delivery_completed_date,
            ))

        return ShipmentBoardData(
            items=items,
            last_updated=datetime.now(),
        )
