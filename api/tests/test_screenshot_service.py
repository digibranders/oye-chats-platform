"""Capture path for the hosted demo page's backdrop.

The important guarantees here are negative ones: a provider that answers 200
with something that is not an image must never reach the CDN, because the
result is a broken picture on the one page a customer sends to prospects.
"""

import pytest

from app.services import screenshot_service as svc

PNG = b"\x89PNG\r\n\x1a\n" + b"payload"
JPEG = b"\xff\xd8\xff" + b"payload"


class TestNormalizeSiteUrl:
    def test_bare_hostname_becomes_https(self):
        assert svc.normalize_site_url("acme.com") == "https://acme.com"

    def test_existing_scheme_is_kept(self):
        assert svc.normalize_site_url("http://acme.com/pricing") == "http://acme.com/pricing"

    @pytest.mark.parametrize("raw", [None, "", "   ", "localhost", "ftp://acme.com", "not a url"])
    def test_unusable_values_return_none(self, raw):
        assert svc.normalize_site_url(raw) is None

    def test_dotless_host_is_refused(self):
        """A hostname with no dot is a local name or a typo, never a public
        site worth spending a paid render on."""
        assert svc.normalize_site_url("https://intranet") is None


class TestBuildScreenshotKey:
    def test_key_is_unguessable_and_bot_scoped(self):
        first = svc.build_screenshot_key(7)
        second = svc.build_screenshot_key(7)

        assert first.startswith("demo-screenshots/7/")
        # Captures sit on the public CDN and bot keys are public, so a key
        # derived only from the bot id would let anyone enumerate every
        # customer's homepage capture.
        assert first != second


class TestAsCapture:
    def test_png_and_jpeg_are_accepted(self):
        assert svc._as_capture(PNG, provider="p", url="u").content_type == "image/png"
        assert svc._as_capture(JPEG, provider="p", url="u").content_type == "image/jpeg"

    def test_empty_body_is_refused(self):
        with pytest.raises(svc.ScreenshotError):
            svc._as_capture(b"", provider="p", url="u")

    def test_non_image_body_is_refused(self):
        """Content-Type is the provider's claim, not evidence. A JSON error
        body served as image/png would otherwise be stored and then rendered
        as a broken image on the customer's demo page."""
        with pytest.raises(svc.ScreenshotError):
            svc._as_capture(b'{"error":"could not render"}', provider="p", url="u")

    def test_oversized_capture_is_refused(self, monkeypatch):
        monkeypatch.setattr(svc, "DEMO_SCREENSHOT_MAX_BYTES", 4)
        with pytest.raises(svc.ScreenshotError):
            svc._as_capture(PNG, provider="p", url="u")

    def test_extension_follows_the_sniffed_format(self):
        assert svc._as_capture(JPEG, provider="p", url="u").extension == "jpg"
        assert svc._as_capture(PNG, provider="p", url="u").extension == "png"


class TestDecodeSpiderBody:
    def test_raw_image_passes_through(self):
        assert svc._decode_spider_body(PNG) == PNG

    def test_base64_json_shape_is_decoded(self):
        import base64
        import json

        body = json.dumps([{"content": base64.b64encode(PNG).decode()}]).encode()
        assert svc._decode_spider_body(body) == PNG

    def test_object_shape_is_decoded(self):
        import base64
        import json

        body = json.dumps({"content": base64.b64encode(JPEG).decode()}).encode()
        assert svc._decode_spider_body(body) == JPEG

    def test_json_without_content_yields_nothing(self):
        assert svc._decode_spider_body(b'{"error": "boom"}') == b""

    def test_unparseable_body_is_returned_for_the_caller_to_reject(self):
        assert svc._decode_spider_body(b"not json, not an image") == b"not json, not an image"


class TestCaptureFullPage:
    @pytest.mark.anyio
    async def test_ssrf_unsafe_url_is_refused_before_any_request(self, monkeypatch):
        from app.core.ssrf import SSRFError

        def _boom(url):
            raise SSRFError("non-public address")

        monkeypatch.setattr(svc, "validate_public_url", _boom)

        with pytest.raises(svc.ScreenshotError):
            await svc.capture_full_page("http://169.254.169.254/latest/meta-data/")

    @pytest.mark.anyio
    async def test_fallback_provider_runs_when_the_primary_fails(self, monkeypatch):
        monkeypatch.setattr(svc, "validate_public_url", lambda u: u)
        monkeypatch.setattr(svc, "DEMO_SCREENSHOT_PROVIDER", "spider")
        calls = []

        async def _fail(url, client):
            calls.append("primary")
            raise svc.ScreenshotError("primary down")

        async def _ok(url, client):
            calls.append("fallback")
            return svc.Capture(data=PNG, content_type="image/png")

        monkeypatch.setattr(svc, "_capture_via_spider", _fail)
        monkeypatch.setattr(svc, "_capture_via_jina", _ok)

        capture = await svc.capture_full_page("https://acme.com")

        assert capture.data == PNG
        assert calls == ["primary", "fallback"]

    @pytest.mark.anyio
    async def test_both_providers_failing_raises(self, monkeypatch):
        monkeypatch.setattr(svc, "validate_public_url", lambda u: u)

        async def _fail(url, client):
            raise svc.ScreenshotError("down")

        monkeypatch.setattr(svc, "_capture_via_spider", _fail)
        monkeypatch.setattr(svc, "_capture_via_jina", _fail)

        with pytest.raises(svc.ScreenshotError):
            await svc.capture_full_page("https://acme.com")

    @pytest.mark.anyio
    async def test_jina_leads_by_default(self, monkeypatch):
        """The default order matches CRAWL_PROVIDER_PRIMARY, which is Reader.

        Pinned in a test because the order is a one-word config value and
        flipping it silently changes which vendor renders every customer's
        site.
        """
        from app import config

        assert config.DEMO_SCREENSHOT_PROVIDER == "jina"

        monkeypatch.setattr(svc, "validate_public_url", lambda u: u)
        monkeypatch.setattr(svc, "DEMO_SCREENSHOT_PROVIDER", "jina")
        order = []

        async def _jina(url, client):
            order.append("jina")
            raise svc.ScreenshotError("reader down")

        async def _spider(url, client):
            order.append("spider")
            return svc.Capture(data=PNG, content_type="image/png")

        monkeypatch.setattr(svc, "_capture_via_jina", _jina)
        monkeypatch.setattr(svc, "_capture_via_spider", _spider)

        await svc.capture_full_page("https://acme.com")

        assert order == ["jina", "spider"]


