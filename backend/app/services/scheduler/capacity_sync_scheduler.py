"""OA 工序产能(UPPH)定时同步调度器。

同步策略（双层）：
- 白天每小时做一次增量同步（modedatamodifydatetime > 上次同步时间），
  让工价变更在 1 小时内反映到排产快照。
- 每天凌晨 03:00 做一次全量兜底，补齐 OA 端 modedatamodifydatetime
  字段为空但仍被改动的工单（约占 36%，无法用增量捕获）。
"""

import asyncio
import logging
from datetime import datetime, time, timedelta

from app.core.database import AsyncSessionLocal
from app.services.production.product_process_capacity_sync_service import (
    ProductProcessCapacitySyncService,
)

logger = logging.getLogger(__name__)

# 增量同步间隔（小时）
INCREMENTAL_INTERVAL_HOURS = 1
# 全量兜底执行时刻（凌晨 3 点）
FULL_SYNC_TIME = time(3, 0)


class CapacitySyncScheduler:
    """OA 工序产能定时同步调度器"""

    def __init__(self):
        self.running = False
        self.task = None
        self.last_incremental_at: datetime | None = None
        self.last_full_at: datetime | None = None

    async def _run_incremental(self) -> None:
        """增量同步：只拉取自上次同步以来修改过的工单。"""
        since = self.last_incremental_at or self.last_full_at
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        logger.info("[OA产能同步] 增量同步开始 - %s (since=%s)", ts, since)
        try:
            async with AsyncSessionLocal() as db:
                svc = ProductProcessCapacitySyncService(db)
                stats = await svc.sync_from_oa(incremental_since=since)
                self.last_incremental_at = datetime.now()
                logger.info(
                    "[OA产能同步] 增量同步完成 - fetched=%s updated=%s created=%s snapshots_refreshed=%s",
                    stats.get("fetched"),
                    stats.get("updated"),
                    stats.get("created"),
                    stats.get("snapshots_refreshed"),
                )
        except Exception as e:
            logger.error("[OA产能同步] 增量同步失败: %s", e, exc_info=True)

    async def _run_full(self) -> None:
        """全量兜底同步。"""
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        logger.info("[OA产能同步] 全量同步开始 - %s", ts)
        try:
            async with AsyncSessionLocal() as db:
                svc = ProductProcessCapacitySyncService(db)
                stats = await svc.sync_from_oa()
                self.last_full_at = datetime.now()
                self.last_incremental_at = self.last_full_at
                logger.info(
                    "[OA产能同步] 全量同步完成 - fetched=%s updated=%s created=%s snapshots_refreshed=%s",
                    stats.get("fetched"),
                    stats.get("updated"),
                    stats.get("created"),
                    stats.get("snapshots_refreshed"),
                )
        except Exception as e:
            logger.error("[OA产能同步] 全量同步失败: %s", e, exc_info=True)

    @staticmethod
    def _seconds_until(target: time) -> float:
        """计算距离今天下一次 target 时刻的秒数。"""
        now = datetime.now()
        target_dt = now.replace(hour=target.hour, minute=target.minute, second=0, microsecond=0)
        if target_dt <= now:
            target_dt += timedelta(days=1)
        return (target_dt - now).total_seconds()

    async def _loop(self):
        """调度循环。

        两个周期：
        1. 增量：启动后立刻跑一次，之后每 INCREMENTAL_INTERVAL_HOURS 小时跑一次。
        2. 全量：每天 FULL_SYNC_TIME 兜底一次（与增量复用同一个循环，
           到点时插入一次全量任务）。
        """
        logger.info(
            "[OA产能同步] 调度器启动 - 增量每%d小时, 全量兜底 %s",
            INCREMENTAL_INTERVAL_HOURS,
            FULL_SYNC_TIME.strftime("%H:%M"),
        )
        while self.running:
            try:
                await self._run_incremental()

                # 在两次增量之间等待，期间若到达全量时刻则提前唤醒跑全量
                wait_seconds = INCREMENTAL_INTERVAL_HOURS * 3600
                seconds_to_full = self._seconds_until(FULL_SYNC_TIME)
                if seconds_to_full < wait_seconds:
                    # 到点前剩余时间 < 增量间隔，先睡到全量时刻
                    await asyncio.sleep(max(seconds_to_full, 1))
                    if not self.running:
                        break
                    await self._run_full()
                    # 全量跑完，按增量间隔继续
                else:
                    await asyncio.sleep(wait_seconds)
            except asyncio.CancelledError:
                logger.info("[OA产能同步] 收到取消信号，退出循环")
                break
            except Exception as e:
                logger.error("[OA产能同步] 循环异常，将继续运行: %s", e, exc_info=True)
                await asyncio.sleep(60)

    def start(self):
        if not self.running:
            self.running = True
            self.task = asyncio.create_task(self._loop())
            logger.info("[OA产能同步] 已启动")

    def stop(self):
        self.running = False
        if self.task:
            self.task.cancel()
        logger.info("[OA产能同步] 已停止")


capacity_sync_scheduler = CapacitySyncScheduler()
