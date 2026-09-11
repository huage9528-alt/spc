"""异常与质量中心 — 风险引擎服务（多因子加权评分 + 规则调整）"""

from collections import defaultdict
from datetime import date, datetime
from sqlalchemy import select, func, update, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.order.sale_order import SaleOrder
from app.models.material.material_demand import MaterialDemand
from app.models.material.purchase_order import PurchaseOrder
from app.models.exception.risk_issue import RiskIssue
from app.models.exception.quality_issue import QualityIssue
from app.models.production.process_progress import ProcessProgress
from app.models.rules.risk_rule import RiskRule
from app.models.basicdata.audit_log import AuditLog


# ── 因子定义 ──
FACTOR_MAX = {
    "delivery_delay": 25,
    "shortage": 30,
    "process_lag": 15,
    "quality": 15,
    "eta_delay": 20,
    "inspection_ng": 15,
}
FACTOR_LABELS = {
    "delivery_delay": "交期延期",
    "shortage": "欠料风险",
    "process_lag": "工序滞后",
    "quality": "品质异常",
    "eta_delay": "ETA延期",
    "inspection_ng": "客检NG",
}
RAW_MAX = sum(FACTOR_MAX.values())  # 120

# ── 问题编号类型缩写映射 ──
ISSUE_TYPE_PREFIX = {
    "delivery_delay": "DD",
    "shortage": "SH",
    "eta_delay": "ED",
    "process_lag": "PL",
    "quality": "QL",
    "inspection_ng": "IN",
    "holiday_risk": "HR",
    "long_lead": "LL",
    "manual": "MN",
}


def _score_to_level(score: float) -> str:
    if score >= 60:
        return "red"
    elif score >= 30:
        return "yellow"
    elif score > 0:
        return "blue"
    return "green"


