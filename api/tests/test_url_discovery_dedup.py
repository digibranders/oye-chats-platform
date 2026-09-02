"""Discovery counted one page twice when it appeared in two spellings.

Found on a real customer site on 2026-09-02: the customer typed
``https://www.example.com`` and the site's sitemap listed the homepage as
``https://example.com/``. The sitemap loop and the seed guarantee both keyed
their "seen" set on the raw string, so both spellings were admitted, the
console reported 339 pages found, and the page tree (which groups by path)
offered 338. Nothing was crawled twice, but a number the customer reads as a
count of their pages was off by one, and the two figures on one card disagreed.

The link-scan phase already keyed on :func:`normalize_url`; the sitemap phase
now does the same.
"""

from __future__ import annotations

import pytest

from app.services import url_discovery as ud

BASE = "https://www.example-dedup.test"
BARE = "https://example-dedup.test"


def _site(monkeypatch, pages: dict[str, str]) -> None:
    async def fake_fetch(session=None, url=None, **kwargs):
        target = url if url is not None else kwargs.get("url")
        return (200, pages[target]) if target in pages else (404, "")

    async def fake_fetch_bytes(session=None, url=None, **kwargs):
        target = url if url is not None else kwargs.get("url")
        return (200, pages[target].encode("utf-8")) if target in pages else (404, b"")

    monkeypatch.setattr(ud, "fetch_text_safely", fake_fetch)
    monkeypatch.setattr(ud, "fetch_bytes_safely", fake_fetch_bytes)


def _urlset(*locs: str) -> str:
    body = "".join(f"<url><loc>{loc}</loc></url>" for loc in locs)
    return f'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{body}</urlset>'


@pytest.mark.asyncio
async def test_seed_and_sitemap_homepage_in_different_spellings_count_once(monkeypatch):
    _site(
        monkeypatch,
        {
            f"{BASE}/robots.txt": "",
            f"{BASE}/sitemap.xml": _urlset(f"{BARE}/about/", f"{BARE}/", f"{BARE}/contact/"),
        },
    )
    stats: dict = {}
    urls = await ud.discover_website_urls(BASE, max_urls=100, timeout=5.0, stats=stats)

    homepages = [u for u in urls if ud.normalize_url(u) == ud.normalize_url(BASE)]
    assert len(homepages) == 1, urls
    assert len(urls) == 3
    # The figure the console shows as "Pages found" agrees with the list.
    assert stats["total_found"] == 3


@pytest.mark.asyncio
async def test_seed_without_slash_and_sitemap_homepage_with_slash_count_once(monkeypatch):
    """The customer retyped the address without ``www`` and saw the same gap."""
    _site(
        monkeypatch,
        {
            f"{BARE}/robots.txt": "",
            f"{BARE}/sitemap.xml": _urlset(f"{BARE}/about/", f"{BARE}/"),
        },
    )
    stats: dict = {}
    urls = await ud.discover_website_urls(BARE, max_urls=100, timeout=5.0, stats=stats)
    assert urls == [f"{BARE}/", f"{BARE}/about/"]
    assert stats["total_found"] == 2


@pytest.mark.asyncio
async def test_the_homepage_still_comes_first_when_the_sitemap_lists_it_elsewhere(monkeypatch):
    """The crawl bills in list order, so a small budget must reach the homepage first.

    The seed guarantee used to achieve that by inserting the typed URL at
    index 0. Now that the sitemap's spelling of the same page is recognised as
    the same page, that spelling has to move to the front instead.
    """
    _site(
        monkeypatch,
        {
            f"{BASE}/robots.txt": "",
            f"{BASE}/sitemap.xml": _urlset(f"{BARE}/about/", f"{BARE}/contact/", f"{BARE}/"),
        },
    )
    urls = await ud.discover_website_urls(BASE, max_urls=100, timeout=5.0)
    assert ud.normalize_url(urls[0]) == ud.normalize_url(BASE)
    assert urls == [f"{BARE}/", f"{BARE}/about/", f"{BARE}/contact/"]


@pytest.mark.asyncio
async def test_a_seed_absent_from_the_sitemap_is_still_inserted_first(monkeypatch):
    _site(
        monkeypatch,
        {
            f"{BASE}/robots.txt": "",
            f"{BASE}/sitemap.xml": _urlset(f"{BARE}/about/", f"{BARE}/contact/"),
        },
    )
    stats: dict = {}
    urls = await ud.discover_website_urls(BASE, max_urls=100, timeout=5.0, stats=stats)
    assert urls == [BASE, f"{BARE}/about/", f"{BARE}/contact/"]
    assert stats["total_found"] == 3


@pytest.mark.asyncio
async def test_trailing_slash_and_tracking_variants_inside_one_sitemap_count_once(monkeypatch):
    _site(
        monkeypatch,
        {
            f"{BASE}/robots.txt": "",
            f"{BASE}/sitemap.xml": _urlset(
                f"{BARE}/pricing",
                f"{BARE}/pricing/",
                f"{BARE}/pricing/?utm_source=sitemap",
                f"{BARE}/faq/",
            ),
        },
    )
    stats: dict = {}
    urls = await ud.discover_website_urls(BASE, max_urls=100, timeout=5.0, stats=stats)
    # The seed, one pricing page (first spelling kept), and the FAQ.
    assert urls == [BASE, f"{BARE}/pricing", f"{BARE}/faq/"]
    assert stats["total_found"] == 3


@pytest.mark.asyncio
async def test_a_variant_past_the_cap_does_not_inflate_the_found_count(monkeypatch):
    """Counting past the cap must use the same notion of "a page" as collecting."""
    _site(
        monkeypatch,
        {
            f"{BASE}/robots.txt": "",
            f"{BASE}/sitemap.xml": _urlset(f"{BARE}/a/", f"{BARE}/b/", f"{BARE}/a", f"{BARE}/c/"),
        },
    )
    stats: dict = {}
    urls = await ud.discover_website_urls(BASE, max_urls=2, timeout=5.0, stats=stats)
    assert len(urls) == 2
    # a, b, c and the seed: four pages, not five.
    assert stats["total_found"] == 4
