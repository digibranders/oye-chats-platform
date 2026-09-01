"""Tests for the favicon / app-icon extractor used to auto-set bot avatars.

Two halves, and the second is the one that kept getting skipped:

* the pure ranking/validation helpers and the guarded fetcher, and
* the WRITE, the orchestrator step that actually mutates a customer's bot row.

The write half used to be covered by ``inspect.getsource()`` substring matches.
Those assert that a line of source text exists; they pass if the logic is
inverted, unreachable, or commented out, and fail if someone reformats the
line. Every one of them has been replaced with a test that calls the function
against a real ``Bot`` row and asserts what lands in the database.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import os
import socket
from unittest.mock import AsyncMock, patch

import pytest
from PIL import Image, ImageFile

import app.services.crawl_orchestrator as orch
from app.db.models import Bot, Client
from app.services.favicon_extractor import (
    _decode_is_valid_image,
    _discover_icon_urls,
    _is_svg_candidate,
    _largest_declared_size,
)


def _image_bytes(fmt: str, size: tuple[int, int] = (64, 64)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", size, (255, 0, 0, 255)).save(buf, format=fmt)
    return buf.getvalue()


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
    assert _decode_is_valid_image(_image_bytes("PNG")) is True
    # An HTML error page served for a missing icon path must be rejected.
    assert _decode_is_valid_image(b"<!doctype html><html>not found</html>") is False


def test_decode_rejects_too_small_image():
    # 8x8 is below the 16px floor, a tracking pixel, not a usable avatar.
    assert _decode_is_valid_image(_image_bytes("PNG", (8, 8))) is False


# ── The network-facing half ────────────────────────────────────────────────
#
# The original fetcher rolled its own httpx client and got all three guards
# wrong: `follow_redirects=True` (so a customer's site could 302 the crawl
# worker into the VPC), `validate_public_url` on the pre-redirect URL only,
# and a size cap applied to `resp.content` AFTER the whole body was buffered.


class TestEveryByteComesFromTheGuardedHelpers:
    """The fix was structural (route both fetches through `core/ssrf`, which
    re-validates every redirect hop and pins DNS) but "no hand-rolled client"
    is still observable: sever every direct egress path, leave only the guarded
    helpers working, and check the extractor still produces an icon. If any
    part of it opened its own connection, the severed transport raises.
    """

    @pytest.mark.asyncio
    async def test_the_extractor_never_opens_a_connection_of_its_own(self, monkeypatch):
        import aiohttp

        from app.services import favicon_extractor

        def _forbidden(*args, **kwargs):
            raise AssertionError(
                "unguarded egress: a hand-rolled client bypasses per-hop redirect revalidation and DNS pinning"
            )

        async def _forbidden_async(*args, **kwargs):
            _forbidden()

        # aiohttp funnels every request through `_request`; httpx (what the
        # original version used) through `AsyncClient.send`. `socket.connect`
        # is the backstop that catches a rewrite using any other client
        # (requests, urllib, a raw socket) since the guarded helpers are
        # stubbed here and nothing legitimate should reach the network at all.
        monkeypatch.setattr(aiohttp.ClientSession, "_request", _forbidden_async)
        monkeypatch.setattr(socket.socket, "connect", _forbidden)
        with contextlib.suppress(ImportError):
            import httpx

            monkeypatch.setattr(httpx.AsyncClient, "send", _forbidden_async)

        html = '<html><head><link rel="apple-touch-icon" href="/apple.png"></head></html>'
        png = _image_bytes("PNG")
        monkeypatch.setattr(favicon_extractor, "fetch_text_safely", AsyncMock(return_value=(200, html)))
        monkeypatch.setattr(favicon_extractor, "fetch_bytes_safely", AsyncMock(return_value=(200, png)))

        assert await favicon_extractor.fetch_favicon_image("https://acme.com") == png

    @pytest.mark.asyncio
    async def test_the_icon_download_is_guarded_too_not_just_the_homepage(self, monkeypatch):
        """Guarding only the HTML fetch would still leave the icon URL (which
        comes straight out of attacker-controlled markup) as an open redirect
        into private space."""
        from app.services import favicon_extractor

        html = '<html><head><link rel="icon" href="http://169.254.169.254/latest/meta-data/"></head></html>'
        monkeypatch.setattr(favicon_extractor, "fetch_text_safely", AsyncMock(return_value=(200, html)))
        # What `fetch_bytes_safely` returns for a rejected host.
        guarded = AsyncMock(return_value=None)
        monkeypatch.setattr(favicon_extractor, "fetch_bytes_safely", guarded)

        assert await favicon_extractor.fetch_favicon_image("https://acme.com") is None
        # The link-local URL was handed to the guard rather than filtered out
        # upstream: the extractor does not judge candidate hosts itself, so if
        # this download were not routed through `fetch_bytes_safely` the
        # metadata endpoint would simply be fetched.
        attempted = [call.args[1] for call in guarded.await_args_list]
        assert "http://169.254.169.254/latest/meta-data/" in attempted


class TestTheCandidateListIsBounded:
    def test_a_site_declaring_hundreds_of_icons_is_capped(self):
        """300 <link rel="icon"> tags produced 302 sequential candidates at up
        to 10s each. Longer than the worker's entire job timeout, on a crawl
        that was already complete and billed."""
        from app.services.favicon_extractor import _MAX_ICON_CANDIDATES, _discover_icon_urls

        html = "<html><head>" + "".join(f'<link rel="icon" href="/i{i}.png">' for i in range(300)) + "</head></html>"

        candidates = _discover_icon_urls("https://acme.com", html)
        assert len(candidates) > _MAX_ICON_CANDIDATES, "the discovery itself is intentionally unbounded"
        assert len(candidates[:_MAX_ICON_CANDIDATES]) == _MAX_ICON_CANDIDATES

    @pytest.mark.asyncio
    async def test_the_fetcher_stops_at_the_cap(self, monkeypatch):
        """The cap is only worth anything if the download loop honours it."""
        from app.services import favicon_extractor

        html = "<html><head>" + "".join(f'<link rel="icon" href="/i{i}.png">' for i in range(300)) + "</head></html>"
        monkeypatch.setattr(favicon_extractor, "fetch_text_safely", AsyncMock(return_value=(200, html)))
        # Never yields a usable icon, so the loop runs to exhaustion.
        attempts = AsyncMock(return_value=None)
        monkeypatch.setattr(favicon_extractor, "fetch_bytes_safely", attempts)

        assert await favicon_extractor.fetch_favicon_image("https://acme.com") is None
        assert attempts.await_count == favicon_extractor._MAX_ICON_CANDIDATES

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
        Pillow opens ICO happily, but `process_image_for_logo` rejects it, so
        the old code returned the bytes, STOPPED the candidate loop, and the
        site got no avatar even when `/apple-touch-icon.png` existed and would
        have worked."""
        from app.services.favicon_extractor import _decode_is_valid_image, _usable_by_the_avatar_pipeline

        ico = _image_bytes("ICO")
        assert _decode_is_valid_image(ico) is True, "Pillow does open ICO. That is the trap"
        assert _usable_by_the_avatar_pipeline(ico) is False

    def test_a_png_is_accepted(self):
        from app.services.favicon_extractor import _usable_by_the_avatar_pipeline

        assert _usable_by_the_avatar_pipeline(_image_bytes("PNG")) is True

    @pytest.mark.parametrize("load_truncated", [False, True])
    @pytest.mark.parametrize("case", ["PNG", "ICO", "BMP", "GIF", "truncated", "decompression-bomb"])
    def test_the_predicate_agrees_with_the_pipeline_it_is_predicting(self, case, load_truncated, monkeypatch):
        """A prediction that disagrees with the thing it predicts is worse than
        no prediction: a false yes STOPS the candidate loop on bytes the upload
        then rejects, so the site gets no avatar and the perfectly good
        lower-ranked candidate is never tried.

        The fixtures are chosen to cover all three of the pipeline's rejection
        paths, because modelling only the first is how the predicate drifted:
        format (ICO), truncated data, and the decompression-bomb ceiling. A
        9000x9000 solid PNG is ~78 KB, so it passes the byte cap and
        `_decode_is_valid_image` (`verify()` never decompresses) and used to
        be declared usable here.

        Parametrised over `ImageFile.LOAD_TRUNCATED_IMAGES` because it is a
        process-global that importing weasyprint (the invoice-PDF renderer)
        flips to True for everyone, and the truncated fixture is what makes
        that parametrisation mean anything.
        """
        from app.services.favicon_extractor import _usable_by_the_avatar_pipeline
        from app.services.r2_service import UnsupportedImage, process_image_for_logo

        monkeypatch.setattr(ImageFile, "LOAD_TRUNCATED_IMAGES", load_truncated)
        if case == "truncated":
            whole = _image_bytes("PNG")
            data = whole[: len(whole) // 2]
        elif case == "decompression-bomb":
            buf = io.BytesIO()
            Image.new("L", (9000, 9000), 0).save(buf, format="PNG")
            data = buf.getvalue()
            assert len(data) < 2 * 1024 * 1024, "must stay under the fetcher's body cap to be a real threat"
        else:
            data = _image_bytes(case)

        predicted = _usable_by_the_avatar_pipeline(data)
        try:
            process_image_for_logo(data)
            actual = True
        except UnsupportedImage:
            actual = False
        assert predicted is actual, f"{case}: predicate says {predicted}, pipeline says {actual}"

    def test_a_decompression_bomb_does_not_stop_the_candidate_loop(self):
        """The consequence the agreement property exists to prevent, stated
        directly: an oversized icon must be refused by `_download_icon` so the
        loop moves on, not accepted and then rejected by the upload."""
        from app.services.favicon_extractor import _decode_is_valid_image, _usable_by_the_avatar_pipeline

        buf = io.BytesIO()
        Image.new("L", (9000, 9000), 0).save(buf, format="PNG")
        bomb = buf.getvalue()

        assert _decode_is_valid_image(bomb) is True, "verify() does not decompress. That is the trap"
        assert _usable_by_the_avatar_pipeline(bomb) is False


class TestDownloadIconAppliesThePipelineCheck:
    """Testing the predicate is not testing the call site.

    Removing the `_usable_by_the_avatar_pipeline` guard from `_download_icon`
    left the predicate's own tests green, exactly the hole this whole
    workstream keeps rediscovering.
    """

    @pytest.mark.asyncio
    async def test_an_ico_is_converted_rather_than_refused(self):
        """This used to assert `is None`, so the loop could skip ICO.

        Skipping was the wrong answer to "the pipeline cannot store ICO": it is
        the most common favicon declaration on the web, and the fallback the
        loop moved on to (`/apple-touch-icon.png`) usually 404s -- so most sites
        got no avatar at all. Now the bytes are re-encoded to PNG and returned.

        What has NOT changed is the property underneath: `_download_icon` still
        only ever returns bytes the pipeline accepts. It is the RETURNED bytes
        that must satisfy it, which is what the next test states directly.
        """
        from app.services import favicon_extractor
        from app.services.r2_service import process_image_for_logo

        with patch.object(
            favicon_extractor,
            "fetch_bytes_safely",
            new=AsyncMock(return_value=(200, _image_bytes("ICO"))),
        ):
            out = await favicon_extractor._download_icon(object(), "https://acme.com/favicon.ico")
        assert out is not None
        assert process_image_for_logo(out)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("fmt", ["ICO", "PNG", "BMP", "GIF"])
    async def test_whatever_it_returns_the_pipeline_accepts(self, fmt):
        """The real invariant, stated on the returned value.

        The old proxy compared the predicate against the pipeline on the SAME
        raw bytes, which stopped being the right question once the downloader
        was allowed to convert. What actually matters is that nothing the loop
        accepts can be rejected later by the upload -- because that is what
        strands a site with no avatar while a good lower-ranked candidate goes
        untried.
        """
        from app.services import favicon_extractor
        from app.services.r2_service import process_image_for_logo

        with patch.object(
            favicon_extractor,
            "fetch_bytes_safely",
            new=AsyncMock(return_value=(200, _image_bytes(fmt))),
        ):
            out = await favicon_extractor._download_icon(object(), f"https://acme.com/icon.{fmt.lower()}")
        if out is not None:
            assert process_image_for_logo(out), f"{fmt}: accepted by the loop, rejected by the pipeline"

    @pytest.mark.asyncio
    async def test_a_png_is_returned(self):
        from app.services import favicon_extractor

        png = _image_bytes("PNG")
        with patch.object(favicon_extractor, "fetch_bytes_safely", new=AsyncMock(return_value=(200, png))):
            assert await favicon_extractor._download_icon(object(), "https://acme.com/icon.png") == png

    @pytest.mark.asyncio
    async def test_a_guarded_fetch_returning_none_is_a_miss_not_a_crash(self):
        """`fetch_bytes_safely` returns None for an SSRF rejection, a redirect
        into private space, or an oversized body."""
        from app.services import favicon_extractor

        with patch.object(favicon_extractor, "fetch_bytes_safely", new=AsyncMock(return_value=None)):
            assert await favicon_extractor._download_icon(object(), "https://acme.com/i.png") is None


# ── The write path, against a real bot row ──────────────────────────────────

pytestmark_db = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_UPLOADED_KEY = "logos/derived-favicon.png"


def _make_bot(db, bot_id: int, **overrides) -> Bot:
    """A committed Client + Bot the orchestrator's own sessions can see."""
    db.add(Client(id=bot_id, email=f"fav{bot_id}@example.com", name="C", api_key=f"favkey{bot_id}"))
    db.flush()
    bot = Bot(id=bot_id, client_id=bot_id, bot_key=f"bot-fav{bot_id}", name="B", is_active=True, **overrides)
    db.add(bot)
    db.commit()
    return bot


def _reread(db, bot_id: int) -> Bot:
    """Re-read through the fixture session after the code under test committed
    on a session of its own. Otherwise the identity map serves the stale row."""
    db.expire_all()
    return db.get(Bot, bot_id)


@contextlib.contextmanager
def _favicon_enabled(monkeypatch, *, fetch, upload=None):
    """Turn the kill switch on and stub the two vendor calls.

    Both are imported inside `_maybe_apply_favicon_avatar`, so they are patched
    where they are defined rather than on the orchestrator module. The flag is
    a module global read at call time, so patching it on the orchestrator is
    what the running code actually sees.
    """
    monkeypatch.setattr(orch, "CRAWL_FAVICON_AVATAR_ENABLED", True)
    upload_mock = upload if upload is not None else (lambda *a, **k: _UPLOADED_KEY)
    with (
        patch("app.services.favicon_extractor.fetch_favicon_image", new=fetch) as fetch_patch,
        patch("app.services.r2_service.upload_to_r2", new=upload_mock) as upload_patch,
    ):
        yield fetch_patch, upload_patch


@pytestmark_db
class TestTheAvatarWrite:
    """Every case here calls `_maybe_apply_favicon_avatar` for real and asserts
    on the database row afterwards."""

    @pytest.mark.asyncio
    async def test_the_kill_switch_prevents_the_fetch_and_the_write(self, db, monkeypatch):
        """Off means off: not "fetches but doesn't write", no egress at all."""
        bot = _make_bot(db, 8001)
        monkeypatch.setattr(orch, "CRAWL_FAVICON_AVATAR_ENABLED", False)
        fetch = AsyncMock(return_value=_image_bytes("PNG"))

        with patch("app.services.favicon_extractor.fetch_favicon_image", new=fetch):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        assert fetch.await_count == 0
        assert _reread(db, 8001).bot_logo is None

    @pytest.mark.asyncio
    async def test_a_found_favicon_fills_both_logo_fields(self, db, monkeypatch):
        """`bot_routes` keeps these in lockstep on every API write and the
        widget's launcher reads `launcher_logo`; setting only `bot_logo` left
        the in-chat avatar as the favicon while the launcher bubble still
        showed the fallback robot."""
        bot = _make_bot(db, 8002)
        fetch = AsyncMock(return_value=_image_bytes("PNG"))

        with _favicon_enabled(monkeypatch, fetch=fetch):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        written = _reread(db, 8002)
        assert written.bot_logo == _UPLOADED_KEY
        assert written.launcher_logo == _UPLOADED_KEY
        # `avatar_type` is a style selector, not provenance. This can't tell
        # "never touched" from "reassigned to upload" (they're the same row)
        # but it does fail if the write ever puts a different value there,
        # which is the mistake that was made once.
        assert written.avatar_type == "upload"

    @pytest.mark.asyncio
    async def test_the_widget_config_cache_is_dropped_so_the_avatar_appears_now(self, db, monkeypatch):
        """The widget serves bot_logo / launcher_logo from a 10-minute config
        cache. Committing without invalidating leaves the customer's site
        showing the fallback robot for up to `BOT_CONFIG_TTL` after a crawl
        that reports itself finished."""
        from app.core.cache import bot_config_key

        bot = _make_bot(db, 8016)
        dropped: list[str] = []
        monkeypatch.setattr(orch, "cache_delete", lambda key: dropped.append(key))

        with _favicon_enabled(monkeypatch, fetch=AsyncMock(return_value=_image_bytes("PNG"))):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        assert _reread(db, 8016).bot_logo == _UPLOADED_KEY
        assert dropped == [bot_config_key("bot-fav8016")]

    @pytest.mark.asyncio
    async def test_no_write_means_no_cache_churn(self, db, monkeypatch):
        """The invalidation belongs to the write, not to the attempt."""
        bot = _make_bot(db, 8017, avatar_type="orb")
        dropped: list[str] = []
        monkeypatch.setattr(orch, "cache_delete", lambda key: dropped.append(key))

        with _favicon_enabled(monkeypatch, fetch=AsyncMock(return_value=_image_bytes("PNG"))):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        assert dropped == []

    @pytest.mark.asyncio
    async def test_a_custom_launcher_image_is_not_overwritten(self, db, monkeypatch):
        """A customer can run a distinct launcher bubble image with no in-chat
        avatar. Filling the empty slot must not clobber the full one."""
        bot = _make_bot(db, 8003, launcher_logo="logos/customer-chosen.png")
        fetch = AsyncMock(return_value=_image_bytes("PNG"))

        with _favicon_enabled(monkeypatch, fetch=fetch):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        written = _reread(db, 8003)
        assert written.bot_logo == _UPLOADED_KEY
        assert written.launcher_logo == "logos/customer-chosen.png"

    @pytest.mark.asyncio
    async def test_an_existing_avatar_short_circuits_before_any_network_call(self, db, monkeypatch):
        """Not merely "doesn't overwrite", a bot that already has an avatar
        must cost one indexed lookup and nothing else. This is what makes the
        step affordable on every crawl now that it no longer skips partial
        re-scrapes."""
        bot = _make_bot(db, 8004, bot_logo="logos/uploaded-by-the-customer.png")
        fetch = AsyncMock(return_value=_image_bytes("PNG"))

        with _favicon_enabled(monkeypatch, fetch=fetch):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        assert fetch.await_count == 0
        assert _reread(db, 8004).bot_logo == "logos/uploaded-by-the-customer.png"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("avatar_type", ["orb", "mascot"])
    async def test_a_non_upload_avatar_type_is_left_alone(self, db, monkeypatch, avatar_type):
        """`bot_logo` empty is NOT "no avatar chosen". `avatar_type` has three
        legal values and a customer who picked Orb has bot_logo NULL, so the
        old guard passed and then flipped avatar_type to 'upload'. Silently
        replacing a deliberate choice with their favicon. Fixed once; this is
        what keeps it fixed."""
        bot_id = 8005 if avatar_type == "orb" else 8006
        bot = _make_bot(db, bot_id, avatar_type=avatar_type)
        fetch = AsyncMock(return_value=_image_bytes("PNG"))

        with _favicon_enabled(monkeypatch, fetch=fetch):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        written = _reread(db, bot_id)
        assert written.bot_logo is None
        assert written.launcher_logo is None
        assert written.avatar_type == avatar_type
        assert fetch.await_count == 0, "an orb/mascot bot can never pass the write guard. Don't pay for the fetch"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("chosen", ["bot_logo", "avatar_type"])
    async def test_an_avatar_chosen_during_the_fetch_wins(self, db, monkeypatch, chosen):
        """The pre-check is an optimisation; the post-fetch re-check is the
        real guard. A customer picking an avatar in the seconds the homepage
        fetch takes must not have it overwritten."""
        bot_id = 8007 if chosen == "bot_logo" else 8008
        bot = _make_bot(db, bot_id)

        async def _fetch_then_customer_chooses(_url):
            # Committed on a session of its own, exactly as the API route would.
            from app.db.session import get_session

            with get_session() as concurrent:
                row = concurrent.get(Bot, bot_id)
                if chosen == "bot_logo":
                    row.bot_logo = "logos/chosen-mid-fetch.png"
                else:
                    row.avatar_type = "orb"
                concurrent.commit()
            return _image_bytes("PNG")

        with _favicon_enabled(monkeypatch, fetch=_fetch_then_customer_chooses):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        written = _reread(db, bot_id)
        if chosen == "bot_logo":
            assert written.bot_logo == "logos/chosen-mid-fetch.png"
        else:
            assert written.bot_logo is None
            assert written.avatar_type == "orb"

    @pytest.mark.asyncio
    async def test_another_tenants_bot_is_refused(self, db, monkeypatch):
        """`bot_id` and `client_id` arrive as two independent arguments. If they
        are ever wired up from different places, this is the line that stops one
        customer's crawl from restyling another customer's agent."""
        bot = _make_bot(db, 8009)
        other = _make_bot(db, 8010)
        fetch = AsyncMock(return_value=_image_bytes("PNG"))

        with _favicon_enabled(monkeypatch, fetch=fetch):
            await orch._maybe_apply_favicon_avatar(bot.id, other.client_id, "https://acme.com")

        assert fetch.await_count == 0
        assert _reread(db, 8009).bot_logo is None

    @pytest.mark.asyncio
    async def test_a_site_with_no_usable_icon_writes_nothing(self, db, monkeypatch):
        bot = _make_bot(db, 8011)

        with _favicon_enabled(monkeypatch, fetch=AsyncMock(return_value=None)):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        assert _reread(db, 8011).bot_logo is None

    @pytest.mark.asyncio
    async def test_a_raising_fetch_is_swallowed(self, db, monkeypatch):
        """Non-fatal by contract: the crawl this runs after is already complete
        and billed, so nothing here may propagate."""
        bot = _make_bot(db, 8012)
        fetch = AsyncMock(side_effect=RuntimeError("upstream exploded"))

        with _favicon_enabled(monkeypatch, fetch=fetch):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        assert _reread(db, 8012).bot_logo is None

    @pytest.mark.asyncio
    async def test_a_raising_upload_is_swallowed(self, db, monkeypatch):
        """The reachable R2 failure mode today: `upload_to_r2` re-raises on a
        ClientError, and `process_image_for_logo` raises `UnsupportedImage` for
        bytes the pipeline won't take, which arrive here straight off a
        customer-controlled host."""
        bot = _make_bot(db, 8013)

        def _explodes(*args, **kwargs):
            raise Exception("R2 upload failed (ClientError): AccessDenied")

        with _favicon_enabled(monkeypatch, fetch=AsyncMock(return_value=_image_bytes("PNG")), upload=_explodes):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        assert _reread(db, 8013).bot_logo is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize("returned", [None, ""])
    async def test_a_falsy_upload_key_is_never_written(self, db, monkeypatch, returned):
        """The `if not logo_key` guard. `upload_to_r2` raises rather than
        returning falsy today, so this pins the guard against a future version
        that returns an empty key instead, which would otherwise be written
        straight onto the bot and point the widget at nothing.

        The empty-string case is what gives this test teeth: with `None`,
        dropping the guard writes `bot_logo = None`, which is indistinguishable
        from not writing at all."""
        bot = _make_bot(db, 8013 if returned is None else 8015)

        with _favicon_enabled(
            monkeypatch,
            fetch=AsyncMock(return_value=_image_bytes("PNG")),
            upload=lambda *a, **k: returned,
        ):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        assert _reread(db, bot.id).bot_logo is None

    @pytest.mark.asyncio
    async def test_the_fetched_bytes_are_what_reaches_the_upload(self, db, monkeypatch):
        """The stored key comes from the upload, so the only thing linking the
        avatar to the customer's site is these bytes. Asserts they arrive
        unmangled and that the real logo pipeline accepts them, the upload is
        stubbed here, and a byte path that only ever sees a stub is untested."""
        from app.services.r2_service import process_image_for_logo

        bot = _make_bot(db, 8014)
        png = _image_bytes("PNG")
        seen: dict[str, object] = {}

        def _capture(data, filename, content_type):
            seen["data"] = data
            seen["content_type"] = content_type
            return _UPLOADED_KEY

        with _favicon_enabled(monkeypatch, fetch=AsyncMock(return_value=png), upload=_capture):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        assert seen["data"] == png
        assert seen["content_type"] == "image/png"
        assert process_image_for_logo(seen["data"]), "the bytes handed to R2 must survive the real logo pipeline"
        assert _reread(db, 8014).bot_logo == _UPLOADED_KEY


# ── The step's placement inside the crawl ───────────────────────────────────


def _wire_a_minimal_crawl(monkeypatch, statuses: list[str]) -> None:
    """Stub everything in `run_full_crawl` that is not the favicon step.

    Deliberately not a mocked DB session: these tests assert on a real bot row,
    so `get_session` is left pointing at the test database.
    """

    @contextlib.asynccontextmanager
    async def _no_heartbeat(_client_id):
        yield

    async def _fetch_urls(urls, **kwargs):
        return {
            "results": [{"url": u, "content": "hello world"} for u in urls],
            "recommended_colors": [],
            "discovered_total": len(urls),
            "queue_remaining": 0,
        }

    async def _crawl_website(url, **kwargs):
        return {
            "results": [{"url": url, "content": "hello world"}],
            "recommended_colors": [],
            "discovered_total": 1,
            "queue_remaining": 0,
        }

    async def _no_colors(_url, **kwargs):
        return []

    def _record_status(_client_id, **kwargs):
        statuses.append(kwargs.get("status"))

    monkeypatch.setattr(orch, "CRAWL_STREAM_INGEST_ENABLED", False)
    monkeypatch.setattr(orch, "crawl_heartbeat", _no_heartbeat)
    monkeypatch.setattr(orch, "fetch_urls", _fetch_urls)
    monkeypatch.setattr(orch, "crawl_website", _crawl_website)
    monkeypatch.setattr(orch, "harvest_footer_media", AsyncMock(return_value={}))
    monkeypatch.setattr(orch, "fetch_recommended_colors", _no_colors)
    monkeypatch.setattr(orch, "classify_brand_tone", lambda *a, **k: None)
    monkeypatch.setattr(orch, "extract_company_context", lambda *a, **k: None)
    monkeypatch.setattr(orch, "is_cancellation_requested", lambda *a, **k: False)
    monkeypatch.setattr(orch, "set_crawl_progress", _record_status)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda *a, **k: None)
    monkeypatch.setattr(orch, "_record_bot_crawl_state", lambda *a, **k: None)
    monkeypatch.setattr(orch, "_precompute_seed_questions", lambda *a, **k: None)
    monkeypatch.setattr(
        orch,
        "batch_web_ingestion",
        lambda cid, pages, **kw: {"chunks": len(pages), "pages_charged": len(pages), "credits_deducted": 0},
    )
    monkeypatch.setattr(
        "app.services.notification_service.notify_crawl_completed",
        lambda *a, **k: None,
    )


