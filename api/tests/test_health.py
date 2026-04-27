"""Tests for /health and /health/full — readiness vs comprehensive checks.

The split is the user-facing behavioral contract:
- /health returns 200 as long as DB + Redis are up (worker degradation does
  NOT flip the response code, so LB probes / deploy gates don't flap on
  transient worker hiccups).
- /health/full returns 200 only when DB + Redis + worker heartbeat are all
  green. Use this for alerting that should page on partial degradation.

Without these tests, a future refactor of `_gather_health` could silently
re-introduce the old behavior where a missing worker fails /health and
takes the LB down with it.
"""

import json
from unittest.mock import MagicMock, patch

import pytest

from app.main import _gather_health, health_check, health_check_full


@pytest.fixture()
def healthy_engine():
    """An engine whose connect() context manager yields a connection that
    runs SELECT 1 successfully and reports zero pool stats."""
    conn = MagicMock()
    conn.execute.return_value = MagicMock()
    pool = MagicMock(size=lambda: 0, checkedin=lambda: 0, checkedout=lambda: 0, overflow=lambda: 0)
    engine = MagicMock()
    engine.connect.return_value.__enter__.return_value = conn
    engine.pool = pool
    return engine


@pytest.fixture()
def broken_engine():
    """An engine whose connect() raises — simulates DB unreachable."""
    engine = MagicMock()
    engine.connect.side_effect = RuntimeError("connection refused")
    return engine


def _redis_with_heartbeat(heartbeat_iso=None):
    """Return a fake Redis where ping() works and the heartbeat key resolves
    to the given ISO timestamp (or None for missing/dead worker).

    Production `get_redis()` configures `decode_responses=True`, so `get()`
    returns str (not bytes) — the fixture mirrors that contract.
    """
    redis = MagicMock()
    redis.ping.return_value = True
    redis.get.return_value = heartbeat_iso if heartbeat_iso else None
    return redis


def _broken_redis():
    redis = MagicMock()
    redis.ping.side_effect = RuntimeError("redis down")
    return redis


# ── /health (readiness) ───────────────────────────────────────────────────


class TestHealthEndpoint:
    """`/health` must stay 200 when only the worker is degraded — that's the
    whole point of splitting the endpoints. Regressing this would silently
    take down LB probes whenever the worker hiccupped."""

    def test_returns_200_when_worker_is_dead_but_db_and_redis_are_up(self, healthy_engine):
        """The behavioral contract: a dead worker does not 503 /health."""
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(None)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
        ):
            response = health_check()
        body = json.loads(response.body)
        assert response.status_code == 200
        assert body["status"] == "degraded"
        assert body["worker"]["status"] == "missing"
        assert body["database"] == "connected"
        assert body["redis"] == "connected"

    def test_returns_200_when_worker_is_disabled(self, healthy_engine):
        """`WORKER_ENABLED=false` means in-process work — no separate worker
        to poll, so worker_status='disabled' is healthy."""
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(None)),
            patch("app.worker.enqueue.WORKER_ENABLED", False),
        ):
            response = health_check()
        body = json.loads(response.body)
        assert response.status_code == 200
        assert body["status"] == "healthy"
        assert body["worker"]["status"] == "disabled"

    def test_returns_503_when_database_is_down(self, broken_engine):
        with (
            patch("app.main.engine", broken_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(None)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
        ):
            response = health_check()
        body = json.loads(response.body)
        assert response.status_code == 503
        assert body["status"] == "unhealthy"
        assert body["database"] == "unreachable"

    def test_returns_503_when_redis_is_down(self, healthy_engine):
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_broken_redis()),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
        ):
            response = health_check()
        body = json.loads(response.body)
        assert response.status_code == 503
        assert body["status"] == "unhealthy"
        assert body["redis"] == "unreachable"


# ── /health/full (comprehensive) ──────────────────────────────────────────


class TestHealthFullEndpoint:
    """`/health/full` is the strict check used by alerting that should page
    oncall when the worker disappears."""

    def test_returns_503_when_worker_is_dead(self, healthy_engine):
        """Mirror image of the /health test above — worker death MUST 503
        the comprehensive endpoint, otherwise pager rules are silent."""
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(None)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
        ):
            response = health_check_full()
        body = json.loads(response.body)
        assert response.status_code == 503
        assert body["status"] == "degraded"
        assert body["worker"]["status"] == "missing"

    def test_returns_200_when_everything_is_healthy(self, healthy_engine):
        from datetime import UTC, datetime

        recent = datetime.now(UTC).isoformat()
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(recent)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
        ):
            response = health_check_full()
        body = json.loads(response.body)
        assert response.status_code == 200
        assert body["status"] == "healthy"
        assert body["worker"]["status"] == "alive"


# ── _gather_health (the shared collector) ──────────────────────────────────


class TestGatherHealth:
    def test_ready_to_serve_decoupled_from_fully_ok(self, healthy_engine):
        """With worker dead: ready_to_serve=True, fully_ok=False. This is
        the invariant that lets /health stay 200 while /health/full goes 503."""
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(None)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
        ):
            payload, ready_to_serve, fully_ok = _gather_health()
        assert ready_to_serve is True
        assert fully_ok is False
        assert payload["status"] == "degraded"

    def test_both_false_when_db_unreachable(self, broken_engine):
        with (
            patch("app.main.engine", broken_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(None)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
        ):
            payload, ready_to_serve, fully_ok = _gather_health()
        assert ready_to_serve is False
        assert fully_ok is False
