"""Tests for /health and /health/full. Readiness vs comprehensive checks.

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
import threading
import time
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

import pytest
from fastapi import Request

from app.main import _gather_health, _TtlProbe, health_check, health_check_full

# The health endpoints only emit the full subsystem payload (DB pool internals,
# version, chat-gate ceiling, billing state) to a caller presenting a valid
# X-Health-Token; anonymous callers get just the status label. Most tests here
# assert on that full payload, so an autouse fixture arms the token and the
# endpoints are invoked with an authorized request. The gate itself is covered
# by TestHealthDetailGate.
TEST_HEALTH_TOKEN = "test-health-detail-token"


@pytest.fixture(autouse=True)
def _enable_health_detail():
    with patch("app.main.HEALTH_DETAIL_TOKEN", TEST_HEALTH_TOKEN):
        yield


GATE_PROBE_OK = {"ok": True, "latency_ms": 40, "error": None, "model": "gemini/gemini-2.5-flash"}
EMBED_PROBE_OK = {"ok": True, "latency_ms": 30, "error": None, "model": "gemini-embedding-001"}


@pytest.fixture(autouse=True)
def _dependency_probes_healthy():
    """The gate-model and embedding probes make real provider calls. Default
    them to healthy so every DB/Redis/worker/LLM scenario below stays about
    what it tests; ``TestDependencyProbes`` overrides this to reach the real
    probes, and ``TestDegradedSignal`` patches over it per test."""
    with (
        patch("app.main._gate_probe", return_value=dict(GATE_PROBE_OK)),
        patch("app.main._embedding_probe", return_value=dict(EMBED_PROBE_OK)),
    ):
        yield


def _authed_request() -> Request:
    """A Request carrying the valid X-Health-Token, so the endpoint returns the
    full detail body the payload-shape assertions rely on."""
    return Request({"type": "http", "headers": [(b"x-health-token", TEST_HEALTH_TOKEN.encode())]})


def _request_with_token(token: bytes | None) -> Request:
    """A Request with an arbitrary (or absent) X-Health-Token, for gate tests."""
    headers = [(b"x-health-token", token)] if token is not None else []
    return Request({"type": "http", "headers": headers})


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
    """An engine whose connect() raises. Simulates DB unreachable."""
    engine = MagicMock()
    engine.connect.side_effect = RuntimeError("connection refused")
    return engine


def _redis_with_heartbeat(heartbeat_iso=None):
    """Return a fake Redis where ping() works and the heartbeat key resolves
    to the given ISO timestamp (or None for missing/dead worker).

    Production `get_redis()` configures `decode_responses=True`, so `get()`
    returns str (not bytes), the fixture mirrors that contract.
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
    """`/health` must stay 200 when only the worker is degraded. That's the
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
            response = health_check(_authed_request())
        body = json.loads(response.body)
        assert response.status_code == 200
        assert body["status"] == "degraded"
        assert body["worker"]["status"] == "missing"
        assert body["database"] == "connected"
        assert body["redis"] == "connected"

    def test_returns_200_when_worker_is_disabled(self, healthy_engine):
        """`WORKER_ENABLED=false` means in-process work, no separate worker
        to poll, so worker_status='disabled' is healthy."""
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(None)),
            patch("app.worker.enqueue.WORKER_ENABLED", False),
            patch("app.main._llm_probe", return_value=(True, None)),
        ):
            response = health_check(_authed_request())
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
            response = health_check(_authed_request())
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
            response = health_check(_authed_request())
        body = json.loads(response.body)
        assert response.status_code == 503
        assert body["status"] == "unhealthy"
        assert body["redis"] == "unreachable"


# ── /health/full (comprehensive) ──────────────────────────────────────────


class TestHealthFullEndpoint:
    """`/health/full` is the strict check used by alerting that should page
    oncall when the worker disappears."""

    def test_returns_503_when_worker_is_dead(self, healthy_engine):
        """Mirror image of the /health test above. Worker death MUST 503
        the comprehensive endpoint, otherwise pager rules are silent."""
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(None)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
            patch("app.main._llm_probe", return_value=(True, None)),
        ):
            response = health_check_full(_authed_request())
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
            response = health_check_full(_authed_request())
        body = json.loads(response.body)
        assert response.status_code == 200
        assert body["status"] == "healthy"
        assert body["worker"]["status"] == "alive"
        assert body["llm"]["status"] == "ready"
        assert body["llm"]["probe_ok"] is True
        assert "fallback_count_1h" in body["llm"]


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
            response = health_check_full(_authed_request())
        body = json.loads(response.body)
        assert response.status_code == 503
        assert body["status"] == "degraded"
        assert body["llm"]["status"] == "unavailable"
        assert body["llm"]["import_ok"] is False
        assert body["llm"]["probe_ok"] is False
        assert body["llm"]["detail"]  # non-empty diagnostic string

    def test_health_readiness_stays_200_when_llm_unavailable(self, healthy_engine):
        """/health is the LB / deploy gate and must keep DB+Redis-only response
        semantics, a hollow litellm must NOT take the load balancer down."""
        from datetime import UTC, datetime

        recent = datetime.now(UTC).isoformat()
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(recent)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
            patch("app.main._llm_ready", return_value=False),
        ):
            response = health_check(_authed_request())
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
    real, tiny completion call. These tests pin that it actually calls out,
    caches the result, and never spends money re-probing within the TTL."""

    @pytest.fixture(autouse=True)
    def _reset_probe_cache(self):
        """Every test in this class gets a clean cache. Otherwise test order
        (or a slow CI box) could leak a cached result across tests."""
        import app.main as main_module

        main_module._llm_probe_cache["ts"] = 0.0
        main_module._llm_probe_cache["ok"] = True
        main_module._llm_probe_cache["detail"] = None
        yield

    def test_short_circuits_without_network_call_when_import_check_fails(self):
        """A hollow litellm install can't make a completion call at all.
        Don't even try; this must never make a network call."""
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


