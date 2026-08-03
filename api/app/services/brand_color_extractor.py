"""Brand color extraction from a website's homepage HTML.

The crawl providers (Spider, Jina) return page bodies as markdown, which
strips CSS and inline styles — the only signal we ever had for a customer's
palette. This module recovers it by fetching the seed URL's raw HTML once
and pulling colors out of ``<style>`` blocks, inline ``style=""``
attributes, ``<meta name="theme-color">``, and SVG fill/stroke attributes.

Recognised color notations
--------------------------
* ``#RGB`` / ``#RRGGBB`` hex — the historic path.
* ``rgb()`` / ``rgba()`` — both the legacy comma-separated form and the
  modern CSS Color Level 4 space-separated form with an optional
  ``/ alpha`` suffix. Percentage channels are supported.
* ``hsl()`` / ``hsla()`` — same syntax variants. Hue accepts a bare number
  (degrees) or an explicit ``deg`` / ``turn`` / ``rad`` / ``grad`` unit.

Alpha is parsed but ignored — the caller wants a solid brand color to seed
the widget palette, not a translucent overlay. Every recognised notation is
normalised to a lowercase ``#rrggbb`` string before being counted, so a
site that mixes ``#0F172A`` in inline styles with ``rgb(15 23 42)`` in a
``<style>`` block still ranks that shade as one color rather than two.

Cheap and deterministic: no LLM, no headless browser, one HTTP GET.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections import Counter
from collections.abc import Iterable
from urllib.parse import urljoin, urlparse

import httpx

logger = logging.getLogger(__name__)

_FETCH_TIMEOUT_S = 10.0
_MAX_HTML_BYTES = 2 * 1024 * 1024  # 2 MB is plenty for a marketing homepage
_DEFAULT_TOP_N = 6

# External stylesheet crawl budget. Marketing sites usually load their whole
# palette from 1–2 first-party CSS bundles (globals, tailwind, design system);
# anything past ~4 tends to be legal/tracking chrome. We cap tightly so a
# misconfigured site with 50 stylesheets can't burn the crawl's time budget.
_MAX_STYLESHEETS = 4
_STYLESHEET_TIMEOUT_S = 5.0
_MAX_STYLESHEET_BYTES = 512 * 1024  # 512 KB — bigger than any real hand-authored bundle

# Match ``<link ...>`` tags with ``rel="stylesheet"`` in any attribute order,
# capturing the ``href``. Case-insensitive. The regex is intentionally
# permissive: an HTML parser would be overkill for a single-tag extraction
# and would drag in a dependency we don't otherwise need.
_LINK_STYLESHEET_RE = re.compile(
    r"""<link\b(?=[^>]*\brel\s*=\s*['\"]stylesheet['\"])
        [^>]*?
        \bhref\s*=\s*(?P<q>['\"])(?P<href>[^'\"]+)(?P=q)
        [^>]*>""",
    re.IGNORECASE | re.VERBOSE,
)

# Alternative attribute order — ``href`` before ``rel``. Kept separate so the
# combined match set is a union of both orderings without needing a bigger
# regex with lookaheads on both sides.
_LINK_STYLESHEET_HREF_FIRST_RE = re.compile(
    r"""<link\b(?=[^>]*\brel\s*=\s*['\"]stylesheet['\"])
        [^>]*?
        \bhref\s*=\s*(?P<q>['\"])(?P<href>[^'\"]+)(?P=q)""",
    re.IGNORECASE | re.VERBOSE,
)

# Match #RGB, #RRGGBB (with or without leading `color:`/`background:` context).
_HEX_COLOR_RE = re.compile(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b")

# Match ``rgb(...)`` / ``rgba(...)`` in either the legacy comma-separated form
# or the modern space-separated form with an optional slash-alpha. We stay
# permissive with whitespace to survive minified stylesheets.
_RGB_COLOR_RE = re.compile(
    r"""rgba?\(\s*
        (?P<r>[+\-]?\d+(?:\.\d+)?%?)\s*[,\s]\s*
        (?P<g>[+\-]?\d+(?:\.\d+)?%?)\s*[,\s]\s*
        (?P<b>[+\-]?\d+(?:\.\d+)?%?)
        (?:\s*[,/]\s*[+\-]?\d+(?:\.\d+)?%?)?  # alpha — ignored
        \s*\)""",
    re.VERBOSE,
)

# Match ``hsl(...)`` / ``hsla(...)`` with the same syntactic tolerance.
# Hue may carry an explicit angle unit (deg/turn/rad/grad); saturation and
# lightness use a percent sign but we accept bare numbers defensively.
_HSL_COLOR_RE = re.compile(
    r"""hsla?\(\s*
        (?P<h>[+\-]?\d+(?:\.\d+)?)\s*(?P<hu>deg|turn|rad|grad)?\s*[,\s]\s*
        (?P<s>[+\-]?\d+(?:\.\d+)?)%?\s*[,\s]\s*
        (?P<l>[+\-]?\d+(?:\.\d+)?)%?
        (?:\s*[,/]\s*[+\-]?\d+(?:\.\d+)?%?)?
        \s*\)""",
    re.VERBOSE,
)

# Colors that are almost certainly chrome, not brand: white/black/near-neutrals.
# Filtering these prevents "recommended" panels from being polluted with
# generic body-text / background greys that carry no branding signal.
_NEUTRAL_SATURATION_MAX = 0.08  # 0..1
_NEUTRAL_LIGHTNESS_MIN = 0.10
_NEUTRAL_LIGHTNESS_MAX = 0.92


def _expand_short_hex(hex6_or_3: str) -> str:
    """Normalize ``abc`` → ``aabbcc`` and lowercase."""
    v = hex6_or_3.lower()
    if len(v) == 3:
        v = v[0] * 2 + v[1] * 2 + v[2] * 2
    return v


def _hex_to_rgb(hex6: str) -> tuple[int, int, int]:
    return (int(hex6[0:2], 16), int(hex6[2:4], 16), int(hex6[4:6], 16))


def _rgb_to_hsl(r: int, g: int, b: int) -> tuple[float, float, float]:
    """Standard sRGB → HSL, all outputs in [0, 1]."""
    rf, gf, bf = r / 255.0, g / 255.0, b / 255.0
    mx, mn = max(rf, gf, bf), min(rf, gf, bf)
    lightness = (mx + mn) / 2.0
    if mx == mn:
        return 0.0, 0.0, lightness
    d = mx - mn
    s = d / (2.0 - mx - mn) if lightness > 0.5 else d / (mx + mn)
    if mx == rf:
        h = ((gf - bf) / d) + (6.0 if gf < bf else 0.0)
    elif mx == gf:
        h = ((bf - rf) / d) + 2.0
    else:
        h = ((rf - gf) / d) + 4.0
    return h / 6.0, s, lightness


def _is_brandable(hex6: str) -> bool:
    """Keep colors with enough saturation and mid-range lightness.

    Rejects pure white/black plus near-neutral greys — the ones that show up
    in every stylesheet regardless of brand identity.
    """
    r, g, b = _hex_to_rgb(hex6)
    _h, s, lightness = _rgb_to_hsl(r, g, b)
    if s < _NEUTRAL_SATURATION_MAX:
        return False
    return _NEUTRAL_LIGHTNESS_MIN <= lightness <= _NEUTRAL_LIGHTNESS_MAX


def _clamp_byte(value: float) -> int:
    """Clamp a float to the 0..255 byte range and round to int."""
    return max(0, min(255, int(round(value))))


def _rgb_component_to_byte(raw: str) -> int | None:
    """Convert an ``rgb()`` channel token to a 0..255 byte.

    Accepts either bare numbers (``128``, ``42.5``) or percentages
    (``50%``, ``12.5%``). Returns ``None`` for unparseable input so the
    match can be dropped without polluting the counter.
    """
    token = raw.strip()
    try:
        if token.endswith("%"):
            pct = float(token[:-1])
            return _clamp_byte(pct * 255.0 / 100.0)
        return _clamp_byte(float(token))
    except ValueError:
        return None


def _hue_to_unit(value_str: str, unit: str | None) -> float | None:
    """Normalise a CSS hue token to the [0, 1) unit interval."""
    try:
        value = float(value_str)
    except ValueError:
        return None
    if unit == "turn":
        hue_deg = value * 360.0
    elif unit == "rad":
        hue_deg = value * 180.0 / 3.141592653589793
    elif unit == "grad":
        hue_deg = value * 360.0 / 400.0
    else:  # None or "deg"
        hue_deg = value
    hue_deg %= 360.0
    if hue_deg < 0:
        hue_deg += 360.0
    return hue_deg / 360.0


def _hsl_channel_to_unit(raw: str) -> float | None:
    """Convert a saturation/lightness token (with or without ``%``) to [0, 1]."""
    token = raw.strip().rstrip("%")
    try:
        return max(0.0, min(1.0, float(token) / 100.0))
    except ValueError:
        return None


def _hsl_to_rgb(hue: float, sat: float, lightness: float) -> tuple[int, int, int]:
    """Standard HSL → sRGB, all inputs in [0, 1]."""
    if sat == 0:
        v = _clamp_byte(lightness * 255.0)
        return v, v, v

    def _channel(t: float) -> float:
        if t < 0:
            t += 1.0
        elif t > 1:
            t -= 1.0
        if t < 1 / 6:
            return p + (q - p) * 6.0 * t
        if t < 1 / 2:
            return q
        if t < 2 / 3:
            return p + (q - p) * (2 / 3 - t) * 6.0
        return p

    q = lightness * (1.0 + sat) if lightness < 0.5 else lightness + sat - lightness * sat
    p = 2.0 * lightness - q
    r = _channel(hue + 1 / 3)
    g = _channel(hue)
    b = _channel(hue - 1 / 3)
    return _clamp_byte(r * 255.0), _clamp_byte(g * 255.0), _clamp_byte(b * 255.0)


def _rgb_bytes_to_hex(r: int, g: int, b: int) -> str:
    return f"{r:02x}{g:02x}{b:02x}"


def _iter_hex_colors(html: str) -> Iterable[str]:
    """Yield every recognised color as a lowercase ``rrggbb`` string.

    Runs the hex, ``rgb()``, and ``hsl()`` matchers over the same document.
    The matchers overlap harmlessly (a ``#abc`` inside a ``style`` attribute
    can't also parse as ``rgb(...)``), so we don't dedupe positions — the
    downstream counter treats each occurrence as a separate vote for that
    color, which is exactly the ranking signal we want.
    """
    for match in _HEX_COLOR_RE.finditer(html):
        yield _expand_short_hex(match.group(1))

    for match in _RGB_COLOR_RE.finditer(html):
        r = _rgb_component_to_byte(match.group("r"))
        g = _rgb_component_to_byte(match.group("g"))
        b = _rgb_component_to_byte(match.group("b"))
        if r is None or g is None or b is None:
            continue
        yield _rgb_bytes_to_hex(r, g, b)

    for match in _HSL_COLOR_RE.finditer(html):
        hue = _hue_to_unit(match.group("h"), match.group("hu"))
        sat = _hsl_channel_to_unit(match.group("s"))
        lightness = _hsl_channel_to_unit(match.group("l"))
        if hue is None or sat is None or lightness is None:
            continue
        r, g, b = _hsl_to_rgb(hue, sat, lightness)
        yield _rgb_bytes_to_hex(r, g, b)


def extract_colors_from_html(html: str, *, top_n: int = _DEFAULT_TOP_N) -> list[str]:
    """Return the top-N brandable hex colors from an HTML document.

    Colors are ranked by frequency of occurrence, ties broken by first-seen
    order. Neutrals (near-white, near-black, low-saturation greys) are
    filtered out. Result values are lowercase ``#rrggbb`` strings.
    """
    if not html:
        return []
    counts: Counter[str] = Counter()
    first_seen: dict[str, int] = {}
    for idx, hex6 in enumerate(_iter_hex_colors(html)):
        if not _is_brandable(hex6):
            continue
        counts[hex6] += 1
        first_seen.setdefault(hex6, idx)

    if not counts:
        return []

    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], first_seen[kv[0]]))
    return [f"#{hex6}" for hex6, _ in ranked[:top_n]]


def _iter_stylesheet_hrefs(html: str) -> Iterable[str]:
    """Yield every ``<link rel="stylesheet">`` href in document order.

    Emits duplicates as-is; the downstream caller dedupes after resolving to
    absolute URLs so ``/style.css`` and its already-absolute twin coalesce.
    """
    for match in _LINK_STYLESHEET_RE.finditer(html):
        yield match.group("href")
    for match in _LINK_STYLESHEET_HREF_FIRST_RE.finditer(html):
        yield match.group("href")


def _discover_stylesheet_urls(base_url: str, html: str, *, limit: int = _MAX_STYLESHEETS) -> list[str]:
    """Resolve stylesheet hrefs against ``base_url`` and return the first ``limit`` unique HTTP(S) URLs.

    Skips ``data:`` / ``javascript:`` / mailto schemes and anything that
    isn't http(s). Preserves discovery order so first-in-document stylesheets
    (globals, design tokens) get scanned before late-loaded chrome.
    """
    seen: set[str] = set()
    out: list[str] = []
    for raw_href in _iter_stylesheet_hrefs(html):
        href = raw_href.strip()
        if not href:
            continue
        try:
            absolute = urljoin(base_url, href)
        except Exception:
            continue
        parsed = urlparse(absolute)
        if parsed.scheme not in {"http", "https"}:
            continue
        # Drop the fragment so ``/a.css`` and ``/a.css#x`` collapse; also
        # dedup on the fully-qualified URL so relative + absolute twins
        # don't get fetched twice.
        canonical = absolute.split("#", 1)[0]
        if canonical in seen:
            continue
        seen.add(canonical)
        out.append(canonical)
        if len(out) >= limit:
            break
    return out


async def _fetch_stylesheet_body(client: httpx.AsyncClient, url: str) -> str:
    """Return the decoded CSS body for ``url``, or an empty string on failure.

    Bounded by ``_STYLESHEET_TIMEOUT_S`` per request and
    ``_MAX_STYLESHEET_BYTES`` per body so a single hostile stylesheet can't
    dominate the crawl.
    """
    try:
        resp = await client.get(url, timeout=_STYLESHEET_TIMEOUT_S)
        resp.raise_for_status()
        body = resp.content[:_MAX_STYLESHEET_BYTES]
        return body.decode(resp.encoding or "utf-8", errors="ignore")
    except Exception as exc:
        logger.debug("Brand color stylesheet fetch failed for %s: %s", url, exc)
        return ""


def _extract_colors_from_documents(documents: list[str], *, top_n: int) -> list[str]:
    """Rank colors across a batch of already-fetched documents.

    Runs the single-document counter over each body's yielded colors,
    combining the counts + first-seen positions so the ranking behaves as if
    all documents were concatenated. Preserves per-document iteration so
    each source's brand color still lands early in the first-seen index
    (used only for tie-breaking).
    """
    counts: Counter[str] = Counter()
    first_seen: dict[str, int] = {}
    global_idx = 0
    for document in documents:
        if not document:
            continue
        for hex6 in _iter_hex_colors(document):
            if not _is_brandable(hex6):
                global_idx += 1
                continue
            counts[hex6] += 1
            first_seen.setdefault(hex6, global_idx)
            global_idx += 1

    if not counts:
        return []

    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], first_seen[kv[0]]))
    return [f"#{hex6}" for hex6, _ in ranked[:top_n]]


async def fetch_recommended_colors(url: str, *, top_n: int = _DEFAULT_TOP_N) -> list[str]:
    """Fetch ``url`` and its linked stylesheets, then return the top-N brand colors.

    Discovers up to :data:`_MAX_STYLESHEETS` ``<link rel="stylesheet">`` URLs
    from the fetched HTML, fetches them in parallel through the same client
    (so keep-alive and cookies are reused), then ranks colors across every
    body found. Any per-URL failure is dropped silently — a broken CDN URL
    should never fail the whole crawl.

    Best-effort throughout: an empty homepage, a network error, or a fully
    JS-rendered SPA that returns nothing scannable all fall back to ``[]``.
    """
    if not url:
        return []

    stylesheet_bodies: list[str] = []
    try:
        async with httpx.AsyncClient(
            timeout=_FETCH_TIMEOUT_S,
            follow_redirects=True,
            headers={
                # Some CDNs return an SPA shell to headless UA strings; a
                # plain browser UA gives us the same first-paint HTML the
                # visitor sees, which is where the brand palette lives.
                "User-Agent": ("Mozilla/5.0 (compatible; OyeChatsBrandBot/1.0; +https://www.oyechats.com)"),
                "Accept": "text/html,application/xhtml+xml",
            },
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            body = resp.content[:_MAX_HTML_BYTES]
            html = body.decode(resp.encoding or "utf-8", errors="ignore")

            # Follow linked stylesheets against the redirected final URL so
            # relative hrefs resolve correctly for sites that redirect
            # www ↔ apex or http → https as their first hop.
            stylesheet_urls = _discover_stylesheet_urls(str(resp.url), html)
            if stylesheet_urls:
                stylesheet_bodies = list(
                    await asyncio.gather(
                        *(_fetch_stylesheet_body(client, ss_url) for ss_url in stylesheet_urls),
                    )
                )
                logger.info(
                    "Fetched %d/%d linked stylesheets for %s",
                    sum(1 for b in stylesheet_bodies if b),
                    len(stylesheet_urls),
                    url,
                )
    except Exception as exc:
        logger.warning("Brand color fetch failed for %s: %s", url, exc)
        return []

    colors = _extract_colors_from_documents([html, *stylesheet_bodies], top_n=top_n)
    logger.info("Extracted %d brand colors from %s", len(colors), url)
    return colors
