"""
ERP Sync Service — 直接通过 SQL 查询 ERP 数据库同步数据到 SPC
SQL 语句存储在 sync_sql_config 表中，可在后台管理界面配置
SQL 中使用 :since 作为增量时间参数
"""

import asyncio
import json
import logging
import re
from datetime import datetime, date, timedelta
from typing import Optional

from sqlalchemy import create_engine, text, select, cast, String, Column
from sqlalchemy.orm import sessionmaker
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.models.material.material_demand import MaterialDemand
from app.models.material.purchase_order import PurchaseOrder
from app.models.material.purchase_invoice import PurchaseInvoice
from app.models.material.payment_apply import PaymentApply
from app.models.material.subcontract_order import SubcontractOrder
from app.models.material.subcontract_order_detail import SubcontractOrderDetail
from app.models.basicdata.sync_sql_config import SyncSqlConfig
from app.models.basicdata.customer import Customer
from app.models.basicdata.supplier import Supplier
from app.models.basicdata.material import Material
from app.models.basicdata.sku import SKU
from app.models.basicdata.product import Product
from app.models.basicdata.bom import Bom
from app.models.basicdata.bom_detail import BomDetail
from app.models.basicdata.warehouse import Warehouse
from app.models.basicdata.location import Location
from app.models.basicdata.inventory import Inventory
from app.models.basicdata.subject_balance import SubjectBalance
from app.models.basicdata.process import Process
from app.models.basicdata.organization import Organization
from app.models.basicdata.employee import Employee
from app.models.basicdata.employee_organization import EmployeeOrganization
from app.models.basicdata.position import Position
from app.models.exception.quality_issue import QualityIssue
from app.models.material.mrp_plan_order import MrpPlanOrder
from app.models.production.production_task_order import ProductionTaskOrder
from app.models.production.production_daily_report import ProductionDailyReport
from app.models.production.labor_price_audit import ProductionLaborPriceAudit


logger = logging.getLogger(__name__)
settings = get_settings()
ACTIVE_EMPLOYEE_STATUSES = {0, 1, 2, 3}


class ERPConnectionError(Exception):
    """ERP 连接异常"""
    pass


