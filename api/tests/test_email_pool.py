"""The email pool: separate from the shared background pool, and never drops a send.

Two properties the dispatch relies on. First, an email runs on an
``oyechats-email`` worker, not one of the three shared ``oyechats-bg`` workers
that carry the per-turn LLM calls, so a verification code cannot queue behind a
45-second BANT extraction. Second, once the executor has been shut down (the
interpreter does this at exit), a submit falls back to a plain thread instead of
raising into the caller or silently losing the send.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

from app.core import thread_pool


def test_email_runs_on_the_email_pool_not_the_shared_one():
    seen: dict[str, str] = {}
    done = threading.Event()

    def send() -> None:
        seen["thread"] = threading.current_thread().name
        done.set()

    thread_pool.submit_email(send)
    assert done.wait(5.0)
    assert seen["thread"].startswith("oyechats-email")
    assert thread_pool.drain_background(timeout=5.0) is True


def test_email_still_sends_after_the_pool_is_shut_down(monkeypatch):
    closed = ThreadPoolExecutor(max_workers=1, thread_name_prefix="oyechats-email-closed")
    closed.shutdown(wait=True)
    monkeypatch.setattr(thread_pool, "_email_pool", closed)
    done = threading.Event()

    thread_pool.submit_email(done.set)

    assert done.wait(5.0), "the send was dropped once the pool was shut down"


def test_shutdown_pool_leaves_the_email_pool_open(monkeypatch):
    shared = ThreadPoolExecutor(max_workers=1, thread_name_prefix="oyechats-bg-test")
    monkeypatch.setattr(thread_pool, "_pool", shared)
    thread_pool.shutdown_pool()
    assert shared._shutdown is True
    assert thread_pool._email_pool._shutdown is False
