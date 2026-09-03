"""Crawl ingestion must account for every page it touched, and only once.

Three defects, all of which let a crawl report a bigger number than it
delivered:

* a page whose insert transaction failed was counted nowhere, so a run where
  40 of 200 pages hit a DB error looked identical to a clean run;
* the final sweep re-offering a page a streamed wave had already billed
  counted the idempotent no-op as a fresh charge, doubling the summary's
  pages-charged and credits figures in ``force_reingest`` mode;
* the dedup hash normalises dates, and the lookup matched that hash across the
  WHOLE bot, so two event pages differing only by date collided and the second
  one was silently never ingested.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest

from app.db.models import Bot, Client, CreditLedger, Document
from app.ingestion import pipeline

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _seed(db, credits: int = 500) -> tuple[Client, Bot]:
    client = Client(name="Acme", email="acct@test.local", hashed_password="x", api_key="k-acct")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="Acme bot", bot_key="bot-acct")
    db.add(bot)
    db.add(CreditLedger(client_id=client.id, delta=credits, reason="plan_grant"))
    db.flush()
    db.commit()
    return client, bot


def _use_test_session(monkeypatch, db) -> None:
    @contextmanager
    def _fake_session():
        yield db

    monkeypatch.setattr(pipeline, "get_session", _fake_session)
    monkeypatch.setattr(
        pipeline,
        "embed_chunks",
        lambda chunk_content_list, progress_cb=None: [[0.0] * 768 for _ in chunk_content_list],
    )


def test_a_failed_page_insert_is_counted(db, monkeypatch):
    """A page whose insert blew up must show up as ``pages_failed``.

    Before this it contributed nothing anywhere: zero chunks, no counter, and
    indistinguishable from a dedup skip, so the crawl summary still claimed to
    have read it.
    """
    client, bot = _seed(db)
    _use_test_session(monkeypatch, db)

    calls = {"n": 0}
    real_insert = pipeline.insert_documents

    def flaky_insert(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated DB error")
        return real_insert(*args, **kwargs)

    monkeypatch.setattr(pipeline, "insert_documents", flaky_insert)

    result = pipeline.batch_web_ingestion(
        client.id,
        [
            {"url": "https://acme.test/broken", "content": "# Broken\nSome real body text here."},
            {"url": "https://acme.test/fine", "content": "# Fine\nSome other body text here."},
        ],
        bot_id=bot.id,
    )

    assert result["pages_failed"] == 1
    assert result["pages_changed"] == 1


def test_a_no_op_idempotent_charge_is_not_counted_again(db, monkeypatch):
    """``force_reingest`` + the final sweep must not double the billing summary.

    ``force_reingest`` bypasses the content dedup, so with streaming on the
    post-crawl sweep re-offers every page the waves already ingested. The
    per-(job, url) idempotency key stops the ledger being charged twice, but
    ``pages_charged`` / ``credits_deducted`` were incremented regardless of
    whether the deduction actually moved anything, so the customer's summary
    reported twice the pages and twice the credits actually spent.
    """
    client, bot = _seed(db)
    _use_test_session(monkeypatch, db)
    pages = [{"url": "https://acme.test/a", "content": "# A\nBody copy for page A."}]
    kw = {"cost_per_page": 5, "force_reingest": True, "crawl_job_id": "job-sweep"}

    wave = pipeline.batch_web_ingestion(client.id, pages, bot_id=bot.id, **kw)
    sweep = pipeline.batch_web_ingestion(client.id, pages, bot_id=bot.id, **kw)

    assert wave["pages_charged"] == 1
    assert wave["credits_deducted"] == 5
    # The sweep re-ingested the page but the ledger deduction was a no-op, so
    # neither number may move.
    assert sweep["pages_charged"] == 0
    assert sweep["credits_deducted"] == 0


def test_two_pages_differing_only_by_date_are_both_ingested(db, monkeypatch):
    """Date-templated pages must not collide on the dedup hash.

    ``_normalize_for_dedup_hash`` replaces every date with ``<DATE>`` before
    hashing, and the lookup matched that hash across the whole bot rather than
    per URL. Two webinar pages differing only by their date hashed identically,
    so only the first was ever ingested — silently, with the crawl still
    reporting success.
    """
    client, bot = _seed(db)
    _use_test_session(monkeypatch, db)

    spring = [
        {
            "url": "https://acme.test/webinars/spring",
            "content": "# Quarterly Webinar\nJoin us on 2026-03-14 for the quarterly product webinar.",
        }
    ]
    summer = [
        {
            "url": "https://acme.test/webinars/summer",
            "content": "# Quarterly Webinar\nJoin us on 2026-06-20 for the quarterly product webinar.",
        }
    ]
    # The two pages hash identically once dates are normalised away. They must
    # arrive in separate calls (separate streaming waves, or a later crawl):
    # within one call nothing is stored yet, so the collision cannot show.
    assert pipeline.calculate_hash(
        pipeline._normalize_for_dedup_hash(pipeline.clean_text(spring[0]["content"]))
    ) == pipeline.calculate_hash(pipeline._normalize_for_dedup_hash(pipeline.clean_text(summer[0]["content"])))

    pipeline.batch_web_ingestion(client.id, spring, bot_id=bot.id)
    result = pipeline.batch_web_ingestion(client.id, summer, bot_id=bot.id)

    stored = {row[0] for row in db.query(Document.document_name).filter(Document.bot_id == bot.id).distinct().all()}
    assert stored == {"https://acme.test/webinars/spring", "https://acme.test/webinars/summer"}
    assert result["pages_changed"] == 1


def test_the_same_url_unchanged_is_still_free(db, monkeypatch):
    """The billing optimisation the per-URL scope must preserve."""
    client, bot = _seed(db)
    _use_test_session(monkeypatch, db)
    pages = [{"url": "https://acme.test/pricing", "content": "# Pricing\nStarter is 29 dollars a month."}]

    first = pipeline.batch_web_ingestion(client.id, pages, bot_id=bot.id, cost_per_page=5)
    second = pipeline.batch_web_ingestion(client.id, pages, bot_id=bot.id, cost_per_page=5)

    assert first["pages_charged"] == 1
    assert second["chunks"] == 0
    assert second["pages_charged"] == 0


def test_pages_covered_by_the_free_allowance_are_reported(db, monkeypatch):
    """``pages_free`` lets a caller that ingests in waves carry the remaining
    allowance forward; without it every wave restarts the allowance."""
    client, bot = _seed(db)
    _use_test_session(monkeypatch, db)
    pages = [
        {"url": "https://acme.test/a", "content": "# A\nAlpha page with enough words to chunk."},
        {"url": "https://acme.test/b", "content": "# B\nBravo page with enough words to chunk."},
        {"url": "https://acme.test/c", "content": "# C\nCharlie page with enough words to chunk."},
    ]

    result = pipeline.batch_web_ingestion(client.id, pages, bot_id=bot.id, cost_per_page=5, free_pages=2)

    assert result["pages_free"] == 2
    assert result["pages_charged"] == 1
    assert result["credits_deducted"] == 5
