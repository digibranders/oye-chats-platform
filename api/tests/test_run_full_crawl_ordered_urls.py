import pytest

import app.services.crawl_orchestrator as orch


@pytest.mark.asyncio
async def test_ordered_urls_uses_fetch_urls_not_recursive_crawl(monkeypatch):
    """When ordered_urls is provided, run_full_crawl must fetch exactly those
    URLs (via provider.fetch_urls) and NOT run the recursive crawl_website."""
    seen = {}

    async def fake_provider_crawl(url, **kw):
        seen["url"] = url
        return {
            "results": [{"url": url, "content": "hello world"}],
            "recommended_colors": [],
            "discovered_total": 1,
            "queue_remaining": 0,
        }

    async def fake_fetch_urls(urls, **kw):
        seen["fetched"] = urls
        return {
            "results": [{"url": u, "content": f"c:{u}"} for u in urls],
            "recommended_colors": [],
            "discovered_total": len(urls),
            "queue_remaining": 0,
        }

    def fake_ingest(client_id, pages, **kw):
        seen["pages"] = pages
        return {"chunks": len(pages), "pages_charged": len(pages), "credits_deducted": 5 * len(pages)}

    monkeypatch.setattr(orch, "crawl_website", fake_provider_crawl)
    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)
    monkeypatch.setattr(orch, "batch_web_ingestion", fake_ingest)
    monkeypatch.setattr(orch, "set_crawl_progress", lambda *a, **k: None)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda *a, **k: None)

    result = await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=2,
        use_js=False,
        replace_source=None,
        cost_per_page=5,
        ordered_urls=["https://acme.test/a", "https://acme.test/b"],
    )
    assert seen["fetched"] == ["https://acme.test/a", "https://acme.test/b"]
    assert "url" not in seen  # recursive crawl skipped
    assert seen["pages"] == [
        {"url": "https://acme.test/a", "content": "c:https://acme.test/a"},
        {"url": "https://acme.test/b", "content": "c:https://acme.test/b"},
    ]
    assert result["chunks_processed"] == 2
    assert result["pages_processed"] == 2


@pytest.mark.asyncio
async def test_ordered_recrawl_still_runs_the_orphan_sweep(monkeypatch):
    """An ordered re-crawl MUST run the orphan sweep, gated on liveness.

    This replaces an assertion that ``ordered_urls`` skips the sweep entirely.
    That assertion was wrong about the product: ``replace_source`` is only ever
    set by the dashboard's re-crawl, and that path sends the COMPLETE page list
    it diffed (``orderedUrlsForRecrawl`` returns the whole new+unchanged set or
    ``null``). The user-picked subset path is a FIRST crawl and carries no
    ``replace_source`` at all. So the guard never protected a partial crawl; it
    only made the sweep unreachable from the one UI that starts one, and pages
    deleted from a customer's site kept their chunks forever. The real
    protection against over-deleting is ``check_urls_alive``, which is still
    required to confirm a 404/410 before anything is removed.
    """
    from contextlib import contextmanager
    from unittest.mock import MagicMock

    import app.services.url_discovery as url_discovery

    del_session = MagicMock()
    q = del_session.query.return_value
    q.filter.return_value = q
    q.distinct.return_value = q
    q.all.return_value = [("https://acme.test/retired",)]

    @contextmanager
    def fake_session():
        yield del_session

    async def fake_fetch_urls(urls, **kw):
        return {
            "results": [{"url": u, "content": "c"} for u in urls],
            "recommended_colors": [],
            "discovered_total": len(urls),
            "queue_remaining": 0,
        }

    checked = {}

    async def fake_alive(urls, **kw):
        checked["urls"] = list(urls)
        return dict.fromkeys(urls, False)  # confirmed gone

    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)
    monkeypatch.setattr(url_discovery, "check_urls_alive", fake_alive)
    monkeypatch.setattr(
        orch,
        "batch_web_ingestion",
        lambda cid, pages, **kw: {
            "chunks": len(pages),
            "pages_charged": len(pages),
            "credits_deducted": 5 * len(pages),
        },
    )
    monkeypatch.setattr(orch, "get_session", fake_session)
    monkeypatch.setattr(orch, "set_crawl_progress", lambda *a, **k: None)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda *a, **k: None)

    await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=1,
        use_js=False,
        replace_source="acme.test",
        cost_per_page=5,
        ordered_urls=["https://acme.test/a"],
    )
    assert checked["urls"] == ["https://acme.test/retired"]
    q.delete.assert_called_once()
