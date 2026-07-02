import json
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import Boolean, Column, DateTime, Integer, Numeric, String, Index, Text
from sqlalchemy.sql import func

from app.core.database import Base


OA_CAPACITY_META_PREFIX = "__oa_capacity_meta__:"
TARGET_SCHEDULABLE_WORKSHOPS = ("精益车间", "装配车间")
LEAN_WORKSHOP_NAME = "精益车间"
DEFAULT_FORMULA_PROFILES: dict[tuple[str, str], dict[str, float]] = {}
DEFAULT_PROCESS_PROFILE_KEY = "*"
UPPH_SOURCE_FORMULA = "formula"
UPPH_SOURCE_OA = "oa"
UPPH_SOURCE_MANUAL = "manual"
UPPH_SOURCE_NONE = "none"


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(str(value).strip())
    except (InvalidOperation, ValueError, TypeError):
        return None


def _resolve_formula_profile(
    workshop_name: str | None,
    process_type: str | None,
) -> dict[str, float]:
    if not workshop_name:
        return {}
    keys = []
    if process_type:
        keys.append((workshop_name, process_type))
    keys.append((workshop_name, DEFAULT_PROCESS_PROFILE_KEY))
    for key in keys:
        profile = DEFAULT_FORMULA_PROFILES.get(key)
        if profile:
            return profile
    return {}


def calculate_formula_upph(
    *,
    gjje: Any,
    manpower: Any,
    hour_price: Any,
) -> float | None:
    gjje_value = _normalize_float(gjje)
    manpower_value = _normalize_float(manpower)
    hour_price_value = _normalize_float(hour_price)
    if gjje_value is None or gjje_value <= 0:
        return None
    if manpower_value is None or manpower_value <= 0:
        return None
    if hour_price_value is None or hour_price_value <= 0:
        return None
    return round((manpower_value * hour_price_value) / gjje_value, 2)


def resolve_capacity_upph(
    *,
    workshop_name: str | None,
    process_type: str | None,
    gjje: Any,
    oa_raw_upph: Any = None,
    manpower: Any = None,
    hour_price: Any = None,
    manual_upph: Any = None,
) -> dict[str, Any]:
    profile = _resolve_formula_profile(workshop_name, process_type)
    resolved_manpower = _normalize_float(manpower)
    resolved_hour_price = _normalize_float(hour_price)
    if resolved_manpower is None:
        resolved_manpower = _normalize_float(profile.get("manpower"))
    if resolved_hour_price is None:
        resolved_hour_price = _normalize_float(profile.get("hour_price"))

    oa_value = _normalize_float(oa_raw_upph)
    manual_value = _normalize_float(manual_upph)
    formula_value = calculate_formula_upph(
        gjje=gjje,
        manpower=resolved_manpower,
        hour_price=resolved_hour_price,
    )

    effective_upph = 0.0
    upph_source = UPPH_SOURCE_NONE
    if manual_value is not None and manual_value > 0:
        effective_upph = manual_value
        upph_source = UPPH_SOURCE_MANUAL
    elif formula_value is not None and formula_value > 0:
        effective_upph = formula_value
        upph_source = UPPH_SOURCE_FORMULA
    elif oa_value is not None and oa_value > 0:
        effective_upph = oa_value
        upph_source = UPPH_SOURCE_OA

    return {
        "oa_raw_upph": oa_value,
        "formula_upph": formula_value,
        "manual_upph": manual_value,
        "effective_upph": round(effective_upph, 2),
        "upph_source": upph_source,
        "manpower": resolved_manpower,
        "hour_price": resolved_hour_price,
    }


