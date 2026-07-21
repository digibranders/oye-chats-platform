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
    monkeypatch.setattr(recrawl_service, "acquire_crawl_lock", lambda client_id: False)

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
    monkeypatch.setattr(recrawl_service, "acquire_crawl_lock", lambda client_id: True)

    released: list[int] = []
    monkeypatch.setattr(recrawl_service, "release_crawl_lock", lambda client_id: released.append(client_id))

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
    assert released == [bot.client_id]


def test_lock_released_on_ingest_failure(db, monkeypatch):
    _, bot, _ = _mk_recrawlable_bot(db, "rc-lock-fail")

    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(recrawl_service, "acquire_crawl_lock", lambda client_id: True)

    released: list[int] = []
    monkeypatch.setattr(recrawl_service, "release_crawl_lock", lambda client_id: released.append(client_id))

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
    assert released == [bot.client_id]