# ── Gate-model + embedding probes (degradation signals) ────────────────────


class TestTtlProbe:
    """The cache-and-deadline wrapper both new probes run through. A probe is
    a real provider call, so it is cached; and not every dependency call has a
    timeout knob (the embedding client retries for minutes), so a run that
    outlives its deadline is reported as failed rather than hanging the health
    endpoint until a monitor gives up on it."""

    @staticmethod
    def _until(predicate, timeout_s: float = 3.0) -> bool:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return predicate()

    def test_reports_ok_latency_and_the_fields_the_run_surfaced(self):
        def run(report):
            report["model"] = "m"

        result = _TtlProbe("t", run, ttl_s=30.0, deadline_s=1.0).result()
        assert result["ok"] is True
        assert result["error"] is None
        assert result["model"] == "m"
        assert isinstance(result["latency_ms"], int)

    def test_reports_failure_with_the_exception_and_still_surfaces_the_fields(self):
        def run(report):
            report["model"] = "m"
            raise RuntimeError("insufficient_quota")

        result = _TtlProbe("t", run, ttl_s=30.0, deadline_s=1.0).result()
        assert result["ok"] is False
        assert result["error"] == "RuntimeError: insufficient_quota"
        assert result["model"] == "m"  # an operator needs to know WHICH model failed

    def test_serves_the_cached_verdict_within_the_ttl_and_reprobes_after(self):
        runs: list[int] = []
        probe = _TtlProbe("t", lambda report: runs.append(1), ttl_s=30.0, deadline_s=1.0)

        probe.result()
        probe.result()
        assert len(runs) == 1  # second call served from cache, no re-probe

        probe._ts -= 31.0  # age the cache past the TTL
        probe.result()
        assert len(runs) == 2

    def test_a_run_past_its_deadline_reads_as_failed_and_is_never_duplicated(self):
        release = threading.Event()
        runs: list[int] = []

        def run(report):
            runs.append(1)
            report["model"] = "m"
            release.wait(5.0)

        # ttl 0: every call re-evaluates, so the second call below is a real
        # decision about the hung run rather than a cache hit.
        probe = _TtlProbe("t", run, ttl_s=0.0, deadline_s=0.05)
        first = probe.result()
        assert first["ok"] is False
        assert first["latency_ms"] is None
        assert "still running" in first["error"]
        assert first["model"] == "m"

        second = probe.result()
        assert second["ok"] is False
        assert len(runs) == 1  # a hung provider gets one thread, not one per health hit

        release.set()
        assert self._until(lambda: probe.result()["ok"] is True)
        # The hung run's own report is consumed once it finishes: it is a real
        # measurement, and replacing it would pay for a second provider call to
        # learn the same thing. With ttl 0 the call after that probes afresh.
        assert len(runs) == 1
        assert probe.result()["ok"] is True
        assert len(runs) == 2


