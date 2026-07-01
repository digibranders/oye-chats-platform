"""Selects the crawl backend (Playwright self-host vs Spider.cloud managed API).

``run_full_crawl`` imports ``crawl_website`` from here instead of directly from
``crawler_service``. Both backends return the identical crawl_data shape, so the
downstream ingest pipeline is provider-agnostic.
"""

import logging
from urllib.parse import urlparse

from app.config import CRAWL_PROVIDER, SPIDER_FALLBACK_TO_PLAYWRIGHT
from app.services.crawler_service import CrawlerError
from app.services.crawler_service import crawl_website as _playwright_crawl
from app.services.spider_service import crawl_website as _spider_crawl
from app.services.spider_service import fetch_urls as _spider_fetch_urls

logger = logging.getLogger(__name__)


async def crawl_website(url: str, **kwargs) -> dict:
    """Dispatch to the configured crawl provider.

    ``kwargs`` are forwarded verbatim: ``max_pages``, ``use_js``, ``client_id``,
    ``max_depth``, ``concurrency``.
    """
    if CRAWL_PROVIDER == "spider":
        try:
            return await _spider_crawl(url, **kwargs)
        except CrawlerError:
            if not SPIDER_FALLBACK_TO_PLAYWRIGHT:
                raise
            logger.warning("Spider crawl failed for %s — falling back to Playwright", url, exc_info=True)
            return await _playwright_crawl(url, **kwargs)
    return await _playwright_crawl(url, **kwargs)


async def fetch_urls(urls: list[str], **kwargs) -> dict:
    """Fetch an explicit ordered URL list.

    Spider scrapes the exact list in order. On a Spider outage we can't replay
    an arbitrary list with the recursive crawler, so we recursively crawl the
    seed domain capped at len(urls) — best-effort, order not guaranteed.
    """
    if CRAWL_PROVIDER == "spider":
        try:
            return await _spider_fetch_urls(urls, **kwargs)
        except CrawlerError:
            if not SPIDER_FALLBACK_TO_PLAYWRIGHT:
                raise
            logger.warning(
                "Spider fetch_urls failed (%d urls) — falling back to recursive crawl",
                len(urls),
                exc_info=True,
            )
    if not urls:
        return {"results": [], "recommended_colors": [], "discovered_total": 0, "queue_remaining": 0}
    parsed = urlparse(urls[0])
    seed = f"{parsed.scheme}://{parsed.netloc}"
    return await _playwright_crawl(
        seed,
        max_pages=len(urls),
        use_js=kwargs.get("use_js", False),
        client_id=kwargs.get("client_id"),
    )
