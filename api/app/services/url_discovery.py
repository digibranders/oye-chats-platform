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
"""

import logging
import re
from urllib.parse import urlparse

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
    }
)


def _is_html_url(url: str) -> bool:
    """Return True if the URL path likely points to an HTML page (not a binary asset)."""
    path = urlparse(url).path.lower()
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

        async def _scan_page_links(page_url: str) -> None:
            """Fetch *page_url* and add any new same-domain HTML links to page_urls."""
            if len(page_urls) >= max_urls:
                return
            try:
                async with session.get(page_url, allow_redirects=True, ssl=False) as r:
                    if r.status != 200:
                        return
                    html = await r.text(errors="replace")
                    hrefs = re.findall(
                        r"""href=['"]((https?://[^'"#?]+)|(/[^'"#?]*))['"]""",
                        html,
                    )
                    for groups in hrefs:
                        href = groups[1] or groups[2]
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
                            if len(page_urls) >= max_urls:
                                return
            except Exception as exc:
                logger.debug("Link scan failed for %s: %s", page_url, exc)

        # Scan the seed page for any homepage-linked pages missing from the sitemap
        if seed_url not in seen_pages:
            seen_pages.add(seed_url)
            page_urls.insert(0, seed_url)
        await _scan_page_links(seed_url)

        # If sitemap had results, also do a shallow scan of up to 5 sitemap pages
        # to catch pages they link to that the sitemap omitted.
        if len(page_urls) > 1:
            import asyncio

            sample = [u for u in page_urls[1:6]]
            await asyncio.gather(*[_scan_page_links(u) for u in sample])

        return page_urls[:max_urls]
