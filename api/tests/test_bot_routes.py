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
    require_verified_email_for_workspace,
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
    # Same rationale for the email-verification gate — its semantics are covered
    # in test_verified_email_gate; here we act as a verified workspace.
    app.dependency_overrides[require_verified_email_for_workspace] = lambda: None
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


def _apply_flush_defaults(obj, bot_id=42):
    """Assign a primary key + materialize a Bot's scalar column defaults.

    ``create_bot`` now returns the full serialized bot, which requires the id
    and the model's column defaults to be present. A ``MagicMock`` session never
    runs a real flush, so this mirrors what SQLAlchemy would do on INSERT.
    """
    from sqlalchemy import inspect as sa_inspect

    from app.db.models import Bot

    if not isinstance(obj, Bot):
        return obj
    if getattr(obj, "id", None) is None:
        obj.id = bot_id
    for col in sa_inspect(Bot).columns:
        if getattr(obj, col.key, None) is not None:
            continue
        default = col.default
        if default is not None and not default.is_callable:
            setattr(obj, col.key, default.arg)
    return obj


def _populate_on_refresh(session, bot_id=42):
    """Wire a mocked ``session.refresh`` to behave like a real flush."""
    session.refresh.side_effect = lambda obj: _apply_flush_defaults(obj, bot_id)


# ── Bot CRUD ─────────────────────────────────────────────────────────────────


class TestCreateBot:
    def test_creates_bot(self, monkeypatch):
        from app.api import bot_routes
        from app.services.plan_entitlements_service import AddBotDecision

        session = MagicMock()
        added = []
        session.add.side_effect = added.append
        _populate_on_refresh(session)
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
        # create now returns the full bot object (same shape as GET /bots/{id}),
        # not the old {message, bot_id, bot_key, name} envelope.
        assert data["id"] == 42
        assert data["bot_key"].startswith("bot-")
        assert data["name"] == "My Bot"
        # Two rows are persisted on a successful create: the Bot itself and
        # an in-app ``bot_created`` Notification dropped into the
        # workspace's notification feed.
        from app.db.models import Bot, Notification

        assert len(added) == 2
        assert any(isinstance(r, Bot) for r in added)
        assert any(isinstance(r, Notification) for r in added)

    def test_new_bot_defaults_domain_check_enabled(self, monkeypatch):
        # Secure-by-default: a bot created without an explicit
        # ``domain_check_enabled`` must enforce origins. Combined with the
        # fail-open on empty allowlist, this locks new bots down as soon as
        # domains are configured without bricking unconfigured ones.
        from app.api import bot_routes
        from app.db.models import Bot
        from app.services.plan_entitlements_service import AddBotDecision

        session = MagicMock()
        added = []
        session.add.side_effect = added.append
        _populate_on_refresh(session)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)

        allowed = AddBotDecision(allowed=True, reason="ok", must_subscribe=False, active_bot_count=0)
        with patch(
            "app.services.plan_entitlements_service.can_client_add_new_bot",
            return_value=allowed,
        ):
            # No website and no allowed_domains -> empty allowlist, flag still on.
            response = tc.post("/bots", json={"name": "Bare Bot"})

        assert response.status_code == 201
        created = next(r for r in added if isinstance(r, Bot))
        assert created.domain_check_enabled is True
        assert list(created.allowed_domains or []) == []

    def test_idempotent_create_reuses_existing_bot_for_same_site(self, monkeypatch):
        # Onboarding double-submit: submit #1 created the bot; submit #2 arrives
        # over the free 1-bot cap. Instead of a confusing 402, the same-site bot
        # is returned so the retry is a no-op.
        from app.api import bot_routes
        from app.db.models import Bot
        from app.services.plan_entitlements_service import AddBotDecision

        existing = _apply_flush_defaults(
            Bot(client_id=1, bot_key="bot-existing123", name="Acme", website="https://mysite.com", bant_enabled=True),
            bot_id=7,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult([existing])
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)

        denied = AddBotDecision(allowed=False, reason="bot_limit_reached", must_subscribe=True, active_bot_count=1)
        with patch(
            "app.services.plan_entitlements_service.can_client_add_new_bot",
            return_value=denied,
        ):
            response = tc.post("/bots", json={"name": "Acme retry", "website": "https://mysite.com"})

        assert response.status_code == 201
        data = response.json()
        assert data["id"] == 7
        assert data["bot_key"] == "bot-existing123"
        # Reused, not created — no new Bot row was added.
        session.add.assert_not_called()

    def test_create_402s_when_capped_and_no_matching_site(self, monkeypatch):
        # The idempotent reuse must NOT mask the upsell for a genuinely new bot:
        # a capped account creating a bot for a *different* site still 402s.
        from app.api import bot_routes
        from app.db.models import Bot
        from app.services.plan_entitlements_service import AddBotDecision

        existing = _apply_flush_defaults(
            Bot(client_id=1, bot_key="bot-existing123", name="Acme", website="https://mysite.com", bant_enabled=True),
            bot_id=7,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult([existing])
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)

        denied = AddBotDecision(allowed=False, reason="bot_limit_reached", must_subscribe=True, active_bot_count=1)
        with patch(
            "app.services.plan_entitlements_service.can_client_add_new_bot",
            return_value=denied,
        ):
            response = tc.post("/bots", json={"name": "Other", "website": "https://different.com"})

        assert response.status_code == 402
        assert response.json()["detail"]["must_subscribe"] is True

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
            manual_field_overrides=[],
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
            manual_field_overrides=[],
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
            manual_field_overrides=[],
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        with patch("app.api.bot_routes.cache_delete") as mock_cache:
            app = _build_app(auth_override=_client_auth())
            tc = TestClient(app)
            tc.patch("/bots/5", json={"name": "Updated"})

        mock_cache.assert_called()

    def test_persists_company_and_queue_fields(self, monkeypatch):
        """PATCH writes company + live-chat queue fields onto the bot row.

        The admin Bot Settings editor edits these four fields; they must be
        accepted by ``UpdateBotRequest`` and applied by the generic setattr
        step so they actually persist (round-trip starts here).
        """
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=5,
            client_id=1,
            bot_key="bot-xyz",
            name="Bot",
            company_name=None,
            company_description=None,
            live_chat_queue_timeout_seconds=20,
            live_chat_max_queue_size=10,
            feature_flags={},
            widget_messages={},
            widget_config={},
            bant_config=None,
            manual_field_overrides=[],
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        with patch("app.api.bot_routes.cache_delete"):
            app = _build_app(auth_override=_client_auth())
            tc = TestClient(app)
            response = tc.patch(
                "/bots/5",
                json={
                    "company_name": "Acme Inc",
                    "company_description": "We sell anvils.",
                    "live_chat_queue_timeout_seconds": 45,
                    "live_chat_max_queue_size": 25,
                },
            )

        assert response.status_code == 200
        assert bot.company_name == "Acme Inc"
        assert bot.company_description == "We sell anvils."
        assert bot.live_chat_queue_timeout_seconds == 45
        assert bot.live_chat_max_queue_size == 25


