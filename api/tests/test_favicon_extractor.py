"""Unit tests for the favicon / app-icon extractor used to auto-set bot avatars."""

from __future__ import annotations

import io

import pytest
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


# ── The network-facing half, which had no tests at all ──────────────────────
#
# The original fetcher rolled its own httpx client and got all three guards
# wrong: `follow_redirects=True` (so a customer's site could 302 the crawl
# worker into the VPC), `validate_public_url` on the pre-redirect URL only,
# and a size cap applied to `resp.content` AFTER the whole body was buffered.
# Its 83-line test file covered only the four pure helpers.


class TestItUsesTheSharedSsrfHelpers:
    """The fix is structural — reuse `core/ssrf`, which already does per-hop
    revalidation and pins DNS — so the test is structural too."""

    def test_it_does_not_build_its_own_http_client(self):
        import inspect

        from app.services import favicon_extractor

        source = inspect.getsource(favicon_extractor)
        # Only the docstring explaining what was removed may mention httpx.
        code = "\n".join(line for line in source.splitlines() if not line.strip().startswith("#"))
        assert "httpx.AsyncClient" not in code, (
            "a hand-rolled client bypasses the per-hop redirect revalidation and DNS pinning"
        )
        assert "follow_redirects" not in code.replace("``follow_redirects=True``", "")

    def test_both_fetches_go_through_the_guarded_helpers(self):
        import inspect

        from app.services import favicon_extractor

        source = inspect.getsource(favicon_extractor)
        assert "fetch_text_safely" in source, "the homepage fetch must be guarded"
        assert "fetch_bytes_safely" in source, "each icon download must be guarded"


class TestTheCandidateListIsBounded:
    def test_a_site_declaring_hundreds_of_icons_is_capped(self):
        """300 <link rel="icon"> tags produced 302 sequential candidates at up
        to 10s each — longer than the worker's entire job timeout, on a crawl
        that was already complete and billed."""
        from app.services.favicon_extractor import _MAX_ICON_CANDIDATES, _discover_icon_urls

        html = "<html><head>" + "".join(f'<link rel="icon" href="/i{i}.png">' for i in range(300)) + "</head></html>"

        candidates = _discover_icon_urls("https://acme.com", html)
        assert len(candidates) > _MAX_ICON_CANDIDATES, "the discovery itself is intentionally unbounded"
        assert len(candidates[:_MAX_ICON_CANDIDATES]) == _MAX_ICON_CANDIDATES

    def test_the_cap_is_small_enough_to_finish_inside_the_budget(self):
        from app.services.crawl_orchestrator import _FAVICON_TOTAL_BUDGET_S
        from app.services.favicon_extractor import _FETCH_TIMEOUT_S, _MAX_ICON_CANDIDATES

        # Even if every candidate times out, the step cannot outlive its budget.
        assert _MAX_ICON_CANDIDATES * _FETCH_TIMEOUT_S >= _FAVICON_TOTAL_BUDGET_S, (
            "the wait_for budget is what actually bounds this; keep it the binding constraint"
        )
        assert _FAVICON_TOTAL_BUDGET_S <= 60


class TestIcoIsRejectedRatherThanWinning:
    def test_an_ico_the_avatar_pipeline_cannot_use_is_not_accepted(self):
        """`/favicon.ico` is the most common favicon declaration on the web.
        Pillow opens ICO happily, but `process_image_for_logo` rejects it — so
        the old code returned the bytes, STOPPED the candidate loop, and the
        site got no avatar even when `/apple-touch-icon.png` existed and would
        have worked."""
        import io as _io

        from PIL import Image as _Image

        from app.services.favicon_extractor import _decode_is_valid_image, _usable_by_the_avatar_pipeline

        buf = _io.BytesIO()
        _Image.new("RGBA", (64, 64), (255, 0, 0, 255)).save(buf, format="ICO")
        ico = buf.getvalue()

        assert _decode_is_valid_image(ico) is True, "Pillow does open ICO — that is the trap"
        assert _usable_by_the_avatar_pipeline(ico) is False

    def test_a_png_is_accepted(self):
        import io as _io

        from PIL import Image as _Image

        from app.services.favicon_extractor import _usable_by_the_avatar_pipeline

        buf = _io.BytesIO()
        _Image.new("RGBA", (64, 64), (0, 128, 255, 255)).save(buf, format="PNG")
        assert _usable_by_the_avatar_pipeline(buf.getvalue()) is True

    def test_it_agrees_with_the_pipeline_it_is_predicting(self):
        """The predicate reads the pipeline's own allow-list rather than a
        second copy of it, so the two cannot drift."""
        import inspect

        from app.services import favicon_extractor

        assert "ALLOWED_IMAGE_FORMATS" in inspect.getsource(favicon_extractor._usable_by_the_avatar_pipeline)


