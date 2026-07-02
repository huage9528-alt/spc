from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from app.models.production.product_process_capacity import resolve_capacity_upph
from app.services.basicdata.erp_sync_service import ERPSyncService
from app.services.production.schedule_simulation_service import ScheduleSimulationService
from app.services.production.upph_formula_config_service import UpphFormulaConfigService

ASSEMBLY_WORKSHOP_NAME = "装配车间"
ASSEMBLY_PROCESS_TYPES = ("组装", "组装前加工")
PACKAGING_PROCESS_TYPES = ("包装", "包装前加工")
ROLLING_GAP_DAYS = 1


@dataclass
class RollingStagePlan:
    schedule_bucket: str
    schedule_bucket_label: str
    quantity: float
    upph: float
    daily_work_hours: float
    daily_capacity_qty: float
    total_hours: float
    days_needed: int
    start_date: date
    end_date: date
    target_ready_date: date
    warning: str = ""
    work_hour_summary: str = ""
    plan_date: Optional[date] = None
    lag_days: int = 0
    capacity_load_status: Optional[str] = None
    capacity_load_status_label: Optional[str] = None
    sunday_rest_allowed: Optional[bool] = None
    needs_sunday_work: bool = False
    needs_move_earlier: bool = False
    move_earlier_days: int = 0
    available_production_days: Optional[int] = None
    required_daily_hours: Optional[float] = None


