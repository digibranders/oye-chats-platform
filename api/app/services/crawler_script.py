import asyncio
import heapq
import ipaddress
import json
import os
import re
import socket
import sys
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
from urllib.robotparser import RobotFileParser

import aiohttp
import html2text
from defusedxml.ElementTree import fromstring as safe_xml_fromstring

# Force stdin, stdout, stderr to use UTF-8 safely
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Force Windows Proactor Policy
if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

# ---------------------------------------------------------------------------
# URL filtering constants
# ---------------------------------------------------------------------------

SKIP_EXTENSIONS: frozenset[str] = frozenset(
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
        ".tiff",
        ".css",
        ".js",
        ".mjs",
        ".woff",
        ".woff2",
        ".ttf",
        ".eot",
        ".otf",
        ".mp3",
        ".mp4",
        ".avi",
        ".mov",
        ".wmv",
        ".flv",
        ".webm",
        ".ogg",
        ".wav",
        ".zip",
        ".gz",
        ".tar",
        ".rar",
        ".7z",
        ".exe",
        ".dmg",
        ".msi",
        ".deb",
        ".rpm",
        ".xml",
        ".json",
        ".csv",
        ".xls",
        ".xlsx",
        ".doc",
        ".docx",
        ".ppt",
        ".pptx",
    }
)

TRACKING_PARAMS: frozenset[str] = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "fbclid",
        "gclid",
        "msclkid",
        "_ga",
        "_gl",
        "_hsenc",
        "_hsmi",
        "mc_cid",
        "mc_eid",
        "ref",
        "source",
    }
)

_HTTP_USER_AGENT = "OyeChats-Bot/1.0 (+https://oyechats.com)"

# Scroll preamble — dispatches scroll events to wake Intersection Observers
# and trigger lazy-loaded React/Next.js components before link extraction.
# Synchronous scrollTo calls are intentional: they fire scroll events
# synchronously, which is enough to mark IO entries as "intersecting" so
# React can schedule their render on the next frame.
_JS_SCROLL_PREAMBLE: str = """
(function () {
    var total = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    var step = Math.ceil(total / 6) || 300;
    for (var i = 1; i <= 6; i++) {
        window.scrollTo(0, step * i);
    }
    window.scrollTo(0, total);
})();
"""


def _is_spa(html: str) -> bool:
    """Return True if the page is a Next.js / Nuxt / Angular / Gatsby SPA.

    Checked against common fingerprints injected into the HTML at build time.
    """
    markers = ("__NEXT_DATA__", "/_next/", "__NUXT__", "window.__nuxt__", "ng-version=", "__gatsby")
    return any(m in html for m in markers)


# ---------------------------------------------------------------------------
# URL normalization & filtering
# ---------------------------------------------------------------------------


def normalize_url(url: str) -> str:
    """Normalize a URL for deduplication.

    - Lowercases scheme and netloc
    - Strips ``www.`` prefix
    - Removes default ports (:80, :443)
    - Removes fragments
    - Strips trailing ``/``
    - Drops tracking query parameters and sorts the remainder
    """
    parsed = urlparse(url)

    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower().removeprefix("www.")

    # Strip default ports
    if netloc.endswith(":80") and scheme == "http":
        netloc = netloc[:-3]
    elif netloc.endswith(":443") and scheme == "https":
        netloc = netloc[:-4]

    # Normalize path (collapse double slashes, remove trailing /)
    path = re.sub(r"/+", "/", parsed.path).rstrip("/") or "/"

    # Remove index.html / index.htm from path tail
    if path.endswith(("/index.html", "/index.htm")):
        path = path.rsplit("/", 1)[0] or "/"

    # Strip tracking params, sort remaining
    params = parse_qs(parsed.query, keep_blank_values=True)
    clean_params = {k: v for k, v in params.items() if k.lower() not in TRACKING_PARAMS}
    sorted_query = urlencode(clean_params, doseq=True) if clean_params else ""

    return urlunparse((scheme, netloc, path, "", sorted_query, ""))


def get_base_domain(netloc: str) -> str:
    """Return a comparable base domain (lowercase, no www. prefix)."""
    return netloc.lower().removeprefix("www.")


def should_skip_url(url: str) -> bool:
    """Return True if *url* points to a non-HTML resource based on extension."""
    path = urlparse(url).path.lower()
    # Get the last segment's extension
    dot_pos = path.rfind(".")
    if dot_pos == -1:
        return False
    ext = path[dot_pos:]
    return ext in SKIP_EXTENSIONS


def url_priority(depth: int, *, from_sitemap: bool = False) -> int:
    """Lower number = higher priority (crawled first).

    Priority ladder (lowest number wins):
      0 → seed URL (the customer's typed entry point, depth 0)
      1 → URLs the site owner curated in sitemap.xml

    BFS-discovered URLs are no longer pushed onto the queue, so the
    ladder only has two rungs in practice. The ``depth`` parameter is
    retained for caller compatibility and audit logging; any value
    other than 0 with ``from_sitemap=False`` is unreachable through the
    current crawl path.
    """
    if depth == 0:
        return 0
    if from_sitemap:
        return 1
    return depth + 1


def is_html_content(html: str) -> bool:
    """Heuristic check: does the content look like an HTML page?"""
    if not html:
        return False
    snippet = html[:1000].lower()
    return any(marker in snippet for marker in ("<!doctype", "<html", "<head", "<body"))


# ---------------------------------------------------------------------------
# HTML → Markdown & link extraction (lightweight, no browser)
# ---------------------------------------------------------------------------


def _make_html2text() -> html2text.HTML2Text:
    """Create a configured HTML → Markdown converter."""
    h = html2text.HTML2Text()
    h.ignore_links = False
    h.ignore_images = True
    h.ignore_emphasis = False
    h.body_width = 0  # No wrapping
    h.skip_internal_links = False
    return h


# ---------------------------------------------------------------------------
# robots.txt & sitemap helpers
# ---------------------------------------------------------------------------


def _disallow_all_parser() -> RobotFileParser:
    """Return a robots parser configured as ``Disallow: /``.

    Used when ``robots.txt`` is auth-gated (401/403) — per RFC 9309 the safe
    interpretation is "fully disallowed" rather than "no rules", because the
    site has explicitly indicated unauthenticated agents should not access
    its content.
    """
    rp = RobotFileParser()
    rp.parse(["User-agent: *", "Disallow: /"])
    return rp


