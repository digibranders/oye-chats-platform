"""Regression test for the operator-handoff tenant-isolation guard (roadmap §0.1).

``POST /operators/handoff`` is authenticated only by the public ``X-Bot-Key``
(embedded in every embed script). Before the fix the route loaded the
``ChatSession`` by id alone, so a caller holding *any* bot key could pass another
tenant's ``session_id`` and mutate that session (flip status to ``waiting``,
overwrite ``handoff_reason`` / ``department_id``, fire the victim's
audit/webhook/push side effects). The guard now returns 404 when an existing
session's ``bot_id`` does not match the authenticated bot.

Driven by a MagicMock session, the guard fires on the very first load, so no
real Postgres is required.
"""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot
from app.api.operator_routes import router


class _ScalarOneResult:
    """Mimics ``session.execute(...).scalar_one_or_none()``."""

    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


@contextmanager
def _session_context(session):
    yield session


def _app_with_bot(bot):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_bot] = lambda: bot
    return app


class TestHandoffTenantIsolation:
    def test_foreign_session_rejected_with_404(self, monkeypatch):
        from app.api import operator_routes

        # Attacker authenticates with their own bot key…
        bot = SimpleNamespace(id=1, client_id=1, bot_key="bot-attacker")
        # …and targets a session owned by a DIFFERENT bot/tenant.
        victim_session = SimpleNamespace(id="sess-victim", bot_id=999, client_id=42)

        session = MagicMock()
        session.execute.return_value = _ScalarOneResult(victim_session)
        monkeypatch.setattr(operator_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_app_with_bot(bot))
        resp = client.post("/operators/handoff", json={"session_id": "sess-victim"})

        assert resp.status_code == 404
        # The victim's session must be untouched, no status flip, no commit.
        assert victim_session.bot_id == 999
        assert not getattr(victim_session, "status", None)
        session.commit.assert_not_called()

    def test_owned_session_passes_the_guard(self, monkeypatch):
        """Positive lock: a session owned by THIS bot must get past the guard and
        reach the availability state machine. Guarded by a sentinel exception so
        an over-aggressive guard (that 404'd a legit session) would fail here."""
        from app.api import operator_routes
        from app.services import live_chat_availability_service as availsvc

        bot = SimpleNamespace(id=1, client_id=1, bot_key="bot-owner")
        owned = SimpleNamespace(id="s1", bot_id=1, client_id=1)

        session = MagicMock()
        session.execute.return_value = _ScalarOneResult(owned)
        monkeypatch.setattr(operator_routes, "get_session", lambda: _session_context(session))

        class _Reached(Exception):
            pass

        monkeypatch.setattr(availsvc, "resolve_live_chat_state", lambda *a, **k: (_ for _ in ()).throw(_Reached()))

        client = TestClient(_app_with_bot(bot))
        # Reaches resolve_live_chat_state ONLY if the ownership guard passed.
        with pytest.raises(_Reached):
            client.post("/operators/handoff", json={"session_id": "s1"})

    def test_absent_session_create_path_passes_the_guard(self, monkeypatch):
        """The create-path (session doesn't exist yet) must also proceed, the
        new ChatSession is stamped with bot_id=bot.id, so it's owned."""
        from app.api import operator_routes
        from app.services import live_chat_availability_service as availsvc

        bot = SimpleNamespace(id=1, client_id=1, bot_key="bot-owner")
        created_bot = SimpleNamespace(id=1, client_id=1)

        session = MagicMock()
        # 1st execute: session lookup -> None (absent); 2nd: db_bot re-fetch.
        session.execute.side_effect = [_ScalarOneResult(None), _ScalarOneResult(created_bot)]
        monkeypatch.setattr(operator_routes, "get_session", lambda: _session_context(session))

        class _Reached(Exception):
            pass

        monkeypatch.setattr(availsvc, "resolve_live_chat_state", lambda *a, **k: (_ for _ in ()).throw(_Reached()))

        client = TestClient(_app_with_bot(bot))
        with pytest.raises(_Reached):
            client.post("/operators/handoff", json={"session_id": "brand-new"})
