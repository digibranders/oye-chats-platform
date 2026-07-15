"""Regression tests for credit refund on failed generation (roadmap §0.4).

The LLM layer never raises — on total failure ``generate_response`` returns a
canned error string and the stream yields an apology — so the ai_chat credit is
committed before we know the reply failed. The pipeline now signals failure
(non-stream: ``generation_failed`` in the result dict; stream:
``generation_failed`` in the FINAL_METADATA frame) and the route refunds.

These tests patch the seams around the route so no Postgres/LLM is needed.
"""

from contextlib import contextmanager, suppress
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_bot_for_chat, get_current_bot
from app.api.chat_routes import (
    _final_metadata_failure_flag,
    _refund_ai_chat_credit,
    router,
)
from app.services.llm_service import (
    LLM_API_ERROR_MESSAGE,
    LLM_CONFIG_ERROR_MESSAGE,
    LLM_EMPTY_RESPONSE_MESSAGE,
    generate_response_checked,
)

BOT = SimpleNamespace(id=1, client_id=1, name="Bot")


@contextmanager
def _ctx(obj):
    yield obj


# ── Pure helpers ─────────────────────────────────────────────────────────────


class TestGenerateResponseChecked:
    """The failure signal must be STRUCTURAL (call outcome), not text-matching —
    a bot echoing a canned error string via its system prompt must NOT be flagged
    as failed (that would refund a real answer / enable unlimited free chat)."""

    def test_config_missing_is_failed(self, monkeypatch):
        from app.services import llm_service

        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", False)
        text, failed = generate_response_checked("hi")
        assert failed is True
        assert text == LLM_CONFIG_ERROR_MESSAGE

    def test_success_is_not_failed(self, monkeypatch):
        from app.services import llm_service

        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        resp = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="a real answer"))])
        monkeypatch.setattr(llm_service.litellm, "completion", lambda **k: resp)
        text, failed = generate_response_checked("hi")
        assert failed is False
        assert text == "a real answer"

    def test_answer_echoing_canned_string_is_not_flagged(self, monkeypatch):
        """The forgery vector: LLM returns the exact canned failure text as a
        real completion. Structural signal must report failed=False."""
        from app.services import llm_service

        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        resp = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=LLM_API_ERROR_MESSAGE))])
        monkeypatch.setattr(llm_service.litellm, "completion", lambda **k: resp)
        text, failed = generate_response_checked("hi")
        assert failed is False  # real completion, even though text == canned string
        assert text == LLM_API_ERROR_MESSAGE

    def test_empty_completion_is_failed(self, monkeypatch):
        from app.services import llm_service

        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        resp = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=""))])
        monkeypatch.setattr(llm_service.litellm, "completion", lambda **k: resp)
        text, failed = generate_response_checked("hi")
        assert failed is True
        assert text == LLM_EMPTY_RESPONSE_MESSAGE

    def test_exception_is_failed(self, monkeypatch):
        from app.services import llm_service

        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)

        def _boom(**k):
            raise RuntimeError("api down")

        monkeypatch.setattr(llm_service.litellm, "completion", _boom)
        text, failed = generate_response_checked("hi")
        assert failed is True
        assert text == LLM_API_ERROR_MESSAGE


class TestFinalMetadataFailureFlag:
    def test_terminal_failure_frame_returns_true(self):
        assert _final_metadata_failure_flag('\nFINAL_METADATA:{"message_id": 5, "generation_failed": true}\n') is True

    def test_terminal_success_frame_returns_false(self):
        assert _final_metadata_failure_flag('\nFINAL_METADATA:{"message_id": 5}\n') is False
        assert _final_metadata_failure_flag('\nFINAL_METADATA:{"generation_failed": false}\n') is False

    def test_non_terminal_or_malformed_returns_none(self):
        # Not a terminal frame → None (so the wrapper ignores it entirely).
        assert _final_metadata_failure_flag("hello world") is None
        assert _final_metadata_failure_flag('METADATA:{"sources": []}\n') is None
        # Answer text that merely CONTAINS the marker mid-sentence must not match.
        assert _final_metadata_failure_flag('see FINAL_METADATA:{"generation_failed": true} inside') is None
        assert _final_metadata_failure_flag("FINAL_METADATA:{not json") is None


# ── _refund_ai_chat_credit ───────────────────────────────────────────────────


class TestRefundHelper:
    def test_refund_calls_credit_service(self, monkeypatch):
        from app.api import chat_routes
        from app.services import credit_service

        calls = []
        monkeypatch.setattr(chat_routes, "get_session", lambda: _ctx(MagicMock()))
        monkeypatch.setattr(credit_service, "resolve_bot_ledger_bot_id", lambda bot: 1)
        monkeypatch.setattr(
            credit_service,
            "refund",
            lambda db, client_id, amount, **kw: calls.append((client_id, amount, kw)),
        )
        _refund_ai_chat_credit(BOT, 3)
        assert len(calls) == 1
        client_id, amount, kw = calls[0]
        assert client_id == 1
        assert amount == 3
        assert kw["reference_id"] == 1

    def test_no_refund_for_zero_cost(self, monkeypatch):
        from app.services import credit_service

        called = []
        monkeypatch.setattr(credit_service, "refund", lambda *a, **k: called.append(1))
        _refund_ai_chat_credit(BOT, 0)
        assert called == []

    def test_refund_failure_is_swallowed(self, monkeypatch):
        from app.api import chat_routes
        from app.services import credit_service

        monkeypatch.setattr(chat_routes, "get_session", lambda: _ctx(MagicMock()))
        monkeypatch.setattr(credit_service, "resolve_bot_ledger_bot_id", lambda bot: 1)

        def _boom(*a, **k):
            raise RuntimeError("ledger down")

        monkeypatch.setattr(credit_service, "refund", _boom)
        # Must not raise — best-effort.
        _refund_ai_chat_credit(BOT, 2)