async def fetch_robots_txt(base_url: str) -> RobotFileParser | None:
    """Fetch and parse robots.txt for *base_url*.

    Returns:
        * Parsed rules on HTTP 200
        * A ``Disallow: /`` parser on HTTP 401/403 (per RFC 9309 — auth-gated
          robots means "not allowed")
        * ``None`` on 404 / 5xx / network errors — caller treats as "no rules"

    SSRF-hardened: rejects private/internal hosts and disables redirect
    following so a 301 to an internal address cannot leak metadata.
    """
    try:
        parsed = urlparse(base_url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"

        if not _is_url_safe(robots_url):
            return None

        async with (
            aiohttp.ClientSession() as session,
            session.get(
                robots_url,
                timeout=aiohttp.ClientTimeout(total=10),
                allow_redirects=False,
            ) as resp,
        ):
            if resp.status in (401, 403):
                # RFC 9309: auth-gated robots.txt means the site does not
                # grant unauthenticated crawl access — treat as fully
                # disallowed instead of silently crawling everything.
                return _disallow_all_parser()
            if resp.status != 200:
                return None
            text = await resp.text()

        rp = RobotFileParser()
        rp.parse(text.splitlines())
        return rp
    except Exception:
        return None


def _looks_like_sitemap(url: str) -> bool:
    """Heuristic: does this URL point to a sitemap rather than a content page?

    Triggers sitemap-seed mode when the customer pastes their sitemap URL
    directly into the crawler (e.g. ``https://example.com/sitemap.xml``).
    Treats any URL whose path ends in ``.xml`` *or* contains ``/sitemap`` as
    a sitemap. False positives (e.g. a content page that happens to live at
    ``/sitemap-howto``) are rare and at worst skip the Chromium color phase
    on one page — the BFS still proceeds normally.
    """
    path = urlparse(url).path.lower()
    if not path:
        return False
    if path.endswith(".xml"):
        return True
    return "/sitemap" in path and not path.endswith("/")


async def fetch_sitemap_urls(
    base_url: str,
    robot_parser: RobotFileParser | None,
    *,
    max_sitemaps: int = 10,
    extra_seeds: list[str] | None = None,
    cancel_file: str | None = None,
) -> list[str]:
    """Discover URLs from sitemap.xml (and robots.txt Sitemap directives).

    Handles sitemap index files with a depth limit to prevent unbounded expansion.
    At most *max_sitemaps* sitemap files are fetched.

    ``extra_seeds`` lets the caller force-add sitemap URLs that wouldn't be
    discovered automatically — used by sitemap-seed mode so a customer-supplied
    custom sitemap path (e.g. ``/sitemap_pages.xml``) is parsed even when
    ``robots.txt`` doesn't advertise it and it isn't at the standard location.
    """
    sitemap_queue: list[str] = []
    seen_sitemaps: set[str] = set()

    def enqueue_sitemap(url: str) -> None:
        if url not in seen_sitemaps and len(seen_sitemaps) < max_sitemaps:
            seen_sitemaps.add(url)
            sitemap_queue.append(url)

    # 0. Caller-supplied sitemap URLs come first so they're never crowded out
    #    by the auto-probed standard location when ``max_sitemaps`` is tight.
    if extra_seeds:
        for s in extra_seeds:
            enqueue_sitemap(s)

    # 1. Check robots.txt for Sitemap directives
    if robot_parser and hasattr(robot_parser, "site_maps") and callable(robot_parser.site_maps):
        sitemaps = robot_parser.site_maps()
        if sitemaps:
            for s in sitemaps:
                enqueue_sitemap(s)

    # 2. Always try the standard location
    parsed = urlparse(base_url)
    standard_sitemap = f"{parsed.scheme}://{parsed.netloc}/sitemap.xml"
    enqueue_sitemap(standard_sitemap)

    discovered: list[str] = []
    idx = 0

    async with aiohttp.ClientSession() as session:
        while idx < len(sitemap_queue) and idx < max_sitemaps:
            if _is_cancelled(cancel_file):
                break
            sitemap_url = sitemap_queue[idx]
            idx += 1
            # SSRF guard: sitemap URLs can come from attacker-controlled robots.txt
            # or sitemap-index files. Reject any that resolve to private/internal
            # addresses before fetching.
            if not _is_url_safe(sitemap_url):
                continue
            try:
                async with session.get(
                    sitemap_url,
                    timeout=aiohttp.ClientTimeout(total=10),
                    allow_redirects=False,
                ) as resp:
                    if resp.status != 200:
                        continue
                    content = await resp.text()

                root = safe_xml_fromstring(content)
                ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

                # Check if it's a sitemap index
                sub_sitemaps = root.findall(".//sm:sitemap/sm:loc", ns)
                if sub_sitemaps:
                    for loc_el in sub_sitemaps[:5]:
                        if loc_el.text:
                            enqueue_sitemap(loc_el.text.strip())
                    continue

                # Regular urlset — extract <loc> entries
                for loc_el in root.findall(".//sm:loc", ns):
                    if loc_el.text:
                        discovered.append(loc_el.text.strip())
            except Exception:
                continue

    return discovered


# ---------------------------------------------------------------------------
# Color extraction helpers
# ---------------------------------------------------------------------------


def rgb_to_hex(r: float, g: float, b: float) -> str:
    """Convert RGB values to hex color string."""
    return f"#{int(r):02x}{int(g):02x}{int(b):02x}"


def hex_to_hsl(hex_color: str) -> tuple[float, float]:
    """Convert hex color to (saturation%, lightness%) tuple."""
    hex_color = hex_color.lstrip("#")
    if len(hex_color) == 3:
        hex_color = "".join(c * 2 for c in hex_color)
    r, g, b = int(hex_color[0:2], 16) / 255, int(hex_color[2:4], 16) / 255, int(hex_color[4:6], 16) / 255
    mx, mn = max(r, g, b), min(r, g, b)
    lightness = (mx + mn) / 2
    if mx == mn:
        s = 0.0
    else:
        d = mx - mn
        s = d / (2 - mx - mn) if lightness > 0.5 else d / (mx + mn)
    return s * 100, lightness * 100


def is_brand_worthy(hex_color: str) -> bool:
    """Check if a color is likely a brand color (not white/black/gray)."""
    try:
        s, lightness = hex_to_hsl(hex_color)
        if lightness > 95 or lightness < 5:
            return False
        return not (s < 5 and 20 < lightness < 80)
    except Exception:
        return False


def extract_colors_from_html(html_content: str) -> list[str]:
    """Python-based fallback: extract brand colors directly from HTML/CSS."""
    scores: dict[str, float] = {}

    def add_color(hex_color: str, weight: float) -> None:
        hex_color = hex_color.lower().strip()
        if len(hex_color) == 4:
            hex_color = "#" + "".join(c * 2 for c in hex_color[1:])
        if len(hex_color) != 7 or not hex_color.startswith("#"):
            return
        if not is_brand_worthy(hex_color):
            return
        scores[hex_color] = scores.get(hex_color, 0) + weight

    def parse_rgb(match_str: str) -> str | None:
        nums = re.findall(r"[\d.]+", match_str)
        if len(nums) >= 3:
            try:
                return rgb_to_hex(float(nums[0]), float(nums[1]), float(nums[2]))
            except Exception:
                pass
        return None

    # 1. All hex colors
    hex_colors = re.findall(r"#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b", html_content)
    for c in hex_colors:
        add_color(c, 1)

    # 2. rgb/rgba colors
    rgb_matches = re.findall(r"rgba?\s*\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\)", html_content)
    for m in rgb_matches:
        hex_c = parse_rgb(m)
        if hex_c:
            add_color(hex_c, 1)

    # 3. Brand-related CSS variables (higher weight)
    style_blocks = re.findall(r"<style[^>]*>(.*?)</style>", html_content, re.DOTALL | re.IGNORECASE)
    style_content = " ".join(style_blocks)

    css_var_colors = re.findall(
        r"--[\w-]*(?:primary|brand|accent|theme|main|color)[\w-]*\s*:\s*(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b)",
        style_content,
        re.IGNORECASE,
    )
    for c in css_var_colors:
        add_color(c, 10)

    css_var_rgb = re.findall(
        r"--[\w-]*(?:primary|brand|accent|theme|main|color)[\w-]*\s*:\s*(rgba?\s*\([^)]+\))",
        style_content,
        re.IGNORECASE,
    )
    for m in css_var_rgb:
        hex_c = parse_rgb(m)
        if hex_c:
            add_color(hex_c, 10)

    # 4. Colors in brand-related HTML elements
    brand_patterns: list[tuple[str, int]] = [
        (r"<(?:header|nav)[^>]*(?:style|class)[^>]*>.*?</(?:header|nav)>", 8),
        (r"<(?:button|a)[^>]*(?:style|class)[^>]*>.*?</(?:button|a)>", 7),
        (
            r'class="[^"]*(?:brand|logo|accent|primary|cta|hero|banner)[^"]*"[^>]*style="[^"]*(?:background|color)\s*:\s*([^;"]+)',
            9,
        ),
    ]
    for pattern, weight in brand_patterns:
        matches = re.findall(pattern, html_content, re.DOTALL | re.IGNORECASE)
        for match_text in matches:
            block = match_text if isinstance(match_text, str) else str(match_text)
            block_hex = re.findall(r"#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b", block)
            for c in block_hex:
                add_color(c, weight)
            block_rgb = re.findall(r"rgba?\s*\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\)", block)
            for m in block_rgb:
                hex_c = parse_rgb(m)
                if hex_c:
                    add_color(hex_c, weight)

    # 5. background-color and color properties
    bg_colors = re.findall(
        r"background(?:-color)?\s*:\s*(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b)", style_content, re.IGNORECASE
    )
    for c in bg_colors:
        add_color(c, 5)

    fg_colors = re.findall(
        r"(?<!background-)color\s*:\s*(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b)", style_content, re.IGNORECASE
    )
    for c in fg_colors:
        add_color(c, 3)

    sorted_colors = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [c for c, _ in sorted_colors[:6]]


# ---------------------------------------------------------------------------
# SSRF protection for redirect targets
# ---------------------------------------------------------------------------


def _is_url_safe(url: str) -> bool:
    """Return False if *url* resolves to a private/internal/loopback address.

    Used to validate the final URL after HTTP redirects so that an attacker
    cannot redirect the crawler to internal services (e.g. cloud metadata at
    169.254.169.254 or localhost).
    """
    hostname = urlparse(str(url)).hostname
    if not hostname:
        return False

    # Check literal IP addresses first
    try:
        ip = ipaddress.ip_address(hostname)
        return not (ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local)
    except ValueError:
        pass

    # Hostname — resolve DNS and verify every address is public
    try:
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
        if not infos:
            return False
        for info in infos:
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
                return False
        return True
    except socket.gaierror:
        return False


# ---------------------------------------------------------------------------
# Lightweight HTTP crawl (depths 1+)
# ---------------------------------------------------------------------------


class _RetryableStatus(Exception):
    """Marker exception raised when an HTTP 5xx warrants a retry.

    Lets ``crawl_single_http`` reuse its existing ``except Exception`` retry
    path without duplicating the sleep/loop scaffolding.
    """

    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status


async def crawl_single_http(
    http_session: aiohttp.ClientSession,
    url: str,
    depth: int,
    semaphore: asyncio.Semaphore,
    page_timeout: int,
    h2t: html2text.HTML2Text,
) -> dict:
    """Crawl a single URL using plain HTTP (no browser).

    Used for all pages except the seed URL (depth 0) which requires
    Chromium for JS-based color extraction.  Memory cost: ~5 MB per
    concurrent request vs ~200 MB per Chromium tab.
    """
    for attempt in range(2):
        async with semaphore:
            try:
                timeout = aiohttp.ClientTimeout(
                    total=page_timeout if attempt == 0 else int(page_timeout * 1.5),
                )
                async with http_session.get(url, timeout=timeout, allow_redirects=True) as resp:
                    # SSRF guard: validate the final URL after redirects to
                    # block redirects to internal/private addresses.
                    final_url = str(resp.url)
                    if final_url != url and not _is_url_safe(final_url):
                        return {
                            "url": url,
                            "depth": depth,
                            "html": None,
                            "markdown": None,
                            "error": "redirect to internal address blocked (SSRF protection)",
                        }

                    # Retry policy by status class:
                    #   2xx → process (continues below)
                    #   5xx → transient (server overloaded, e.g. 503). Retry
                    #         once; without this a single traffic spike on
                    #         the customer's site silently drops pages.
                    #   any other non-200 (3xx after disabled redirects, 4xx)
                    #         → permanent. Return immediately, no retry.
                    if 500 <= resp.status < 600:
                        if attempt == 1:
                            return {
                                "url": url,
                                "depth": depth,
                                "html": None,
                                "markdown": None,
                                "error": f"HTTP {resp.status}",
                            }
                        # Fall through to the post-`async with` sleep + retry.
                        raise _RetryableStatus(resp.status)
                    if resp.status != 200:
                        return {
                            "url": url,
                            "depth": depth,
                            "html": None,
                            "markdown": None,
                            "error": f"HTTP {resp.status}",
                        }

                    content_type = resp.headers.get("Content-Type", "")
                    if "text/html" not in content_type and "application/xhtml" not in content_type:
                        return {"url": url, "depth": depth, "html": None, "markdown": None, "error": "not HTML"}

                    raw_html = await resp.text()

                    if not is_html_content(raw_html):
                        return {"url": url, "depth": depth, "html": None, "markdown": None, "error": "not HTML content"}

                    # Trafilatura: ML-based boilerplate removal (0.883 F1).
                    # Falls back to html2text if trafilatura returns nothing.
                    #
                    # ``include_formatting=True`` preserves <li>/<ul> structure
                    # as proper markdown bullets — without it, list items are
                    # flattened into prose joined by inline " - " separators,
                    # which the LLM then echoes verbatim and produces unreadable
                    # answers for list-shaped content (events, services, etc).
                    markdown = None
                    try:
                        import trafilatura

                        markdown = trafilatura.extract(
                            raw_html,
                            url=url,
                            include_comments=False,
                            include_tables=True,
                            include_formatting=True,
                            include_links=True,
                            output_format="markdown",
                        )
                    except Exception:
                        pass
                    if not markdown or not markdown.strip():
                        markdown = h2t.handle(raw_html)

                    # Treat whitespace-only extraction as a content failure so
                    # the caller's "if not markdown" guard correctly skips the page
                    # rather than storing empty chunks.
                    if markdown and not markdown.strip():
                        markdown = None

                    return {"url": url, "depth": depth, "html": raw_html, "markdown": markdown, "error": None}
            except TimeoutError:
                if attempt == 1:
                    return {"url": url, "depth": depth, "html": None, "markdown": None, "error": "timeout"}
            except Exception as e:
                if attempt == 1:
                    return {"url": url, "depth": depth, "html": None, "markdown": None, "error": str(e)}
        # Sleep outside the semaphore so other tasks can proceed
        if attempt == 0:
            await asyncio.sleep(1)

    return {"url": url, "depth": depth, "html": None, "markdown": None, "error": "max retries exceeded"}


async def _crawl_http_with_info(
    info: dict,
    http_session: aiohttp.ClientSession,
    url: str,
    depth: int,
    semaphore: asyncio.Semaphore,
    page_timeout: int,
    h2t: html2text.HTML2Text,
) -> tuple[dict, dict]:
    """Run ``crawl_single_http`` and return ``(info, result)`` together.

    ``asyncio.as_completed`` yields tasks in completion order, not submission
    order — without bundling the originating ``info`` into the awaited value,
    the consumer would have to maintain a separate id→info map. This wrapper
    keeps the call site straightforward: one coroutine in, one tagged result
    out.
    """
    result = await crawl_single_http(http_session, url, depth, semaphore, page_timeout, h2t)
    return info, result


# ---------------------------------------------------------------------------
# JS color extraction code (injected into Chromium on depth-0 only)
# ---------------------------------------------------------------------------

_JS_COLOR_EXTRACTION = """
(() => {
    function rgbToHex(rgb) {
        if (!rgb) return null;
        const m = rgb.match(/\\d+/g);
        if (!m || m.length < 3) return null;
        return "#" + m.slice(0, 3).map(x => {
            const h = parseInt(x).toString(16);
            return h.length === 1 ? "0" + h : h;
        }).join("");
    }

    function hexToHSL(hex) {
        let r = parseInt(hex.slice(1,3), 16) / 255;
        let g = parseInt(hex.slice(3,5), 16) / 255;
        let b = parseInt(hex.slice(5,7), 16) / 255;
        const max = Math.max(r,g,b), min = Math.min(r,g,b);
        let h, s, l = (max + min) / 2;
        if (max === min) { h = s = 0; }
        else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
            else if (max === g) h = ((b - r) / d + 2) / 6;
            else h = ((r - g) / d + 4) / 6;
        }
        return { h: h * 360, s: s * 100, l: l * 100 };
    }

    function isBrandWorthy(hex) {
        const { s, l } = hexToHSL(hex);
        if (l > 95 || l < 5) return false;
        if (s < 5 && l > 20 && l < 80) return false;
        return true;
    }

    const scores = {};
    function addColor(rgb, weight) {
        const hex = rgbToHex(rgb);
        if (!hex || !isBrandWorthy(hex)) return;
        const key = hex.toLowerCase();
        scores[key] = (scores[key] || 0) + weight;
    }

    try {
        const rootStyles = getComputedStyle(document.documentElement);
        const sheets = document.styleSheets;
        const varNames = [];
        for (const sheet of sheets) {
            try {
                for (const rule of sheet.cssRules || []) {
                    const text = rule.cssText || "";
                    const vars = text.match(/--[\\w-]*(primary|brand|accent|theme|main|color)[\\w-]*/gi);
                    if (vars) varNames.push(...vars);
                }
            } catch(e) {}
        }
        for (const v of [...new Set(varNames)]) {
            const val = rootStyles.getPropertyValue(v).trim();
            if (val && val.match(/^(#|rgb)/)) addColor(val.startsWith("#") ? val : val, 10);
        }
    } catch(e) {}

    const brandSelectors = [
        { sel: "header, nav, [class*='header'], [class*='nav'], [class*='topbar']", w: 8 },
        { sel: "a, button, [class*='btn'], [class*='button'], [class*='cta']", w: 7 },
        { sel: "[class*='brand'], [class*='logo'], [class*='accent'], [class*='primary']", w: 9 },
        { sel: "footer, [class*='footer']", w: 5 },
        { sel: "h1, h2, h3", w: 4 },
        { sel: "[class*='hero'], [class*='banner'], [class*='jumbotron']", w: 6 }
    ];

    for (const { sel, w } of brandSelectors) {
        try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                const cs = getComputedStyle(el);
                const bg = cs.backgroundColor;
                const fg = cs.color;
                const border = cs.borderColor;
                if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") addColor(bg, w);
                if (fg && fg !== "rgba(0, 0, 0, 0)" && fg !== "transparent") addColor(fg, w - 1);
                if (border && border !== "rgba(0, 0, 0, 0)" && border !== "transparent") addColor(border, w - 2);
            }
        } catch(e) {}
    }

    const all = document.querySelectorAll("*");
    for (let i = 0; i < all.length; i += 5) {
        const cs = getComputedStyle(all[i]);
        const bg = cs.backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") addColor(bg, 1);
    }

    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, 6).map(e => e[0]);
})();
"""


# ---------------------------------------------------------------------------
# Seed page crawl via crawl4ai (Chromium, depth-0 only)
# ---------------------------------------------------------------------------


async def _crawl_seed_with_browser(
    url: str,
    page_timeout: int,
) -> dict:
    """Crawl the seed URL using Chromium for JS color extraction.

    The browser is created, used for a single page, and then destroyed
    when the ``async with`` block exits — freeing ~400-500 MB.
    """
    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig
    except ImportError:
        print(json.dumps({"log": "crawl4ai not available, falling back to HTTP for seed"}))
        return {"result": None, "error": "crawl4ai not installed"}

    browser_config = BrowserConfig(
        verbose=False,
        memory_saving_mode=True,
        light_mode=True,
        text_mode=False,  # Need CSS for color extraction
    )
    run_config = CrawlerRunConfig(
        wait_until="domcontentloaded",
        screenshot=False,
        pdf=False,
        exclude_all_images=True,
        # Scroll first to trigger Intersection Observers / lazy components,
        # then extract brand colors.  Two IIFEs: first returns undefined
        # (discarded), second returns the colors array (captured).
        js_code=_JS_SCROLL_PREAMBLE + _JS_COLOR_EXTRACTION,
    )

    try:
        async with AsyncWebCrawler(config=browser_config) as crawler:
            result = await asyncio.wait_for(
                crawler.arun(url=url, config=run_config),
                timeout=page_timeout,
            )
            # crawl4ai may return a list; unwrap if needed
            if isinstance(result, list):
                result = result[0] if result else None
            return {"result": result, "error": None}
    except TimeoutError:
        return {"result": None, "error": "timeout"}
    except Exception as e:
        return {"result": None, "error": str(e)}


# ---------------------------------------------------------------------------
# Main recursive crawl
# ---------------------------------------------------------------------------


def _write_progress(path: str, results: list[dict]) -> None:
    """Atomically write discovered URLs to the progress file.

    Called after every successfully crawled page so the FastAPI process
    can read incremental progress while the subprocess is still running.
    """
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"urls": [r["url"] for r in results]}, f)
        os.replace(tmp, path)  # Atomic on POSIX; avoids partial reads
    except Exception:
        pass  # Progress is best-effort — never crash the crawler


