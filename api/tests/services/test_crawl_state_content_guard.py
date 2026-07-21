"""``_record_bot_crawl_state`` must never latch a fake "trained" state.

A crawl that fetches pages but extracts zero readable text (common on
JS-rendered sites) used to still stamp ``crawl_completed_at`` /
``indexed_chunk_count`` whenever the terminal status was ``"done"`` —
regardless of chunk count — so the frontend had no durable signal to tell
"trained" apart from "crawled nothing." These tests pin the defense-in-depth
guard: the durable "trained" marker is only set when ``chunk_count > 0``,
and a dedicated ``"no_content"`` status is recorded (status only, no
trained-marker fields) for the zero-content case.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest

from app.db.models import Bot, Client
from app.services import crawl_orchestrator

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _make_client(db, email: str) -> Client:
    client = Client(name="C", email=email, api_key=f"key-{email}", hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _make_bot(db, client_id: int, bot_key: str) -> Bot:
    bot = Bot(client_id=client_id, name="B", bot_key=bot_key)
    db.add(bot)
    db.flush()
    return bot


def test_zero_chunks_does_not_set_trained_marker(db, monkeypatch) -> None:
    monkeypatch.setattr(crawl_orchestrator, "get_session", lambda: _ctx(db))
    client = _make_client(db, "guard-zero@e.com")
    bot = _make_bot(db, client.id, "bot-guard-zero")
    db.commit()

    crawl_orchestrator._record_bot_crawl_state(bot.id, "done", 0)

    assert bot.last_crawl_status == "done"
    assert bot.crawl_completed_at is None
    assert bot.indexed_chunk_count == 0


def test_positive_chunks_sets_trained_marker(db, monkeypatch) -> None:
    monkeypatch.setattr(crawl_orchestrator, "get_session", lambda: _ctx(db))
    client = _make_client(db, "guard-positive@e.com")
    bot = _make_bot(db, client.id, "bot-guard-positive")
    db.commit()

    crawl_orchestrator._record_bot_crawl_state(bot.id, "done", 5)

    assert bot.last_crawl_status == "done"
    assert bot.crawl_completed_at is not None
    assert bot.indexed_chunk_count == 5


def test_no_content_status_records_status_only(db, monkeypatch) -> None:
    monkeypatch.setattr(crawl_orchestrator, "get_session", lambda: _ctx(db))
    client = _make_client(db, "guard-nocontent@e.com")
    bot = _make_bot(db, client.id, "bot-guard-nocontent")
    db.commit()

    crawl_orchestrator._record_bot_crawl_state(bot.id, "no_content", 0)

    assert bot.last_crawl_status == "no_content"
    assert bot.crawl_completed_at is None
