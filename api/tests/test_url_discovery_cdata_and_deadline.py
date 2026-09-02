"""Two discovery faults found on a real customer site on 2026-09-02.

**A sitemap whose locations are wrapped in CDATA yielded nothing.** The
sitemap spec permits ``<loc><![CDATA[https://...]]></loc>``, and All in One SEO,
the most installed WordPress SEO plugin, emits exactly that on every entry. The
parser's regex required the URL to start immediately after ``<loc>``, so on such
a site it matched zero locations in the index, never fetched a single child
sitemap, and reported one page (the seed) for a site with three hundred. On the
site that surfaced this, nine child sitemaps holding ~300 pages went unread.

**The link-crawl fallback had no wall-clock bound.** Its ``timeout`` was only
aiohttp's per-request budget; the BFS loop itself ran until ``max_fetch`` pages
had been fetched, one after another. On that site it took 33 seconds, so the
preview request, which the frontend abandons at 30, returned its answer to a
client that had already given up, and the customer saw "timeout exceeded" over a
cost box of invented zeros.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from app.services import url_discovery as ud

BASE = "https://www.example-aioseo.test"

INDEX_CDATA = f"""<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc><![CDATA[{BASE}/post-sitemap.xml]]></loc></sitemap>
  <sitemap><loc><![CDATA[{BASE}/page-sitemap.xml]]></loc></sitemap>
</sitemapindex>"""

POSTS_CDATA = f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc><![CDATA[{BASE}/blog/one/]]></loc></url>
  <url><loc><![CDATA[{BASE}/blog/two/]]></loc></url>
  <url><loc>
    <![CDATA[{BASE}/blog/three/]]>
  </loc></url>
</urlset>"""

PAGES_PLAIN = f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>{BASE}/about/</loc></url>
  <url><loc>
    {BASE}/contact/
  </loc></url>
</urlset>"""


def _site(monkeypatch, pages: dict[str, str]):
    """Serve a fake site to the discovery module, recording every fetch."""
    fetched: list[str] = []

    async def fake_fetch(session=None, url=None, **kwargs):
        target = url if url is not None else kwargs.get("url")
        fetched.append(target)
        if target in pages:
            return 200, pages[target]
        return 404, ""

    monkeypatch.setattr(ud, "fetch_text_safely", fake_fetch)
    return fetched


@pytest.mark.asyncio
async def test_cdata_wrapped_locations_are_read(monkeypatch):
    fetched = _site(
        monkeypatch,
        {
            f"{BASE}/robots.txt": f"Sitemap: {BASE}/sitemap.xml\n",
            f"{BASE}/sitemap.xml": INDEX_CDATA,
            f"{BASE}/post-sitemap.xml": POSTS_CDATA,
            f"{BASE}/page-sitemap.xml": PAGES_PLAIN,
        },
    )

    urls = await ud.discover_website_urls(BASE, max_urls=100, timeout=5.0)

    # Both children were actually fetched: the index's CDATA locations resolved.
    assert f"{BASE}/post-sitemap.xml" in fetched
    assert f"{BASE}/page-sitemap.xml" in fetched
    # And the pages inside them, CDATA and plain alike, all came through.
    for path in ("/blog/one/", "/blog/two/", "/blog/three/", "/about/", "/contact/"):
        assert f"{BASE}{path}" in urls, path
    # The seed is guaranteed, so five pages plus it.
    assert len(urls) == 6


@pytest.mark.asyncio
async def test_plain_locations_still_work_exactly_as_before(monkeypatch):
    """The CDATA tolerance must not loosen matching for ordinary sitemaps."""
    _site(
        monkeypatch,
        {
            f"{BASE}/robots.txt": "",
            f"{BASE}/sitemap.xml": PAGES_PLAIN,
        },
    )
    urls = await ud.discover_website_urls(BASE, max_urls=100, timeout=5.0)
    assert f"{BASE}/about/" in urls and f"{BASE}/contact/" in urls


@pytest.mark.asyncio
async def test_cdata_wrapper_never_leaks_into_a_url(monkeypatch):
    """A half-handled CDATA would produce URLs ending in ``]]>``."""
    _site(monkeypatch, {f"{BASE}/robots.txt": "", f"{BASE}/sitemap.xml": POSTS_CDATA})
    urls = await ud.discover_website_urls(BASE, max_urls=100, timeout=5.0)
    assert all("]]" not in u and "CDATA" not in u for u in urls), urls


@pytest.mark.asyncio
async def test_link_crawl_returns_within_its_time_budget(monkeypatch):
    """`timeout` is a wall-clock bound on the whole crawl, not on each request.

    With each page taking half a second and fifty allowed, an unbounded loop
    needs twenty-five seconds. The preview route promises about twenty and the
    browser abandons it at thirty, so partial results inside the budget beat a
    complete answer nobody is waiting for.
    """
    page = "".join(f'<a href="{BASE}/p{i}/">p{i}</a>' for i in range(30))

    async def slow_fetch(session=None, url=None, **kwargs):
        target = url if url is not None else kwargs.get("url")
        if target.endswith("/robots.txt"):
            return 200, ""
        await asyncio.sleep(0.5)
        return 200, page

    monkeypatch.setattr(ud, "fetch_text_safely", slow_fetch)

    started = time.perf_counter()
    urls = await ud.discover_via_links(BASE, max_urls=500, max_depth=3, max_fetch=50, timeout=1.0)
    elapsed = time.perf_counter() - started

    assert elapsed < 2.0, f"took {elapsed:.1f}s against a 1s budget"
    # It stopped early, not empty: whatever it had found so far comes back.
    assert BASE in urls
    assert len(urls) > 1
