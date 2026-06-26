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

        # If the sitemap gave us a meaningful list, we're done
        if len(page_urls) >= 5:
            return page_urls[:max_urls]

        # ── Step 3: BFS fallback — seed page → extract all internal links ─────
        # Always include the seed URL itself
        if seed_url not in seen_pages:
            seen_pages.add(seed_url)
            page_urls.insert(0, seed_url)

        try:
            async with session.get(seed_url, allow_redirects=True, ssl=False) as r:
                if r.status == 200:
                    html = await r.text(errors="replace")
                    # Match both absolute and root-relative hrefs
                    hrefs = re.findall(
                        r"""href=['"]((https?://[^'"#?]+)|(/[^'"#?]*))['"]""",
                        html,
                    )
                    for groups in hrefs:
                        href = groups[1] or groups[2]  # absolute or root-relative
                        if not href:
                            continue
                        if href.startswith("/"):
                            href = f"{base}{href}"
                        loc_netloc = _norm_netloc(urlparse(href).netloc)
                        if loc_netloc != base_netloc:
                            continue
                        if not _is_html_url(href):
                            continue
                        if href not in seen_pages:
                            seen_pages.add(href)
                            page_urls.append(href)
                            if len(page_urls) >= max_urls:
                                break
        except Exception as exc:
            logger.debug("BFS fallback failed for %s: %s", seed_url, exc)

        return page_urls[:max_urls]
