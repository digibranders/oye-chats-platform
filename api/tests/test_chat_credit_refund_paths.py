"""Audit A3: an ``ai_chat`` credit charged before generation must come back when
the request fails afterwards.

Both chat endpoints deduct the credit *before* resolving the session and running
the pipeline. Any exception raised past that point used to become a 500 (or a
dropped stream) with the visitor's credit still spent. These tests pin the
refund on those paths, and pin that no path refunds twice.
"""

import contextlib
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_bot_for_chat, get_current_bot
from app.api.chat_routes import router
from app.core.exceptions import SessionOwnershipError


@contextmanager
def _session_ctx(session):
    yield session


def _bot():
    return SimpleNamespace(
        id=1,
        client_id=1,
        bot_key="bot-refund",
        name="Refund Bot",
        is_active=True,
        subscription_id=None,
        is_legacy_pooled=False,
        _subscription_bot_id=None,
        offline_message=None,
    )


def _app(bot):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_bot] = lambda: bot
    app.dependency_overrides[get_bot_for_chat] = lambda: bot
    return app


@pytest.fixture(autouse=True)
def _active_subscription(monkeypatch):
    from app.api import chat_routes

    monkeypatch.setattr(chat_routes, "bot_subscription_status", lambda _client_id, subscription_id=None: "active")


class TestSyncChatRefund:
    def test_pipeline_exception_refunds_the_credit(self):
        bot = _bot()
        tc = TestClient(_app(bot), raise_server_exceptions=False)
        refunds: list[int] = []

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.services.credit_service.get_credit_cost", return_value=1),
            patch("app.services.credit_service.check_and_deduct"),
            patch("app.api.chat_routes._refund_ai_chat_credit", side_effect=lambda _bot, cost: refunds.append(cost)),
            patch("app.api.chat_routes._resolve_session_id", return_value="s-1"),
            patch("app.api.chat_routes._parse_request_context", return_value=("1.2.3.4", "Desktop Chrome")),
            patch("app.api.chat_routes._resolve_visitor_language_and_update_session", return_value=None),
            patch("app.api.chat_routes.submit_background"),
            patch("app.api.chat_routes.rag_pipeline", side_effect=RuntimeError("pipeline exploded")),
        ):
            mock_gs.return_value = _session_ctx(MagicMock())
            resp = tc.post("/chat", json={"question": "Hi"}, headers={"X-Bot-Key": "bot-refund"})

        assert resp.status_code == 500
        assert refunds == [1]

    def test_session_ownership_error_refunds_the_credit(self):
        bot = _bot()
        tc = TestClient(_app(bot), raise_server_exceptions=False)
        refunds: list[int] = []

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.services.credit_service.get_credit_cost", return_value=1),
            patch("app.services.credit_service.check_and_deduct"),
            patch("app.api.chat_routes._refund_ai_chat_credit", side_effect=lambda _bot, cost: refunds.append(cost)),
            patch("app.api.chat_routes._parse_request_context", return_value=("1.2.3.4", "Desktop Chrome")),
            patch("app.api.chat_routes._resolve_session_id", side_effect=SessionOwnershipError("s-1", 1, 999)),
        ):
            mock_gs.return_value = _session_ctx(MagicMock())
            # The app under test registers no handler for this exception, so
            # the client sees a 500; the refund is what is being asserted.
            with contextlib.suppress(Exception):
                tc.post("/chat", json={"question": "Hi"}, headers={"X-Bot-Key": "bot-refund"})

        assert refunds == [1]

    def test_generation_failed_refunds_exactly_once(self):
        bot = _bot()
        tc = TestClient(_app(bot))
        refunds: list[int] = []

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.services.credit_service.get_credit_cost", return_value=1),
            patch("app.services.credit_service.check_and_deduct"),
            patch("app.api.chat_routes._refund_ai_chat_credit", side_effect=lambda _bot, cost: refunds.append(cost)),
            patch("app.api.chat_routes._resolve_session_id", return_value="s-1"),
            patch("app.api.chat_routes._parse_request_context", return_value=("1.2.3.4", "Desktop Chrome")),
            patch("app.api.chat_routes._resolve_visitor_language_and_update_session", return_value=None),
            patch("app.api.chat_routes.submit_background"),
            patch(
                "app.api.chat_routes.rag_pipeline",
                return_value={"answer": "…", "session_id": "s-1", "generation_failed": True},
            ),
        ):
            mock_gs.return_value = _session_ctx(MagicMock())
            resp = tc.post("/chat", json={"question": "Hi"}, headers={"X-Bot-Key": "bot-refund"})

        assert resp.status_code == 200
        assert refunds == [1]


