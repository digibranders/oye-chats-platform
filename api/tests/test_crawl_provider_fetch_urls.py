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
