"""Audit A4 / A5 / A6: tenant-scoping and live-chat teardown on operator routes.

* A4 — ``POST /operators/handoff`` took ``department_id`` from a payload
  authenticated only by the public bot key and never checked who owned it, so
  another tenant's business hours decided the out-of-hours state and their
  department name landed in this workspace's notifications.
* A5 — ``POST /operators/transfer/{sid}`` accepted a deactivated operator as the
  target, stranding the visitor with someone who can never connect.
* A6 — ``PATCH /operators/{id}`` re-queued live chats with raw SQL when the
  operator moved to another bot, leaving the ConnectionManager's queue and the
  visitors' sockets ignorant of it.
"""

import os
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot, get_current_client_or_operator
from app.api.operator_routes import router as operator_router

# ── A4: handoff department scoping (mock session, no DB needed) ──────────────


class _ScalarOneResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


@contextmanager
def _session_context(session):
    yield session


class _Reached(Exception):
    """Raised by the stubbed state machine to stop the route right after the
    department has been resolved."""


def _handoff_app(bot):
    app = FastAPI()
    app.include_router(operator_router)
    app.dependency_overrides[get_current_bot] = lambda: bot
    return app


def _run_handoff(monkeypatch, *, department_row, department_id):
    """Drive ``POST /operators/handoff`` to the state machine and return the
    ``department_id`` it was handed."""
    from app.api import operator_routes
    from app.services import live_chat_availability_service as availsvc

    bot = SimpleNamespace(id=1, client_id=1, bot_key="bot-owner")
    db_bot = SimpleNamespace(id=1, client_id=1)

    session = MagicMock()
    # 1) session lookup (absent → create path), 2) db_bot re-fetch,
    # 3) the department lookup this fix added.
    session.execute.side_effect = [
        _ScalarOneResult(None),
        _ScalarOneResult(db_bot),
        _ScalarOneResult(department_row),
    ]
    monkeypatch.setattr(operator_routes, "get_session", lambda: _session_context(session))
    monkeypatch.setattr(operator_routes.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *a, **k: True)

    seen: dict = {}

    def _capture(_bot, _session, department_id=None):
        seen["department_id"] = department_id
        raise _Reached

    monkeypatch.setattr(availsvc, "resolve_live_chat_state", _capture)

    tc = TestClient(_handoff_app(bot))
    with pytest.raises(_Reached):
        tc.post("/operators/handoff", json={"session_id": "s-1", "department_id": department_id})
    return seen["department_id"]


def test_handoff_ignores_a_department_from_another_workspace(monkeypatch):
    # The scoped lookup finds nothing, so routing degrades to workspace-wide
    # instead of borrowing the other tenant's schedule.
    assert _run_handoff(monkeypatch, department_row=None, department_id=99) is None


def test_handoff_keeps_an_owned_department(monkeypatch):
    owned = SimpleNamespace(id=5, client_id=1, name="Sales")
    assert _run_handoff(monkeypatch, department_row=owned, department_id=5) == 5


# ── A5 / A6: DB-backed operator routes ───────────────────────────────────────

pytestmark_db = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture()
def stub_manager(monkeypatch):
    from app.api import operator_routes

    stub = SimpleNamespace(
        update_operator_department=AsyncMock(),
        disconnect_operator_and_broadcast=AsyncMock(),
        handle_operator_deactivated=AsyncMock(return_value=0),
        mark_operator_offline_now=AsyncMock(return_value=0),
        transfer_chat=AsyncMock(),
    )
    monkeypatch.setattr(operator_routes, "manager", stub)
    return stub


def _client_auth(client_id: int) -> dict:
    return {
        "type": "client",
        "entity": SimpleNamespace(id=client_id),
        "client_id": client_id,
        "operator_id": None,
        "linked_client_id": None,
    }


