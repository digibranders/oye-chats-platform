"""Jina Reader crawl fallback — fetch URLs as markdown via https://r.jina.ai/<url>.

PAYG, off-box, markdown-native. Returns the SAME payload shape as
``spider_service`` so it drops in behind ``crawl_provider``:

    {"results": [{"url": str, "content": str}, ...],
     "recommended_colors": [],
     "discovered_total": int,
     "queue_remaining": int}

Single-page by design — multi-page coverage is provided by ``url_discovery``
(browser-free) upstream. Jina renders JS server-side, so ``use_js`` is accepted
only for signature parity with the Spider provider.
"""

import asyncio
import logging

import httpx

from app.config import JINA_API_KEY, JINA_FETCH_CONCURRENCY, JINA_READER_URL

logger = logging.getLogger(__name__)

_TIMEOUT = 60.0


def _empty() -> dict:
    return {"results": [], "recommended_colors": [], "discovered_total": 0, "queue_remaining": 0}


async def _fetch_one(client: httpx.AsyncClient, url: str, sem: asyncio.Semaphore) -> dict | None:
    headers = {"X-Return-Format": "markdown"}
    if JINA_API_KEY:
        headers["Authorization"] = f"Bearer {JINA_API_KEY}"
    async with sem:
        try:
            resp = await client.get(f"{JINA_READER_URL}/{url}", headers=headers, timeout=_TIMEOUT)
        except httpx.HTTPError as exc:
            logger.warning("Jina fetch failed for %s: %s", url, exc)
            return None
    if resp.status_code >= 400 or not resp.text.strip():
        logger.warning("Jina fetch %s returned %s (len=%d)", url, resp.status_code, len(resp.text))
        return None
    return {"url": url, "content": resp.text}


async def fetch_urls(
    urls: list[str],
    *,
    use_js: bool = False,  # noqa: ARG001 — parity with spider_service; Jina renders JS server-side
    client_id: int | None = None,
    _client: httpx.AsyncClient | None = None,
) -> dict:
    """Fetch an explicit, ordered URL list as markdown. Preserves order; drops failures."""
    if not urls:
        return _empty()

    owns_client = _client is None
    client = _client or httpx.AsyncClient(timeout=_TIMEOUT)
    sem = asyncio.Semaphore(JINA_FETCH_CONCURRENCY)
    try:
        fetched = await asyncio.gather(*[_fetch_one(client, u, sem) for u in urls])
    finally:
        if owns_client:
            await client.aclose()

    results = [page for page in fetched if page]  # gather preserves order
    logger.info("jina_fallback client=%s pages=%d/%d", client_id, len(results), len(urls))
    return {
        "results": results,
        "recommended_colors": [],
        "discovered_total": len(urls),
        "queue_remaining": 0,
    }
