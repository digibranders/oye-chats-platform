"""One page per metric per window, not one page per event.

``forward_to_sentry_if_alertable`` used to call ``capture_message`` on every
call. During a Gemini outage ``gate_failed_open`` fires once per chat turn,
and ``invoice_stuck_unnumbered`` fires every five minutes from the PDF backfill
for as long as any row is stuck. Both flooded Sentry with the same message and
the alert channel with duplicates of the one page that mattered.

The counter increment stays unthrottled: the safety-net dashboard still needs
every event. Only the Sentry forward is rate-limited, per metric, and the
throttle itself must never raise or block the caller.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.core import metrics


@pytest.fixture(autouse=True)
def _isolated_throttle(monkeypatch):
    """No Redis and a clean in-process table, so no test sees another's claim."""
    monkeypatch.setattr(metrics, "get_redis", lambda: None)
    metrics.reset_sentry_forward_throttle()
    yield
    metrics.reset_sentry_forward_throttle()


@pytest.fixture
def capture():
    with (
        patch("app.config.SENTRY_ENABLED", True),
        patch("sentry_sdk.capture_message") as mock_capture,
    ):
        yield mock_capture


class TestTheInProcessFallback:
    def test_the_second_call_within_the_window_is_not_forwarded(self, capture):
        metrics.forward_to_sentry_if_alertable("gate_failed_open", bot_id=1)
        metrics.forward_to_sentry_if_alertable("gate_failed_open", bot_id=1)
        assert capture.call_count == 1

    def test_a_call_after_the_window_is_forwarded_again(self, capture, monkeypatch):
        now = [1_000.0]
        monkeypatch.setattr(metrics.time, "monotonic", lambda: now[0])
        metrics.forward_to_sentry_if_alertable("gate_failed_open", bot_id=1)
        now[0] += metrics.SENTRY_FORWARD_DEFAULT_WINDOW_SECONDS + 1
        metrics.forward_to_sentry_if_alertable("gate_failed_open", bot_id=1)
        assert capture.call_count == 2

    def test_metrics_are_throttled_independently(self, capture):
        metrics.forward_to_sentry_if_alertable("gate_failed_open", bot_id=1)
        metrics.forward_to_sentry_if_alertable("moderation_failed_open", bot_id=1)
        assert capture.call_count == 2

    def test_the_invoice_metric_uses_the_longer_window(self, capture, monkeypatch):
        now = [1_000.0]
        monkeypatch.setattr(metrics.time, "monotonic", lambda: now[0])
        metrics.forward_to_sentry_if_alertable("invoice_stuck_unnumbered")
        now[0] += metrics.SENTRY_FORWARD_DEFAULT_WINDOW_SECONDS + 1
        metrics.forward_to_sentry_if_alertable("invoice_stuck_unnumbered")
        assert capture.call_count == 1, "ten minutes is not enough for the hourly invoice page"
        now[0] += metrics.SENTRY_FORWARD_WINDOW_SECONDS["invoice_stuck_unnumbered"]
        metrics.forward_to_sentry_if_alertable("invoice_stuck_unnumbered")
        assert capture.call_count == 2

    def test_the_default_and_invoice_windows(self):
        assert metrics.SENTRY_FORWARD_DEFAULT_WINDOW_SECONDS == 10 * 60
        assert metrics.SENTRY_FORWARD_WINDOW_SECONDS["invoice_stuck_unnumbered"] == 60 * 60

    def test_a_suppressed_forward_is_logged_with_its_count(self, capture, caplog):
        caplog.set_level("INFO", logger="app.core.metrics")
        metrics.forward_to_sentry_if_alertable("gate_failed_open", bot_id=1)
        metrics.forward_to_sentry_if_alertable("gate_failed_open", bot_id=1)
        metrics.forward_to_sentry_if_alertable("gate_failed_open", bot_id=1)
        suppressed = [r for r in caplog.records if "suppressed" in r.getMessage()]
        assert len(suppressed) == 2
        assert "gate_failed_open" in suppressed[-1].getMessage()
        assert "2" in suppressed[-1].getMessage()


class TestTheRedisThrottle:
    def test_the_claim_is_set_nx_ex_keyed_on_the_metric(self, capture, monkeypatch):
        client = MagicMock()
        client.set.return_value = True
        monkeypatch.setattr(metrics, "get_redis", lambda: client)
        metrics.forward_to_sentry_if_alertable("gate_failed_open", bot_id=1)
        assert capture.call_count == 1
        client.set.assert_called_once()
        args, kwargs = client.set.call_args
        assert "gate_failed_open" in args[0]
        assert kwargs["nx"] is True
        assert kwargs["ex"] == metrics.SENTRY_FORWARD_DEFAULT_WINDOW_SECONDS

    def test_the_invoice_claim_carries_the_longer_ttl(self, capture, monkeypatch):
        client = MagicMock()
        client.set.return_value = True
        monkeypatch.setattr(metrics, "get_redis", lambda: client)
        metrics.forward_to_sentry_if_alertable("invoice_stuck_unnumbered")
        assert client.set.call_args.kwargs["ex"] == 60 * 60

    def test_a_held_claim_suppresses_the_forward(self, capture, monkeypatch):
        client = MagicMock()
        client.set.return_value = None
        client.incr.return_value = 4
        monkeypatch.setattr(metrics, "get_redis", lambda: client)
        metrics.forward_to_sentry_if_alertable("gate_failed_open", bot_id=1)
        capture.assert_not_called()

    def test_a_broken_redis_falls_back_to_the_in_process_table(self, capture, monkeypatch):
        client = MagicMock()
        client.set.side_effect = RuntimeError("redis down")
        monkeypatch.setattr(metrics, "get_redis", lambda: client)
        metrics.forward_to_sentry_if_alertable("gate_failed_open", bot_id=1)
        metrics.forward_to_sentry_if_alertable("gate_failed_open", bot_id=1)
        assert capture.call_count == 1, "the fallback must still throttle, and must not raise"


class TestTheCounterIsNotThrottled:
    def test_every_event_is_still_counted(self, monkeypatch):
        client = MagicMock()
        client.pipeline.return_value = client
        monkeypatch.setattr(metrics, "get_redis", lambda: client)
        metrics.increment_metric_counter("gate_failed_open", bot_id=1)
        metrics.increment_metric_counter("gate_failed_open", bot_id=1)
        assert client.execute.call_count == 2