def _build_app(auth: dict) -> FastAPI:
    app = FastAPI()
    app.include_router(operator_router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: auth
    return app


def _workspace(db, suffix: str):
    from app.db.models import Bot, Client

    client = Client(
        name=f"WS {suffix}",
        email=f"{suffix}@scoping.test",
        api_key=f"key-{suffix}",
        hashed_password="h",
    )
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key=f"bot-{suffix}", name=f"Bot {suffix}", is_legacy_pooled=False)
    db.add(bot)
    db.flush()
    return client, bot


def _operator(db, client, bot, suffix: str, *, is_active: bool = True):
    from app.db.models import Operator

    op = Operator(
        client_id=client.id,
        bot_id=bot.id,
        name=f"Op {suffix}",
        email=f"op-{suffix}@scoping.test",
        operator_api_key=f"opkey-{suffix}",
        hashed_password="h",
        role="operator",
        is_active=is_active,
    )
    db.add(op)
    db.flush()
    return op


@pytestmark_db
def test_transfer_rejects_a_deactivated_target(db, stub_manager):
    from app.db.models import ChatSession

    client, bot = _workspace(db, "transfer")
    source = _operator(db, client, bot, "source")
    target = _operator(db, client, bot, "target", is_active=False)
    chat = ChatSession(
        id="sess-transfer",
        bot_id=bot.id,
        client_id=client.id,
        status="live",
        assigned_operator_id=source.id,
    )
    db.add(chat)
    db.commit()

    tc = TestClient(_build_app(_client_auth(client.id)))
    resp = tc.post(f"/operators/transfer/{chat.id}", json={"target_operator_id": target.id})

    assert resp.status_code == 404, resp.text
    db.expire_all()
    # The chat stays with the operator who can actually serve it.
    assert db.get(ChatSession, "sess-transfer").assigned_operator_id == source.id
    stub_manager.transfer_chat.assert_not_awaited()


@pytestmark_db
def test_transfer_to_an_active_target_still_works(db, stub_manager):
    from app.db.models import ChatSession

    client, bot = _workspace(db, "transfer-ok")
    source = _operator(db, client, bot, "src-ok")
    target = _operator(db, client, bot, "tgt-ok")
    db.add(
        ChatSession(
            id="sess-ok",
            bot_id=bot.id,
            client_id=client.id,
            status="live",
            assigned_operator_id=source.id,
        )
    )
    db.commit()

    tc = TestClient(_build_app(_client_auth(client.id)))
    resp = tc.post("/operators/transfer/sess-ok", json={"target_operator_id": target.id})

    assert resp.status_code == 200, resp.text
    db.expire_all()
    assert db.get(ChatSession, "sess-ok").assigned_operator_id == target.id


@pytestmark_db
def test_bot_reassignment_releases_live_chats_through_the_manager(db, stub_manager):
    from app.db.models import Bot, ChatSession

    client, bot = _workspace(db, "reassign")
    other_bot = Bot(client_id=client.id, bot_key="bot-reassign-2", name="Bot 2", is_legacy_pooled=False)
    db.add(other_bot)
    db.flush()
    op = _operator(db, client, bot, "reassign")
    db.add(
        ChatSession(
            id="sess-reassign",
            bot_id=bot.id,
            client_id=client.id,
            status="live",
            assigned_operator_id=op.id,
        )
    )
    db.commit()

    tc = TestClient(_build_app(_client_auth(client.id)))
    resp = tc.patch(f"/operators/{op.id}", json={"bot_id": other_bot.id})

    assert resp.status_code == 200, resp.text
    db.expire_all()
    assert db.get(type(op), op.id).bot_id == other_bot.id
    # The route must NOT pre-clear the rows: the manager finds them by
    # ``status == 'live'`` and moves DB, queue and sockets together.
    live = db.get(ChatSession, "sess-reassign")
    assert live.status == "live"
    assert live.assigned_operator_id == op.id
    stub_manager.mark_operator_offline_now.assert_awaited_once()
    assert stub_manager.mark_operator_offline_now.await_args.args[0] == op.id
