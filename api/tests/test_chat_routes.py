"""Tests for app.api.chat_routes — chat endpoint functionality."""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot, get_current_client_or_operator
from app.api.chat_routes import router


@contextmanager
def _session_ctx(session):
    yield session


def _build_app(bot_override=None, auth_override=None):
    app = FastAPI()
    app.include_router(router)
    if bot_override:
        app.dependency_overrides[get_current_bot] = lambda: bot_override
    if auth_override:
        app.dependency_overrides[get_current_client_or_operator] = lambda: auth_override
    return app


def _default_bot(**overrides):
    defaults = dict(
        id=1,
        client_id=1,
        bot_key="bot-test123",
        name="Test Bot",
        is_active=True,
        bant_enabled=False,
        bant_config=None,
        system_prompt="You are helpful.",
        website="https://example.com",
        company_name=None,
        company_description=None,
        brand_tone=None,
        live_chat_enabled=False,
        feature_flags={},
        widget_config={},
        notification_email=None,
        notification_emails=None,
        meeting_booking_enabled=False,
        calendly_url=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


# ── Chat endpoint ────────────────────────────────────────────────────────────


class TestChatEndpoint:
    def test_successful_chat(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        mock_session = MagicMock()

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.services.credit_service.get_credit_cost", return_value=1),
            patch("app.services.credit_service.check_and_deduct"),
            patch("app.api.chat_routes._resolve_session_id", return_value="session-1"),
            patch("app.api.chat_routes._parse_request_context", return_value=("1.2.3.4", "Desktop Chrome")),
            patch("app.api.chat_routes.submit_background"),
            patch(
                "app.api.chat_routes.rag_pipeline",
                return_value={
                    "answer": "Hello! How can I help?",
                    "sources": [],
                    "session_id": "session-1",
                    "message_id": 42,
                },
            ),
        ):
            mock_gs.return_value = _session_ctx(mock_session)
            response = tc.post(
                "/chat",
                json={"question": "Hello"},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["answer"] == "Hello! How can I help?"
        assert data["session_id"] == "session-1"

    def test_empty_question_rejected(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        response = tc.post(
            "/chat",
            json={"question": ""},
            headers={"X-Bot-Key": "bot-test123"},
        )

        assert response.status_code == 422


# ── Lead capture ─────────────────────────────────────────────────────────────


class TestLeadCapture:
    def test_valid_lead_capture(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.ensure_chat_session"),
            patch("app.api.chat_routes.create_or_update_lead_info"),
            patch("app.services.webhook_service.fire_webhook"),
        ):
            session = MagicMock()
            mock_gs.return_value = _session_ctx(session)

            response = tc.post(
                "/chat/lead-capture",
                json={
                    "session_id": "session-1",
                    "name": "John",
                    "email": "john@example.com",
                    "phone": "+1234567890",
                    "company": "Acme",
                },
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json()["success"] is True

    def test_invalid_email_rejected(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        response = tc.post(
            "/chat/lead-capture",
            json={
                "session_id": "session-1",
                "name": "John",
                "email": "not-an-email",
            },
            headers={"X-Bot-Key": "bot-test123"},
        )

        assert response.status_code == 422


# ── Feedback ─────────────────────────────────────────────────────────────────


class TestFeedback:
    def test_valid_feedback(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.update_message_feedback", return_value=True),
            patch("app.api.chat_routes.get_langfuse", return_value=None),
        ):
            session = MagicMock()
            msg = MagicMock()
            msg.trace_id = None
            session.execute.return_value.scalars.return_value.first.return_value = msg
            mock_gs.return_value = _session_ctx(session)

            response = tc.post(
                "/chat/feedback/42",
                json={"feedback": 1},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200

    def test_feedback_not_found(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.update_message_feedback", return_value=False),
        ):
            session = MagicMock()
            session.execute.return_value.scalars.return_value.first.return_value = None
            mock_gs.return_value = _session_ctx(session)

            response = tc.post(
                "/chat/feedback/999",
                json={"feedback": 1},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 404


# ── Lead info ────────────────────────────────────────────────────────────────


class TestLeadInfo:
    def test_returns_lead_info(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        lead = SimpleNamespace(name="John", email="john@example.com", phone=None, company=None)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.get_lead_info_by_session", return_value=lead),
        ):
            session = MagicMock()
            cs = SimpleNamespace(id="s1", bot_id=1)
            session.execute.return_value.scalars.return_value.first.return_value = cs
            mock_gs.return_value = _session_ctx(session)

            response = tc.get(
                "/chat/lead-info/s1",
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json()["lead_info"]["name"] == "John"

    def test_returns_none_when_no_lead(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.get_lead_info_by_session", return_value=None),
        ):
            session = MagicMock()
            session.execute.return_value.scalars.return_value.first.return_value = None
            mock_gs.return_value = _session_ctx(session)

            response = tc.get(
                "/chat/lead-info/no-session",
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json()["lead_info"] is None


# ── Behavioral signals ───────────────────────────────────────────────────────


class TestBehavioralSignals:
    def test_records_signals(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        cs = SimpleNamespace(
            id="s1",
            bot_id=1,
            page_url=None,
            referrer=None,
            utm_params=None,
            visit_count=0,
            behavioral_score=0,
        )
        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.ensure_chat_session", return_value=cs),
            patch("app.services.behavioral_service.score_behavioral_signals", return_value=25),
        ):
            session = MagicMock()
            session.execute.return_value.scalar_one.return_value = cs
            session.execute.return_value.scalar_one_or_none.return_value = cs
            mock_gs.return_value = _session_ctx(session)

            response = tc.post(
                "/chat/behavioral-signals",
                json={
                    "session_id": "s1",
                    "page_url": "https://example.com/pricing",
                    "time_on_page": 30,
                },
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json()["success"] is True
        assert response.json()["behavioral_score"] == 25


# ── Transcript ───────────────────────────────────────────────────────────────


class TestTranscript:
    def test_requires_session(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
        ):
            session = MagicMock()
            session.execute.return_value.scalar_one_or_none.return_value = None
            session.execute.return_value.scalars.return_value.first.return_value = None
            mock_gs.return_value = _session_ctx(session)

            response = tc.post(
                "/chat/transcript",
                json={"session_id": "no-session", "recipient_email": "a@b.com"},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 404