class TestRefreshBotCapture:
    """The shared entry point behind both the ARQ task and the inline
    fallback. ``WORKER_ENABLED`` defaults to false, so the inline path is the
    one most deployments actually run."""

    def test_disabled_feature_does_no_work(self, monkeypatch):
        monkeypatch.setattr("app.config.DEMO_SCREENSHOT_ENABLED", False)
        called = []
        monkeypatch.setattr(svc, "capture_and_store", lambda *a: called.append(a))

        assert svc.refresh_bot_capture(1) is False
        assert called == []

    def test_a_capture_failure_clears_pending(self, monkeypatch):
        """A row left on 'pending' strands the Deploy card on "we are taking a
        picture now" with nothing ever arriving."""
        recorded = []
        monkeypatch.setattr(svc, "_record_status", lambda bot_id, status: recorded.append((bot_id, status)))
        monkeypatch.setattr(svc, "normalize_site_url", lambda raw: "https://acme.com")

        def _boom(bot_id, url):
            raise svc.ScreenshotError("render failed")

        monkeypatch.setattr(svc, "capture_and_store", _boom)

        # Exercised through the real function, with the DB layer stubbed by the
        # session fixture the other service tests use.
        import app.db.session as db_session

        class _Bot:
            demo_screenshot_status = None
            demo_screenshot_url = None
            demo_screenshot_source_url = None
            demo_screenshot_captured_at = None
            website = "https://acme.com"

        from contextlib import contextmanager

        holder = _Bot()

        class _Session:
            def get(self, model, pk):
                return holder

            def commit(self):
                pass

        @contextmanager
        def _fake_session():
            yield _Session()

        monkeypatch.setattr(db_session, "get_session", _fake_session)

        assert svc.refresh_bot_capture(1) is False
        assert recorded == [(1, "failed")]

    def test_an_unexpected_error_also_clears_pending(self, monkeypatch):
        """Not just ScreenshotError: any exception must leave a terminal state
        behind, or the card waits forever on a capture that already died."""
        recorded = []
        monkeypatch.setattr(svc, "_record_status", lambda bot_id, status: recorded.append((bot_id, status)))

        def _boom(bot_id, url):
            raise RuntimeError("something else entirely")

        monkeypatch.setattr(svc, "capture_and_store", _boom)

        from contextlib import contextmanager

        import app.db.session as db_session

        class _Bot:
            demo_screenshot_status = None
            demo_screenshot_url = None
            demo_screenshot_source_url = None
            demo_screenshot_captured_at = None
            website = "https://acme.com"

        holder = _Bot()

        class _Session:
            def get(self, model, pk):
                return holder

            def commit(self):
                pass

        @contextmanager
        def _fake_session():
            yield _Session()

        monkeypatch.setattr(db_session, "get_session", _fake_session)

        assert svc.refresh_bot_capture(1) is False
        assert recorded == [(1, "failed")]


class TestSpiderUpstreamError:
    """Spider answers 200 with a per-target failure in the body, so the HTTP
    status alone cannot tell a broken integration from a site that would not
    render. Verified against the live endpoint."""

    def test_extracts_error_and_status(self):
        body = b'[{"error":"Error getting website url.","status":504,"url":"https://acme.com/"}]'
        assert svc._spider_upstream_error(body) == "Error getting website url. (upstream status 504)"

    def test_no_image_bytes_is_reported_rather_than_stored(self):
        body = b'[{"error":"screenshot route produced no image bytes on this backend","status":200}]'
        detail = svc._spider_upstream_error(body)
        assert detail is not None
        assert "no image bytes" in detail

    def test_real_image_has_no_upstream_error(self):
        assert svc._spider_upstream_error(PNG) is None

    def test_body_without_an_error_key_is_clean(self):
        assert svc._spider_upstream_error(b'[{"status":200,"url":"https://acme.com/"}]') is None

    def test_unparseable_body_is_not_reported_as_an_upstream_error(self):
        # It is still rejected downstream by the magic-number check; it is just
        # not evidence about the TARGET.
        assert svc._spider_upstream_error(b"not json") is None
