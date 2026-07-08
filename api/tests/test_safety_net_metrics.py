"""Tests for the safety-net metrics counter + alerting layer (AR-13).

Before this, `_safety_net_metric` only emitted a log line — no counter, no
consumer, no alert. These tests pin: (1) the Redis-backed rolling counter
actually counts, (2) security-relevant events forward to Sentry, and (3) a
Redis outage never breaks the caller (these are called from hot request
paths and must be best-effort).
"""

from unittest.mock import MagicMock, patch

from app.core.metrics import (
    forward_to_sentry_if_alertable,
    get_metric_counts,
    increment_metric_counter,
)


class TestIncrementMetricCounter:
    def test_increments_redis_counter(self):
        mock_redis = MagicMock()
        mock_pipe = MagicMock()
        mock_redis.pipeline.return_value = mock_pipe

        with patch("app.core.metrics.get_redis", return_value=mock_redis):
            increment_metric_counter("moderation_block", bot_id=5)

        # AR-26: increment_metric_counter now delegates to
        # increment_metric_counter_by(name, 1, ...) so a single amount-aware
        # code path backs both the +1 and +N counter APIs.
        mock_pipe.incrby.assert_called_once()
        mock_pipe.expire.assert_called_once()
        mock_pipe.execute.assert_called_once()
        key_arg, amount_arg = mock_pipe.incrby.call_args[0]
        assert "moderation_block" in key_arg
        assert "b5" in key_arg
        assert amount_arg == 1

    def test_scoped_globally_when_no_bot_id(self):
        mock_redis = MagicMock()
        mock_pipe = MagicMock()
        mock_redis.pipeline.return_value = mock_pipe

        with patch("app.core.metrics.get_redis", return_value=mock_redis):
            increment_metric_counter("injection_attempt", bot_id=None)

        key_arg = mock_pipe.incrby.call_args[0][0]
        assert "global" in key_arg

    def test_never_raises_when_redis_unavailable(self):
        with patch("app.core.metrics.get_redis", return_value=None):
            increment_metric_counter("moderation_block", bot_id=1)  # must not raise

    def test_never_raises_on_redis_error(self):
        mock_redis = MagicMock()
        mock_redis.pipeline.side_effect = RuntimeError("connection refused")
        with patch("app.core.metrics.get_redis", return_value=mock_redis):
            increment_metric_counter("moderation_block", bot_id=1)  # must not raise


class TestGetMetricCounts:
    def test_returns_counts_for_present_buckets_only(self):
        mock_redis = MagicMock()
        mock_redis.mget.return_value = ["3", None, "1"]

        with patch("app.core.metrics.get_redis", return_value=mock_redis):
            counts = get_metric_counts("moderation_block", bot_id=1, hours=3)

        assert sum(counts.values()) == 4
        assert None not in counts.values()

    def test_returns_empty_dict_when_redis_unavailable(self):
        with patch("app.core.metrics.get_redis", return_value=None):
            assert get_metric_counts("moderation_block") == {}

    def test_never_raises_on_redis_error(self):
        mock_redis = MagicMock()
        mock_redis.mget.side_effect = RuntimeError("boom")
        with patch("app.core.metrics.get_redis", return_value=mock_redis):
            assert get_metric_counts("moderation_block") == {}


class TestForwardToSentryIfAlertable:
    def test_forwards_security_relevant_metrics(self):
        with (
            patch("app.config.SENTRY_ENABLED", True),
            patch("sentry_sdk.capture_message") as mock_capture,
        ):
            forward_to_sentry_if_alertable("moderation_block", bot_id=1)
        mock_capture.assert_called_once()
        assert "moderation_block" in mock_capture.call_args[0][0]

    def test_does_not_forward_non_security_metrics(self):
        with (
            patch("app.config.SENTRY_ENABLED", True),
            patch("sentry_sdk.capture_message") as mock_capture,
        ):
            forward_to_sentry_if_alertable("intent_router_short_circuit", bot_id=1)
        mock_capture.assert_not_called()

    def test_skips_when_sentry_disabled(self):
        with (
            patch("app.config.SENTRY_ENABLED", False),
            patch("sentry_sdk.capture_message") as mock_capture,
        ):
            forward_to_sentry_if_alertable("moderation_block", bot_id=1)
        mock_capture.assert_not_called()

    def test_never_raises_on_sentry_error(self):
        with (
            patch("app.config.SENTRY_ENABLED", True),
            patch("sentry_sdk.capture_message", side_effect=RuntimeError("boom")),
        ):
            forward_to_sentry_if_alertable("moderation_block", bot_id=1)  # must not raise


class TestSafetyNetMetricsEndpoint:
    """GET /superadmin/safety-net-metrics — the previously-missing consumer
    for _safety_net_metric's log lines."""

    def _client(self):
        from types import SimpleNamespace

        from fastapi import FastAPI
        from fastapi.testclient import TestClient as HttpClient

        from app.api import superadmin_routes_v2
        from app.api.auth import get_superadmin

        app = FastAPI()
        app.include_router(superadmin_routes_v2.router)
        app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(
            id=None, name="A", is_superadmin=True, superadmin_role="owner"
        )
        return HttpClient(app)

    def test_returns_totals_and_series_for_every_known_metric(self):
        client = self._client()
        with patch("app.core.metrics.get_redis", return_value=None):  # no Redis -> all zero, still 200
            res = client.get("/superadmin/safety-net-metrics")

        assert res.status_code == 200
        body = res.json()
        assert body["hours"] == 24
        assert body["bot_id"] is None
        assert "moderation_block" in body["totals"]
        assert "injection_attempt" in body["series"]

    def test_scoped_to_a_single_bot(self):
        client = self._client()
        with patch("app.core.metrics.get_redis", return_value=None):
            res = client.get("/superadmin/safety-net-metrics?bot_id=42")

        assert res.status_code == 200
        assert res.json()["bot_id"] == 42

    def test_rejects_out_of_range_hours(self):
        client = self._client()
        res = client.get("/superadmin/safety-net-metrics?hours=9999")
        assert res.status_code == 422
