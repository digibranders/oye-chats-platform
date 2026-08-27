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

        # This test is scoped to the tenant-isolation guard, not the plan gate.
        # Stub the plan check True so the flow proceeds to the state machine
        # (the plan gate has its own coverage in ``test_plan_gate_*`` below).
        monkeypatch.setattr(
            operator_routes.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *a, **k: True
        )

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

        # Scoped to the create-path guard; stub the plan check True (see above).
        monkeypatch.setattr(
            operator_routes.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *a, **k: True
        )

        class _Reached(Exception):
            pass

        monkeypatch.setattr(availsvc, "resolve_live_chat_state", lambda *a, **k: (_ for _ in ()).throw(_Reached()))

        client = TestClient(_app_with_bot(bot))
        with pytest.raises(_Reached):
            client.post("/operators/handoff", json={"session_id": "brand-new"})

    def test_plan_gate_blocks_handoff_when_live_chat_not_entitled(self, monkeypatch):
        """A bot whose plan excludes live chat must be 403'd at the handoff
        endpoint, after the ownership guard, before the state machine runs.

        This locks in the Free-plan behavior: the widget never offers a handoff,
        and the endpoint is the hard boundary if a crafted request reaches it."""
        from app.api import operator_routes
        from app.services import live_chat_availability_service as availsvc

        bot = SimpleNamespace(id=1, client_id=1, bot_key="bot-free")
        owned = SimpleNamespace(id="s1", bot_id=1, client_id=1)

        session = MagicMock()
        session.execute.return_value = _ScalarOneResult(owned)
        monkeypatch.setattr(operator_routes, "get_session", lambda: _session_context(session))

        # Plan excludes live chat.
        monkeypatch.setattr(
            operator_routes.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *a, **k: False
        )

        # The state machine must NOT be reached: if it were, this would raise
        # and mask the expected 403.
        def _boom(*a, **k):
            raise AssertionError("resolve_live_chat_state must not run when the plan excludes live chat")

        monkeypatch.setattr(availsvc, "resolve_live_chat_state", _boom)

        client = TestClient(_app_with_bot(bot))
        resp = client.post("/operators/handoff", json={"session_id": "s1"})

        assert resp.status_code == 403
        session.commit.assert_not_called()
