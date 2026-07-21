"""Ownership-aware crawl lock: token compare-and-delete anti-corruption guard.

The per-client crawl lock exists to stop two crawls double-ingesting the same
URLs (there is no unique index on ``Document`` to catch the resulting duplicate
chunks). The original implementation released the lock with a token-less
``DEL``: if a long-running holder's TTL expired mid-run and a *second* crawl
acquired a fresh lock, the first holder's release would delete the second
crawl's lock, letting a third crawl start concurrently → the exact double
ingest the lock is meant to prevent.

The fix makes acquire return an ownership token and release compare-and-delete
so a stale holder can only ever free *its own* lock. These tests drive the
deterministic in-process fallback path (``get_redis()`` returns ``None``) so
they don't need a live Redis; the Lua compare-and-delete on the Redis path is
the same predicate expressed server-side.
"""

from __future__ import annotations

import pytest

from app.services import crawler_service


@pytest.fixture(autouse=True)
def _no_redis_and_clean_locks(monkeypatch):
    """Force the in-process fallback and isolate ``_local_locks`` per test."""
    monkeypatch.setattr(crawler_service, "get_redis", lambda: None)
    crawler_service._local_locks.clear()
    yield
    crawler_service._local_locks.clear()


def test_acquire_returns_kind_prefixed_token_and_blocks_second_acquire():
    token = crawler_service.acquire_crawl_lock(101, kind="recrawl")
    assert isinstance(token, str)
    assert token.startswith("recrawl:")
    # Token half is a non-empty uuid hex.
    assert len(token.split(":", 1)[1]) == 32

    # A second acquire for the same client is refused while the lock is held.
    assert crawler_service.acquire_crawl_lock(101, kind="recrawl") is None
    # ...and refused regardless of the caller's kind.
    assert crawler_service.acquire_crawl_lock(101) is None


def test_holder_reports_value_while_held_and_none_when_free():
    assert crawler_service.crawl_lock_holder(202) is None
    token = crawler_service.acquire_crawl_lock(202, kind="interactive")
    assert crawler_service.crawl_lock_holder(202) == token
    crawler_service.release_crawl_lock(202, token)
    assert crawler_service.crawl_lock_holder(202) is None


def test_wrong_token_release_does_not_free_lock_but_right_token_does():
    """Core anti-corruption assertion: a stale holder cannot free another
    crawl's lock, and only the true owner's token releases it."""
    token = crawler_service.acquire_crawl_lock(303, kind="interactive")
    assert token is not None

    # A stale holder attempting to release with a foreign token is a no-op.
    crawler_service.release_crawl_lock(303, "interactive:deadbeefdeadbeefdeadbeefdeadbeef")
    assert crawler_service.acquire_crawl_lock(303) is None  # still held
    assert crawler_service.crawl_lock_holder(303) == token

    # The true owner's token frees it; a fresh acquire then succeeds.
    crawler_service.release_crawl_lock(303, token)
    assert crawler_service.crawl_lock_holder(303) is None
    new_token = crawler_service.acquire_crawl_lock(303)
    assert new_token is not None
    assert new_token != token


def test_legacy_tokenless_release_frees_unconditionally():
    """A None token (older enqueued job during a rolling deploy) falls back to
    the legacy unconditional delete so the lock is never wedged."""
    token = crawler_service.acquire_crawl_lock(404, kind="interactive")
    assert token is not None
    crawler_service.release_crawl_lock(404, token=None)
    assert crawler_service.crawl_lock_holder(404) is None
    assert crawler_service.acquire_crawl_lock(404) is not None
