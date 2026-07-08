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
            patch("app.main._llm_probe", return_value=(True, None)),
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
            patch("app.main._llm_probe", return_value=(True, None)),
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
            patch("app.main._llm_probe", return_value=(True, None)),
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
            patch("app.main._llm_probe", return_value=(True, None)),
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
            patch("app.main._llm_probe", return_value=(True, None)),
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
            patch("app.main._llm_probe", return_value=(True, None)),
        ):
            response = health_check_full()
        body = json.loads(response.body)
        assert response.status_code == 200
        assert body["status"] == "healthy"
        assert body["worker"]["status"] == "alive"
        assert body["llm"]["status"] == "ready"
        assert body["llm"]["probe_ok"] is True


# ── LLM readiness (the 2026-07-01 outage regression guard) ─────────────────


class TestLlmReadiness:
    """The outage: a partial `uv sync` left litellm a hollow namespace package,
    so `import litellm` succeeded but `litellm.completion` was gone. Every chat
    500'd while /health stayed green because it never probed the LLM path. These
    tests pin the fix: LLM breakage 503s /health/full (pages oncall) but must
    NOT flip /health (readiness / LB gate)."""

    def test_health_full_503s_when_llm_unavailable(self, healthy_engine):
        """DB + Redis + worker all green, but litellm is hollow → /health/full
        must 503 so alerting fires. This is the signal the outage lacked."""
        from datetime import UTC, datetime

        recent = datetime.now(UTC).isoformat()
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(recent)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
            patch("app.main._llm_ready", return_value=False),
        ):
            response = health_check_full()
        body = json.loads(response.body)
        assert response.status_code == 503
        assert body["status"] == "degraded"
        assert body["llm"]["status"] == "unavailable"
        assert body["llm"]["import_ok"] is False
        assert body["llm"]["probe_ok"] is False
        assert body["llm"]["detail"]  # non-empty diagnostic string

    def test_health_readiness_stays_200_when_llm_unavailable(self, healthy_engine):
        """/health is the LB / deploy gate and must keep DB+Redis-only response
        semantics — a hollow litellm must NOT take the load balancer down."""
        from datetime import UTC, datetime

        recent = datetime.now(UTC).isoformat()
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(recent)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
            patch("app.main._llm_ready", return_value=False),
        ):
            response = health_check()
        body = json.loads(response.body)
        assert response.status_code == 200
        assert body["llm"]["status"] == "unavailable"

    def test_llm_ready_detects_hollow_litellm(self):
        """`_llm_ready` returns False when the litellm module lacks `completion`
        (the exact hollow-namespace-package failure mode) and True otherwise."""
        from app.main import _llm_ready

        hollow = MagicMock(spec=[])  # no `completion` attribute
        with patch("app.main._litellm", hollow):
            assert _llm_ready() is False

        intact = MagicMock()  # `completion` resolves via MagicMock auto-attr
        with patch("app.main._litellm", intact):
            assert _llm_ready() is True


# ── _llm_probe (the real, TTL-cached completion probe) ─────────────────────


class TestLlmProbe:
    """The 2026-07-07 ~4h production incident (OpenAI `insufficient_quota`)
    ran the whole time with `/health/full` reporting healthy, because the only
    LLM signal was the import-attribute check (`_llm_ready`), which can't see
    a revoked key, billing block, or provider outage. `_llm_probe` makes one
    real, tiny completion call — these tests pin that it actually calls out,
    caches the result, and never spends money re-probing within the TTL."""

    @pytest.fixture(autouse=True)
    def _reset_probe_cache(self):
        """Every test in this class gets a clean cache — otherwise test order
        (or a slow CI box) could leak a cached result across tests."""
        import app.main as main_module

        main_module._llm_probe_cache["ts"] = 0.0
        main_module._llm_probe_cache["ok"] = True
        main_module._llm_probe_cache["detail"] = None
        yield

    def test_short_circuits_without_network_call_when_import_check_fails(self):
        """A hollow litellm install can't make a completion call at all —
        don't even try; this must never make a network call."""
        from app.main import _llm_probe

        with (
            patch("app.main._llm_ready", return_value=False),
            patch("app.main._litellm.completion") as mock_completion,
        ):
            ok, detail = _llm_probe()

        assert ok is False
        assert detail
        mock_completion.assert_not_called()

    def test_returns_true_on_successful_completion(self):
        from app.main import _llm_probe

        with (
            patch("app.main._llm_ready", return_value=True),
            patch("app.services.runtime_config.get_primary_model", return_value="openai/gpt-5.4-mini"),
            patch("app.main._litellm.completion", return_value=MagicMock()) as mock_completion,
        ):
            ok, detail = _llm_probe()

        assert ok is True
        assert detail is None
        mock_completion.assert_called_once()
        _, kwargs = mock_completion.call_args
        assert kwargs["model"] == "openai/gpt-5.4-mini"
        assert kwargs["max_tokens"] >= 2  # must not regress to the max_tokens=1 false-negative bug

    def test_returns_false_with_detail_on_provider_error(self):
        from app.main import _llm_probe

        with (
            patch("app.main._llm_ready", return_value=True),
            patch("app.services.runtime_config.get_primary_model", return_value="openai/gpt-5.4-mini"),
            patch(
                "app.main._litellm.completion",
                side_effect=RuntimeError("insufficient_quota"),
            ),
        ):
            ok, detail = _llm_probe()

        assert ok is False
        assert "insufficient_quota" in detail

    def test_caches_result_within_ttl_and_does_not_recall(self):
        from app.main import _llm_probe

        with (
            patch("app.main._llm_ready", return_value=True),
            patch("app.services.runtime_config.get_primary_model", return_value="openai/gpt-5.4-mini"),
            patch("app.main._litellm.completion", return_value=MagicMock()) as mock_completion,
        ):
            ok1, _ = _llm_probe()
            ok2, _ = _llm_probe()

        assert ok1 is True
        assert ok2 is True
        mock_completion.assert_called_once()  # second call served from cache, not a re-probe

    def test_reprobes_after_ttl_expires(self):
        import app.main as main_module
        from app.main import _llm_probe

        with (
            patch("app.main._llm_ready", return_value=True),
            patch("app.services.runtime_config.get_primary_model", return_value="openai/gpt-5.4-mini"),
            patch("app.main._litellm.completion", return_value=MagicMock()) as mock_completion,
        ):
            _llm_probe()
            main_module._llm_probe_cache["ts"] -= main_module._LLM_PROBE_TTL_SECONDS + 1
            _llm_probe()

        assert mock_completion.call_count == 2


# ── _gather_health (the shared collector) ──────────────────────────────────


class TestGatherHealth:
    def test_ready_to_serve_decoupled_from_fully_ok(self, healthy_engine):
        """With worker dead: ready_to_serve=True, fully_ok=False. This is
        the invariant that lets /health stay 200 while /health/full goes 503."""
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(None)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
            patch("app.main._llm_probe", return_value=(True, None)),
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
            patch("app.main._llm_probe", return_value=(True, None)),
        ):
            payload, ready_to_serve, fully_ok = _gather_health()
        assert ready_to_serve is False
        assert fully_ok is False
