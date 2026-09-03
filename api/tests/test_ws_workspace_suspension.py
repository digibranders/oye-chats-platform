"""Audit A8: live-chat websockets must honour workspace suspension/deactivation.

Every HTTP resolver funnels through ``auth._ensure_client_authenticatable``, so a
suspended or deactivated workspace loses its API key, its bot keys and its
operator keys. Neither websocket did that check: the widget's live chat and the
operator console kept working over WS after the account was suspended, and the
operator socket even re-flagged the operator online (re-occupying a seat).

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import contextmanager
from datetime import UTC, datetime

import pytest
from fastapi import WebSocketDisconnect

from app.api import ws_routes
from app.db.models import Bot, Client, Operator

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


class _FakeWebSocket:
    """The slice of ``starlette.WebSocket`` these routes touch."""

    def __init__(self, headers: dict[str, str]):
        self.headers = headers
        self.accepted = False
        self.closed_with: tuple[int, str] | None = None

    async def accept(self, subprotocol: str | None = None) -> None:
        self.accepted = True

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)

    async def send_json(self, data: dict) -> None:
        pass

    async def receive_json(self):
        raise WebSocketDisconnect(1000)


class _StubManager:
    def __init__(self):
        self.connected: list[str] = []
        self.operators: list[int] = []

    async def connect_visitor(self, session_id: str, ws, subprotocol: str | None = None) -> None:
        await ws.accept(subprotocol=subprotocol)
        self.connected.append(session_id)

    def disconnect_visitor(self, session_id: str, ws: object | None = None) -> None:
        pass

    async def connect_operator(self, operator_id: int, ws, **_kwargs) -> None:
        await ws.accept()
        self.operators.append(operator_id)

    def disconnect_operator(self, operator_id: int, ws: object | None = None) -> None:
        pass

    async def disconnect_operator_and_broadcast(self, operator_id: int, ws: object | None = None) -> None:
        pass


@contextmanager
def _ctx(session):
    yield session


@pytest.fixture()
def stub_manager(db, monkeypatch):
    manager = _StubManager()
    monkeypatch.setattr(ws_routes, "manager", manager)
    monkeypatch.setattr(ws_routes, "get_session", lambda: _ctx(db))
    return manager


def _workspace(db, key: str, *, suspended=None, deactivated=None, is_superadmin=False):
    client = Client(
        name="c",
        email=f"{key}@suspension.test",
        api_key=f"api-{key}",
        hashed_password="h",
        suspended_at=suspended,
        deactivated_at=deactivated,
        is_superadmin=is_superadmin,
    )
    db.add(client)
    db.flush()
    bot = Bot(
        client_id=client.id,
        bot_key=key,
        name="Agent",
        is_active=True,
        allowed_domains=[],
        domain_check_enabled=False,
    )
    db.add(bot)
    db.flush()
    return client, bot


def _connect_visitor(bot: Bot) -> _FakeWebSocket:
    ws = _FakeWebSocket({"x-bot-key": bot.bot_key})
    asyncio.run(ws_routes.visitor_websocket(ws, "ws-suspended-1", bot_key=None))
    return ws


def _operator_row(db, client, bot, key: str) -> Operator:
    op = Operator(
        client_id=client.id,
        bot_id=bot.id,
        name="Op",
        email=f"op-{key}@suspension.test",
        operator_api_key=f"opkey-{key}",
        hashed_password="h",
        role="owner",
        is_active=True,
        is_online=False,
    )
    db.add(op)
    db.flush()
    return op


class TestVisitorSocket:
    def test_suspended_owner_closes_the_socket(self, db, stub_manager):
        _client, bot = _workspace(db, "bot-susp00000001", suspended=datetime.now(UTC))

        ws = _connect_visitor(bot)

        assert ws.closed_with == (4003, "account_unavailable")
        assert stub_manager.connected == []
        assert ws.accepted is False

    def test_deactivated_owner_closes_the_socket(self, db, stub_manager):
        _client, bot = _workspace(db, "bot-deact00000001", deactivated=datetime.now(UTC))

        ws = _connect_visitor(bot)

        assert ws.closed_with == (4003, "account_unavailable")
        assert stub_manager.connected == []

    def test_healthy_owner_still_connects(self, db, stub_manager):
        _client, bot = _workspace(db, "bot-ok0000000001")

        ws = _connect_visitor(bot)

        assert ws.closed_with is None
        assert stub_manager.connected == ["ws-suspended-1"]

    def test_superadmin_owner_is_exempt(self, db, stub_manager):
        _client, bot = _workspace(db, "bot-sa0000000001", suspended=datetime.now(UTC), is_superadmin=True)

        ws = _connect_visitor(bot)

        assert ws.closed_with is None
        assert stub_manager.connected == ["ws-suspended-1"]


class TestOperatorResolver:
    def test_operator_key_refused_for_a_suspended_workspace(self, db, stub_manager):
        client, bot = _workspace(db, "bot-opsusp000001", suspended=datetime.now(UTC))
        op = _operator_row(db, client, bot, "susp")
        db.flush()

        assert ws_routes._resolve_operator_from_key(op.operator_api_key, "operator_key") is None
        db.expire_all()
        # Refused before the side effect: the seat is not re-occupied.
        assert db.get(Operator, op.id).is_online is False

    def test_client_key_refused_for_a_deactivated_workspace(self, db, stub_manager):
        client, bot = _workspace(db, "bot-opdeact00001", deactivated=datetime.now(UTC))
        op = _operator_row(db, client, bot, "deact")
        db.flush()

        assert ws_routes._resolve_operator_from_key(client.api_key, "api_key") is None
        db.expire_all()
        assert db.get(Operator, op.id).is_online is False

    def test_healthy_workspace_still_resolves(self, db, stub_manager):
        client, bot = _workspace(db, "bot-ophealthy001")
        op = _operator_row(db, client, bot, "healthy")
        db.flush()

        resolved = ws_routes._resolve_operator_from_key(op.operator_api_key, "operator_key")

        assert resolved is not None
        assert resolved[0] == op.id
