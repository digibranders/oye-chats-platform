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
async def test_partial_crawl_skips_orphan_sweep(monkeypatch):
    """A partial (ordered_urls) re-crawl with replace_source must NOT run the
    orphan sweep — otherwise it deletes pages outside the fetched slice."""
    from contextlib import contextmanager
    from unittest.mock import MagicMock

    del_session = MagicMock()

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

    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)
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
    # The sweep issues del_session.query(Document)...delete(); assert it never ran.
    del_session.query.assert_not_called()
