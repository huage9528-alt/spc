"""
同步 SQL 配置管理 API
管理员在后台配置直接查询 ERP 数据库的 SQL 语句
"""

import asyncio
import json
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.core.audit import log_audit
from app.schemas.common import ResponseModel
from app.models.basicdata.sync_sql_config import SyncSqlConfig
from app.core.database import Base
from app.services.ai import ai_service, ChatMessage, ChatOptions
import app.models  # 确保所有模型已注册到 Base

router = APIRouter()

_AUTO_FIELDS = {"id", "created_at", "updated_at"}


def _get_sync_type_overrides() -> dict:
    """前端使用的 sync_type 名称 → Model 映射，覆盖自动生成无法匹配的名称"""
    from app.models.order.sale_order import SaleOrder, SaleOrderLine
    from app.models.material.material_demand import MaterialDemand
    from app.models.material.purchase_order import PurchaseOrder
    from app.models.basicdata.customer import Customer
    from app.models.basicdata.supplier import Supplier
    from app.models.basicdata.material import Material
    from app.models.basicdata.sku import SKU
    from app.models.basicdata.product import Product
    from app.models.basicdata.warehouse import Warehouse
    from app.models.basicdata.subject_balance import SubjectBalance
    from app.models.basicdata.process import Process
    from app.models.basicdata.organization import Organization
    from app.models.basicdata.employee import Employee
    from app.models.basicdata.position import Position
    from app.models.production.production_daily_report import ProductionDailyReport
    from app.models.production.labor_price_audit import ProductionLaborPriceAudit
    return {
        "orders": SaleOrder,
        "order_details": SaleOrderLine,
        "materials": MaterialDemand,
        "purchase_orders": PurchaseOrder,
        "customers": Customer,
        "suppliers": Supplier,
        "materials_masterdata": Material,
        "skus": SKU,
        "products": Product,
        "warehouses": Warehouse,
        "subject_balances": SubjectBalance,
        "processes": Process,
        "organizations": Organization,
        "positions": Position,
        "employees": Employee,
        "production_daily_reports": ProductionDailyReport,
        "labor_price_audits": ProductionLaborPriceAudit,
    }


def _get_model_map() -> dict:
    """动态从所有已注册的 SQLAlchemy 模型构建 sync_type → Model 映射。
    支持的 key 形式（以 Supplier / scm_supplier 为例）：
      - 原始表名:       'scm_supplier'
      - 去前缀表名:     'supplier'
      - 去前缀表名复数:  'suppliers'
      - 类名 snake_case: 'supplier'
    """
    import re
    result: dict = {}

    def _collect(cls):
        for sub in cls.__subclasses__():
            if hasattr(sub, '__tablename__') and hasattr(sub, '__table__'):
                table: str = sub.__tablename__
                result[table] = sub
                stripped = re.sub(r'^(scm_|app_|sys_)', '', table)
                result[stripped] = sub
                result[stripped + 's'] = sub
                snake = re.sub(r'(?<!^)(?=[A-Z])', '_', sub.__name__).lower()
                result[snake] = sub
                result[snake + 's'] = sub
            _collect(sub)

    _collect(Base)
    result.update(_get_sync_type_overrides())
    return result


def _build_erp_engine():
    from app.core.config import get_settings
    from sqlalchemy import create_engine

    settings = get_settings()
    if not settings.ERP_DB_URL:
        raise HTTPException(status_code=400, detail="ERP_DB_URL 未配置")
    url = settings.ERP_DB_URL
    for param in ["TrustServerCertificate=yes", "Encrypt=no"]:
        if param.split("=")[0] not in url:
            url += f"&{param}" if "?" in url else f"?{param}"
    connect_args = {"login_timeout": 15, "timeout": 30}
    if "mssql+pyodbc" in url:
        connect_args["charset"] = "utf-8"
    return create_engine(url, echo=False, connect_args=connect_args)


