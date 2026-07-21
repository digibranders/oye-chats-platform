"""An interactive crawl must preempt a background auto-recrawl, not 429.

Once auto-recrawl shares the per-client crawl lock, a user clicking
Train/Recrawl while an hourly background recrawl is mid-run would otherwise
get a hard 429 for a job they didn't start. ``_acquire_crawl_lock_or_preempt``
resolves this: a ``recrawl:`` holder is signalled to cancel and the interactive
crawl waits (bounded) for the lock to free, while an ``interactive:`` holder is
NOT preempted (two user crawls must not stomp each other → the caller 429s).

These are pure unit tests of the helper: ``acquire_crawl_lock`` /
``crawl_lock_holder`` / ``request_cancellation`` and ``asyncio.sleep`` are all
driven via monkeypatch, so the bounded loop runs instantly and never hangs.
"""

from __future__ import annotations

import asyncio

import pytest

from app.api import document_routes


class _AcquireStub:
    """Callable returning a scripted sequence of ``acquire_crawl_lock`` results.

    The last value is repeated once the script is exhausted so a "never frees"
    scenario keeps returning ``None`` for the whole bounded loop.
    """

    def __init__(self, returns: list[str | None]) -> None:
        self._returns = returns
        self.calls = 0

    def __call__(self, client_id: int, *args, **kwargs) -> str | None:
        idx = min(self.calls, len(self._returns) - 1)
        self.calls += 1
        return self._returns[idx]


@pytest.fixture
def _no_sleep(monkeypatch):
    """Replace ``asyncio.sleep`` with a no-op that tallies its call count."""
    sleeps: list[float] = []

    async def _fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(document_routes.asyncio, "sleep", _fake_sleep)
    return sleeps


def test_lock_immediately_free_returns_token_without_requesting_cancellation(monkeypatch, _no_sleep):
    acquire = _AcquireStub(["interactive:tok-free"])
    monkeypatch.setattr(document_routes, "acquire_crawl_lock", acquire)

    cancels: list[int] = []
    monkeypatch.setattr(document_routes, "request_cancellation", lambda cid: cancels.append(cid))
    monkeypatch.setattr(
        document_routes,
        "crawl_lock_holder",
        lambda cid: pytest.fail("holder must not be consulted when the lock is free"),
    )

    token = asyncio.run(document_routes._acquire_crawl_lock_or_preempt(42))

    assert token == "interactive:tok-free"
    assert cancels == []  # nothing to preempt
    assert _no_sleep == []  # returned on the fast path, no polling


def test_interactive_holder_is_not_preempted(monkeypatch, _no_sleep):
    monkeypatch.setattr(document_routes, "acquire_crawl_lock", _AcquireStub([None]))
    monkeypatch.setattr(document_routes, "crawl_lock_holder", lambda cid: "interactive:someone-else")

    cancels: list[int] = []
    monkeypatch.setattr(document_routes, "request_cancellation", lambda cid: cancels.append(cid))

    token = asyncio.run(document_routes._acquire_crawl_lock_or_preempt(42))

    assert token is None  # caller 429s
    assert cancels == []  # a user crawl is never cancelled by another user crawl
    assert _no_sleep == []  # bailed before the wait loop


def test_recrawl_holder_is_preempted_and_lock_acquired_once_freed(monkeypatch, _no_sleep):
    # Initial acquire fails (recrawl holds it), first poll still fails, second
    # poll succeeds once the recrawl has released.
    acquire = _AcquireStub([None, None, "interactive:tok-preempt"])
    monkeypatch.setattr(document_routes, "acquire_crawl_lock", acquire)
    monkeypatch.setattr(document_routes, "crawl_lock_holder", lambda cid: "recrawl:bg-job")

    cancels: list[int] = []
    monkeypatch.setattr(document_routes, "request_cancellation", lambda cid: cancels.append(cid))

    token = asyncio.run(document_routes._acquire_crawl_lock_or_preempt(7))

    assert token == "interactive:tok-preempt"
    assert cancels == [7]  # cancellation requested exactly once
    assert acquire.calls == 3  # initial + two polls
    assert len(_no_sleep) == 2  # slept before each poll, stopped as soon as acquired


def test_recrawl_holder_never_frees_returns_none_after_bounded_loop(monkeypatch, _no_sleep):
    acquire = _AcquireStub([None])  # never frees
    monkeypatch.setattr(document_routes, "acquire_crawl_lock", acquire)
    monkeypatch.setattr(document_routes, "crawl_lock_holder", lambda cid: "recrawl:bg-job")

    cancels: list[int] = []
    monkeypatch.setattr(document_routes, "request_cancellation", lambda cid: cancels.append(cid))

    token = asyncio.run(document_routes._acquire_crawl_lock_or_preempt(7))

    expected_polls = int(document_routes._PREEMPT_MAX_WAIT_S / document_routes._PREEMPT_POLL_INTERVAL_S)
    assert token is None  # bounded fallback → caller 429s
    assert cancels == [7]  # requested once, up front
    assert len(_no_sleep) == expected_polls  # exactly the bounded number of polls, no hang
    assert acquire.calls == 1 + expected_polls  # initial acquire + one per poll