def _is_cancelled(cancel_file: str | None) -> bool:
    """Cooperative cancel check.

    Returns True iff the parent process has touched ``cancel_file`` to ask us
    to stop. Cheap (single ``os.path.exists`` call) so we can call it between
    every URL without measurable overhead. Returns False on any I/O error so a
    flaky filesystem can't accidentally cancel a running crawl.
    """
    if not cancel_file:
        return False
    try:
        return os.path.exists(cancel_file)
    except OSError:
        return False


def _emit_cancelled(
    results: list[dict],
    extracted_colors: set[str],
    *,
    discovered_total: int = 0,
    queue_remaining: int = 0,
) -> None:
    """Print the JSON envelope with cancellation flag + partial results.

    Lets the parent ``crawler_service.crawl_website`` raise ``CrawlCancelled``
    with the partial payload so any pages already crawled can still be
    ingested — we never throw away crawled work just because the user clicked
    Cancel.

    ``discovered_total`` / ``queue_remaining`` let the orchestrator report
    how many URLs were found but never crawled, so the UI can show "we found
    N more URLs that didn't fit your plan's cap" instead of silently dropping
    them.
    """
    print(json.dumps({"log": f"Crawl cancelled by user after {len(results)} pages"}))
    print("---CRAWLER_JSON_OUTPUT---")
    print(
        json.dumps(
            {
                "results": results,
                "recommended_colors": list(extracted_colors),
                "cancelled": True,
                "discovered_total": discovered_total,
                "queue_remaining": queue_remaining,
            }
        )
    )


