import pytest

from app.services import crawl_provider
from app.services.crawler_service import CrawlerError


@pytest.mark.asyncio
async def test_crawl_website_uses_spider(monkeypatch):
    async def fake_spider(url, **kw):
        return {
            "results": [{"url": url, "content": "spider"}],
            "recommended_colors": [],
            "discovered_total": 1,
            "queue_remaining": 0,
        }

    monkeypatch.setattr(crawl_provider, "_spider_crawl", fake_spider)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=1, use_js=False, client_id=1)
    assert data["results"][0]["content"] == "spider"


@pytest.mark.asyncio
async def test_spider_failure_falls_back_to_jina_via_discovery(monkeypatch):
    monkeypatch.setattr(crawl_provider, "JINA_FALLBACK_ENABLED", True)
    seen = {}

    async def boom_spider(url, **kw):
        raise CrawlerError("spider down")

    async def fake_discover(url, *, max_urls, timeout):
        seen["seed"] = url
        seen["max_urls"] = max_urls
        return ["https://a.test/1", "https://a.test/2"]

    async def fake_jina(urls, **kw):
        return {
            "results": [{"url": u, "content": "md"} for u in urls],
            "recommended_colors": [],
            "discovered_total": len(urls),
            "queue_remaining": 0,
        }

    monkeypatch.setattr(crawl_provider, "_spider_crawl", boom_spider)
    monkeypatch.setattr(crawl_provider, "_discover_urls", fake_discover)
    monkeypatch.setattr(crawl_provider, "_jina_fetch_urls", fake_jina)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=5, use_js=False, client_id=1)
    assert [p["url"] for p in data["results"]] == ["https://a.test/1", "https://a.test/2"]
    assert seen["seed"] == "https://a.test"
    assert seen["max_urls"] == 5  # uses max_pages as the discovery cap


@pytest.mark.asyncio
async def test_fallback_fetches_seed_when_discovery_empty(monkeypatch):
    monkeypatch.setattr(crawl_provider, "JINA_FALLBACK_ENABLED", True)

    async def boom_spider(url, **kw):
        raise CrawlerError("down")

    async def empty_discover(url, *, max_urls, timeout):
        return []

    async def fake_jina(urls, **kw):
        return {
            "results": [{"url": urls[0], "content": "md"}],
            "recommended_colors": [],
            "discovered_total": len(urls),
            "queue_remaining": 0,
        }

    monkeypatch.setattr(crawl_provider, "_spider_crawl", boom_spider)
    monkeypatch.setattr(crawl_provider, "_discover_urls", empty_discover)
    monkeypatch.setattr(crawl_provider, "_jina_fetch_urls", fake_jina)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=5, use_js=False, client_id=1)
    assert data["results"][0]["url"] == "https://a.test"


@pytest.mark.asyncio
async def test_spider_failure_without_fallback_reraises(monkeypatch):
    monkeypatch.setattr(crawl_provider, "JINA_FALLBACK_ENABLED", False)

    async def boom_spider(url, **kw):
        raise CrawlerError("spider down")

    monkeypatch.setattr(crawl_provider, "_spider_crawl", boom_spider)
    with pytest.raises(CrawlerError):
        await crawl_provider.crawl_website("https://a.test", max_pages=1, use_js=False, client_id=1)
