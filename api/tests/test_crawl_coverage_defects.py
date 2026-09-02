"""Regression guards for the crawl pipeline's silent content-loss defects.

Each test here pins one way a crawl used to report success while quietly
dropping the customer's pages: a link-only index page cleaned to nothing, a
discovery filter that matched on a bare path prefix, a fallback provider
outage that discarded a partially-successful crawl, and a terminal payload
that reported every page *fetched* as a page the chatbot had read.
"""

from __future__ import annotations

import pytest

from app.ingestion.cleaner import clean_text
from app.services.url_discovery import _is_html_url

# ── Defect 7: link-list pages must keep their anchor text ────────────────────


def test_a_product_index_page_survives_cleaning():
    """A 40-item product index is a list of nothing but links.

    Dropping every pure-link line cleaned the page to '', the pipeline's
    ``if not chunks: continue`` skipped it with no log and no counter, and a
    visitor asking "what do you sell?" got nothing.
    """
    markdown = "\n".join(
        [
            "# Our Products",
            "* [Acme Widget Pro](/products/widget-pro)",
            "* [Acme Widget Mini](/products/widget-mini)",
            "- [Acme Gearbox 5000](/products/gearbox-5000)",
            "[Acme Torque Wrench](/products/torque-wrench)",
        ]
    )
    result = clean_text(markdown)
    assert result.strip(), "a page of links must not clean to nothing"
    for label in ("Acme Widget Pro", "Acme Widget Mini", "Acme Gearbox 5000", "Acme Torque Wrench"):
        assert label in result
    # The URL itself is still noise. Only the label is knowledge.
    assert "/products/widget-pro" not in result
    assert "](" not in result


def test_a_link_only_pipe_row_keeps_its_labels():
    text = "| [Enterprise Plan](/enterprise) | [Team Plan](/team) |\nReal content."
    result = clean_text(text)
    assert "Enterprise Plan" in result and "Team Plan" in result
    assert "/enterprise" not in result


def test_an_empty_anchor_line_is_still_dropped():
    """A label-less link carries no knowledge; it must not leave a stray line."""
    assert clean_text("* []( /nowhere )\nReal content.").strip() == "Real content."


# ── Defect 8: discovery skiplist must not prefix-match real pages ────────────


@pytest.mark.parametrize(
    "path",
    ["/feedback", "/rss-guide", "/atomic-habits", "/sitemapping", "/feeds-for-beginners", "/atomics"],
)
def test_real_pages_are_not_dropped_by_the_feed_skiplist(path: str):
    assert _is_html_url(f"https://acme.test{path}") is True


@pytest.mark.parametrize(
    "path",
    ["/feed", "/rss", "/atom", "/sitemap", "/wp-json", "/feed/", "/wp-json/wp/v2/posts", "/sitemap-0", "/sitemap1"],
)
def test_feeds_and_sitemaps_are_still_dropped(path: str):
    assert _is_html_url(f"https://acme.test{path}") is False


# ── Defect 9: the coverage shortfall must be measured before truncation ──────


@pytest.mark.asyncio
async def test_discovery_reports_what_it_found_before_the_cap(monkeypatch):
    """``total_found`` counts every qualifying page, the returned list is capped.

    The crawl's headline "N more pages were discovered but didn't fit your
    plan's cap" was computed from the already-truncated list, so it was
    structurally always zero and the customer was never told.
    """
    import app.services.url_discovery as ud

    base = "https://big.test"
    locs = "".join(f"<url><loc>{base}/p{i}</loc></url>" for i in range(40))
    sitemap = f'<?xml version="1.0"?><urlset>{locs}</urlset>'

    async def fake_fetch(session=None, url=None, **kwargs):
        if url.endswith("/robots.txt"):
            return (200, "User-agent: *\nDisallow:\n")
        if url.endswith("/sitemap.xml"):
            return (200, sitemap)
        return None

    monkeypatch.setattr(ud, "fetch_text_safely", fake_fetch)

    # Sitemaps are fetched as bytes now; serve the same fake through that seam.
    async def fake_fetch_bytes(session=None, url=None, **kwargs):
        result = await fake_fetch(session=session, url=url, **kwargs)
        return None if result is None else (result[0], result[1].encode("utf-8"))

    monkeypatch.setattr(ud, "fetch_bytes_safely", fake_fetch_bytes)

    stats: dict = {}
    urls = await ud.discover_website_urls(base, max_urls=5, stats=stats)

    assert len(urls) == 5, "the returned list is still capped"
    # 40 sitemap pages + the guaranteed seed URL.
    assert stats["total_found"] == 41
