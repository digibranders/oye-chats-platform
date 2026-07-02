import pytest

from app.services import crawl_provider
from app.services.crawler_service import CrawlerError


@pytest.mark.asyncio
async def test_fetch_urls_uses_spider(monkeypatch):
    async def fake_spider(urls, **kw):
        return {
            "results": [{"url": urls[0], "content": "s"}],
            "recommended_colors": [],
            "discovered_total": len(urls),
            "queue_remaining": 0,
        }

    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", fake_spider)
    data = await crawl_provider.fetch_urls(["https://a.test/x"], use_js=False, client_id=1)
    assert data["results"][0]["content"] == "s"


@pytest.mark.asyncio
async def test_fetch_urls_falls_back_to_jina(monkeypatch):
    """On Spider failure, replay the exact list via Jina Reader (order preserved)."""
    monkeypatch.setattr(crawl_provider, "JINA_FALLBACK_ENABLED", True)
    seen = {}

    async def boom(urls, **kw):
        raise CrawlerError("down")

    async def fake_jina(urls, **kw):
        seen["urls"] = urls
        return {
            "results": [{"url": u, "content": "md"} for u in urls],
            "recommended_colors": [],
            "discovered_total": len(urls),
            "queue_remaining": 0,
        }

    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", boom)
    monkeypatch.setattr(crawl_provider, "_jina_fetch_urls", fake_jina)
    urls = ["https://a.test/x", "https://a.test/y"]
    data = await crawl_provider.fetch_urls(urls, use_js=False, client_id=1)
    assert [p["url"] for p in data["results"]] == urls  # order preserved
    assert seen["urls"] == urls


@pytest.mark.asyncio
async def test_fetch_urls_reraises_without_fallback(monkeypatch):
    monkeypatch.setattr(crawl_provider, "JINA_FALLBACK_ENABLED", False)

    async def boom(urls, **kw):
        raise CrawlerError("down")

    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", boom)
    with pytest.raises(CrawlerError):
        await crawl_provider.fetch_urls(["https://a.test/x"], use_js=False, client_id=1)


# ── Runtime-configurable provider order ──────────────────────────────────────


def _ok(results_from, urls):
    return {
        "results": [{"url": u, "content": f"{results_from}:{u}"} for u in urls],
        "recommended_colors": [],
        "discovered_total": len(urls),
        "queue_remaining": 0,
    }


def _empty_data(urls):
    return {"results": [], "recommended_colors": [], "discovered_total": len(urls), "queue_remaining": 0}


@pytest.mark.asyncio
async def test_jina_primary_runs_jina_first(monkeypatch):
    """crawl.provider_primary=jina flips the order: Jina first, Spider untouched
    on success."""
    monkeypatch.setattr(crawl_provider, "_provider_order", lambda: ("jina", "spider"))
    called = {"spider": False}

    async def fake_jina(urls, **kw):
        return _ok("jina", urls)

    async def fake_spider(urls, **kw):  # pragma: no cover - must NOT run
        called["spider"] = True
        return _ok("spider", urls)

    monkeypatch.setattr(crawl_provider, "_jina_fetch_urls", fake_jina)
    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", fake_spider)

    data = await crawl_provider.fetch_urls(["https://a.test/x"], use_js=False, client_id=1)
    assert data["results"][0]["content"] == "jina:https://a.test/x"
    assert called["spider"] is False


@pytest.mark.asyncio
async def test_jina_primary_empty_results_fall_back_to_spider(monkeypatch):
    """Jina fails soft (drops pages, never raises) — zero results for a
    non-empty list must trigger the Spider fallback."""
    monkeypatch.setattr(crawl_provider, "_provider_order", lambda: ("jina", "spider"))

    async def fake_jina(urls, **kw):
        return _empty_data(urls)

    async def fake_spider(urls, **kw):
        return _ok("spider", urls)

    monkeypatch.setattr(crawl_provider, "_jina_fetch_urls", fake_jina)
    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", fake_spider)

    data = await crawl_provider.fetch_urls(["https://a.test/x"], use_js=False, client_id=1)
    assert data["results"][0]["content"] == "spider:https://a.test/x"


@pytest.mark.asyncio
async def test_spider_primary_empty_results_fall_back_to_jina(monkeypatch):
    monkeypatch.setattr(crawl_provider, "JINA_FALLBACK_ENABLED", True)
    monkeypatch.setattr(crawl_provider, "_provider_order", lambda: ("spider", "jina"))

    async def fake_spider(urls, **kw):
        return _empty_data(urls)

    async def fake_jina(urls, **kw):
        return _ok("jina", urls)

    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", fake_spider)
    monkeypatch.setattr(crawl_provider, "_jina_fetch_urls", fake_jina)

    data = await crawl_provider.fetch_urls(["https://a.test/x"], use_js=False, client_id=1)
    assert data["results"][0]["content"] == "jina:https://a.test/x"


@pytest.mark.asyncio
async def test_jina_fallback_disabled_only_gates_jina_as_fallback(monkeypatch):
    """JINA_FALLBACK_ENABLED=false must not block the spider fallback when the
    configured primary is Jina."""
    monkeypatch.setattr(crawl_provider, "JINA_FALLBACK_ENABLED", False)
    monkeypatch.setattr(crawl_provider, "_provider_order", lambda: ("jina", "spider"))

    async def fake_jina(urls, **kw):
        return _empty_data(urls)

    async def fake_spider(urls, **kw):
        return _ok("spider", urls)

    monkeypatch.setattr(crawl_provider, "_jina_fetch_urls", fake_jina)
    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", fake_spider)

    data = await crawl_provider.fetch_urls(["https://a.test/x"], use_js=False, client_id=1)
    assert data["results"][0]["content"] == "spider:https://a.test/x"


def test_provider_order_resolves_from_runtime_config(monkeypatch):
    from app.services import runtime_config

    monkeypatch.setattr(runtime_config, "get_crawl_provider_primary", lambda: "jina")
    assert crawl_provider._provider_order() == ("jina", "spider")
    monkeypatch.setattr(runtime_config, "get_crawl_provider_primary", lambda: "spider")
    assert crawl_provider._provider_order() == ("spider", "jina")


def test_runtime_accessor_rejects_unknown_values(monkeypatch):
    from app.services import runtime_config

    monkeypatch.setattr(runtime_config, "get", lambda key, default=None: "playwright")
    assert runtime_config.get_crawl_provider_primary() in ("spider", "jina")
