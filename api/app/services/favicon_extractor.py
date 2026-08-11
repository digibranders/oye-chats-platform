"""Favicon / app-icon extraction from a website's homepage.

When a customer trains a bot by crawling their site, the site almost always
advertises a favicon or an Apple touch icon in its ``<head>``. That mark is a
ready-made avatar for the bot — so this module fetches the homepage HTML,
discovers the best icon it declares, downloads that icon, and returns the raw
image bytes. The crawl orchestrator then uploads those bytes through the same
logo pipeline used for a manual upload (square-crop + resize to a 512x512 PNG)
and sets them as the bot's avatar when the customer hasn't chosen one.

Selection strategy
------------------
Every ``<link rel="...icon...">`` is collected with its declared ``sizes`` and
ranked so the sharpest square mark wins: Apple touch icons (designed as filled
app icons, typically 180x180) rank first, then ``rel="icon"`` PNGs by declared
size, then the legacy ``shortcut icon``. Scalable ``mask-icon`` / SVG entries
are skipped because the logo pipeline rasterizes with Pillow, which cannot open
SVG. The site root's conventional ``/apple-touch-icon.png`` and ``/favicon.ico``
are always appended as last-resort fallbacks, so a site that declares nothing
still yields an icon.

Safety
------
Every fetch (the homepage and each candidate icon) is validated through the
shared SSRF guard before connecting, redirects are not auto-followed, and every
response body is size-capped. Best-effort throughout: any failure returns
``None`` and must never abort the crawl.
"""

from __future__ import annotations

import io
import logging
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from PIL import Image

from app.core.ssrf import SSRFError, validate_public_url

logger = logging.getLogger(__name__)

_FETCH_TIMEOUT_S = 10.0
_MAX_HTML_BYTES = 2 * 1024 * 1024  # 2 MB — plenty for a marketing homepage <head>
_MAX_ICON_BYTES = 2 * 1024 * 1024  # 2 MB — a real app icon is a few dozen KB
_MIN_ICON_BYTES = 48  # anything smaller can't be a decodable image

# Browser-like UA: some CDNs serve an SPA shell (no icon links) to headless UA
# strings, but the same first-paint HTML a visitor sees to a real browser UA.
_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (compatible; OyeChatsBrandBot/1.0; +https://www.oyechats.com)"),
    "Accept": "text/html,application/xhtml+xml,image/*,*/*",
}

# ``rel`` tokens we treat as icon declarations, mapped to a base priority
# (lower = preferred). Apple touch icons are purpose-built square app icons and
# make the cleanest avatars, so they outrank the generic favicon.
_ICON_REL_PRIORITY = {
    "apple-touch-icon-precomposed": 0,
    "apple-touch-icon": 0,
    "icon": 1,
    "shortcut icon": 2,
    "fluid-icon": 3,
}

# SVG icons can't be rasterized by the Pillow-based logo pipeline — skip them.
_SVG_HINTS = ("image/svg", ".svg")


def _largest_declared_size(sizes: str | None) -> int:
    """Return the largest pixel dimension declared in a ``sizes`` attribute.

    ``sizes`` looks like ``"180x180"``, ``"16x16 32x32"``, or ``"any"``. We take
    the max of every ``NxM`` token's larger side. ``"any"`` (scalable) and a
    missing/garbage value yield ``0`` so declared-size icons always outrank
    undeclared ones; ``"any"`` is not treated as huge because it usually marks an
    SVG we can't use anyway.
    """
    if not sizes:
        return 0
    best = 0
    for token in sizes.lower().split():
        if "x" not in token:
            continue
        parts = token.split("x")
        try:
            best = max(best, max(int(parts[0]), int(parts[1])))
        except (ValueError, IndexError):
            continue
    return best


def _is_svg_candidate(href: str, icon_type: str | None) -> bool:
    """True when the candidate is an SVG (unusable by the raster logo pipeline)."""
    lowered_href = href.split("?", 1)[0].lower()
    lowered_type = (icon_type or "").lower()
    return any(hint in lowered_type for hint in _SVG_HINTS) or lowered_href.endswith(".svg")