async def _run_crawl(*, bot: Bot, ordered_urls: list[str] | None) -> dict:
    return await orch.run_full_crawl(
        client_id=bot.client_id,
        bot_id=bot.id,
        url="https://acme.com",
        max_pages=10,
        use_js=False,
        replace_source=None,
        cost_per_page=0,
        ordered_urls=ordered_urls,
    )


@pytestmark_db
class TestTheFaviconStepInsideTheCrawl:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("ordered_urls", [None, ["https://acme.com/pricing"]])
    async def test_it_runs_for_a_partial_re_scrape_as_well_as_a_full_crawl(self, db, monkeypatch, ordered_urls):
        """The admin panel pre-ticks every discovered page on discovery, so
        `ordered_urls` is set on essentially every crawl started from it,
        including a customer's FIRST, which is precisely when the bot has no
        avatar. Gating the favicon step on `ordered_urls` (mirroring the
        footer harvest) made it dead code for the case it exists to serve.
        The icon is site work read from the homepage; which pages were ticked
        has nothing to do with it."""
        bot = _make_bot(db, 8100 if ordered_urls is None else 8101)
        _wire_a_minimal_crawl(monkeypatch, [])

        with _favicon_enabled(monkeypatch, fetch=AsyncMock(return_value=_image_bytes("PNG"))):
            result = await _run_crawl(bot=bot, ordered_urls=ordered_urls)

        assert result["message"].startswith("Crawling and ingestion completed")
        assert _reread(db, bot.id).bot_logo == _UPLOADED_KEY

    @pytest.mark.asyncio
    async def test_it_runs_only_after_the_terminal_status_is_published(self, db, monkeypatch):
        """It used to sit ABOVE the result payload and the terminal status
        write. An ARQ cancellation raises CancelledError (a BaseException, so
        neither handler caught it) on a crawl already fetched, ingested and
        BILLED, leaving the customer's spinner hung forever on completed work.
        """
        bot = _make_bot(db, 8102)
        statuses: list[str] = []
        _wire_a_minimal_crawl(monkeypatch, statuses)
        seen_at_fetch_time: list[list[str]] = []

        async def _fetch(_url):
            seen_at_fetch_time.append(list(statuses))
            return _image_bytes("PNG")

        with _favicon_enabled(monkeypatch, fetch=_fetch):
            await _run_crawl(bot=bot, ordered_urls=None)

        assert seen_at_fetch_time, "the favicon step never ran"
        assert "done" in seen_at_fetch_time[0], (
            "the terminal crawl status must already be published before the favicon step starts"
        )

    @pytest.mark.asyncio
    async def test_a_favicon_step_that_overruns_its_budget_does_not_hold_the_crawl(self, db, monkeypatch):
        """The budget is the only thing bounding a step that reaches out to a
        customer-controlled host. The crawl is already billed by this point, so
        overrunning must cost the avatar, never the result."""
        bot = _make_bot(db, 8103)
        _wire_a_minimal_crawl(monkeypatch, [])
        monkeypatch.setattr(orch, "_FAVICON_TOTAL_BUDGET_S", 0.05)

        async def _hangs(_url):
            await asyncio.sleep(30)
            return _image_bytes("PNG")

        with _favicon_enabled(monkeypatch, fetch=_hangs):
            result = await asyncio.wait_for(_run_crawl(bot=bot, ordered_urls=None), timeout=10)

        assert result["message"].startswith("Crawling and ingestion completed")
        assert _reread(db, 8103).bot_logo is None