class TestBotResponseRoundTrip:
    """Schema-level guarantee that the four editor fields round-trip.

    ``UpdateBotRequest`` must accept them and ``BotResponse`` must carry them
    back, mirroring what GET /bots/{id} returns from the stored row.
    """

    def test_update_request_accepts_fields(self):
        from app.api.bot_routes import UpdateBotRequest

        req = UpdateBotRequest(
            company_name="Acme Inc",
            company_description="We sell anvils.",
            live_chat_queue_timeout_seconds=45,
            live_chat_max_queue_size=25,
        )
        dumped = req.dict(exclude_unset=True)
        assert dumped == {
            "company_name": "Acme Inc",
            "company_description": "We sell anvils.",
            "live_chat_queue_timeout_seconds": 45,
            "live_chat_max_queue_size": 25,
        }

    def test_response_carries_fields(self):
        from app.api.bot_routes import BotResponse

        resp = BotResponse(
            id=1,
            bot_key="bot-xyz",
            name="Bot",
            website=None,
            system_prompt=None,
            company_name="Acme Inc",
            company_description="We sell anvils.",
            bot_logo=None,
            launcher_name="Have Questions?",
            launcher_logo=None,
            primary_color="#ba68c8",
            background_color="#ffffff",
            header_color="#3A0CA3",
            recommended_colors=[],
            bant_enabled=False,
            avatar_type="upload",
            orb_color=None,
            live_chat_queue_timeout_seconds=45,
            live_chat_max_queue_size=25,
            is_active=True,
            created_at="2026-01-01T00:00:00",
        )
        assert resp.company_name == "Acme Inc"
        assert resp.company_description == "We sell anvils."
        assert resp.live_chat_queue_timeout_seconds == 45
        assert resp.live_chat_max_queue_size == 25


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
        _populate_on_refresh(session)
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
        _populate_on_refresh(session)
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
