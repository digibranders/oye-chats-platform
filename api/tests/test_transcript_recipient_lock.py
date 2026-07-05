"""Regression tests for transcript-email recipient locking (roadmap §0.4).

``POST /chat/transcript`` takes a visitor-typed ``recipient_email``. The session
is bot-scoped, but on its own a leaked ``session_id`` would let anyone mail
another visitor's conversation to an arbitrary inbox. The guard: when the
session has a captured lead email, the transcript may only be sent to THAT
address; sessions with no lead keep the anonymous self-send flow.

MagicMock session — no Postgres. ``send_transcript_email`` is patched so no mail
is actually sent.
"""

from contextlib import contextmanager, suppress
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot
from app.api.chat_routes import router

BOT = SimpleNamespace(id=1, name="Bot", reply_to_email=None)


@contextmanager
def _session_context(session):
    yield session


class _ScalarOne:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _ScalarsAll:
    def __init__(self, values):
        self._values = values

    def scalars(self):
        return SimpleNamespace(all=lambda: self._values)


def _client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_bot] = lambda: BOT
    return TestClient(app)


def _msg():
    return SimpleNamespace(role="user", content="hi", created_at=None)


class TestTranscriptRecipientLock:
    @pytest.fixture(autouse=True)
    def _reset_rate_limiter(self):
        # /chat/transcript is capped 3/min on a process-global counter; reset so
        # the class is order-independent within a full pytest run.
        from app.core.rate_limit import limiter

        with suppress(Exception):
            limiter.reset()
        yield

    def _wire(self, monkeypatch, *, lead_email, execute):
        from app.api import chat_routes
        from app.services import email_service

        session = MagicMock()
        if isinstance(execute, list):
            session.execute.side_effect = execute
        else:
            session.execute.return_value = execute
        monkeypatch.setattr(chat_routes, "get_session", lambda: _session_context(session))
        lead = SimpleNamespace(email=lead_email) if lead_email is not None else None
        monkeypatch.setattr(chat_routes, "get_lead_info_by_session", lambda s, sid: lead)
        sent: list = []
        monkeypatch.setattr(email_service, "send_transcript_email", lambda **kw: sent.append(kw))
        return sent

    def test_blocked_when_recipient_differs_from_lead(self, monkeypatch):
        sent = self._wire(
            monkeypatch,
            lead_email="real@visitor.com",
            execute=_ScalarOne(SimpleNamespace(id="s1", bot_id=1)),
        )
        resp = _client().post(
            "/chat/transcript",
            json={"session_id": "s1", "recipient_email": "attacker@evil.com"},
        )
        assert resp.status_code == 403
        assert sent == []  # email must NOT be sent to a non-lead address

    def test_allowed_when_recipient_matches_lead_case_insensitive(self, monkeypatch):
        sent = self._wire(
            monkeypatch,
            lead_email="Real@Visitor.com",
            execute=[_ScalarOne(SimpleNamespace(id="s1", bot_id=1)), _ScalarsAll([_msg()])],
        )
        resp = _client().post(
            "/chat/transcript",
            json={"session_id": "s1", "recipient_email": "real@visitor.com"},
        )
        assert resp.status_code == 200
        assert len(sent) == 1

    def test_allowed_when_no_lead_on_file(self, monkeypatch):
        sent = self._wire(
            monkeypatch,
            lead_email=None,
            execute=[_ScalarOne(SimpleNamespace(id="s1", bot_id=1)), _ScalarsAll([_msg()])],
        )
        resp = _client().post(
            "/chat/transcript",
            json={"session_id": "s1", "recipient_email": "anyone@example.com"},
        )
        assert resp.status_code == 200
        assert len(sent) == 1