class TestDependencyProbes:
    """The real ``_gate_probe`` / ``_embedding_probe``: what they call, with
    what, and that they cache."""

    @pytest.fixture(autouse=True)
    def _dependency_probes_healthy(self):
        """Override the module fixture: this class exercises the real probes.
        Each test starts and ends with an empty cache so order cannot leak."""
        import app.main as main_module

        main_module._gate_probe_state.reset()
        main_module._embedding_probe_state.reset()
        yield
        main_module._gate_probe_state.reset()
        main_module._embedding_probe_state.reset()

    def test_gate_probe_calls_the_gate_model_small_with_reasoning_off(self):
        import app.main as main_module
        from app.main import _gate_probe

        with (
            patch("app.main._llm_ready", return_value=True),
            patch("app.services.runtime_config.get_gate_model", return_value="gemini/gemini-2.5-flash"),
            patch("app.main._litellm.completion", return_value=MagicMock()) as completion,
        ):
            result = _gate_probe()

        assert result["ok"] is True
        assert result["error"] is None
        assert result["model"] == "gemini/gemini-2.5-flash"
        assert isinstance(result["latency_ms"], int)
        completion.assert_called_once()
        kwargs = completion.call_args.kwargs
        assert kwargs["model"] == "gemini/gemini-2.5-flash"
        assert kwargs["max_tokens"] == 5
        assert kwargs["timeout"] == main_module._LLM_PROBE_TIMEOUT_SECONDS
        # gemini-2.5 reasons by default and spends the whole budget doing so;
        # the gate's own calls turn it off, and so must the probe.
        assert kwargs["reasoning_effort"] == "disable"

    def test_gate_probe_uses_the_family_sentinel_for_an_openai_gate_model(self):
        from app.main import _gate_probe

        with (
            patch("app.main._llm_ready", return_value=True),
            patch("app.services.runtime_config.get_gate_model", return_value="openai/gpt-5.4-mini"),
            patch("app.main._litellm.completion", return_value=MagicMock()) as completion,
        ):
            assert _gate_probe()["ok"] is True

        assert completion.call_args.kwargs["reasoning_effort"] == "none"

    def test_gate_probe_reports_a_provider_failure_with_the_model(self):
        from app.main import _gate_probe

        with (
            patch("app.main._llm_ready", return_value=True),
            patch("app.services.runtime_config.get_gate_model", return_value="gemini/gemini-2.5-flash"),
            patch("app.main._litellm.completion", side_effect=RuntimeError("insufficient_quota")),
        ):
            result = _gate_probe()

        assert result["ok"] is False
        assert "insufficient_quota" in result["error"]
        assert result["model"] == "gemini/gemini-2.5-flash"

    def test_gate_probe_short_circuits_on_a_hollow_litellm(self):
        from app.main import _gate_probe

        with (
            patch("app.main._llm_ready", return_value=False),
            patch("app.main._litellm.completion") as completion,
        ):
            result = _gate_probe()

        assert result["ok"] is False
        assert result["error"]
        completion.assert_not_called()

    def test_gate_probe_is_cached_within_the_ttl(self):
        from app.main import _gate_probe

        with (
            patch("app.main._llm_ready", return_value=True),
            patch("app.services.runtime_config.get_gate_model", return_value="gemini/gemini-2.5-flash"),
            patch("app.main._litellm.completion", return_value=MagicMock()) as completion,
        ):
            _gate_probe()
            _gate_probe()

        completion.assert_called_once()

    def test_embedding_probe_embeds_one_text_within_the_query_wait_ceiling(self):
        from app.main import _embedding_probe
        from app.services.gemini_embedding import GEMINI_EMBED_MODEL

        with patch("app.ingestion.embedder.embed_chunks", return_value=[[0.1, 0.2, 0.3]]) as embed:
            result = _embedding_probe()

        assert result["ok"] is True
        assert result["error"] is None
        assert result["model"] == GEMINI_EMBED_MODEL
        assert isinstance(result["latency_ms"], int)
        # The query path's own ceiling on queueing behind bulk-ingestion debt:
        # a saturated limiter must read as the degradation it is for visitors.
        embed.assert_called_once_with(["health probe"], max_wait_s=2.0)

    def test_embedding_probe_treats_an_empty_vector_as_failure(self):
        from app.main import _embedding_probe

        with patch("app.ingestion.embedder.embed_chunks", return_value=[[]]):
            result = _embedding_probe()

        assert result["ok"] is False
        assert "no vector" in result["error"]

    def test_embedding_probe_reports_a_provider_failure(self):
        from app.main import _embedding_probe

        with patch("app.ingestion.embedder.embed_chunks", side_effect=RuntimeError("Gemini embedding failed")):
            result = _embedding_probe()

        assert result["ok"] is False
        assert "Gemini embedding failed" in result["error"]

    def test_embedding_probe_is_cached_within_the_ttl(self):
        from app.main import _embedding_probe

        with patch("app.ingestion.embedder.embed_chunks", return_value=[[0.1]]) as embed:
            _embedding_probe()
            _embedding_probe()

        embed.assert_called_once()


