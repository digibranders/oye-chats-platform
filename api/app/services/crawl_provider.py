"""Selects the crawl backend (Playwright self-host vs Spider.cloud managed API).

``run_full_crawl`` imports ``crawl_website`` from here instead of directly from
``crawler_service``. Both backends return the identical crawl_data shape, so the
downstream ingest pipeline is provider-agnostic.
"""

import logging

from app.config import CRAWL_PROVIDER, SPIDER_FALLBACK_TO_PLAYWRIGHT
from app.services.crawler_service import CrawlerError
from app.services.crawler_service import crawl_website as _playwright_crawl
from app.services.spider_service import crawl_website as _spider_crawl

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