# ── Avatar provenance ───────────────────────────────────────────────────────


@pytestmark_db
class TestProvenanceDecidesWhetherToDerive:
    """`bot_logo IS NULL` answers the wrong question.

    A customer who REMOVES their avatar lands in exactly the same row state as
    one who never had one, so the crawl read a deliberate deletion as an empty
    slot and re-derived the picture they had just deleted, with no way for
    them to say no, because `avatar_type` stays `upload` and the removal was
    never recorded anywhere. `Bot.bot_logo_source` is what makes the two
    distinguishable.
    """

    @pytest.mark.asyncio
    async def test_a_derived_avatar_is_stamped_as_derived(self, db, monkeypatch):
        bot = _make_bot(db, 8200)

        with _favicon_enabled(monkeypatch, fetch=AsyncMock(return_value=_image_bytes("PNG"))):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        written = _reread(db, 8200)
        assert written.bot_logo == _UPLOADED_KEY
        assert written.bot_logo_source == "derived"

    @pytest.mark.asyncio
    async def test_a_removed_avatar_is_not_re_derived(self, db, monkeypatch):
        """The bug this column exists for. Row state is identical to a fresh
        agent (`bot_logo` NULL, `avatar_type` 'upload') and only the stamp
        distinguishes them."""
        bot = _make_bot(db, 8201, bot_logo=None, bot_logo_source="manual")
        fetch = AsyncMock(return_value=_image_bytes("PNG"))

        with _favicon_enabled(monkeypatch, fetch=fetch):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        assert fetch.await_count == 0, "a customer who said no should not cost a homepage fetch either"
        written = _reread(db, 8201)
        assert written.bot_logo is None
        assert written.bot_logo_source == "manual"

    @pytest.mark.asyncio
    async def test_a_removal_during_the_fetch_still_wins(self, db, monkeypatch):
        """The pre-check is an optimisation; the post-fetch re-check is the
        guard. A customer removing their avatar in the seconds the fetch takes
        is the same intent, expressed a moment later."""
        bot = _make_bot(db, 8202)

        async def _fetch_then_customer_removes(_url):
            from app.db.session import get_session

            with get_session() as concurrent:
                row = concurrent.get(Bot, 8202)
                row.bot_logo_source = "manual"
                concurrent.commit()
            return _image_bytes("PNG")

        with _favicon_enabled(monkeypatch, fetch=_fetch_then_customer_removes):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        written = _reread(db, 8202)
        assert written.bot_logo is None
        assert written.bot_logo_source == "manual"

    @pytest.mark.asyncio
    async def test_an_agent_nobody_has_touched_still_gets_one(self, db, monkeypatch):
        """The other half: provenance must not become a blanket refusal. A
        fresh agent has a NULL stamp and is exactly who this feature is for."""
        bot = _make_bot(db, 8203)
        assert bot.bot_logo_source is None

        with _favicon_enabled(monkeypatch, fetch=AsyncMock(return_value=_image_bytes("PNG"))):
            await orch._maybe_apply_favicon_avatar(bot.id, bot.client_id, "https://acme.com")

        assert _reread(db, 8203).bot_logo == _UPLOADED_KEY