class TestStreamChatRefund:
    def test_session_resolution_failure_refunds_the_credit(self):
        bot = _bot()
        tc = TestClient(_app(bot), raise_server_exceptions=False)
        refunds: list[int] = []

        with (
            patch("app.api.chat_routes._deduct_ai_chat_credit_sync", return_value=1),
            patch("app.api.chat_routes._refund_ai_chat_credit", side_effect=lambda _bot, cost: refunds.append(cost)),
            patch("app.api.chat_routes._parse_request_context", return_value=("1.2.3.4", "Desktop Chrome")),
            patch("app.api.chat_routes._resolve_session_id", side_effect=SessionOwnershipError("s-1", 1, 999)),
            contextlib.suppress(Exception),
        ):
            tc.post("/chat/stream", json={"question": "Hi"}, headers={"X-Bot-Key": "bot-refund"})

        assert refunds == [1]

    def test_mid_stream_exception_refunds_the_credit_once(self):
        bot = _bot()
        tc = TestClient(_app(bot), raise_server_exceptions=False)
        refunds: list[int] = []

        async def _exploding_stream(*_args, **_kwargs):
            yield "METADATA:{}\n"
            raise RuntimeError("stream died")

        with (
            patch("app.api.chat_routes._deduct_ai_chat_credit_sync", return_value=1),
            patch("app.api.chat_routes._refund_ai_chat_credit", side_effect=lambda _bot, cost: refunds.append(cost)),
            patch("app.api.chat_routes._parse_request_context", return_value=("1.2.3.4", "Desktop Chrome")),
            patch("app.api.chat_routes._resolve_session_id", return_value="s-1"),
            patch("app.api.chat_routes._resolve_visitor_language_and_update_session", return_value=None),
            patch("app.api.chat_routes.submit_background"),
            patch("app.api.chat_routes.rag_pipeline_stream", _exploding_stream),
            # The failure surfaces mid-body; the client may see a truncated
            # response rather than an exception, so the refund is the assertion.
            contextlib.suppress(Exception),
        ):
            tc.post("/chat/stream", json={"question": "Hi"}, headers={"X-Bot-Key": "bot-refund"})

        assert refunds == [1]

    def test_successful_stream_is_not_refunded(self):
        bot = _bot()
        tc = TestClient(_app(bot))
        refunds: list[int] = []

        async def _good_stream(*_args, **_kwargs):
            yield "METADATA:{}\n"
            yield "Hello"
            yield 'FINAL_METADATA:{"answer": "Hello"}\n'

        with (
            patch("app.api.chat_routes._deduct_ai_chat_credit_sync", return_value=1),
            patch("app.api.chat_routes._refund_ai_chat_credit", side_effect=lambda _bot, cost: refunds.append(cost)),
            patch("app.api.chat_routes._parse_request_context", return_value=("1.2.3.4", "Desktop Chrome")),
            patch("app.api.chat_routes._resolve_session_id", return_value="s-1"),
            patch("app.api.chat_routes._resolve_visitor_language_and_update_session", return_value=None),
            patch("app.api.chat_routes.submit_background"),
            patch("app.api.chat_routes.rag_pipeline_stream", _good_stream),
        ):
            resp = tc.post("/chat/stream", json={"question": "Hi"}, headers={"X-Bot-Key": "bot-refund"})

        assert resp.status_code == 200
        assert refunds == []
