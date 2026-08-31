"""``/close`` and ``/resolve`` must go through the state machine, not around it.

``session_state_machine`` declares ``closed`` terminal and offers
``transition_session`` (``SELECT … FOR UPDATE`` + CAS + audit row), but these two
routes wrote ``ChatSession.status`` directly. So a ``/close`` on an already
resolved conversation resurrected it to ``bot``, and either route could clobber a
transition another worker had just committed.

``/handoff`` on a ``closed`` session is the third bypass. It is left working on
purpose - the visitor keeps chatting to the bot after a resolve, so refusing
would strand them - but it now leaves an audit row saying the terminal state was
re-opened, which is the part that was missing.
"""

from __future__ import annotations

import os
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.auth import get_current_bot, get_current_client_or_operator
from app.api.operator_routes import router as operator_router
from app.db.models import Bot, ChatAuditLog, ChatSession, Client, Operator

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture(autouse=True)
def _quiet_side_effects(monkeypatch):
    from app.api import operator_routes
    from app.services import webhook_service

    monkeypatch.setattr(operator_routes, "manager", SimpleNamespace(close_chat=AsyncMock()))
    monkeypatch.setattr(webhook_service, "fire_webhook", lambda *a, **k: None)


@pytest.fixture
def world(db):
    client = Client(name="T", email="t@trans.test", api_key="key-trans", hashed_password="h")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key="bot-trans", name="Trans Bot")
    db.add(bot)
    db.flush()
    operator = Operator(
        client_id=client.id, bot_id=bot.id, name="Op", email="op@trans.test", operator_api_key="opkey-trans"
    )
    db.add(operator)
    db.flush()
    db.commit()
    return SimpleNamespace(client=client, bot=bot, operator=operator, db=db)


def _seed(world, sid: str, status: str, **kw) -> None:
    world.db.add(ChatSession(id=sid, client_id=world.client.id, bot_id=world.bot.id, status=status, **kw))
    world.db.commit()


def _auth(world) -> dict:
    return {
        "type": "operator",
        "entity": SimpleNamespace(id=world.operator.id, role="owner", client_id=world.client.id),
        "client_id": world.client.id,
        "operator_id": world.operator.id,
        "linked_client_id": None,
    }


def _api(world) -> TestClient:
    app = FastAPI()
    app.include_router(operator_router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: _auth(world)
    app.dependency_overrides[get_current_bot] = lambda: world.bot
    return TestClient(app)


def _status(world, sid: str) -> str:
    world.db.expire_all()
    return world.db.get(ChatSession, sid).status


def _actions(world, sid: str) -> list[str]:
    world.db.expire_all()
    return [
        a.action
        for a in world.db.execute(select(ChatAuditLog).where(ChatAuditLog.session_id == sid).order_by(ChatAuditLog.id))
        .scalars()
        .all()
    ]


# ── /close ───────────────────────────────────────────────────────────────────


def test_close_returns_a_live_conversation_to_the_bot(world):
    _seed(world, "cl-live", "live", assigned_operator_id=world.operator.id)

    resp = _api(world).post("/operators/close/cl-live")

    assert resp.status_code == 200
    assert _status(world, "cl-live") == "bot"
    assert _actions(world, "cl-live") == ["closed"]


def test_close_does_not_resurrect_a_resolved_conversation(world):
    """``closed`` is terminal. The direct write flipped it back to ``bot``."""
    _seed(world, "cl-done", "closed")

    resp = _api(world).post("/operators/close/cl-done")

    assert resp.status_code in (200, 409)
    assert _status(world, "cl-done") == "closed"


# ── /resolve ─────────────────────────────────────────────────────────────────


def test_resolve_hard_closes_a_live_conversation(world):
    _seed(world, "rs-live", "live", assigned_operator_id=world.operator.id)

    resp = _api(world).post("/operators/resolve/rs-live")

    assert resp.status_code == 200
    assert _status(world, "rs-live") == "closed"
    assert _actions(world, "rs-live") == ["resolved"]


def test_resolving_twice_does_not_write_a_second_audit_row(world):
    _seed(world, "rs-twice", "live", assigned_operator_id=world.operator.id)
    api = _api(world)

    api.post("/operators/resolve/rs-twice")
    api.post("/operators/resolve/rs-twice")

    assert _status(world, "rs-twice") == "closed"
    assert _actions(world, "rs-twice") == ["resolved"]


# ── /handoff on a terminal session ───────────────────────────────────────────


def test_a_handoff_on_a_closed_session_is_recorded_as_a_reopen(world, monkeypatch):
    from app.api import operator_routes
    from app.services import live_chat_availability_service as availsvc

    _seed(world, "hf-closed", "closed")
    monkeypatch.setattr(operator_routes.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *a, **k: True)
    monkeypatch.setattr(
        availsvc,
        "resolve_live_chat_state",
        lambda *a, **k: availsvc.LiveChatAvailability(
            state=availsvc.LiveChatState.AVAILABLE,
            suggested_action=availsvc.SuggestedAction.ROUTE,
        ),
    )
    monkeypatch.setattr("app.worker.enqueue.enqueue_sync", lambda *a, **k: None)
    operator_routes.manager.request_handoff = AsyncMock()

    resp = _api(world).post("/operators/handoff", json={"session_id": "hf-closed"})

    assert resp.status_code == 200
    assert _status(world, "hf-closed") == "waiting"
    assert "handoff_reopened_closed_session" in _actions(world, "hf-closed")
