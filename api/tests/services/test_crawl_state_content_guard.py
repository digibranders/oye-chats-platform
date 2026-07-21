"""``_record_bot_crawl_state`` must never latch a fake "trained" state, and
the ``no_content`` terminal status must reflect the bot's real knowledge —
not merely whether this particular crawl added new chunks.

A crawl that fetches pages but extracts zero readable text (common on
JS-rendered sites) used to still stamp ``crawl_completed_at`` /
``indexed_chunk_count`` whenever the terminal status was ``"done"`` —
regardless of chunk count — so the frontend had no durable signal to tell
"trained" apart from "crawled nothing." These tests pin the defense-in-depth
guard: the durable "trained" marker is only set when ``chunk_count > 0``,
and a dedicated ``"no_content"`` status is recorded (status only, no
trained-marker fields) for the zero-content case.

Separately, ``_terminal_status`` (extracted from ``run_full_crawl``'s
completion block) must distinguish "zero *new* chunks this crawl" (healthy —
e.g. a delta recrawl of an unchanged site where SHA-256 dedup skipped every
page but the bot still holds all its prior content) from "zero chunks
*period*" (genuinely ``no_content`` — nothing for the bot to answer from).
``count_documents_for_bot`` is the ground-truth source for the bot's existing
content count; these tests pin its exact semantics too.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest

from app.db.models import Bot, Client, Document
from app.db.repository import count_documents_for_bot
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


def _make_doc(db, bot_id: int, client_id: int, name: str) -> Document:
    doc = Document(
        client_id=client_id,
        bot_id=bot_id,
        document_name=name,
        source="crawl",
        file_hash=f"h-{name}",
        content="x",
        embedding=[0.0] * 768,
    )
    db.add(doc)
    db.flush()
    return doc


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


def test_count_documents_for_bot_counts_existing_chunks(db) -> None:
    """Ground-truth pin: a bot with indexed content counts > 0, an empty bot counts 0."""
    client = _make_client(db, "guard-count-nonzero@e.com")
    bot = _make_bot(db, client.id, "bot-guard-count-nonzero")
    empty_bot = _make_bot(db, client.id, "bot-guard-count-empty")
    _make_doc(db, bot.id, client.id, "https://a.test/page1")
    _make_doc(db, bot.id, client.id, "https://a.test/page2")
    db.commit()

    assert count_documents_for_bot(db, bot_id=bot.id) == 2
    assert count_documents_for_bot(db, bot_id=empty_bot.id) == 0


class TestTerminalStatus:
    """Exhaustive truth table for ``_terminal_status(total_chunks, existing_count)``.

    ``no_content`` is reserved for the case where the bot has NO usable
    knowledge at all — both this crawl's new chunks and its pre-existing
    indexed content are zero. Any other combination is a success.
    """

    def test_zero_new_zero_existing_is_no_content(self) -> None:
        assert crawl_orchestrator._terminal_status(0, 0) == "no_content"

    def test_zero_new_but_existing_content_is_done(self) -> None:
        # Delta recrawl of an unchanged site: dedup skipped every page, but
        # the bot still holds its prior content. This is a success.
        assert crawl_orchestrator._terminal_status(0, 5) == "done"

    def test_new_chunks_with_no_prior_existing_is_done(self) -> None:
        assert crawl_orchestrator._terminal_status(3, 0) == "done"

    def test_new_chunks_and_existing_content_is_done(self) -> None:
        assert crawl_orchestrator._terminal_status(3, 5) == "done"