class TestDegradedSignal:
    """A failing gate-model or embedding probe is a degradation, not an
    outage: chats still flow, with the KB-only check skipped or retrieval
    reduced to keyword search. It is reported as ``degraded: true`` and must
    NOT move ``fully_ok``. That HTTP code is the deploy gate (deploy-api.yml
    polls ``/health/full`` and rolls back on 503), and a slow third-party
    model must never fail or roll back a deploy."""

    GATE_DOWN = {
        "ok": False,
        "latency_ms": None,
        "error": "APIConnectionError: down",
        "model": "gemini/gemini-2.5-flash",
    }
    EMBED_DOWN = {
        "ok": False,
        "latency_ms": 2004,
        "error": "EmbedWaitExceeded: limiter",
        "model": "gemini-embedding-001",
    }

    @staticmethod
    def _all_green(healthy_engine):
        from datetime import UTC, datetime

        recent = datetime.now(UTC).isoformat()
        return (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(recent)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
            patch("app.main._llm_probe", return_value=(True, None)),
        )

    def _full(self, healthy_engine, *extra):
        with ExitStack() as stack:
            for cm in (*self._all_green(healthy_engine), *extra):
                stack.enter_context(cm)
            response = health_check_full(_authed_request())
        return response, json.loads(response.body)

    def test_healthy_probes_report_not_degraded(self, healthy_engine):
        response, body = self._full(healthy_engine)
        assert response.status_code == 200
        assert body["degraded"] is False
        assert body["llm"]["gate_probe"] == GATE_PROBE_OK
        assert body["embedding"]["probe"] == EMBED_PROBE_OK

    def test_gate_model_failure_is_degraded_but_health_full_stays_200(self, healthy_engine):
        response, body = self._full(healthy_engine, patch("app.main._gate_probe", return_value=dict(self.GATE_DOWN)))
        assert response.status_code == 200
        assert body["status"] == "healthy"  # the label tracks the HTTP code, see _gather_health
        assert body["degraded"] is True
        assert body["llm"]["gate_probe"] == self.GATE_DOWN
        assert body["llm"]["probe_ok"] is True  # the primary model is a separate signal
        assert body["embedding"]["probe"]["ok"] is True

    def test_embedding_failure_is_degraded_but_health_full_stays_200(self, healthy_engine):
        response, body = self._full(
            healthy_engine, patch("app.main._embedding_probe", return_value=dict(self.EMBED_DOWN))
        )
        assert response.status_code == 200
        assert body["degraded"] is True
        assert body["embedding"]["probe"] == self.EMBED_DOWN
        assert body["llm"]["gate_probe"]["ok"] is True

    def test_fully_ok_is_unaffected_when_both_probes_fail(self, healthy_engine):
        with ExitStack() as stack:
            for cm in (
                *self._all_green(healthy_engine),
                patch("app.main._gate_probe", return_value=dict(self.GATE_DOWN)),
                patch("app.main._embedding_probe", return_value=dict(self.EMBED_DOWN)),
            ):
                stack.enter_context(cm)
            payload, ready_to_serve, fully_ok = _gather_health()
        assert ready_to_serve is True
        assert fully_ok is True
        assert payload["degraded"] is True

    def test_readiness_endpoint_is_unaffected_too(self, healthy_engine):
        with ExitStack() as stack:
            for cm in (
                *self._all_green(healthy_engine),
                patch("app.main._gate_probe", return_value=dict(self.GATE_DOWN)),
            ):
                stack.enter_context(cm)
            response = health_check(_authed_request())
        assert response.status_code == 200
        assert json.loads(response.body)["degraded"] is True


