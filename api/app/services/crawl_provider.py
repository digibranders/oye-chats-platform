"""Selects the crawl backend: Spider.cloud primary, Jina Reader fallback.

``run_full_crawl`` imports ``crawl_website`` / ``fetch_urls`` from here. Spider is
the sole primary crawler (no local browser). On a Spider ``CrawlerError`` we fall
back to Jina Reader (PAYG markdown, off-box):

* recursive crawl → discover URLs (browser-free ``url_discovery``) then Jina each;
* explicit ordered list → Jina the list directly.

Both backends return the identical crawl_data shape, so the ingest pipeline is
provider-agnostic.
"""

import logging

from app.config import JINA_FALLBACK_ENABLED
from app.services.crawler_service import CrawlerError
from app.services.jina_service import fetch_urls as _jina_fetch_urls
from app.services.spider_service import crawl_website as _spider_crawl
from app.services.spider_service import fetch_urls as _spider_fetch_urls
from app.services.url_discovery import discover_website_urls as _discover_urls

logger = logging.getLogger(__name__)

# When Spider can't determine a page cap, discover at most this many URLs to hand
# to the Jina fallback (keeps a runaway site from ballooning the fallback fetch).
_FALLBACK_DISCOVERY_CAP = 1000


async def crawl_website(url: str, **kwargs) -> dict:
    """Crawl a site via Spider; on failure discover URLs + fetch via Jina Reader.

    ``kwargs`` are forwarded verbatim to Spider: ``max_pages``, ``use_js``,
    ``client_id``, ``max_depth``, ``concurrency``.
    """
    try:
        return await _spider_crawl(url, **kwargs)
    except CrawlerError:
        if not JINA_FALLBACK_ENABLED:
            raise
        logger.warning(
            "Spider crawl failed for %s — falling back to Jina via discovery", url, exc_info=True
        )
        max_pages = kwargs.get("max_pages") or 0
        discovered = await _discover_urls(
            url, max_urls=(max_pages or _FALLBACK_DISCOVERY_CAP), timeout=20.0
        )
        if not discovered:
            discovered = [url]  # discovery came up empty — at least fetch the seed
        return await _jina_fetch_urls(
            discovered, use_js=kwargs.get("use_js", False), client_id=kwargs.get("client_id")
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
        logger.warning(
            "Spider fetch_urls failed (%d urls) — falling back to Jina", len(urls), exc_info=True
        )
        return await _jina_fetch_urls(urls, **kwargs)