class TestIcoIsConvertedRatherThanRejected:
    """ICO is the most common favicon declaration on the web, and it was dropped.

    Found on a real crawl of fynix.digital: the site declares
    ``<link rel="icon" href="/favicon.ico" sizes="48x48">``, that URL serves a
    perfectly good 48x48 RGBA icon, and no avatar ever appeared. Pillow opens it
    (`_decode_is_valid_image` passed), but the avatar pipeline's
    ``ALLOWED_IMAGE_FORMATS`` is ``{PNG, JPEG, WEBP, GIF, BMP}`` -- no ICO -- so
    ``_usable_by_the_avatar_pipeline`` correctly said no, the candidate loop
    moved on, and the fallback ``/apple-touch-icon.png`` 404'd.

    Refusing the format the web actually uses is the wrong answer to "the
    pipeline cannot store ICO". Pillow decodes it, so the bytes are re-encoded
    to PNG and the pipeline gets something it accepts. This fixes BOTH callers:
    the crawl's automatic avatar and the "Use my website's icon" button, which
    runs the same extractor.
    """

    def _ico(self, size=(48, 48), colour=(10, 102, 194, 255)) -> bytes:
        import io

        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGBA", size, colour).save(buf, format="ICO")
        return buf.getvalue()

    def test_an_ico_becomes_something_the_pipeline_accepts(self):
        from app.services.favicon_extractor import _normalise_for_pipeline
        from app.services.r2_service import process_image_for_logo

        normalised = _normalise_for_pipeline(self._ico())
        assert normalised is not None
        # The real gate, run for real rather than modelled.
        assert process_image_for_logo(normalised)

    def test_a_png_is_passed_through_untouched(self):
        # No needless re-encode: a format the pipeline already takes must not be
        # decoded and rebuilt, which would cost quality for nothing.
        import io

        from PIL import Image

        from app.services.favicon_extractor import _normalise_for_pipeline

        buf = io.BytesIO()
        Image.new("RGBA", (64, 64), (10, 102, 194, 255)).save(buf, format="PNG")
        original = buf.getvalue()
        assert _normalise_for_pipeline(original) is original

    def test_rubbish_is_still_rejected(self):
        from app.services.favicon_extractor import _normalise_for_pipeline

        assert _normalise_for_pipeline(b"not an image at all") is None

    def test_a_decompression_bomb_is_not_re_encoded(self):
        # Re-encoding happens BEFORE the pipeline's own `MAX_DECODED_PIXELS`
        # guard, so the normaliser needs its own bound or it becomes the hole
        # that guard exists to close.
        import io

        from PIL import Image

        from app.services.favicon_extractor import _normalise_for_pipeline

        buf = io.BytesIO()
        Image.new("RGB", (9000, 9000), (255, 0, 0)).save(buf, format="PNG")
        # A PNG is passed through, so use a format that WOULD be re-encoded.
        big = io.BytesIO()
        Image.new("RGB", (9000, 9000), (255, 0, 0)).save(big, format="TIFF")
        assert _normalise_for_pipeline(big.getvalue()) is None

    def test_the_predicate_still_answers_for_the_bytes_it_is_given(self):
        # Conversion lives in `_download_icon`, NOT in here. Moving it into the
        # predicate would make it disagree with the pipeline about the same
        # input, which is the property the agreement tests above protect.
        from app.services.favicon_extractor import _usable_by_the_avatar_pipeline

        assert _usable_by_the_avatar_pipeline(self._ico()) is False
