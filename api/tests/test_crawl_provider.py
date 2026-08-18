import pytest

from app.services import crawl_provider
from app.services.crawler_service import CrawlerError


@pytest.mark.asyncio
async def test_sitemap_first_scrapes_discovered_urls(monkeypatch):
    """With a real sitemap, crawl_website enumerates it and scrapes every URL
    (this is what reaches all sitemap pages, not just depth-N link-reachable)."""
    seen = {}

    async def fake_discover(u, *, max_urls, timeout):
        seen["cap"] = max_urls
        return ["https://a.test/1", "https://a.test/2", "https://a.test/3"]

    async def fake_fetch(urls, **kw):
        seen["scraped"] = urls
        return {
            "results": [{"url": u, "content": "md"} for u in urls],
            "recommended_colors": [],
            "discovered_total": len(urls),
            "queue_remaining": 0,
        }

    async def boom_spider(*a, **k):
        raise AssertionError("Spider link crawl must not run when a sitemap exists")

    monkeypatch.setattr(crawl_provider, "_discover_urls", fake_discover)
    monkeypatch.setattr(crawl_provider, "fetch_urls", fake_fetch)
    monkeypatch.setattr(crawl_provider, "_spider_crawl", boom_spider)

    data = await crawl_provider.crawl_website("https://a.test", max_pages=250, use_js=False, client_id=1)
    assert seen["cap"] == 250  # capped at max_pages
    assert seen["scraped"] == ["https://a.test/1", "https://a.test/2", "https://a.test/3"]
    assert len(data["results"]) == 3


@pytest.mark.asyncio
async def test_no_sitemap_uses_link_discovery_via_provider_path(monkeypatch):
    """No sitemap but crawlable links: the link-discovered set is scraped
    through the provider-agnostic fetch path (honoring the toggle + failover),
    NOT Spider's recursive crawl."""
    seen = {}

    async def only_seed(u, *, max_urls, timeout):
        return [u]  # no usable sitemap

    async def fake_links(u, *, max_urls, timeout):
        return [u, "https://a.test/about", "https://a.test/pricing"]

    async def fake_fetch(urls, **kw):
        seen["scraped"] = urls
        return {
            "results": [{"url": u, "content": "md"} for u in urls],
            "recommended_colors": [],
            "discovered_total": len(urls),
            "queue_remaining": 0,
        }

    async def boom_spider(*a, **k):
        raise AssertionError("Spider recursive crawl must not run when links are discovered")

    monkeypatch.setattr(crawl_provider, "_discover_urls", only_seed)
    monkeypatch.setattr(crawl_provider, "_discover_links", fake_links)
    monkeypatch.setattr(crawl_provider, "fetch_urls", fake_fetch)
    monkeypatch.setattr(crawl_provider, "_spider_crawl", boom_spider)

    data = await crawl_provider.crawl_website("https://a.test", max_pages=100, use_js=False, client_id=1)
    assert seen["scraped"] == ["https://a.test", "https://a.test/about", "https://a.test/pricing"]
    assert len(data["results"]) == 3


@pytest.mark.asyncio
async def test_no_sitemap_no_links_falls_back_to_spider_link_crawl(monkeypatch):
    async def only_seed(u, *, max_urls, timeout):
        return [u]  # url_discovery guarantees the seed even with no sitemap

    async def no_links(u, *, max_urls, timeout):
        return [u]  # SPA / no crawlable anchors. Only the seed comes back

    async def fake_spider(url, **kw):
        return {
            "results": [{"url": url, "content": "spider"}],
            "recommended_colors": [],
            "discovered_total": 1,
            "queue_remaining": 0,
        }

    monkeypatch.setattr(crawl_provider, "_discover_urls", only_seed)
    monkeypatch.setattr(crawl_provider, "_discover_links", no_links)
    monkeypatch.setattr(crawl_provider, "_spider_crawl", fake_spider)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=100, use_js=False, client_id=1)
    assert data["results"][0]["content"] == "spider"


@pytest.mark.asyncio
async def test_no_sitemap_no_links_spider_fails_then_jina(monkeypatch):
    monkeypatch.setattr(crawl_provider, "JINA_FALLBACK_ENABLED", True)

    async def only_seed(u, *, max_urls, timeout):
        return [u]

    async def no_links(u, *, max_urls, timeout):
        return [u]

    async def boom_spider(url, **kw):
        raise CrawlerError("spider down")

    async def fake_jina(urls, **kw):
        return {
            "results": [{"url": urls[0], "content": "jina"}],
            "recommended_colors": [],
            "discovered_total": len(urls),
            "queue_remaining": 0,
        }

    monkeypatch.setattr(crawl_provider, "_discover_urls", only_seed)
    monkeypatch.setattr(crawl_provider, "_discover_links", no_links)
    monkeypatch.setattr(crawl_provider, "_spider_crawl", boom_spider)
    monkeypatch.setattr(crawl_provider, "_jina_fetch_urls", fake_jina)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=100, use_js=False, client_id=1)
    assert data["results"][0]["content"] == "jina"


@pytest.mark.asyncio
async def test_link_discovery_failure_falls_back_to_spider(monkeypatch):
    """A link-scan that raises must not abort the crawl, it degrades to the
    Spider recursive crawl, same as an empty scan."""

    async def only_seed(u, *, max_urls, timeout):
        return [u]

    async def boom_links(u, *, max_urls, timeout):
        raise TimeoutError("link scan timed out")

    async def fake_spider(url, **kw):
        return {
            "results": [{"url": url, "content": "spider"}],
            "recommended_colors": [],
            "discovered_total": 1,
            "queue_remaining": 0,
        }

    monkeypatch.setattr(crawl_provider, "_discover_urls", only_seed)
    monkeypatch.setattr(crawl_provider, "_discover_links", boom_links)
    monkeypatch.setattr(crawl_provider, "_spider_crawl", fake_spider)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=100, use_js=False, client_id=1)
    assert data["results"][0]["content"] == "spider"


@pytest.mark.asyncio
async def test_discovery_failure_falls_back_to_spider(monkeypatch):
    async def boom_discover(u, *, max_urls, timeout):
        raise TimeoutError("discovery timed out")

    async def no_links(u, *, max_urls, timeout):
        return [u]

    async def fake_spider(url, **kw):
        return {
            "results": [{"url": url, "content": "spider"}],
            "recommended_colors": [],
            "discovered_total": 1,
            "queue_remaining": 0,
        }

    monkeypatch.setattr(crawl_provider, "_discover_urls", boom_discover)
    monkeypatch.setattr(crawl_provider, "_discover_links", no_links)
    monkeypatch.setattr(crawl_provider, "_spider_crawl", fake_spider)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=100, use_js=False, client_id=1)
    assert data["results"][0]["content"] == "spider"
