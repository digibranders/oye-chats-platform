"""
Lightweight URL discovery — sitemap-first, BFS fallback.

Used by POST /crawl/discover to count pages before a full crawl starts.
Does NOT extract page content; only discovers URLs. Intentionally avoids
Playwright so it completes in a few seconds even for large sites.

Algorithm:
  1. Fetch robots.txt → extract Sitemap: directives
  2. Try standard sitemap paths (/sitemap.xml, /sitemap_index.xml)
  3. Parse sitemaps (handles sitemap index, one level deep)
  4. If < 5 URLs from sitemap: shallow HTTP BFS from the seed page (depth 1)

Also exports ``check_urls_alive`` for the recrawl-diff endpoint, which
needs an authoritative liveness verdict for previously-stored URLs rather
than relying on whether discovery happens to find them again.
"""

import asyncio
import logging
import re
from urllib.parse import parse_qs, urlparse

logger = logging.getLogger(__name__)

_USER_AGENT = "OyeChats-Bot/1.0 (+https://oyechats.com)"

_SKIP_EXTENSIONS = frozenset(
    {
        ".pdf",
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".svg",
        ".webp",
        ".ico",
        ".bmp",
        ".css",
        ".js",
        ".mjs",
        ".woff",
        ".woff2",
        ".ttf",
        ".eot",
        ".mp3",
        ".mp4",
        ".avi",
        ".mov",
        ".zip",
        ".gz",
        ".tar",
        ".rar",
        ".json",
        ".csv",
        ".xls",
        ".xlsx",
        ".doc",
        ".docx",
        # Feeds and machine-readable docs — these slipped through before and
        # showed up in the diff "new" bucket because the original crawler
        # never ingests them, so the URL was always going to look orphaned.
        ".xml",
        ".rss",
        ".atom",
        ".txt",
        ".yml",
        ".yaml",
    }
)

# Path-prefix skiplist: catches extensionless feed/sitemap URLs like
# ``/sitemap-0`` or ``/feed`` that the extension filter misses.
_SKIP_PATH_PREFIXES = ("/sitemap", "/feed", "/rss", "/atom", "/wp-json")

# WordPress (and similar CMS) shortlink query-only params that resolve to the
# same canonical post/page as another URL the crawler already has. Pages whose
# query string consists *only* of these keys are duplicates — keeping them
# makes the recrawl-diff hallucinate "new" pages every run.
_WP_SHORTLINK_PARAMS = frozenset({"p", "page_id", "attachment_id", "cat", "tag_id", "feed", "preview", "preview_id"})


def _is_wp_shortlink(url: str) -> bool:
    parsed = urlparse(url)
    # Shortlinks are always rooted at "/" (or empty) with the post id in the query.
    if parsed.path not in ("", "/"):
        return False
    if not parsed.query:
        return False
    try:
        params = parse_qs(parsed.query, keep_blank_values=True)
    except Exception:
        return False
    if not params:
        return False
    return all(k.lower() in _WP_SHORTLINK_PARAMS for k in params)


def _is_html_url(url: str) -> bool:
    """Return True if the URL path likely points to an HTML page (not a binary asset)."""
    if _is_wp_shortlink(url):
        return False
    path = urlparse(url).path.lower()
    for prefix in _SKIP_PATH_PREFIXES:
        if path.startswith(prefix):
            return False
    dot = path.rfind(".")
    if dot == -1:
        return True
    return path[dot:] not in _SKIP_EXTENSIONS


def _norm_netloc(netloc: str) -> str:
    return netloc.lower().removeprefix("www.")


