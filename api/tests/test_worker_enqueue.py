"""Behavioral tests for ``app/worker/enqueue.py`` — the API→ARQ handoff.

This module is small but it is the seam every background job crosses (invoice
PDFs, transactional email, webhooks, ingestion). It was the least-covered file
in the backend, and two of its behaviors are documented fixes for real
incidents:

* the fire-and-forget path must hold a **strong reference** to the scheduled
  task, or the event loop garbage-collects it mid-flight and the job silently
  never reaches Redis;
* the no-running-loop path must **not** reuse the module-level pool, because
  ``asyncio.run`` closes its loop each call and a cached pool becomes a
  use-after-close ("Event loop is closed") on every subsequent call.

Both are invisible in production until jobs quietly stop arriving, so they are
worth pinning. Redis is never contacted: ``create_pool`` / ``enqueue`` are
replaced at the module seam and the tests assert the dispatch decision and the
failure handling, not that a mock was called.
"""

from __future__ import annotations

import asyncio

import pytest

from app.worker import enqueue as eq

# ── _get_redis_settings — configuration behavior ─────────────────────────────


def test_missing_redis_url_raises_a_clear_error(monkeypatch):
    """Config errors must fail loudly at the seam rather than surfacing later as
    an opaque connection error inside a worker."""
    monkeypatch.delenv("REDIS_URL", raising=False)
    with pytest.raises(RuntimeError, match="REDIS_URL"):
        eq._get_redis_settings()


