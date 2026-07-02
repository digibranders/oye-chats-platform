"""Selects the crawl backend: Spider.cloud and Jina Reader, order-configurable.

``run_full_crawl`` imports ``crawl_website`` / ``fetch_urls`` from here.

Which backend page fetches try FIRST is a runtime setting — the super-admin
Models & RAG page writes ``crawl.provider_primary`` ("spider" | "jina") and the
other provider becomes the fallback. Failover triggers on a raised
``CrawlerError`` *or* an empty result set (Jina fails soft: it drops pages
instead of raising).

``crawl_website`` is **sitemap-first**: it enumerates the site's authoritative
page list via ``url_discovery`` (robots.txt + sitemap.xml, browser-free) and
scrapes every URL through the same path as an explicit crawl — so it reaches
deep/orphan pages that a depth-limited link crawl misses. Only when a site has
no usable sitemap does it fall back to Spider's recursive link crawl (Spider is
the only backend with a recursive mode, so that path ignores the provider
order).

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


def _fetcher(provider: str):
    """Resolve a provider name to its fetch_urls at call time (test-patchable)."""
    return {"spider": _spider_fetch_urls, "jina": _jina_fetch_urls}[provider]


def _provider_order() -> tuple[str, str]:
    """Resolve (primary, fallback) from runtime config at call time."""
    from app.services import runtime_config

    primary = runtime_config.get_crawl_provider_primary()
    return (primary, "jina" if primary == "spider" else "spider")


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
    2. Scrape each URL via :func:`fetch_urls` (runtime-configured primary with
       failover to the other provider, ordered, per-page ``on_page`` progress,
       per-page ``on_result`` streaming).
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
    """Fetch an explicit, ordered URL list via the primary provider, with
    failover to the other one.

    The provider order is a runtime setting (``crawl.provider_primary``).
    Failover fires when the primary raises ``CrawlerError`` or comes back with
    zero pages for a non-empty list — the latter is how Jina fails (it drops
    pages instead of raising). Both providers replay the exact list in order,
    so order and coverage are preserved across a failover.

    ``JINA_FALLBACK_ENABLED=false`` disables Jina *as a fallback* only; an
    explicit jina-primary configuration still runs Jina first.
    """
    primary, fallback = _provider_order()
    primary_error: CrawlerError | None = None
    try:
        data = await _fetcher(primary)(urls, **kwargs)
        if data.get("results") or not urls:
            return data
        logger.warning("%s fetch_urls returned 0/%d pages — treating as failure", primary, len(urls))
    except CrawlerError as exc:
        primary_error = exc
    if fallback == "jina" and not JINA_FALLBACK_ENABLED:
        if primary_error is not None:
            raise primary_error
        raise CrawlerError(f"{primary} returned no pages and the Jina fallback is disabled")
    logger.warning(
        "%s fetch_urls failed (%d urls) — falling back to %s",
        primary,
        len(urls),
        fallback,
        exc_info=primary_error is not None,
    )
    return await _fetcher(fallback)(urls, **kwargs)
