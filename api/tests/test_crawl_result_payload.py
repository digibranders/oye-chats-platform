"""The terminal crawl payload must describe what the chatbot actually learned.

A quota-aborted crawl keeps its ``done`` status (pages that landed before the
abort are real knowledge), but it used to report the FULL fetched page count
as the number of pages the chatbot had read. A Starter customer crawling a
400-page site whose ingestion aborts on the knowledge-character ceiling at page
25 was told "this chatbot read 400 pages" with 94% of the site missing, and the
payload carried nothing the UI could have used to say otherwise.
"""

from __future__ import annotations

import pytest

import app.services.crawl_orchestrator as orch
from app.ingestion.pipeline import ABORT_REASON_KNOWLEDGE_QUOTA


def _quiet(monkeypatch) -> list[dict]:
    published: list[dict] = []

    def record(client_id, **kw):
        published.append(kw)

    monkeypatch.setattr(orch, "set_crawl_progress", record)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda *a, **k: None)
    monkeypatch.setattr(orch, "_record_bot_crawl_state", lambda *a, **k: None)
    return published


@pytest.mark.asyncio
async def test_a_quota_aborted_crawl_reports_the_pages_it_really_ingested(monkeypatch):
    monkeypatch.setattr(orch, "CRAWL_STREAM_INGEST_ENABLED", False)
    published = _quiet(monkeypatch)
    urls = [f"https://acme.test/p{i}" for i in range(400)]

    async def fake_fetch_urls(u, **kw):
        return {
            "results": [{"url": x, "content": f"body {x}"} for x in u],
            "recommended_colors": [],
            "discovered_total": len(u),
            "queue_remaining": 0,
        }

    def aborting_ingest(cid, pages, **kw):
        return {
            "chunks": 50,
            "pages_changed": 25,
            "pages_charged": 25,
            "pages_failed": 3,
            "credits_deducted": 0,
            "aborted": True,
            "abort_reason": ABORT_REASON_KNOWLEDGE_QUOTA,
        }

    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)
    monkeypatch.setattr(orch, "batch_web_ingestion", aborting_ingest)

    result = await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=400,
        use_js=False,
        replace_source=None,
        cost_per_page=0,
        ordered_urls=urls,
    )

    # Partial success is still success. That part is deliberate and unchanged.
    assert published[-1]["status"] == "done"
    # But the shortfall is now visible instead of being reported as coverage.
    assert result["pages_processed"] == 400  # pages FETCHED
    assert result["pages_ingested"] == 25  # pages the chatbot can answer from
    assert result["pages_failed"] == 3
    assert result["aborted"] is True
    assert result["abort_reason"] == ABORT_REASON_KNOWLEDGE_QUOTA


@pytest.mark.asyncio
async def test_the_final_sweep_does_not_re_force_pages_a_wave_already_ingested(monkeypatch):
    """``force_reingest`` + streaming embedded and counted every page twice.

    The waves already bypassed dedup for the pages they saw, so the sweep must
    let the content hash skip them; otherwise every page is chunked and
    embedded a second time for nothing.
    """
    monkeypatch.setattr(orch, "CRAWL_STREAM_INGEST_ENABLED", True)
    _quiet(monkeypatch)
    urls = [f"https://acme.test/p{i}" for i in range(3)]
    forced: list[bool] = []

    async def streaming_fetch_urls(u, on_result=None, **kw):
        results = [{"url": x, "content": f"body {x}"} for x in u]
        for page in results:
            if on_result is not None:
                await on_result(page)
        return {
            "results": results,
            "recommended_colors": [],
            "discovered_total": len(u),
            "queue_remaining": 0,
        }

    def recording_ingest(cid, pages, **kw):
        forced.append(bool(kw.get("force_reingest")))
        return {
            "chunks": len(pages),
            "pages_changed": len(pages),
            "pages_charged": len(pages),
            "pages_failed": 0,
            "credits_deducted": 0,
            "aborted": False,
            "abort_reason": None,
        }

    monkeypatch.setattr(orch, "fetch_urls", streaming_fetch_urls)
    monkeypatch.setattr(orch, "batch_web_ingestion", recording_ingest)

    await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=3,
        use_js=False,
        replace_source="acme.test",
        cost_per_page=1,
        ordered_urls=urls,
        force_reingest=True,
        crawl_job_id="job-force",
    )

    assert forced, "ingestion never ran"
    assert forced[0] is True, "the streamed wave still does the forced re-ingest"
    assert forced[-1] is False, "the final sweep must let dedup skip what the waves ingested"


@pytest.mark.asyncio
async def test_a_crawl_with_no_streaming_keeps_the_full_forced_pass(monkeypatch):
    """The recursive-crawl path streams nothing, so the sweep is the only pass."""
    monkeypatch.setattr(orch, "CRAWL_STREAM_INGEST_ENABLED", True)
    _quiet(monkeypatch)
    forced: list[bool] = []

    async def non_streaming_fetch_urls(u, **kw):
        return {
            "results": [{"url": x, "content": f"body {x}"} for x in u],
            "recommended_colors": [],
            "discovered_total": len(u),
            "queue_remaining": 0,
        }

    def recording_ingest(cid, pages, **kw):
        forced.append(bool(kw.get("force_reingest")))
        return {
            "chunks": len(pages),
            "pages_changed": len(pages),
            "pages_charged": len(pages),
            "pages_failed": 0,
            "credits_deducted": 0,
            "aborted": False,
            "abort_reason": None,
        }

    monkeypatch.setattr(orch, "fetch_urls", non_streaming_fetch_urls)
    monkeypatch.setattr(orch, "batch_web_ingestion", recording_ingest)

    await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=2,
        use_js=False,
        replace_source=None,
        cost_per_page=1,
        ordered_urls=["https://acme.test/a", "https://acme.test/b"],
        force_reingest=True,
        crawl_job_id="job-force-2",
    )

    assert forced == [True]


@pytest.mark.asyncio
async def test_a_delta_recrawl_of_an_unchanged_site_still_reports_full_coverage(monkeypatch):
    """ "Pages the chatbot has" is not "pages this crawl re-embedded".

    A delta re-crawl of an unchanged site legitimately ingests nothing: the
    content hash skips every page while the bot keeps all of it. Reporting only
    freshly-written pages here would swap one lie for another.
    """
    monkeypatch.setattr(orch, "CRAWL_STREAM_INGEST_ENABLED", False)
    _quiet(monkeypatch)
    urls = ["https://acme.test/a", "https://acme.test/b"]

    async def fake_fetch_urls(u, **kw):
        return {
            "results": [{"url": x, "content": f"body {x}"} for x in u],
            "recommended_colors": [],
            "discovered_total": len(u),
            "queue_remaining": 0,
        }

    def all_unchanged(cid, pages, **kw):
        return {
            "chunks": 0,
            "pages_changed": 0,
            "pages_unchanged": len(pages),
            "pages_charged": 0,
            "pages_failed": 0,
            "credits_deducted": 0,
            "aborted": False,
            "abort_reason": None,
        }

    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)
    monkeypatch.setattr(orch, "batch_web_ingestion", all_unchanged)
    monkeypatch.setattr(orch, "count_documents_for_bot", lambda *a, **k: 10, raising=False)

    result = await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=2,
        use_js=False,
        replace_source=None,
        cost_per_page=0,
        ordered_urls=urls,
    )

    assert result["pages_ingested"] == 2
    assert result["pages_failed"] == 0
    assert result["aborted"] is False
