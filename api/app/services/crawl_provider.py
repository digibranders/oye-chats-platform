"""Selects the crawl backend: Spider.cloud and Jina Reader, order-configurable.

``run_full_crawl`` imports ``crawl_website`` / ``fetch_urls`` from here.

Which backend page fetches try FIRST is a runtime setting, the super-admin
Models & RAG page writes ``crawl.provider_primary`` ("spider" | "jina") and the
other provider becomes the fallback. Failover triggers on a raised
``CrawlerError`` *or* an empty result set (Jina fails soft: it drops pages
instead of raising).

``crawl_website`` is **sitemap-first**: it enumerates the site's authoritative
page list via ``url_discovery`` (robots.txt + sitemap.xml, browser-free) and
scrapes every URL through the same path as an explicit crawl, so it reaches
deep/orphan pages that a depth-limited link crawl misses. When a site has no
usable sitemap it falls back to a browser-free same-domain link scan
(``discover_via_links``) and scrapes the result through the same
provider-agnostic path, so the primary/fallback toggle is honored there too.
Only when neither a sitemap nor crawlable links exist (e.g. a client-rendered
SPA) does it fall back to Spider's recursive link crawl (Spider is the only
backend with a recursive mode, so that last-resort path ignores the provider
order).

Both paths return the identical crawl_data shape, so the ingest pipeline is
provider-agnostic.
"""

import logging
from collections.abc import Awaitable, Callable

from app.config import JINA_FALLBACK_ENABLED
from app.services.crawler_service import CrawlerError
from app.services.jina_service import fetch_urls as _jina_fetch_urls
from app.services.spider_service import crawl_website as _spider_crawl
from app.services.spider_service import fetch_urls as _spider_fetch_urls
from app.services.url_discovery import discover_via_links as _discover_links
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
    on_result: Callable[[dict], Awaitable[None]] | None = None,
    max_depth: int | None = None,
    concurrency: int | None = None,
) -> dict:
    """Crawl a site to (at most) ``max_pages`` pages, sitemap-first.

    1. Enumerate the sitemap/robots page list (``url_discovery``), capped at
       ``max_pages``. This is the authoritative set and includes deep/orphan
       pages a link crawl never reaches.
    2. Scrape each URL via :func:`fetch_urls` (runtime-configured primary with
       failover to the other provider, ordered, per-page ``on_page`` progress,
       per-page ``on_result`` streaming).
    3. If the site has no usable sitemap (discovery yields only the seed), scan
       same-domain ``<a href>`` links (``discover_via_links``, browser-free) and
       scrape any that are found via the same :func:`fetch_urls` path, so the
       provider toggle and failover apply here too.
    4. Only if neither a sitemap nor crawlable links exist (e.g. a
       client-rendered SPA) fall back to Spider's recursive link crawl
       (``max_depth``/``concurrency``), with a Jina fallback on Spider failure
       that replays whatever URLs were discovered. The recursive crawl is a
       single blocking call, so it cannot stream ``on_result``. Callers must
       handle "no pages streamed" (the orchestrator's final ingest sweep does).
    """
    cap = max_pages or _FALLBACK_DISCOVERY_CAP
    discovery_stats: dict = {}
    try:
        discovered = await _discover_urls(url, max_urls=cap, timeout=25.0, stats=discovery_stats)
    except Exception:
        logger.warning("Sitemap discovery failed for %s. Trying Spider link crawl", url, exc_info=True)
        discovered = []

    if len(discovered) > 1:
        logger.info("crawl_path mode=sitemap urls=%d url=%s cap=%s", len(discovered), url, cap)
        data = await fetch_urls(discovered, use_js=use_js, client_id=client_id, on_page=on_page, on_result=on_result)
        # ``fetch_urls`` can only report the length of the list it was handed,
        # and that list is already truncated to ``cap``. Reporting it as the
        # discovered total made the orchestrator's coverage shortfall
        # ("N pages didn't fit your plan") structurally always zero. Use the
        # pre-truncation count discovery actually saw.
        data["discovered_total"] = max(int(discovery_stats.get("total_found") or 0), len(discovered))
        return data

    # No usable sitemap. Before falling back to Spider's recursive crawl (the
    # only backend that can discover pages, so that path ignores the provider
    # toggle), try a browser-free same-domain link scan. When it finds real
    # links we scrape them through the provider-agnostic ``fetch_urls`` path,
    # so the primary/fallback setting is honored here too, and a Spider outage
    # no longer silently collapses a sitemap-less crawl to a single page.
    linked: list[str] = []
    try:
        linked = await _discover_links(url, max_urls=cap, timeout=25.0)
    except Exception:
        logger.warning("Link discovery failed for %s. Trying Spider link crawl", url, exc_info=True)

    if len(linked) > 1:
        logger.info("crawl_path mode=links urls=%d url=%s cap=%s", len(linked), url, cap)
        return await fetch_urls(linked, use_js=use_js, client_id=client_id, on_page=on_page, on_result=on_result)

    # Neither a sitemap nor crawlable links (e.g. a client-rendered SPA). Spider's
    # recursive crawl with a JS engine is the only backend that can discover
    # pages here; Jina has no recursive mode, so on Spider failure it can only
    # replay the URLs we already discovered.
    logger.info("crawl_path mode=spider_recursive url=%s depth=%s", url, max_depth)
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
        fallback_urls = linked or discovered or [url]
        logger.warning(
            "crawl_path mode=jina_recursive_fallback url=%s urls=%d (Spider recursive crawl failed)",
            url,
            len(fallback_urls),
            exc_info=True,
        )
        return await _jina_fetch_urls(
            fallback_urls, use_js=use_js, client_id=client_id, on_page=on_page, on_result=on_result
        )


