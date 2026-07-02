"""run_full_crawl must emit live progress (real page counts + an embedding
phase) during a spider crawl, not just a terminal status at the very end.
"""

import contextlib

import pytest

import app.services.crawl_orchestrator as orch


@contextlib.asynccontextmanager
async def _noop_heartbeat(client_id, **kwargs):
    # Replace the real 30s-ticking heartbeat so the test doesn't sleep.
    yield


@pytest.mark.asyncio
async def test_ordered_crawl_emits_live_progress(monkeypatch):
    progress_calls: list[dict] = []
    monkeypatch.setattr(orch, "crawl_heartbeat", _noop_heartbeat)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda cid: None)
    monkeypatch.setattr(orch, "set_crawl_progress", lambda cid, **kw: progress_calls.append(kw))
    monkeypatch.setattr(
        orch,
        "batch_web_ingestion",
        lambda *a, **k: {"chunks": 2, "pages_charged": 2, "credits_deducted": 10},
    )

    async def fake_fetch_urls(urls, *, use_js, client_id, on_page=None, on_result=None):
        # Simulate pages completing one by one, driving the progress callback.
        for u in urls:
            if on_page is not None:
                on_page(u, True)
        return {
            "results": [{"url": u, "content": f"c:{u}"} for u in urls],
            "recommended_colors": [],
            "discovered_total": len(urls),
            "queue_remaining": 0,
        }

    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)

    result = await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=None,
        use_js=False,
        replace_source=None,
        cost_per_page=5,
        ordered_urls=["https://acme.test/a", "https://acme.test/b"],
    )

    statuses = [c.get("status") for c in progress_calls]
    # Per-page "running" updates fired with growing page counts (unfreezes 0/N).
    running = [c for c in progress_calls if c.get("status") == "running"]
    assert any(c.get("pages_crawled", 0) >= 1 for c in running)
    assert max(c.get("pages_crawled", 0) for c in running) == 2
    # The embedding phase is surfaced before the terminal write.
    assert any("embedding" in (c.get("phase") or "").lower() for c in running)
    # Terminal success still written last.
    assert statuses[-1] == "done"
    assert result["pages_processed"] == 2


@pytest.mark.asyncio
async def test_crawl_failure_still_writes_terminal_failed(monkeypatch):
    progress_calls: list[dict] = []
    monkeypatch.setattr(orch, "crawl_heartbeat", _noop_heartbeat)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda cid: None)
    monkeypatch.setattr(orch, "set_crawl_progress", lambda cid, **kw: progress_calls.append(kw))

    async def boom_fetch(urls, *, use_js, client_id, on_page=None, on_result=None):
        raise orch.CrawlerError("spider + jina both down")

    monkeypatch.setattr(orch, "fetch_urls", boom_fetch)

    with pytest.raises(orch.CrawlerError):
        await orch.run_full_crawl(
            client_id=1,
            bot_id=None,
            url="https://acme.test",
            max_pages=None,
            use_js=False,
            replace_source=None,
            cost_per_page=5,
            ordered_urls=["https://acme.test/a"],
        )
    assert progress_calls[-1]["status"] == "failed"
