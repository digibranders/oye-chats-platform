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

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable

import httpx

from app.config import (
    SPIDER_API_KEY,
    SPIDER_API_URL,
    SPIDER_REQUEST_MODE,
    SPIDER_TIMEOUT,
)
from app.services.crawler_service import CrawlCancelled, CrawlerError, is_cancellation_requested

# Called once per page as it finishes fetching: ``(url, ok)`` where ``ok`` is
# True if the page yielded content. Lets the orchestrator emit live progress.
PageProgressCallback = Callable[[str, bool], None]
# Called (and awaited — AR-23) with the full ``{"url", "content"}`` dict for
# every *successful* page, as it lands. Lets the orchestrator stream pages
# into ingestion while the rest of the crawl is still fetching (see
# crawl_orchestrator). Async so the orchestrator can put pages onto a
# bounded queue and have this await naturally suspend just this page's fetch
# slot when the ingest side falls behind — real producer-side backpressure
# instead of unbounded buffering, without blocking the event loop or other
# concurrent fetches (asyncio.gather keeps running the rest).
PageResultCallback = Callable[[dict], Awaitable[None]]

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
        raise CrawlCancelled({"results": [], "recommended_colors": []})

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
    # The recursive POST is one blocking call, so cancel can only land after it
    # returns — but honour it here so we don't proceed to embed a cancelled crawl.
    if client_id is not None and is_cancellation_requested(client_id):
        raise CrawlCancelled({"results": results, "recommended_colors": []})
    return {
        "results": results,
        "recommended_colors": [],  # Spider does not extract colors
        "discovered_total": len(pages),
        "queue_remaining": 0,
    }


# ── Explicit ordered-URL fetch (for credit-aware partial crawls) ─────────────

# Transient scrape failures (a burst 502/503/504 from the origin under crawl
# load, a timeout, or a 200-with-empty-content that masks an upstream 5xx) are
# retried — verified: pages that 502 mid-crawl return 200 when re-fetched. Only
# these statuses retry; a real 4xx (404/401) drops immediately.
_SCRAPE_ATTEMPTS = 3
_SCRAPE_RETRY_BASE = 1.5  # seconds; delay = base * attempt (backoff between tries)
_RETRYABLE_SCRAPE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


def _extract_page_content(resp: httpx.Response) -> tuple[str | None, int | None]:
    """Return (content, upstream_status) from a Spider /scrape response.

    ``content`` is None when the body is unparseable or the page came back empty
    (which usually masks an upstream 5xx). ``upstream_status`` is the per-page
    status Spider reports, when present.
    """
    try:
        data = resp.json()
    except ValueError:
        return None, None
    # /scrape returns a JSON list of page objects (verified Task 2 Step 0).
    page = data[0] if isinstance(data, list) and data else (data if isinstance(data, dict) else None)
    if not isinstance(page, dict):
        return None, None
    upstream = page.get("status")
    content = page.get("content")
    return (content if content else None), upstream


async def _scrape_one(client: httpx.AsyncClient, url: str, use_js: bool, sem: asyncio.Semaphore) -> dict | None:
    """Scrape a single URL to markdown, retrying transient failures.

    Returns ``{url, content}`` or None once the page is confirmed unfetchable.
    """
    payload = {
        "url": url,
        "return_format": "markdown",
        "request": _engine(use_js),
        "readability": True,
        "store_data": False,
    }
    headers = {"Authorization": f"Bearer {SPIDER_API_KEY}", "Content-Type": "application/json"}
    last_reason = "unknown"
    for attempt in range(1, _SCRAPE_ATTEMPTS + 1):
        resp: httpx.Response | None = None
        async with sem:  # hold a concurrency slot only for the request, not the backoff
            try:
                resp = await client.post(f"{SPIDER_API_URL}/scrape", json=payload, headers=headers)
            except httpx.HTTPError as exc:
                last_reason = f"{type(exc).__name__}"
        if resp is not None:
            if resp.status_code < 400:
                content, upstream = _extract_page_content(resp)
                if content:
                    return {"url": url, "content": content}
                # 200 but empty — usually a transient upstream 5xx; worth a retry.
                last_reason = f"empty content (upstream status={upstream})"
            elif resp.status_code not in _RETRYABLE_SCRAPE_STATUS:
                logger.warning("Spider scrape %s returned %s — dropped (not retryable)", url, resp.status_code)
                return None
            else:
                last_reason = f"HTTP {resp.status_code}"
        if attempt < _SCRAPE_ATTEMPTS:
            await asyncio.sleep(_SCRAPE_RETRY_BASE * attempt)
    # Exhausted retries — log so these drops are visible when reconciling
    # "N discovered vs M ingested".
    logger.warning(
        "Spider scrape %s failed after %d attempts (%s) — dropped",
        url,
        _SCRAPE_ATTEMPTS,
        last_reason,
    )
    return None


