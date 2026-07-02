"""Selects the crawl backend: Spider.cloud primary, Jina Reader fallback.

``run_full_crawl`` imports ``crawl_website`` / ``fetch_urls`` from here.

``crawl_website`` is **sitemap-first**: it enumerates the site's authoritative
page list via ``url_discovery`` (robots.txt + sitemap.xml, browser-free) and
scrapes every URL through the same path as an explicit crawl — so it reaches
deep/orphan pages that a depth-limited link crawl misses. Only when a site has
no usable sitemap does it fall back to Spider's recursive link crawl. Every
scrape has Spider→Jina failover built in via ``fetch_urls``.

Both paths return the identical crawl_data shape, so the ingest pipeline is
provider-agnostic.
"""

import logging
from collections.abc import Callable

from app.config import JINA_FALLBACK_ENABLED
from app.services.crawler_service import CrawlerError
from app.services.jina_service import fetch_urls as _jina_fetch_urls
from app.services.spider_service import crawl_website as _spider_crawl
from app.services.spider_service import fetch_urls as _spider_fetch_urls
from app.services.url_discovery import discover_website_urls as _discover_urls

logger = logging.getLogger(__name__)

# Ceiling on URLs pulled from a sitemap when no explicit page cap is given, so a
# runaway site can't balloon the scrape set.
_FALLBACK_DISCOVERY_CAP = 5000


async def crawl_website(
    url: str,
    *,
    max_pages: int | None = None,
    use_js: bool = False,
    client_id: int | None = None,
    on_page: Callable[[str, bool], None] | None = None,
    on_result: Callable[[dict], None] | None = None,
    max_depth: int | None = None,
    concurrency: int | None = None,
) -> dict:
    """Crawl a site to (at most) ``max_pages`` pages, sitemap-first.

    1. Enumerate the sitemap/robots page list (``url_discovery``), capped at
       ``max_pages`` — this is the authoritative set and includes deep/orphan
       pages a link crawl never reaches.
    2. Scrape each URL via :func:`fetch_urls` (Spider→Jina failover, ordered,
       per-page ``on_page`` progress, per-page ``on_result`` streaming).
    3. If the site has no usable sitemap (discovery yields only the seed), fall
       back to Spider's recursive link crawl (``max_depth``/``concurrency``),
       with a Jina fallback on Spider failure. The recursive crawl is a single
       blocking call, so it cannot stream ``on_result`` — callers must handle
       "no pages streamed" (the orchestrator's final ingest sweep does).
    """
    cap = max_pages or _FALLBACK_DISCOVERY_CAP
    try:
        discovered = await _discover_urls(url, max_urls=cap, timeout=25.0)
    except Exception:
        logger.warning("Sitemap discovery failed for %s — trying Spider link crawl", url, exc_info=True)
        discovered = []

    if len(discovered) > 1:
        logger.info("Sitemap-seeded crawl: scraping %d URLs for %s (cap=%s)", len(discovered), url, cap)
        return await fetch_urls(discovered, use_js=use_js, client_id=client_id, on_page=on_page, on_result=on_result)

    # No usable sitemap — Spider recursive link crawl, Jina fallback on failure.
    logger.info("No usable sitemap for %s — Spider recursive link crawl (depth=%s)", url, max_depth)
    try:
        return await _spider_crawl(
            url,
            max_pages=max_pages,
            use_js=use_js,
            client_id=client_id,
            max_depth=max_depth,
            concurrency=concurrency,
        )
    except CrawlerError:
        if not JINA_FALLBACK_ENABLED:
            raise
        logger.warning("Spider crawl failed for %s — Jina fallback", url, exc_info=True)
        return await _jina_fetch_urls(
            discovered or [url], use_js=use_js, client_id=client_id, on_page=on_page, on_result=on_result
        )


async def fetch_urls(urls: list[str], **kwargs) -> dict:
    """Fetch an explicit, ordered URL list via Spider; Jina Reader on failure.

    Jina replays the exact list in order — unlike the old recursive fallback,
    order and coverage are preserved on a Spider outage.
    """
    try:
        return await _spider_fetch_urls(urls, **kwargs)
    except CrawlerError:
        if not JINA_FALLBACK_ENABLED:
            raise
        logger.warning("Spider fetch_urls failed (%d urls) — falling back to Jina", len(urls), exc_info=True)
        return await _jina_fetch_urls(urls, **kwargs)
