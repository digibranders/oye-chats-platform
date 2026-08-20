"""The visitor WebSocket must enforce the origin allowlist exactly like HTTP.

``_enforce_bot_origin`` (HTTP) fails OPEN on an empty allowlist: the flag alone
never rejects anything, enforcement only starts once the customer has actually
listed a domain. The WebSocket used to skip that clause and call
``is_origin_allowed(hostname, [])`` directly, which under ``APP_ENV=production``
answers ``False`` for every host.

That mattered because ``bot_routes.create_bot`` sets ``domain_check_enabled=True``
unconditionally while deriving ``allowed_domains`` from the customer's website
only, so an agent created without a website is stored as
``(True, [])``: HTTP chat answered normally and every live-chat socket closed
with 4403. Both transports now ask ``origin_check_applies``.

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import contextmanager

import pytest
from fastapi import WebSocketDisconnect

from app.api import ws_routes
from app.db.models import Bot, Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


class _FakeWebSocket:
    """The bits of ``starlette.WebSocket`` the visitor route touches.

    ``receive_json`` disconnects on the first call, so the route runs its
    connect path once and then unwinds through its ``WebSocketDisconnect``
    handler, which is all these tests need to observe.
    """

    def __init__(self, headers: dict[str, str]):
        self.headers = headers
        self.accepted = False
        self.closed_with: tuple[int, str] | None = None
        self.sent: list[dict] = []

    async def accept(self, subprotocol: str | None = None) -> None:
        self.accepted = True

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)

    async def receive_json(self):
        raise WebSocketDisconnect(1000)


class _StubManager:
    """Stands in for the process-global ``ConnectionManager``.

    The route's own origin gate is under test here, not the manager's global
    queue/roster state, and the real ``connect_visitor`` reaches back into the
    database through its own session factory.
    """

    def __init__(self):
        self.connected: list[str] = []

    async def connect_visitor(self, session_id: str, ws, subprotocol: str | None = None) -> None:
        await ws.accept(subprotocol=subprotocol)
        self.connected.append(session_id)

    def disconnect_visitor(self, session_id: str) -> None:
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


def _bot(db, *, key: str, domains: list[str], enabled: bool = True) -> Bot:
    client = Client(name="c", email=f"{key}@e.com", api_key=key, hashed_password="h")
    db.add(client)
    db.flush()
    bot = Bot(
        client_id=client.id,
        bot_key=key,
        name="Agent",
        is_active=True,
        allowed_domains=domains,
        domain_check_enabled=enabled,
    )
    db.add(bot)
    db.flush()
    return bot


def _connect(bot: Bot, origin: str | None, session_id: str = "ws-sess-1") -> _FakeWebSocket:
    headers = {"x-bot-key": bot.bot_key}
    if origin is not None:
        headers["origin"] = origin
    ws = _FakeWebSocket(headers)
    asyncio.run(ws_routes.visitor_websocket(ws, session_id, bot_key=None))
    return ws


def test_empty_allowlist_does_not_close_the_socket(db, stub_manager, monkeypatch):
    """The live-chat outage: flag on, nothing configured, production.

    ``is_origin_allowed(host, [])`` is ``False`` for every host in production, so
    enforcing here rejected every visitor of a website-less agent even though the
    same agent's HTTP chat was unaffected.
    """
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(db, key="bot-wsempty0001", domains=[])

    ws = _connect(bot, "https://anywhere.com")

    assert ws.closed_with is None
    assert stub_manager.connected == ["ws-sess-1"]


def test_empty_allowlist_does_not_close_the_socket_without_an_origin(db, stub_manager, monkeypatch):
    """Fail-open short-circuits before the missing-header case, as it does on HTTP."""
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(db, key="bot-wsempty0002", domains=[])

    ws = _connect(bot, None)

    assert ws.closed_with is None
    assert stub_manager.connected == ["ws-sess-1"]


def test_configured_allowlist_still_rejects_a_foreign_origin(db, stub_manager, monkeypatch):
    """The fix must not disarm the check for bots that DID configure domains."""
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(db, key="bot-wsallow0001", domains=["acme.com"])

    ws = _connect(bot, "https://evil.com")

    assert ws.closed_with == (4403, "origin_not_allowed")
    assert stub_manager.connected == []
    assert ws.accepted is False


def test_configured_allowlist_admits_the_listed_domain(db, stub_manager, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(db, key="bot-wsallow0002", domains=["acme.com"])

    ws = _connect(bot, "https://acme.com")

    assert ws.closed_with is None
    assert stub_manager.connected == ["ws-sess-1"]


def test_configured_allowlist_admits_the_www_host(db, stub_manager, monkeypatch):
    """Same ``www.`` equivalence as HTTP: the apex entry covers the www host."""
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(db, key="bot-wsallow0003", domains=["acme.com"])

    ws = _connect(bot, "https://www.acme.com")

    assert ws.closed_with is None
    assert stub_manager.connected == ["ws-sess-1"]


def test_check_disabled_lets_a_foreign_origin_through(db, stub_manager, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(db, key="bot-wsoff000001", domains=["acme.com"], enabled=False)

    ws = _connect(bot, "https://evil.com")

    assert ws.closed_with is None
    assert stub_manager.connected == ["ws-sess-1"]
