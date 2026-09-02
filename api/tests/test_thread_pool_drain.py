"""The background pool can be drained, so a test cannot leave a thread behind.

Why this exists: the test harness TRUNCATEs every table after each test. A
task still running on the shared background pool from an earlier test (a
geolocation lookup, a lead enrichment, a webhook delivery) may hold a
transaction on one of those tables, and TRUNCATE then waits for it with no
output. On 2026-09-02 a CI run sat at 65% of the suite for over half an hour
that way. The harness now drains the pool before it truncates; this pins the
primitive it relies on.
"""

from __future__ import annotations

import threading
import time

from app.core import thread_pool


def test_drain_returns_true_once_submitted_work_has_finished():
    done = threading.Event()

    def work() -> None:
        time.sleep(0.05)
        done.set()

    thread_pool.submit_background(work)
    assert thread_pool.drain_background(timeout=5.0) is True
    assert done.is_set()


def test_drain_reports_false_while_work_is_still_running_then_true():
    release = threading.Event()

    def work() -> None:
        release.wait(5.0)

    thread_pool.submit_background(work)
    # Not finished yet: the caller is told, rather than blocked indefinitely.
    assert thread_pool.drain_background(timeout=0.1) is False
    release.set()
    assert thread_pool.drain_background(timeout=5.0) is True


def test_drain_is_a_no_op_when_nothing_is_running():
    assert thread_pool.drain_background(timeout=0.1) is True


def test_a_failing_task_still_counts_as_finished():
    def work() -> None:
        raise RuntimeError("boom")

    thread_pool.submit_background(work)
    assert thread_pool.drain_background(timeout=5.0) is True


def test_pending_count_names_what_is_still_running():
    release = threading.Event()

    def slow_geolocation() -> None:
        release.wait(5.0)

    thread_pool.submit_background(slow_geolocation)
    try:
        pending = thread_pool.pending_background()
        assert pending == ["slow_geolocation"]
    finally:
        release.set()
        thread_pool.drain_background(timeout=5.0)
    assert thread_pool.pending_background() == []
