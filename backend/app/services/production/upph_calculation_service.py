
from typing import Optional, List, Tuple, Any
from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.production.product_process_capacity import (
    LEAN_WORKSHOP_NAME,
    ProductProcessCapacity,
    parse_capacity_metadata,
)
from app.core.config import get_settings
from app.services.production.assembly_roll_schedule_service import AssemblyRollScheduleService

ASSEMBLY_WORKSHOP_NAME = "装配车间"
ASSEMBLY_PROCESS_TYPES = {"组装", "组装前加工"}
PACKAGING_PROCESS_TYPES = {"包装", "包装前加工"}


class UpphCalculationService:
    """UPPH 计算服务 - 统一处理 UPPH 的获取、匹配、计算"""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.settings = get_settings()

    @staticmethod
    def normalize_bom_code_for_match(bom_code: Optional[str]) -> Optional[str]:
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
    def build_bom_match_candidates(cls, bom_code: Optional[str]) -> list[str]:
        normalized = str(bom_code or "").strip()
        if not normalized:
            return []
        candidates = [normalized]
        normalized_match = cls.normalize_bom_code_for_match(normalized)
        if normalized_match and normalized_match not in candidates:
            candidates.append(normalized_match)
        return candidates

    async def get_matched_capacities(
        self,
        product_code: Optional[str] = None,
        bom_code: Optional[str] = None,
    ) -> List[ProductProcessCapacity]:
        """
        根据配置获取匹配的 UPPH 记录
        返回按 last_sync_time 倒序排列的列表（最新优先）
        """
        # Older/local env files may not define UPPH_MATCH_MODE yet.
        # Fall back to product_code matching to keep schedule APIs available.
        match_mode = getattr(self.settings, "UPPH_MATCH_MODE", "product_code")
        conditions = [ProductProcessCapacity.is_active == True]
        order_by_clauses = []

        if match_mode == "bom_code" and bom_code:
            # 按 BOM 编码匹配
            bom_candidates = self.build_bom_match_candidates(bom_code)
            if not bom_candidates:
                return []
            if len(bom_candidates) == 1:
                conditions.append(ProductProcessCapacity.bom_code == bom_candidates[0])
            else:
                conditions.append(ProductProcessCapacity.bom_code.in_(bom_candidates))
            order_by_clauses.append(
                case((ProductProcessCapacity.bom_code == bom_candidates[0], 0), else_=1).asc()
            )
        elif product_code:
            # 默认按产品编码匹配
            conditions.append(ProductProcessCapacity.product_code == product_code)
        else:
            # 没有匹配条件
            return []

        result = await self.db.execute(
            select(ProductProcessCapacity)
            .where(*conditions)
            .order_by(
                *order_by_clauses,
                # 优先选择有备注的，再按 last_sync_time 倒序（最新优先）
                ProductProcessCapacity.remark.is_(None),
                ProductProcessCapacity.last_sync_time.desc().nullslast(),
                ProductProcessCapacity.id.desc(),
            )
        )
        return list(result.scalars().all())

    def _accumulate_total_upph(
        self,
        capacities: List[ProductProcessCapacity],
    ) -> Tuple[Optional[float], List[ProductProcessCapacity]]:
        total_upph = 0.0
        used_capacities: List[ProductProcessCapacity] = []
        seen_lean_main_ids: set[str] = set()

        for capacity in capacities:
            metadata = parse_capacity_metadata(capacity.remark)
            if not metadata.get("is_schedulable", True):
                continue
            if metadata.get("oa_workshop_name") == LEAN_WORKSHOP_NAME:
                lean_main_id = metadata.get("oa_main_id")
                if lean_main_id:
                    if lean_main_id in seen_lean_main_ids:
                        continue
                    seen_lean_main_ids.add(lean_main_id)
            if capacity.upph and float(capacity.upph) > 0:
                total_upph += float(capacity.upph)
                used_capacities.append(capacity)

        return (total_upph if total_upph > 0 else None, used_capacities)

    @staticmethod
    def _resolve_schedule_bucket(
        workshop_name: Optional[str],
        process_type: Optional[str],
    ) -> Optional[str]:
        if workshop_name == LEAN_WORKSHOP_NAME:
            return "lean"
        if workshop_name == ASSEMBLY_WORKSHOP_NAME and process_type in ASSEMBLY_PROCESS_TYPES:
            return "assembly"
        if workshop_name == ASSEMBLY_WORKSHOP_NAME and process_type in PACKAGING_PROCESS_TYPES:
            return "packaging"
        return None

    def summarize_schedule_context_from_capacities(
        self,
        capacities: List[ProductProcessCapacity],
    ) -> dict[str, Any]:
        matched_buckets: set[str] = set()
        has_schedulable_capacity = False
        workshop_names: set[str] = set()
        schedulable_workshop_names: set[str] = set()
        non_schedulable_reasons: set[str] = set()
        lean_main_ids: set[str] = set()
        positive_upph_count = 0

        for capacity in capacities:
            metadata = parse_capacity_metadata(capacity.remark)
            workshop_name = metadata.get("oa_workshop_name")
            if workshop_name:
                workshop_names.add(workshop_name)
            if capacity.upph and float(capacity.upph) > 0:
                positive_upph_count += 1
            if not metadata.get("is_schedulable", True):
                if metadata.get("exclude_reason"):
                    non_schedulable_reasons.add(metadata["exclude_reason"])
                continue
            has_schedulable_capacity = True
            if workshop_name:
                schedulable_workshop_names.add(workshop_name)
            if workshop_name == LEAN_WORKSHOP_NAME and metadata.get("oa_main_id"):
                lean_main_ids.add(metadata["oa_main_id"])
            bucket = self._resolve_schedule_bucket(
                workshop_name,
                capacity.process_type,
            )
            if bucket:
                matched_buckets.add(bucket)

        total_upph, used_capacities = self._accumulate_total_upph(capacities)
        if "lean" in matched_buckets and len(matched_buckets) == 1:
            schedule_bucket = "lean"
        elif matched_buckets == {"assembly"}:
            schedule_bucket = "assembly"
        elif matched_buckets == {"packaging"}:
            schedule_bucket = "packaging"
        elif matched_buckets:
            schedule_bucket = "mixed"
        else:
            schedule_bucket = "pending"

        return {
            "schedule_bucket": schedule_bucket,
            "matched_buckets": sorted(matched_buckets),
            "has_any_capacity": len(capacities) > 0,
            "has_schedulable_capacity": has_schedulable_capacity,
            "matched_capacity_count": len(capacities),
            "positive_upph_count": positive_upph_count,
            "workshop_names": sorted(workshop_names),
            "schedulable_workshop_names": sorted(schedulable_workshop_names),
            "non_schedulable_reasons": sorted(non_schedulable_reasons),
            "lean_main_ids": sorted(lean_main_ids),
            "lean_main_count": len(lean_main_ids),
            "total_upph": total_upph,
            "used_capacities": used_capacities,
        }

    async def summarize_schedule_context(
        self,
        product_code: Optional[str] = None,
        bom_code: Optional[str] = None,
        preloaded_split_rules: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        capacities = await self.get_matched_capacities(product_code=product_code, bom_code=bom_code)
        summary = self.summarize_schedule_context_from_capacities(capacities)
        if summary.get("schedule_bucket") in {"assembly", "packaging", "mixed"}:
            split_rules = preloaded_split_rules
            if split_rules is None:
                split_service = AssemblyRollScheduleService(self.db)
                split_rules = await split_service.get_stage_rules(bom_code=bom_code)
            if split_rules.get("split_rule_ready"):
                summary["schedule_bucket"] = split_rules.get("schedule_bucket") or summary.get("schedule_bucket")
                summary["matched_buckets"] = split_rules.get("matched_buckets") or summary.get("matched_buckets")
                summary["stage_rules"] = split_rules.get("stage_rules") or {}
                summary["split_rule_ready"] = True
                summary["split_price_main_id"] = split_rules.get("selected_main_id")
                summary["total_upph"] = split_rules.get("total_upph") or summary.get("total_upph")
            else:
                summary["stage_rules"] = split_rules.get("stage_rules") or {}
                summary["split_rule_ready"] = False
        return summary

    async def calculate_total_upph(
        self,
        product_code: Optional[str] = None,
        bom_code: Optional[str] = None,
    ) -> Tuple[Optional[float], List[ProductProcessCapacity]]:
        """
        计算综合 UPPH
        返回：(综合 UPPH, 使用的 UPPH 记录列表)
        """
        capacities = await self.get_matched_capacities(product_code=product_code, bom_code=bom_code)
        return self._accumulate_total_upph(capacities)
