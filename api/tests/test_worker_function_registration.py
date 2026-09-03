"""What the ARQ worker will actually accept and how it keeps job results.

I11: ``task_reembed_all_documents`` existed, was documented, and was never in
``WorkerSettings.functions`` — every enqueue of it was rejected outright.

I7 (worker half): the demo-screenshot capture and the install probe are both
enqueued under a FIXED job id so a burst of triggers collapses into one job.
ARQ refuses an enqueue while EITHER the job key or the ``result:{job_id}`` key
exists, and results live an hour by default, so a finished capture silently
swallowed every re-trigger for the next hour while the Deploy card sat on
"taking a picture now". Keeping no result restores de-duplication to the
in-flight window, which is what the fixed job id was for.
"""

import os

import pytest
from arq.worker import Function, func


@pytest.fixture
def worker_settings(monkeypatch):
    """``app.worker.settings`` parses REDIS_URL at class-body time and refuses
    to import without it. Parsing is all that happens (no connection), so a
    loopback DSN keeps the test runnable with no worker env — set through
    monkeypatch so it is reverted and cannot switch Redis on for other tests.
    """
    monkeypatch.setenv("REDIS_URL", os.getenv("REDIS_URL") or "redis://localhost:6379/0")
    from app.worker.settings import WorkerSettings

    return WorkerSettings


def _registered(worker_settings) -> dict[str, Function]:
    return {f.name if isinstance(f, Function) else f.__qualname__: func(f) for f in worker_settings.functions}


def test_every_registered_entry_is_unique(worker_settings):
    names = list(_registered(worker_settings))
    assert len(names) == len(set(names))


def test_reembed_all_documents_is_registered_with_a_long_timeout(worker_settings):
    entry = _registered(worker_settings).get("task_reembed_all_documents")
    assert entry is not None, "an unregistered task cannot be enqueued at all"
    # The backfill paces itself against the shared embed rate limiter and runs
    # far past the worker-wide 1600s default.
    assert entry.timeout_s is not None and entry.timeout_s > worker_settings.job_timeout


def test_fixed_job_id_tasks_keep_no_result(worker_settings):
    registered = _registered(worker_settings)
    for name in ("task_capture_demo_screenshot", "task_probe_bot_installs"):
        entry = registered.get(name)
        assert entry is not None, f"{name} must stay registered"
        assert entry.keep_result_s == 0, (
            f"{name} is enqueued under a fixed job id; a lingering result key blocks re-enqueue for an hour"
        )


def test_kb_usage_recompute_runs_daily(worker_settings):
    """I6: the only backstop for counter drift from cascade deletes."""
    crons = {c.name: c for c in worker_settings.cron_jobs}
    assert "cron:task_recompute_kb_usage" in crons
    job = crons["cron:task_recompute_kb_usage"]
    assert job.hour == 3 and job.minute == 0
