"""审批超时提醒目标筛选与调度器生命周期测试。"""

import asyncio

from app.services.scheduler.approval_timeout_reminder import (
    REMIND_DEDUP_TTL_SECONDS,
    ApprovalTimeoutReminderScheduler,
    select_reminder_targets,
)


def _item(**kw):
    base = {"biz_type": "supplier_claim", "id": 1, "current_level": 1,
            "wait_level": "overdue", "timeout_hours": 24, "approver_user_ids": [3]}
    base.update(kw)
    return base


class TestSelectReminderTargets:
    def test_picks_overdue_with_threshold_and_approvers(self):
        assert len(select_reminder_targets([_item()])) == 1

    def test_skips_not_overdue(self):
        assert select_reminder_targets([_item(wait_level="soon"), _item(wait_level="normal")]) == []

    def test_skips_when_reminder_disabled(self):
        assert select_reminder_targets([_item(timeout_hours=0)]) == []

    def test_skips_when_no_approver(self):
        assert select_reminder_targets([_item(approver_user_ids=[]), _item(approver_user_ids=None)]) == []

    def test_dedup_ttl_is_24h(self):
        assert REMIND_DEDUP_TTL_SECONDS == 24 * 3600


class TestSchedulerLifecycle:
    async def test_start_runs_one_round_then_stops(self):
        """启停与既有调度器同构：start 建任务并跑一轮，stop 置位并取消任务（不触库）。"""
        scheduler = ApprovalTimeoutReminderScheduler(interval_hours=1)
        rounds: list[int] = []

        async def fake_check():
            rounds.append(1)

        scheduler._run_check = fake_check
        scheduler.start()
        assert scheduler.running is True and scheduler.task is not None
        await asyncio.sleep(0.05)
        scheduler.stop()
        assert scheduler.running is False
        assert rounds, "start 后应至少执行一轮检查"
