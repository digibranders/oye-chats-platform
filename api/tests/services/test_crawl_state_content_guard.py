"""The durable "trained" state must describe what a bot actually knows.

``Bot.indexed_chunk_count`` drives every "is my AI trained?" surface in the
dashboard, so it has to answer that question — not describe whichever crawl
happened to run last. Two failure directions matter:

* **Never latch a fake "trained" state.** A crawl that fetches pages but
  extracts zero readable text (common on JS-rendered sites) must not leave the
  bot claiming knowledge it doesn't have, and ``no_content`` must be recorded
  as a status without any trained marker.
* **Never deny a real one.** Deriving the marker from a single crawl's delta
  under-reported in three real cases: a document upload runs no crawl at all; a
  delta recrawl of an unchanged site ingests zero new chunks while the bot keeps
  all its prior content; and a failed recrawl doesn't destroy what was already
  ingested. Each left a fully-trained bot reading "Nothing learned yet" forever.

``_record_bot_crawl_state`` therefore recomputes from the documents table via
``repository.sync_bot_knowledge_state`` rather than trusting a job's output, and
``last_crawl_status`` is kept strictly as a record of the last ATTEMPT.

Separately, ``_terminal_status`` (extracted from ``run_full_crawl``'s completion
block) must distinguish "zero *new* chunks this crawl" (healthy) from "zero
chunks *period*" (genuinely ``no_content``). ``count_documents_for_bot`` is the
ground-truth source for the bot's existing content; these tests pin its exact
semantics too.
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


def test_bot_with_no_content_does_not_get_trained_marker(db, monkeypatch) -> None:
    monkeypatch.setattr(crawl_orchestrator, "get_session", lambda: _ctx(db))
    client = _make_client(db, "guard-zero@e.com")
    bot = _make_bot(db, client.id, "bot-guard-zero")
    db.commit()

    crawl_orchestrator._record_bot_crawl_state(bot.id, "done")

    assert bot.last_crawl_status == "done"
    assert bot.crawl_completed_at is None
    assert bot.indexed_chunk_count == 0


def test_ingested_content_sets_trained_marker(db, monkeypatch) -> None:
    monkeypatch.setattr(crawl_orchestrator, "get_session", lambda: _ctx(db))
    client = _make_client(db, "guard-positive@e.com")
    bot = _make_bot(db, client.id, "bot-guard-positive")
    for i in range(5):
        _make_doc(db, bot.id, client.id, f"https://a.test/p{i}")
    db.commit()

    crawl_orchestrator._record_bot_crawl_state(bot.id, "done")

    assert bot.last_crawl_status == "done"
    assert bot.crawl_completed_at is not None
    assert bot.indexed_chunk_count == 5


def test_no_content_status_records_status_only(db, monkeypatch) -> None:
    monkeypatch.setattr(crawl_orchestrator, "get_session", lambda: _ctx(db))
    client = _make_client(db, "guard-nocontent@e.com")
    bot = _make_bot(db, client.id, "bot-guard-nocontent")
    db.commit()

    crawl_orchestrator._record_bot_crawl_state(bot.id, "no_content")

    assert bot.last_crawl_status == "no_content"
    assert bot.crawl_completed_at is None
    assert bot.indexed_chunk_count == 0


def test_delta_recrawl_adding_nothing_keeps_bot_trained(db, monkeypatch) -> None:
    """The reported bug: a recrawl that ingests zero NEW chunks must not un-train.

    SHA-256 dedup skips every page of an unchanged site, so the crawl's own
    output is zero — but the bot still holds all its prior content. Gating the
    marker on that output left a trained agent reading "Nothing learned yet".
    """
    monkeypatch.setattr(crawl_orchestrator, "get_session", lambda: _ctx(db))
    client = _make_client(db, "guard-delta@e.com")
    bot = _make_bot(db, client.id, "bot-guard-delta")
    _make_doc(db, bot.id, client.id, "https://a.test/only-page")
    db.commit()

    crawl_orchestrator._record_bot_crawl_state(bot.id, "done")

    assert bot.indexed_chunk_count == 1
    assert bot.crawl_completed_at is not None


def test_failed_recrawl_preserves_existing_trained_state(db, monkeypatch) -> None:
    """A failed ATTEMPT doesn't destroy already-ingested content."""
    monkeypatch.setattr(crawl_orchestrator, "get_session", lambda: _ctx(db))
    client = _make_client(db, "guard-failed@e.com")
    bot = _make_bot(db, client.id, "bot-guard-failed")
    _make_doc(db, bot.id, client.id, "https://a.test/kept")
    db.commit()

    crawl_orchestrator._record_bot_crawl_state(bot.id, "failed")

    assert bot.last_crawl_status == "failed"  # the attempt is still reported
    assert bot.indexed_chunk_count == 1  # ...but the knowledge survives it
    assert bot.crawl_completed_at is not None


def test_removing_all_content_clears_trained_marker(db, monkeypatch) -> None:
    """The mirror case: a stale counter must not outlive the content."""
    monkeypatch.setattr(crawl_orchestrator, "get_session", lambda: _ctx(db))
    client = _make_client(db, "guard-emptied@e.com")
    bot = _make_bot(db, client.id, "bot-guard-emptied")
    doc = _make_doc(db, bot.id, client.id, "https://a.test/doomed")
    db.commit()
    crawl_orchestrator._record_bot_crawl_state(bot.id, "done")
    assert bot.indexed_chunk_count == 1

    db.delete(doc)
    db.commit()
    crawl_orchestrator._record_bot_crawl_state(bot.id, "done")

    assert bot.indexed_chunk_count == 0
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