async def crawl_recursive(
    start_url: str,
    max_depth: int = 3,
    max_pages: int | None = None,
    progress_file: str | None = None,
    cancel_file: str | None = None,
) -> None:
    # Read config from env
    if max_pages is None:
        max_pages = int(os.getenv("MAX_CRAWL_PAGES", "50"))
    concurrency = int(os.getenv("CRAWL_CONCURRENCY", "3"))
    page_timeout = int(os.getenv("CRAWL_PAGE_TIMEOUT", "20"))

    max_depth = int(os.getenv("MAX_CRAWL_DEPTH", str(max_depth)))

    # SSRF guard: reject seed URLs that resolve to private/internal/loopback
    # addresses (e.g. 169.254.169.254 cloud metadata, 127.0.0.1, 10.0.0.0/8).
    # Without this check a customer could crawl internal services and ingest
    # their responses as RAG documents, then read them back via their bot.
    if not _is_url_safe(start_url):
        print(
            json.dumps(
                {
                    "log": f"Crawl rejected: {start_url} resolves to a private/internal address",
                    "error": "url_not_safe",
                }
            )
        )
        if progress_file:
            _write_progress(progress_file, [])
        return

    start_domain = get_base_domain(urlparse(start_url).netloc)
    visited: set[str] = set()
    enqueued: set[str] = set()  # URLs already in the priority queue (prevents duplicates)
    pages_crawled = 0  # Only counts actually-crawled pages (not robots-skipped)
    results: list[dict] = []
    extracted_colors: set[str] = set()

    # Counter for heapq tie-breaking (ensures stable ordering)
    counter = 0

    # Priority queue: (priority, counter, url, depth)
    pq: list[tuple[int, int, str, int]] = []

    # Raw HTML from seed page — used for SPA fingerprint detection after Phase 1
    _seed_html: str = ""

    def push_url(url: str, depth: int, *, from_sitemap: bool = False) -> None:
        nonlocal counter
        norm = normalize_url(url)
        if norm in visited or norm in enqueued:
            return
        if should_skip_url(url):
            return
        enqueued.add(norm)
        priority = url_priority(depth, from_sitemap=from_sitemap)
        heapq.heappush(pq, (priority, counter, url, depth))
        counter += 1

    print(
        json.dumps(
            {
                "log": f"Starting crawl on {start_url} (domain: {start_domain}, max_depth: {max_depth}, max_pages: {max_pages})"
            }
        )
    )

    # Sitemap-seed mode: when the customer pastes a sitemap URL as the seed
    # (e.g. https://example.com/sitemap.xml), don't try to render that XML
    # document with Chromium. Instead, parse it directly and queue its <loc>
    # entries as the crawl frontier. Pull in the site's homepage at priority 0
    # so Phase 1 can still extract brand colors from a real page. Sitemap URLs
    # arrive at priority 1 (``from_sitemap=True``) so the homepage runs first.
    sitemap_mode = _looks_like_sitemap(start_url)
    parsed_start = urlparse(start_url)
    if sitemap_mode:
        homepage_url = f"{parsed_start.scheme}://{parsed_start.netloc}/"
        print(
            json.dumps(
                {
                    "log": (
                        f"Sitemap-seed mode: {start_url} treated as sitemap. "
                        f"Using {homepage_url} for brand-color extraction; "
                        f"content frontier will come from the sitemap."
                    )
                }
            )
        )
        push_url(homepage_url, 0)
    else:
        # Seed the start URL first (always priority 0, depth 0). Must be
        # enqueued before sitemap URLs so it isn't silently dropped when the
        # sitemap contains the root URL (which is common).
        push_url(start_url, 0)

    # ---- Pre-crawl: robots.txt & sitemap ----
    robot_parser = await fetch_robots_txt(start_url)
    if robot_parser:
        print(json.dumps({"log": "robots.txt loaded"}))

    # In sitemap-seed mode, the customer-supplied URL is the authoritative
    # sitemap location — feed it through ``extra_seeds`` so the discovery
    # helper parses it even when robots.txt doesn't advertise it.
    extra_sitemap_seeds = [start_url] if sitemap_mode else None
    if _is_cancelled(cancel_file):
        print(json.dumps({"cancelled": True, "results": [], "recommended_colors": []}))
        return
    sitemap_urls = await fetch_sitemap_urls(
        start_url, robot_parser, extra_seeds=extra_sitemap_seeds, cancel_file=cancel_file
    )
    sitemap_seeded = 0
    # In sitemap-seed mode the URLs are explicitly curated by the site owner,
    # so we trust them as depth-0 entries (deeper than BFS depth-1 discoveries).
    # This also means the depth-budget never truncates them.
    sitemap_depth = 0 if sitemap_mode else 1
    for surl in sitemap_urls:
        parsed_surl = urlparse(surl)
        if (
            get_base_domain(parsed_surl.netloc) == start_domain
            and parsed_surl.scheme in ("http", "https")
            and not should_skip_url(surl)
        ):
            push_url(surl, sitemap_depth, from_sitemap=True)
            sitemap_seeded += 1
    if sitemap_seeded:
        mode_label = "sitemap-seed mode" if sitemap_mode else "sitemap"
        print(json.dumps({"log": f"Seeded {sitemap_seeded} URLs from {mode_label}"}))
    else:
        # Sitemap-only crawl with no sitemap available — the customer's
        # typed entry point is all we'll ingest. Surface this clearly so
        # they understand why the result is a single page rather than
        # the whole site.
        print(
            json.dumps(
                {
                    "log": (
                        f"No URLs found in robots.txt or {urlparse(start_url).scheme}://"
                        f"{urlparse(start_url).netloc}/sitemap.xml — crawling only the "
                        f"seed URL. Add a sitemap to your site to crawl more pages."
                    )
                }
            )
        )

    if _is_cancelled(cancel_file):
        print(json.dumps({"cancelled": True, "results": [], "recommended_colors": []}))
        return

    # ======================================================================
    # Phase 1: Crawl seed URL with Chromium (for JS color extraction)
    # The browser is destroyed after this phase, freeing ~400-500 MB.
    # ======================================================================

    if pq:
        _priority, _counter, seed_url, seed_depth = heapq.heappop(pq)
        norm_seed = normalize_url(seed_url)

        # Respect robots.txt
        if robot_parser and not robot_parser.can_fetch("*", seed_url):
            print(json.dumps({"log": f"Skipped (robots.txt): {seed_url}"}))
            visited.add(norm_seed)
        else:
            visited.add(norm_seed)
            print(json.dumps({"log": f"Phase 1: Crawling seed URL with browser: {seed_url}"}))

            seed_result = await _crawl_seed_with_browser(seed_url, page_timeout)

            if seed_result["error"]:
                print(json.dumps({"log": f"Browser crawl failed ({seed_result['error']}), trying HTTP fallback"}))
                # Fallback: try seed page via plain HTTP (no colors, but content still usable)
                h2t_fallback = _make_html2text()
                semaphore_fb = asyncio.Semaphore(1)
                async with aiohttp.ClientSession(headers={"User-Agent": _HTTP_USER_AGENT}) as fb_session:
                    fb_result = await crawl_single_http(
                        fb_session, seed_url, 0, semaphore_fb, page_timeout, h2t_fallback
                    )
                if not fb_result["error"] and fb_result["markdown"]:
                    pages_crawled += 1
                    results.append({"url": norm_seed, "content": fb_result["markdown"]})
                    # Try Python-based color extraction from HTML
                    if fb_result["html"]:
                        fallback_colors = extract_colors_from_html(fb_result["html"])
                        for c in fallback_colors:
                            extracted_colors.add(c.lower())
                    # No link discovery — crawl frontier is strictly
                    # ``{seed_url} ∪ sitemap`` per the sitemap-only contract.
            else:
                result = seed_result["result"]
                # Capture raw HTML for SPA fingerprint detection (used after Phase 1)
                _seed_html = (getattr(result, "html", "") or "") if result else ""
                if result and hasattr(result, "markdown") and result.markdown:
                    pages_crawled += 1
                    results.append({"url": norm_seed, "content": result.markdown})
                    if progress_file:
                        _write_progress(progress_file, results)

                    # Extract colors from JS execution
                    if hasattr(result, "js_execution_result") and result.js_execution_result:
                        js_result = result.js_execution_result
                        if isinstance(js_result, list):
                            for c in js_result:
                                if isinstance(c, str):
                                    extracted_colors.add(c.lower())
                        elif isinstance(js_result, dict):
                            for val in js_result.values():
                                if isinstance(val, str) and val.startswith("#"):
                                    extracted_colors.add(val.lower())
                                elif isinstance(val, list):
                                    for c in val:
                                        if isinstance(c, str):
                                            extracted_colors.add(c.lower())

                    # Python fallback for color extraction
                    if not extracted_colors and hasattr(result, "html") and result.html:
                        print(json.dumps({"log": "JS color extraction returned nothing, using Python HTML fallback"}))
                        fallback_colors = extract_colors_from_html(result.html)
                        for c in fallback_colors:
                            extracted_colors.add(c.lower())
                        if extracted_colors:
                            print(json.dumps({"log": f"Python fallback extracted {len(extracted_colors)} colors"}))

                    # No link discovery — crawl frontier is strictly
                    # ``{seed_url} ∪ sitemap`` per the sitemap-only contract.
                    # If the site owner wants more pages crawled, they add
                    # them to their sitemap; this used to fan out via the
                    # seed page's `<a href>` graph, which led to crawling
                    # unrelated /blog/* archives, paginated /tag/* views,
                    # and stale shortlink URLs.

    print(json.dumps({"log": f"Phase 1 complete. Browser destroyed. {pages_crawled} page(s), {len(pq)} URLs queued."}))

    # ======================================================================
    # Phase 2: Crawl remaining URLs
    # CRAWLER_JS_ALL_PAGES=true  → Playwright (sequential, 1 tab, browser recycled
    #                               every CRAWLER_BROWSER_RECYCLE pages).
    #                               Handles Next.js / React SPAs that need JS.
    # CRAWLER_JS_ALL_PAGES=false → Lightweight HTTP (concurrent, original behaviour).
    #                               ~5 MB per request vs ~200 MB per Chromium tab.
    # ======================================================================

    js_all_pages = os.getenv("CRAWLER_JS_ALL_PAGES", "false").lower() in ("1", "true", "yes")
    recycle_every = int(os.getenv("CRAWLER_BROWSER_RECYCLE", "10"))

    # Auto-detect Next.js / Nuxt / Angular SPAs from seed page HTML.
    # If detected and JS mode wasn't already requested, enable it automatically
    # so that client-side rendered links and lazy-loaded content are discovered.
    if not js_all_pages and _seed_html and _is_spa(_seed_html):
        print(json.dumps({"log": "[OyeChats] SPA detected — enabling JavaScript mode for all pages"}))
        js_all_pages = True

    # Check crawl4ai availability when JS mode is requested
    if js_all_pages:
        try:
            from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig
        except ImportError:
            js_all_pages = False
            print(json.dumps({"log": "crawl4ai not available for Phase 2, falling back to HTTP"}))

    if pq and pages_crawled < max_pages:
        if js_all_pages:
            # ------------------------------------------------------------------
            # Browser-based Phase 2 — sequential Playwright with browser recycling.
            # One Chromium tab at a time; browser restarted every recycle_every
            # pages to prevent memory creep on long crawls.
            # Per-page HTTP fallback when Playwright fails.
            # ------------------------------------------------------------------
            browser_config_p2 = BrowserConfig(  # type: ignore[name-defined]
                verbose=False,
                memory_saving_mode=True,
                light_mode=True,
                text_mode=True,  # Text only — no CSS/images needed
            )
            run_config_p2 = CrawlerRunConfig(  # type: ignore[name-defined]
                # ``domcontentloaded`` fires when the HTML is parsed — well
                # before all third-party trackers, fonts, and analytics
                # pixels are done. The previous setting (``networkidle``)
                # waits for 500ms of zero network activity, which on modern
                # sites with retargeting / chat / analytics scripts often
                # never resolves and forces us into the full ``page_timeout``
                # for every page. The JS scroll preamble below still runs
                # *after* DOMContentLoaded, so React/Next.js hydration +
                # Intersection-Observer lazy-loading still get triggered;
                # we just don't wait for the long tail of unrelated network
                # chatter. Typical observed speedup: 5–10× per page.
                wait_until="domcontentloaded",
                screenshot=False,
                pdf=False,
                exclude_all_images=True,
                # Scroll each page to trigger Intersection Observers so that
                # lazy-loaded portfolio grids, footer links, etc. are rendered.
                js_code=_JS_SCROLL_PREAMBLE,
            )
            h2t_p2 = _make_html2text()
            semaphore_p2 = asyncio.Semaphore(1)

            async def _crawl_page_with_fallback(
                current_url: str,
                depth: int,
                browser_crawler,  # AsyncWebCrawler instance
            ) -> tuple[str | None, str | None, dict]:
                """Try Playwright; fall back to plain HTTP on any failure."""
                try:
                    res = await asyncio.wait_for(
                        browser_crawler.arun(url=current_url, config=run_config_p2),
                        timeout=page_timeout,
                    )
                    if isinstance(res, list):
                        res = res[0] if res else None
                    if res and hasattr(res, "markdown") and res.markdown:
                        return res.markdown, getattr(res, "html", None), getattr(res, "links", {}) or {}
                except Exception as _browser_err:
                    print(
                        json.dumps({"log": f"Browser failed for {current_url} ({_browser_err}), using HTTP fallback"})
                    )

                # HTTP fallback
                async with aiohttp.ClientSession(headers={"User-Agent": _HTTP_USER_AGENT}) as _fb_session:
                    fb = await crawl_single_http(_fb_session, current_url, depth, semaphore_p2, page_timeout, h2t_p2)
                if not fb["error"] and fb["markdown"]:
                    return fb["markdown"], fb["html"], {}
                return None, None, {}

            # Outer loop: create a browser session, crawl up to recycle_every
            # pages, then destroy and recreate to free memory.
            while pq and pages_crawled < max_pages:
                if _is_cancelled(cancel_file):
                    _emit_cancelled(results, extracted_colors, discovered_total=len(enqueued), queue_remaining=len(pq))
                    return
                print(
                    json.dumps(
                        {
                            "log": f"Phase 2 (browser): starting session (crawled={pages_crawled}/{max_pages}, queued={len(pq)})"
                        }
                    )
                )
                async with AsyncWebCrawler(config=browser_config_p2) as p2_crawler:  # type: ignore[name-defined]
                    session_count = 0
                    while pq and pages_crawled < max_pages and session_count < recycle_every:
                        if _is_cancelled(cancel_file):
                            _emit_cancelled(
                                results, extracted_colors, discovered_total=len(enqueued), queue_remaining=len(pq)
                            )
                            return
                        _prio, _cnt, current_url, depth = heapq.heappop(pq)
                        norm_url = normalize_url(current_url)
                        if norm_url in visited:
                            continue
                        if robot_parser and not robot_parser.can_fetch("*", current_url):
                            print(json.dumps({"log": f"Skipped (robots.txt): {current_url}"}))
                            visited.add(norm_url)
                            continue
                        visited.add(norm_url)

                        markdown, html, links_dict = await _crawl_page_with_fallback(current_url, depth, p2_crawler)
                        if not markdown:
                            continue

                        pages_crawled += 1
                        session_count += 1
                        results.append({"url": norm_url, "content": markdown})
                        if progress_file:
                            _write_progress(progress_file, results)
                        print(
                            json.dumps(
                                {
                                    "log": f"Phase 2 (browser): {current_url} [{pages_crawled}/{max_pages}, session={session_count}/{recycle_every}]"
                                }
                            )
                        )

                        # No per-page link discovery — frontier is fixed at
                        # ``{seed_url} ∪ sitemap`` for the entire crawl.

                if session_count >= recycle_every and pq:
                    print(json.dumps({"log": f"Phase 2 (browser): recycled browser after {session_count} pages"}))

        else:
            # ------------------------------------------------------------------
            # HTTP-based Phase 2 — concurrent aiohttp (original behaviour)
            # ------------------------------------------------------------------
            h2t = _make_html2text()
            semaphore = asyncio.Semaphore(concurrency)
            http_headers = {"User-Agent": _HTTP_USER_AGENT}

            async with aiohttp.ClientSession(headers=http_headers) as http_session:
                while pq and pages_crawled < max_pages:
                    if _is_cancelled(cancel_file):
                        _emit_cancelled(
                            results, extracted_colors, discovered_total=len(enqueued), queue_remaining=len(pq)
                        )
                        return
                    # Collect a batch of URLs to crawl
                    batch_tasks: list = []
                    batch_info: list[dict] = []

                    while pq and len(batch_tasks) < concurrency and pages_crawled + len(batch_tasks) < max_pages:
                        _priority, _counter, current_url, depth = heapq.heappop(pq)

                        norm_url = normalize_url(current_url)
                        if norm_url in visited:
                            continue

                        # Respect robots.txt (does not consume page budget)
                        if robot_parser and not robot_parser.can_fetch("*", current_url):
                            print(json.dumps({"log": f"Skipped (robots.txt): {current_url}"}))
                            visited.add(norm_url)
                            continue

                        visited.add(norm_url)

                        # Adaptive timeout: shorter for deep pages
                        effective_timeout = page_timeout if depth <= 1 else max(page_timeout - 5, 10)
                        info = {"url": current_url, "norm_url": norm_url, "depth": depth}
                        # Wrap each task so as_completed() can hand us back
                        # (info, result) without a separate index lookup.
                        batch_tasks.append(
                            _crawl_http_with_info(
                                info,
                                http_session,
                                current_url,
                                depth,
                                semaphore,
                                effective_timeout,
                                h2t,
                            )
                        )
                        batch_info.append(info)

                    if not batch_tasks:
                        break

                    print(
                        json.dumps(
                            {
                                "log": f"Phase 2 (HTTP): crawling batch of {len(batch_tasks)} pages ({pages_crawled}/{max_pages} crawled, {len(pq)} queued)"
                            }
                        )
                    )
                    # Per-page progress emission: consume each task as it
                    # completes (not after the whole batch via gather). On a
                    # heavyweight CMS, one slow page used to delay the whole
                    # batch's progress write by 60-150s; with as_completed
                    # the temp file (and Redis heartbeat) refresh within
                    # seconds of every individual page finishing.
                    #
                    # Snappy cancel: also check the cancel file on every
                    # iteration so Cancel is honoured within ~1 page of work,
                    # not "the whole batch must finish first". The remaining
                    # in-flight tasks are abandoned to the event-loop teardown
                    # on return (the subprocess is exiting anyway).
                    cancel_seen = False
                    for completed in asyncio.as_completed(batch_tasks):
                        if _is_cancelled(cancel_file):
                            cancel_seen = True
                            break
                        try:
                            info, crawl_result = await completed
                        except Exception as exc:
                            print(json.dumps({"log": f"Task raised: {exc}"}))
                            continue

                        if crawl_result["error"]:
                            print(json.dumps({"log": f"Error crawling {info['url']}: {crawl_result['error']}"}))
                            continue

                        if not crawl_result["markdown"]:
                            continue

                        pages_crawled += 1
                        results.append({"url": info["norm_url"], "content": crawl_result["markdown"]})
                        if progress_file:
                            _write_progress(progress_file, results)

                        # No per-page link discovery — frontier is fixed at
                        # ``{seed_url} ∪ sitemap`` for the entire crawl.

                    if cancel_seen:
                        # Cancel was raised mid-batch. Emit what we have and
                        # exit cleanly — the parent will see ``cancelled=True``
                        # in the JSON envelope and skip the failed-job path.
                        _emit_cancelled(
                            results,
                            extracted_colors,
                            discovered_total=len(enqueued),
                            queue_remaining=len(pq),
                        )
                        return

    # Coverage diagnostics: how many URLs did we know about vs. actually
    # crawl? The orchestrator surfaces these so the UI can show "we found N
    # more URLs that didn't fit your plan's cap" instead of silently dropping
    # them. ``enqueued`` is every URL we ever queued (visited + still in pq +
    # robots-blocked); ``len(pq)`` is the leftover frontier when we stopped.
    discovered_total = len(enqueued)
    queue_remaining = len(pq)

    if queue_remaining:
        print(
            json.dumps(
                {
                    "log": (
                        f"Crawl complete: {len(results)} pages ingested, "
                        f"{queue_remaining} URLs discovered but not crawled "
                        f"(plan page cap or depth limit reached)"
                    )
                }
            )
        )
    else:
        print(json.dumps({"log": f"Crawl complete: {len(results)} pages collected"}))

    # Output results
    print("---CRAWLER_JSON_OUTPUT---")
    print(
        json.dumps(
            {
                "results": results,
                "recommended_colors": list(extracted_colors),
                "discovered_total": discovered_total,
                "queue_remaining": queue_remaining,
            }
        )
    )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        sys.exit(1)

    url = sys.argv[1]
    max_pages = int(os.getenv("MAX_CRAWL_PAGES", "50"))

    # Allow explicit JS mode override via CLI flag (useful for manual testing)
    if "--js-all-pages" in sys.argv:
        os.environ["CRAWLER_JS_ALL_PAGES"] = "true"

    # Parse --progress-file <path> for real-time URL streaming to the API process
    progress_file: str | None = None
    # Parse --cancel-file <path> — parent ``touch``es this file to ask us to
    # stop cooperatively between URLs. Lets cancellation be fast and clean
    # (no leaked Playwright/Chromium descendants); SIGTERM is the fallback.
    cancel_file: str | None = None
    for i, arg in enumerate(sys.argv):
        if arg == "--progress-file" and i + 1 < len(sys.argv):
            progress_file = sys.argv[i + 1]
        elif arg == "--cancel-file" and i + 1 < len(sys.argv):
            cancel_file = sys.argv[i + 1]

    asyncio.run(
        crawl_recursive(
            url,
            max_pages=max_pages,
            progress_file=progress_file,
            cancel_file=cancel_file,
        )
    )
