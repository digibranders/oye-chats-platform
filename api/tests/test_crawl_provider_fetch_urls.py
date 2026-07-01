import pytest

from app.services import crawl_provider
from app.services.crawler_service import CrawlerError


@pytest.mark.asyncio
async def test_fetch_urls_uses_spider(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", False)

    async def fake_spider(urls, **kw):
        return {"results": [{"url": urls[0], "content": "s"}], "recommended_colors": [],
                "discovered_total": len(urls), "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", fake_spider)
    data = await crawl_provider.fetch_urls(["https://a.test/x"], use_js=False, client_id=1)
    assert data["results"][0]["content"] == "s"


@pytest.mark.asyncio
async def test_fetch_urls_falls_back_to_recursive_crawl(monkeypatch):
    """On Spider failure, fall back to a recursive crawl of the seed domain,
    capped at the number of requested URLs."""
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", True)
    seen = {}

    async def boom(urls, **kw):
        raise CrawlerError("down")

    async def fake_recursive(url, **kw):
        seen["seed"] = url
        seen["max_pages"] = kw.get("max_pages")
        return {"results": [{"url": url, "content": "pw"}], "recommended_colors": [],
                "discovered_total": 1, "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", boom)
    monkeypatch.setattr(crawl_provider, "_playwright_crawl", fake_recursive)
    data = await crawl_provider.fetch_urls(
        ["https://a.test/x", "https://a.test/y"], use_js=False, client_id=1
    )
    assert data["results"][0]["content"] == "pw"
    assert seen["seed"] == "https://a.test"   # origin of the first URL
    assert seen["max_pages"] == 2             # capped at len(urls)


@pytest.mark.asyncio
async def test_fetch_urls_reraises_without_fallback(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", False)

    async def boom(urls, **kw):
        raise CrawlerError("down")

    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", boom)
    with pytest.raises(CrawlerError):
        await crawl_provider.fetch_urls(["https://a.test/x"], use_js=False, client_id=1)
