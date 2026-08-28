from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api.auth import get_current_client_or_operator
from app.api.bot_routes import public_router, router
from app.core.rate_limit import limiter
from app.db.models import BotGrowthEvent


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def first(self):
        return self._value


class _ExecuteResult:
    def __init__(self, value):
        self._value = value

    def scalars(self):
        return _ScalarResult(self._value)


@contextmanager
def _session_context(session):
    yield session


def _build_test_client():
    app = FastAPI()
    # /demo is rate-limited (audit F11). Wire slowapi as main.py does so the
    # decorated route resolves app.state.limiter under TestClient.
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(public_router)
    app.include_router(router)
    return app


class TestBotDemoRoutes:
    def test_demo_page_returns_html_and_tracks_open(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="https://example.com",
            is_active=True,
            allowed_domains=[],
            # No stored capture, so these fakes exercise the hero-page
            # fallback. The capture path has its own tests below.
            demo_screenshot_url=None,
            demo_screenshot_status=None,
            demo_screenshot_source_url=None,
            demo_screenshot_captured_at=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        added = []
        session.add.side_effect = added.append
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
        assert 'data-bot-key="bot-demo123"' in response.text
        assert "Sales Assistant" in response.text
        assert len(added) == 1
        assert isinstance(added[0], BotGrowthEvent)
        assert added[0].event_type == "demo_link_opened"
        assert added[0].bot_id == 7
        session.commit.assert_called_once()

    def test_demo_page_returns_404_for_unknown_bot(self, monkeypatch):
        from app.api import bot_routes

        session = MagicMock()
        session.execute.return_value = _ExecuteResult(None)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-missing")

        assert response.status_code == 404
        session.add.assert_not_called()
        session.commit.assert_not_called()

    def test_demo_share_click_requires_auth(self):
        client = TestClient(_build_test_client())
        response = client.post("/bots/7/demo-share-click")
        assert response.status_code == 401

    def test_demo_share_click_tracks_event_for_workspace_user(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(id=7, name="Sales Assistant", client_id=9)
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        added = []
        session.add.side_effect = added.append
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        app = _build_test_client()
        app.dependency_overrides[get_current_client_or_operator] = lambda: {
            "type": "client",
            "entity": SimpleNamespace(id=9),
            "client_id": 9,
            "operator_id": None,
        }

        client = TestClient(app)
        response = client.post("/bots/7/demo-share-click")

        assert response.status_code == 200
        assert response.json() == {"success": True, "event_type": "demo_share_clicked"}
        assert len(added) == 1
        assert isinstance(added[0], BotGrowthEvent)
        assert added[0].event_type == "demo_share_clicked"
        assert added[0].bot_id == 7
        session.commit.assert_called_once()

    def test_preview_with_url_returns_iframe_html(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="https://example.com",
            is_active=True,
            allowed_domains=[],
            # No stored capture, so these fakes exercise the hero-page
            # fallback. The capture path has its own tests below.
            demo_screenshot_url=None,
            demo_screenshot_status=None,
            demo_screenshot_source_url=None,
            demo_screenshot_captured_at=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        added = []
        session.add.side_effect = added.append
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123?url=https://example.com")

        assert response.status_code == 200
        assert "<iframe" in response.text
        assert 'data-bot-key="bot-demo123"' in response.text
        assert "Sales Assistant" in response.text
        assert "Preview" in response.text
        assert len(added) == 1
        assert added[0].event_type == "demo_link_opened"

    def test_preview_without_url_returns_hero(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="https://example.com",
            is_active=True,
            allowed_domains=[],
            # No stored capture, so these fakes exercise the hero-page
            # fallback. The capture path has its own tests below.
            demo_screenshot_url=None,
            demo_screenshot_status=None,
            demo_screenshot_source_url=None,
            demo_screenshot_captured_at=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123")

        assert response.status_code == 200
        assert "Interactive Demo" in response.text
        assert "<iframe" not in response.text

    def test_preview_rejects_javascript_url(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="",
            is_active=True,
            allowed_domains=[],
            # No stored capture, so these fakes exercise the hero-page
            # fallback. The capture path has its own tests below.
            demo_screenshot_url=None,
            demo_screenshot_status=None,
            demo_screenshot_source_url=None,
            demo_screenshot_captured_at=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123?url=javascript:alert(1)")

        assert response.status_code == 400
        assert "http or https" in response.json()["detail"]

    def test_preview_with_edit_flag_injects_bootstrap(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="https://example.com",
            is_active=True,
            allowed_domains=[],
            # No stored capture, so these fakes exercise the hero-page
            # fallback. The capture path has its own tests below.
            demo_screenshot_url=None,
            demo_screenshot_status=None,
            demo_screenshot_source_url=None,
            demo_screenshot_captured_at=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))
        monkeypatch.setattr(bot_routes, "_check_iframe_allowed", lambda _url: True)

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123?url=https://example.com&edit=1")

        assert response.status_code == 200
        assert "window.__OYECHATS_PREVIEW_MODE__=true" in response.text
        assert "<iframe" in response.text

    def test_preview_without_edit_flag_omits_bootstrap(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="https://example.com",
            is_active=True,
            allowed_domains=[],
            # No stored capture, so these fakes exercise the hero-page
            # fallback. The capture path has its own tests below.
            demo_screenshot_url=None,
            demo_screenshot_status=None,
            demo_screenshot_source_url=None,
            demo_screenshot_captured_at=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))
        monkeypatch.setattr(bot_routes, "_check_iframe_allowed", lambda _url: True)

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123?url=https://example.com")

        assert response.status_code == 200
        assert "__OYECHATS_PREVIEW_MODE__" not in response.text

    def test_hero_page_with_edit_flag_injects_bootstrap(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="https://example.com",
            is_active=True,
            allowed_domains=[],
            # No stored capture, so these fakes exercise the hero-page
            # fallback. The capture path has its own tests below.
            demo_screenshot_url=None,
            demo_screenshot_status=None,
            demo_screenshot_source_url=None,
            demo_screenshot_captured_at=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123?edit=1")

        assert response.status_code == 200
        assert "<iframe" not in response.text
        assert "window.__OYECHATS_PREVIEW_MODE__=true" in response.text

    def test_preview_rejects_empty_netloc(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="",
            is_active=True,
            allowed_domains=[],
            # No stored capture, so these fakes exercise the hero-page
            # fallback. The capture path has its own tests below.
            demo_screenshot_url=None,
            demo_screenshot_status=None,
            demo_screenshot_source_url=None,
            demo_screenshot_captured_at=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123?url=http://")

        assert response.status_code == 400
        assert "Invalid URL" in response.json()["detail"]


class TestPreviewSSRF:
    """F11: the iframe-preview HEAD must not be a server-side SSRF primitive."""

    def test_check_iframe_allowed_blocks_internal_hosts(self):
        """A non-public target is refused outright, no server-side request."""
        from app.api import bot_routes

        assert bot_routes._check_iframe_allowed("http://127.0.0.1/") is False
        assert bot_routes._check_iframe_allowed("http://169.254.169.254/latest/meta-data/") is False
        assert bot_routes._check_iframe_allowed("http://10.0.0.5/") is False

    def test_check_iframe_allowed_does_not_follow_redirects(self, monkeypatch):
        """The HEAD client must be built with follow_redirects=False so a 3xx
        can't bounce the request to an internal address (the F11 bypass)."""
        import httpx

        from app.api import bot_routes

        # Skip the DNS-backed guard so this test isolates the redirect behavior.
        monkeypatch.setattr(bot_routes, "validate_public_url", lambda u: u)

        captured = {}

        class _FakeResp:
            status_code = 200
            headers: dict = {}

        class _FakeClient:
            def __init__(self, *args, **kwargs):
                captured.update(kwargs)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def head(self, *args, **kwargs):
                return _FakeResp()

        monkeypatch.setattr(httpx, "Client", _FakeClient)

        bot_routes._check_iframe_allowed("https://example.com/")

        assert captured.get("follow_redirects") is False

    def test_check_iframe_allowed_treats_redirect_as_not_embeddable(self, monkeypatch):
        """A redirecting site (http->https, apex->www) returns a 3xx we don't
        follow. Treat it as not-embeddable so the demo serves the working hero
        fallback instead of embedding a likely frame-blocked page (RV6)."""
        import httpx

        from app.api import bot_routes

        monkeypatch.setattr(bot_routes, "validate_public_url", lambda u: u)

        class _RedirectResp:
            status_code = 301
            headers: dict = {}

        class _RedirectClient:
            def __init__(self, *args, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def head(self, *args, **kwargs):
                return _RedirectResp()

        monkeypatch.setattr(httpx, "Client", _RedirectClient)

        assert bot_routes._check_iframe_allowed("https://example.com/") is False


def _captured_bot(**overrides):
    """A bot whose website has a fresh, usable capture stored."""
    from datetime import UTC, datetime

    base = dict(
        id=7,
        bot_key="bot-demo123",
        name="Sales Assistant",
        website="https://example.com",
        is_active=True,
        allowed_domains=[],
        demo_screenshot_url="https://cdn.oyechats.com/demo-screenshots/7/abc.png",
        demo_screenshot_status="ready",
        demo_screenshot_source_url="https://example.com",
        demo_screenshot_captured_at=datetime.now(UTC),
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _wire(monkeypatch, bot):
    """Point the route at ``bot`` and return the recorded growth events."""
    from app.api import bot_routes

    session = MagicMock()
    session.execute.return_value = _ExecuteResult(bot)
    added = []
    session.add.side_effect = added.append
    monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))
    return added


class TestDemoScreenshotPage:
    """The demo link's whole purpose: show the customer's OWN site."""

    def test_capture_renders_the_customers_site_not_the_hero_page(self, monkeypatch):
        _wire(monkeypatch, _captured_bot())

        response = TestClient(_build_test_client()).get("/demo/bot-demo123")

        assert response.status_code == 200
        assert "demo-screenshots/7/abc.png" in response.text
        assert "example.com" in response.text
        assert 'data-bot-key="bot-demo123"' in response.text
        # The hero page's headline must not be what a shared link resolves to
        # once we have a real picture of the customer's site.
        assert "Try Sales Assistant on a live page." not in response.text

    def test_falls_back_to_hero_when_no_capture(self, monkeypatch):
        _wire(monkeypatch, _captured_bot(demo_screenshot_status=None, demo_screenshot_url=None))

        response = TestClient(_build_test_client()).get("/demo/bot-demo123")

        assert response.status_code == 200
        assert "Try Sales Assistant on a live page." in response.text

    def test_failed_capture_falls_back_rather_than_rendering_a_broken_image(self, monkeypatch):
        _wire(monkeypatch, _captured_bot(demo_screenshot_status="failed"))

        response = TestClient(_build_test_client()).get("/demo/bot-demo123")

        assert "Try Sales Assistant on a live page." in response.text

    def test_stale_capture_is_not_served(self, monkeypatch):
        """Past the TTL the hero page is more honest than a screenshot of a
        site design the customer may have replaced months ago."""
        from datetime import UTC, datetime, timedelta

        _wire(monkeypatch, _captured_bot(demo_screenshot_captured_at=datetime.now(UTC) - timedelta(days=365)))

        response = TestClient(_build_test_client()).get("/demo/bot-demo123")

        assert "Try Sales Assistant on a live page." in response.text

    def test_capture_of_a_different_site_is_never_served(self, monkeypatch):
        """A customer who changed their website must not be shown a current-
        looking demo of their previous one."""
        _wire(monkeypatch, _captured_bot(website="https://newsite.com"))

        response = TestClient(_build_test_client()).get("/demo/bot-demo123")

        assert "Try Sales Assistant on a live page." in response.text

    def test_capture_is_preferred_when_the_site_refuses_framing(self, monkeypatch):
        """`?url=` on a frame-blocking site should land on the capture, which
        shows the same site and cannot be blocked, not on a generic page."""
        from app.api import bot_routes

        _wire(monkeypatch, _captured_bot())
        monkeypatch.setattr(bot_routes, "_validate_preview_url", lambda u: u)
        monkeypatch.setattr(bot_routes, "_check_iframe_allowed", lambda u: False)

        response = TestClient(_build_test_client()).get("/demo/bot-demo123?url=https://example.com")

        assert response.status_code == 200
        assert "demo-screenshots/7/abc.png" in response.text


class TestDemoUrlOwnership:
    """`?url=` is unauthenticated and keyed on a PUBLIC bot key, so it must not
    render arbitrary third-party sites under our own domain and branding."""

    def test_foreign_url_is_refused(self, monkeypatch):
        from app.api import bot_routes

        _wire(monkeypatch, _captured_bot())
        monkeypatch.setattr(bot_routes, "_validate_preview_url", lambda u: u)
        monkeypatch.setattr(bot_routes, "_check_iframe_allowed", lambda u: True)

        response = TestClient(_build_test_client()).get("/demo/bot-demo123?url=https://evil.example.net")

        assert response.status_code == 400
        assert "own website" in response.json()["detail"]

    def test_own_site_is_allowed(self, monkeypatch):
        from app.api import bot_routes

        _wire(monkeypatch, _captured_bot())
        monkeypatch.setattr(bot_routes, "_validate_preview_url", lambda u: u)
        monkeypatch.setattr(bot_routes, "_check_iframe_allowed", lambda u: True)

        response = TestClient(_build_test_client()).get("/demo/bot-demo123?url=https://example.com/pricing")

        assert response.status_code == 200
        assert "<iframe" in response.text

    def test_www_variant_of_own_site_is_allowed(self, monkeypatch):
        """Customers store whichever of apex/www they typed; both are the same
        site to everyone except a string comparison."""
        from app.api import bot_routes

        _wire(monkeypatch, _captured_bot())
        monkeypatch.setattr(bot_routes, "_validate_preview_url", lambda u: u)
        monkeypatch.setattr(bot_routes, "_check_iframe_allowed", lambda u: True)

        response = TestClient(_build_test_client()).get("/demo/bot-demo123?url=https://www.example.com")

        assert response.status_code == 200
        assert "<iframe" in response.text

    def test_allow_listed_domain_is_permitted(self, monkeypatch):
        from app.api import bot_routes

        _wire(monkeypatch, _captured_bot(allowed_domains=["staging.example.org"]))
        monkeypatch.setattr(bot_routes, "_validate_preview_url", lambda u: u)
        monkeypatch.setattr(bot_routes, "_check_iframe_allowed", lambda u: True)

        response = TestClient(_build_test_client()).get("/demo/bot-demo123?url=https://staging.example.org")

        assert response.status_code == 200
        assert "<iframe" in response.text

    def test_empty_allow_list_does_not_fail_open(self, monkeypatch):
        """`domain_check_enabled` fails open on an empty allow-list so a new
        bot's widget still boots. Doing that HERE would reinstate the abuse
        this guard exists to prevent."""
        from app.api import bot_routes

        _wire(monkeypatch, _captured_bot(website=None, allowed_domains=[]))
        monkeypatch.setattr(bot_routes, "_validate_preview_url", lambda u: u)
        monkeypatch.setattr(bot_routes, "_check_iframe_allowed", lambda u: True)

        response = TestClient(_build_test_client()).get("/demo/bot-demo123?url=https://anything.example.net")

        assert response.status_code == 400
