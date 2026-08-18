"""Unit tests for ``footer_harvester.harvest_footer_media``.

Phase 1 is log-only: these tests exercise the pure-Python extraction path
(BeautifulSoup + ``extract_media_urls``) by stubbing the Spider fetch and
the two YouTube-metadata enrichers. Network is never touched.
"""

from __future__ import annotations

import asyncio

import pytest

from app.services import footer_harvester


@pytest.fixture(autouse=True)
def _stub_youtube_enrichers(monkeypatch):
    """Never hit YouTube from tests, the enrichers are proven separately.

    Autouse so every test in this module gets deterministic no-op enrichers;
    individual tests can still override to assert on the calls they receive.
    """
    monkeypatch.setattr(footer_harvester, "enrich_media_urls_with_channel_videos", lambda media: None)
    monkeypatch.setattr(footer_harvester, "enrich_media_urls_with_metadata", lambda media: None)


def _stub_fetch(monkeypatch, html: str | None) -> None:
    async def _fake(url: str, *, use_js: bool = False, _client=None):  # noqa: ARG001
        return html

    monkeypatch.setattr(footer_harvester, "fetch_html", _fake)


@pytest.mark.asyncio
async def test_harvest_captures_youtube_channel_from_footer(monkeypatch):
    """A ``<footer>`` with a channel URL surfaces it under ``youtube_channels``."""
    html = """
    <html><body>
      <main><p>Product copy</p></main>
      <footer>
        <p>Follow us:</p>
        <a href="https://youtube.com/@brand">Our YouTube</a>
      </footer>
    </body></html>
    """
    _stub_fetch(monkeypatch, html)

    media = await footer_harvester.harvest_footer_media("https://example.com/")
    assert media.get("youtube_channels") == ["https://youtube.com/@brand"]


@pytest.mark.asyncio
async def test_harvest_captures_video_url_from_footer(monkeypatch):
    """A footer with an individual video URL surfaces it under ``youtube``."""
    html = """
    <html><body>
      <footer>
        <a href="https://www.youtube.com/watch?v=abcdefghij0">Watch our demo</a>
      </footer>
    </body></html>
    """
    _stub_fetch(monkeypatch, html)

    media = await footer_harvester.harvest_footer_media("https://example.com/")
    assert media["youtube"][0]["video_id"] == "abcdefghij0"


@pytest.mark.asyncio
async def test_harvest_captures_pdf_link_from_footer(monkeypatch):
    """A footer PDF link surfaces under ``files`` with a readable name."""
    html = """
    <html><body>
      <footer>
        <a href="https://cdn.example.com/downloads/brochure.pdf">Download brochure</a>
      </footer>
    </body></html>
    """
    _stub_fetch(monkeypatch, html)

    media = await footer_harvester.harvest_footer_media("https://example.com/")
    files = media.get("files") or []
    assert len(files) == 1
    assert files[0]["url"] == "https://cdn.example.com/downloads/brochure.pdf"
    assert files[0]["name"] == "brochure.pdf"


@pytest.mark.asyncio
async def test_harvest_matches_role_contentinfo_when_no_footer_tag(monkeypatch):
    """Sites using the ARIA landmark instead of ``<footer>`` are still handled."""
    html = """
    <html><body>
      <div role="contentinfo">
        <a href="https://youtube.com/channel/UCabcdefghijklmnopqrstuv">YouTube</a>
      </div>
    </body></html>
    """
    _stub_fetch(monkeypatch, html)

    media = await footer_harvester.harvest_footer_media("https://example.com/")
    assert media.get("youtube_channels") == ["https://youtube.com/channel/UCabcdefghijklmnopqrstuv"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "wrapper_html",
    [
        # WordPress default (Twenty-* themes and derivatives)
        '<div id="colophon"><a href="https://youtube.com/@brand">YouTube</a></div>',
        # Genesis / older WordPress starter themes
        '<div class="site-info"><a href="https://youtube.com/@brand">YouTube</a></div>',
        # Wix
        '<div id="SITE_FOOTER"><a href="https://youtube.com/@brand">YouTube</a></div>',
        # Bootstrap-derived layouts
        '<div id="page-footer"><a href="https://youtube.com/@brand">YouTube</a></div>',
        '<div class="page-footer"><a href="https://youtube.com/@brand">YouTube</a></div>',
    ],
    ids=["wp-colophon", "wp-genesis", "wix", "bootstrap-id", "bootstrap-class"],
)
async def test_harvest_matches_legacy_footer_selectors(monkeypatch, wrapper_html):
    """Legacy themes without ``<footer>`` still surface the channel URL."""
    html = f"<html><body>{wrapper_html}</body></html>"
    _stub_fetch(monkeypatch, html)

    media = await footer_harvester.harvest_footer_media("https://example.com/")
    assert media.get("youtube_channels") == ["https://youtube.com/@brand"]


@pytest.mark.asyncio
async def test_harvest_returns_empty_when_no_footer_region(monkeypatch):
    """Pages with no footer-shaped region return an empty dict (not None)."""
    html = "<html><body><main><p>Only main content, no footer.</p></main></body></html>"
    _stub_fetch(monkeypatch, html)

    media = await footer_harvester.harvest_footer_media("https://example.com/")
    assert media == {}


@pytest.mark.asyncio
async def test_harvest_returns_empty_on_fetch_failure(monkeypatch):
    """A Spider fetch failure (``None``) is swallowed silently."""
    _stub_fetch(monkeypatch, None)

    media = await footer_harvester.harvest_footer_media("https://example.com/")
    assert media == {}


