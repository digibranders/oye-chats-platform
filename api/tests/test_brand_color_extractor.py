"""Unit tests for the CSS-based brand color extractor."""

from __future__ import annotations

import httpx
import pytest

from app.services.brand_color_extractor import (
    extract_colors_from_html,
    fetch_recommended_colors,
)


def test_returns_empty_for_empty_input():
    assert extract_colors_from_html("") == []


def test_extracts_hex_from_style_block():
    html = """
    <html><head><style>
      :root { --brand: #0F172A; --accent: #59C5ED; }
      .btn { background: #0F172A; color: #ffffff; }
      body { background: #000000; }
    </style></head><body></body></html>
    """
    result = extract_colors_from_html(html)
    # Neutrals filtered (#ffffff white, #000000 black); brand + accent kept.
    assert "#0f172a" in result
    assert "#59c5ed" in result
    assert "#ffffff" not in result
    assert "#000000" not in result


def test_extracts_hex_from_inline_style_attribute():
    html = '<div style="color:#e11d48"><span style="background: #F59E0B">x</span></div>'
    result = extract_colors_from_html(html)
    assert "#e11d48" in result
    assert "#f59e0b" in result


def test_expands_short_hex():
    html = "<style>.a { color: #abc; }</style>"
    result = extract_colors_from_html(html)
    assert "#aabbcc" in result


def test_ranks_by_frequency_then_first_seen():
    html = """
    <style>
      .a { color: #ff0000; }
      .b { color: #00aa00; }
      .c { color: #ff0000; background: #ff0000; }
    </style>
    """
    result = extract_colors_from_html(html, top_n=2)
    # #ff0000 appears 3x, #00aa00 once. Red should rank first.
    assert result[0] == "#ff0000"
    assert result[1] == "#00aa00"


def test_filters_near_neutrals():
    html = """
    <style>
      body { color: #f8f8f8; background: #111111; border: 1px solid #cccccc; }
      .a { color: #808080; }
    </style>
    """
    # All four are low-saturation greys, nothing should survive the filter.
    assert extract_colors_from_html(html) == []


def test_top_n_caps_result_length():
    html = "<style>" + "".join(f".c{i} {{ color: #{i:02x}00{255 - i:02x}; }}" for i in range(20)) + "</style>"
    assert len(extract_colors_from_html(html, top_n=6)) == 6


def test_extracts_rgb_legacy_comma_form():
    html = "<style>.a { color: rgb(225, 29, 72); background: rgba(245, 158, 11, 0.9); }</style>"
    result = extract_colors_from_html(html)
    assert "#e11d48" in result  # rgb(225, 29, 72)
    assert "#f59e0b" in result  # rgba alpha ignored


def test_extracts_rgb_modern_space_form_with_slash_alpha():
    html = "<style>.a { color: rgb(15 23 42 / 0.75); }</style>"
    result = extract_colors_from_html(html)
    assert "#0f172a" in result


def test_extracts_rgb_percentage_components():
    # 100% 0% 50% → #ff0080. Percentages are Color Level 4 spec.
    html = "<style>.a { color: rgb(100%, 0%, 50%); }</style>"
    result = extract_colors_from_html(html)
    assert "#ff0080" in result


def test_extracts_hsl_and_hsla():
    # HSL(0, 100%, 50%) = pure red. HSL(210, 50%, 50%) resolves to a slate
    # blue whose green channel is 127.4999…. Float-precision rounding lands
    # on ``0x7f`` rather than ``0x80``, which is fine for palette seeding.
    html = "<style>.a { color: hsl(0, 100%, 50%); } .b { color: hsla(210 50% 50% / 0.6); }</style>"
    result = extract_colors_from_html(html)
    assert "#ff0000" in result
    assert "#407fbf" in result


def test_extracts_hsl_with_turn_hue_unit():
    # 0.5turn = 180deg = cyan at full saturation.
    html = "<style>.a { color: hsl(0.5turn 100% 50%); }</style>"
    result = extract_colors_from_html(html)
    assert "#00ffff" in result


def test_dedupes_hex_and_rgb_pointing_at_same_color():
    # #0F172A and rgb(15, 23, 42) are the same slate. Should collide as one
    # entry in the counter rather than split the ranking signal.
    html = """
    <style>
      :root { --brand: #0F172A; }
      .a { color: rgb(15, 23, 42); }
      .b { background: #00aa00; }
    </style>
    """
    result = extract_colors_from_html(html, top_n=2)
    assert result[0] == "#0f172a"  # 2 hits vs 1 for green
    assert result[1] == "#00aa00"


def test_ignores_malformed_rgb():
    # Missing channels, garbage tokens. Must not throw or emit anything.
    html = "<style>.a { color: rgb(1, 2); background: rgb(foo, bar, baz); }</style>"
    assert extract_colors_from_html(html) == []


_RealAsyncClient = httpx.AsyncClient  # captured before any monkeypatch


@pytest.mark.asyncio
async def test_fetch_returns_empty_on_network_error(monkeypatch):
    def boom(_req):
        raise httpx.ConnectError("boom")

    transport = httpx.MockTransport(boom)

    def fake_client(*args, **kwargs):
        kwargs.pop("transport", None)
        return _RealAsyncClient(transport=transport, timeout=1.0)

    monkeypatch.setattr("app.services.brand_color_extractor.httpx.AsyncClient", fake_client)
    result = await fetch_recommended_colors("https://example.test")
    assert result == []


