"""Unit tests for the favicon / app-icon extractor used to auto-set bot avatars."""

from __future__ import annotations

import io

from PIL import Image

from app.services.favicon_extractor import (
    _decode_is_valid_image,
    _discover_icon_urls,
    _is_svg_candidate,
    _largest_declared_size,
)


def test_largest_declared_size_parses_tokens():
    assert _largest_declared_size("180x180") == 180
    assert _largest_declared_size("16x16 32x32") == 32
    # "any" (scalable, usually SVG) and garbage yield 0 so sized icons win.
    assert _largest_declared_size("any") == 0
    assert _largest_declared_size(None) == 0
    assert _largest_declared_size("garbage") == 0


def test_is_svg_candidate_detects_svg():
    assert _is_svg_candidate("/icon.svg", None) is True
    assert _is_svg_candidate("/icon", "image/svg+xml") is True
    assert _is_svg_candidate("/icon.png", "image/png") is False


def test_discover_ranks_apple_icon_first_and_skips_svg():
    html = """
    <html><head>
      <link rel="icon" type="image/png" sizes="32x32" href="/fav-32.png">
      <link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="shortcut icon" href="favicon.ico">
      <link rel="mask-icon" href="/mask.svg">
    </head></html>
    """
    urls = _discover_icon_urls("https://example.com/", html)
    # Apple touch icon ranks first; the declared-size PNG beats the shortcut icon.
    assert urls[0] == "https://example.com/apple.png"
    assert urls[1] == "https://example.com/fav-32.png"
    # SVG and mask-icon entries are dropped entirely (Pillow can't rasterize them).
    assert not any(u.endswith(".svg") for u in urls)
    # Root fallbacks are always appended.
    assert "https://example.com/apple-touch-icon.png" in urls


def test_discover_appends_root_fallbacks_when_no_icons_declared():
    urls = _discover_icon_urls("https://shop.example.com/home", "<html><head></head></html>")
    assert urls == [
        "https://shop.example.com/apple-touch-icon.png",
        "https://shop.example.com/favicon.ico",
    ]


def test_discover_dedupes_repeated_urls():
    html = """
    <html><head>
      <link rel="icon" href="/favicon.ico">
      <link rel="shortcut icon" href="/favicon.ico">
    </head></html>
    """
    urls = _discover_icon_urls("https://example.com/", html)
    assert urls.count("https://example.com/favicon.ico") == 1


def test_decode_is_valid_image_accepts_real_png_rejects_junk():
    buf = io.BytesIO()
    Image.new("RGBA", (64, 64), (10, 20, 30, 255)).save(buf, format="PNG")
    assert _decode_is_valid_image(buf.getvalue()) is True
    # An HTML error page served for a missing icon path must be rejected.
    assert _decode_is_valid_image(b"<!doctype html><html>not found</html>") is False


def test_decode_rejects_too_small_image():
    buf = io.BytesIO()
    Image.new("RGBA", (8, 8), (0, 0, 0, 255)).save(buf, format="PNG")
    # 8x8 is below the 16px floor — a tracking pixel, not a usable avatar.
    assert _decode_is_valid_image(buf.getvalue()) is False
