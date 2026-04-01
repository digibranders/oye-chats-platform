import asyncio
import heapq
import json
import os
import re
import sys
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree

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

HIGH_PRIORITY_PATHS: frozenset[str] = frozenset(
    {
        "/",
        "/about",
        "/about-us",
        "/pricing",
        "/features",
        "/faq",
        "/faqs",
        "/contact",
        "/contact-us",
        "/docs",
        "/documentation",
        "/products",
        "/services",
        "/support",
        "/help",
        "/terms",
        "/privacy",
        "/team",
    }
)

LOW_PRIORITY_PATTERNS: tuple[str, ...] = (
    "/blog/",
    "/news/",
    "/archive/",
    "/tag/",
    "/tags/",
    "/category/",
    "/categories/",
    "/author/",
    "/page/",
    "/comment",
)

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


def url_priority(url: str, depth: int) -> int:
    """Lower number = higher priority (crawled first)."""
    path = urlparse(url).path.rstrip("/") or "/"

    if path.lower() in HIGH_PRIORITY_PATHS:
        return 0

    for pattern in LOW_PRIORITY_PATTERNS:
        if pattern in path.lower():
            return 3

    if depth <= 1:
        return 1

    return 2


def is_html_content(html: str) -> bool:
    """Heuristic check: does the content look like an HTML page?"""
    if not html:
        return False
    snippet = html[:1000].lower()
    return any(marker in snippet for marker in ("<!doctype", "<html", "<head", "<body"))


# ---------------------------------------------------------------------------
# robots.txt & sitemap helpers
# ---------------------------------------------------------------------------


