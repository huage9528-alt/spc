"""数据供给调用告警调度器

每小时检查近 1h DataSupplyCallLog：
- 失败率 > 50% 且调用量 >= 20 → 告警
- 限流命中 > 100 次 → 告警
同一条件 2h 内不重复告警（Redis SET NX）。企微接收人由
settings.data_supply_alert_wecom_uids 配置，未配置则仅记日志。
"""

import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import select, func

from app.core.database import AsyncSessionLocal
from app.models.basicdata.data_supply import DataSupplyCallLog
from app.services.basicdata.rate_limiter import RATE_LIMITED_MARK

logger = logging.getLogger(__name__)

FAIL_RATE_THRESHOLD = 0.5
MIN_CALLS = 20
RATE_LIMIT_HITS_THRESHOLD = 100


class DataSupplyAlertScheduler:
    def __init__(self, interval_hours: int = 1):
        self.running = False
        self.task = None
        self.interval_hours = interval_hours

    async def _can_alert(self, condition: str) -> bool:
        """Redis 去重：同一条件 2h 内只告警一次。Redis 不可用时放行。"""
        from app.core.redis_client import get_command_client, note_failure, note_success
        client = get_command_client()
        if client is None:
            return True
        try:
            got = await client.set(
                f"ds_alert:{condition}",
                "1", nx=True, ex=7200,
            )
            note_success()
            return bool(got)
        except Exception:
            note_failure()
            return True

    async def _send_wecom(self, text: str):
        try:
            from app.core.config import get_settings
            uids = [u.strip() for u in (get_settings().data_supply_alert_wecom_uids or "").split(",") if u.strip()]
            if not uids:
                logger.warning(f"[数据供给告警] 未配置接收人，仅记日志: {text}")
                return
            from app.services.basicdata.wecom.client import get_wecom_client
            client = get_wecom_client()
            agent_id = int(client._settings.wecom_agent_id or 0)
            resp = await client.send_app_message({
                "touser": "|".join(uids),
                "msgtype": "text",
                "agentid": agent_id,
                "text": {"content": text},
            })
            if resp.get("errcode", 0) != 0:
                logger.warning(f"[数据供给告警] 企微推送失败: {resp}")
        except Exception as e:
            logger.warning(f"[数据供给告警] 企微推送异常（已降级）: {e}")

    async def _run_check(self):
        try:
            async with AsyncSessionLocal() as db:
                since = datetime.now() - timedelta(hours=1)
                base = select(DataSupplyCallLog).where(DataSupplyCallLog.called_at >= since)
                total = (await db.execute(
                    select(func.count()).select_from(base.subquery())
                )).scalar() or 0
                failed = (await db.execute(
                    select(func.count()).select_from(
                        base.where(DataSupplyCallLog.response_status != 200).subquery()
                    )
                )).scalar() or 0
                rate_limited = (await db.execute(
                    select(func.count()).select_from(
                        base.where(DataSupplyCallLog.error_message == RATE_LIMITED_MARK).subquery()
                    )
                )).scalar() or 0

            if total >= MIN_CALLS and (failed / total) > FAIL_RATE_THRESHOLD:
                if await self._can_alert("fail_rate"):
                    msg = (f"[数据供给告警] 近1h调用 {total} 次，失败 {failed} 次"
                           f"（失败率 {failed / total:.0%}），请检查对外接口日志")
                    logger.warning(msg)
                    await self._send_wecom(msg)
            if rate_limited > RATE_LIMIT_HITS_THRESHOLD:
                if await self._can_alert("rate_limit"):
                    msg = f"[数据供给告警] 近1h限流命中 {rate_limited} 次，超过阈值 {RATE_LIMIT_HITS_THRESHOLD}，请核查消费方配额"
                    logger.warning(msg)
                    await self._send_wecom(msg)
        except Exception as e:
            logger.error(f"[数据供给告警] 执行失败: {e}")

    async def _loop(self):
        while self.running:
            await self._run_check()
            await asyncio.sleep(self.interval_hours * 3600)

    def start(self):
        self.running = True
        self.task = asyncio.create_task(self._loop())
        logger.info(f"[数据供给告警] 已启动，每{self.interval_hours}小时执行一次")

    def stop(self):
        self.running = False
        if self.task:
            self.task.cancel()
        logger.info("[数据供给告警] 已停止")


data_supply_alert_scheduler = DataSupplyAlertScheduler(interval_hours=1)