def _clean_value(v):
    from decimal import Decimal as _Decimal
    if v is None:
        return v
    if isinstance(v, (int, float, bool)):
        return v
    if isinstance(v, _Decimal):
        return float(v)
    if isinstance(v, bytes):
        try:
            return v.decode('utf-8')
        except UnicodeDecodeError:
            try:
                return v.decode('gbk')
            except UnicodeDecodeError:
                return v.decode('latin-1', errors='replace')
    if isinstance(v, str):
        try:
            v.encode('utf-8')
            return v
        except UnicodeEncodeError:
            try:
                return v.encode('latin-1').decode('gbk')
            except (UnicodeDecodeError, UnicodeEncodeError):
                return v.encode('latin-1', errors='replace').decode('utf-8', errors='replace')
    if hasattr(v, 'isoformat'):
        return v.isoformat()
    return str(v)


def _strip_top_level_order_by(sql_text: str) -> str:
    sql = sql_text.strip().rstrip(";")
    depth = 0
    quote = None
    bracket_quote = False
    last_order_by = None
    i = 0
    while i < len(sql):
        ch = sql[i]
        if quote:
            if bracket_quote:
                if ch == "]":
                    bracket_quote = False
                    quote = None
            elif ch == quote:
                if i + 1 < len(sql) and sql[i + 1] == quote:
                    i += 1
                else:
                    quote = None
        else:
            if ch in ("'", '"'):
                quote = ch
            elif ch == "[":
                quote = ch
                bracket_quote = True
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth = max(depth - 1, 0)
            elif depth == 0:
                match = re.match(r"order\s+by\b", sql[i:], re.IGNORECASE)
                if match:
                    last_order_by = i
                    i += match.end() - 1
        i += 1
    if last_order_by is None:
        return sql
    return sql[:last_order_by].rstrip()


def _strip_sql_comments(sql_text: str) -> str:
    """剥离 SQL 注释（-- 行注释、/* */ 块注释），保留字符串字面量('...')、
    双引号标识符("...")、T-SQL 方括号标识符([...])内的内容。

    用于字段解析前的清洗：原始 SQL 中的行尾 -- 注释会与外层
    `SELECT TOP 0 * FROM (...) AS __parse__` 的右括号粘连在同一行，
    导致注释吞掉右括号而报语法错误。
    """
    result = []
    i = 0
    n = len(sql_text)
    while i < n:
        ch = sql_text[i]
        nxt = sql_text[i + 1] if i + 1 < n else ""

        if ch == "-" and nxt == "-":
            j = i
            while j < n and sql_text[j] != "\n":
                j += 1
            i = j
            continue

        if ch == "/" and nxt == "*":
            j = i + 2
            while j < n - 1 and not (sql_text[j] == "*" and sql_text[j + 1] == "/"):
                j += 1
            i = j + 2 if j < n - 1 else n
            continue

        if ch in ("'", '"'):
            quote = ch
            result.append(ch)
            i += 1
            while i < n:
                result.append(sql_text[i])
                if sql_text[i] == quote:
                    if i + 1 < n and sql_text[i + 1] == quote:
                        result.append(sql_text[i + 1])
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            continue

        if ch == "[":
            result.append(ch)
            i += 1
            while i < n:
                result.append(sql_text[i])
                if sql_text[i] == "]":
                    i += 1
                    break
                i += 1
            continue

        result.append(ch)
        i += 1

    return "".join(result)


def _run_erp_test(sql_text: str) -> dict:
    """同步执行 ERP SQL 并返回测试结果（在线程池中调用）"""
    from datetime import datetime, timedelta
    from sqlalchemy import text
    import time

    erp_engine = _build_erp_engine()
    try:
        with erp_engine.connect() as conn:
            since = datetime.now() - timedelta(days=30)
            start_time = time.time()
            rows = conn.execute(
                text(sql_text), {"since": since}
            ).mappings().all()
            elapsed = round(time.time() - start_time, 2)

            preview = []
            for row in rows[:20]:
                row_dict = {}
                for k, v in dict(row).items():
                    row_dict[k] = _clean_value(v)
                preview.append(row_dict)

        return {
            "total_rows": len(rows),
            "preview": preview,
            "columns": list(preview[0].keys()) if preview else [],
            "elapsed_seconds": elapsed,
        }
    finally:
        erp_engine.dispose()