class TestTheAvatarWriteRespectsTheCustomersChoice:
    def test_a_non_upload_avatar_type_is_left_alone(self):
        """`bot_logo` empty is NOT "no avatar chosen". `avatar_type` has three
        legal values and a customer who picked Orb has bot_logo NULL, so the
        old guard passed and then flipped avatar_type to 'upload' — silently
        replacing a deliberate choice with their favicon."""
        import inspect

        from app.services import crawl_orchestrator

        source = inspect.getsource(crawl_orchestrator._maybe_apply_favicon_avatar)
        assert 'avatar_type or "upload") != "upload"' in source, (
            "the write must bail out for orb/mascot, not just for a set bot_logo"
        )
        assert 'bot.avatar_type = "upload"' not in source, "it must not reassign avatar_type at all"

    def test_it_writes_both_logo_fields(self):
        """`bot_routes` keeps these in lockstep on every API write and the
        widget's launcher reads `launcher_logo`; setting only `bot_logo` left
        the in-chat avatar as the favicon while the launcher bubble still
        showed the fallback robot."""
        import inspect

        from app.services import crawl_orchestrator

        source = inspect.getsource(crawl_orchestrator._maybe_apply_favicon_avatar)
        assert "bot.bot_logo = logo_key" in source
        assert "bot.launcher_logo = logo_key" in source


class TestItRunsAfterTheCrawlIsAlreadyComplete:
    def test_the_favicon_step_is_hard_bounded(self):
        import inspect

        from app.services import crawl_orchestrator

        source = inspect.getsource(crawl_orchestrator)
        assert "_FAVICON_TOTAL_BUDGET_S" in source
        assert "asyncio.wait_for(" in source and "_maybe_apply_favicon_avatar(" in source

    def test_it_is_invoked_after_the_terminal_result_is_built(self):
        """It used to sit ABOVE the result payload and the terminal status
        write. An ARQ cancellation raises CancelledError — a BaseException, so
        neither handler caught it — on a crawl already fetched, ingested and
        BILLED, leaving the customer's spinner hung forever on completed work.
        """
        import inspect

        from app.services import crawl_orchestrator

        source = inspect.getsource(crawl_orchestrator.run_full_crawl)
        payload_at = source.index("result_payload = {")
        favicon_at = source.index("_maybe_apply_favicon_avatar(")
        assert favicon_at > payload_at, "the favicon step must not sit between ingestion and the terminal result"


class TestDownloadIconAppliesThePipelineCheck:
    """Testing the predicate is not testing the call site.

    Removing the `_usable_by_the_avatar_pipeline` guard from `_download_icon`
    left the predicate's own tests green — exactly the hole this whole
    workstream keeps rediscovering.
    """

    @staticmethod
    def _image_bytes(fmt: str) -> bytes:
        import io as _io

        from PIL import Image as _Image

        buf = _io.BytesIO()
        _Image.new("RGBA", (64, 64), (255, 0, 0, 255)).save(buf, format=fmt)
        return buf.getvalue()

    @pytest.mark.asyncio
    async def test_an_ico_is_refused_so_the_loop_can_try_the_next_candidate(self):
        from unittest.mock import AsyncMock, patch

        from app.services import favicon_extractor

        with patch.object(
            favicon_extractor,
            "fetch_bytes_safely",
            new=AsyncMock(return_value=(200, self._image_bytes("ICO"))),
        ):
            assert await favicon_extractor._download_icon(object(), "https://acme.com/favicon.ico") is None

    @pytest.mark.asyncio
    async def test_a_png_is_returned(self):
        from unittest.mock import AsyncMock, patch

        from app.services import favicon_extractor

        png = self._image_bytes("PNG")
        with patch.object(favicon_extractor, "fetch_bytes_safely", new=AsyncMock(return_value=(200, png))):
            assert await favicon_extractor._download_icon(object(), "https://acme.com/icon.png") == png

    @pytest.mark.asyncio
    async def test_a_guarded_fetch_returning_none_is_a_miss_not_a_crash(self):
        """`fetch_bytes_safely` returns None for an SSRF rejection, a redirect
        into private space, or an oversized body."""
        from unittest.mock import AsyncMock, patch

        from app.services import favicon_extractor

        with patch.object(favicon_extractor, "fetch_bytes_safely", new=AsyncMock(return_value=None)):
            assert await favicon_extractor._download_icon(object(), "https://acme.com/i.png") is None
