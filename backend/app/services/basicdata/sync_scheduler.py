"""
ERP 定时同步调度器
支持配置化的同步策略（间隔、策略、时间窗口、优先级）
"""

import asyncio
import logging
import traceback
import uuid
from datetime import datetime, timedelta, time
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import AsyncSessionLocal
from app.core.config import get_settings, get_server_identity
from app.services.basicdata.erp_sync_service import ERPSyncService
from app.models.basicdata.sync_sql_config import SyncSqlConfig
from app.models.basicdata.sync_log import SyncLog

logger = logging.getLogger(__name__)
settings = get_settings()


class SyncScheduler:
    """配置化定时同步调度器"""

    def __init__(self):
        self.running = False
        self.task = None
        self.sync_method_map = {
            "orders": "sync_orders",
            "order_details": "sync_order_details",
            "materials": "sync_materials",
            "purchase_orders": "sync_purchase_orders",
            "customers": "sync_customers",
            "suppliers": "sync_suppliers",
            "materials_masterdata": "sync_materials_masterdata",
            "skus": "sync_skus",
            "products": "sync_products",
            "boms": "sync_boms",
            "bom_details": "sync_bom_details",
            "warehouses": "sync_warehouses",
            "locations": "sync_locations",
            "processes": "sync_processes",
            "organizations": "sync_organizations",
            "positions": "sync_positions",
            "employees": "sync_employees",
            "purchase_invoices": "sync_purchase_invoices",
            "payment_applies": "sync_payment_applies",
            "quality_issues": "sync_quality_issues",
            "mrp_plan_orders": "sync_mrp_plan_orders",
            "production_task_orders": "sync_production_task_orders",
            "production_daily_reports": "sync_production_daily_reports",
            "labor_price_audits": "sync_labor_price_audits",
            "inventory": "sync_inventory",
            "subject_balances": "sync_subject_balances",
            "subcontract_orders": "sync_subcontract_orders",
            "subcontract_order_details": "sync_subcontract_order_details",
        }

    async def _load_sync_configs(self, db: AsyncSession) -> list[SyncSqlConfig]:
        """从数据库加载所有启用的同步配置，按优先级排序"""
        result = await db.execute(
            select(SyncSqlConfig)
            .where(SyncSqlConfig.sync_enabled == True)
            .order_by(SyncSqlConfig.sync_priority.asc())
        )
        return result.scalars().all()

    def _parse_interval(self, interval: str) -> timedelta:
        """解析同步间隔字符串为timedelta"""
        interval = interval.lower()
        if interval.endswith('h'):
            return timedelta(hours=int(interval[:-1]))
        elif interval.endswith('d'):
            return timedelta(days=int(interval[:-1]))
        elif interval.endswith('w'):
            return timedelta(weeks=int(interval[:-1]))
        else:
            # 默认1小时
            return timedelta(hours=1)

    def _is_in_time_window(self, time_window: Optional[str]) -> bool:
        """检查当前时间是否在时间窗口内"""
        if not time_window:
            return True  # 无时间窗口限制
        
        try:
            # 解析时间窗口，格式: "02:00-04:00"
            start_str, end_str = time_window.split('-')
            start_time = datetime.strptime(start_str.strip(), '%H:%M').time()
            end_time = datetime.strptime(end_str.strip(), '%H:%M').time()
            now = datetime.now().time()
            
            if start_time <= end_time:
                # 同一天内
                return start_time <= now <= end_time
            else:
                # 跨天，如 22:00-02:00
                return now >= start_time or now <= end_time
        except Exception as e:
            logger.warning(f"时间窗口解析失败: {time_window}, 错误: {e}")
            return True  # 解析失败时默认允许执行

    async def _should_sync(self, db: AsyncSession, config: SyncSqlConfig) -> bool:
        """判断是否应该执行同步"""
        # Reload config in current session to avoid expired attributes
        result = await db.execute(
            select(SyncSqlConfig).where(SyncSqlConfig.id == config.id)
        )
        config = result.scalar_one_or_none()
        if not config:
            return False

        # 防重复执行：该类型在近 30 分钟内已有 pending/running 任务（可能是本实例的手动
        # 同步、或另一实例的定时同步）则跳过本轮，避免两个写入方并发拉同一批 ERP 数据、
        # 并发抢 sync_sql_config 行锁（2026-08-26 08:32 LockNotAvailableError 根因）。
        # 30 分钟窗口自动过期：实例崩溃残留的 running 行在老化后不再阻塞后续同步。
        recent = await db.execute(
            select(func.count()).select_from(SyncLog).where(
                SyncLog.sync_type == config.sync_type,
                SyncLog.status.in_(("pending", "running")),
                SyncLog.created_at > datetime.now() - timedelta(minutes=30),
            )
        )
        if recent.scalar_one() > 0:
            logger.info(
                f"[调度器] {config.sync_type} 近 30 分钟内已有未完成的同步任务，本轮跳过"
            )
            return False

        # 检查时间窗口
        if not self._is_in_time_window(config.sync_time_window):
            return False

        # 检查是否到达同步时间
        if config.next_sync_time:
            return datetime.now() >= config.next_sync_time

        # 如果没有next_sync_time，说明首次执行
        return True

    def _calculate_next_sync_time(self, config: SyncSqlConfig) -> datetime:
        """计算下次同步时间"""
        interval = self._parse_interval(config.sync_interval)
        base_time = config.last_sync_time if config.last_sync_time else datetime.now()
        return base_time + interval

    async def _update_sync_status(
        self, 
        db: AsyncSession, 
        config: SyncSqlConfig, 
        status: str, 
        message: str = ""
    ):
        """更新同步状态（必须在短事务内调用并在调用后尽快 commit）"""
        config.last_sync_status = status
        config.last_sync_message = message
        if status == "success":
            config.last_sync_time = datetime.now()
            config.next_sync_time = self._calculate_next_sync_time(config)
        await db.flush()

    def _compute_since(self, config: SyncSqlConfig):
        """根据同步策略计算 since 时间（纯内存计算，不触碰数据库）"""
        if config.sync_strategy == "incremental":
            if config.last_sync_time:
                return config.last_sync_time
            return datetime.now() - timedelta(days=30)
        elif config.sync_strategy == "full":
            return None
        elif config.sync_strategy == "hybrid":
            if not config.last_sync_time:
                return None
            elif (datetime.now() - config.last_sync_time).days >= 7:
                return None
            return config.last_sync_time
        return None

    async def _run_single_sync(self, config_id: int):
        """执行单个同步任务。

        事务纪律（修复 PG 卡死的关键）：
        - 阶段A/阶段C 各用一个短事务，commit 后立即释放 sync_sql_config 行锁；
        - 阶段B（ERP 拉数，分钟级）期间不持有任何对 sync_sql_config 的事务/锁。
        旧实现把 "running" 状态的 UPDATE 挂在未提交事务上去跑 ERP 拉数，
        导致行锁被持有数分钟，手动同步/配置管理接口 UPDATE 同表时无限等待
        （服务端 lock_timeout=0），连接堆积直至连接池耗尽、全站卡死。
        """
        # 阶段A：短事务——读配置、计算 since、写 SyncLog、标记 running，立即 commit
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(SyncSqlConfig).where(SyncSqlConfig.id == config_id)
            )
            config = result.scalar_one_or_none()
            if not config:
                return
            sync_type = config.sync_type
            description = config.description or ""
            since = self._compute_since(config)

            task_id = str(uuid.uuid4())
            started_at = datetime.now()
            sync_log = SyncLog(
                task_id=task_id,
                sync_type=sync_type,
                trigger_mode="scheduled",
                server_id=get_server_identity(),
                status="running",
                started_at=started_at,
            )
            db.add(sync_log)
            await self._update_sync_status(db, config, "running", "同步任务开始")
            await db.commit()

        logger.info(f"[同步任务] 开始执行: {sync_type} - {description}")

        # 阶段B：ERP 拉数 + 目标表写入，独立 session（不再触碰调度状态表）
        sync_method_name = self.sync_method_map.get(sync_type)
        if not sync_method_name or not hasattr(ERPSyncService, sync_method_name):
            message = f"暂不支持 {sync_type} 的同步方法"
            await self._finish_sync(
                config_id, task_id, started_at, "failed", message, sync_type
            )
            logger.warning(f"[同步任务] {sync_type} - {message}")
            return

        synced_count = created_count = updated_count = errors_count = 0
        sync_log_status = "failed"
        config_status = "failed"
        message = ""
        error_detail = None
        try:
            async with AsyncSessionLocal() as sync_db:
                service = ERPSyncService(sync_db)
                sync_method = getattr(service, sync_method_name)
                result = await sync_method(since=since)
                try:
                    await sync_db.commit()
                except Exception as commit_err:
                    logger.error(f"[调度器] 同步数据 commit 失败: {commit_err}")
                    await sync_db.rollback()
                    raise

            synced_count = result.get("synced", 0)
            created_count = result.get("created", 0)
            updated_count = result.get("updated", 0)
            errors_list = result.get("errors", [])
            errors_count = len(errors_list)

            message = f"同步完成: 处理{synced_count}条, 新增{created_count}条, 更新{updated_count}条"
            if errors_count > 0:
                message += f", 失败{errors_count}条"

            sync_log_status = "success" if errors_count == 0 else "failed"
            config_status = "success"
            # 同步方法内部捕获的异常只进入了 stats["errors"]，
            # 不会触发下方外层 except。这里把错误明细写入 error_detail，
            # 否则前端只能看到 "失败N条" 而无法定位失败原因。
            error_detail = "\n".join(errors_list[:50]) if errors_list else None

            logger.info(f"[同步任务] {sync_type} - {message}")
        except Exception as e:
            message = f"同步失败: {str(e)}"
            sync_log_status = "failed"
            config_status = "failed"
            error_detail = traceback.format_exc()
            logger.error(f"[同步任务] {sync_type} - {message}", exc_info=True)

        # 阶段C：短事务——回写最终状态与 SyncLog，立即 commit
        await self._finish_sync(
            config_id, task_id, started_at, config_status, message,
            sync_type, synced_count, created_count, updated_count,
            errors_count, sync_log_status, error_detail,
        )

    async def _finish_sync(
        self,
        config_id: int,
        task_id: str,
        started_at: datetime,
        config_status: str,
        message: str,
        sync_type: str,
        synced_count: int = 0,
        created_count: int = 0,
        updated_count: int = 0,
        failed_count: int = 0,
        sync_log_status: Optional[str] = None,
        error_detail: Optional[str] = None,
    ):
        """短事务回写同步结果：SyncSqlConfig 状态 + SyncLog 统计"""
        try:
            async with AsyncSessionLocal() as db:
                result = await db.execute(
                    select(SyncSqlConfig).where(SyncSqlConfig.id == config_id)
                )
                config = result.scalar_one_or_none()
                if config:
                    if config_status == "success":
                        await self._update_sync_status(db, config, "success", message)
                    else:
                        config.last_sync_status = config_status
                        config.last_sync_message = message
                        await db.flush()

                log_result = await db.execute(
                    select(SyncLog).where(SyncLog.task_id == task_id)
                )
                sync_log = log_result.scalar_one_or_none()
                if sync_log:
                    finished_at = datetime.now()
                    sync_log.status = sync_log_status or config_status
                    sync_log.finished_at = finished_at
                    sync_log.duration_seconds = (finished_at - started_at).total_seconds()
                    sync_log.synced_count = synced_count
                    sync_log.created_count = created_count
                    sync_log.updated_count = updated_count
                    sync_log.failed_count = failed_count
                    sync_log.message = message
                    if error_detail:
                        sync_log.error_detail = error_detail
                await db.commit()
        except Exception:
            logger.error("[同步任务] 回写同步状态失败，忽略", exc_info=True)

    async def _run_sync(self):
        """执行一次调度循环"""
        logger.info(f"[调度器] 检查同步任务 - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
        try:
            # 短事务：只筛出到期的配置 id，立即 commit，绝不把读事务带进 ERP 拉数阶段
            async with AsyncSessionLocal() as db:
                configs = await self._load_sync_configs(db)
                due_ids = []
                for config in configs:
                    if await self._should_sync(db, config):
                        due_ids.append(config.id)
                await db.commit()

            for config_id in due_ids:
                # 逐个隔离异常：单个配置失败（如行锁被其他实例/手动同步短暂占用）
                # 不能中断本轮其余到期任务；锁冲突降级为 warning，下一轮自然重试。
                try:
                    await self._run_single_sync(config_id)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    if type(getattr(e, "orig", None)).__name__ == "LockNotAvailableError":
                        logger.warning(
                            f"[调度器] 同步任务 {config_id} 等待 sync_sql_config 行锁超时"
                            f"（其他实例/手动同步占用中），本轮跳过，下轮重试: {e}"
                        )
                    else:
                        logger.error(
                            f"[调度器] 同步任务 {config_id} 失败，继续执行其余任务: {e}",
                            exc_info=True,
                        )
                
            logger.info(f"[调度器] 同步任务检查完成")
                
        except Exception as e:
            try:
                logger.error(f"[调度器] 同步任务执行失败 - {e}", exc_info=True)
            except Exception:
                pass

    async def _loop(self):
        """调度循环：每分钟检查一次"""
        while self.running:
            try:
                await self._run_sync()
            except asyncio.CancelledError:
                logger.info("[调度器] 收到取消信号，退出循环")
                break
            except Exception as e:
                logger.error(f"[调度器] 同步循环异常，将继续运行: {e}", exc_info=True)
            await asyncio.sleep(60)  # 每分钟检查一次

    def start(self):
        """启动调度器"""
        if not settings.ERP_SYNC_ENABLED:
            logger.info("[调度器] ERP 同步未启用，跳过调度器启动")
            return

        self.running = True
        self.task = asyncio.create_task(self._loop())
        logger.info("[调度器] 已启动，每分钟检查同步任务")

    def stop(self):
        """停止调度器"""
        self.running = False
        if self.task:
            self.task.cancel()
        logger.info("[调度器] 已停止")


# 全局调度器实例
scheduler = SyncScheduler()