def parse_capacity_metadata(remark: str | None) -> dict[str, Any]:
    raw_remark = _normalize_text(remark)
    if not raw_remark or not raw_remark.startswith(OA_CAPACITY_META_PREFIX):
        return {
            "oa_main_id": None,
            "oa_workshop_id": None,
            "oa_workshop_name": None,
            "gjje": None,
            "oa_raw_upph": None,
            "formula_upph": None,
            "manual_upph": None,
            "effective_upph": None,
            "upph_source": None,
            "manpower": None,
            "hour_price": None,
            "raw_remark": raw_remark,
            "is_schedulable": True,
            "exclude_reason": None,
        }

    try:
        payload = json.loads(raw_remark[len(OA_CAPACITY_META_PREFIX):])
    except json.JSONDecodeError:
        return {
            "oa_main_id": None,
            "oa_workshop_id": None,
            "oa_workshop_name": None,
            "gjje": None,
            "oa_raw_upph": None,
            "formula_upph": None,
            "manual_upph": None,
            "effective_upph": None,
            "upph_source": None,
            "manpower": None,
            "hour_price": None,
            "raw_remark": raw_remark,
            "is_schedulable": True,
            "exclude_reason": None,
        }

    workshop_name = _normalize_text(payload.get("oa_workshop_name"))
    gjje = _normalize_float(payload.get("gjje"))
    exclude_reason = None
    if not workshop_name:
        exclude_reason = "车间未配置或无法映射"
    elif workshop_name not in TARGET_SCHEDULABLE_WORKSHOPS:
        exclude_reason = "非精益/装配车间，不参与自动排产"

    return {
        "oa_main_id": _normalize_text(payload.get("oa_main_id")),
        "oa_workshop_id": _normalize_text(payload.get("oa_workshop_id")),
        "oa_workshop_name": workshop_name,
        "gjje": gjje,
        "oa_raw_upph": _normalize_float(payload.get("oa_raw_upph")),
        "formula_upph": _normalize_float(payload.get("formula_upph")),
        "manual_upph": _normalize_float(payload.get("manual_upph")),
        "effective_upph": _normalize_float(payload.get("effective_upph")),
        "upph_source": _normalize_text(payload.get("upph_source")),
        "manpower": _normalize_float(payload.get("manpower")),
        "hour_price": _normalize_float(payload.get("hour_price")),
        "raw_remark": _normalize_text(payload.get("raw_remark")),
        "is_schedulable": exclude_reason is None,
        "exclude_reason": exclude_reason,
    }


def build_capacity_metadata_remark(
    *,
    oa_main_id: str | None = None,
    oa_workshop_id: str | None = None,
    oa_workshop_name: str | None = None,
    gjje: Any = None,
    oa_raw_upph: Any = None,
    formula_upph: Any = None,
    effective_upph: Any = None,
    manual_upph: Any = None,
    upph_source: str | None = None,
    manpower: Any = None,
    hour_price: Any = None,
    raw_remark: str | None = None,
) -> str:
    payload = {
        "oa_main_id": _normalize_text(oa_main_id),
        "oa_workshop_id": _normalize_text(oa_workshop_id),
        "oa_workshop_name": _normalize_text(oa_workshop_name),
        "gjje": _normalize_float(gjje),
        "oa_raw_upph": _normalize_float(oa_raw_upph),
        "formula_upph": _normalize_float(formula_upph),
        "effective_upph": _normalize_float(effective_upph),
        "manual_upph": _normalize_float(manual_upph),
        "upph_source": _normalize_text(upph_source),
        "manpower": _normalize_float(manpower),
        "hour_price": _normalize_float(hour_price),
        "raw_remark": _normalize_text(raw_remark),
    }
    return f"{OA_CAPACITY_META_PREFIX}{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}"


def update_capacity_raw_remark(existing_remark: str | None, raw_remark: str | None) -> str | None:
    if not existing_remark or not existing_remark.startswith(OA_CAPACITY_META_PREFIX):
        return _normalize_text(raw_remark)

    metadata = parse_capacity_metadata(existing_remark)
    return build_capacity_metadata_remark(
        oa_main_id=metadata.get("oa_main_id"),
        oa_workshop_id=metadata.get("oa_workshop_id"),
        oa_workshop_name=metadata.get("oa_workshop_name"),
        gjje=metadata.get("gjje"),
        oa_raw_upph=metadata.get("oa_raw_upph"),
        formula_upph=metadata.get("formula_upph"),
        effective_upph=metadata.get("effective_upph"),
        manual_upph=metadata.get("manual_upph"),
        upph_source=metadata.get("upph_source"),
        manpower=metadata.get("manpower"),
        hour_price=metadata.get("hour_price"),
        raw_remark=raw_remark,
    )

class ProductProcessCapacity(Base):
    __tablename__ = "product_process_capacity"

    id = Column(Integer, primary_key=True, autoincrement=True)
    oa_detail_id = Column(String(64), nullable=True, index=True, comment="OA明细ID")
    bom_code = Column(String(64), nullable=True, index=True, comment="BOM编码")
    product_code = Column(String(64), nullable=False, index=True, comment="产品编码")
    product_name = Column(String(256), nullable=True, comment="产品名称")
    process_type = Column(String(32), nullable=False, comment="工序类型(如: 组装, 包装)")
    upph = Column(Numeric(15, 2), nullable=False, default=0, comment="每小时产能")
    source = Column(String(32), nullable=True, default="OA", comment="数据来源")
    sync_batch_no = Column(String(64), nullable=True, index=True, comment="同步批次号")
    last_sync_time = Column(DateTime, nullable=True, comment="上次同步时间")
    is_active = Column(Boolean, nullable=False, default=True, comment="是否有效")
    remark = Column(Text, nullable=True, comment="备注/区分信息(来自OA的bz/bzcn)")

    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_product_process_capacity_product_process", "product_code", "process_type", unique=False),
        Index("ix_product_process_capacity_bom_process", "bom_code", "process_type", unique=False),
    )
