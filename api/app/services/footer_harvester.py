"""Footer-only media harvest (Phase 1. Log-only).

Runs a targeted scrape of the crawl root to isolate the page's ``<footer>``
and ``[role=contentinfo]`` regions, then extracts any YouTube channel URLs,
individual video URLs, and downloadable file URLs that live there. Almost
every business site puts its channel link, brochure PDF, or social handles
in the footer, but the main crawl passes markdown through
``readability: true``, which heuristically drops those regions on many
pages. This side channel guarantees they are inspected even when the main
crawl's markdown scrubs them out.

Phase 1 is log-only: the returned media dict is emitted to the crawl log
so we can eyeball a few real customer sites before wiring it into the
ingest pipeline. Every failure mode returns an empty dict silently. This
must never abort a real crawl, and the orchestrator's 30s wait cap keeps
a hung Spider scrape from ever delaying the crawl's completion.
"""

from __future__ import annotations

import asyncio
import logging

from bs4 import BeautifulSoup

from app.ingestion.cleaner import extract_media_urls
from app.ingestion.youtube_metadata import (
    enrich_media_urls_with_channel_videos,
    enrich_media_urls_with_metadata,
)
from app.services.spider_service import fetch_html

logger = logging.getLogger(__name__)

# CSS selectors that reliably identify the footer region across the sites we
# see in the wild. Ordered from strongest signal to weakest so the seen-set
# dedup below can't be tricked by a broad class matching before the semantic
# element does.
#   * ``footer`` / ``[role=contentinfo]``. HTML5-native + ARIA landmark
#   * ``.site-footer`` / ``#site-footer``. Convention on modern themes
#   * ``#footer`` / ``.footer`` (generic legacy
#   * ``#colophon``) WordPress default (baked into the Twenty-* themes and
#     inherited by a huge share of the WP long tail)
#   * ``.site-info`` (Genesis / older WordPress starter themes
#   * ``#SITE_FOOTER``) Wix
#   * ``#page-footer`` / ``.page-footer``. Bootstrap-derived layouts
_FOOTER_SELECTORS = (
    "footer",
    "[role=contentinfo]",
    ".site-footer",
    "#site-footer",
    "#footer",
    ".footer",
    "#colophon",
    ".site-info",
    "#SITE_FOOTER",
    "#page-footer",
    ".page-footer",
)


def _extract_footer_text(html: str) -> str:
    """Return the concatenated visible text of every footer-shaped region.

    Uses BeautifulSoup to locate elements matching :data:`_FOOTER_SELECTORS`
    and joins their ``get_text`` output with a newline. Anchor ``href`` values
    are inlined into the text so ``extract_media_urls`` can regex-match URLs
    that live only inside ``<a href="…">…</a>`` (visible text alone would lose
    them). Duplicate regions (footer nested inside a container that also
    matches) are collapsed via a seen-set of element ids.
    """
    if not html:
        return ""

    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        logger.debug("footer_harvester: HTML parse failed", exc_info=True)
        return ""

    seen: set[int] = set()
    parts: list[str] = []
    for selector in _FOOTER_SELECTORS:
        try:
            matches = soup.select(selector)
        except Exception:
            continue
        for element in matches:
            marker = id(element)
            if marker in seen:
                continue
            seen.add(marker)
            # Inline every anchor's href so URL regexes can find them. Without
            # this, a footer like ``<a href="youtube.com/@brand">YouTube</a>``
            # would only surface the word "YouTube" in the extracted text and
            # the channel URL would be lost.
            for anchor in element.find_all("a", href=True):
                href = anchor.get("href")
                if isinstance(href, str) and href:
                    anchor.insert_after(f" {href} ")
            parts.append(element.get_text(separator="\n", strip=True))
    return "\n".join(p for p in parts if p)


async def harvest_footer_media(root_url: str) -> dict:
    """Fetch the footer of ``root_url`` and return the media URLs it references.

    Return shape mirrors :func:`extract_media_urls` (``youtube``, ``files``,
    ``youtube_channels`` keys. Omitted when empty) with YouTube channels
    already expanded into per-video entries via
    :func:`enrich_media_urls_with_channel_videos` and each video annotated
    with title/duration via :func:`enrich_media_urls_with_metadata`.

    Returns an empty dict on any failure (missing API key, HTTP error, HTML
    parse failure, no footer region found, no media URLs in the footer).
    Never raises, the caller is a background task and a footer scrape must
    never abort or fail a real crawl.
    """
    if not root_url:
        return {}

    html = await fetch_html(root_url)
    if not html:
        return {}

    footer_text = _extract_footer_text(html)
    if not footer_text:
        return {}

    media = extract_media_urls(footer_text)
    if not media:
        return {}

    # Expand any captured channel URLs into their full video lists BEFORE the
    # metadata pass so newly-discovered videos also get title + duration
    # filled in. Both helpers are best-effort and mutate ``media`` in place.
    #
    # Off-thread via ``asyncio.to_thread`` because the underlying enrichers
    # use synchronous ``urllib.urlopen``. Up to 1 channel-page fetch plus
    # 50 per-video watch-page fetches, each bounded by ``_TIMEOUT_SECONDS``.
    # Running that on the event loop would freeze the concurrent main
    # crawl's per-page callbacks, its ``crawl_heartbeat`` ticks (the
    # stall-reaper wakes on missed ticks), and the streaming ingest
    # consumer. On the executor pool the same work runs alongside without
    # any of that damage; failure modes remain the enrichers' silent
    # in-place no-op.
    await asyncio.to_thread(enrich_media_urls_with_channel_videos, media)
    await asyncio.to_thread(enrich_media_urls_with_metadata, media)
    return media
