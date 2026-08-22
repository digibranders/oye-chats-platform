"""Integration and route tests for Bot.language_config in API endpoints (Phase 1)."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import bot_routes
from app.api.auth import (
    get_current_bot,
    get_current_client_or_operator,
    require_active_subscription_for_workspace,
    require_verified_email_for_workspace,
)
from app.api.bot_routes import public_router, router


def _client_auth(client_id=1):
    return {
        "type": "client",
        "entity": SimpleNamespace(id=client_id),
        "client_id": client_id,
        "operator_id": None,
    }


def _build_app(auth_override=None, bot_override=None) -> FastAPI:
    app = FastAPI()
    app.include_router(public_router)
    app.include_router(router)
    if auth_override:
        app.dependency_overrides[get_current_client_or_operator] = lambda: auth_override
    if bot_override:
        app.dependency_overrides[get_current_bot] = lambda: bot_override
    app.dependency_overrides[require_active_subscription_for_workspace] = lambda: None
    app.dependency_overrides[require_verified_email_for_workspace] = lambda: None
    return app


class _SessionContext:
    def __init__(self, session):
        self.session = session

    def __enter__(self):
        return self.session

    def __exit__(self, *args):
        pass


class _ExecuteResult:
    def __init__(self, scalar_val):
        self._scalar = scalar_val

    def scalar_one(self):
        return self._scalar

    def scalar_one_or_none(self):
        return self._scalar

    def scalars(self):
        return self

    def first(self):
        return self._scalar

    def all(self):
        return [self._scalar] if self._scalar is not None else []


def test_public_settings_returns_language_config():
    """GET /bots/settings/public exposes language_config in its response."""
    bot = MagicMock()
    bot.id = 1
    bot.name = "Test Bot"
    bot.bot_logo = None
    bot.launcher_name = None
    bot.launcher_logo = None
    bot.primary_color = "#4F46E5"
    bot.background_color = "#FFFFFF"
    bot.header_color = "#4F46E5"
    bot.recommended_colors = []
    bot.user_bubble_color = None
    bot.bant_enabled = False
    bot.avatar_type = "upload"
    bot.orb_color = None
    bot.lead_form_enabled = False
    bot.email_verification_enabled = False
    bot.company_lookup_enabled = False
    bot.lead_form_fields = None
    bot.live_chat_enabled = False
    bot.business_hours = None
    bot.feature_flags = {}
    bot.widget_messages = {}
    bot.widget_config = {}
    bot.branding_text = "Powered by OyeChats"
    bot.branding_url = "https://www.oyechats.com"
    bot.welcome_title = "Hi there"
    bot.welcome_subtitle = "How can we help?"
    bot.waiting_message = "Connecting..."
    bot.offline_message = "We'll be right back!"
    bot.handoff_delay_seconds = 0
    bot.meeting_booking_enabled = False
    bot.meeting_provider = None
    bot.calendly_url = None
    bot.zcal_url = None
    bot.calcom_url = None
    bot.session_share_domain = None
    bot.answer_links = None
    bot.widget_installed_at = None
    bot.language_config = {
        "enabled": True,
        "default_locale": "hi-IN",
        "supported_locales": ["en-IN", "hi-IN"],
        "auto_detect": True,
        "allow_visitor_language_switch": True,
        "operator_translation_enabled": False,
    }

    request = MagicMock()
    request.base_url = "http://test/"

    with (
        patch.object(bot_routes, "_build_public_cta_options", return_value={}),
        patch.object(bot_routes, "bot_subscription_status", return_value="active"),
        patch("app.db.session.get_session", lambda: _SessionContext(MagicMock())),
        patch(
            "app.services.plan_entitlements_service.get_bot_entitlements",
            return_value=MagicMock(has_feature=lambda f: True, plan_slug="professional"),
        ),
    ):
        settings = bot_routes.get_bot_settings_public(request, bot)

    assert "language_config" in settings
    assert settings["language_config"]["enabled"] is True
    assert settings["language_config"]["default_locale"] == "hi-IN"
    assert settings["language_config"]["supported_locales"] == ["en-IN", "hi-IN"]


def test_public_settings_defaults_empty_dict_for_legacy_bot():
    """GET /bots/settings/public returns {} if language_config is None/empty."""
    bot = MagicMock()
    bot.id = 1
    bot.name = "Test Bot"
    bot.bot_logo = None
    bot.launcher_name = None
    bot.launcher_logo = None
    bot.primary_color = "#4F46E5"
    bot.background_color = "#FFFFFF"
    bot.header_color = "#4F46E5"
    bot.recommended_colors = []
    bot.user_bubble_color = None
    bot.bant_enabled = False
    bot.avatar_type = "upload"
    bot.orb_color = None
    bot.lead_form_enabled = False
    bot.email_verification_enabled = False
    bot.company_lookup_enabled = False
    bot.lead_form_fields = None
    bot.live_chat_enabled = False
    bot.business_hours = None
    bot.feature_flags = {}
    bot.widget_messages = {}
    bot.widget_config = {}
    bot.branding_text = "Powered by OyeChats"
    bot.branding_url = "https://www.oyechats.com"
    bot.welcome_title = "Hi there"
    bot.welcome_subtitle = "How can we help?"
    bot.waiting_message = "Connecting..."
    bot.offline_message = "We'll be right back!"
    bot.handoff_delay_seconds = 0
    bot.meeting_booking_enabled = False
    bot.meeting_provider = None
    bot.calendly_url = None
    bot.zcal_url = None
    bot.calcom_url = None
    bot.session_share_domain = None
    bot.answer_links = None
    bot.widget_installed_at = None
    bot.language_config = None

    request = MagicMock()
    request.base_url = "http://test/"

    with (
        patch.object(bot_routes, "_build_public_cta_options", return_value={}),
        patch.object(bot_routes, "bot_subscription_status", return_value="active"),
        patch("app.db.session.get_session", lambda: _SessionContext(MagicMock())),
        patch(
            "app.services.plan_entitlements_service.get_bot_entitlements",
            return_value=MagicMock(has_feature=lambda f: True, plan_slug="free"),
        ),
    ):
        settings = bot_routes.get_bot_settings_public(request, bot)

    assert settings["language_config"] == {}


def test_update_bot_merges_language_config(monkeypatch):
    """PATCH /bots/{id} merges language_config partially without wiping other keys."""
    bot = SimpleNamespace(
        id=5,
        client_id=1,
        bot_key="bot-xyz",
        name="Bot",
        feature_flags={},
        language_config={
            "enabled": False,
            "default_locale": "en-IN",
            "supported_locales": ["en-IN"],
            "auto_detect": True,
        },
        widget_messages={},
        widget_config={},
        bant_config=None,
        manual_field_overrides=[],
    )
    session = MagicMock()
    session.execute.return_value = _ExecuteResult(bot)
    monkeypatch.setattr(bot_routes, "get_session", lambda: _SessionContext(session))

    with patch("app.api.bot_routes.cache_delete"):
        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)
        response = tc.patch(
            "/bots/5",
            json={
                "language_config": {
                    "enabled": True,
                    "supported_locales": ["en-IN", "hi-IN", "fr-FR"],
                }
            },
        )

    assert response.status_code == 200
    assert bot.language_config["enabled"] is True
    # Preserved previous keys
    assert bot.language_config["default_locale"] == "en-IN"
    assert bot.language_config["auto_detect"] is True
    # Updated keys
    assert bot.language_config["supported_locales"] == ["en-IN", "hi-IN", "fr-FR"]
