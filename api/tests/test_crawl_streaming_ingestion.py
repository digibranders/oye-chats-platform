"""Streaming crawl ingestion: pages are embedded+ingested in waves while the
scrape is still running, with a dedup-protected final sweep. Covers wave
batching, the sequential fallback, billing aborts, the non-streaming provider
path (recursive crawl), and cancel semantics.
"""

import asyncio
import contextlib

import pytest

import app.services.crawl_orchestrator as orch
from app.services.crawler_service import CrawlCancelled


@contextlib.asynccontextmanager
async def _noop_heartbeat(client_id, **kwargs):
    yield


def _page(i: int) -> dict:
    return {"url": f"https://acme.test/p{i}", "content": f"content {i}"}


@pytest.fixture
def harness(monkeypatch):
    """Wire run_full_crawl with a fake provider + fake ingestion.

    The fake ingestion records every call's page list and returns one chunk per
    page; pages seen in an earlier call are "hash-skipped" (0 chunks, 0 charge)
    exactly like the real content-hash dedup, so the final sweep behaves as in
    production.
    """
    monkeypatch.setattr(orch, "crawl_heartbeat", _noop_heartbeat)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda cid: None)
    progress: list[dict] = []
    monkeypatch.setattr(orch, "set_crawl_progress", lambda cid, **kw: progress.append(kw))

    state = {"ingest_calls": [], "ingested_urls": set(), "abort_on_call": None, "progress": progress}

    def fake_ingest(client_id, pages, **kwargs):
        call_no = len(state["ingest_calls"]) + 1
        fresh = [p for p in pages if p["url"] not in state["ingested_urls"]]
        state["ingested_urls"].update(p["url"] for p in fresh)
        state["ingest_calls"].append([p["url"] for p in pages])
        cb = kwargs.get("embed_progress_cb")
        if cb is not None and fresh:
            cb(len(fresh), len(fresh))
        aborted = state["abort_on_call"] == call_no
        return {
            "chunks": len(fresh),
            "pages_charged": len(fresh),
            "credits_deducted": 5 * len(fresh),
            "aborted": aborted,
        }

    monkeypatch.setattr(orch, "batch_web_ingestion", fake_ingest)
    return state


async def _run(ordered_urls: list[str] | None = None, **kwargs):
    return await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=None,
        use_js=False,
        replace_source=None,
        cost_per_page=5,
        ordered_urls=ordered_urls,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_pages_are_ingested_in_waves_while_crawl_runs(monkeypatch, harness):
    monkeypatch.setattr(orch, "CRAWL_STREAM_INGEST_ENABLED", True)
    monkeypatch.setattr(orch, "CRAWL_INGEST_WAVE_PAGES", 2)
    pages = [_page(i) for i in range(5)]

    async def fake_fetch_urls(urls, *, on_page=None, on_result=None, **kw):
        for p in pages:
            if on_page:
                on_page(p["url"], True)
            if on_result:
                on_result(p)
            await asyncio.sleep(0)  # yield so the consumer can interleave
        return {"results": pages, "recommended_colors": [], "discovered_total": 5, "queue_remaining": 0}

    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)
    result = await _run(ordered_urls=[p["url"] for p in pages])

    # Waves of ≤2 pages plus the final full-list sweep at the end.
    assert harness["ingest_calls"][-1] == [p["url"] for p in pages]  # sweep sees everything
    wave_calls = harness["ingest_calls"][:-1]
    assert wave_calls, "expected at least one streamed wave before the sweep"
    assert all(len(w) <= 2 for w in wave_calls)
    # Every page ingested exactly once (dedup absorbs the sweep overlap).
    assert result["chunks_processed"] == 5
    assert result["credits_deducted"] == 25
    assert result["pages_charged"] == 5


@pytest.mark.asyncio
async def test_streaming_disabled_is_single_batch(monkeypatch, harness):
    monkeypatch.setattr(orch, "CRAWL_STREAM_INGEST_ENABLED", False)
    pages = [_page(i) for i in range(3)]

    async def fake_fetch_urls(urls, *, on_page=None, on_result=None, **kw):
        assert on_result is None  # no streaming callback when the flag is off
        return {"results": pages, "recommended_colors": [], "discovered_total": 3, "queue_remaining": 0}

    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)
    result = await _run(ordered_urls=[p["url"] for p in pages])

    assert harness["ingest_calls"] == [[p["url"] for p in pages]]  # exactly one batch
    assert result["chunks_processed"] == 3


@pytest.mark.asyncio
async def test_billing_abort_stops_waves_and_skips_sweep(monkeypatch, harness):
    monkeypatch.setattr(orch, "CRAWL_STREAM_INGEST_ENABLED", True)
    monkeypatch.setattr(orch, "CRAWL_INGEST_WAVE_PAGES", 2)
    harness["abort_on_call"] = 1  # first wave runs out of credits
    pages = [_page(i) for i in range(6)]

    async def fake_fetch_urls(urls, *, on_page=None, on_result=None, **kw):
        for p in pages:
            if on_result:
                on_result(p)
            await asyncio.sleep(0)
        return {"results": pages, "recommended_colors": [], "discovered_total": 6, "queue_remaining": 0}

    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)
    result = await _run(ordered_urls=[p["url"] for p in pages])

    # Only the aborted wave ran — no further waves, no final sweep.
    assert len(harness["ingest_calls"]) == 1
    assert result["chunks_processed"] == 2  # what the aborted wave managed


@pytest.mark.asyncio
async def test_non_streaming_provider_falls_back_to_sweep(monkeypatch, harness):
    """The recursive-crawl path never fires on_result — everything must still
    be ingested exactly once via the final sweep."""
    monkeypatch.setattr(orch, "CRAWL_STREAM_INGEST_ENABLED", True)
    pages = [_page(i) for i in range(3)]

    async def fake_crawl_website(url, *, on_page=None, on_result=None, **kw):
        # Simulates the single blocking Spider /crawl call: no streaming.
        return {"results": pages, "recommended_colors": [], "discovered_total": 3, "queue_remaining": 0}

    monkeypatch.setattr(orch, "crawl_website", fake_crawl_website)
    result = await _run(ordered_urls=None)

    assert harness["ingest_calls"] == [[p["url"] for p in pages]]  # sweep only
    assert result["chunks_processed"] == 3


@pytest.mark.asyncio
async def test_cancel_keeps_ingested_waves_and_discards_buffer(monkeypatch, harness):
    monkeypatch.setattr(orch, "CRAWL_STREAM_INGEST_ENABLED", True)
    monkeypatch.setattr(orch, "CRAWL_INGEST_WAVE_PAGES", 2)
    pages = [_page(i) for i in range(5)]

    async def fake_fetch_urls(urls, *, on_page=None, on_result=None, **kw):
        # Two pages land (one full wave), a third sits in the buffer, then the
        # user cancels.
        for p in pages[:3]:
            if on_result:
                on_result(p)
            await asyncio.sleep(0)
        await asyncio.sleep(0)  # let the wave start
        exc = CrawlCancelled("cancelled")
        exc.partial_result = {"results": pages[:3]}
        raise exc

    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)
    result = await _run(ordered_urls=[p["url"] for p in pages])

    assert result["message"] == "Crawl cancelled by user"
    # The completed wave's work is kept and reported; the buffered page 3 was
    # discarded, not embedded.
    assert result["chunks_processed"] == 2
    assert result["credits_deducted"] == 10
    assert len(harness["ingest_calls"]) == 1
    # Terminal status is cancelled.
    assert harness["progress"][-1]["status"] == "cancelled"
