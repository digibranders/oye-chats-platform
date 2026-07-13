"""Brand color extraction from a website's homepage HTML.

The crawl providers (Spider, Jina) return page bodies as markdown, which
strips CSS and inline styles — the only signal we ever had for a customer's
palette. This module recovers it by fetching the seed URL's raw HTML once
and pulling hex colors out of ``<style>`` blocks, inline ``style=""``
attributes, ``<meta name="theme-color">``, and SVG fill/stroke attributes.

Cheap and deterministic: no LLM, no headless browser, one HTTP GET.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from collections.abc import Iterable

import httpx

logger = logging.getLogger(__name__)

_FETCH_TIMEOUT_S = 10.0
_MAX_HTML_BYTES = 2 * 1024 * 1024  # 2 MB is plenty for a marketing homepage
_DEFAULT_TOP_N = 6

# Match #RGB, #RRGGBB (with or without leading `color:`/`background:` context).
# We deliberately do not try to parse rgb()/hsl() — CSS custom-property setups
# nearly always expose the same brand colors as literal hex somewhere in the
# same stylesheet (variable definitions, gradient stops, meta tags).
_HEX_COLOR_RE = re.compile(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b")

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


def _iter_hex_colors(html: str) -> Iterable[str]:
    for match in _HEX_COLOR_RE.finditer(html):
        yield _expand_short_hex(match.group(1))


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


async def fetch_recommended_colors(url: str, *, top_n: int = _DEFAULT_TOP_N) -> list[str]:
    """Fetch ``url`` once and return the top-N brandable colors from its HTML.

    Best-effort — any network / decoding error returns ``[]`` so a broken
    homepage never fails a crawl. Body is truncated at 2 MB.
    """
    if not url:
        return []
    try:
        async with httpx.AsyncClient(
            timeout=_FETCH_TIMEOUT_S,
            follow_redirects=True,
            headers={
                # Some CDNs return an SPA shell to headless UA strings; a
                # plain browser UA gives us the same first-paint HTML the
                # visitor sees, which is where the brand palette lives.
                "User-Agent": ("Mozilla/5.0 (compatible; OyeChatsBrandBot/1.0; +https://oyechats.com)"),
                "Accept": "text/html,application/xhtml+xml",
            },
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            body = resp.content[:_MAX_HTML_BYTES]
            html = body.decode(resp.encoding or "utf-8", errors="ignore")
    except Exception as exc:
        logger.warning("Brand color fetch failed for %s: %s", url, exc)
        return []

    colors = extract_colors_from_html(html, top_n=top_n)
    logger.info("Extracted %d brand colors from %s", len(colors), url)
    return colors
