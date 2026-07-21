"""Auto-recrawl must take the per-client crawl lock before fetch+ingest.

Without a lock, a scheduled auto-recrawl can run concurrently with an
interactive crawl (or another recrawl) for the same client — both write
through ``batch_web_ingestion`` for the same bot/URLs at once, producing
duplicate chunks that permanently degrade retrieval (there is no unique
index on ``Document`` to catch it at the DB layer).

``recrawl_bot`` must:

1. Try to take the same per-client lock the interactive crawl path uses
   (``acquire_crawl_lock`` / ``release_crawl_lock`` in
   ``app.services.crawler_service``), keyed on ``client_id``.
2. If the lock is already held, skip this cycle entirely — no fetch, no
   ingest — and leave ``next_recrawl_at`` untouched so the next hourly
   sweep retries once the lock frees, instead of parking the bot for a
   full 7-day interval.
3. Always release the lock in a ``finally``, even when ingestion raises,
   so a crashed run never wedges the client's crawl lock for other paths.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Bot, Client, Document
from app.services import recrawl_service

pytestmark = pytest.mark.skipif(
    __import__("os").getenv("DB_URL") is None,
    reason="needs a reachable Postgres at DB_URL",
)


@contextmanager
def _ctx(session):
    yield session


def _mk_client(db, email):
    c = Client(name="R", email=email, api_key=f"key-{email}")
    db.add(c)
    db.flush()
    return c


def _mk_bot(db, client_id, key, **kw):
    b = Bot(client_id=client_id, name=f"B-{key}", bot_key=key, **kw)
    db.add(b)
    db.flush()
    return b


def _mk_doc(db, bot_id, client_id, name, source="crawl"):
    db.add(
        Document(
            client_id=client_id,
            bot_id=bot_id,
            document_name=name,
            source=source,
            file_hash=f"h-{name}",
            content="x",
            embedding=[0.0] * 768,
        )
    )


def _mk_recrawlable_bot(db, key):
    c = _mk_client(db, f"{key}@test.example")
    original_next = datetime.now(UTC) - timedelta(hours=1)
    bot = _mk_bot(
        db,
        c.id,
        f"bot-{key}",
        recrawl_enabled=True,
        next_recrawl_at=original_next,
    )
    _mk_doc(db, bot.id, c.id, "https://a.test/page1")
    db.commit()
    return c, bot, original_next


def test_lock_held_skips_without_ingest_or_reschedule(db, monkeypatch):
    _, bot, original_next = _mk_recrawlable_bot(db, "rc-lock-held")

    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(db))
    # Lock already held → acquire returns None (the new ownership-aware API
    # returns a token string on success, None on contention).
    monkeypatch.setattr(recrawl_service, "acquire_crawl_lock", lambda client_id, **kw: None)

    ingest_calls: list[tuple] = []
    monkeypatch.setattr(
        recrawl_service,
        "batch_web_ingestion",
        lambda *a, **kw: ingest_calls.append((a, kw)) or {"chunks": 0, "pages_charged": 0, "credits_deducted": 0},
    )

    result = asyncio.run(recrawl_service.recrawl_bot(bot.id))

    assert result["status"] == "skipped"
    assert ingest_calls == []

    db.refresh(bot)
    # Schedule must be left untouched — NOT jumped 7 days out — so the next
    # hourly sweep retries this bot once the lock frees.
    assert bot.next_recrawl_at == original_next


def test_lock_free_runs_and_releases(db, monkeypatch):
    _, bot, _ = _mk_recrawlable_bot(db, "rc-lock-free")

    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(db))
    # Lock free → acquire hands back an ownership token; the finally must
    # release with that exact token.
    monkeypatch.setattr(recrawl_service, "acquire_crawl_lock", lambda client_id, **kw: "recrawl:tok-free")

    released: list[tuple[int, str | None]] = []
    monkeypatch.setattr(
        recrawl_service,
        "release_crawl_lock",
        lambda client_id, token=None: released.append((client_id, token)),
    )

    async def _fake_fetch(urls, **kw):
        return {"results": [{"url": "https://a.test/page1", "content": "fresh content"}]}

    monkeypatch.setattr(recrawl_service, "fetch_urls", _fake_fetch)
    monkeypatch.setattr(
        recrawl_service,
        "batch_web_ingestion",
        lambda client_id, pages, **kw: {"chunks": 3, "pages_charged": 1, "credits_deducted": 0},
    )

    result = asyncio.run(recrawl_service.recrawl_bot(bot.id))

    assert result["status"] in {"success", "partial", "failed"}
    assert result["status"] != "skipped"
    db.refresh(bot)
    # Released exactly once, with the token acquire handed back (ownership-checked).
    assert released == [(bot.client_id, "recrawl:tok-free")]


def test_lock_released_on_ingest_failure(db, monkeypatch):
    _, bot, _ = _mk_recrawlable_bot(db, "rc-lock-fail")

    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(recrawl_service, "acquire_crawl_lock", lambda client_id, **kw: "recrawl:tok-fail")

    released: list[tuple[int, str | None]] = []
    monkeypatch.setattr(
        recrawl_service,
        "release_crawl_lock",
        lambda client_id, token=None: released.append((client_id, token)),
    )

    async def _fake_fetch(urls, **kw):
        return {"results": [{"url": "https://a.test/page1", "content": "fresh content"}]}

    monkeypatch.setattr(recrawl_service, "fetch_urls", _fake_fetch)

    def _boom(*a, **kw):
        raise RuntimeError("embedding provider down")

    monkeypatch.setattr(recrawl_service, "batch_web_ingestion", _boom)

    # recrawl_bot's contract is "never raises" — the ingest failure is caught
    # internally and tallied into the summary.
    result = asyncio.run(recrawl_service.recrawl_bot(bot.id))

    assert result is not None
    db.refresh(bot)
    assert released == [(bot.client_id, "recrawl:tok-fail")]


def test_preemption_yields_to_interactive_crawl(db, monkeypatch):
    """A cancel requested AFTER the recrawl started makes it yield.

    An interactive crawl preempts a background recrawl by setting the cancel
    flag then waiting for the lock. The recrawl must honour that flag right
    after fetching (before ingest): return ``preempted`` WITHOUT persisting a
    summary (so ``next_recrawl_at`` stays due and the sweep retries), and its
    ``finally`` must release the lock so the waiting interactive crawl can take
    it. ``clear_cancellation`` must run right after acquire so a *stale* flag
    from a previously-timed-out preemption can't spuriously abort this fresh run.
    """
    _, bot, original_next = _mk_recrawlable_bot(db, "rc-preempt")

    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(recrawl_service, "acquire_crawl_lock", lambda client_id, **kw: "recrawl:tok-preempt")

    released: list[tuple[int, str | None]] = []
    monkeypatch.setattr(
        recrawl_service,
        "release_crawl_lock",
        lambda client_id, token=None: released.append((client_id, token)),
    )

    cleared: list[int] = []
    monkeypatch.setattr(recrawl_service, "clear_cancellation", lambda client_id: cleared.append(client_id))

    async def _fake_fetch(urls, client_id):
        return [{"url": "https://a.test/page1", "content": "fresh content"}], []

    monkeypatch.setattr(recrawl_service, "_fetch_pages", _fake_fetch)

    # A real preemption: the interactive path set the cancel flag after this
    # recrawl began (clear_cancellation at start didn't wipe it because it was
    # set later), so the post-fetch check sees it.
    monkeypatch.setattr(recrawl_service, "is_cancellation_requested", lambda client_id: True)

    ingest_calls: list[tuple] = []
    monkeypatch.setattr(
        recrawl_service,
        "batch_web_ingestion",
        lambda *a, **kw: ingest_calls.append((a, kw)) or {"chunks": 0, "pages_charged": 0, "credits_deducted": 0},
    )

    result = asyncio.run(recrawl_service.recrawl_bot(bot.id))

    assert result == {"status": "preempted", "reason": "interactive_crawl"}
    assert ingest_calls == []  # yielded before ingest — no duplicate chunks
    assert cleared == [bot.client_id]  # cleared once, right after acquire
    # Lock released with the ownership token so the waiting interactive crawl acquires.
    assert released == [(bot.client_id, "recrawl:tok-preempt")]

    db.refresh(bot)
    # No summary persisted → schedule left due so the sweep retries after the
    # interactive crawl finishes.
    assert bot.next_recrawl_at == original_next


def test_no_preemption_flag_runs_normally(db, monkeypatch):
    """With no cancel pending after fetch, the recrawl ingests as usual."""
    _, bot, _ = _mk_recrawlable_bot(db, "rc-no-preempt")

    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(recrawl_service, "acquire_crawl_lock", lambda client_id, **kw: "recrawl:tok-run")
    monkeypatch.setattr(recrawl_service, "release_crawl_lock", lambda client_id, token=None: None)
    monkeypatch.setattr(recrawl_service, "clear_cancellation", lambda client_id: None)

    async def _fake_fetch(urls, client_id):
        return [{"url": "https://a.test/page1", "content": "fresh content"}], []

    monkeypatch.setattr(recrawl_service, "_fetch_pages", _fake_fetch)
    monkeypatch.setattr(recrawl_service, "is_cancellation_requested", lambda client_id: False)

    ingest_calls: list[tuple] = []
    monkeypatch.setattr(
        recrawl_service,
        "batch_web_ingestion",
        lambda *a, **kw: ingest_calls.append((a, kw)) or {"chunks": 3, "pages_charged": 1, "credits_deducted": 0},
    )

    result = asyncio.run(recrawl_service.recrawl_bot(bot.id))

    assert result["status"] != "preempted"
    assert result["status"] in {"success", "partial", "failed"}
    assert len(ingest_calls) == 1  # proceeded to ingest
