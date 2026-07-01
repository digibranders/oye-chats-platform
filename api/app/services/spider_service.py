"""Spider.cloud crawl provider.

Calls Spider's managed crawl API and returns the SAME payload shape as
``crawler_service.crawl_website`` so ``crawl_orchestrator.run_full_crawl`` can
consume it unchanged:

    {"results": [{"url": str, "content": str}, ...],
     "recommended_colors": [],
     "discovered_total": int,
     "queue_remaining": int}

Browser rendering happens on Spider's infrastructure, so this path uses no
local Chromium — that is the whole point of the migration.
"""

import logging

import httpx

from app.config import (
    SPIDER_API_KEY,
    SPIDER_API_URL,
    SPIDER_REQUEST_MODE,
    SPIDER_TIMEOUT,
)
from app.services.crawler_service import CrawlerError, is_cancellation_requested

logger = logging.getLogger(__name__)


def _engine(use_js: bool) -> str:
    """Map our ``use_js`` flag onto Spider's ``request`` engine."""
    if use_js:
        return "chrome"  # force full JS render
    if SPIDER_REQUEST_MODE in ("http", "chrome", "smart"):
        return "http" if SPIDER_REQUEST_MODE == "smart" else SPIDER_REQUEST_MODE
    return "http"


async def crawl_website(
    url: str,
    *,
    max_pages: int | None = None,
    use_js: bool = False,
    client_id: int | None = None,
    max_depth: int | None = None,
    concurrency: int | None = None,
    _client: httpx.AsyncClient | None = None,
) -> dict:
    """Crawl ``url`` via Spider and return the orchestrator's crawl_data shape.

    ``concurrency`` is accepted for signature parity with the Playwright
    provider but is managed Spider-side, so it is not forwarded.
    """
    if not SPIDER_API_KEY:
        raise CrawlerError("SPIDER_API_KEY is not configured")

    if client_id is not None and is_cancellation_requested(client_id):
        logger.info("Spider crawl aborted before start (cancel requested) client=%s", client_id)
        return {"results": [], "recommended_colors": [], "discovered_total": 0, "queue_remaining": 0}

    payload: dict = {
        "url": url,
        "limit": int(max_pages) if max_pages else 0,  # 0 = Spider default cap
        "return_format": "markdown",
        "request": _engine(use_js),
        "readability": True,
        "store_data": False,
    }
    if max_depth:
        payload["depth"] = int(max_depth)

    headers = {
        "Authorization": f"Bearer {SPIDER_API_KEY}",
        "Content-Type": "application/json",
    }

    owns_client = _client is None
    client = _client or httpx.AsyncClient(timeout=SPIDER_TIMEOUT)
    try:
        resp = await client.post(f"{SPIDER_API_URL}/crawl", json=payload, headers=headers)
    except httpx.HTTPError as exc:
        raise CrawlerError(f"Spider request failed: {exc}") from exc
    finally:
        if owns_client:
            await client.aclose()

    if resp.status_code >= 400:
        raise CrawlerError(f"Spider returned {resp.status_code}: {resp.text[:300]}")

    try:
        pages = resp.json()
    except ValueError as exc:
        raise CrawlerError(f"Spider returned non-JSON body: {exc}") from exc
    if not isinstance(pages, list):
        raise CrawlerError(f"Spider returned unexpected payload type: {type(pages).__name__}")

    results = [
        {"url": p["url"], "content": p["content"]}
        for p in pages
        if isinstance(p, dict) and p.get("url") and p.get("content")
    ]
    logger.info(
        "Spider crawl %s: %d/%d pages with content (client=%s)",
        url,
        len(results),
        len(pages),
        client_id,
    )
    # Structured signal for reconciling usage against the Spider bill.
    logger.info(
        "spider_cost client=%s engine=%s pages=%d discovered=%d",
        client_id,
        _engine(use_js),
        len(results),
        len(pages),
    )
    return {
        "results": results,
        "recommended_colors": [],  # Spider does not extract colors
        "discovered_total": len(pages),
        "queue_remaining": 0,
    }