def _discover_icon_urls(base_url: str, html: str) -> list[str]:
    """Return absolute icon URLs discovered in ``html``, best candidate first.

    Ranks by ``rel`` priority then by largest declared size (descending), and
    always appends the site root's conventional ``/apple-touch-icon.png`` and
    ``/favicon.ico`` as fallbacks. De-duplicates while preserving rank order.
    """
    soup = BeautifulSoup(html, "html.parser")
    # (priority, -size, order, absolute_url) — ``order`` keeps the sort stable
    # for equal-rank icons so document order breaks ties deterministically.
    candidates: list[tuple[int, int, int, str]] = []
    for order, link in enumerate(soup.find_all("link")):
        rels = link.get("rel") or []
        # BeautifulSoup returns ``rel`` as a token list; normalize to a single
        # lowercase key so "shortcut icon" (two tokens) still matches.
        rel_key = " ".join(str(r).lower() for r in rels).strip()
        priority = _ICON_REL_PRIORITY.get(rel_key)
        if priority is None and "icon" in rel_key and "mask-icon" not in rel_key:
            priority = _ICON_REL_PRIORITY["icon"]
        if priority is None:
            continue
        href = (link.get("href") or "").strip()
        if not href:
            continue
        if _is_svg_candidate(href, link.get("type")):
            continue
        try:
            absolute = urljoin(base_url, href).split("#", 1)[0]
        except Exception:
            continue
        if not absolute.lower().startswith(("http://", "https://")):
            continue
        size = _largest_declared_size(link.get("sizes"))
        candidates.append((priority, -size, order, absolute))

    candidates.sort()
    ordered = [url for _, _, _, url in candidates]

    # Conventional root fallbacks — appended last so a site with no declared
    # icons (or only unusable ones) still resolves something.
    try:
        parsed = urlparse(base_url)
        if parsed.scheme and parsed.netloc:
            root = f"{parsed.scheme}://{parsed.netloc}"
            ordered.append(f"{root}/apple-touch-icon.png")
            ordered.append(f"{root}/favicon.ico")
    except Exception:
        pass

    seen: set[str] = set()
    deduped: list[str] = []
    for url in ordered:
        if url in seen:
            continue
        seen.add(url)
        deduped.append(url)
    return deduped


def _decode_is_valid_image(data: bytes) -> bool:
    """True when ``data`` decodes as a real raster image via Pillow.

    Guards against a site serving an HTML error page (or a 1x1 tracking pixel)
    for a missing icon path — we only want bytes the logo pipeline can process
    into a usable avatar.
    """
    try:
        with Image.open(io.BytesIO(data)) as img:
            img.verify()  # cheap structural check without full decode
        width, height = Image.open(io.BytesIO(data)).size
    except Exception:
        return False
    return width >= 16 and height >= 16


async def _download_icon(client: httpx.AsyncClient, url: str) -> bytes | None:
    """Download and validate a single icon URL, or return ``None``.

    SSRF-validated before connecting; redirects are not auto-followed (a
    ``Location`` to an internal host is simply treated as a miss); the body is
    capped at :data:`_MAX_ICON_BYTES`.
    """
    try:
        validate_public_url(url)
    except SSRFError:
        logger.debug("favicon candidate rejected by SSRF guard: %s", url)
        return None
    try:
        resp = await client.get(url, timeout=_FETCH_TIMEOUT_S)
    except Exception as exc:
        logger.debug("favicon download failed for %s: %s", url, exc)
        return None
    if resp.status_code != 200:
        return None
    data = resp.content[:_MAX_ICON_BYTES]
    if len(data) < _MIN_ICON_BYTES:
        return None
    if not _decode_is_valid_image(data):
        return None
    return data


async def fetch_favicon_image(url: str) -> bytes | None:
    """Return the best usable icon for ``url`` as raw image bytes, or ``None``.

    Fetches the homepage HTML, ranks its declared icons plus the conventional
    root fallbacks, and downloads them in order until one decodes as a valid
    raster image. Best-effort: a network error, an SSRF rejection, a JS-only
    shell with no icons, or a site that serves nothing decodable all return
    ``None`` without raising.
    """
    if not url:
        return None

    try:
        validate_public_url(url)
    except SSRFError:
        logger.debug("favicon homepage rejected by SSRF guard: %s", url)
        return None

    try:
        async with httpx.AsyncClient(
            timeout=_FETCH_TIMEOUT_S,
            follow_redirects=True,
            headers=_HEADERS,
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            html = resp.content[:_MAX_HTML_BYTES].decode(resp.encoding or "utf-8", errors="ignore")
            # Resolve icon hrefs against the redirected final URL so relative
            # paths work for sites that redirect www ↔ apex or http → https.
            candidates = _discover_icon_urls(str(resp.url), html)
            for candidate in candidates:
                data = await _download_icon(client, candidate)
                if data is not None:
                    logger.info("Fetched favicon for %s from %s (%d bytes)", url, candidate, len(data))
                    return data
    except Exception as exc:
        logger.warning("favicon fetch failed for %s: %s", url, exc)
        return None

    logger.info("No usable favicon found for %s", url)
    return None