def _run_erp_parse_fields(sql_text: str) -> list:
    """同步解析 ERP SQL 字段名（在线程池中调用）
    用 SELECT TOP 0 包裹原始 SQL，仅获取列元数据，不实际拉取数据。
    """
    from datetime import datetime, timedelta
    from sqlalchemy import text

    erp_engine = _build_erp_engine()
    try:
        with erp_engine.connect() as conn:
            since = datetime.now() - timedelta(days=30)
            cleaned = _strip_sql_comments(sql_text)
            parse_sql = _strip_top_level_order_by(cleaned)
            wrapped_sql = f"SELECT TOP 0 * FROM ({parse_sql}\n) AS __parse__"
            result = conn.execute(text(wrapped_sql), {"since": since})
            return list(result.keys())
    finally:
        erp_engine.dispose()


class ParseErpFieldsBody(BaseModel):
    sql_text: str


class AiAutoMatchRequest(BaseModel):
    sql_text: str
    sync_type: str
    erp_fields: List[str]
    spc_fields: List[dict]


class AiAutoMatchResponse(BaseModel):
    mappings: dict  # {erp_field: {spc_field: str, remark: str}}


class TestSqlBody(BaseModel):
    sql_text: str


class SyncSqlCreate(BaseModel):
    sync_type: str
    description: Optional[str] = None
    sql_text: str
    field_mapping_json: Optional[str] = None
    condition_params_json: Optional[str] = None
    sync_interval: str = "1h"
    sync_strategy: str = "incremental"
    sync_time_window: Optional[str] = None
    sync_priority: int = 5
    sync_enabled: bool = True


class SyncSqlUpdate(BaseModel):
    description: Optional[str] = None
    sql_text: Optional[str] = None
    field_mapping_json: Optional[str] = None
    condition_params_json: Optional[str] = None
    sync_interval: Optional[str] = None
    sync_strategy: Optional[str] = None
    sync_time_window: Optional[str] = None
    sync_priority: Optional[int] = None
    sync_enabled: Optional[bool] = None


@router.post("/test-sql", response_model=ResponseModel[dict])
async def test_raw_sql(
    body: TestSqlBody,
    current_user: dict = Depends(PermissionChecker("settings", "read")),
):
    """直接测试 SQL 语句，无需保存配置"""
    if not body.sql_text or not body.sql_text.strip():
        raise HTTPException(status_code=400, detail="SQL 语句不能为空")

    try:
        result = await asyncio.to_thread(_run_erp_test, body.sql_text)
        return ResponseModel(data=result)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SQL 执行失败: {e}")