class AssemblyRollScheduleService:
    def __init__(self, db):
        self.db = db
        self.erp_service = ERPSyncService(db)
        self.formula_service = UpphFormulaConfigService(db)

    @staticmethod
    def _normalize_decimal(value: Any) -> Decimal:
        if value in (None, ""):
            return Decimal("0")
        if isinstance(value, Decimal):
            return value
        try:
            return Decimal(str(value).strip())
        except (InvalidOperation, ValueError, TypeError, AttributeError):
            return Decimal("0")

    @staticmethod
    def _normalize_float(value: Any) -> float:
        return float(AssemblyRollScheduleService._normalize_decimal(value))

    @staticmethod
    def _normalize_bom_code_for_match(bom_code: Optional[str]) -> Optional[str]:
        normalized = str(bom_code or "").strip()
        if not normalized:
            return None
        upper_value = normalized.upper()
        for prefix in ("Y-", "P-"):
            if upper_value.startswith(prefix) and len(normalized) > len(prefix):
                stripped = normalized[len(prefix):].strip()
                if stripped:
                    return stripped
        return normalized

    @classmethod
    def _build_bom_match_candidates(cls, bom_code: Optional[str]) -> list[str]:
        normalized = str(bom_code or "").strip()
        if not normalized:
            return []
        candidates = [normalized]
        stripped = cls._normalize_bom_code_for_match(normalized)
        if stripped and stripped not in candidates:
            candidates.append(stripped)
        return candidates

    async def get_stage_pricing_bulk(self, bom_codes: list[str]) -> dict[str, dict[str, Any]]:
        original_codes = [str(item).strip() for item in bom_codes if str(item).strip()]
        if not original_codes:
            return {}

        candidate_rows: list[tuple[str, str]] = []
        seen_pairs: set[tuple[str, str]] = set()
        for code in dict.fromkeys(original_codes):
            for match_code in self._build_bom_match_candidates(code):
                pair = (code, match_code)
                if pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                candidate_rows.append(pair)

        params: dict[str, str] = {}
        values_sql = "\n                UNION ALL\n                ".join(
            [
                (
                    f"SELECT CAST(:original_bom_{index} AS VARCHAR(64)) AS original_bom_code, "
                    f"CAST(:match_bom_{index} AS VARCHAR(64)) AS match_bom_code"
                )
                for index in range(len(candidate_rows))
            ]
        )
        for index, (original_code, match_code) in enumerate(candidate_rows):
            params[f"original_bom_{index}"] = original_code
            params[f"match_bom_{index}"] = match_code

        await self.erp_service._connect_erp()
        rows = await self.erp_service._execute_erp_sql(
            f"""
            WITH input_boms AS (
                {values_sql}
            ),
            latest_main AS (
                SELECT
                    i.original_bom_code AS bom_code,
                    a.id AS main_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY i.original_bom_code
                        ORDER BY
                            CASE WHEN i.match_bom_code = i.original_bom_code THEN 0 ELSE 1 END,
                            a.id DESC
                    ) AS rn
                FROM input_boms i
                JOIN FWsv.ecology.dbo.formtable_main_51 a
                    ON LTRIM(RTRIM(CAST(a.bombm AS VARCHAR(64)))) = i.match_bom_code
                WHERE a.sfyx = 0
            )
            SELECT
                m.bom_code,
                CAST(m.main_id AS VARCHAR(64)) AS main_id,
                CASE
                    WHEN b.gx IN (0, 2) THEN 'assembly'
                    WHEN b.gx IN (1, 7) THEN 'packaging'
                    ELSE 'others'
                END AS stage_bucket,
                SUM(CAST(ISNULL(b.dj, 0) AS DECIMAL(15, 4))) AS stage_price_total
            FROM latest_main m
            JOIN FWsv.ecology.dbo.formtable_main_51_dt1 b ON m.main_id = b.mainid
            WHERE m.rn = 1
            GROUP BY
                m.bom_code,
                m.main_id,
                CASE
                    WHEN b.gx IN (0, 2) THEN 'assembly'
                    WHEN b.gx IN (1, 7) THEN 'packaging'
                    ELSE 'others'
                END
            """,
            params,
        )

        pricing_map: dict[str, dict[str, Any]] = {
            code: {
                "bom_code": code,
                "resolved": False,
                "stage_price_totals": {"assembly": 0.0, "packaging": 0.0},
                "selected_main_id": None,
            }
            for code in dict.fromkeys(original_codes)
        }
        for row in rows:
            bom_code = str(row.get("bom_code") or "").strip()
            if not bom_code:
                continue
            payload = pricing_map.setdefault(
                bom_code,
                {
                    "bom_code": bom_code,
                    "resolved": False,
                    "stage_price_totals": {"assembly": 0.0, "packaging": 0.0},
                    "selected_main_id": None,
                },
            )
            stage_bucket = str(row.get("stage_bucket") or "")
            if stage_bucket in payload["stage_price_totals"]:
                payload["stage_price_totals"][stage_bucket] = round(self._normalize_float(row.get("stage_price_total")), 4)
            payload["selected_main_id"] = str(row.get("main_id") or "") or payload.get("selected_main_id")
            payload["resolved"] = bool(payload["selected_main_id"])
        return pricing_map

    async def get_stage_pricing(self, bom_code: Optional[str]) -> dict[str, Any]:
        if not bom_code:
            return {
                "bom_code": bom_code,
                "resolved": False,
                "stage_price_totals": {"assembly": 0.0, "packaging": 0.0},
                "selected_main_id": None,
            }
        pricing_map = await self.get_stage_pricing_bulk([bom_code])
        return pricing_map.get(str(bom_code).strip(), {
            "bom_code": bom_code,
            "resolved": False,
            "stage_price_totals": {"assembly": 0.0, "packaging": 0.0},
            "selected_main_id": None,
        })

    async def get_stage_rules_bulk(self, bom_codes: list[str]) -> dict[str, dict[str, Any]]:
        pricing_map = await self.get_stage_pricing_bulk(bom_codes)
        config_map = await self.formula_service.get_active_config_map()
        result: dict[str, dict[str, Any]] = {}
        for bom_code, pricing in pricing_map.items():
            stage_price_totals = dict(pricing.get("stage_price_totals") or {})
            stage_rules: dict[str, dict[str, Any]] = {}
            matched_buckets: list[str] = []
            for bucket, process_type in (("assembly", "组装"), ("packaging", "包装")):
                price_total = float(stage_price_totals.get(bucket) or 0)
                manpower, hour_price = await self.formula_service.resolve_formula_inputs(
                    ASSEMBLY_WORKSHOP_NAME,
                    process_type,
                    config_map,
                )
                upph_payload = resolve_capacity_upph(
                    workshop_name=ASSEMBLY_WORKSHOP_NAME,
                    process_type=process_type,
                    gjje=price_total,
                    manpower=manpower,
                    hour_price=hour_price,
                )
                effective_upph = float(upph_payload.get("effective_upph") or 0)
                if price_total > 0 and effective_upph > 0:
                    matched_buckets.append(bucket)
                stage_rules[bucket] = {
                    "price_total": round(price_total, 4),
                    "upph": round(effective_upph, 2),
                    "manpower": manpower,
                    "hour_price": hour_price,
                    "process_type": process_type,
                }

            schedule_bucket = "pending"
            if set(matched_buckets) == {"assembly", "packaging"}:
                schedule_bucket = "mixed"
            elif matched_buckets == ["assembly"]:
                schedule_bucket = "assembly"
            elif matched_buckets == ["packaging"]:
                schedule_bucket = "packaging"

            result[bom_code] = {
                **pricing,
                "matched_buckets": matched_buckets,
                "schedule_bucket": schedule_bucket,
                "total_upph": round(sum(float(stage_rules[b]["upph"] or 0) for b in ("assembly", "packaging")), 2),
                "split_rule_ready": schedule_bucket in {"assembly", "packaging", "mixed"},
                "stage_rules": stage_rules,
            }
        return result

    async def get_stage_rules(self, bom_code: Optional[str]) -> dict[str, Any]:
        if not bom_code:
            return {
                "bom_code": bom_code,
                "resolved": False,
                "stage_price_totals": {"assembly": 0.0, "packaging": 0.0},
                "selected_main_id": None,
                "matched_buckets": [],
                "schedule_bucket": "pending",
                "total_upph": 0.0,
                "split_rule_ready": False,
                "stage_rules": {},
            }
        rules_map = await self.get_stage_rules_bulk([bom_code])
        return rules_map.get(bom_code, {
            "bom_code": bom_code,
            "resolved": False,
            "stage_price_totals": {"assembly": 0.0, "packaging": 0.0},
            "selected_main_id": None,
            "matched_buckets": [],
            "schedule_bucket": "pending",
            "total_upph": 0.0,
            "split_rule_ready": False,
            "stage_rules": {},
        })

    @staticmethod
    def _simulate_from_assembly_start(
        *,
        quantity: float,
        assembly_daily_capacity_qty: float,
        packaging_daily_capacity_qty: float,
        assembly_start_date: date,
        assembly_include_sunday: bool,
        packaging_include_sunday: bool,
        lag_days: int = ROLLING_GAP_DAYS,
    ) -> dict[str, Any]:
        assembly_completed = 0.0
        packaging_completed = 0.0
        eligible_inventory = 0.0
        current_date = assembly_start_date
        assembly_daily_release: dict[date, float] = {}
        assembly_first_date: Optional[date] = None
        assembly_end_date = assembly_start_date
        packaging_start_date: Optional[date] = None
        packaging_end_date: Optional[date] = None

        for _ in range(730):
            assembly_today = 0.0
            if (
                assembly_completed + 0.01 < quantity
                and ScheduleSimulationService.is_production_day(current_date, assembly_include_sunday)
            ):
                assembly_today = min(assembly_daily_capacity_qty, quantity - assembly_completed)
                assembly_completed = round(assembly_completed + assembly_today, 4)
                if assembly_first_date is None and assembly_today > 0:
                    assembly_first_date = current_date
                assembly_end_date = current_date
            assembly_daily_release[current_date] = assembly_today

            release_date = current_date - timedelta(days=lag_days)
            eligible_inventory = round(
                eligible_inventory + float(assembly_daily_release.get(release_date, 0.0)),
                4,
            )

            packaging_today = 0.0
            if (
                eligible_inventory > 0
                and packaging_completed + 0.01 < quantity
                and ScheduleSimulationService.is_production_day(current_date, packaging_include_sunday)
            ):
                packaging_today = min(packaging_daily_capacity_qty, eligible_inventory, quantity - packaging_completed)
                packaging_completed = round(packaging_completed + packaging_today, 4)
                eligible_inventory = round(eligible_inventory - packaging_today, 4)
                if packaging_start_date is None and packaging_today > 0:
                    packaging_start_date = current_date
                packaging_end_date = current_date

            if assembly_completed + 0.01 >= quantity and packaging_completed + 0.01 >= quantity:
                break
            current_date += timedelta(days=1)
        else:
            raise ValueError("滚动排产模拟超出 730 天，请检查 UPPH 配置")

        resolved_assembly_start = assembly_first_date or ScheduleSimulationService.get_next_production_day(
            assembly_start_date,
            assembly_include_sunday,
        )
        resolved_packaging_start = packaging_start_date or ScheduleSimulationService.get_next_production_day(
            resolved_assembly_start + timedelta(days=lag_days),
            packaging_include_sunday,
        )
        # #region debug-point D:assembly-simulation-result
        try:
            import json
            import urllib.request

            _p = '.dbg/assembly-duration-overrun.env'
            _u, _s = 'http://127.0.0.1:7777/event', 'assembly-duration-overrun'
            try:
                with open(_p, encoding='utf-8') as f:
                    c = f.read()
                _u = next((l.split('=', 1)[1] for l in c.split('\n') if l.startswith('DEBUG_SERVER_URL=')), _u)
                _s = next((l.split('=', 1)[1] for l in c.split('\n') if l.startswith('DEBUG_SESSION_ID=')), _s)
            except Exception:
                pass
            urllib.request.urlopen(
                urllib.request.Request(
                    _u,
                    data=json.dumps({
                        "sessionId": _s,
                        "runId": "pre-fix",
                        "hypothesisId": "D",
                        "location": "assembly_roll_schedule_service.py:_simulate_from_assembly_start",
                        "msg": "[DEBUG] assembly simulation result",
                        "data": {
                            "quantity": quantity,
                            "assembly_daily_capacity_qty": assembly_daily_capacity_qty,
                            "packaging_daily_capacity_qty": packaging_daily_capacity_qty,
                            "assembly_include_sunday": assembly_include_sunday,
                            "packaging_include_sunday": packaging_include_sunday,
                            "assembly_start_date": str(resolved_assembly_start),
                            "assembly_end_date": str(assembly_end_date),
                            "assembly_days_needed": ScheduleSimulationService.count_production_days(
                                resolved_assembly_start, assembly_end_date, include_sunday=assembly_include_sunday
                            ),
                            "packaging_start_date": str(resolved_packaging_start),
                            "packaging_end_date": str(packaging_end_date or assembly_end_date),
                            "packaging_days_needed": ScheduleSimulationService.count_production_days(
                                resolved_packaging_start,
                                packaging_end_date or assembly_end_date,
                                include_sunday=packaging_include_sunday,
                            ),
                        },
                        "ts": __import__('time').time_ns() // 1_000_000,
                    }).encode(),
                    headers={"Content-Type": "application/json"},
                ),
                timeout=0.3,
            ).read()
        except Exception:
            pass
        # #endregion
        return {
            "assembly_start_date": resolved_assembly_start,
            "assembly_end_date": assembly_end_date,
            "packaging_start_date": resolved_packaging_start,
            "packaging_end_date": packaging_end_date or assembly_end_date,
            "assembly_days_needed": ScheduleSimulationService.count_production_days(
                resolved_assembly_start,
                assembly_end_date,
                include_sunday=assembly_include_sunday,
            ),
            "packaging_days_needed": ScheduleSimulationService.count_production_days(
                resolved_packaging_start,
                packaging_end_date or assembly_end_date,
                include_sunday=packaging_include_sunday,
            ),
        }

    def build_mixed_stage_plans(
        self,
        *,
        quantity: float,
        promised_date: date,
        assembly_upph: float,
        packaging_upph: float,
        assembly_daily_hours: float,
        packaging_daily_hours: float,
        target_ready_date: date,
        ready_offset_days: int,
        assembly_workhour_plan: Optional[dict[str, Any]] = None,
        packaging_workhour_plan: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        assembly_daily_capacity_qty = round(assembly_upph * assembly_daily_hours, 4)
        packaging_daily_capacity_qty = round(packaging_upph * packaging_daily_hours, 4)
        if assembly_daily_capacity_qty <= 0 or packaging_daily_capacity_qty <= 0:
            raise ValueError("组装或包装日产能无效，无法滚动排产")

        assembly_workhour_plan = assembly_workhour_plan or {}
        packaging_workhour_plan = packaging_workhour_plan or {}
        assembly_include_sunday = bool(assembly_workhour_plan.get("needs_sunday_work"))
        packaging_include_sunday = bool(packaging_workhour_plan.get("needs_sunday_work"))
        # #region debug-point B:mixed-stage-input
        try:
            import json
            import urllib.request

            _p = '.dbg/assembly-duration-overrun.env'
            _u, _s = 'http://127.0.0.1:7777/event', 'assembly-duration-overrun'
            try:
                with open(_p, encoding='utf-8') as f:
                    c = f.read()
                _u = next((l.split('=', 1)[1] for l in c.split('\n') if l.startswith('DEBUG_SERVER_URL=')), _u)
                _s = next((l.split('=', 1)[1] for l in c.split('\n') if l.startswith('DEBUG_SESSION_ID=')), _s)
            except Exception:
                pass
            urllib.request.urlopen(
                urllib.request.Request(
                    _u,
                    data=json.dumps({
                        "sessionId": _s,
                        "runId": "pre-fix",
                        "hypothesisId": "B",
                        "location": "assembly_roll_schedule_service.py:build_mixed_stage_plans",
                        "msg": "[DEBUG] mixed stage input",
                        "data": {
                            "quantity": quantity,
                            "promised_date": str(promised_date),
                            "target_ready_date": str(target_ready_date),
                            "assembly_upph": assembly_upph,
                            "packaging_upph": packaging_upph,
                            "assembly_daily_hours": assembly_daily_hours,
                            "packaging_daily_hours": packaging_daily_hours,
                            "assembly_daily_capacity_qty": assembly_daily_capacity_qty,
                            "packaging_daily_capacity_qty": packaging_daily_capacity_qty,
                            "assembly_workhour_plan": {
                                "recommended_daily_hours": assembly_workhour_plan.get("recommended_daily_hours"),
                                "days_needed": assembly_workhour_plan.get("days_needed"),
                                "suggested_start_date": str(assembly_workhour_plan.get("suggested_start_date") or ""),
                                "suggested_end_date": str(assembly_workhour_plan.get("suggested_end_date") or ""),
                                "capacity_load_status": assembly_workhour_plan.get("capacity_load_status"),
                            },
                            "packaging_workhour_plan": {
                                "recommended_daily_hours": packaging_workhour_plan.get("recommended_daily_hours"),
                                "days_needed": packaging_workhour_plan.get("days_needed"),
                                "suggested_start_date": str(packaging_workhour_plan.get("suggested_start_date") or ""),
                                "suggested_end_date": str(packaging_workhour_plan.get("suggested_end_date") or ""),
                                "capacity_load_status": packaging_workhour_plan.get("capacity_load_status"),
                            },
                        },
                        "ts": __import__('time').time_ns() // 1_000_000,
                    }).encode(),
                    headers={"Content-Type": "application/json"},
                ),
                timeout=0.3,
            ).read()
        except Exception:
            pass
        # #endregion

        latest_feasible_start: Optional[date] = None
        latest_feasible_simulation: Optional[dict[str, Any]] = None
        for offset in range(0, 730):
            candidate_start = target_ready_date - timedelta(days=offset)
            simulation = self._simulate_from_assembly_start(
                quantity=quantity,
                assembly_daily_capacity_qty=assembly_daily_capacity_qty,
                packaging_daily_capacity_qty=packaging_daily_capacity_qty,
                assembly_start_date=candidate_start,
                assembly_include_sunday=assembly_include_sunday,
                packaging_include_sunday=packaging_include_sunday,
                lag_days=ROLLING_GAP_DAYS,
            )
            if simulation["packaging_end_date"] <= target_ready_date:
                latest_feasible_start = candidate_start
                latest_feasible_simulation = simulation
                break
        if latest_feasible_start is None or latest_feasible_simulation is None:
            raise ValueError("未找到满足交期的组装/包装滚动排产窗口")

        today = date.today()
        warning = ""
        actual_start = latest_feasible_start
        actual_simulation = latest_feasible_simulation
        if actual_start < today:
            actual_start = today
            actual_simulation = self._simulate_from_assembly_start(
                quantity=quantity,
                assembly_daily_capacity_qty=assembly_daily_capacity_qty,
                packaging_daily_capacity_qty=packaging_daily_capacity_qty,
                assembly_start_date=actual_start,
                assembly_include_sunday=assembly_include_sunday,
                packaging_include_sunday=packaging_include_sunday,
                lag_days=ROLLING_GAP_DAYS,
            )
            if actual_simulation["packaging_end_date"] > target_ready_date:
                warning = (
                    f"【延期预警】按组装滚动释放、包装次日承接计算，若从 {actual_start} 开始，"
                    f"预计包装完成日为 {actual_simulation['packaging_end_date']}，晚于备货目标日({target_ready_date})，客户交期({promised_date})！"
                )

        total_assembly_hours = round(quantity / assembly_upph, 2)
        total_packaging_hours = round(quantity / packaging_upph, 2)
        assembly_plan = RollingStagePlan(
            schedule_bucket="assembly",
            schedule_bucket_label="装配-组装",
            quantity=quantity,
            upph=round(assembly_upph, 2),
            daily_work_hours=round(assembly_daily_hours, 2),
            daily_capacity_qty=assembly_daily_capacity_qty,
            total_hours=total_assembly_hours,
            days_needed=actual_simulation["assembly_days_needed"],
            start_date=actual_simulation["assembly_start_date"],
            end_date=actual_simulation["assembly_end_date"],
            target_ready_date=target_ready_date,
            warning=warning,
            work_hour_summary=(
                f"组装单价汇总换算 UPPH {assembly_upph:.2f}；"
                f"按 {assembly_daily_hours:.2f} 小时/天，日产约 {assembly_daily_capacity_qty:.2f}；"
                f"{assembly_workhour_plan.get('capacity_load_status_label') or '正常'}；"
                f"{'启用周日生产' if assembly_include_sunday else '周日可休'}；"
                f"连续组装 {actual_simulation['assembly_days_needed']} 个生产日。"
            ),
            plan_date=actual_simulation["assembly_start_date"],
            capacity_load_status=assembly_workhour_plan.get("capacity_load_status"),
            capacity_load_status_label=assembly_workhour_plan.get("capacity_load_status_label"),
            sunday_rest_allowed=assembly_workhour_plan.get("sunday_rest_allowed"),
            needs_sunday_work=assembly_include_sunday,
            needs_move_earlier=bool(assembly_workhour_plan.get("needs_move_earlier")),
            move_earlier_days=int(assembly_workhour_plan.get("move_earlier_days") or 0),
            available_production_days=assembly_workhour_plan.get("available_production_days"),
            required_daily_hours=assembly_workhour_plan.get("required_daily_hours"),
        )
        packaging_plan = RollingStagePlan(
            schedule_bucket="packaging",
            schedule_bucket_label="装配-包装",
            quantity=quantity,
            upph=round(packaging_upph, 2),
            daily_work_hours=round(packaging_daily_hours, 2),
            daily_capacity_qty=packaging_daily_capacity_qty,
            total_hours=total_packaging_hours,
            days_needed=actual_simulation["packaging_days_needed"],
            start_date=actual_simulation["packaging_start_date"],
            end_date=actual_simulation["packaging_end_date"],
            target_ready_date=target_ready_date,
            warning=warning,
            work_hour_summary=(
                f"包装单价汇总换算 UPPH {packaging_upph:.2f}；"
                f"按 {packaging_daily_hours:.2f} 小时/天，日产约 {packaging_daily_capacity_qty:.2f}；"
                f"{packaging_workhour_plan.get('capacity_load_status_label') or '正常'}；"
                f"{'启用周日生产' if packaging_include_sunday else '周日可休'}；"
                f"承接组装前一日释放量，连续包装 {actual_simulation['packaging_days_needed']} 个生产日。"
            ),
            plan_date=actual_simulation["packaging_start_date"],
            lag_days=ROLLING_GAP_DAYS,
            capacity_load_status=packaging_workhour_plan.get("capacity_load_status"),
            capacity_load_status_label=packaging_workhour_plan.get("capacity_load_status_label"),
            sunday_rest_allowed=packaging_workhour_plan.get("sunday_rest_allowed"),
            needs_sunday_work=packaging_include_sunday,
            needs_move_earlier=bool(packaging_workhour_plan.get("needs_move_earlier")),
            move_earlier_days=int(packaging_workhour_plan.get("move_earlier_days") or 0),
            available_production_days=packaging_workhour_plan.get("available_production_days"),
            required_daily_hours=packaging_workhour_plan.get("required_daily_hours"),
        )
        # #region debug-point C:mixed-stage-output
        try:
            import json
            import urllib.request

            _p = '.dbg/assembly-duration-overrun.env'
            _u, _s = 'http://127.0.0.1:7777/event', 'assembly-duration-overrun'
            try:
                with open(_p, encoding='utf-8') as f:
                    c = f.read()
                _u = next((l.split('=', 1)[1] for l in c.split('\n') if l.startswith('DEBUG_SERVER_URL=')), _u)
                _s = next((l.split('=', 1)[1] for l in c.split('\n') if l.startswith('DEBUG_SESSION_ID=')), _s)
            except Exception:
                pass
            urllib.request.urlopen(
                urllib.request.Request(
                    _u,
                    data=json.dumps({
                        "sessionId": _s,
                        "runId": "pre-fix",
                        "hypothesisId": "C",
                        "location": "assembly_roll_schedule_service.py:build_mixed_stage_plans",
                        "msg": "[DEBUG] mixed stage output",
                        "data": {
                            "assembly": {
                                "daily_work_hours": assembly_plan.daily_work_hours,
                                "total_hours": assembly_plan.total_hours,
                                "days_needed": assembly_plan.days_needed,
                                "start_date": str(assembly_plan.start_date),
                                "end_date": str(assembly_plan.end_date),
                                "capacity_load_status": assembly_plan.capacity_load_status,
                            },
                            "packaging": {
                                "daily_work_hours": packaging_plan.daily_work_hours,
                                "total_hours": packaging_plan.total_hours,
                                "days_needed": packaging_plan.days_needed,
                                "start_date": str(packaging_plan.start_date),
                                "end_date": str(packaging_plan.end_date),
                                "capacity_load_status": packaging_plan.capacity_load_status,
                            },
                            "warning": warning,
                        },
                        "ts": __import__('time').time_ns() // 1_000_000,
                    }).encode(),
                    headers={"Content-Type": "application/json"},
                ),
                timeout=0.3,
            ).read()
        except Exception:
            pass
        # #endregion
        return {
            "target_ready_date": target_ready_date,
            "ready_offset_days": ready_offset_days,
            "warning": warning,
            "assembly_plan": assembly_plan,
            "packaging_plan": packaging_plan,
            "packaging_start_date": actual_simulation["packaging_start_date"],
            "packaging_end_date": actual_simulation["packaging_end_date"],
            "assembly_start_date": actual_simulation["assembly_start_date"],
            "assembly_end_date": actual_simulation["assembly_end_date"],
        }