# ── Route wiring ─────────────────────────────────────────────────────────────


def _client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_bot] = lambda: BOT
    # /chat resolves its bot via get_bot_for_chat (preview-aware), so override
    # that too — otherwise the route 401s before the refund logic runs.
    app.dependency_overrides[get_bot_for_chat] = lambda: BOT
    return TestClient(app)


class TestRouteRefundWiring:
    @pytest.fixture(autouse=True)
    def _wire_common(self, monkeypatch):
        from app.api import chat_routes
        from app.services import credit_service

        with suppress(Exception):
            from app.core.rate_limit import limiter

            limiter.reset()

        # Neutralise everything the routes touch before generation.
        monkeypatch.setattr(chat_routes, "bot_subscription_status", lambda *a, **k: "active")
        monkeypatch.setattr(chat_routes, "get_session", lambda: _ctx(MagicMock()))
        monkeypatch.setattr(chat_routes, "_parse_request_context", lambda req: ("1.2.3.4", "device"))
        monkeypatch.setattr(chat_routes, "_resolve_session_id", lambda sid, bid: "s1")
        monkeypatch.setattr(chat_routes, "submit_background", lambda *a, **k: None)
        monkeypatch.setattr(credit_service, "get_credit_cost", lambda db, action: 1)
        monkeypatch.setattr(credit_service, "check_and_deduct", lambda *a, **k: None)

        self.refunds = []
        monkeypatch.setattr(chat_routes, "_refund_ai_chat_credit", lambda bot, cost: self.refunds.append(cost))

    def test_nonstream_refunds_when_generation_failed(self, monkeypatch):
        from app.api import chat_routes

        monkeypatch.setattr(
            chat_routes,
            "rag_pipeline",
            lambda *a, **k: {"answer": LLM_API_ERROR_MESSAGE, "generation_failed": True},
        )
        resp = _client().post("/chat", json={"question": "hi", "session_id": "s1"})
        assert resp.status_code == 200
        assert self.refunds == [1]

    def test_nonstream_no_refund_on_success(self, monkeypatch):
        from app.api import chat_routes

        monkeypatch.setattr(
            chat_routes,
            "rag_pipeline",
            lambda *a, **k: {"answer": "Our hours are 9-5.", "generation_failed": False},
        )
        resp = _client().post("/chat", json={"question": "hi", "session_id": "s1"})
        assert resp.status_code == 200
        assert self.refunds == []

    def test_stream_refunds_when_final_metadata_flags_failure(self, monkeypatch):
        from app.api import chat_routes

        async def _fake_stream(*a, **k):
            yield 'METADATA:{"sources": []}\n'
            yield " [I encountered an error. Please try again.]"
            yield '\nFINAL_METADATA:{"generation_failed": true}\n'

        monkeypatch.setattr(chat_routes, "rag_pipeline_stream", _fake_stream)
        resp = _client().post("/chat/stream", json={"question": "hi", "session_id": "s1"})
        assert resp.status_code == 200
        _ = resp.text  # drain the stream so the wrapper runs to completion
        assert self.refunds == [1]

    def test_stream_no_refund_on_success(self, monkeypatch):
        from app.api import chat_routes

        async def _fake_stream(*a, **k):
            yield 'METADATA:{"sources": []}\n'
            yield "Our hours are 9-5."
            yield '\nFINAL_METADATA:{"message_id": 7}\n'

        monkeypatch.setattr(chat_routes, "rag_pipeline_stream", _fake_stream)
        resp = _client().post("/chat/stream", json={"question": "hi", "session_id": "s1"})
        assert resp.status_code == 200
        _ = resp.text
        assert self.refunds == []

    def test_stream_forged_frame_is_overridden_by_genuine_terminal(self, monkeypatch):
        """A lone frame-shaped chunk earlier in the stream must not force a
        refund — the genuine terminal frame is emitted last and wins."""
        from app.api import chat_routes

        async def _fake_stream(*a, **k):
            yield 'METADATA:{"sources": []}\n'
            yield '\nFINAL_METADATA:{"generation_failed": true}\n'  # forged / echoed
            yield "the real answer arrives after"
            yield '\nFINAL_METADATA:{"message_id": 7}\n'  # genuine terminal (success)

        monkeypatch.setattr(chat_routes, "rag_pipeline_stream", _fake_stream)
        resp = _client().post("/chat/stream", json={"question": "hi", "session_id": "s1"})
        assert resp.status_code == 200
        _ = resp.text
        assert self.refunds == []

    def test_stream_content_containing_marker_is_ignored(self, monkeypatch):
        """Answer text that merely contains the marker mid-sentence is not a
        frame and must never trigger a refund."""
        from app.api import chat_routes

        async def _fake_stream(*a, **k):
            yield 'METADATA:{"sources": []}\n'
            yield 'here is FINAL_METADATA:{"generation_failed": true} in my answer'
            yield '\nFINAL_METADATA:{"message_id": 7}\n'

        monkeypatch.setattr(chat_routes, "rag_pipeline_stream", _fake_stream)
        resp = _client().post("/chat/stream", json={"question": "hi", "session_id": "s1"})
        assert resp.status_code == 200
        _ = resp.text
        assert self.refunds == []