class ERPSyncService:
    """
    ERP 数据同步服务
    通过在 sync_sql_config 表中配置的 SQL 直接查询 ERP 数据库
    """

    def __init__(self, spc_db: AsyncSession):
        self.spc_db = spc_db
        self.erp_engine = None
        self.erp_session = None
        self.batch_size = settings.ERP_SYNC_BATCH_SIZE
        self.sync_log = None  # 可选：同步过程中实时回写进度的 SyncLog 对象

    # ------------------------------------------------------------------
    # 连接管理
    # ------------------------------------------------------------------
    async def _connect_erp(self):
        """建立到 ERP 数据库的只读连接（幂等：已连接则跳过），通过线程池避免阻塞事件循环"""
        if self.erp_session is not None:
            return
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._connect_erp_sync)

    def _connect_erp_sync(self):
        """同步建立 ERP 连接（在线程池中执行）"""
        if self.erp_session is not None:
            return
        if not settings.ERP_DB_URL:
            raise ERPConnectionError("ERP_DB_URL 未配置，请在 .env 中设置")
        if not settings.ERP_SYNC_ENABLED:
            raise ERPConnectionError("ERP 同步未启用，请设置 ERP_SYNC_ENABLED=true")

        try:
            url = settings.ERP_DB_URL
            for param in ["TrustServerCertificate=yes", "Encrypt=no"]:
                if param.split("=")[0] not in url:
                    url += f"&{param}" if "?" in url else f"?{param}"
            connect_args = {"login_timeout": 15, "timeout": 30}
            # 对于 SQL Server，添加编码参数
            if "mssql+pyodbc" in url:
                connect_args["charset"] = "utf-8"
            self.erp_engine = create_engine(
                url,
                echo=False,
                pool_size=5,
                max_overflow=2,
                pool_pre_ping=True,
                connect_args=connect_args,
            )
            Session = sessionmaker(bind=self.erp_engine)
            self.erp_session = Session()
            self.erp_session.execute(text("SELECT 1"))
            logger.info("ERP 数据库连接成功")
        except Exception as e:
            raise ERPConnectionError(f"ERP 数据库连接失败: {e}")

    def _close_erp(self, keep_alive: bool = False):
        """关闭 ERP 连接。keep_alive=True 时仅断开 session 但保留引擎供复用"""
        if self.erp_session:
            self.erp_session.close()
            if not keep_alive:
                self.erp_session = None
            else:
                # 重新创建 session 供下次使用
                Session = sessionmaker(bind=self.erp_engine)
                self.erp_session = Session()
        if not keep_alive and self.erp_engine:
            self.erp_engine.dispose()
            self.erp_engine = None
            self.erp_session = None

    # ------------------------------------------------------------------
    # SQL 配置加载
    # ------------------------------------------------------------------
    async def _load_sql_config(self, sync_type: str) -> tuple[str, dict]:
        """
        从 sync_sql_config 表加载 SQL 和字段映射
        返回 (sql_text, field_mapping_dict)
        """
        result = await self.spc_db.execute(
            select(SyncSqlConfig).where(
                SyncSqlConfig.sync_type == sync_type,
                SyncSqlConfig.sync_enabled == True,
            )
        )
        config = result.scalar_one_or_none()
        if not config:
            raise ERPConnectionError(
                f"未配置 sync_type='{sync_type}' 的同步 SQL，"
                f"请在 系统配置 → 同步SQL配置 中添加"
            )

        mapping = {}
        if config.field_mapping_json:
            try:
                mapping = json.loads(config.field_mapping_json)
            except json.JSONDecodeError:
                logger.warning(f"sync_type={sync_type} 的字段映射 JSON 解析失败，使用原始字段名")

        return config.sql_text, mapping

    async def _load_optional_sql_config(self, sync_type: str) -> Optional[tuple[str, dict]]:
        """
        可选地加载某 sync_type 的 SQL 配置(不限 sync_enabled)。
        用于辅助型查询(如删除检测), 读不到/未配置则返回 None 而非抛错。
        """
        result = await self.spc_db.execute(
            select(SyncSqlConfig).where(SyncSqlConfig.sync_type == sync_type)
        )
        config = result.scalar_one_or_none()
        if not config or not (config.sql_text or "").strip():
            return None
        mapping = {}
        if config.field_mapping_json:
            try:
                mapping = json.loads(config.field_mapping_json)
            except json.JSONDecodeError:
                logger.warning(f"sync_type={sync_type} 的字段映射 JSON 解析失败，使用原始字段名")
        return config.sql_text, mapping

    # ------------------------------------------------------------------
    # 通用：执行 SQL 并映射字段
    # ------------------------------------------------------------------
    async def _execute_erp_sql(self, sql_text: str, params: dict) -> list[dict]:
        """在 ERP 数据库上执行 SQL，返回字典列表（通过线程池避免阻塞事件循环）"""
        # pyodbc 使用 ? 绑定参数，传入的参数数量必须与占位符数量完全一致，
        # 否则会抛出 "COUNT field incorrect or syntax error"。
        # 这里只保留 SQL 中实际出现的命名占位符（:name），避免配置的 SQL 未使用 :since 时报错。
        if params:
            referenced = set(re.findall(r":(\w+)", sql_text))
            params = {k: v for k, v in params.items() if k in referenced}
        else:
            params = {}

        loop = asyncio.get_event_loop()

        def _fetch():
            return self.erp_session.execute(text(sql_text), params).mappings().all()

        timeout = getattr(settings, "ERP_SYNC_QUERY_TIMEOUT", 600)
        try:
            rows = await asyncio.wait_for(
                loop.run_in_executor(None, _fetch),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            raise ERPConnectionError(
                f"ERP 查询超时（{timeout}秒未返回），SQL 可能过慢或连接异常。"
                f"请检查 ERP 端表数据量/索引，或调大 ERP_SYNC_QUERY_TIMEOUT。"
            )

        def clean_value(v):
            """清理值，处理编码问题"""
            if v is None:
                return v
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
            return v

        cleaned_rows = []
        for row in rows:
            row_dict = {}
            for k, v in dict(row).items():
                row_dict[k] = clean_value(v)
            cleaned_rows.append(row_dict)
        return cleaned_rows

    @staticmethod
    def _get_model_columns(model_class) -> set:
        """获取 ORM 模型的所有列名（排除自动字段）"""
        auto = {"id", "created_at", "updated_at"}
        return {col.name for col in model_class.__table__.columns if col.name not in auto}

    @staticmethod
    def _ensure_utf8_string(value: str) -> str:
        """确保字符串是有效的 UTF-8 编码，如果不是则尝试从 GBK/GB2312 转换"""
        if not isinstance(value, str):
            return value
        try:
            # 尝试编码为 UTF-8 来验证
            value.encode('utf-8')
            return value
        except UnicodeEncodeError:
            try:
                # 尝试从 GBK/GB2312 解码并重新编码为 UTF-8
                return value.encode('latin-1').decode('gbk')
            except (UnicodeDecodeError, UnicodeEncodeError):
                # 如果都失败，替换无效字符
                return value.encode('latin-1', errors='replace').decode('utf-8', errors='replace')

    @staticmethod
    def _map_row(row: dict, mapping: dict) -> dict:
        """根据字段映射转换一行数据
        支持两种映射格式:
          "FCol": "spc_col"                          (简单格式)
          "FCol": {"target": "spc_col", "remark": "备注"} (带备注格式)
        """
        mapped = {}
        for key, value in row.items():
            map_entry = mapping.get(key, key)
            if isinstance(map_entry, dict):
                target_key = map_entry.get("target", key)
            else:
                target_key = map_entry
            if value is not None:
                if isinstance(value, datetime):
                    value = value.date()
                elif isinstance(value, str):
                    value = ERPSyncService._ensure_utf8_string(value)
                mapped[target_key] = value
        return mapped

    @staticmethod
    def _filter_model_fields(row_dict: dict, valid_columns: set) -> dict:
        """过滤掉不属于目标模型的字段，防止 ORM 构造报错"""
        return {k: v for k, v in row_dict.items() if k in valid_columns}

    @staticmethod
    def _coerce_row_types(row_dict: dict, model_class) -> dict:
        """
        根据 ORM 模型列类型强制转换值类型
        防止 asyncpg 严格类型检查报错（如 int 传给 VARCHAR 列）
        """
        from sqlalchemy import String, Numeric, Date, DateTime, Integer, Float, Boolean
        col_map = {col.name: col for col in model_class.__table__.columns}
        coerced = {}
        for k, v in row_dict.items():
            if v is None:
                coerced[k] = v
                continue
            col = col_map.get(k)
            if col is None:
                coerced[k] = v
                continue
            col_type = type(col.type)
            # 非字符串列收到空串时统一转 None：
            # ERP 经常用 '' 表示缺失,asyncpg 会对 INTEGER/NUMERIC/DATE 列
            # 报 "str' object cannot be interpreted as an integer" 等错误。
            # 转成 None 后可由 _bulk_upsert 的 NOT NULL 默认值清理走 DB/ORM 默认值。
            if isinstance(v, str) and v.strip() == "" and col_type is not String:
                coerced[k] = None
                continue
            try:
                if col_type is String and not isinstance(v, str):
                    coerced[k] = str(v)
                elif col_type in (Numeric, Float) and not isinstance(v, (int, float)):
                    coerced[k] = float(v)
                elif col_type is Integer and (isinstance(v, bool) or not isinstance(v, int)):
                    coerced[k] = int(v)
                elif col_type is Date:
                    if isinstance(v, str):
                        try:
                            coerced[k] = datetime.strptime(v, "%Y-%m-%d").date() if v else None
                        except ValueError:
                            # Handle different date formats
                            try:
                                coerced[k] = datetime.fromisoformat(v).date() if v else None
                            except ValueError:
                                coerced[k] = None
                    elif isinstance(v, datetime):
                        coerced[k] = v.date()
                    elif isinstance(v, date):
                        coerced[k] = v
                    else:
                        coerced[k] = None
                elif col_type is DateTime:
                    # DateTime 列必须收到 datetime 实例，否则 asyncpg 会拒绝。
                    # 处理三种源数据：
                    #   1. datetime / date 实例 — 直接用 / 提升为 datetime
                    #   2. str — 尝试解析常见格式，失败则置 None
                    #   3. SQL Server rowversion/timestamp 二进制（被 clean_value
                    #      按 latin-1 解码成含 \x00 控制字符的 str）— 无法解析，
                    #      置 None，避免污染列
                    if isinstance(v, datetime):
                        coerced[k] = v
                    elif isinstance(v, date):
                        coerced[k] = datetime(v.year, v.month, v.day)
                    elif isinstance(v, str):
                        parsed: Optional[datetime] = None
                        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
                            try:
                                parsed = datetime.strptime(v, fmt)
                                break
                            except ValueError:
                                continue
                        if parsed is None:
                            try:
                                parsed = datetime.fromisoformat(v.replace("Z", "+00:00"))
                            except (ValueError, AttributeError):
                                parsed = None
                        coerced[k] = parsed
                    else:
                        coerced[k] = None
                elif col_type is Boolean and not isinstance(v, bool):
                    coerced[k] = bool(v)
                else:
                    coerced[k] = v
            except (ValueError, TypeError):
                coerced[k] = v
        return coerced

    # ------------------------------------------------------------------
    # 批量 upsert 通用方法
    # ------------------------------------------------------------------
    async def _report_progress(self, stats: dict):
        """实时回写同步进度到 SyncLog，使前端轮询能看到已处理条数。"""
        if self.sync_log is None:
            return
        try:
            self.sync_log.synced_count = stats["synced"]
            self.sync_log.created_count = stats["created"]
            self.sync_log.updated_count = stats["updated"]
            self.sync_log.failed_count = len(stats["errors"])
            await self.spc_db.commit()
        except Exception:
            try:
                await self.spc_db.rollback()
            except Exception:
                pass

    async def _bulk_upsert(
        self,
        model_class,
        raw_rows: list[dict],
        mapping: dict,
        key_fields: list[str],
        label: str,
        defaults: Optional[dict] = None,
        field_overrides: Optional[dict] = None,
    ) -> dict:
        """
        批量同步 ERP 行到目标模型。

        相比逐行 upsert 的优化点：
        1. 一次性按业务键预加载已有记录（避免每行一次 SELECT 退化为 O(N²)）
        2. 按 batch_size 分批 commit（减少 N 次 DB 往返到 N/batch_size 次）
        3. 批次失败时自动回退为逐行处理，保留单行错误隔离
        4. 每处理一定行数打印进度日志

        Args:
            model_class: 目标 ORM 模型
            raw_rows: 从 ERP 取回的原始行（_execute_erp_sql 输出）
            mapping: 字段映射
            key_fields: 业务主键字段列表，如 ["bom_id"] 或 ["bom_id", "line_no"]
            label: 日志标识
            defaults: 当某字段为空时的取值来源，如 {"bom_no": "bom_id"}
            field_overrides: 字段覆盖回调 {列名: callable(row_dict)->value}，
                用于修正不能直接信任源数据的字段（如外键列必须指向 SPC 内部
                主键，不能直接采用 ERP/OA 给出的标识）。在映射+类型转换之后、
                去重/upsert 决策之前应用。
        """
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}
        total = len(raw_rows)
        if total == 0:
            return stats

        valid_cols = self._get_model_columns(model_class)

        # 1) 映射 + 过滤 + 类型转换 + 业务键规整；按业务键去重（保留最后一条）
        deduped: dict[tuple, dict] = {}
        for row in raw_rows:
            row_dict = self._map_row(row, mapping)
            first = str(row_dict.get(key_fields[0], "")).strip()
            if not first:
                stats["skipped"] += 1
                continue
            row_dict[key_fields[0]] = first
            # 第二及后续业务键 — 如果是 nullable 字段且值为空则保持 None（不要强制填 "1"）
            # 这样支持如 (material_code, wh_code, null) 当 location_id 不存在时仍能正确去重
            for kf in key_fields[1:]:
                val = row_dict.get(kf)
                if val is None:
                    # 保持 None，不要填充默认值
                    continue
                val_str = str(val).strip()
                if not val_str:
                    # 仍为空字符串，检查该列是否可为空
                    col = getattr(model_class, kf, None)
                    if col is None or not hasattr(col, 'property') or not isinstance(col.property.column, Column):
                        # 无法判断，填充 "1" 保持兼容
                        val_str = "1"
                    else:
                        column = col.property.column
                        if column.nullable:
                            # 列允许空，保持 None
                            row_dict.pop(kf, None)
                            continue
                        # 不允许空则填 "1"
                        val_str = "1"
                row_dict[kf] = val_str
            # 默认值填充
            if defaults:
                for tgt, src in defaults.items():
                    if not row_dict.get(tgt):
                        row_dict[tgt] = row_dict.get(src)
            row_dict = self._filter_model_fields(row_dict, valid_cols)
            row_dict = self._coerce_row_types(row_dict, model_class)
            # 字段覆盖：修正不能直接信任源数据的字段（如外键列必须指向 SPC
            # 内部主键，不能直接采用 ERP/OA 给出的标识）。
            if field_overrides:
                for fld, resolver in field_overrides.items():
                    if fld in valid_cols:
                        row_dict[fld] = resolver(row_dict)
            # 剔除 NOT NULL 列的 None / 空串值，让 ORM/DB 默认值生效
            # 否则显式 None 或 '' 会覆盖 client_default(如 default=0)，
            # flush 时 INSERT NULL → integrity error → 整批失败；
            # 或对 Integer 列传 '' → asyncpg 编码失败。
            for col in model_class.__table__.columns:
                if col.nullable:
                    continue
                if col.default is not None or col.server_default is not None:
                    val = row_dict.get(col.name)
                    if val is None or (isinstance(val, str) and val.strip() == ""):
                        row_dict.pop(col.name, None)
            key = tuple(
                None if row_dict.get(f) is None else str(row_dict.get(f, "")).strip()
                for f in key_fields
            )
            deduped[key] = row_dict

        prepared = list(deduped.values())
        n = len(prepared)
        logger.info(f"{label}: 原始 {total} 条, 去重后 {n} 条待写入")

        if n == 0:
            return stats

        # 2) 一次性预加载已有记录（按第一个业务键分块 IN 查询，避免超大 IN）
        in_col = getattr(model_class, key_fields[0])
        # 业务键在上方统一转为 str 用于去重；但 IN 查询的值必须匹配列的
        # 原生 Python 类型，否则 PostgreSQL 会报
        # "operator does not exist: integer = character varying"
        # （如 MrpPlanOrder.sale_order_id 是 Integer 列）
        try:
            in_python_type = in_col.type.python_type
        except (AttributeError, NotImplementedError):
            in_python_type = str

        def _coerce_in_value(v):
            if in_python_type is str or isinstance(v, in_python_type):
                return v
            try:
                return in_python_type(v)
            except (ValueError, TypeError):
                return v

        in_values: list = []
        seen = set()
        for key in deduped.keys():
            v = key[0]
            if v not in seen:
                seen.add(v)
                in_values.append(v)

        existing_map: dict[tuple, object] = {}
        chunk = 1000
        for i in range(0, len(in_values), chunk):
            chunk_vals = [_coerce_in_value(v) for v in in_values[i:i + chunk]]
            res = await self.spc_db.execute(
                select(model_class).where(in_col.in_(chunk_vals))
            )
            for obj in res.scalars():
                k = tuple(
                    None if getattr(obj, f, None) is None
                    else str(getattr(obj, f, "")).strip()
                    for f in key_fields
                )
                existing_map[k] = obj
        logger.info(f"{label}: 预加载 {len(existing_map)} 条已有记录")

        # 3) 处理单行：更新或新增（纯内存操作，无 DB 往返）
        created_keys: set = set()

        def _process_row(row_dict: dict) -> str:
            key = tuple(
                None if row_dict.get(f) is None else str(row_dict.get(f, "")).strip()
                for f in key_fields
            )
            obj = existing_map.get(key)
            if obj is not None:
                if getattr(obj, "data_source", None) not in ("erp", None, ""):
                    return "skipped"
                for k, v in row_dict.items():
                    if k in key_fields:
                        continue
                    if v is not None and getattr(obj, k, None) != v:
                        setattr(obj, k, v)
                if hasattr(obj, "data_source"):
                    obj.data_source = "erp"
                return "updated"
            new_obj = model_class(**row_dict)
            if hasattr(new_obj, "data_source"):
                new_obj.data_source = "erp"
            self.spc_db.add(new_obj)
            existing_map[key] = new_obj
            created_keys.add(key)
            return "created"

        # 4) 分批 flush+commit；批次失败则回退逐行处理以隔离错误
        #    savepoint 必须用 `async with begin_nested()` 上下文管理器管理，
        #    否则异常时 savepoint 句柄丢失，再 session.rollback() 会让 async 事务栈/
        #    greenlet 损坏，后续所有操作都抛 "greenlet_spawn has not been called"
        #    （这是此前生产任务单同步逐行全部失败的根因）。
        batch_size = max(1, int(self.batch_size or 500))
        progress_step = max(1000, batch_size * 2)

        def _bump(status: str):
            stats[status] += 1
            stats["synced"] += 1

        idx = 0
        while idx < n:
            batch = prepared[idx:idx + batch_size]
            try:
                batch_results = []
                async with self.spc_db.begin_nested():
                    for row_dict in batch:
                        batch_results.append(_process_row(row_dict))
                    await self.spc_db.flush()
                await self.spc_db.commit()
                for status in batch_results:
                    _bump(status)
            except Exception as e:
                # 此前批次真因被静默吞掉，只能看到逐行重跑的 secondary greenlet 错误，
                # 这里必须记录，才能定位真正的数据/约束错误。
                logger.error(
                    f"{label} 批次写入失败，回退逐行处理。批次真因: {e}",
                    exc_info=True,
                )
                try:
                    await self.spc_db.rollback()
                except Exception:
                    pass
                # flush 失败时本批新增对象随 rollback 失效，
                # 需从缓存移除以便逐行重跑时重新插入
                for row_dict in batch:
                    key = tuple(
                        None if row_dict.get(f) is None else str(row_dict.get(f, "")).strip()
                        for f in key_fields
                    )
                    if key in created_keys:
                        existing_map.pop(key, None)
                        created_keys.discard(key)
                # 逐行重跑，成功才计数。
                # 关键：rollback 会把 session 内对象置为 expired；逐行重跑在同步
                # 函数 _process_row 中访问这些对象属性，会触发 async 同步懒加载，
                # 抛 "greenlet_spawn has not been called"（此前 100/100 全部失败的
                # 真因）。即便在循环前统一刷新过，任意一行失败后的 rollback 又会把
                # 其余对象重新置为 expired。因此在每次迭代内部按业务键重新拉取该行
                # 已有对象，确保属性访问不再触发懒加载。
                for row_dict in batch:
                    try:
                        async with self.spc_db.begin_nested():
                            fkey = tuple(
                                None if row_dict.get(f) is None
                                else str(row_dict.get(f, "")).strip()
                                for f in key_fields
                            )
                            if fkey not in created_keys:
                                fv = _coerce_in_value(str(row_dict.get(key_fields[0])).strip())
                                r = await self.spc_db.execute(
                                    select(model_class).where(in_col == fv)
                                )
                                matched = None
                                for cand in r.scalars():
                                    ck = tuple(
                                        None if getattr(cand, f, None) is None
                                        else str(getattr(cand, f, "")).strip()
                                        for f in key_fields
                                    )
                                    if ck == fkey:
                                        matched = cand
                                        break
                                existing_map[fkey] = matched
                            status = _process_row(row_dict)
                            await self.spc_db.flush()
                        await self.spc_db.commit()
                        _bump(status)
                    except Exception as e2:
                        try:
                            await self.spc_db.rollback()
                        except Exception:
                            pass
                        stats["errors"].append(
                            f"{label} {row_dict.get(key_fields[0])}: {e2}"
                        )
            idx += batch_size
            if idx % progress_step == 0 or idx >= n:
                logger.info(
                    f"{label} 进度: {min(idx, n)}/{n} "
                    f"(created={stats['created']}, updated={stats['updated']}, "
                    f"errors={len(stats['errors'])})"
                )
                await self._report_progress(stats)

        return stats

    # ------------------------------------------------------------------
    # 订单数据同步
    # ------------------------------------------------------------------
    async def sync_orders(
        self,
        since: Optional[datetime] = None,
        order_numbers: Optional[list[str]] = None,
        custom_params: Optional[dict] = None
    ) -> dict:
        """
        同步订单行数据

        Args:
            since: 同步指定时间之后的数据
            order_numbers: 只同步指定订单（如果提供，忽略since参数）
            custom_params: 自定义条件参数（用于SQL中的条件筛选）
        """
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("orders")

            # 构建查询参数 — 始终提供 :since 以防 SQL 中引用了该占位符
            if since is None:
                since = datetime.now() - timedelta(hours=24)
            params: dict = {"since": since}

            if order_numbers:
                # 转义单引号防止 SQL 注入
                safe_nos = [no.replace("'", "''") for no in order_numbers if no.strip()]
                order_list_str = ",".join([f"'{no}'" for no in safe_nos])
                
                # 查找真正的 ORDER BY 子句位置（不在括号内的）
                order_by_pos = -1
                paren_depth = 0
                for i in range(len(sql_text) - 8):
                    if sql_text[i] == '(':
                        paren_depth += 1
                    elif sql_text[i] == ')':
                        paren_depth -= 1
                    elif paren_depth == 0 and sql_text[i:i+9].upper() == "ORDER BY ":
                        order_by_pos = i
                        break
                
                condition = f"FContractNo IN ({order_list_str})"
                if order_by_pos > 0:
                    # 在 ORDER BY 之前插入条件
                    if "WHERE" in sql_text[:order_by_pos].upper() or "where" in sql_text[:order_by_pos]:
                        # 已有 WHERE 子句
                        sql_text = sql_text[:order_by_pos] + f" AND {condition} " + sql_text[order_by_pos:]
                    else:
                        # 无 WHERE 子句
                        sql_text = sql_text[:order_by_pos] + f" WHERE {condition} " + sql_text[order_by_pos:]
                else:
                    # 没有 ORDER BY 子句，直接追加
                    if "WHERE" in sql_text.upper() or "where" in sql_text:
                        sql_text += f" AND {condition}"
                    else:
                        sql_text += f" WHERE {condition}"
                logger.info(f"按订单筛选同步: {order_numbers}，SQL 添加条件: {condition}")

            # 添加自定义参数
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            print(f"ERP数据：{rows}")
            logger.info(f"从 ERP 获取到 {len(rows)} 条订单记录")
            valid_cols = self._get_model_columns(SaleOrder)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    order_no = str(row_dict.get("order_no", "")).strip()
                    line_no = str(row_dict.get("line_no", "")).strip()
                    raw_erp_id = row_dict.get("erp_id")
                    try:
                        erp_id = int(raw_erp_id) if raw_erp_id not in (None, "") else None
                    except (TypeError, ValueError):
                        erp_id = None
                    row_dict["order_no"] = order_no
                    row_dict["line_no"] = line_no

                    if not order_no:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    if erp_id is None:
                        stats["skipped"] += 1
                        logger.warning(f"订单缺少 erp_id，跳过: {order_no}")
                        await self.spc_db.commit()
                        continue

                    # 如果 line_no 为空，设置默认值
                    if not line_no:
                        line_no = "10"
                        row_dict["line_no"] = line_no

                    # 只保留模型字段 + 类型强转
                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, SaleOrder)

                    result = await self.spc_db.execute(
                        select(SaleOrder).where(
                            SaleOrder.erp_id == erp_id,
                        )
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            changed = {}
                            for k, v in row_dict.items():
                                if k == "order_no":
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                                    changed[k] = True

                            if changed:
                                now_str = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")
                                times = dict(existing.field_synced_at or {})
                                times.update({k: now_str for k in changed})
                                existing.field_synced_at = times

                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        order = SaleOrder(**row_dict)
                        if hasattr(order, "data_source"):
                            order.data_source = "erp"
                        self.spc_db.add(order)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"订单 {row_dict.get('order_no')}-{row_dict.get('line_no')}: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"订单同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"订单同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 订单明细同步
    # ------------------------------------------------------------------
    async def sync_order_details(
        self,
        since: Optional[datetime] = None,
        custom_params: Optional[dict] = None
    ) -> dict:
        """同步订单明细行数据到 SaleOrderLine"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("order_details")

            if since is None:
                since = datetime.now() - timedelta(hours=24)
            params: dict = {"since": since}

            if custom_params:
                params.update(custom_params)

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条订单明细记录")
            valid_cols = self._get_model_columns(SaleOrderLine)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    order_no = str(row_dict.get("order_no", "")).strip()
                    line_no = str(row_dict.get("line_no", "")).strip()
                    erp_line_id = str(row_dict.get("erp_line_id", "")).strip()
                    row_dict["order_no"] = order_no
                    row_dict["line_no"] = line_no
                    row_dict["erp_line_id"] = erp_line_id

                    if not order_no:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue
                    if not erp_line_id:
                        stats["skipped"] += 1
                        logger.warning(f"订单明细缺少 erp_line_id，跳过: {order_no}")
                        await self.spc_db.commit()
                        continue
                    if not line_no:
                        line_no = "10"
                        row_dict["line_no"] = line_no

                    # 查找关联的 SaleOrder 以获取 sale_order_id
                    # 重号场景: 明细行带 erp_id(订单头主键)则精确匹配, 否则按 order_no 取最新一张
                    raw_header_erp_id = row_dict.get("erp_id")
                    try:
                        header_erp_id = int(raw_header_erp_id) if raw_header_erp_id not in (None, "") else None
                    except (TypeError, ValueError):
                        header_erp_id = None
                    header_query = select(SaleOrder).where(SaleOrder.order_no == order_no)
                    if header_erp_id is not None:
                        header_query = header_query.where(SaleOrder.erp_id == header_erp_id)
                    else:
                        header_query = header_query.order_by(SaleOrder.id.desc())
                    sale_order_result = await self.spc_db.execute(header_query.limit(1))
                    sale_order = sale_order_result.scalar_one_or_none()
                    if not sale_order:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue
                    row_dict["sale_order_id"] = sale_order.id
                    # 冗余存订单头的 shipping_plan 到明细行, 排产以此为准
                    if sale_order.shipping_plan is not None:
                        row_dict["shipping_plan"] = sale_order.shipping_plan

                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, SaleOrderLine)

                    # 使用正确的唯一约束字段 erp_line_id 查询
                    result = await self.spc_db.execute(
                        select(SaleOrderLine).where(
                            SaleOrderLine.order_no == order_no,
                            SaleOrderLine.erp_line_id == erp_line_id,
                        )
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        for k, v in row_dict.items():
                            if k in ("order_no", "erp_line_id"):
                                continue
                            if getattr(existing, k, None) != v and v is not None:
                                setattr(existing, k, v)
                        stats["updated"] += 1
                    else:
                        line = SaleOrderLine(**row_dict)
                        self.spc_db.add(line)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"订单明细 {row_dict.get('order_no')}-{row_dict.get('erp_line_id')}: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"订单明细同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"订单明细同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 物料需求同步
    # ------------------------------------------------------------------
    async def sync_materials(
        self,
        since: Optional[datetime] = None,
        order_numbers: Optional[list[str]] = None,
        custom_params: Optional[dict] = None
    ) -> dict:
        """
        同步物料需求数据

        Args:
            since: 同步指定时间之后的数据
            order_numbers: 只同步指定订单的物料需求（如果提供，忽略since参数）
            custom_params: 自定义条件参数（用于SQL中的条件筛选）
        """
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("materials")

            # 构建查询参数 — 始终提供 :since 以防 SQL 中引用了该占位符
            if since is None:
                since = datetime.now() - timedelta(hours=24)
            params: dict = {"since": since}

            if order_numbers:
                # 转义单引号防止 SQL 注入
                safe_nos = [no.replace("'", "''") for no in order_numbers if no.strip()]
                order_list_str = ",".join([f"'{no}'" for no in safe_nos])
                
                # 查找真正的 ORDER BY 子句位置（不在括号内的）
                order_by_pos = -1
                paren_depth = 0
                for i in range(len(sql_text) - 8):
                    if sql_text[i] == '(':
                        paren_depth += 1
                    elif sql_text[i] == ')':
                        paren_depth -= 1
                    elif paren_depth == 0 and sql_text[i:i+9].upper() == "ORDER BY ":
                        order_by_pos = i
                        break
                
                condition = f"FContractNo IN ({order_list_str})"
                if order_by_pos > 0:
                    # 在 ORDER BY 之前插入条件
                    if "WHERE" in sql_text[:order_by_pos].upper() or "where" in sql_text[:order_by_pos]:
                        # 已有 WHERE 子句
                        sql_text = sql_text[:order_by_pos] + f" AND {condition} " + sql_text[order_by_pos:]
                    else:
                        # 无 WHERE 子句
                        sql_text = sql_text[:order_by_pos] + f" WHERE {condition} " + sql_text[order_by_pos:]
                else:
                    # 没有 ORDER BY 子句，直接追加
                    if "WHERE" in sql_text.upper() or "where" in sql_text:
                        sql_text += f" AND {condition}"
                    else:
                        sql_text += f" WHERE {condition}"
                logger.info(f"按订单筛选同步: {order_numbers}，SQL 添加条件: {condition}")

            # 添加自定义参数
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条物料需求记录")
            valid_cols = self._get_model_columns(MaterialDemand)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    order_no = str(row_dict.get("order_no", "")).strip()
                    line_no = str(row_dict.get("line_no", "")).strip()
                    material_code = str(row_dict.get("material_code", "")).strip()

                    if not order_no or not line_no or not material_code:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    # 计算欠料
                    req_qty = float(row_dict.get("req_qty") or 0)
                    allocated_qty = float(row_dict.get("allocated_qty") or 0)
                    shortage_qty = max(0, req_qty - allocated_qty)
                    row_dict["shortage_qty"] = shortage_qty
                    row_dict["shortage_flag"] = shortage_qty > 0

                    # 只保留模型字段 + 类型强转
                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, MaterialDemand)

                    result = await self.spc_db.execute(
                        select(MaterialDemand).where(
                            MaterialDemand.order_no == order_no,
                            MaterialDemand.line_no == line_no,
                            MaterialDemand.material_code == material_code,
                        )
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k in ("order_no", "line_no", "material_code"):
                                    continue
                                if v is not None:
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        # 检查关联订单是否存在
                        order_exists = await self.spc_db.execute(
                            select(SaleOrder).where(
                                SaleOrder.order_no == order_no,
                                SaleOrder.line_no == line_no,
                            ).limit(1)
                        )
                        if not order_exists.scalar_one_or_none():
                            stats["skipped"] += 1
                            await self.spc_db.commit()
                            continue
                        demand = MaterialDemand(**row_dict)
                        if hasattr(demand, "data_source"):
                            demand.data_source = "erp"
                        self.spc_db.add(demand)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"物料 {row_dict.get('material_code')}: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"物料需求同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"物料需求同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 采购订单同步
    # ------------------------------------------------------------------
    async def sync_purchase_orders(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步采购订单数据"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("purchase_orders")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条采购订单记录")
            valid_cols = self._get_model_columns(PurchaseOrder)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    po_no = str(row_dict.get("po_no", "")).strip()
                    if not po_no:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    # 只保留模型字段 + 类型强转
                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, PurchaseOrder)

                    source_eta = row_dict.get("eta")
                    source_original_eta = row_dict.get("original_eta") or source_eta
                    if source_original_eta:
                        row_dict["original_eta"] = source_original_eta

                    # 设置必填字段的默认值
                    if not row_dict.get("po_status"):
                        row_dict["po_status"] = "placed"
                    if not row_dict.get("detail_id"):
                        row_dict["detail_id"] = 1
                    detail_id = row_dict.get("detail_id", 1)

                    result = await self.spc_db.execute(
                        select(PurchaseOrder).where(
                            PurchaseOrder.po_no == po_no,
                            PurchaseOrder.detail_id == detail_id,
                        )
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k in {"po_no", "eta"}:
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                            existing.updated_at = datetime.now()
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        if source_original_eta and not row_dict.get("eta"):
                            row_dict["eta"] = source_original_eta
                        po = PurchaseOrder(**row_dict)
                        if not po.original_eta and po.eta:
                            po.original_eta = po.eta
                        if hasattr(po, "data_source"):
                            po.data_source = "erp"
                        self.spc_db.add(po)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"PO {row_dict.get('po_no')}: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"采购订单同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"采购订单同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 客户同步
    # ------------------------------------------------------------------
    async def sync_customers(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步客户"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("customers")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条客户记录")
            valid_cols = self._get_model_columns(Customer)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    customer_code = str(row_dict.get("customer_code", "")).strip()
                    if not customer_code:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    # 只保留模型字段 + 类型强转
                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, Customer)

                    result = await self.spc_db.execute(
                        select(Customer).where(Customer.customer_code == customer_code)
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k == "customer_code":
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        customer = Customer(**row_dict)
                        if hasattr(customer, "data_source"):
                            customer.data_source = "erp"
                        self.spc_db.add(customer)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"客户 {row_dict.get('customer_code')}: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"客户同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"客户同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 供应商同步
    # ------------------------------------------------------------------
    async def sync_suppliers(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步供应商"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("suppliers")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条供应商记录")
            valid_cols = self._get_model_columns(Supplier)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    supplier_code = str(row_dict.get("supplier_code", "")).strip()
                    if not supplier_code:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, Supplier)

                    result = await self.spc_db.execute(
                        select(Supplier).where(Supplier.supplier_code == supplier_code)
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k == "supplier_code":
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        supplier = Supplier(**row_dict)
                        if hasattr(supplier, "data_source"):
                            supplier.data_source = "erp"
                        self.spc_db.add(supplier)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"供应商 {row_dict.get('supplier_code')}: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"供应商同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"供应商同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 物料同步
    # ------------------------------------------------------------------
    async def sync_materials_masterdata(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步物料"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("materials_masterdata")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条物料记录")
            valid_cols = self._get_model_columns(Material)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    material_code = str(row_dict.get("material_code", "")).strip()
                    if not material_code:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, Material)

                    # ERP 数据可能缺少 NOT NULL 字段，填充默认值
                    row_dict.setdefault("material_type", row_dict.get("material_type") or "未分类")
                    row_dict.setdefault("unit_of_measure", row_dict.get("unit_of_measure") or "个")

                    result = await self.spc_db.execute(
                        select(Material).where(Material.material_code == material_code)
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k == "material_code":
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        material = Material(**row_dict)
                        if hasattr(material, "data_source"):
                            material.data_source = "erp"
                        self.spc_db.add(material)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"物料 {row_dict.get('material_code')}: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"物料同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"物料同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # SKU同步
    # ------------------------------------------------------------------
    async def sync_skus(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步SKU"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("skus")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条SKU记录")
            valid_cols = self._get_model_columns(SKU)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    sku_code = str(row_dict.get("sku_code", "")).strip()
                    if not sku_code:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, SKU)

                    result = await self.spc_db.execute(
                        select(SKU).where(SKU.sku_code == sku_code)
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k == "sku_code":
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        sku = SKU(**row_dict)
                        if hasattr(sku, "data_source"):
                            sku.data_source = "erp"
                        self.spc_db.add(sku)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"SKU {row_dict.get('sku_code')}: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"SKU同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"SKU同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 产品同步
    # ------------------------------------------------------------------
    async def sync_products(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步产品"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("products")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条产品记录")
            valid_cols = self._get_model_columns(Product)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    product_code = str(row_dict.get("product_code", "")).strip()
                    if not product_code:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, Product)

                    result = await self.spc_db.execute(
                        select(Product).where(Product.product_code == product_code)
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k == "product_code":
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        product = Product(**row_dict)
                        if hasattr(product, "data_source"):
                            product.data_source = "erp"
                        self.spc_db.add(product)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"产品 {row_dict.get('product_code')}: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"产品同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"产品同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # BOM同步
    # ------------------------------------------------------------------
    async def sync_boms(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步BOM"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("boms")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条BOM记录")

            stats = await self._bulk_upsert(
                Bom,
                rows,
                mapping,
                key_fields=["bom_id"],
                label="BOM",
                defaults={"bom_no": "bom_id"},
            )

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"BOM同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"BOM同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # BOM明细同步
    # ------------------------------------------------------------------
    async def sync_bom_details(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步BOM明细行数据到 BomDetail"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("bom_details")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条BOM明细记录")

            stats = await self._bulk_upsert(
                BomDetail,
                rows,
                mapping,
                key_fields=["bom_id", "line_no"],
                label="BOM明细",
            )

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"BOM明细同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"BOM明细同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 仓库同步
    # ------------------------------------------------------------------
    async def sync_warehouses(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步仓库"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("warehouses")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条仓库记录")
            valid_cols = self._get_model_columns(Warehouse)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    wh_id = row_dict.get("wh_id")
                    wh_code = str(row_dict.get("wh_code", "")).strip()
                    if not wh_id and not wh_code:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, Warehouse)

                    existing = None
                    if wh_id:
                        result = await self.spc_db.execute(
                            select(Warehouse).where(Warehouse.wh_id == wh_id)
                        )
                        existing = result.scalar_one_or_none()
                    if not existing and wh_code:
                        result = await self.spc_db.execute(
                            select(Warehouse).where(Warehouse.wh_code == wh_code)
                        )
                        existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k in ("wh_id", "wh_code"):
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        warehouse = Warehouse(**row_dict)
                        if hasattr(warehouse, "data_source"):
                            warehouse.data_source = "erp"
                        self.spc_db.add(warehouse)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"仓库 {row_dict.get('wh_code')}: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"仓库同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"仓库同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 库位同步
    # ------------------------------------------------------------------
    async def sync_locations(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步库位"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("locations")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条库位记录")
            valid_cols = self._get_model_columns(Location)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    location_id = row_dict.get("location_id")
                    if not location_id:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, Location)

                    result = await self.spc_db.execute(
                        select(Location).where(Location.location_id == location_id)
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k == "location_id":
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        location = Location(**row_dict)
                        if hasattr(location, "data_source"):
                            location.data_source = "erp"
                        self.spc_db.add(location)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"库位 {row_dict.get('location_id')}: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"库位同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"库位同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 工序同步
    # ------------------------------------------------------------------
    async def sync_processes(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步工序"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("processes")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条工序记录")
            valid_cols = self._get_model_columns(Process)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    process_code = str(row_dict.get("process_code", "")).strip()
                    if not process_code:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, Process)

                    result = await self.spc_db.execute(
                        select(Process).where(Process.process_code == process_code)
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k == "process_code":
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        process = Process(**row_dict)
                        if hasattr(process, "data_source"):
                            process.data_source = "erp"
                        self.spc_db.add(process)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"工序 {row_dict.get('process_code')}: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"工序同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"工序同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 组织同步
    # ------------------------------------------------------------------
    async def sync_organizations(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步组织"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("organizations")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条组织记录")
            logger.info(f"原始ERP数据: {rows}")
            valid_cols = self._get_model_columns(Organization)
            logger.info(f"有效字段: {valid_cols}")

            # 第一次遍历：先创建/更新所有组织，但暂时不处理 parent_id
            org_list = []
            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    logger.info(f"映射后数据: {row_dict}")
                    
                    # 优先使用 org_code，如果没有则使用 oa_org_id
                    org_code = str(row_dict.get("org_code", "")).strip()
                    if not org_code:
                        oa_org_id = row_dict.get("oa_org_id")
                        if oa_org_id:
                            org_code = str(oa_org_id)
                            row_dict["org_code"] = org_code
                            logger.info(f"使用 oa_org_id 作为 org_code: {org_code}")
                        else:
                            logger.warning(f"组织编码为空且 oa_org_id 也为空，跳过: {row_dict}")
                            stats["skipped"] += 1
                            await self.spc_db.commit()
                            continue

                    # 保存原始 parent_id（ERP 的 oa_org_id）
                    original_parent_oa_id = row_dict.get("parent_id")
                    
                    # 确保必填字段有值
                    if not row_dict.get("org_name"):
                        row_dict["org_name"] = org_code
                    if not row_dict.get("org_type"):
                        row_dict["org_type"] = "未知"
                    if not row_dict.get("status"):
                        row_dict["status"] = 1
                    
                    # 暂时把 parent_id 设为 None，后续再处理
                    row_dict["parent_id"] = None

                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, Organization)
                    logger.info(f"最终处理数据: {row_dict}")

                    result = await self.spc_db.execute(
                        select(Organization).where(Organization.org_code == org_code)
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k == "org_code":
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        organization = Organization(**row_dict)
                        if hasattr(organization, "data_source"):
                            organization.data_source = "erp"
                        self.spc_db.add(organization)
                        stats["created"] += 1

                    org_list.append({
                        "org_code": org_code,
                        "oa_org_id": row_dict.get("oa_org_id"),
                        "original_parent_oa_id": original_parent_oa_id
                    })
                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"组织 {row_dict.get('org_code')}: {e}")
                    logger.exception(f"组织同步错误: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            
            # 第二次遍历：更新 parent_id 映射
            # 先建立 oa_org_id 到 SPC id 的映射
            oa_id_to_spc_id = {}
            all_orgs_result = await self.spc_db.execute(select(Organization))
            for org in all_orgs_result.scalars().all():
                if org.oa_org_id:
                    oa_id_to_spc_id[str(org.oa_org_id)] = org.id
            
            # 更新每个组织的 parent_id
            for org_info in org_list:
                try:
                    result = await self.spc_db.execute(
                        select(Organization).where(Organization.org_code == org_info["org_code"])
                    )
                    org = result.scalar_one_or_none()
                    if org and org_info["original_parent_oa_id"]:
                        parent_spc_id = oa_id_to_spc_id.get(str(org_info["original_parent_oa_id"]))
                        if parent_spc_id:
                            org.parent_id = parent_spc_id
                except Exception as e:
                    logger.exception(f"更新组织 parent_id 错误: {e}")
            
            await self.spc_db.commit()
            logger.info(f"组织同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"组织同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 人员同步
    # ------------------------------------------------------------------
    async def _resolve_position_id(self, row_dict: dict) -> Optional[int]:
        oa_position_id = str(row_dict.get("oa_position_id", "") or "").strip()
        position_code = str(row_dict.get("position_code", "") or "").strip()
        position_name = str(row_dict.get("position", "") or row_dict.get("position_name", "") or "").strip()
        if position_name and not row_dict.get("position"):
            row_dict["position"] = position_name

        if oa_position_id:
            result = await self.spc_db.execute(select(Position).where(Position.oa_position_id == oa_position_id))
            position = result.scalar_one_or_none()
            if position:
                row_dict["position"] = position.position_name
                return position.id

        if position_code:
            result = await self.spc_db.execute(select(Position).where(Position.position_code == position_code))
            position = result.scalar_one_or_none()
            if position:
                row_dict["position"] = position.position_name
                return position.id

        if position_name:
            result = await self.spc_db.execute(select(Position).where(Position.position_name == position_name))
            positions = result.scalars().all()
            if len(positions) == 1:
                return positions[0].id
            if len(positions) > 1:
                logger.warning(f"[员工同步] 岗位名称匹配到多条记录，跳过 position_id 回填: {position_name}")

        return None

    async def sync_positions(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """Sync positions from OA/ERP SQL config."""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("positions")

            params = {"since": since or datetime.now() - timedelta(days=30)}
            if custom_params:
                params.update(custom_params)

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"[岗位同步] 从ERP/OA获取到 {len(rows)} 条岗位记录")
            valid_cols = self._get_model_columns(Position)

            for row in rows:
                row_dict = {}
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    position_code = str(row_dict.get("position_code", "") or "").strip() or None
                    oa_position_id = str(row_dict.get("oa_position_id", "") or "").strip() or None
                    position_name = str(row_dict.get("position_name", "") or "").strip() or None
                    if not (position_code or oa_position_id or position_name):
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue
                    row_dict["position_code"] = position_code
                    if "oa_position_id" in row_dict:
                        row_dict["oa_position_id"] = oa_position_id
                    if not row_dict.get("position_name"):
                        row_dict["position_name"] = position_code or oa_position_id
                    if row_dict.get("status") is None:
                        row_dict["status"] = 1

                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, Position)

                    existing = None
                    if oa_position_id:
                        result = await self.spc_db.execute(
                            select(Position).where(Position.oa_position_id == oa_position_id)
                        )
                        existing = result.scalar_one_or_none()
                    if not existing and position_code:
                        result = await self.spc_db.execute(
                            select(Position).where(Position.position_code == position_code)
                        )
                        existing = result.scalar_one_or_none()
                    if not existing and position_name:
                        result = await self.spc_db.execute(
                            select(Position).where(Position.position_name == position_name)
                        )
                        positions = result.scalars().all()
                        if len(positions) == 1:
                            existing = positions[0]

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k in ("position_code", "oa_position_id") and v is None:
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        position = Position(**row_dict)
                        if hasattr(position, "data_source"):
                            position.data_source = "erp"
                        self.spc_db.add(position)
                        await self.spc_db.flush()
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(
                        f"岗位 {row_dict.get('position_code') or row_dict.get('oa_position_id') or row_dict.get('position_name')}: {e}"
                    )

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"[岗位同步] 完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"[岗位同步] 异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    async def sync_employees(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步人员（仅更新员工数据，不自动创建/更新系统用户。系统用户由管理员在用户管理页面手动开通）"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        logger.info(f"[员工同步] 开始同步人员 since={since}")
        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("employees")

            if since is None:
                since = datetime(1900, 1, 1)  # 全量同步使用最早时间

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"[员工同步] 使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"[员工同步] 从 ERP 获取到 {len(rows)} 条人员记录")
            valid_cols = self._get_model_columns(Employee)

            for idx, row in enumerate(rows):
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    resolved_position_id = await self._resolve_position_id(row_dict)
                    if resolved_position_id:
                        row_dict["position_id"] = resolved_position_id
                    row_dict.pop("position_code", None)
                    row_dict.pop("position_name", None)
                    emp_code = str(row_dict.get("emp_code", "")).strip()
                    oa_user_id = str(row_dict.get("oa_user_id", "")).strip()
                    login_id = str(row_dict.get("login_id", "")).strip()
                    emp_name = row_dict.get("emp_name", "")

                    existing = None
                    # 尝试多种方式查找现有员工
                    if emp_code:
                        result = await self.spc_db.execute(
                            select(Employee).where(Employee.emp_code == emp_code)
                        )
                        existing = result.scalar_one_or_none()
                    if not existing and oa_user_id:
                        result = await self.spc_db.execute(
                            select(Employee).where(Employee.oa_user_id == oa_user_id)
                        )
                        existing = result.scalar_one_or_none()
                    if not existing and login_id:
                        result = await self.spc_db.execute(
                            select(Employee).where(Employee.login_id == login_id)
                        )
                        existing = result.scalar_one_or_none()

                    if not emp_code and not existing:
                        # 如果是新记录且 emp_code 为空，尝试用 oa_user_id 或 login_id 填充
                        if oa_user_id:
                            emp_code = oa_user_id
                            row_dict["emp_code"] = emp_code
                            logger.info(f"[员工同步] 第{idx+1}条记录 emp_code 为空，使用 oa_user_id 填充: {emp_code}")
                        elif login_id:
                            emp_code = login_id
                            row_dict["emp_code"] = emp_code
                            logger.info(f"[员工同步] 第{idx+1}条记录 emp_code 为空，使用 login_id 填充: {emp_code}")
                        else:
                            # 所有标识都为空，生成临时 emp_code
                            import uuid
                            temp_emp_code = f"TEMP_{uuid.uuid4().hex[:8]}"
                            emp_code = temp_emp_code
                            row_dict["emp_code"] = emp_code
                            logger.warning(f"[员工同步] 第{idx+1}条记录所有标识为空，生成临时 emp_code: {temp_emp_code}")

                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, Employee)

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            changes = []
                            for k, v in row_dict.items():
                                if k == "emp_code":
                                    # 如果原记录 emp_code 为空，而新值有值，则更新
                                    if not getattr(existing, k, None) and v:
                                        changes.append(f"{k}: {getattr(existing, k, None)}->{v}")
                                        setattr(existing, k, v)
                                    continue
                                old_val = getattr(existing, k, None)
                                if old_val != v and v is not None:
                                    changes.append(f"{k}: {old_val}->{v}")
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                            logger.info(f"[员工同步] 更新员工 emp_code={existing.emp_code} emp_name={emp_name} 变更字段: {', '.join(changes) if changes else '无字段变更'}")
                        else:
                            stats["skipped"] += 1
                            logger.info(f"[员工同步] 跳过员工 emp_code={existing.emp_code} emp_name={emp_name} 原因: 数据来源为 {getattr(existing, 'data_source', None)} 非 ERP")
                    else:
                        employee = Employee(**row_dict)
                        if hasattr(employee, "data_source"):
                            employee.data_source = "erp"
                        self.spc_db.add(employee)
                        stats["created"] += 1
                        logger.info(f"[员工同步] 创建员工 emp_code={emp_code} emp_name={emp_name}")

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"人员 {row_dict.get('emp_code')}: {e}")
                    logger.error(f"[员工同步] 处理第{idx+1}条记录异常 emp_code={row_dict.get('emp_code')} 错误: {e}")

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"[员工同步] 完成同步: 共处理{len(rows)}条记录 created={stats['created']} updated={stats['updated']} skipped={stats['skipped']} errors={len(stats['errors'])}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"人员同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 员工-部门关系同步
    # ------------------------------------------------------------------
    async def sync_employee_organizations(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步员工-部门关系，并回填 Employee.org_id 为主部门ID"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": [], "org_id_backfilled": 0}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("employee_organizations")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条员工-部门关系记录")
            valid_cols = self._get_model_columns(EmployeeOrganization)

            for row in rows:
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    emp_code = str(row_dict.get("emp_code", "")).strip()
                    org_code = str(row_dict.get("org_code", "")).strip()
                    if not emp_code or not org_code:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    # 验证员工和组织是否存在
                    emp_result = await self.spc_db.execute(
                        select(Employee).where(Employee.emp_code == emp_code)
                    )
                    emp = emp_result.scalar_one_or_none()
                    if not emp:
                        stats["skipped"] += 1
                        logger.warning(f"员工-部门关系跳过: 员工 {emp_code} 不存在")
                        await self.spc_db.commit()
                        continue

                    org_result = await self.spc_db.execute(
                        select(Organization).where(Organization.org_code == org_code)
                    )
                    org = org_result.scalar_one_or_none()
                    if not org:
                        stats["skipped"] += 1
                        logger.warning(f"员工-部门关系跳过: 组织 {org_code} 不存在")
                        await self.spc_db.commit()
                        continue

                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, EmployeeOrganization)

                    # upsert 关联记录
                    result = await self.spc_db.execute(
                        select(EmployeeOrganization).where(
                            EmployeeOrganization.emp_code == emp_code,
                            EmployeeOrganization.org_code == org_code,
                        )
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k in ("emp_code", "org_code"):
                                    continue
                                if getattr(existing, k, None) != v and v is not None:
                                    setattr(existing, k, v)
                            if hasattr(existing, "data_source"):
                                existing.data_source = "erp"
                            stats["updated"] += 1
                        else:
                            stats["skipped"] += 1
                    else:
                        rel = EmployeeOrganization(**row_dict)
                        if hasattr(rel, "data_source"):
                            rel.data_source = "erp"
                        self.spc_db.add(rel)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(f"员工部门关系 {row_dict.get('emp_code')}-{row_dict.get('org_code')}: {e}")

            await self.spc_db.flush()

            # 回填 Employee.org_id：对每个员工取 is_primary=1 的关联记录，
            # 赋值为 scm_organization.oa_org_id（与代码库其他地方保持一致，
            # 如用户列表查询按 Employee.org_id == Organization.oa_org_id 关联）
            primary_result = await self.spc_db.execute(
                select(EmployeeOrganization).where(EmployeeOrganization.is_primary == 1)
            )
            primary_rels = primary_result.scalars().all()
            for rel in primary_rels:
                org_result = await self.spc_db.execute(
                    select(Organization).where(Organization.org_code == rel.org_code)
                )
                org = org_result.scalar_one_or_none()
                if org:
                    emp_result = await self.spc_db.execute(
                        select(Employee).where(Employee.emp_code == rel.emp_code)
                    )
                    emp = emp_result.scalar_one_or_none()
                    if emp:
                        # Employee.org_id 存 oa_org_id（转为整数），而非 Organization.id
                        if org.oa_org_id:
                            try:
                                target_org_id = int(org.oa_org_id)
                            except (ValueError, TypeError):
                                target_org_id = org.id
                        else:
                            target_org_id = org.id
                        if emp.org_id != target_org_id:
                            emp.org_id = target_org_id
                            stats["org_id_backfilled"] += 1

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"员工-部门关系同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"员工-部门关系同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 采购开票同步
    # ------------------------------------------------------------------
    async def sync_purchase_invoices(
        self, since: Optional[datetime] = None, custom_params: Optional[dict] = None
    ) -> dict:
        """同步采购开票数据。幂等依据: (invoice_no, line_no) 复合唯一键。"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("purchase_invoices")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条采购开票记录")
            valid_cols = self._get_model_columns(PurchaseInvoice)

            for row in rows:
                row_dict: dict = {}
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    invoice_no = str(row_dict.get("invoice_no", "")).strip()
                    line_no = str(row_dict.get("line_no", "")).strip()
                    if not invoice_no or not line_no:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    # 统一类型
                    row_dict["invoice_no"] = invoice_no
                    row_dict["line_no"] = line_no
                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, PurchaseInvoice)

                    result = await self.spc_db.execute(
                        select(PurchaseInvoice).where(
                            PurchaseInvoice.invoice_no == invoice_no,
                            PurchaseInvoice.line_no == line_no,
                        )
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        changed = False
                        for k, v in row_dict.items():
                            if k in ("invoice_no", "line_no"):
                                continue
                            if v is not None and getattr(existing, k, None) != v:
                                setattr(existing, k, v)
                                changed = True
                        if changed:
                            stats["updated"] += 1
                        else:
                            existing.updated_at = datetime.now()
                            stats["skipped"] += 1
                    else:
                        invoice = PurchaseInvoice(**row_dict)
                        self.spc_db.add(invoice)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(
                        f"采购开票 {row_dict.get('invoice_no')}-{row_dict.get('line_no')}: {e}"
                    )

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"采购开票同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"采购开票同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 付款申请同步
    # ------------------------------------------------------------------
    async def sync_payment_applies(
        self, since: Optional[datetime] = None, custom_params: Optional[dict] = None
    ) -> dict:
        """同步付款申请数据。幂等依据: payment_apply_no。"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("payment_applies")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条付款申请记录")
            valid_cols = self._get_model_columns(PaymentApply)

            for row in rows:
                row_dict: dict = {}
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    payment_apply_no = str(row_dict.get("payment_apply_no", "")).strip()
                    if not payment_apply_no:
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue

                    # 统一类型
                    row_dict["payment_apply_no"] = payment_apply_no
                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    row_dict = self._coerce_row_types(row_dict, PaymentApply)

                    result = await self.spc_db.execute(
                        select(PaymentApply).where(
                            PaymentApply.payment_apply_no == payment_apply_no
                        )
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        changed = False
                        for k, v in row_dict.items():
                            if k == "payment_apply_no":
                                continue
                            if v is not None and getattr(existing, k, None) != v:
                                setattr(existing, k, v)
                                changed = True
                        if changed:
                            stats["updated"] += 1
                        else:
                            existing.updated_at = datetime.now()
                            stats["skipped"] += 1
                    else:
                        row_dict.setdefault("data_source", "erp")
                        apply = PaymentApply(**row_dict)
                        self.spc_db.add(apply)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(
                        f"付款申请 {row_dict.get('payment_apply_no')}: {e}"
                    )

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"付款申请同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"付款申请同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 品质异常同步
    # ------------------------------------------------------------------
    async def sync_quality_issues(
        self, since: Optional[datetime] = None, custom_params: Optional[dict] = None
    ) -> dict:
        """同步品质异常数据。幂等依据: ERP品质异常ID。"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "soft_deleted": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("quality_issues")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条品质异常记录")
            valid_cols = self._get_model_columns(QualityIssue)

            issue_counters: dict[str, int] = {}

            for row in rows:
                row_dict: dict = {}
                try:
                    await self.spc_db.begin_nested()
                    row_dict = self._map_row(row, mapping)
                    logger.info(f"映射后数据: {row_dict}")
                    erp_quality_id = str(row_dict.get("erp_quality_id", "")).strip()
                    issue_no = str(row_dict.get("issue_no", "")).strip()
                    if not erp_quality_id:
                        logger.warning(f"跳过: ERP品质异常ID为空, row: {row_dict}")
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue
                    
                    # 如果 ERP 数据中没有 issue_no，自动生成
                    if not issue_no:
                        submit_date = row_dict.get("submit_date")
                        if submit_date:
                            date_str = str(submit_date).replace("-", "")[:8]
                        else:
                            date_str = datetime.now().strftime("%Y%m%d")
                        if date_str not in issue_counters:
                            result = await self.spc_db.execute(
                                select(QualityIssue.issue_no)
                                .where(QualityIssue.issue_no.like(f"QI-{date_str}-%"))
                                .order_by(QualityIssue.issue_no.desc())
                                .limit(1)
                            )
                            max_issue_no = result.scalar_one_or_none()
                            issue_counters[date_str] = int(max_issue_no.rsplit("-", 1)[-1]) if max_issue_no else 0
                        issue_counters[date_str] += 1
                        issue_counter = issue_counters[date_str]
                        issue_no = f"QI-{date_str}-{issue_counter:04d}"
                        logger.info(f"自动生成 issue_no: {issue_no}")
                    
                    row_dict["erp_quality_id"] = erp_quality_id
                    row_dict["issue_no"] = issue_no
                    _imp_date = row_dict.get("improvement_countermeasures_date")
                    if _imp_date and str(_imp_date).strip().lower() not in ("", "none", "null", "0"):
                        row_dict["status"] = "closed"
                    else:
                        row_dict["status"] = row_dict.get("status") or "open"
                    row_dict = self._filter_model_fields(row_dict, valid_cols)
                    logger.info(f"过滤后数据: {row_dict}")
                    if not row_dict:
                        logger.warning(f"跳过: 过滤后无有效字段, issue_no: {issue_no}")
                        stats["skipped"] += 1
                        await self.spc_db.commit()
                        continue
                    row_dict = self._coerce_row_types(row_dict, QualityIssue)
                    logger.info(f"类型强转后数据: {row_dict}")

                    result = await self.spc_db.execute(
                        select(QualityIssue).where(QualityIssue.erp_quality_id == erp_quality_id)
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        # ERP sync guard: 只覆盖 ERP 来源/空的记录, 不动 manual/excel
                        if getattr(existing, "data_source", None) in ("erp", None, ""):
                            for k, v in row_dict.items():
                                if k in ("erp_quality_id", "issue_no"):
                                    continue
                                if v is not None:
                                    setattr(existing, k, v)
                            existing.data_source = "erp"
                            # 复活: ERP 端恢复的记录自动解除软删
                            if getattr(existing, "is_deleted", False):
                                existing.is_deleted = False
                            stats["updated"] += 1
                        else:
                            logger.info(
                                f"跳过品质异常更新 issue_no={getattr(existing, 'issue_no', None)}: "
                                f"数据来源为 {getattr(existing, 'data_source', None)} 非 ERP"
                            )
                            stats["skipped"] += 1
                    else:
                        row_dict.setdefault("data_source", "erp")
                        qi = QualityIssue(**row_dict)
                        self.spc_db.add(qi)
                        stats["created"] += 1

                    stats["synced"] += 1
                    await self.spc_db.commit()
                except Exception as e:
                    try:
                        await self.spc_db.rollback()
                    except Exception:
                        pass
                    stats["errors"].append(
                        f"品质异常 {row_dict.get('issue_no')}: {e}"
                    )
                    logger.exception(f"处理品质异常失败: {row_dict}")

            await self.spc_db.flush()
            await self.spc_db.commit()

            # ---- 删除检测 (方案C): 全量比对 erp_quality_id, 软删本地多余记录 ----
            try:
                optional = await self._load_optional_sql_config("quality_issues_ids")
                if optional is None:
                    logger.info("品质异常删除检测: 未配置 quality_issues_ids SQL, 跳过")
                else:
                    id_sql, id_mapping = optional
                    id_rows = await self._execute_erp_sql(id_sql, {})
                    erp_ids = set()
                    for r in id_rows:
                        mapped = self._map_row(r, id_mapping)
                        eid = str(mapped.get("erp_quality_id", "")).strip()
                        if eid:
                            erp_ids.add(eid)
                    logger.info(f"品质异常删除检测: ERP 端共 {len(erp_ids)} 条")

                    # 安全护栏: ERP id 集合为空时绝不软删(避免误清全表)
                    if erp_ids:
                        existing_result = await self.spc_db.execute(
                            select(QualityIssue).where(
                                QualityIssue.data_source == "erp",
                                QualityIssue.is_deleted == False,
                            )
                        )
                        soft_deleted = 0
                        for qi in existing_result.scalars().all():
                            eid = str(qi.erp_quality_id or "").strip()
                            if eid and eid not in erp_ids:
                                qi.is_deleted = True
                                soft_deleted += 1
                        if soft_deleted:
                            await self.spc_db.flush()
                            await self.spc_db.commit()
                        stats["soft_deleted"] = soft_deleted
                        logger.info(f"品质异常删除检测: 软删 {soft_deleted} 条 ERP 中已不存在的记录")
                    else:
                        logger.warning("品质异常删除检测: ERP 端 id 集合为空, 跳过(避免误删全表)")
            except Exception as de:
                logger.warning(f"品质异常删除检测失败(不影响已完成的增量同步): {de}")

            logger.info(f"品质异常同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"品质异常同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # MRP计划订单同步
    # ------------------------------------------------------------------
    async def sync_mrp_plan_orders(
        self, since: Optional[datetime] = None, custom_params: Optional[dict] = None
    ) -> dict:
        """同步MRP计划订单数据。幂等依据: sale_order_id + material_id 联合主键。"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("mrp_plan_orders")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条MRP计划订单记录")

            stats = await self._bulk_upsert(
                MrpPlanOrder,
                rows,
                mapping,
                key_fields=["sale_order_id", "material_id"],
                label="MRP计划订单",
            )

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"MRP计划订单同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"MRP计划订单同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # OA 生产任务单同步
    # ------------------------------------------------------------------
    async def sync_production_task_orders(
        self, since: Optional[datetime] = None, custom_params: Optional[dict] = None
    ) -> dict:
        """同步 OA 生产任务单数据。幂等依据: task_id 唯一。"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("production_task_orders")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 OA/ERP 获取到 {len(rows)} 条生产任务单记录")

            # sale_order_id 直接采用 ERP 同步数据里给出的值（按 field_mapping_json
            # 映射后的结果），不做二次覆盖。
            stats = await self._bulk_upsert(
                ProductionTaskOrder,
                rows,
                mapping,
                key_fields=["task_id"],
                label="生产任务单",
            )

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"生产任务单同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"生产任务单同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 生产日报表同步
    # ------------------------------------------------------------------
    async def sync_production_daily_reports(
        self, since: Optional[datetime] = None, custom_params: Optional[dict] = None
    ) -> dict:
        """同步生产日报表数据。幂等依据: oa_id 唯一。"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("production_daily_reports")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 OA/ERP 获取到 {len(rows)} 条生产日报表记录")

            stats = await self._bulk_upsert(
                ProductionDailyReport,
                rows,
                mapping,
                key_fields=["oa_id"],
                label="生产日报表",
            )

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"生产日报表同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"生产日报表同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 工价审核数据同步
    # ------------------------------------------------------------------
    async def sync_labor_price_audits(
        self, since: Optional[datetime] = None, custom_params: Optional[dict] = None
    ) -> dict:
        """同步工价审核数据。幂等依据: labor_price_code 唯一。"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("labor_price_audits")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条工价审核记录")

            stats = await self._bulk_upsert(
                ProductionLaborPriceAudit,
                rows,
                mapping,
                key_fields=["labor_price_code"],
                label="工价审核",
            )

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"工价审核数据同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"工价审核数据同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 即时库存同步
    # ------------------------------------------------------------------
    async def sync_inventory(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步即时库存余额（全量覆盖快照）。幂等依据: (material_id, wh_id, location_id)。"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("inventory")

            params = {}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条即时库存记录")

            if rows and len(rows) > 0:
                sample_row = rows[0]
                logger.info(f"即时库存 原始第一行(前5字段): {dict(list(sample_row.items())[:5])}")
                logger.info(f"即时库存 字段映射: {mapping}")
                sample_mapped = self._map_row(sample_row, mapping)
                logger.info(f"即时库存 映射后第一行: {sample_mapped}")

            erp_keys: set[tuple] = set()

            stats = await self._bulk_upsert(
                Inventory,
                rows,
                mapping,
                key_fields=["material_id", "wh_id", "location_id"],
                label="即时库存",
            )

            valid_cols = self._get_model_columns(Inventory)
            for row in rows:
                row_dict = self._map_row(row, mapping)
                mid = row_dict.get("material_id")
                wid = row_dict.get("wh_id")
                lid = row_dict.get("location_id")
                if mid and wid:
                    erp_keys.add((mid, wid, lid))

            if erp_keys:
                all_existing = await self.spc_db.execute(
                    select(Inventory).where(Inventory.data_source == "erp")
                )
                all_existing_list = all_existing.scalars().all()
                deleted_count = 0
                for inv in all_existing_list:
                    key = (inv.material_id, inv.wh_id, inv.location_id)
                    if key not in erp_keys:
                        await self.spc_db.delete(inv)
                        deleted_count += 1
                if deleted_count:
                    await self.spc_db.flush()
                    await self.spc_db.commit()
                    logger.info(f"即时库存清理: 删除 {deleted_count} 条ERP中已不存在的库存记录")

            logger.info(f"即时库存同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"即时库存同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 科目余额同步
    # ------------------------------------------------------------------
    async def sync_subject_balances(
        self, since: Optional[datetime] = None, custom_params: Optional[dict] = None
    ) -> dict:
        """同步科目余额（按期间 upsert，保留历史）。幂等依据:
        (subject_id, item_code, fiscal_year, fiscal_month)。

        核算项目代码(item_code)为空时统一归一化为 "0"，使 NULL 与 ''
        落到同一去重键与存储值上（_bulk_upsert 对 NOT NULL 空键默认填 "1"，
        这里在传入前显式规整为 "0" 以保持语义一致）。
        """
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("subject_balances")

            params = {}
            if custom_params:
                params.update(custom_params)
                logger.info(f"科目余额使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条科目余额记录")

            # 归一化 item_code：定位 ERP 源字段（显式映射或身份映射）
            item_code_sources = ["item_code"]
            for src, tgt in (mapping or {}).items():
                t = tgt.get("target") if isinstance(tgt, dict) else tgt
                if t == "item_code":
                    item_code_sources = [src]
                    break
            for row in rows:
                for src in item_code_sources:
                    val = row.get(src)
                    if val is None or str(val).strip() == "":
                        row[src] = "0"

            stats = await self._bulk_upsert(
                SubjectBalance,
                rows,
                mapping,
                key_fields=["subject_id", "item_code", "fiscal_year", "fiscal_month"],
                label="科目余额",
            )

            logger.info(f"科目余额同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"科目余额同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 委外订单同步
    # ------------------------------------------------------------------
    async def sync_subcontract_orders(
        self, since: Optional[datetime] = None, custom_params: Optional[dict] = None
    ) -> dict:
        """同步委外订单数据。幂等依据: bill_no。"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("subcontract_orders")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条委外订单记录")

            stats = await self._bulk_upsert(
                SubcontractOrder,
                rows,
                mapping,
                key_fields=["bill_no"],
                label="委外订单",
            )

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"委外订单同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"委外订单同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 委外订单明细同步
    # ------------------------------------------------------------------
    async def sync_subcontract_order_details(
        self, since: Optional[datetime] = None, custom_params: Optional[dict] = None
    ) -> dict:
        """同步委外订单明细数据。幂等依据: (erp_order_id, detail_id)。"""
        stats = {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": []}

        try:
            await self._connect_erp()
            sql_text, mapping = await self._load_sql_config("subcontract_order_details")

            if since is None:
                since = datetime.now() - timedelta(hours=24)

            params = {"since": since}
            if custom_params:
                params.update(custom_params)
                logger.info(f"使用自定义参数: {custom_params}")

            rows = await self._execute_erp_sql(sql_text, params)
            logger.info(f"从 ERP 获取到 {len(rows)} 条委外订单明细记录")

            stats = await self._bulk_upsert(
                SubcontractOrderDetail,
                rows,
                mapping,
                key_fields=["erp_order_id", "detail_id"],
                label="委外订单明细",
            )

            await self.spc_db.flush()
            await self.spc_db.commit()
            logger.info(f"委外订单明细同步完成: {stats}")

        except Exception as e:
            stats["errors"].append(str(e))
            logger.exception(f"委外订单明细同步异常: {e}")
        finally:
            self._close_erp(keep_alive=True)

        return stats

    # ------------------------------------------------------------------
    # 全量同步
    # ------------------------------------------------------------------
    async def sync_all(self, since: Optional[datetime] = None, custom_params: Optional[dict] = None) -> dict:
        """同步所有已配置的数据类型，复用单个 ERP 连接"""
        try:
            await self._connect_erp()
            results = {}
            results["orders"] = await self.sync_orders(since, None, custom_params)
            results["order_details"] = await self.sync_order_details(since, custom_params)
            results["materials"] = await self.sync_materials(since, None, custom_params)
            results["purchase_orders"] = await self.sync_purchase_orders(since, custom_params)
            results["customers"] = await self.sync_customers(since, custom_params)
            results["suppliers"] = await self.sync_suppliers(since, custom_params)
            results["materials_masterdata"] = await self.sync_materials_masterdata(since, custom_params)
            results["skus"] = await self.sync_skus(since, custom_params)
            results["products"] = await self.sync_products(since, custom_params)
            results["boms"] = await self.sync_boms(since, custom_params)
            results["bom_details"] = await self.sync_bom_details(since, custom_params)
            results["warehouses"] = await self.sync_warehouses(since, custom_params)
            results["locations"] = await self.sync_locations(since, custom_params)
            results["processes"] = await self.sync_processes(since, custom_params)
            results["organizations"] = await self.sync_organizations(since, custom_params)
            results["positions"] = await self.sync_positions(since, custom_params)
            results["employees"] = await self.sync_employees(since, custom_params)
            results["employee_organizations"] = await self.sync_employee_organizations(since, custom_params)
            results["purchase_invoices"] = await self.sync_purchase_invoices(since, custom_params)
            results["payment_applies"] = await self.sync_payment_applies(since, custom_params)
            results["quality_issues"] = await self.sync_quality_issues(since, custom_params)
            results["mrp_plan_orders"] = await self.sync_mrp_plan_orders(since, custom_params)
            results["production_task_orders"] = await self.sync_production_task_orders(since, custom_params)
            results["inventory"] = await self.sync_inventory(since, custom_params)
            results["subcontract_orders"] = await self.sync_subcontract_orders(since, custom_params)
            results["subcontract_order_details"] = await self.sync_subcontract_order_details(since, custom_params)
            return results
        finally:
            self._close_erp()