async def discover_website_urls(
    seed_url: str,
    *,
    max_urls: int = 500,
    timeout: float = 20.0,
) -> list[str]:
    """Return up to *max_urls* content-page URLs found on the site.

    Hits the network asynchronously with aiohttp — safe to await from
    FastAPI's async event loop. Never spawns a subprocess or browser.

    Args:
        seed_url: Root URL to start discovery from (already validated for SSRF).
        max_urls:  Hard cap on the number of URLs returned. Callers pass the
                   plan's ``max_crawl_pages`` ceiling so we never overcount.
        timeout:   Wall-clock time budget for the whole discovery (seconds).

    Returns:
        Deduplicated list of URLs, shortest paths first.
    """
    import aiohttp

    parsed = urlparse(seed_url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    base_netloc = _norm_netloc(parsed.netloc)

    headers = {"User-Agent": _USER_AGENT}
    client_timeout = aiohttp.ClientTimeout(total=timeout, connect=8, sock_read=12)

    async with aiohttp.ClientSession(headers=headers, timeout=client_timeout) as session:
        # ── Step 1: robots.txt → find declared Sitemap URLs ──────────────────
        sitemap_seeds: list[str] = []
        try:
            async with session.get(f"{base}/robots.txt", allow_redirects=True, ssl=False) as r:
                if r.status == 200:
                    text = await r.text(errors="replace")
                    for line in text.splitlines():
                        if line.lower().startswith("sitemap:"):
                            s = line[8:].strip()
                            if s:
                                sitemap_seeds.append(s)
        except Exception:
            pass

        # Fallback: try the two most common standard locations
        if not sitemap_seeds:
            sitemap_seeds = [
                f"{base}/sitemap.xml",
                f"{base}/sitemap_index.xml",
            ]

        # ── Step 2: parse sitemaps (one level of index recursion) ────────────
        page_urls: list[str] = []
        seen_pages: set[str] = set()
        fetched_maps: set[str] = set()

        async def _parse_sitemap(url: str, depth: int) -> None:
            if url in fetched_maps or depth > 2 or len(page_urls) >= max_urls:
                return
            fetched_maps.add(url)
            try:
                async with session.get(url, allow_redirects=True, ssl=False) as r:
                    if r.status != 200:
                        return
                    raw = await r.text(errors="replace")
            except Exception:
                return

            is_index = "<sitemapindex" in raw.lower()
            locs = re.findall(r"<loc>\s*(https?://[^\s<]+)\s*</loc>", raw)

            for loc in locs:
                loc = loc.strip()
                if is_index:
                    await _parse_sitemap(loc, depth + 1)
                else:
                    loc_netloc = _norm_netloc(urlparse(loc).netloc)
                    if loc_netloc == base_netloc and _is_html_url(loc) and loc not in seen_pages:
                        seen_pages.add(loc)
                        page_urls.append(loc)
                        if len(page_urls) >= max_urls:
                            return

        for s in sitemap_seeds[:4]:
            if len(page_urls) >= max_urls:
                break
            await _parse_sitemap(s, depth=0)

        # ── Step 3: BFS pass — always scan seed page for links not in sitemap ──
        # Even when the sitemap is populated we do a shallow scan of the seed
        # page so we catch pages that are linked from the homepage but missing
        # from the sitemap (common on WordPress / theme nav menus).
        # Always include the seed URL itself
        if seed_url not in seen_pages:
            seen_pages.add(seed_url)
            page_urls.insert(0, seed_url)

        async def _scan_page_links(page_url: str) -> list[str]:
            """Fetch *page_url* and return any new same-domain HTML links."""
            found: list[str] = []
            if len(page_urls) >= max_urls:
                return found
            try:
                async with session.get(page_url, allow_redirects=True, ssl=False) as r:
                    if r.status != 200:
                        return found
                    html = await r.text(errors="replace")
                    # Capture absolute and root-relative hrefs from anchor tags
                    # only. ``<link rel="shortlink" href="?p=51">`` and similar
                    # ``<link>`` / ``<area>`` / ``<base>`` elements were being
                    # slurped before and surfaced as bogus "new" pages
                    # (WordPress shortlinks, RSS alternates, canonical hints).
                    # Query strings are preserved (only fragments stripped) so
                    # a link like ``/contact?intent=enterprise`` matches what
                    # the real crawler stored.
                    hrefs = re.findall(
                        r"""<a\b[^>]*?\shref=['"]((?:https?://|/)[^'"#]+)['"]""",
                        html,
                        flags=re.IGNORECASE,
                    )
                    for href in hrefs:
                        href = href.strip()
                        if not href:
                            continue
                        if href.startswith("/"):
                            href = f"{base}{href}"
                        if _norm_netloc(urlparse(href).netloc) != base_netloc:
                            continue
                        if not _is_html_url(href):
                            continue
                        if href not in seen_pages:
                            seen_pages.add(href)
                            page_urls.append(href)
                            found.append(href)
                            if len(page_urls) >= max_urls:
                                return found
            except Exception as exc:
                logger.debug("Link scan failed for %s: %s", page_url, exc)
            return found

        # ── Step 3: BFS scan from the seed page, up to depth 2 ────────────
        # The previous shallow scan (seed page + 5 sample sitemap pages) missed
        # pages reachable in 2+ clicks but absent from the sitemap, which made
        # the recrawl-diff falsely report those pages as "removed". A bounded
        # BFS catches more of what the real crawler will find without slipping
        # into a full Playwright run.
        _MAX_PAGES_SCANNED = 60  # hard ceiling so a large site can't blow the time budget
        _MAX_DEPTH = 2
        _BATCH_SIZE = 10

        scanned: set[str] = set()
        # Start the queue with the seed and (when sitemap returned content)
        # the first handful of sitemap children — same as the old behaviour
        # but feeds into a deeper scan instead of stopping there.
        queue: list[tuple[str, int]] = [(seed_url, 0)]
        for u in page_urls[1:6]:
            queue.append((u, 0))

        while queue and len(scanned) < _MAX_PAGES_SCANNED and len(page_urls) < max_urls:
            # Pull the next batch, skipping anything already scanned or past depth cap.
            batch: list[tuple[str, int]] = []
            while queue and len(batch) < _BATCH_SIZE:
                next_url, next_depth = queue.pop(0)
                if next_url in scanned or next_depth > _MAX_DEPTH:
                    continue
                scanned.add(next_url)
                batch.append((next_url, next_depth))
                if len(scanned) >= _MAX_PAGES_SCANNED:
                    break
            if not batch:
                continue
            results = await asyncio.gather(*[_scan_page_links(u) for u, _ in batch])
            for (_parent_url, parent_depth), new_links in zip(batch, results, strict=True):
                if parent_depth + 1 > _MAX_DEPTH:
                    continue
                for link in new_links:
                    if link not in scanned:
                        queue.append((link, parent_depth + 1))

        return page_urls[:max_urls]


async def check_urls_alive(
    urls: list[str],
    *,
    concurrency: int = 15,
    per_request_timeout: float = 8.0,
) -> dict[str, bool]:
    """Return ``{url: is_alive}`` for each input URL using HEAD (GET fallback).

    Used by the recrawl-diff endpoint to authoritatively decide whether a
    previously-stored URL is still on the site. Discovery alone cannot answer
    this: discovery is shallow and a deep-linked page may exist (and respond
    200) without being reachable via the seed page or sitemap.

    Liveness policy:
        * Confirmed gone (404, 410) → ``False``.
        * Anything else, including timeouts, 5xx, redirects, 405 (HEAD
          disallowed → retried as GET), and connection errors → ``True``
          ("not confirmed dead"). Conservative on purpose so a transient
          network blip or a bot-blocking firewall does not delete a customer's
          knowledge base.

    Concurrency is bounded so we do not hammer the customer's origin. Total
    wall-clock for *N* URLs is roughly ``ceil(N / concurrency) * per_request_timeout``
    in the worst case.
    """
    import aiohttp

    if not urls:
        return {}

    sem = asyncio.Semaphore(concurrency)
    timeout = aiohttp.ClientTimeout(total=per_request_timeout, connect=5, sock_read=6)
    headers = {"User-Agent": _USER_AGENT}
    results: dict[str, bool] = {}

    async with aiohttp.ClientSession(headers=headers, timeout=timeout) as session:

        async def _check(url: str) -> None:
            async with sem:
                # HEAD first — cheap and most servers support it. Fall back
                # to a tiny GET if HEAD is rejected with 405 / 403 so we
                # don't incorrectly flag the page as alive when it might
                # actually be 404 via GET.
                try:
                    async with session.head(url, allow_redirects=True, ssl=False) as r:
                        if r.status in (404, 410):
                            results[url] = False
                            return
                        if r.status < 400:
                            results[url] = True
                            return
                except Exception:
                    pass
                try:
                    async with session.get(url, allow_redirects=True, ssl=False) as r:
                        results[url] = r.status not in (404, 410)
                except Exception:
                    # Network error — keep the URL (conservative).
                    results[url] = True

        await asyncio.gather(*[_check(u) for u in urls])

    return results
