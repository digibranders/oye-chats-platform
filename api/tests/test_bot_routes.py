"""Tests for app.api.bot_routes — bot management endpoints."""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import (
    get_current_bot,
    get_current_client_or_operator,
    require_active_subscription_for_workspace,
)
from app.api.bot_routes import public_router, router


@contextmanager
def _session_ctx(session):
    yield session


def _build_app(auth_override=None, bot_override=None):
    app = FastAPI()
    app.include_router(public_router)
    app.include_router(router)
    if auth_override:
        app.dependency_overrides[get_current_client_or_operator] = lambda: auth_override
    if bot_override:
        app.dependency_overrides[get_current_bot] = lambda: bot_override
    # The subscription gate is a separate concern from bot-route logic —
    # every test in this module exercises an authenticated, paying user, so
    # we short-circuit the gate to "allow" rather than build a fake
    # subscription row per test. PR3 has its own dedicated coverage for
    # the gate semantics (see test_trial_enforcement.py).
    app.dependency_overrides[require_active_subscription_for_workspace] = lambda: None
    return app


def _client_auth(client_id=1):
    return {
        "type": "client",
        "entity": SimpleNamespace(id=client_id),
        "client_id": client_id,
        "operator_id": None,
    }


def _operator_auth(client_id=1, role="admin"):
    return {
        "type": "operator",
        "entity": SimpleNamespace(id=10, client_id=client_id, role=role),
        "client_id": client_id,
        "operator_id": 10,
    }


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def first(self):
        return self._value

    def all(self):
        return self._value if isinstance(self._value, list) else [self._value] if self._value else []


class _ExecuteResult:
    def __init__(self, value):
        self._value = value

    def scalars(self):
        return _ScalarResult(self._value)


# ── Bot CRUD ─────────────────────────────────────────────────────────────────


class TestCreateBot:
    def test_creates_bot(self, monkeypatch):
        from app.api import bot_routes
        from app.services.plan_entitlements_service import AddBotDecision

        session = MagicMock()
        added = []
        session.add.side_effect = added.append
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)

        # Per-bot billing model: ``create_bot`` consults
        # ``can_client_add_new_bot`` instead of resolving plan-level
        # bot limits. The fake decision says this client may still add
        # another bot (paid subscription in good standing).
        allowed = AddBotDecision(allowed=True, reason="ok", must_subscribe=False, active_bot_count=0)
        with patch(
            "app.services.plan_entitlements_service.can_client_add_new_bot",
            return_value=allowed,
        ):
            response = tc.post("/bots", json={"name": "My Bot", "website": "https://mysite.com"})

        assert response.status_code == 201
        data = response.json()
        assert "bot_id" in data
        assert data["name"] == "My Bot"
        # Two rows are persisted on a successful create: the Bot itself and
        # an in-app ``bot_created`` Notification dropped into the
        # workspace's notification feed.
        from app.db.models import Bot, Notification

        assert len(added) == 2
        assert any(isinstance(r, Bot) for r in added)
        assert any(isinstance(r, Notification) for r in added)

    def test_operator_without_permission_rejected(self, monkeypatch):
        from app.api import bot_routes

        session = MagicMock()
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        app = _build_app(auth_override=_operator_auth(role="operator"))
        tc = TestClient(app)

        response = tc.post("/bots", json={"name": "Bot"})
        assert response.status_code == 403


class TestDeleteBot:
    def test_deletes_bot(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(id=5, client_id=1, bot_key="bot-xyz")
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        with patch("app.api.bot_routes.cache_delete"):
            app = _build_app(auth_override=_client_auth())
            tc = TestClient(app)
            response = tc.delete("/bots/5")

        assert response.status_code == 200
        session.delete.assert_called_once_with(bot)

    def test_not_found(self, monkeypatch):
        from app.api import bot_routes

        session = MagicMock()
        session.execute.return_value = _ExecuteResult(None)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)
        response = tc.delete("/bots/999")

        assert response.status_code == 404


# ── Bot settings (public) ───────────────────────────────────────────────────