async def fetch_html(
    url: str,
    *,
    use_js: bool = False,
    _client: httpx.AsyncClient | None = None,
) -> str | None:
    """Fetch the raw HTML of a single URL via Spider ``/scrape``.

    Unlike :func:`fetch_urls`, this asks Spider for ``return_format=html`` and
    disables readability so the DOM comes back intact — needed by the footer
    harvester, which isolates ``<footer>`` / ``[role=contentinfo]`` regions
    from the raw markup that the main markdown crawl would otherwise strip.

    Returns the HTML body on success, or ``None`` on any failure (missing API
    key, HTTP error, empty body). Best-effort by design — the caller is a
    log-only, non-billable side channel and must never abort a real crawl.
    """
    if not SPIDER_API_KEY:
        logger.debug("fetch_html skipped for %s — SPIDER_API_KEY not configured", url)
        return None

    payload = {
        "url": url,
        "return_format": "html",
        "request": _engine(use_js),
        "readability": False,
        "store_data": False,
    }
    headers = {"Authorization": f"Bearer {SPIDER_API_KEY}", "Content-Type": "application/json"}

    owns_client = _client is None
    client = _client or httpx.AsyncClient(timeout=SPIDER_TIMEOUT)
    try:
        try:
            resp = await client.post(f"{SPIDER_API_URL}/scrape", json=payload, headers=headers)
        except httpx.HTTPError as exc:
            logger.warning("fetch_html %s: HTTP error %s", url, exc)
            return None
        if resp.status_code >= 400:
            logger.warning("fetch_html %s returned %s", url, resp.status_code)
            return None
        content, _upstream = _extract_page_content(resp)
        return content
    finally:
        if owns_client:
            await client.aclose()


async def fetch_urls(
    urls: list[str],
    *,
    use_js: bool = False,
    client_id: int | None = None,
    on_page: PageProgressCallback | None = None,
    on_result: PageResultCallback | None = None,
    _client: httpx.AsyncClient | None = None,
) -> dict:
    """Fetch an explicit, ordered list of URLs via Spider scrape → crawl_data shape.

    Preserves input order. Failed/empty pages are dropped (Spider bills $0 for
    them). Returns the same shape as ``crawl_website``. ``on_page(url, ok)`` — if
    given — fires as each page completes so callers can emit live progress;
    ``on_result(page)`` — if given — fires with the full page dict for each
    *successful* page so callers can stream ingestion while the crawl runs. A
    misbehaving callback is swallowed so it can never abort the crawl.
    """
    if not SPIDER_API_KEY:
        raise CrawlerError("SPIDER_API_KEY is not configured")
    if not urls:
        return {"results": [], "recommended_colors": [], "discovered_total": 0, "queue_remaining": 0}
    # Honor a cancel requested before we start spending (mirrors crawl_website).
    if client_id is not None and is_cancellation_requested(client_id):
        logger.info("Spider fetch_urls aborted before start (cancel requested) client=%s", client_id)
        raise CrawlCancelled({"results": [], "recommended_colors": []})

    owns_client = _client is None
    client = _client or httpx.AsyncClient(timeout=SPIDER_TIMEOUT)
    # Resolved per crawl (not at import) so the super-admin Crawler card can
    # tune parallelism at runtime; falls back to the env default.
    from app.services import runtime_config

    sem = asyncio.Semaphore(runtime_config.get_spider_fetch_concurrency())

    async def _scrape_and_report(url: str) -> dict | None:
        # Stop starting new fetches the moment a cancel lands: in-flight pages
        # (bounded by the semaphore) finish, everything else short-circuits so
        # the gather drains within one page instead of the whole batch. We then
        # raise CrawlCancelled below to hand the partial result to the caller.
        if client_id is not None and is_cancellation_requested(client_id):
            return None
        page = await _scrape_one(client, url, use_js, sem)
        if on_page is not None:
            # asyncio is single-threaded, so this runs serially as each task
            # resolves; a broken callback must not take the whole crawl down.
            with contextlib.suppress(Exception):
                on_page(url, page is not None)
        if on_result is not None and page is not None:
            with contextlib.suppress(Exception):
                await on_result(page)
        return page

    try:
        fetched = await asyncio.gather(*[_scrape_and_report(u) for u in urls])
    finally:
        if owns_client:
            await client.aclose()

    results = [p for p in fetched if p]  # gather preserves order
    logger.info(
        "spider_cost client=%s engine=%s pages=%d discovered=%d mode=fetch_urls",
        client_id,
        _engine(use_js),
        len(results),
        len(urls),
    )
    # Cancelled mid-flight: hand back whatever we scraped (already streamed to
    # ingestion) as a CrawlCancelled so the orchestrator writes a clean
    # ``cancelled`` state instead of continuing to embed the rest.
    if client_id is not None and is_cancellation_requested(client_id):
        logger.info(
            "Spider fetch_urls cancelled mid-flight: kept %d scraped pages (client=%s)", len(results), client_id
        )
        raise CrawlCancelled({"results": results, "recommended_colors": []})
    return {
        "results": results,
        "recommended_colors": [],
        "discovered_total": len(urls),
        "queue_remaining": 0,
    }
