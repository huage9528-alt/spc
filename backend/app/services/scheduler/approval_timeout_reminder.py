"""审批中心 - 超时未审批提醒调度器。

每小时扫描各业务待办（admin 旁路取全量），对「已超时且节点配了超时阈值」的单据，
给当前节点审批人推送站内信 + 企微 textcard；同一单据同一节点 24 小时内只提醒一次
（Redis SET NX + TTL，Redis 不可用时放行，宁可多提醒不漏提醒）。企微未配置/失败降级。

仓库既有调度器均为手写 asyncio 循环（非 APScheduler），本模块沿用同一模式。
"""

import asyncio
import logging
from datetime import datetime

from sqlalchemy import text

from app.core.database import AsyncSessionLocal
from app.services.common import approval_providers  # noqa: F401 — 导入即注册各业务 provider
from app.services.common.approval_metrics import enrich_pending_item
from app.services.common.approval_notify import send_approval_wecom_textcard
from app.services.common.approval_registry import get_pending_providers

logger = logging.getLogger(__name__)

REMIND_DEDUP_TTL_SECONDS = 24 * 3600


def select_reminder_targets(items: list[dict]) -> list[dict]:
    """挑出需要提醒的待办：已超时、配了超时阈值（0 = 不提醒）、且能解析到审批人。"""
    return [
        it for it in items
        if it.get("wait_level") == "overdue"
        and (it.get("timeout_hours") or 0) > 0
        and it.get("approver_user_ids")
    ]


class ApprovalTimeoutReminderScheduler:
    def __init__(self, interval_hours: int = 1):
        self.running = False
        self.task = None
        self.interval_hours = interval_hours

    async def _claim_remind_slot(self, item: dict) -> bool:
        """Redis 去重：同一单据同一节点 24h 内只提醒一次。Redis 不可用时放行。"""
        from app.core.redis_client import get_command_client, note_failure, note_success
        client = get_command_client()
        if client is None:
            return True
        key = f"approval_remind:{item.get('biz_type')}:{item.get('id')}:{item.get('current_level')}"
        try:
            got = await client.set(key, "1", nx=True, ex=REMIND_DEDUP_TTL_SECONDS)
            note_success()
            return bool(got)
        except Exception:
            note_failure()
            return True

    async def _active_biz_types(self, db) -> set[str]:
        """已启用的业务：停用后按设计「不再推送提醒」，在途单据仅保留待办可见与可审批。"""
        rows = await db.execute(text("SELECT biz_type FROM approval_config WHERE is_active = TRUE"))
        return {r[0] for r in rows}

    async def _collect_targets(self, db) -> list[dict]:
        targets: list[dict] = []
        active = await self._active_biz_types(db)
        for provider in get_pending_providers():
            if provider.biz_type not in active:
                continue
            try:
                # 系统视角扫描：admin 旁路节点权限过滤，取该业务全量在途
                items = await provider.fetch(db, "", "admin")
            except Exception as exc:
                logger.warning("[审批超时提醒] 取数失败 biz=%s: %s", provider.biz_type, exc)
                continue
            targets.extend(select_reminder_targets([enrich_pending_item(it) for it in items]))
        return targets

    async def _notify(self, db, item: dict):
        title = f"[审批超时] {item.get('biz_name') or item.get('biz_type')} 待您审批已超时"
        content = (f"{item.get('no') or ''} {item.get('title') or ''}"
                   f"（申请人：{item.get('applicant') or '-'}）已等待 {item.get('wait_hours')} 小时，"
                   f"超过节点阈值 {item.get('timeout_hours')} 小时，请尽快处理。")
        for uid in item["approver_user_ids"]:
            try:
                await db.execute(text("""
                    INSERT INTO notification (user_id, type, title, content, ref_type, ref_id, sender_name, priority, is_read, created_at)
                    VALUES (:uid, 'approval_timeout', :title, :content, :ref_type, :rid, '系统', 'important', FALSE, NOW())
                """), {"uid": uid, "title": title, "content": content,
                       "ref_type": item.get("biz_type"), "rid": item.get("id")})
            except Exception as exc:
                logger.warning("[审批超时提醒] 站内信失败 user_id=%s: %s", uid, exc)
        await self._notify_wecom(db, item)

    async def _notify_wecom(self, db, item: dict):
        """企微 textcard 推送，未配置/失败时降级，不影响提醒落库。"""
        await send_approval_wecom_textcard(
            db,
            user_ids=item["approver_user_ids"],
            title="审批超时提醒",
            description=(f"{item.get('no') or ''} {item.get('title') or ''}\n"
                         f"当前节点：{item.get('current_node') or '-'}\n"
                         f"已等待：{item.get('wait_hours')} 小时（阈值 {item.get('timeout_hours')} 小时）\n"
                         f"点击进入待办工作台处理。"),
            path="/approvals/pending",
            btn_text="去处理",
        )

    async def _run_check(self):
        logger.info("[审批超时提醒] 开始执行 - %s", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        try:
            async with AsyncSessionLocal() as db:
                targets = await self._collect_targets(db)
                if not targets:
                    logger.info("[审批超时提醒] 无超时待办")
                    return
                notified_uids: set[int] = set()
                for item in targets:
                    if not await self._claim_remind_slot(item):
                        continue
                    await self._notify(db, item)
                    notified_uids.update(item["approver_user_ids"])
                await db.commit()
                # commit 后 SSE 推送未读计数（Redis 失败静默丢弃）
                from app.services.notification.notification_broker import publish_unread_update
                for uid in notified_uids:
                    await publish_unread_update(db, uid)
                logger.info("[审批超时提醒] 完成：超时待办 %s 条，提醒 %s 人",
                            len(targets), len(notified_uids))
        except Exception as exc:
            logger.error("[审批超时提醒] 执行失败: %s", exc)

    async def _loop(self):
        while self.running:
            await self._run_check()
            await asyncio.sleep(self.interval_hours * 3600)

    def start(self):
        self.running = True
        self.task = asyncio.create_task(self._loop())
        logger.info("[审批超时提醒] 已启动，每%s小时执行一次", self.interval_hours)

    def stop(self):
        self.running = False
        if self.task:
            self.task.cancel()
        logger.info("[审批超时提醒] 已停止")


approval_timeout_reminder = ApprovalTimeoutReminderScheduler(interval_hours=1)