class TestBotSettingsPublic:
    def test_returns_settings(self, monkeypatch):
        from app.api import bot_routes as br

        # Use MagicMock to auto-create missing attrs; set key fields explicitly
        bot = MagicMock()
        bot.primary_color = "#4F46E5"
        bot.background_color = "#FFF"
        bot.header_color = "#4F46E5"
        bot.user_bubble_color = None
        bot.welcome_title = "Hello"
        bot.welcome_subtitle = "Ask anything"
        bot.bot_logo = None
        bot.launcher_logo = None
        bot.launcher_name = None
        bot.feature_flags = {}
        bot.widget_messages = {}
        bot.widget_config = {}
        bot.bant_enabled = False
        bot.bant_config = None
        bot.lead_form_enabled = False
        bot.lead_form_fields = None
        bot.live_chat_enabled = False
        bot.branding_text = None
        bot.branding_url = None
        bot.recommended_colors = None
        bot.offline_message = None
        bot.waiting_message = None
        bot.handoff_delay_seconds = None
        bot.meeting_booking_enabled = False
        bot.calendly_url = None

        request = MagicMock()
        request.base_url = "http://test/"

        with (
            patch.object(br, "_build_public_cta_options", return_value={}),
            patch.object(br, "bot_subscription_status", return_value="active"),
        ):
            result = br.get_bot_settings_public(request, bot)

        assert result["primary_color"] == "#4F46E5"
        assert result["welcome_title"] == "Hello"
        assert result["is_offline"] is False
        assert result["offline_reason"] is None


# ── Bot update ───────────────────────────────────────────────────────────────


class TestUpdateBot:
    def test_updates_name(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=5,
            client_id=1,
            bot_key="bot-xyz",
            name="Old Name",
            feature_flags={},
            widget_messages={},
            widget_config={},
            bant_config=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        with patch("app.api.bot_routes.cache_delete"):
            app = _build_app(auth_override=_client_auth())
            tc = TestClient(app)
            response = tc.patch("/bots/5", json={"name": "New Name"})

        assert response.status_code == 200
        assert bot.name == "New Name"

    def test_merges_feature_flags(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=5,
            client_id=1,
            bot_key="bot-xyz",
            name="Bot",
            feature_flags={"existing_flag": True, "another": False},
            widget_messages={},
            widget_config={},
            bant_config=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        with patch("app.api.bot_routes.cache_delete"):
            app = _build_app(auth_override=_client_auth())
            tc = TestClient(app)
            response = tc.patch("/bots/5", json={"feature_flags": {"new_flag": True}})

        assert response.status_code == 200
        # Existing flags should be preserved
        assert bot.feature_flags["existing_flag"] is True
        assert bot.feature_flags["new_flag"] is True

    def test_invalidates_cache(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=5,
            client_id=1,
            bot_key="bot-xyz",
            name="Bot",
            feature_flags={},
            widget_messages={},
            widget_config={},
            bant_config=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        with patch("app.api.bot_routes.cache_delete") as mock_cache:
            app = _build_app(auth_override=_client_auth())
            tc = TestClient(app)
            tc.patch("/bots/5", json={"name": "Updated"})

        mock_cache.assert_called()


# ── Access control ───────────────────────────────────────────────────────────


class TestBotAccessControl:
    def test_regular_operator_cannot_create(self, monkeypatch):
        from app.api import bot_routes

        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(MagicMock()))

        app = _build_app(auth_override=_operator_auth(role="operator"))
        tc = TestClient(app)
        response = tc.post("/bots", json={"name": "Bot"})
        assert response.status_code == 403

    def test_admin_operator_can_create(self, monkeypatch):
        from app.api import bot_routes
        from app.services.plan_entitlements_service import AddBotDecision

        session = MagicMock()
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        # Same gate as TestCreateBot.test_creates_bot — the route now
        # consults ``can_client_add_new_bot`` instead of resolving
        # plan-level bot limits.
        allowed = AddBotDecision(allowed=True, reason="ok", must_subscribe=False, active_bot_count=0)
        app = _build_app(auth_override=_operator_auth(role="admin"))
        tc = TestClient(app)
        with patch(
            "app.services.plan_entitlements_service.can_client_add_new_bot",
            return_value=allowed,
        ):
            response = tc.post("/bots", json={"name": "Bot"})
        assert response.status_code == 201

    def test_owner_operator_can_create(self, monkeypatch):
        from app.api import bot_routes
        from app.services.plan_entitlements_service import AddBotDecision

        session = MagicMock()
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        allowed = AddBotDecision(allowed=True, reason="ok", must_subscribe=False, active_bot_count=0)
        app = _build_app(auth_override=_operator_auth(role="owner"))
        tc = TestClient(app)
        with patch(
            "app.services.plan_entitlements_service.can_client_add_new_bot",
            return_value=allowed,
        ):
            response = tc.post("/bots", json={"name": "Bot"})
        assert response.status_code == 201


# ── Demo page ────────────────────────────────────────────────────────────────


class TestDemoPage:
    def test_validates_url_scheme(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=1,
            bot_key="bot-demo",
            name="Bot",
            website="",
            is_active=True,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        tc = TestClient(_build_app())
        response = tc.get("/demo/bot-demo?url=ftp://bad-scheme.com")
        assert response.status_code == 400
