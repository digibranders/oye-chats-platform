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
    # #ff0000 appears 3x, #00aa00 once — red should rank first.
    assert result[0] == "#ff0000"
    assert result[1] == "#00aa00"


def test_filters_near_neutrals():
    html = """
    <style>
      body { color: #f8f8f8; background: #111111; border: 1px solid #cccccc; }
      .a { color: #808080; }
    </style>
    """
    # All four are low-saturation greys — nothing should survive the filter.
    assert extract_colors_from_html(html) == []


def test_top_n_caps_result_length():
    html = "<style>" + "".join(f".c{i} {{ color: #{i:02x}00{255 - i:02x}; }}" for i in range(20)) + "</style>"
    assert len(extract_colors_from_html(html, top_n=6)) == 6


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