@router.get("", response_model=ResponseModel[list])
async def list_sync_sql(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = None,
    sync_type: Optional[str] = None,
    sync_enabled: Optional[bool] = None,
    last_sync_status: Optional[str] = None,
    current_user: dict = Depends(PermissionChecker("settings", "read")),
    db: AsyncSession = Depends(get_db),
):
    SORTABLE = {
        'sync_type': SyncSqlConfig.sync_type,
        'description': SyncSqlConfig.description,
        'sync_interval': SyncSqlConfig.sync_interval,
        'sync_strategy': SyncSqlConfig.sync_strategy,
        'sync_priority': SyncSqlConfig.sync_priority,
        'sync_enabled': SyncSqlConfig.sync_enabled,
        'last_sync_status': SyncSqlConfig.last_sync_status,
        'next_sync_time': SyncSqlConfig.next_sync_time,
        'updated_at': SyncSqlConfig.updated_at,
    }

    query = select(SyncSqlConfig)
    if sync_type:
        types = [t.strip() for t in sync_type.split(",") if t.strip()]
        if types:
            query = query.where(SyncSqlConfig.sync_type.in_(types))
    if sync_enabled is not None:
        query = query.where(SyncSqlConfig.sync_enabled == sync_enabled)
    if last_sync_status:
        statuses = [s.strip() for s in last_sync_status.split(",") if s.strip()]
        if statuses:
            query = query.where(SyncSqlConfig.last_sync_status.in_(statuses))

    # 排序
    order_clauses = []
    if sort_by and sort_by in SORTABLE:
        col = SORTABLE[sort_by]
        if sort_order == 'desc':
            order_clauses.append(col.desc().nullslast())
        else:
            order_clauses.append(col.asc().nullslast())
    if not order_clauses:
        order_clauses = [SyncSqlConfig.sync_type.asc()]

    result = await db.execute(query.order_by(*order_clauses))
    configs = result.scalars().all()
    return ResponseModel(data=[
        {
            "id": c.id,
            "sync_type": c.sync_type,
            "description": c.description,
            "sql_text": c.sql_text,
            "field_mapping_json": c.field_mapping_json,
            "condition_params_json": c.condition_params_json,
            "is_active": c.is_active,
            "sync_interval": c.sync_interval,
            "sync_strategy": c.sync_strategy,
            "sync_time_window": c.sync_time_window,
            "sync_priority": c.sync_priority,
            "sync_enabled": c.sync_enabled,
            "last_sync_time": str(c.last_sync_time) if c.last_sync_time else None,
            "next_sync_time": str(c.next_sync_time) if c.next_sync_time else None,
            "last_sync_status": c.last_sync_status,
            "last_sync_message": c.last_sync_message,
            "updated_at": str(c.updated_at) if c.updated_at else None,
        }
        for c in configs
    ])


@router.post("", response_model=ResponseModel[dict])
async def create_sync_sql(
    body: SyncSqlCreate,
    current_user: dict = Depends(PermissionChecker("settings", "create")),
    db: AsyncSession = Depends(get_db),
):
    existing = await db.execute(
        select(SyncSqlConfig).where(SyncSqlConfig.sync_type == body.sync_type)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail=f"sync_type='{body.sync_type}' 已存在，请使用 PUT 更新")

    # 计算初始 next_sync_time
    from datetime import datetime, timedelta
    interval_map = {"h": 3600, "d": 86400, "w": 604800}
    interval_str = (body.sync_interval or "1h").lower()
    try:
        unit = interval_str[-1]
        val = int(interval_str[:-1])
        seconds = val * interval_map.get(unit, 3600)
    except (ValueError, IndexError):
        seconds = 3600
    initial_next = datetime.now() + timedelta(seconds=seconds)

    config = SyncSqlConfig(
        sync_type=body.sync_type,
        description=body.description,
        sql_text=body.sql_text,
        field_mapping_json=body.field_mapping_json,
        condition_params_json=body.condition_params_json,
        is_active=body.sync_enabled,
        sync_interval=body.sync_interval,
        sync_strategy=body.sync_strategy,
        sync_time_window=body.sync_time_window,
        sync_priority=body.sync_priority,
        sync_enabled=body.sync_enabled,
        created_by=current_user.get("username", ""),
        next_sync_time=initial_next,
    )
    db.add(config)
    await db.flush()
    await log_audit(db, "sync_sql_config", config.id, "create", operator=current_user.get("username", ""))
    await db.commit()
    return ResponseModel(data={"id": config.id, "sync_type": config.sync_type})