async def fetch_robots_txt(base_url: str) -> RobotFileParser | None:
    """Fetch and parse robots.txt for *base_url*. Returns None on failure."""
    try:
        import aiohttp

        parsed = urlparse(base_url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"

        async with (
            aiohttp.ClientSession() as session,
            session.get(robots_url, timeout=aiohttp.ClientTimeout(total=10)) as resp,
        ):
            if resp.status != 200:
                return None
            text = await resp.text()

        rp = RobotFileParser()
        rp.parse(text.splitlines())
        return rp
    except Exception:
        return None


async def fetch_sitemap_urls(
    base_url: str, robot_parser: RobotFileParser | None, *, max_sitemaps: int = 10
) -> list[str]:
    """Discover URLs from sitemap.xml (and robots.txt Sitemap directives).

    Handles sitemap index files with a depth limit to prevent unbounded expansion.
    At most *max_sitemaps* sitemap files are fetched.
    """
    import aiohttp

    sitemap_queue: list[str] = []
    seen_sitemaps: set[str] = set()

    def enqueue_sitemap(url: str) -> None:
        if url not in seen_sitemaps and len(seen_sitemaps) < max_sitemaps:
            seen_sitemaps.add(url)
            sitemap_queue.append(url)

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
            sitemap_url = sitemap_queue[idx]
            idx += 1
            try:
                async with session.get(sitemap_url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    if resp.status != 200:
                        continue
                    content = await resp.text()

                root = ElementTree.fromstring(content)
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
# Single-page crawl with retry
# ---------------------------------------------------------------------------


async def crawl_single(
    crawler: "AsyncWebCrawler",  # noqa: F821
    url: str,
    depth: int,
    js_code: str | None,
    semaphore: asyncio.Semaphore,
    page_timeout: int,
) -> dict:
    """Crawl a single URL with semaphore-controlled concurrency and one retry.

    The semaphore is released between retry attempts so that other concurrent
    crawl tasks are not blocked during the backoff sleep.
    """
    for attempt in range(2):
        async with semaphore:
            try:
                timeout = page_timeout if attempt == 0 else int(page_timeout * 1.5)
                result = await asyncio.wait_for(
                    crawler.arun(url=url, js_code=js_code),
                    timeout=timeout,
                )
                return {"url": url, "depth": depth, "result": result, "error": None}
            except TimeoutError:
                if attempt == 0:
                    pass  # will retry after sleep below
                else:
                    return {"url": url, "depth": depth, "result": None, "error": "timeout"}
            except Exception as e:
                if attempt == 0:
                    pass  # will retry after sleep below
                else:
                    return {"url": url, "depth": depth, "result": None, "error": str(e)}
        # Sleep outside the semaphore context so other tasks can proceed
        if attempt == 0:
            await asyncio.sleep(1)

    return {"url": url, "depth": depth, "result": None, "error": "max retries exceeded"}


# ---------------------------------------------------------------------------
# Main recursive crawl
# ---------------------------------------------------------------------------


async def crawl_recursive(start_url: str, max_depth: int = 3, max_pages: int | None = None) -> None:
    try:
        from crawl4ai import AsyncWebCrawler
    except ImportError:
        print(json.dumps({"error": "crawl4ai not installed"}))
        return

    # Read config from env
    if max_pages is None:
        max_pages = int(os.getenv("MAX_CRAWL_PAGES", "50"))
    concurrency = int(os.getenv("CRAWL_CONCURRENCY", "5"))
    page_timeout = int(os.getenv("CRAWL_PAGE_TIMEOUT", "20"))

    max_depth = int(os.getenv("MAX_CRAWL_DEPTH", str(max_depth)))

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

    def push_url(url: str, depth: int) -> None:
        nonlocal counter
        norm = normalize_url(url)
        if norm in visited or norm in enqueued:
            return
        if should_skip_url(url):
            return
        enqueued.add(norm)
        priority = url_priority(url, depth)
        heapq.heappush(pq, (priority, counter, url, depth))
        counter += 1

    print(
        json.dumps(
            {
                "log": f"Starting crawl on {start_url} (domain: {start_domain}, max_depth: {max_depth}, max_pages: {max_pages})"
            }
        )
    )

    # ---- Pre-crawl: robots.txt & sitemap ----
    robot_parser = await fetch_robots_txt(start_url)
    if robot_parser:
        print(json.dumps({"log": "robots.txt loaded"}))

    sitemap_urls = await fetch_sitemap_urls(start_url, robot_parser)
    sitemap_seeded = 0
    for surl in sitemap_urls:
        parsed_surl = urlparse(surl)
        if (
            get_base_domain(parsed_surl.netloc) == start_domain
            and parsed_surl.scheme in ("http", "https")
            and not should_skip_url(surl)
        ):
            push_url(surl, 1)
            sitemap_seeded += 1
    if sitemap_seeded:
        print(json.dumps({"log": f"Seeded {sitemap_seeded} URLs from sitemap"}))

    # Seed the start URL (always priority 0)
    push_url(start_url, 0)

    # ---- JS color extraction code (only used on depth-0) ----
    js_extraction_code = """
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

    semaphore = asyncio.Semaphore(concurrency)

    async with AsyncWebCrawler(verbose=False) as crawler:
        while pq and pages_crawled < max_pages:
            # Collect a batch of URLs to crawl
            batch_tasks = []
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
                js_code = js_extraction_code if depth == 0 else None
                batch_tasks.append(crawl_single(crawler, current_url, depth, js_code, semaphore, effective_timeout))
                batch_info.append({"url": current_url, "norm_url": norm_url, "depth": depth})

            if not batch_tasks:
                break

            print(
                json.dumps(
                    {
                        "log": f"Crawling batch of {len(batch_tasks)} pages ({pages_crawled}/{max_pages} crawled, {len(pq)} queued)"
                    }
                )
            )
            batch_results = await asyncio.gather(*batch_tasks)

            # Process results
            for info, crawl_result in zip(batch_info, batch_results, strict=False):
                if crawl_result["error"]:
                    print(json.dumps({"log": f"Error crawling {info['url']}: {crawl_result['error']}"}))
                    continue

                result = crawl_result["result"]
                if not result or not result.markdown:
                    continue

                # Content-type validation: skip non-HTML
                if hasattr(result, "html") and result.html and not is_html_content(result.html):
                    print(json.dumps({"log": f"Skipped (not HTML): {info['url']}"}))
                    continue

                pages_crawled += 1
                results.append({"url": info["norm_url"], "content": result.markdown})

                # Extract colors from JS (depth-0 only)
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
                if info["depth"] == 0 and not extracted_colors and hasattr(result, "html") and result.html:
                    print(json.dumps({"log": "JS color extraction returned nothing, using Python HTML fallback"}))
                    fallback_colors = extract_colors_from_html(result.html)
                    for c in fallback_colors:
                        extracted_colors.add(c.lower())
                    if extracted_colors:
                        print(json.dumps({"log": f"Python fallback extracted {len(extracted_colors)} colors"}))

                # Discover new links if not at max depth
                if info["depth"] < max_depth:
                    links: list[str] = []

                    # Method 1: crawl4ai built-in links
                    if hasattr(result, "links") and isinstance(result.links, dict):
                        links_internal = result.links.get("internal", [])
                        for link in links_internal:
                            if isinstance(link, dict):
                                href = link.get("href")
                                if href:
                                    links.append(href)
                            elif isinstance(link, str):
                                links.append(link)

                    # Method 2: Fallback regex
                    if not links and hasattr(result, "html"):
                        found_hrefs = re.findall(r'<a\s+(?:[^>]*?\s+)?href="([^"]*)"', result.html)
                        links.extend(found_hrefs)
                        print(json.dumps({"log": f"Fallback: Found {len(found_hrefs)} links via regex"}))

                    for href in links:
                        if not href:
                            continue

                        full_url = urljoin(info["url"], href)
                        parsed_url = urlparse(full_url)
                        link_domain = get_base_domain(parsed_url.netloc)

                        if link_domain == start_domain and parsed_url.scheme in ("http", "https"):
                            push_url(full_url, info["depth"] + 1)

    print(json.dumps({"log": f"Crawl complete: {len(results)} pages collected"}))

    # Output results
    print("---CRAWLER_JSON_OUTPUT---")
    print(json.dumps({"results": results, "recommended_colors": list(extracted_colors)}))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        sys.exit(1)

    url = sys.argv[1]
    max_pages = int(os.getenv("MAX_CRAWL_PAGES", "50"))
    asyncio.run(crawl_recursive(url, max_pages=max_pages))
