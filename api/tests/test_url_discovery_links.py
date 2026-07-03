"""Unit tests for the browser-free same-domain link extractor used by the
sitemap-less crawl fallback (``discover_via_links``)."""

from app.services.url_discovery import _extract_links

BASE = "https://shop.test"
NETLOC = "shop.test"


def test_resolves_relative_and_absolute_same_domain_links():
    html = """
        <a href="/about">About</a>
        <a href="products/1">Product</a>
        <a href="https://shop.test/contact">Contact</a>
    """
    links = _extract_links(BASE, html, NETLOC)
    assert links == [
        "https://shop.test/about",
        "https://shop.test/products/1",
        "https://shop.test/contact",
    ]


def test_drops_off_domain_links():
    html = '<a href="https://evil.test/steal">x</a><a href="https://other.test/y">y</a><a href="/keep">k</a>'
    assert _extract_links(BASE, html, NETLOC) == ["https://shop.test/keep"]


def test_strips_www_when_matching_host():
    html = '<a href="https://www.shop.test/team">team</a>'
    assert _extract_links(BASE, html, NETLOC) == ["https://www.shop.test/team"]


def test_drops_binary_assets_and_feeds():
    html = """
        <a href="/brochure.pdf">pdf</a>
        <a href="/logo.png">img</a>
        <a href="/sitemap.xml">map</a>
        <a href="/feed">feed</a>
        <a href="/real-page">page</a>
    """
    assert _extract_links(BASE, html, NETLOC) == ["https://shop.test/real-page"]


def test_drops_non_http_schemes():
    html = '<a href="mailto:hi@shop.test">mail</a><a href="tel:+100">call</a><a href="/ok">ok</a>'
    assert _extract_links(BASE, html, NETLOC) == ["https://shop.test/ok"]


def test_dedupes_on_normalized_form():
    # Fragment, trailing slash, and tracking param collapse to one URL.
    html = """
        <a href="/pricing">a</a>
        <a href="/pricing/">b</a>
        <a href="/pricing#plans">c</a>
        <a href="/pricing?utm_source=nav">d</a>
    """
    assert _extract_links(BASE, html, NETLOC) == ["https://shop.test/pricing"]


def test_ignores_fragment_only_and_empty_hrefs():
    html = '<a href="#top">top</a><a href="">empty</a><a href="/x">x</a>'
    assert _extract_links(BASE, html, NETLOC) == ["https://shop.test/x"]


def test_handles_single_quoted_and_uppercase_attributes():
    html = "<A HREF='/loud'>LOUD</A>"
    assert _extract_links(BASE, html, NETLOC) == ["https://shop.test/loud"]