# ── _fallback_count_1h (AR-16) ──────────────────────────────────────────────


class TestFallbackCount1h:
    def test_sums_the_last_hour_of_fallback_events(self):
        from app.main import _fallback_count_1h

        with patch("app.core.metrics.get_metric_counts", return_value={"2026070812": 3, "2026070811": 2}):
            assert _fallback_count_1h() == 5

    def test_returns_none_not_zero_when_unreadable(self):
        """Distinguish 'confirmed zero fallbacks' from 'couldn't check', a
        silent Redis outage must not read as a false-positive clean bill of
        health."""
        from app.main import _fallback_count_1h

        with patch("app.core.metrics.get_metric_counts", side_effect=RuntimeError("redis down")):
            assert _fallback_count_1h() is None

    def test_health_full_includes_fallback_count(self, healthy_engine):
        from datetime import UTC, datetime

        recent = datetime.now(UTC).isoformat()
        with (
            patch("app.main.engine", healthy_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(recent)),
            patch("app.worker.enqueue.WORKER_ENABLED", True),
            patch("app.main._llm_probe", return_value=(True, None)),
            patch("app.main._fallback_count_1h", return_value=7),
        ):
            response = health_check_full(_authed_request())
        body = json.loads(response.body)
        assert body["llm"]["fallback_count_1h"] == 7


# ── Detail gate (recon hardening) ──────────────────────────────────────────


def _healthy_patches(healthy_engine):
    """The set of patches that make _gather_health report a fully healthy
    system with the worker intentionally disabled (so status == 'healthy')."""
    return (
        patch("app.main.engine", healthy_engine),
        patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(None)),
        patch("app.worker.enqueue.WORKER_ENABLED", False),
        patch("app.main._llm_probe", return_value=(True, None)),
    )