@router.put("/{config_id}", response_model=ResponseModel[dict])
async def update_sync_sql(
    config_id: int,
    body: SyncSqlUpdate,
    current_user: dict = Depends(PermissionChecker("settings", "update")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(SyncSqlConfig).where(SyncSqlConfig.id == config_id))
    config = result.scalar_one_or_none()
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")

    if body.sql_text is not None:
        config.sql_text = body.sql_text
    if body.description is not None:
        config.description = body.description
    if body.field_mapping_json is not None:
        config.field_mapping_json = body.field_mapping_json
    if body.condition_params_json is not None:
        config.condition_params_json = body.condition_params_json
    if body.sync_interval is not None:
        config.sync_interval = body.sync_interval
        # 重新计算 next_sync_time
        from datetime import datetime, timedelta
        interval_map = {"h": 3600, "d": 86400, "w": 604800}
        interval_str = (body.sync_interval or "1h").lower()
        try:
            unit = interval_str[-1]
            val = int(interval_str[:-1])
            seconds = val * interval_map.get(unit, 3600)
        except (ValueError, IndexError):
            seconds = 3600
        base = config.last_sync_time or datetime.now()
        config.next_sync_time = base + timedelta(seconds=seconds)
    if body.sync_strategy is not None:
        config.sync_strategy = body.sync_strategy
    if body.sync_time_window is not None:
        config.sync_time_window = body.sync_time_window
    if body.sync_priority is not None:
        config.sync_priority = body.sync_priority
    if body.sync_enabled is not None:
        config.sync_enabled = body.sync_enabled
        config.is_active = body.sync_enabled

    await log_audit(db, "sync_sql_config", config.id, "update", operator=current_user.get("username", ""))
    await db.commit()
    return ResponseModel(data={"id": config.id, "sync_type": config.sync_type})


@router.delete("/{config_id}", response_model=ResponseModel[dict])
async def delete_sync_sql(
    config_id: int,
    current_user: dict = Depends(PermissionChecker("settings", "delete")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(SyncSqlConfig).where(SyncSqlConfig.id == config_id))
    config = result.scalar_one_or_none()
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")

    await log_audit(db, "sync_sql_config", config.id, "delete", operator=current_user.get("username", ""))
    await db.delete(config)
    await db.commit()
    return ResponseModel(data={"deleted": config_id})


@router.get("/available-types", response_model=ResponseModel[list])
async def get_available_sync_types(
    current_user: dict = Depends(PermissionChecker("settings", "read")),
    db: AsyncSession = Depends(get_db),
):
    """返回所有已知同步类型（已注册同步处理器 ∪ DB 中已配置的类型），前端用此列表动态渲染下拉/标签。

    不再自动枚举所有 ORM 模型生成的候选 key（如 scm_supplier / supplier / suppliers 三态），
    那样会把数百个没有同步处理器的"无效"类型塞进下拉，污染选择体验。
    仅暴露两类：
      1. 同步处理器已注册的类型（同步任务真正可执行的类型）；
      2. sync_sql_config 表中已配置的类型（保留历史/自定义类型，避免误删用户已配置项）。
    两类合并后标注 has_model / has_sql，前端可据此提示该类型是否已具同步执行能力。
    """
    # 已注册同步处理器支持的 sync_type（与 app/api/v1/basicdata/sync.py VALID_SYNC_TYPES 保持一致，
    # 排除聚合型 "all"）
    supported_types = {
        "orders", "order_details", "materials", "purchase_orders", "customers", "suppliers",
        "materials_masterdata", "skus", "products", "boms", "bom_details", "warehouses", "locations", "processes",
        "organizations", "positions", "employees", "employee_organizations", "purchase_invoices",
        "payment_applies", "quality_issues", "mrp_plan_orders", "production_task_orders", "production_daily_reports",
        "labor_price_audits", "inventory", "subcontract_orders", "subcontract_order_details", "subject_balances",
    }

    model_map = _get_model_map()
    result_db = await db.execute(select(SyncSqlConfig))
    configs = {c.sync_type: c for c in result_db.scalars().all()}

    all_types: dict[str, dict] = {}

    for sync_type in supported_types:
        cfg = configs.get(sync_type)
        label = ""
        if cfg and cfg.description:
            label = cfg.description.split("—")[0].strip()
        all_types[sync_type] = {
            "value": sync_type,
            "label": label or _humanize_sync_type(sync_type),
            "has_model": sync_type in model_map,
            "has_sql": bool(cfg and cfg.sql_text and cfg.sql_text.strip()),
        }

    # 加入 DB 中已配置、但不在 supported_types 的类型（历史/用户自定义），避免误删
    for sync_type, cfg in configs.items():
        if sync_type in all_types:
            all_types[sync_type]["has_sql"] = bool(cfg.sql_text and cfg.sql_text.strip())
            if not all_types[sync_type]["label"] and cfg.description:
                all_types[sync_type]["label"] = cfg.description.split("—")[0].strip()
            continue
        label = ""
        if cfg.description:
            label = cfg.description.split("—")[0].strip()
        all_types[sync_type] = {
            "value": sync_type,
            "label": label or _humanize_sync_type(sync_type),
            "has_model": sync_type in model_map,
            "has_sql": bool(cfg.sql_text and cfg.sql_text.strip()),
        }

    return ResponseModel(data=sorted(all_types.values(), key=lambda x: x["value"]))


def _humanize_sync_type(sync_type: str) -> str:
    name_map = {
        "orders": "订单数据", "order_details": "订单明细", "materials": "物料需求",
        "purchase_orders": "采购订单", "customers": "客户", "suppliers": "供应商",
        "materials_masterdata": "物料", "skus": "SKU", "products": "产品",
        "warehouses": "仓库", "locations": "库位", "processes": "工序",
        "organizations": "组织", "positions": "岗位", "employees": "人员",
        "employee_organizations": "员工组织关系",
        "purchase_invoices": "采购开票",
        "payment_applies": "付款申请", "quality_issues": "品质异常",
        "mrp_plan_orders": "MRP计划订单", "production_task_orders": "生产任务单",
        "production_daily_reports": "生产日报表", "inventory": "即时库存",
        "subcontract_orders": "委外订单", "subcontract_order_details": "委外订单明细",
        "subject_balances": "科目余额", "labor_price_audits": "工价审核数据",
        "boms": "BOM", "bom_details": "BOM明细",
    }
    return name_map.get(sync_type, sync_type)


@router.get("/spc-fields/{sync_type}", response_model=ResponseModel[list])
async def get_spc_fields(
    sync_type: str,
    current_user: dict = Depends(PermissionChecker("settings", "read")),
):
    model_map = _get_model_map()
    model = model_map.get(sync_type)
    if not model:
        raise HTTPException(
            status_code=400,
            detail=f"未知的同步类型: {sync_type}，系统中无匹配模型",
        )

    columns = []
    for col in model.__table__.columns:
        if col.name in _AUTO_FIELDS:
            continue
        columns.append({
            "name": col.name,
            "type": str(col.type),
            "nullable": col.nullable,
        })
    return ResponseModel(data=columns)


@router.post("/parse-erp-fields", response_model=ResponseModel[list])
async def parse_erp_fields(
    body: ParseErpFieldsBody,
    current_user: dict = Depends(PermissionChecker("settings", "read")),
):
    try:
        columns = await asyncio.to_thread(_run_erp_parse_fields, body.sql_text)
        return ResponseModel(data=columns)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SQL 字段解析失败: {e}")


@router.get("/field-remarks/{sync_type}", response_model=ResponseModel[dict])
async def get_field_remarks(
    sync_type: str,
    current_user: dict = Depends(PermissionChecker("settings", "read")),
    db: AsyncSession = Depends(get_db),
):
    result_db = await db.execute(
        select(SyncSqlConfig).where(SyncSqlConfig.sync_type == sync_type)
    )
    config = result_db.scalar_one_or_none()
    if not config or not config.field_mapping_json:
        return ResponseModel(data={})

    try:
        mapping = json.loads(config.field_mapping_json)
    except json.JSONDecodeError:
        return ResponseModel(data={})

    remarks = {}
    for erp_field, val in mapping.items():
        if isinstance(val, dict):
            target = val.get("target")
            remark = val.get("remark")
            if target and remark:
                remarks[target] = remark
        elif isinstance(val, str):
            pass  # 简单格式无备注，跳过

    return ResponseModel(data=remarks)


@router.post("/ai-auto-match", response_model=ResponseModel[dict])
async def ai_auto_match(
    body: AiAutoMatchRequest,
    current_user: dict = Depends(PermissionChecker("settings", "read")),
):
    try:
        if ai_service.current_provider() == "rule_based":
            raise HTTPException(status_code=400, detail="AI 服务未配置，请在 .env 中设置 AI_OPENAI_API_KEY / AI_OPENAI_BASE_URL")

        spc_fields_desc = "\n".join([
            f"  - {f['name']} (类型: {f.get('type', 'unknown')})"
            for f in body.spc_fields
        ])
        erp_fields_list = "\n".join([f"  - {f}" for f in body.erp_fields])

        prompt = (
            f"你是一个数据库字段映射专家。请分析以下 SQL 查询，将 ERP 字段匹配到 SPC 系统的目标字段。\n\n"
            f"## SQL 查询\n```sql\n{body.sql_text}\n```\n\n"
            f"## ERP 字段列表（从 SQL SELECT 中提取）\n{erp_fields_list}\n\n"
            f"## SPC 目标字段列表（{body.sync_type} 模型）\n{spc_fields_desc}\n\n"
            f"## 任务\n"
            f"1. 分析 SQL 查询中涉及的表和列，理解每个 ERP 字段的语义和来源\n"
            f"2. 将每个 ERP 字段语义匹配到最合适的 SPC 目标字段\n"
            f"3. 为每个匹配生成中文备注\n\n"
            f"## 备注格式要求（重要）\n"
            f"备注必须使用自然的中文业务语言，格式为：**[中文表名]表的[中文字段含义]字段**\n"
            f"- 表名必须翻译为中文（如 SEOrder → 销售订单，t_Customer → 客户，t_Item → 物料）\n"
            f"- 字段名必须翻译为中文业务含义（如 FBillNo → 单据编号，FItemName → 物料名称，FQty → 数量）\n"
            f"- 不要保留英文代号，不要使用方括号包裹表名和字段名\n"
            f"- 正确示例：销售订单表的单据编号字段、客户表的客户名称字段\n"
            f"- 错误示例：SEOrder表的FBillNo字段、来自ERP[SEOrder]表的[FBillNo]字段\n\n"
            f"请严格输出 JSON，格式如下：\n"
            f"{{\n"
            f'  "mappings": {{\n'
            f'    "ERP字段1": {{"spc_field": "匹配的SPC字段名或null", "remark": "中文说明"}},\n'
            f'    "ERP字段2": {{"spc_field": "匹配的SPC字段名或null", "remark": "中文说明"}}\n'
            f"  }}\n"
            f"}}\n\n"
            f"注意：\n"
            f"- 如果 ERP 字段没有合适的 SPC 目标字段匹配，spc_field 设为 null\n"
            f"- remark 必须用中文描述业务含义，不要出现英文代号\n"
            f"- 只输出 JSON，不要包含任何其他文字"
        )

        messages = [
            ChatMessage(role="system", content="你是一个专业的数据库字段映射助手，擅长分析 SQL 语义并匹配字段映射关系。"),
            ChatMessage(role="user", content=prompt),
        ]

        options = ChatOptions(temperature=0.1, max_tokens=4096, timeout=120)
        raw = await ai_service.chat(messages, options)

        # 尝试提取 JSON
        text = raw.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            text = "\n".join(lines[1:-1]) if len(lines) > 2 else text
        result = json.loads(text)
        mappings = result.get("mappings", {})

        return ResponseModel(data={"mappings": mappings})
    except HTTPException:
        raise
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="AI 返回的内容无法解析为 JSON，请重试")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 自动匹配失败: {e}")


@router.post("/{config_id}/test", response_model=ResponseModel[dict])
async def test_sync_sql(
    config_id: int,
    current_user: dict = Depends(PermissionChecker("settings", "read")),
):
    # 只在读配置时短暂占用 PG 会话；ERP 测试（最长 30s）期间不持有任何
    # PG 连接/事务，避免并发测试时连接池被白白占满
    from app.core.database import AsyncSessionLocal
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(SyncSqlConfig.sql_text).where(SyncSqlConfig.id == config_id)
        )
        row = result.first()
        if not row:
            raise HTTPException(status_code=404, detail="配置不存在")
        sql_text = row[0]
        await db.commit()

    try:
        data = await asyncio.to_thread(_run_erp_test, sql_text)
        return ResponseModel(data=data)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SQL 执行失败: {e}")
