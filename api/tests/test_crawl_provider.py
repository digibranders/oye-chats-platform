import pytest

from app.services import crawl_provider
from app.services.crawler_service import CrawlerError


@pytest.mark.asyncio
async def test_dispatches_to_playwright_by_default(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "playwright")
    called = {}

    async def fake_pw(url, **kw):
        called["pw"] = True
        return {"results": [{"url": url, "content": "pw"}], "recommended_colors": [],
                "discovered_total": 1, "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_playwright_crawl", fake_pw)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=1, use_js=False, client_id=1)
    assert called.get("pw") is True
    assert data["results"][0]["content"] == "pw"


@pytest.mark.asyncio
async def test_dispatches_to_spider(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", False)

    async def fake_spider(url, **kw):
        return {"results": [{"url": url, "content": "spider"}], "recommended_colors": [],
                "discovered_total": 1, "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_spider_crawl", fake_spider)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=1, use_js=False, client_id=1)
    assert data["results"][0]["content"] == "spider"


@pytest.mark.asyncio
async def test_spider_failure_falls_back_to_playwright(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", True)

    async def boom_spider(url, **kw):
        raise CrawlerError("spider down")

    async def fake_pw(url, **kw):
        return {"results": [{"url": url, "content": "pw-fallback"}], "recommended_colors": [],
                "discovered_total": 1, "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_spider_crawl", boom_spider)
    monkeypatch.setattr(crawl_provider, "_playwright_crawl", fake_pw)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=1, use_js=False, client_id=1)
    assert data["results"][0]["content"] == "pw-fallback"


@pytest.mark.asyncio
async def test_spider_failure_without_fallback_reraises(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", False)

    async def boom_spider(url, **kw):
        raise CrawlerError("spider down")

    monkeypatch.setattr(crawl_provider, "_spider_crawl", boom_spider)
    with pytest.raises(CrawlerError):
        await crawl_provider.crawl_website("https://a.test", max_pages=1, use_js=False, client_id=1)
