from __future__ import annotations

import asyncio
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.production.product_process_capacity import (
    ProductProcessCapacity,
    build_capacity_metadata_remark,
    parse_capacity_metadata,
    resolve_capacity_upph,
)
from app.models.production.schedule_plan import ProductionSchedulePlan
from app.services.basicdata.erp_sync_service import ERPConnectionError, ERPSyncService
from app.services.production.upph_formula_config_service import UpphFormulaConfigService


class ProductProcessCapacitySyncService:
    """从 OA 同步工序产能到 product_process_capacity。"""

    OA_SOURCE = "OA"
    OA_DEPARTMENT_TABLE = "HrmDepartment"
    def __init__(self, db: AsyncSession):
        self.db = db
        self.erp_service = ERPSyncService(db)

    async def sync_from_oa(self, *, incremental_since: Optional[datetime] = None) -> dict[str, Any]:
        sync_batch_no = f"OAUPPH{datetime.now():%Y%m%d%H%M%S}"
        sync_time = datetime.now()
        is_incremental = incremental_since is not None
        stats = {
            "sync_batch_no": sync_batch_no,
            "sync_mode": "incremental" if is_incremental else "full",
            "incremental_since": incremental_since.isoformat() if incremental_since else None,
            "fetched": 0,
            "created": 0,
            "updated": 0,
            "reactivated": 0,
            "deactivated": 0,
            "skipped": 0,
            "snapshots_refreshed": 0,
            "affected_schedule_plans_marked": 0,  # 新增：标记为待重排的计划数
        }

        try:
            config_service = UpphFormulaConfigService(self.db)
            await config_service.ensure_table()
            config_map = await config_service.get_active_config_map()
            await self.erp_service._connect_erp()
            detail_columns = await self._load_table_columns("formtable_main_51_dt1")
            main_columns = await self._load_table_columns("formtable_main_51")
            department_columns = await self._load_table_columns(self.OA_DEPARTMENT_TABLE)
            sql_text = self._build_sync_sql(
                detail_columns, main_columns, department_columns,
                incremental_since=incremental_since,
            )
            sql_params: dict[str, Any] = {}
            if is_incremental:
                sql_params["incremental_since"] = incremental_since.strftime("%Y-%m-%d %H:%M:%S")
            rows = await self.erp_service._execute_erp_sql(sql_text, sql_params)
            stats["fetched"] = len(rows)

            if is_incremental:
                # 增量模式: 只查本次涉及到的工单对应的现有记录, 不能全表扫
                touched_main_ids = {
                    str(r.get("oa_main_id") or "").strip()
                    for r in rows
                    if self._normalize_text(r.get("oa_main_id"))
                }
                if touched_main_ids:
                    existing_result = await self.db.execute(
                        select(ProductProcessCapacity).where(
                            ProductProcessCapacity.oa_detail_id.isnot(None)
                        )
                    )
                    existing_records = [
                        rec for rec in existing_result.scalars().all()
                        if str(parse_capacity_metadata(rec.remark).get("oa_main_id") or "").strip() in touched_main_ids
                    ]
                else:
                    existing_records = []
                existing_by_oa_detail_id = {
                    record.oa_detail_id: record
                    for record in existing_records
                    if record.oa_detail_id
                }
            else:
                existing_result = await self.db.execute(select(ProductProcessCapacity))
                existing_records = existing_result.scalars().all()
                existing_by_oa_detail_id = {
                    record.oa_detail_id: record
                    for record in existing_records
                    if record.oa_detail_id
                }

            seen_oa_detail_ids: set[str] = set()
            # 记录有 UPPH 发生变化的产品编码和 BOM 编码
            changed_product_codes: set[str] = set()
            changed_bom_codes: set[str] = set()

            for row in rows:
                normalized = self._normalize_row(row)
                if not normalized:
                    stats["skipped"] += 1
                    continue

                oa_detail_id = normalized["oa_detail_id"]
                bom_code = normalized["bom_code"]
                product_code = normalized["product_code"]
                process_type = normalized["process_type"]

                if oa_detail_id:
                    seen_oa_detail_ids.add(oa_detail_id)

                record = None
                if oa_detail_id:
                    record = existing_by_oa_detail_id.get(oa_detail_id)

                existing_metadata = parse_capacity_metadata(record.remark) if record else {}
                config_manpower, config_hour_price = await config_service.resolve_formula_inputs(
                    normalized["oa_workshop_name"],
                    process_type,
                    config_map,
                )
                upph_result = resolve_capacity_upph(
                    workshop_name=normalized["oa_workshop_name"],
                    process_type=process_type,
                    gjje=normalized["gjje"],
                    oa_raw_upph=normalized["oa_raw_upph"],
                    manpower=config_manpower,
                    hour_price=config_hour_price,
                    manual_upph=existing_metadata.get("manual_upph"),
                )
                new_upph = self._normalize_decimal(upph_result["effective_upph"])
                remark = build_capacity_metadata_remark(
                    oa_main_id=normalized["oa_main_id"],
                    oa_workshop_id=normalized["oa_workshop_id"],
                    oa_workshop_name=normalized["oa_workshop_name"],
                    gjje=normalized["gjje"],
                    oa_raw_upph=upph_result.get("oa_raw_upph"),
                    formula_upph=upph_result.get("formula_upph"),
                    effective_upph=upph_result.get("effective_upph"),
                    manual_upph=upph_result.get("manual_upph"),
                    upph_source=upph_result.get("upph_source"),
                    manpower=upph_result.get("manpower"),
                    hour_price=upph_result.get("hour_price"),
                    raw_remark=normalized.get("raw_remark"),
                )

                # 检测 UPPH 是否变化
                upph_changed = False
                if record:
                    # 比较新值有变化，并且不是新创建的
                    if record.upph != new_upph:
                        upph_changed = True
                        if product_code:
                            changed_product_codes.add(product_code)
                        if bom_code:
                            changed_bom_codes.add(bom_code)

                if record is None:
                    record = ProductProcessCapacity(
                        oa_detail_id=oa_detail_id,
                        bom_code=bom_code,
                        product_code=product_code,
                        product_name=normalized["product_name"],
                        process_type=process_type,
                        upph=new_upph,
                        source=self.OA_SOURCE,
                        sync_batch_no=sync_batch_no,
                        last_sync_time=sync_time,
                        is_active=True,
                        remark=remark,
                    )
                    self.db.add(record)
                    existing_records.append(record)
                    stats["created"] += 1
                    # 新增 UPPH 也视为有变化
                    if product_code:
                        changed_product_codes.add(product_code)
                    if bom_code:
                        changed_bom_codes.add(bom_code)
                else:
                    was_inactive = not bool(record.is_active)
                    # 检测内容是否真的有变化
                    has_changes = False
                    if (record.bom_code != bom_code or
                        record.product_code != product_code or
                        record.product_name != normalized["product_name"] or
                        record.process_type != process_type or
                        record.upph != new_upph or
                        record.remark != remark or
                        was_inactive):
                        has_changes = True

                    if has_changes:
                        record.oa_detail_id = oa_detail_id
                        record.bom_code = bom_code
                        record.product_code = product_code
                        record.product_name = normalized["product_name"]
                        record.process_type = process_type
                        record.upph = new_upph
                        record.source = self.OA_SOURCE
                        record.sync_batch_no = sync_batch_no
                        record.last_sync_time = sync_time
                        record.is_active = True
                        record.remark = remark
                        self.db.add(record)
                        stats["updated"] += 1
                        # 任何内容变更（含 upph、gjje、bom_code 等）都应该
                        # 触发相关订单行快照刷新，统一在这里加入 changed 集合。
                        if product_code:
                            changed_product_codes.add(product_code)
                        if bom_code:
                            changed_bom_codes.add(bom_code)
                        if was_inactive:
                            stats["reactivated"] += 1
                    else:
                        # 内容没有变化，只更新最后同步时间，不计数为更新
                        record.last_sync_time = sync_time
                        self.db.add(record)

                if oa_detail_id:
                    existing_by_oa_detail_id[oa_detail_id] = record

            # 失效处理只在全量模式跑。增量模式没有拉全量数据，
            # 不能根据"本次没拉到"就判定失效，否则会误删未变更的记录。
            if not is_incremental:
                for record in existing_records:
                    if record.source != self.OA_SOURCE or not record.is_active:
                        continue

                    if record.oa_detail_id:
                        if record.oa_detail_id in seen_oa_detail_ids:
                            continue

                    # 失效 UPPH 也视为有变化
                    if record.product_code:
                        changed_product_codes.add(record.product_code)
                    if record.bom_code:
                        changed_bom_codes.add(record.bom_code)

                    record.is_active = False
                    record.sync_batch_no = sync_batch_no
                    record.last_sync_time = sync_time
                    self.db.add(record)
                    stats["deactivated"] += 1

            # 标记相关的排产计划为待重排
            if changed_product_codes or changed_bom_codes:
                stats["affected_schedule_plans_marked"] += await self.mark_affected_schedule_plans(
                    self.db,
                    changed_product_codes,
                )

            await self.db.commit()

            # 级联刷新受影响订单行的排产快照（填缺口2）：
            # 同步把 product_process_capacity 改了之后，待办池的
            # ProductionOrderScheduleSnapshot 不会自动更新，需要主动刷新
            # 涉及的订单行才会反映最新 UPPH。
            if changed_bom_codes or changed_product_codes:
                try:
                    stats["snapshots_refreshed"] = await self._refresh_affected_order_snapshots(
                        changed_bom_codes,
                    )
                except Exception as refresh_err:
                    # 快照刷新失败不影响同步结果（同步数据已 commit）
                    stats["snapshots_refreshed"] = -1
                    stats["snapshots_refresh_error"] = str(refresh_err)

            return stats
        except ERPConnectionError:
            await self.db.rollback()
            raise
        except Exception:
            await self.db.rollback()
            raise
        finally:
            self.erp_service._close_erp()

    @staticmethod
    async def mark_affected_schedule_plans(
        db: AsyncSession,
        product_codes: set[str],
        reason: str = "UPPH 数据已更新",
    ) -> int:
        if not product_codes:
            return 0

        result = await db.execute(
            select(ProductionSchedulePlan).where(
                ProductionSchedulePlan.is_active == True,
                ProductionSchedulePlan.status == "planned",
                ProductionSchedulePlan.product_code.in_(list(product_codes)),
            )
        )

        affected = 0
        for plan in result.scalars().all():
            if plan.needs_reschedule and plan.reschedule_reason == reason:
                continue
            plan.needs_reschedule = True
            plan.reschedule_reason = reason
            db.add(plan)
            affected += 1
        return affected

    async def _refresh_affected_order_snapshots(self, bom_codes: set[str]) -> int:
        """刷新 BOM 涉及的订单行的排产快照。

        延迟导入 schedule_plans 里的快照刷新函数，避免循环依赖。
        只要 UPPH 数据有变更（BOM 级），就重新拉取该 BOM 对应的待排订单行
        并重建其快照，保证待办池/排产台账立刻反映最新 UPPH。
        """
        if not bom_codes:
            return 0
        # 去掉空串
        bom_list = [b for b in bom_codes if b and b.strip()]
        if not bom_list:
            return 0

        from app.models.order.sale_order import SaleOrderLine, SaleOrder
        from app.api.v1.production.schedule_plans import (
            _query_snapshot_source_rows_by_keys,
            _refresh_order_schedule_snapshots,
        )

        # 找出这些 BOM 对应的未关闭订单行（用最新一行去重 order_no+line_no）
        keys_result = await self.db.execute(
            select(SaleOrderLine.order_no, SaleOrderLine.line_no)
            .where(
                SaleOrderLine.bom_no.in_(bom_list),
                SaleOrderLine.status != "closed",
            )
        )
        keys = {(r[0], r[1]) for r in keys_result.all() if r[0] and r[1]}
        if not keys:
            return 0

        source_rows = await _query_snapshot_source_rows_by_keys(self.db, keys)
        if not source_rows:
            return 0
        snap_map = await _refresh_order_schedule_snapshots(self.db, source_rows, force_refresh=True)
        return len(snap_map)

    async def _load_table_columns(self, table_name: str) -> set[str]:
        sql_text = f"SELECT TOP 0 * FROM FWsv.ecology.dbo.{table_name}"
        loop = asyncio.get_event_loop()
        columns = await loop.run_in_executor(
            None,
            lambda: list(self.erp_service.erp_session.execute(text(sql_text)).keys()),
        )
        return {
            str(column).strip().lower()
            for column in columns
            if column
        }

    def _build_sync_sql(
        self,
        detail_columns: set[str],
        main_columns: set[str],
        department_columns: set[str],
        *,
        incremental_since: Optional[datetime] = None,
    ) -> str:
        detail_id_expr = "CAST(b.id AS VARCHAR(64))" if "id" in detail_columns else "NULL"
        if "wldm" in main_columns:
            product_code_expr = "CAST(a.wldm AS VARCHAR(64))"
        elif "wlbm" in detail_columns:
            product_code_expr = "CAST(b.wlbm AS VARCHAR(64))"
        else:
            raise ERPConnectionError("OA 主表/明细表缺少物料代码字段，未找到 a.wldm/b.wlbm")

        if "wlmc" not in detail_columns:
            raise ERPConnectionError("OA 明细表缺少产品名称字段 wlmc")
        if "gx" not in detail_columns:
            raise ERPConnectionError("OA 明细表缺少工序字段 gx")
        if "pph" not in detail_columns:
            raise ERPConnectionError("OA 明细表缺少 UPPH 字段 pph")
        if "sfyx" not in main_columns:
            raise ERPConnectionError("OA 主表缺少是否有效字段 sfyx")
        if "cj" not in main_columns:
            raise ERPConnectionError("OA 主表缺少车间字段 cj")
        if "dj" not in detail_columns:
            raise ERPConnectionError("OA 明细表缺少单价字段 dj")
        if "id" not in department_columns:
            raise ERPConnectionError("OA 部门表缺少主键字段 id")
        if "departmentname" not in department_columns:
            raise ERPConnectionError("OA 部门表缺少部门名称字段 departmentname")

        request_column = "requestID" if "requestid" in main_columns else None
        request_filter = f"AND a.{request_column} IS NULL" if request_column else ""
        bom_code_expr = (
            "LTRIM(RTRIM(CAST(a.bombm AS VARCHAR(64))))"
            if "bombm" in main_columns
            else "NULL"
        )

        remark_expr = "NULL"
        if "bz" in detail_columns:
            remark_expr = "LTRIM(RTRIM(CAST(b.bz AS NVARCHAR(MAX))))"
        elif "bzcn" in detail_columns:
            remark_expr = "LTRIM(RTRIM(CAST(b.bzcn AS NVARCHAR(MAX))))"

        workshop_id_expr = "LTRIM(RTRIM(CAST(a.cj AS VARCHAR(64))))"
        workshop_name_expr = "LTRIM(RTRIM(CAST(d.departmentname AS NVARCHAR(255))))"
        gjje_expr = "CAST(ISNULL(b.dj, 0) AS DECIMAL(15, 4))"
        incremental_filter = self._build_incremental_filter(main_columns, incremental_since)

        return f"""
        SELECT
            CAST(a.id AS VARCHAR(64)) AS oa_main_id,
            {detail_id_expr} AS oa_detail_id,
            {bom_code_expr} AS bom_code,
            LTRIM(RTRIM({product_code_expr})) AS product_code,
            LTRIM(RTRIM(CAST(b.wlmc AS VARCHAR(256)))) AS product_name,
            {workshop_id_expr} AS oa_workshop_id,
            {workshop_name_expr} AS oa_workshop_name,
            CASE
                WHEN b.gx = 0 THEN '组装前加工'
                WHEN b.gx = 7 THEN '包装前加工'
                WHEN b.gx = 1 THEN '包装'
                WHEN b.gx = 2 THEN '组装'
                WHEN b.gx = 3 THEN '打胶'
                WHEN b.gx = 6 THEN '打砂带'
                ELSE CONCAT('未定义工序(', CAST(b.gx AS VARCHAR(20)), ')')
            END AS process_type,
            {gjje_expr} AS gjje,
            CAST(ISNULL(b.pph, 0) AS DECIMAL(15, 2)) AS upph,
            {remark_expr} AS remark
        FROM FWsv.ecology.dbo.formtable_main_51 a
        LEFT JOIN FWsv.ecology.dbo.formtable_main_51_dt1 b ON a.id = b.mainid
        LEFT JOIN FWsv.ecology.dbo.{self.OA_DEPARTMENT_TABLE} d
          ON CAST(a.cj AS VARCHAR(64)) = CAST(d.id AS VARCHAR(64))
        WHERE a.sfyx = 0
          {request_filter}
          AND b.mainid IS NOT NULL
          {incremental_filter}
        """

    @staticmethod
    def _build_incremental_filter(
        main_columns: set[str],
        incremental_since: Optional[datetime],
    ) -> str:
        """构造增量同步过滤条件。

        OA 主表 modedatamodifydatetime 数据并不完整（约 64% 工单有值），
        所以增量模式时用 OR 兜底：
          - 有 modify 时间且在 since 之后，或
          - modify 时间为空但创建时间在 since 之后（新单尚未触发过 modify）
        全量模式（incremental_since=None）返回空串。
        """
        if incremental_since is None:
            return ""
        has_modify = "modedatamodifydatetime" in main_columns
        has_create = "modedatacreatedate" in main_columns and "modedatacreatetime" in main_columns
        conditions = []
        if has_modify:
            conditions.append(
                "LTRIM(RTRIM(a.modedatamodifydatetime)) <> '' "
                "AND a.modedatamodifydatetime >= :incremental_since"
            )
        if has_create:
            # modedatacreatedate 是日期，modedatacreatetime 是时间，拼起来比较
            conditions.append(
                "(LTRIM(RTRIM(a.modedatacreatedate)) <> '' "
                "AND CAST(a.modedatacreatedate + ' ' + ISNULL(a.modedatacreatetime, '00:00:00') AS DATETIME) >= :incremental_since)"
            )
        if not conditions:
            return ""
        return "AND (" + " OR ".join(conditions) + ")"

    def _normalize_row(self, row: dict[str, Any]) -> dict[str, Any] | None:
        process_type = self._normalize_text(row.get("process_type"))
        product_code = self._normalize_text(row.get("product_code"))
        bom_code = self._normalize_text(row.get("bom_code"))

        if not process_type:
            return None
        if not product_code and not bom_code:
            return None

        return {
            "oa_main_id": self._normalize_text(row.get("oa_main_id")),
            "oa_detail_id": self._normalize_text(row.get("oa_detail_id")),
            "bom_code": bom_code,
            "product_code": product_code or bom_code,
            "product_name": self._normalize_text(row.get("product_name")),
            "oa_workshop_id": self._normalize_text(row.get("oa_workshop_id")),
            "oa_workshop_name": self._normalize_text(row.get("oa_workshop_name")),
            "process_type": process_type,
            "gjje": self._normalize_decimal(row.get("gjje")),
            "oa_raw_upph": self._normalize_decimal(row.get("upph")),
            "raw_remark": self._normalize_text(row.get("remark")),
        }

    @staticmethod
    def _normalize_text(value: Any) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @staticmethod
    def _normalize_decimal(value: Any) -> Decimal:
        if value in (None, ""):
            return Decimal("0")
        if isinstance(value, Decimal):
            return value
        try:
            return Decimal(str(value))
        except (InvalidOperation, ValueError, TypeError):
            return Decimal("0")
