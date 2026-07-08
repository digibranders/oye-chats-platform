"""robots.txt Disallow/Allow compliance for both discovery paths (AR-24).

Before this fix, the crawler was sitemap-aware only and never parsed
robots.txt Disallow/User-agent rules — a site owner excluding e.g. /admin/*
via robots.txt had no guarantee that page wouldn't still be crawled,
embedded, and later surfaced via RAG if a stale sitemap or internal link
referenced it.

These tests monkeypatch `fetch_text_safely` directly (the seam both
discovery functions already call through) rather than mocking aiohttp
itself — simpler and just as real a test of the actual filtering logic.
"""

import pytest

import app.services.url_discovery as ud
from app.services.url_discovery import discover_via_links, discover_website_urls

BASE = "https://shop.test"

ROBOTS_DISALLOW_ADMIN = "User-agent: *\nDisallow: /admin/\n"
ROBOTS_DISALLOW_ALL = "User-agent: *\nDisallow: /\n"
ROBOTS_ALLOW_ALL = "User-agent: *\nDisallow:\n"

SITEMAP_XML = """<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shop.test/public/page</loc></url>
  <url><loc>https://shop.test/admin/secret</loc></url>
</urlset>"""


def _fake_fetch(responses: dict[str, tuple[int, str] | None]):
    async def _fetch(session, url, **kwargs):
        for prefix, result in responses.items():
            if url.startswith(prefix):
                return result
        return None

    return _fetch


class TestDiscoverWebsiteUrlsRobotsCompliance:
    @pytest.mark.asyncio
    async def test_disallowed_sitemap_url_is_excluded(self, monkeypatch):
        monkeypatch.setattr(
            ud,
            "fetch_text_safely",
            _fake_fetch(
                {
                    f"{BASE}/robots.txt": (200, ROBOTS_DISALLOW_ADMIN),
                    f"{BASE}/sitemap.xml": (200, SITEMAP_XML),
                }
            ),
        )
        urls = await discover_website_urls(BASE, max_urls=50)

        assert "https://shop.test/public/page" in urls
        assert "https://shop.test/admin/secret" not in urls

    @pytest.mark.asyncio
    async def test_disallowed_seed_url_is_excluded(self, monkeypatch):
        monkeypatch.setattr(
            ud,
            "fetch_text_safely",
            _fake_fetch(
                {
                    f"{BASE}/robots.txt": (200, ROBOTS_DISALLOW_ALL),
                    f"{BASE}/sitemap.xml": (200, ""),
                }
            ),
        )
        urls = await discover_website_urls(f"{BASE}/some-page", max_urls=50)

        assert urls == []

    @pytest.mark.asyncio
    async def test_no_robots_txt_allows_everything(self, monkeypatch):
        """Absence of robots.txt (or a failed fetch) must not accidentally
        block the crawl — RobotFileParser with no rules parsed defaults to
        allow-all, which is correct."""
        monkeypatch.setattr(
            ud,
            "fetch_text_safely",
            _fake_fetch(
                {
                    f"{BASE}/robots.txt": None,  # 404 / fetch failed
                    f"{BASE}/sitemap.xml": (200, SITEMAP_XML),
                }
            ),
        )
        urls = await discover_website_urls(BASE, max_urls=50)

        assert "https://shop.test/public/page" in urls
        assert "https://shop.test/admin/secret" in urls

    @pytest.mark.asyncio
    async def test_explicit_allow_all_permits_everything(self, monkeypatch):
        monkeypatch.setattr(
            ud,
            "fetch_text_safely",
            _fake_fetch(
                {
                    f"{BASE}/robots.txt": (200, ROBOTS_ALLOW_ALL),
                    f"{BASE}/sitemap.xml": (200, SITEMAP_XML),
                }
            ),
        )
        urls = await discover_website_urls(BASE, max_urls=50)

        assert "https://shop.test/public/page" in urls
        assert "https://shop.test/admin/secret" in urls


class TestDiscoverViaLinksRobotsCompliance:
    @pytest.mark.asyncio
    async def test_disallowed_link_is_excluded(self, monkeypatch):
        html = """
            <a href="/public/page">public</a>
            <a href="/admin/secret">admin</a>
        """
        monkeypatch.setattr(
            ud,
            "fetch_text_safely",
            _fake_fetch(
                {
                    f"{BASE}/robots.txt": (200, ROBOTS_DISALLOW_ADMIN),
                    BASE: (200, html),
                }
            ),
        )
        urls = await discover_via_links(BASE, max_urls=50)

        assert "https://shop.test/public/page" in urls
        assert "https://shop.test/admin/secret" not in urls

    @pytest.mark.asyncio
    async def test_disallowed_seed_yields_empty_result(self, monkeypatch):
        monkeypatch.setattr(
            ud,
            "fetch_text_safely",
            _fake_fetch(
                {
                    f"{BASE}/robots.txt": (200, ROBOTS_DISALLOW_ALL),
                }
            ),
        )
        urls = await discover_via_links(BASE, max_urls=50)

        assert urls == []

    @pytest.mark.asyncio
    async def test_no_robots_txt_allows_everything(self, monkeypatch):
        html = '<a href="/admin/secret">admin</a>'
        monkeypatch.setattr(
            ud,
            "fetch_text_safely",
            _fake_fetch(
                {
                    f"{BASE}/robots.txt": None,
                    BASE: (200, html),
                }
            ),
        )
        urls = await discover_via_links(BASE, max_urls=50)

        assert "https://shop.test/admin/secret" in urls
