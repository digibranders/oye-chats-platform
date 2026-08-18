"""Finding H (ingestion wiring): an ARQ retry of a crawl job must not re-charge
pages it already billed. batch_web_ingestion stamps a per-(job, url) idempotency
key on each page deduction, so re-running the same crawl_job_id (even in
force_reingest mode (which bypasses the content-dedup that would otherwise make a
re-run free)) charges each URL exactly once.
"""

import os
from contextlib import contextmanager

import pytest

from app.db.models import Client, CreditLedger
from app.ingestion import pipeline
from app.services import credit_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _seed_client(db, credits: int) -> Client:
    c = Client(name="Crawl", email="crawl-h@test.local", hashed_password="x", api_key="k-crawl-h")
    db.add(c)
    db.flush()
    db.add(CreditLedger(client_id=c.id, delta=credits, reason="plan_grant"))
    db.flush()
    db.commit()
    return c


def _patch_pipeline(monkeypatch, db):
    """Isolate the billing loop: real session + real credit_service, fake embed
    and no-op storage so we exercise only the deduction/idempotency path."""

    @contextmanager
    def _fake_session():
        # Hand batch_web_ingestion the test session; do NOT close it on exit so
        # the fixture can still truncate at teardown.
        yield db

    monkeypatch.setattr(pipeline, "get_session", _fake_session)
    monkeypatch.setattr(
        pipeline, "embed_chunks", lambda chunk_content_list, progress_cb=None: [[0.0] * 8 for _ in chunk_content_list]
    )
    monkeypatch.setattr(pipeline, "insert_documents", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "delete_chunks_for_url", lambda *a, **k: None)
    # Never dedup-skip on content (we're testing the force_reingest path anyway).
    monkeypatch.setattr(pipeline, "is_document_processed", lambda *a, **k: False)


def test_retry_same_job_does_not_recharge(db, monkeypatch):
    client = _seed_client(db, credits=100)
    _patch_pipeline(monkeypatch, db)
    pages = [{"url": "https://x.test/a", "content": "Alpha page body."}]

    kw = dict(cost_per_page=5, deduct_reason="url_scan", force_reingest=True, crawl_job_id="job-123")
    r1 = pipeline.batch_web_ingestion(client.id, pages, bot_id=None, **kw)
    r2 = pipeline.batch_web_ingestion(client.id, pages, bot_id=None, **kw)  # ARQ retry

    assert r1["pages_charged"] == 1
    # Balance dropped by exactly one page's cost across BOTH runs.
    assert credit_service.get_balance(db, client.id) == 95
    # Exactly one keyed deduction row exists for this (job, url).
    keyed = db.query(CreditLedger).filter(CreditLedger.idempotency_key.isnot(None)).all()
    assert len(keyed) == 1
    assert r2["chunks"] >= 1  # retry still (re)ingests chunks; it just doesn't re-charge


def test_distinct_job_ids_recharge(db, monkeypatch):
    """A NEW user-initiated crawl (fresh job id) is a new billable action."""
    client = _seed_client(db, credits=100)
    _patch_pipeline(monkeypatch, db)
    pages = [{"url": "https://x.test/a", "content": "Alpha page body."}]

    pipeline.batch_web_ingestion(
        client.id, pages, bot_id=None, cost_per_page=5, force_reingest=True, crawl_job_id="job-1"
    )
    pipeline.batch_web_ingestion(
        client.id, pages, bot_id=None, cost_per_page=5, force_reingest=True, crawl_job_id="job-2"
    )
    assert credit_service.get_balance(db, client.id) == 90  # charged twice


def test_no_job_id_keeps_legacy_per_page_charging(db, monkeypatch):
    client = _seed_client(db, credits=100)
    _patch_pipeline(monkeypatch, db)
    pages = [{"url": "https://x.test/a", "content": "Alpha page body."}]

    pipeline.batch_web_ingestion(client.id, pages, bot_id=None, cost_per_page=5, force_reingest=True)
    pipeline.batch_web_ingestion(client.id, pages, bot_id=None, cost_per_page=5, force_reingest=True)
    # No idempotency key → both runs charge (unchanged legacy behaviour).
    assert credit_service.get_balance(db, client.id) == 90
