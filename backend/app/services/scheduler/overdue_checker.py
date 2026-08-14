"""逾期采购到料计划自动推送通知调度器"""

import asyncio
import logging
from datetime import date as date_type, datetime

from sqlalchemy import select, func, or_
from app.core.database import AsyncSessionLocal
from app.models.material.purchase_order import PurchaseOrder
from app.models.basicdata.announcement import Notification

logger = logging.getLogger(__name__)


class OverdueCheckerScheduler:
    """逾期采购到料计划定时检查通知调度器"""

    def __init__(self, interval_hours: int = 24):
        self.running = False
        self.task = None
        self.interval_hours = interval_hours

    async def _run_check(self):
        logger.info(f"[逾期检查] 开始执行 - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        try:
            async with AsyncSessionLocal() as db:
                today = date_type.today()
                result = await db.execute(
                    select(
                        PurchaseOrder.owner_id,
                        func.count(PurchaseOrder.id).label('cnt')
                    )
                    .where(
                        PurchaseOrder.inspection_date.is_(None),
                        PurchaseOrder.actual_arrival_date.is_(None),
                        PurchaseOrder.eta.isnot(None),
                        PurchaseOrder.eta < today,
                        PurchaseOrder.owner_id.isnot(None),
                    )
                    .group_by(PurchaseOrder.owner_id)
                )
                rows = result.all()
                if not rows:
                    logger.info("[逾期检查] 无逾期未到料记录")
                    return

                notification_count = 0
                for row in rows:
                    user_id = row.owner_id
                    overdue_count = row.cnt

                    notification = Notification(
                        user_id=user_id,
                        type='material_alert',
                        title='逾期未到料提醒',
                        content=f'您负责的采购计划中有 {overdue_count} 条逾期未到物料，请及时跟进处理。',
                        ref_type='purchase_order',
                        priority='important',
                        is_read=False,
                    )
                    db.add(notification)
                    notification_count += 1

                await db.commit()
                logger.info(f"[逾期检查] 完成: 为 {len(rows)} 个责任人创建了 {notification_count} 条通知")
        except Exception as e:
            logger.error(f"[逾期检查] 执行失败: {e}")

    async def _loop(self):
        while self.running:
            await self._run_check()
            await asyncio.sleep(self.interval_hours * 3600)

    def start(self):
        self.running = True
        self.task = asyncio.create_task(self._loop())
        logger.info(f"[逾期检查] 已启动，每{self.interval_hours}小时执行一次")

    def stop(self):
        self.running = False
        if self.task:
            self.task.cancel()
        logger.info("[逾期检查] 已停止")


overdue_checker = OverdueCheckerScheduler(interval_hours=24)