@pytest.mark.asyncio
async def test_fetch_extracts_colors_from_live_response(monkeypatch):
    html = """
    <html><head><style>:root{--brand:#0F172A;} .a{color:#59C5ED;}</style></head></html>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=html.encode("utf-8"), headers={"content-type": "text/html"})

    transport = httpx.MockTransport(handler)

    def fake_client(*args, **kwargs):
        kwargs.pop("transport", None)
        return _RealAsyncClient(transport=transport, timeout=1.0)

    monkeypatch.setattr("app.services.brand_color_extractor.httpx.AsyncClient", fake_client)
    result = await fetch_recommended_colors("https://example.test")
    assert "#0f172a" in result
    assert "#59c5ed" in result


@pytest.mark.asyncio
async def test_fetch_returns_empty_for_empty_url():
    assert await fetch_recommended_colors("") == []


@pytest.mark.asyncio
async def test_fetch_follows_linked_stylesheets(monkeypatch):
    # Homepage lists brand color only in a linked stylesheet. Before this
    # feature ``fetch_recommended_colors`` would return ``[]``.
    html = """
    <html><head>
      <link rel="stylesheet" href="/theme.css">
      <link rel="preload" href="/late.js" as="script">
    </head><body></body></html>
    """
    theme_css = ":root { --brand: #7c3aed; } .btn { background: rgb(6, 182, 212); }"

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/theme.css":
            return httpx.Response(200, content=theme_css.encode("utf-8"), headers={"content-type": "text/css"})
        return httpx.Response(200, content=html.encode("utf-8"), headers={"content-type": "text/html"})

    transport = httpx.MockTransport(handler)

    def fake_client(*args, **kwargs):
        kwargs.pop("transport", None)
        return _RealAsyncClient(transport=transport, timeout=1.0)

    monkeypatch.setattr("app.services.brand_color_extractor.httpx.AsyncClient", fake_client)
    result = await fetch_recommended_colors("https://example.test")
    assert "#7c3aed" in result  # from CSS custom property
    assert "#06b6d4" in result  # from rgb(...) in the same stylesheet


@pytest.mark.asyncio
async def test_fetch_survives_stylesheet_error(monkeypatch):
    # A 404 on a linked stylesheet must not break the whole extraction.
    # Colors from the homepage still come through.
    html = """
    <html><head>
      <link rel="stylesheet" href="/missing.css">
      <style>.a { color: #ec4899; }</style>
    </head></html>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/missing.css":
            return httpx.Response(404, content=b"nope")
        return httpx.Response(200, content=html.encode("utf-8"), headers={"content-type": "text/html"})

    transport = httpx.MockTransport(handler)

    def fake_client(*args, **kwargs):
        kwargs.pop("transport", None)
        return _RealAsyncClient(transport=transport, timeout=1.0)

    monkeypatch.setattr("app.services.brand_color_extractor.httpx.AsyncClient", fake_client)
    result = await fetch_recommended_colors("https://example.test")
    assert "#ec4899" in result


@pytest.mark.asyncio
async def test_fetch_caps_stylesheet_count(monkeypatch):
    # 6 stylesheets declared → only the first 4 should be fetched. Verified
    # by tracking which /style-N.css paths hit the transport.
    from app.services import brand_color_extractor as ext

    links = "\n".join(f'<link rel="stylesheet" href="/s{i}.css">' for i in range(6))
    html = f"<html><head>{links}</head></html>"
    hit_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith(".css"):
            hit_paths.append(path)
            return httpx.Response(200, content=b".a{color:#123456;}", headers={"content-type": "text/css"})
        return httpx.Response(200, content=html.encode("utf-8"), headers={"content-type": "text/html"})

    transport = httpx.MockTransport(handler)

    def fake_client(*args, **kwargs):
        kwargs.pop("transport", None)
        return _RealAsyncClient(transport=transport, timeout=1.0)

    monkeypatch.setattr("app.services.brand_color_extractor.httpx.AsyncClient", fake_client)
    await fetch_recommended_colors("https://example.test")
    assert len(hit_paths) == ext._MAX_STYLESHEETS


@pytest.mark.asyncio
async def test_fetch_resolves_relative_hrefs_against_final_redirect(monkeypatch):
    # Homepage redirects apex → www; a relative ``/theme.css`` must resolve
    # against the final host (``www.example.test``) not the requested one.
    theme_css = ".btn { color: hsl(280, 70%, 50%); }"  # → #9926d9-ish
    hit_hosts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hit_hosts.append(request.url.host)
        if request.url.host == "example.test" and request.url.path == "/":
            return httpx.Response(301, headers={"location": "https://www.example.test/"})
        if request.url.host == "www.example.test" and request.url.path == "/":
            return httpx.Response(
                200,
                content=b'<html><head><link rel="stylesheet" href="/theme.css"></head></html>',
                headers={"content-type": "text/html"},
            )
        if request.url.host == "www.example.test" and request.url.path == "/theme.css":
            return httpx.Response(200, content=theme_css.encode("utf-8"), headers={"content-type": "text/css"})
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)

    def fake_client(*args, **kwargs):
        # Preserve the caller's ``follow_redirects=True`` so the 301 to the
        # www host is actually followed. The other fake_client shims in this
        # module don't need it because they never redirect.
        kwargs.pop("transport", None)
        kwargs.setdefault("follow_redirects", True)
        kwargs.setdefault("timeout", 1.0)
        return _RealAsyncClient(transport=transport, **kwargs)

    monkeypatch.setattr("app.services.brand_color_extractor.httpx.AsyncClient", fake_client)
    result = await fetch_recommended_colors("https://example.test")
    # The stylesheet was fetched from the www host (post-redirect).
    assert "www.example.test" in hit_hosts
    # And at least one non-neutral color came through.
    assert result != []