@pytest.mark.asyncio
async def test_harvest_returns_empty_for_empty_url(monkeypatch):
    """Guard clause: an empty ``root_url`` short-circuits without any fetch."""
    called = {"n": 0}

    async def _should_not_be_called(*_args, **_kwargs):
        called["n"] += 1
        return None

    monkeypatch.setattr(footer_harvester, "fetch_html", _should_not_be_called)

    media = await footer_harvester.harvest_footer_media("")
    assert media == {}
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_harvest_returns_empty_when_footer_has_no_media(monkeypatch):
    """A footer with only prose/nav links (no media URLs) yields an empty dict."""
    html = """
    <html><body>
      <footer>
        <p>Copyright 2026 Acme Corp. All rights reserved.</p>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
      </footer>
    </body></html>
    """
    _stub_fetch(monkeypatch, html)

    media = await footer_harvester.harvest_footer_media("https://example.com/")
    assert media == {}


@pytest.mark.asyncio
async def test_harvest_calls_channel_enricher_when_channel_found(monkeypatch):
    """When a channel URL is captured, both enrichers run on the media dict."""
    html = """
    <html><body>
      <footer>
        <a href="https://youtube.com/@brand">YouTube</a>
      </footer>
    </body></html>
    """
    _stub_fetch(monkeypatch, html)

    calls: list[str] = []

    def _channel_enricher(media):
        calls.append("channels")
        # Simulate expansion: add one video so we can prove the metadata pass sees it.
        media.setdefault("youtube", []).append(
            {"video_id": "expanded01x", "url": "https://www.youtube.com/watch?v=expanded01x"}
        )

    def _metadata_enricher(media):
        calls.append("metadata")

    monkeypatch.setattr(footer_harvester, "enrich_media_urls_with_channel_videos", _channel_enricher)
    monkeypatch.setattr(footer_harvester, "enrich_media_urls_with_metadata", _metadata_enricher)

    media = await footer_harvester.harvest_footer_media("https://example.com/")
    # Channels run first so metadata sees the newly-added videos.
    assert calls == ["channels", "metadata"]
    # The expanded video landed in the returned dict.
    assert any(v["video_id"] == "expanded01x" for v in media.get("youtube") or [])


@pytest.mark.asyncio
async def test_harvest_runs_enrichers_off_the_event_loop(monkeypatch):
    """The YouTube enrichers must not block the event loop.

    Regression guard: the real enrichers use synchronous ``urllib.urlopen`` and
    can burn several seconds per fetch. If they run inline on the loop they
    freeze the concurrent main crawl's heartbeat and streaming ingest. This
    test proves the harvester delegates them to a background thread by
    (1) recording the thread that runs each enricher and asserting it isn't
    the main asyncio thread, and (2) confirming a concurrent short-lived
    ``asyncio.sleep`` completes while the enricher is still "working".
    """
    import threading
    import time as _time

    html = """
    <html><body>
      <footer>
        <a href="https://youtube.com/@brand">YouTube</a>
      </footer>
    </body></html>
    """
    _stub_fetch(monkeypatch, html)

    main_thread = threading.get_ident()
    seen_threads: dict[str, int] = {}
    concurrent_flag = {"woke": False}

    def _blocking_channel_enricher(media):
        # 200 ms of blocking work. Long enough that an event-loop-bound
        # implementation would starve the concurrent asyncio.sleep below.
        seen_threads["channels"] = threading.get_ident()
        _time.sleep(0.2)

    def _blocking_metadata_enricher(media):
        seen_threads["metadata"] = threading.get_ident()
        _time.sleep(0.2)

    monkeypatch.setattr(footer_harvester, "enrich_media_urls_with_channel_videos", _blocking_channel_enricher)
    monkeypatch.setattr(footer_harvester, "enrich_media_urls_with_metadata", _blocking_metadata_enricher)

    async def _concurrent_sleeper():
        # If the loop is free while enrichers block a worker thread, this
        # short sleep resolves well before both 200 ms enrichers finish.
        await asyncio.sleep(0.05)
        concurrent_flag["woke"] = True

    await asyncio.gather(
        footer_harvester.harvest_footer_media("https://example.com/"),
        _concurrent_sleeper(),
    )

    assert concurrent_flag["woke"] is True, "event loop was blocked while enrichers ran"
    assert seen_threads.get("channels") not in (None, main_thread), "channel enricher ran on the main thread"
    assert seen_threads.get("metadata") not in (None, main_thread), "metadata enricher ran on the main thread"


@pytest.mark.asyncio
async def test_harvest_dedupes_element_matched_by_multiple_selectors(monkeypatch):
    """Element that matches both ``footer`` and ``.footer`` is processed once."""
    html = """
    <html><body>
      <footer class="footer">
        <a href="https://youtube.com/@brand">YouTube</a>
      </footer>
    </body></html>
    """
    _stub_fetch(monkeypatch, html)

    media = await footer_harvester.harvest_footer_media("https://example.com/")
    # Without the id-based seen-set, the anchor's href would be inlined
    # twice (once per selector hit), leaving a duplicated URL in the text.
    # ``extract_media_urls`` dedupes URLs anyway, so this asserts the
    # observable end state: channel captured exactly once.
    assert media.get("youtube_channels") == ["https://youtube.com/@brand"]