def test_redis_url_is_parsed_into_settings(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/3")
    settings = eq._get_redis_settings()
    assert settings.host == "localhost"
    assert settings.port == 6379
    assert settings.database == 3


# ── enqueue() — dedup contract ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_enqueue_returns_the_job_on_success(monkeypatch):
    class _Job:
        job_id = "job-123"

    class _Pool:
        async def enqueue_job(self, name, *a, **kw):
            assert name == "task_send_email"
            return _Job()

    monkeypatch.setattr(eq, "_get_pool", lambda: _fake_async(_Pool()))
    job = await eq.enqueue("task_send_email", 1, foo="bar")
    assert job.job_id == "job-123"


@pytest.mark.asyncio
async def test_enqueue_returns_none_when_arq_deduplicates(monkeypatch):
    """ARQ returns ``None`` for an already-queued job id. That is a normal
    outcome, not an error — callers branch on it, so it must pass through."""

    class _Pool:
        async def enqueue_job(self, *a, **kw):
            return None

    monkeypatch.setattr(eq, "_get_pool", lambda: _fake_async(_Pool()))
    assert await eq.enqueue("task_dupe") is None


def _fake_async(value):
    """Return an awaitable resolving to ``value`` (stand-in for ``_get_pool``)."""

    async def _coro():
        return value

    return _coro()


# ── enqueue_sync — the two dispatch paths ────────────────────────────────────


def test_enqueue_sync_without_a_running_loop_returns_the_job_id(monkeypatch):
    """Sync caller, no loop: the job is enqueued inline and its id returned."""
    closed: list[bool] = []

    class _Job:
        job_id = "sync-job-1"

    class _Pool:
        async def enqueue_job(self, name, *a, **kw):
            return _Job()

        async def aclose(self):
            closed.append(True)

    async def _fake_create_pool(*_a, **_kw):
        return _Pool()

    monkeypatch.setattr(eq, "create_pool", _fake_create_pool)
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")

    assert eq.enqueue_sync("task_x") == "sync-job-1"
    # The per-call pool is always closed — leaking one per call would exhaust
    # connections on a busy sync endpoint.
    assert closed == [True]


def test_enqueue_sync_builds_a_fresh_pool_per_call(monkeypatch):
    """Regression guard: reusing a pool across ``asyncio.run`` calls raises
    "Event loop is closed" on the second call. Two sequential calls must both
    succeed, each with its own pool."""
    pools: list[object] = []

    class _Job:
        job_id = "id"

    class _Pool:
        def __init__(self):
            pools.append(self)

        async def enqueue_job(self, *a, **kw):
            return _Job()

        async def aclose(self):
            pass

    async def _fake_create_pool(*_a, **_kw):
        return _Pool()

    monkeypatch.setattr(eq, "create_pool", _fake_create_pool)
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")

    eq.enqueue_sync("task_a")
    eq.enqueue_sync("task_b")

    assert len(pools) == 2
    assert pools[0] is not pools[1]


def test_enqueue_sync_returns_none_when_deduplicated(monkeypatch):
    class _Pool:
        async def enqueue_job(self, *a, **kw):
            return None

        async def aclose(self):
            pass

    async def _fake_create_pool(*_a, **_kw):
        return _Pool()

    monkeypatch.setattr(eq, "create_pool", _fake_create_pool)
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")
    assert eq.enqueue_sync("task_dupe") is None


@pytest.mark.asyncio
async def test_enqueue_sync_inside_a_running_loop_schedules_and_completes(monkeypatch):
    """The fire-and-forget path. It returns ``None`` immediately (no job id is
    available synchronously) but the enqueue MUST still complete — the strong
    reference in ``_pending_enqueue_tasks`` is what guarantees that."""
    fired: list[str] = []

    async def _fake_enqueue(name, *a, **kw):
        await asyncio.sleep(0)  # force a suspension point, as real I/O would
        fired.append(name)

    monkeypatch.setattr(eq, "enqueue", _fake_enqueue)

    result = eq.enqueue_sync("task_bg", 7, k="v")
    assert result is None  # no id synchronously — documented contract
    assert eq._pending_enqueue_tasks  # held strongly while in flight

    await asyncio.sleep(0.05)  # let the scheduled task run

    assert fired == ["task_bg"]
    # And the registry drains itself, so it can't grow without bound.
    assert not eq._pending_enqueue_tasks


@pytest.mark.asyncio
async def test_background_enqueue_failure_is_swallowed_not_raised(monkeypatch):
    """A Redis outage must not surface as an unhandled task exception that takes
    down the request that scheduled it — the job is lost, loudly logged, and the
    caller continues."""

    async def _boom(*_a, **_kw):
        raise RuntimeError("redis down")

    monkeypatch.setattr(eq, "enqueue", _boom)

    assert eq.enqueue_sync("task_fails") is None
    await asyncio.sleep(0.05)
    assert not eq._pending_enqueue_tasks  # cleaned up even on failure


# ── get_job_status — status mapping ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_job_status_maps_arq_states_to_api_vocabulary(monkeypatch):
    """The polling endpoint's contract. ``deferred`` and ``queued`` both collapse
    to "queued" for the client."""
    from arq.jobs import JobStatus

    cases = {
        JobStatus.deferred: "queued",
        JobStatus.queued: "queued",
        JobStatus.in_progress: "in_progress",
        JobStatus.complete: "complete",
    }
    for arq_status, expected in cases.items():
        info = _JobInfo(status=arq_status, success=True, result=None)
        monkeypatch.setattr(eq, "_get_pool", lambda: _fake_async(object()))
        with _patched_job(monkeypatch, info):
            out = await eq.get_job_status("j1")
        assert out["status"] == expected, arq_status


@pytest.mark.asyncio
async def test_completed_but_unsuccessful_job_reports_failed(monkeypatch):
    """A job that ran to completion and threw must NOT report "complete" — the
    UI would show success for a failed invoice render."""
    from arq.jobs import JobStatus

    info = _JobInfo(status=JobStatus.complete, success=False, result="boom")
    monkeypatch.setattr(eq, "_get_pool", lambda: _fake_async(object()))
    with _patched_job(monkeypatch, info):
        out = await eq.get_job_status("j2")
    assert out["status"] == "failed"


@pytest.mark.asyncio
async def test_unknown_job_id_reports_not_found(monkeypatch):
    monkeypatch.setattr(eq, "_get_pool", lambda: _fake_async(object()))
    with _patched_job(monkeypatch, None):
        out = await eq.get_job_status("nope")
    assert out == {"job_id": "nope", "status": "not_found"}


# ── helpers for get_job_status ───────────────────────────────────────────────


class _JobInfo:
    def __init__(self, *, status, success, result):
        self.status = status
        self.success = success
        self.result = result
        self.function = "task_x"
        self.enqueue_time = None
        self.start_time = None
        self.finish_time = None


class _patched_job:
    """Patch ``arq.jobs.Job`` so ``get_job_status`` reads our canned info."""

    def __init__(self, monkeypatch, info):
        self.monkeypatch = monkeypatch
        self.info = info

    def __enter__(self):
        import arq.jobs

        info = self.info

        class _FakeJob:
            def __init__(self, *_a, **_kw):
                pass

            async def info(self):
                return info

        self.monkeypatch.setattr(arq.jobs, "Job", _FakeJob)
        return self

    def __exit__(self, *_exc):
        return False