class TestHealthDetailGate:
    """The verbose payload is attacker recon (stack, version for CVE matching,
    chat-gate ceiling for DoS planning, billing state). It must be disclosed
    ONLY to a caller presenting a valid X-Health-Token; everyone else gets the
    bare status label, while the HTTP status *code* stays fully accurate so
    deploy gates and uptime monitors are unaffected.

    `_DETAIL_ONLY_KEYS` are the sensitive fields that must never appear in an
    anonymous response. `status` is the only key that always ships.
    """

    _DETAIL_ONLY_KEYS = (
        "database",
        "redis",
        "worker",
        "llm",
        "embedding",
        "degraded",
        "pool",
        "chat_gate",
        "billing",
        "version",
    )

    def test_anonymous_caller_gets_only_status_label(self, healthy_engine):
        """No token → body is exactly {"status": ...}, code still correct."""
        with ExitStack() as stack:
            for cm in _healthy_patches(healthy_engine):
                stack.enter_context(cm)
            response = health_check(_request_with_token(None))
        body = json.loads(response.body)
        assert response.status_code == 200
        assert body == {"status": "healthy"}
        for key in self._DETAIL_ONLY_KEYS:
            assert key not in body

    def test_wrong_token_gets_only_status_label(self, healthy_engine):
        """A present-but-wrong token is treated exactly like no token."""
        with ExitStack() as stack:
            for cm in _healthy_patches(healthy_engine):
                stack.enter_context(cm)
            response = health_check(_request_with_token(b"not-the-real-token"))
        body = json.loads(response.body)
        assert response.status_code == 200
        assert body == {"status": "healthy"}

    def test_valid_token_unlocks_full_payload(self, healthy_engine):
        with ExitStack() as stack:
            for cm in _healthy_patches(healthy_engine):
                stack.enter_context(cm)
            response = health_check(_authed_request())
        body = json.loads(response.body)
        assert response.status_code == 200
        for key in self._DETAIL_ONLY_KEYS:
            assert key in body

    def test_status_code_is_accurate_even_when_body_is_minimal(self, broken_engine):
        """A 503 must still be a 503 for an anonymous caller — the gate hides
        the body, never the response code the monitors depend on."""
        with (
            patch("app.main.engine", broken_engine),
            patch("app.core.cache.get_redis", return_value=_redis_with_heartbeat(None)),
            patch("app.worker.enqueue.WORKER_ENABLED", False),
            patch("app.main._llm_probe", return_value=(True, None)),
        ):
            response = health_check(_request_with_token(None))
        body = json.loads(response.body)
        assert response.status_code == 503
        assert body == {"status": "unhealthy"}

    def test_unset_token_never_leaks_detail_even_with_matching_header(self, healthy_engine):
        """Secure by default: when HEALTH_DETAIL_TOKEN is unset, no header value
        (including an empty string) can unlock the detailed payload."""
        with patch("app.main.HEALTH_DETAIL_TOKEN", None), ExitStack() as stack:
            for cm in _healthy_patches(healthy_engine):
                stack.enter_context(cm)
            response = health_check(_request_with_token(b""))
        body = json.loads(response.body)
        assert body == {"status": "healthy"}


class TestTtlProbePriming:
    """``prime()`` starts a run without waiting so the health payload can pay
    every probe's deadline at once instead of one after another. A primed run
    that finishes before ``result()`` is asked must be consumed, never
    duplicated by a second provider call."""

    @staticmethod
    def _until(predicate, timeout_s: float = 3.0) -> bool:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return predicate()

    def test_primed_run_is_consumed_not_repeated(self):
        calls = []

        def run(report):
            calls.append(1)
            report["model"] = "m"

        probe = _TtlProbe("t", run, ttl_s=30.0, deadline_s=1.0)
        probe.prime()
        assert self._until(lambda: len(calls) == 1)
        # The run has finished by now; result() must use it, not start another.
        assert self._until(lambda: probe._pending is not None and probe._pending.done.is_set())
        result = probe.result()
        assert result["ok"] is True and result["model"] == "m"
        assert calls == [1]
        assert probe.result()["ok"] is True  # cached within the TTL
        assert calls == [1]

    def test_prime_is_a_noop_while_the_verdict_is_fresh(self):
        calls = []

        def run(report):
            calls.append(1)

        probe = _TtlProbe("t", run, ttl_s=30.0, deadline_s=1.0)
        probe.result()
        probe.prime()
        probe.prime()
        assert calls == [1]

    def test_two_primed_probes_wait_concurrently(self):
        gate = threading.Event()

        def slow(report):
            gate.wait(2.0)

        a = _TtlProbe("a", slow, ttl_s=30.0, deadline_s=0.3)
        b = _TtlProbe("b", slow, ttl_s=30.0, deadline_s=0.3)
        t0 = time.monotonic()
        a.prime()
        b.prime()
        ra, rb = a.result(), b.result()
        elapsed = time.monotonic() - t0
        gate.set()
        assert ra["ok"] is False and rb["ok"] is False
        # Both deadlines overlapped: well under the 0.6s a sequential wait costs.
        assert elapsed < 0.5