async def fetch_urls(urls: list[str], **kwargs) -> dict:
    """Fetch an explicit, ordered URL list via the primary provider, with
    failover to the other one.

    The provider order is a runtime setting (``crawl.provider_primary``).
    Failover fires when the primary raises ``CrawlerError`` or drops pages.
    Zero results replays the whole list, a *partial* result retries only the
    URLs the primary missed. Dropping pages (rather than raising) is how Jina
    fails. Results are merged and returned in the original input order, so a
    flaky primary no longer silently shrinks coverage and successfully-scraped
    pages are never re-fetched on the fallback.

    ``JINA_FALLBACK_ENABLED=false`` disables Jina *as a fallback* only; an
    explicit jina-primary configuration still runs Jina first.
    """
    primary, fallback = _provider_order()
    primary_data: dict | None = None
    primary_error: CrawlerError | None = None
    try:
        primary_data = await _fetcher(primary)(urls, **kwargs)
    except CrawlerError as exc:
        primary_error = exc

    if primary_data is not None:
        got = {p["url"] for p in primary_data.get("results", [])}
        missing = [u for u in urls if u not in got]
        if not missing:
            return primary_data  # full success (also the empty-input case)
        logger.warning("%s fetch_urls returned %d/%d pages. Retrying the rest", primary, len(got), len(urls))
    else:
        missing = list(urls)

    if fallback == "jina" and not JINA_FALLBACK_ENABLED:
        # Jina fallback is off: keep whatever the primary delivered rather than
        # discard a partial result; only a hard primary failure surfaces.
        if primary_data is not None:
            return primary_data
        if primary_error is not None:
            raise primary_error
        raise CrawlerError(f"{primary} returned no pages and the Jina fallback is disabled")

    logger.warning(
        "%s fetch_urls failed (%d/%d urls). Falling back to %s",
        primary,
        len(missing),
        len(urls),
        fallback,
        exc_info=primary_error is not None,
    )
    try:
        fallback_data = await _fetcher(fallback)(missing, **kwargs)
    except CrawlerError:
        # The fallback is unavailable (the commonest case: the other provider
        # has no API key configured, so its fetch_urls raises unconditionally).
        # That must not destroy a partially-successful crawl: with streaming
        # on, the pages the primary DID return are already committed and
        # BILLED, and letting this propagate reported the whole crawl as
        # ``failed`` while the customer paid for it. Keep whatever the primary
        # delivered; only re-raise when there is genuinely nothing to keep.
        if primary_data is not None and primary_data.get("results"):
            logger.warning(
                "%s fallback failed after %s delivered %d/%d pages. Keeping the partial result",
                fallback,
                primary,
                len(urls) - len(missing),
                len(urls),
                exc_info=True,
            )
            return primary_data
        raise

    # Merge primary successes with the fallback retry, de-duplicated by URL and
    # emitted in the original input order (fallback wins for any overlap).
    merged: dict[str, dict] = {}
    if primary_data is not None:
        for page in primary_data.get("results", []):
            merged[page["url"]] = page
    for page in fallback_data.get("results", []):
        merged[page["url"]] = page
    return {
        "results": [merged[u] for u in urls if u in merged],
        "recommended_colors": primary_data.get("recommended_colors", []) if primary_data else [],
        "discovered_total": len(urls),
        "queue_remaining": 0,
    }
