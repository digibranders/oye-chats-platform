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


# ── Phase 5B: the shape the admin Language card actually sends ───────────────


def _language_bot(language_config):
    return SimpleNamespace(
        id=5,
        client_id=1,
        bot_key="bot-xyz",
        name="Bot",
        feature_flags={},
        language_config=language_config,
        widget_messages={},
        widget_config={},
        bant_config=None,
        manual_field_overrides=[],
    )


def _patch_language(monkeypatch, bot, payload):
    session = MagicMock()
    session.execute.return_value = _ExecuteResult(bot)
    monkeypatch.setattr(bot_routes, "get_session", lambda: _SessionContext(session))
    with patch("app.api.bot_routes.cache_delete") as cache_delete:
        tc = TestClient(_build_app(auth_override=_client_auth()))
        response = tc.patch("/bots/5", json={"language_config": payload})
    return response, cache_delete


# What `languagePatch()` in app/src/features/agents/experience/botConfig.ts emits.
CARD_PAYLOAD = {
    "enabled": True,
    "supported_locales": ["en-IN", "hi-IN"],
    "default_locale": "en-IN",
    "auto_detect": True,
    "allow_visitor_language_switch": True,
    "operator_translation_enabled": True,
}


def test_language_card_payload_persists_every_key(monkeypatch):
    """The admin card sends all six keys at once, so nothing stale survives."""
    bot = _language_bot({"enabled": False, "default_locale": "hi-IN"})
    response, _ = _patch_language(monkeypatch, bot, CARD_PAYLOAD)

    assert response.status_code == 200, response.text
    assert bot.language_config == CARD_PAYLOAD


def test_language_card_payload_leaves_unrelated_keys_alone(monkeypatch):
    """The merge is shallow, so a key this UI does not own is not collateral."""
    bot = _language_bot({"enabled": False, "some_future_key": "keep me"})
    _patch_language(monkeypatch, bot, CARD_PAYLOAD)

    assert bot.language_config["some_future_key"] == "keep me"


def test_saving_the_language_card_invalidates_the_widget_cache(monkeypatch):
    """Without this, a customer's change waits out the 10-minute config TTL."""
    bot = _language_bot({"enabled": False})
    _, cache_delete = _patch_language(monkeypatch, bot, CARD_PAYLOAD)

    assert cache_delete.call_count == 1


def test_operator_translation_without_multilingual_is_still_rejected(monkeypatch):
    """The 422 the admin card is built to make unreachable.

    Asserted from the route's side as well, because the UI guard is only a
    convenience: an API client can still send this pair, and the server has to
    keep refusing it.
    """
    bot = _language_bot({"enabled": False})
    response, _ = _patch_language(monkeypatch, bot, {"enabled": False, "operator_translation_enabled": True})

    assert response.status_code == 422
    assert bot.language_config == {"enabled": False}


def test_turning_multilingual_off_from_the_card_clears_operator_translation(monkeypatch):
    """The card sends both keys together, so the merge cannot strand the flag."""
    bot = _language_bot({"enabled": True, "operator_translation_enabled": True})
    response, _ = _patch_language(
        monkeypatch, bot, {**CARD_PAYLOAD, "enabled": False, "operator_translation_enabled": False}
    )

    assert response.status_code == 200, response.text
    assert bot.language_config["enabled"] is False
    assert bot.language_config["operator_translation_enabled"] is False


# ── supported_locales is validated on write ──────────────────────────────────


def test_an_unknown_locale_is_rejected(monkeypatch):
    """``language_config`` is a free-form bounded JSON object, so any string at
    all was accepted, offered to visitors in the picker, and then lockable onto
    a session by ``POST /chat/language`` — which resolves direction, display
    name and prompt directive from the locale catalogue and gets nothing back
    for a code that is not in it."""
    bot = _language_bot({"enabled": True, "supported_locales": ["en-IN"]})
    response, _ = _patch_language(monkeypatch, bot, {"supported_locales": ["en-IN", "xx-ZZ"]})

    assert response.status_code == 422
    assert "xx-ZZ" in response.text
    # Rejected, not silently filtered: a settings page that quietly drops half
    # a selection disagrees with what it shows.
    assert bot.language_config["supported_locales"] == ["en-IN"]


def test_a_catalogue_locale_the_widget_has_no_dictionary_for_is_still_accepted(monkeypatch):
    """The boundary is the locale catalogue, not the widget's UI dictionary.
    ``ar-SA`` is a language the bot can converse in, so it stays writable; that
    its chrome renders in English is surfaced through ``LocaleInfo.ui_translated``
    rather than by refusing the write."""
    bot = _language_bot({"enabled": True, "supported_locales": ["en-IN"]})
    response, _ = _patch_language(monkeypatch, bot, {"supported_locales": ["en-IN", "ar-SA"]})

    assert response.status_code == 200
    assert bot.language_config["supported_locales"] == ["en-IN", "ar-SA"]


def test_a_non_list_supported_locales_is_rejected(monkeypatch):
    bot = _language_bot({"enabled": True, "supported_locales": ["en-IN"]})
    response, _ = _patch_language(monkeypatch, bot, {"supported_locales": "en-IN"})

    assert response.status_code == 422
    assert bot.language_config["supported_locales"] == ["en-IN"]


def test_a_patch_that_does_not_touch_locales_is_unaffected(monkeypatch):
    """Validation is on the INCOMING value, so a legacy row holding a code that
    predates this check stays editable."""
    bot = _language_bot({"enabled": False, "supported_locales": ["en-IN", "xx-ZZ"]})
    response, _ = _patch_language(monkeypatch, bot, {"enabled": True})

    assert response.status_code == 200
    assert bot.language_config["enabled"] is True