class RiskEngine:
    def __init__(self, db: AsyncSession):
        self.db = db

    # ===== 单订单因子计算 =====

    async def _calc_delivery_delay(self, order: SaleOrder) -> int:
        """交期延期因子：已发货用 delivery_completed_date vs promised_date，未发货用 today vs promised_date"""
        if not order.promised_date or order.status == "closed":
            return 0
        if order.delivery_completed_date:
            # 已发货：用实际发货完成日期与承诺交期比较
            if order.delivery_completed_date <= order.promised_date:
                return 0
            delay = (order.delivery_completed_date - order.promised_date).days
        else:
            # 未发货：用今天与承诺交期比较
            today = date.today()
            if order.promised_date >= today:
                return 0
            delay = (today - order.promised_date).days
        if delay > 7:
            return 25
        elif delay >= 3:
            return 15
        elif delay >= 1:
            return 8
        return 0

    async def _calc_shortage(self, order: SaleOrder) -> int:
        """欠料因子：基于 MaterialDemand.shortage_flag"""
        result = await self.db.execute(
            select(func.count(MaterialDemand.id)).where(
                MaterialDemand.order_no == order.order_no,
                MaterialDemand.shortage_flag == True,
            )
        )
        cnt = result.scalar() or 0
        if cnt > 5:
            return 30
        elif cnt >= 3:
            return 20
        elif cnt >= 1:
            return 10
        return 0

    async def _calc_process_lag(self, order: SaleOrder) -> int:
        """工序滞后因子：基于 ProcessProgress.status"""
        result = await self.db.execute(
            select(ProcessProgress.status).where(
                ProcessProgress.order_no == order.order_no,
            )
        )
        statuses = [row[0] for row in result.all()]
        if not statuses:
            return 0
        if "blocked" in statuses:
            return 15
        elif "delayed" in statuses:
            return 8
        return 0

    async def _calc_quality(self, order: SaleOrder) -> int:
        """品质异常因子：基于 QualityIssue"""
        result = await self.db.execute(
            select(QualityIssue.status).where(
                QualityIssue.order_no == order.order_no,
                QualityIssue.is_deleted == False,
            )
        )
        issues = result.scalars().all()
        if not issues:
            return 0
        open_count = sum(1 for s in issues if s in ("open", "processing"))
        if open_count > 0:
            return 15
        return 5

    async def _calc_eta_delay(self, order: SaleOrder) -> int:
        """ETA延期因子：基于 PurchaseOrder.eta vs promised_date/今天"""
        today = date.today()
        result = await self.db.execute(
            select(PurchaseOrder.eta, PurchaseOrder.original_eta).where(
                PurchaseOrder.order_no == order.order_no,
                PurchaseOrder.po_status.notin_(["received", "cancelled", "closed"]),
            )
        )
        rows = result.all()
        if not rows:
            return 0
        max_delay = 0
        for eta, original_eta in rows:
            if not eta:
                continue
            # ETA已超过今天，计算延期天数
            if eta < today:
                delay = (today - eta).days
                max_delay = max(max_delay, delay)
            # ETA超过了原始ETA
            elif original_eta and eta > original_eta:
                delay = (eta - original_eta).days
                max_delay = max(max_delay, delay)
            # ETA超过了订单交期
            elif order.promised_date and eta > order.promised_date:
                delay = (eta - order.promised_date).days
                max_delay = max(max_delay, delay)
        if max_delay > 7:
            return 20
        elif max_delay > 0:
            return 10
        return 0

    async def _calc_inspection_ng(self, order: SaleOrder) -> int:
        """客检NG因子：基于 inspection_result + customer_inspection_date"""
        result_val = (order.inspection_result or "").strip().upper()
        if result_val in ("NG", "FAIL", "不合格"):
            return 15

        # 只有当客检日期已到但未填写结果时才给5分
        if result_val == "" or result_val is None:
            today = date.today()
            if order.customer_inspection_date and order.customer_inspection_date <= today:
                return 5

        return 0

    # ===== 评估单个订单 =====

    async def assess_order(self, order: SaleOrder) -> dict:
        """评估单个订单，返回因子分值+总分+等级"""
        factors = {
            "delivery_delay": await self._calc_delivery_delay(order),
            "shortage": await self._calc_shortage(order),
            "process_lag": await self._calc_process_lag(order),
            "quality": await self._calc_quality(order),
            "eta_delay": await self._calc_eta_delay(order),
            "inspection_ng": await self._calc_inspection_ng(order),
        }
        raw_score = sum(factors.values())
        final_score = round(min(raw_score / RAW_MAX * 100, 100), 2)
        risk_level = _score_to_level(final_score)

        # 规则调整层
        rules_result = await self.db.execute(
            select(RiskRule).where(
                RiskRule.is_active == True,
                RiskRule.rule_type == "order_risk",
            )
        )
        rules_applied = []
        for rule in rules_result.scalars().all():
            cond = rule.condition_json or {}
            action = cond.get("action", "boost")
            factor = cond.get("factor", "*")
            points = cond.get("points", 0)

            if action == "boost" and (factor == "*" or factor in factors):
                raw_score += points
                rules_applied.append({
                    "rule_code": rule.rule_code,
                    "action": "boost",
                    "factor": factor,
                    "points": points,
                })
            elif action == "downgrade":
                # 降一级：red→yellow, yellow→green
                levels = {"red": "yellow", "yellow": "green", "green": "green"}
                risk_level = levels.get(risk_level, risk_level)
                rules_applied.append({
                    "rule_code": rule.rule_code,
                    "action": "downgrade",
                    "to_level": risk_level,
                })

        final_score = round(min(raw_score / RAW_MAX * 100, 100), 2)
        risk_level = _score_to_level(final_score) if not rules_applied or all(r.get("action") != "downgrade" for r in rules_applied) else risk_level

        return {
            "order_no": order.order_no,
            "factors": factors,
            "raw_score": raw_score,
            "final_score": final_score,
            "risk_level": risk_level,
            "rules_applied": rules_applied,
        }

    # ===== 全量评估 =====

    async def assess_all_orders(self, operator: str = "system") -> dict:
        """评估所有 open/reopened 订单，写回 risk_level/risk_score/risk_factors/risk_assessed_at"""
        result = await self.db.execute(
            select(SaleOrder).where(
                SaleOrder.status.in_(["open", "reopened", "in_progress"])
            )
        )
        orders = result.scalars().all()
        assessed = 0
        red_count = 0
        yellow_count = 0
        blue_count = 0
        green_count = 0
        now = datetime.now()

        updates: list[dict] = []
        for order in orders:
            assessment = await self.assess_order(order)
            new_level = assessment["risk_level"]
            new_score = assessment["final_score"]
            new_factors = assessment["factors"]
            if (
                getattr(order, "risk_level", None) != new_level
                or getattr(order, "risk_score", None) != new_score
                or getattr(order, "risk_factors", None) != new_factors
            ):
                updates.append({
                    "id": order.id,
                    "risk_level": new_level,
                    "risk_score": new_score,
                    "risk_factors": new_factors,
                    "risk_assessed_at": now,
                })
                if new_level == "red":
                    red_count += 1
                elif new_level == "yellow":
                    yellow_count += 1
                elif new_level == "blue":
                    blue_count += 1
                else:
                    green_count += 1

        assessed = len(updates)
        if assessed:
            await self.db.execute(
                update(SaleOrder),
                updates,
            )

        await self.db.flush()

        audit = AuditLog(
            table_name="sale_order",
            record_id=0,
            action="risk_assessment",
            field_name="risk_score",
            old_value="",
            new_value=f"评估{assessed}个订单: 红{red_count}/黄{yellow_count}/蓝{blue_count}/绿{green_count}",
            operator=operator,
        )
        self.db.add(audit)
        await self.db.flush()

        return {
            "assessed": assessed,
            "red_count": red_count,
            "yellow_count": yellow_count,
            "blue_count": blue_count,
            "green_count": green_count,
        }

    # ===== 全量扫描（评估 + 按规则生成 RiskIssue） =====

    # ── 统一的风险规则类型（8种：6评分因子 + 2监控规则） ──
    SCAN_RULE_TYPES = [
        "delivery_delay", "shortage", "eta_delay",
        "process_lag", "quality", "inspection_ng",
        "holiday_risk", "long_lead",
    ]

    async def _next_issue_no(self, issue_type: str) -> str:
        """生成唯一问题编号: {类型缩写}-{YYYYMMDD}-{当日序列号}"""
        prefix = ISSUE_TYPE_PREFIX.get(issue_type, "MN")
        today_str = date.today().strftime("%Y%m%d")
        like_pattern = f"{prefix}-{today_str}-%"

        result = await self.db.execute(
            select(func.max(RiskIssue.issue_no))
            .where(RiskIssue.issue_no.like(like_pattern))
        )
        max_no = result.scalar_one_or_none()
        if max_no:
            seq = int(max_no.split("-")[-1]) + 1
        else:
            seq = 1
        return f"{prefix}-{today_str}-{seq:04d}"

    async def _check_existing_issue(self, **kwargs) -> bool:
        """检查是否已存在同类型同关键字的 open RiskIssue"""
        q = select(RiskIssue).where(RiskIssue.status == "open")
        for k, v in kwargs.items():
            if v is not None:
                q = q.where(getattr(RiskIssue, k) == v)
        result = await self.db.execute(q)
        return result.scalar_one_or_none() is not None

    async def _add_issue(self, new_issues: list, issue_type: str, risk_level: str,
                         description: str, owner: str = "system",
                         order_no: str | None = None, line_no: str | None = None,
                         material_code: str | None = None, po_no: str | None = None):
        """创建 RiskIssue 并加入列表"""
        issue_no = await self._next_issue_no(issue_type)
        issue = RiskIssue(
            issue_no=issue_no,
            issue_type=issue_type,
            risk_level=risk_level,
            order_no=order_no,
            line_no=line_no,
            material_code=material_code,
            po_no=po_no,
            description=description,
            owner=owner,
            status="open",
        )
        self.db.add(issue)
        new_issues.append(issue)

    async def run_full_scan(self, operator: str = "system") -> dict:
        """执行全量风险扫描：先评估订单风险等级，再按8种规则类型生成 RiskIssue"""
        # 1) 评估所有订单
        assess_result = await self.assess_all_orders(operator=operator)

        # 2) 加载所有启用的扫描规则（排除 order_risk 调整规则）
        rules_result = await self.db.execute(
            select(RiskRule).where(
                RiskRule.is_active == True,
                RiskRule.rule_type.in_(self.SCAN_RULE_TYPES),
            )
        )
        rules = rules_result.scalars().all()
        new_issues = []
        today = date.today()

        # ── delivery_delay: 交期延期 ──
        dd_rules = [r for r in rules if r.rule_type == "delivery_delay"]
        if dd_rules:
            order_result = await self.db.execute(
                select(SaleOrder).where(
                    SaleOrder.promised_date != None,
                    SaleOrder.status.in_(["open", "reopened", "in_progress"]),
                )
            )
            for order in order_result.scalars().all():
                if order.delivery_completed_date:
                    # 已发货：实际发货完成日期 vs 承诺交期
                    if order.delivery_completed_date <= order.promised_date:
                        continue
                    delay = (order.delivery_completed_date - order.promised_date).days
                else:
                    # 未发货：今天 vs 承诺交期
                    if order.promised_date >= today:
                        continue
                    delay = (today - order.promised_date).days
                for rule in dd_rules:
                    cond = rule.condition_json or {}
                    threshold = cond.get("delay_days_gt", 0)
                    if delay > threshold:
                        if not await self._check_existing_issue(
                            order_no=order.order_no, issue_type="delivery_delay",
                        ):
                            desc_prefix = "发货延期" if order.delivery_completed_date else "逾期未发货"
                            await self._add_issue(
                                new_issues, "delivery_delay", rule.risk_level,
                                f"{desc_prefix}{delay}天，触发规则{rule.rule_code}",
                                owner="system", order_no=order.order_no,
                            )

        # ── shortage: 欠料风险 ──
        sh_rules = [r for r in rules if r.rule_type == "shortage"]
        if sh_rules:
            md_result = await self.db.execute(
                select(MaterialDemand).where(MaterialDemand.shortage_flag == True)
            )
            for md in md_result.scalars().all():
                for rule in sh_rules:
                    cond = rule.condition_json or {}
                    threshold = cond.get("shortage_qty_gt", 0)
                    if md.shortage_qty and md.shortage_qty > threshold:
                        if not await self._check_existing_issue(
                            order_no=md.order_no, material_code=md.material_code,
                            issue_type="shortage",
                        ):
                            await self._add_issue(
                                new_issues, "shortage", rule.risk_level,
                                f"欠料{md.shortage_qty}，触发规则{rule.rule_code}",
                                owner="system", order_no=md.order_no,
                                line_no=md.line_no, material_code=md.material_code,
                            )

        # ── eta_delay: ETA延期 ──
        eta_rules = [r for r in rules if r.rule_type == "eta_delay"]
        if eta_rules:
            po_result = await self.db.execute(
                select(PurchaseOrder).where(
                    PurchaseOrder.eta != None,
                    PurchaseOrder.po_status.notin_(["received", "cancelled"]),
                )
            )
            for po in po_result.scalars().all():
                if po.original_eta and po.eta and po.eta > po.original_eta:
                    delay_days = (po.eta - po.original_eta).days
                    for rule in eta_rules:
                        cond = rule.condition_json or {}
                        threshold = cond.get("delay_days_gt", 0)
                        if delay_days > threshold:
                            if not await self._check_existing_issue(
                                po_no=po.po_no, issue_type="eta_delay",
                            ):
                                await self._add_issue(
                                    new_issues, "eta_delay", rule.risk_level,
                                    f"ETA延期{delay_days}天，触发规则{rule.rule_code}",
                                    owner=po.owner or "system",
                                    material_code=po.material_code, po_no=po.po_no,
                                )

        # ── process_lag: 工序滞后 ──
        pl_rules = [r for r in rules if r.rule_type == "process_lag"]
        if pl_rules:
            pp_result = await self.db.execute(
                select(ProcessProgress).where(
                    ProcessProgress.status.in_(["blocked", "delayed"]),
                )
            )
            for pp in pp_result.scalars().all():
                for rule in pl_rules:
                    cond = rule.condition_json or {}
                    threshold = cond.get("threshold_days", 0)
                    # Use delay_days field if available, otherwise always trigger for blocked/delayed
                    lag_days = getattr(pp, "delay_days", None) or 0
                    if pp.status == "blocked" or lag_days > threshold:
                        if not await self._check_existing_issue(
                            order_no=pp.order_no, issue_type="process_lag",
                        ):
                            status_text = "卡点" if pp.status == "blocked" else f"滞后{lag_days}天"
                            await self._add_issue(
                                new_issues, "process_lag", rule.risk_level,
                                f"工序{pp.process_type or ''}{status_text}，触发规则{rule.rule_code}",
                                owner="system", order_no=pp.order_no,
                            )

        # ── quality: 品质异常 ──
        q_rules = [r for r in rules if r.rule_type == "quality"]
        if q_rules:
            qi_result = await self.db.execute(
                select(QualityIssue).where(
                    QualityIssue.status.in_(["open", "processing"]),
                    QualityIssue.is_deleted == False,
                )
            )
            qi_items = qi_result.scalars().all()
            # Group by order_no
            by_order: dict[str, list] = defaultdict(list)
            for qi in qi_items:
                if qi.order_no:
                    by_order[qi.order_no].append(qi)
            for order_no, items in by_order.items():
                for rule in q_rules:
                    cond = rule.condition_json or {}
                    threshold = cond.get("open_count_gt", 0)
                    if len(items) > threshold:
                        if not await self._check_existing_issue(
                            order_no=order_no, issue_type="quality",
                        ):
                            await self._add_issue(
                                new_issues, "quality", rule.risk_level,
                                f"未关闭品质异常{len(items)}条，触发规则{rule.rule_code}",
                                owner=items[0].responsible_person or "system",
                                order_no=order_no,
                            )

        # ── inspection_ng: 客检NG ──
        ing_rules = [r for r in rules if r.rule_type == "inspection_ng"]
        if ing_rules:
            order_result = await self.db.execute(
                select(SaleOrder).where(
                    SaleOrder.inspection_result != None,
                    SaleOrder.status.in_(["open", "reopened", "in_progress"]),
                )
            )
            for order in order_result.scalars().all():
                result_val = (order.inspection_result or "").strip().upper()
                if result_val in ("NG", "FAIL", "不合格"):
                    if not await self._check_existing_issue(
                        order_no=order.order_no, issue_type="inspection_ng",
                    ):
                        await self._add_issue(
                            new_issues, "inspection_ng", ing_rules[0].risk_level,
                            f"客检结果{order.inspection_result}，触发规则{ing_rules[0].rule_code}",
                            owner="system", order_no=order.order_no,
                        )

        # ── holiday_risk: 假期风险 ──
        hr_rules = [r for r in rules if r.rule_type == "holiday_risk"]
        if hr_rules:
            current_month = today.month
            for rule in hr_rules:
                cond = rule.condition_json or {}
                holiday_months = cond.get("holiday_months", [])
                impact_days = cond.get("threshold_days", 0)
                if current_month in holiday_months:
                    # Find POs with eta in the holiday period
                    po_result = await self.db.execute(
                        select(PurchaseOrder).where(
                            PurchaseOrder.eta != None,
                            PurchaseOrder.po_status.notin_(["received", "cancelled", "closed"]),
                        )
                    )
                    for po in po_result.scalars().all():
                        if po.eta.month in holiday_months:
                            if not await self._check_existing_issue(
                                po_no=po.po_no, issue_type="holiday_risk",
                            ):
                                await self._add_issue(
                                    new_issues, "holiday_risk", rule.risk_level,
                                    f"假期期间ETA（{po.eta}），预计影响{impact_days}天，触发规则{rule.rule_code}",
                                    owner=po.owner or "system",
                                    material_code=po.material_code, po_no=po.po_no,
                                )

        # ── long_lead: 长周期物料 ──
        ll_rules = [r for r in rules if r.rule_type == "long_lead"]
        if ll_rules:
            # Find POs with long lead times (eta - created_at as proxy)
            po_result = await self.db.execute(
                select(PurchaseOrder).where(
                    PurchaseOrder.eta != None,
                    PurchaseOrder.po_status.notin_(["received", "cancelled", "closed"]),
                )
            )
            seen_materials: set[str] = set()
            for po in po_result.scalars().all():
                if not po.material_code or po.material_code in seen_materials:
                    continue
                # Estimate lead time from original_eta - created_at (or eta if no original)
                ref_date = po.original_eta or po.eta
                created = po.created_at.date() if po.created_at else None
                if not created:
                    continue
                lead_days = (ref_date - created).days if ref_date > created else 0
                for rule in ll_rules:
                    cond = rule.condition_json or {}
                    threshold = cond.get("threshold_days", 0)
                    if lead_days > threshold:
                        if not await self._check_existing_issue(
                            material_code=po.material_code, issue_type="long_lead",
                        ):
                            seen_materials.add(po.material_code)
                            await self._add_issue(
                                new_issues, "long_lead", rule.risk_level,
                                f"交期{lead_days}天超过阈值{threshold}天，触发规则{rule.rule_code}",
                                owner=po.owner or "system",
                                material_code=po.material_code, po_no=po.po_no,
                            )

        await self.db.flush()

        audit = AuditLog(
            table_name="risk_issue",
            record_id=0,
            action="scan",
            field_name="risk_scan",
            old_value="",
            new_value=f"评估{assess_result['assessed']}个订单 + 新增{len(new_issues)}条风险问题",
            operator=operator,
        )
        self.db.add(audit)
        await self.db.flush()

        return {
            "scanned": True,
            "assessed": assess_result["assessed"],
            "red_count": assess_result["red_count"],
            "yellow_count": assess_result["yellow_count"],
            "blue_count": assess_result["blue_count"],
            "green_count": assess_result["green_count"],
            "new_issues_count": len(new_issues),
            "rules_applied": len(rules),
        }
