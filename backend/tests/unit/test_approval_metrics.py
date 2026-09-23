"""审批中心等待时长 / 超时分级 / 统计口径纯函数测试。"""

from datetime import datetime, timedelta

from app.services.common.approval_metrics import (
    DEFAULT_TIMEOUT_HOURS,
    approved_stats,
    enrich_pending_item,
    pending_stats,
    resolve_timeout_hours,
    submitted_stats,
    wait_hours,
    wait_level,
)

NOW = datetime(2026, 9, 23, 12, 0, 0)


class TestResolveTimeoutHours:
    def test_default_when_missing(self):
        assert resolve_timeout_hours(None) == DEFAULT_TIMEOUT_HOURS
        assert resolve_timeout_hours({}) == DEFAULT_TIMEOUT_HOURS

    def test_explicit_value(self):
        assert resolve_timeout_hours({"timeout_hours": 24}) == 24

    def test_zero_means_no_reminder(self):
        assert resolve_timeout_hours({"timeout_hours": 0}) == 0

    def test_invalid_falls_back(self):
        assert resolve_timeout_hours({"timeout_hours": "abc"}) == DEFAULT_TIMEOUT_HOURS
        assert resolve_timeout_hours({"timeout_hours": -5}) == 0


class TestWaitHours:
    def test_datetime_input(self):
        assert wait_hours(NOW - timedelta(hours=5), NOW) == 5.0

    def test_iso_string_input(self):
        assert wait_hours("2026-09-23T07:00:00", NOW) == 5.0

    def test_missing_or_invalid(self):
        assert wait_hours(None, NOW) is None
        assert wait_hours("not-a-date", NOW) is None


class TestWaitLevel:
    def test_overdue_at_threshold(self):
        assert wait_level(48, 48) == "overdue"

    def test_soon_at_half_threshold(self):
        assert wait_level(24, 48) == "soon"

    def test_normal_below_half(self):
        assert wait_level(23.9, 48) == "normal"

    def test_no_reminder_never_flagged(self):
        assert wait_level(999, 0) == "normal"
        assert wait_level(None, 48) == "normal"


class TestEnrichAndStats:
    def test_enrich_sets_wait_fields(self):
        item = enrich_pending_item({"biz_type": "supplier_claim", "submitted_at": NOW - timedelta(hours=50)}, NOW)
        assert item["wait_hours"] == 50.0
        assert item["wait_level"] == "overdue"
        assert item["timeout_hours"] == DEFAULT_TIMEOUT_HOURS

    def test_enrich_respects_node_timeout(self):
        item = enrich_pending_item(
            {"biz_type": "supplier_claim", "submitted_at": NOW - timedelta(hours=30), "timeout_hours": 24}, NOW
        )
        assert item["wait_level"] == "overdue"

    def test_pending_stats(self):
        items = [
            enrich_pending_item({"biz_type": "a", "submitted_at": NOW - timedelta(hours=1)}, NOW),
            enrich_pending_item({"biz_type": "a", "submitted_at": NOW - timedelta(hours=30)}, NOW),
            enrich_pending_item({"biz_type": "b", "submitted_at": NOW - timedelta(hours=60)}, NOW),
        ]
        stats = pending_stats(items, NOW)
        assert stats["total"] == 3 and stats["today"] == 1
        assert stats["soon"] == 1 and stats["overdue"] == 1
        assert stats["by_biz"] == {"a": 2, "b": 1}

    def test_approved_stats(self):
        items = [
            {"my_action": "approve", "submitted_at": NOW - timedelta(hours=10), "acted_at": NOW - timedelta(hours=6)},
            {"my_action": "reject", "submitted_at": NOW - timedelta(hours=4), "acted_at": NOW - timedelta(hours=2)},
        ]
        stats = approved_stats(items)
        assert stats["processed"] == 2 and stats["passed"] == 1 and stats["rejected"] == 1
        assert stats["avg_hours"] == 3.0

    def test_submitted_stats(self):
        items = [{"status": "pending"}, {"status": "approved"}, {"status": "approved"}, {"status": "unknown"}]
        assert submitted_stats(items) == {"pending": 1, "approved": 2, "rejected": 0, "recalled": 0}
