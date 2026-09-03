"""The operator socket's ``message`` frame: whose language, and whose turn.

Two defects that only appear once the socket is driven for real:

* the operator's language was captured ONCE at connect and never re-read, so an
  operator who picked a language mid-shift immediately started RECEIVING
  translated visitor messages (that direction reads the row per message) while
  every reply they SENT went out untranslated and stamped with the wrong
  ``source_language``;
* the outbound translation was awaited inside the sequential
  ``while True: await ws.receive_json()`` loop, so up to four seconds of
  provider latency froze that operator's typing indicators, read receipts and
  messages to every OTHER conversation they had open.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import contextmanager

import pytest
from fastapi import WebSocketDisconnect
from sqlalchemy import select

from app.api import ws_routes
from app.db.models import Bot, ChatMessage, ChatSession, Client, Operator
from app.services import live_chat_service as lcs

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

MULTILINGUAL_ON = {
    "enabled": True,
    "default_locale": "en-IN",
    "supported_locales": ["en-IN", "hi-IN"],
    "operator_translation_enabled": True,
}


class _ScriptedWebSocket:
    """Replays scripted frames, then disconnects.

    A frame may be a callable, which is invoked instead of being delivered.
    That is what makes "the operator changed their language mid-shift"
    expressible: the row is rewritten between two frames of one connection,
    exactly as ``PUT /operators/me/language`` does it.
    """

    def __init__(self, frames: list):
        self.headers: dict[str, str] = {}
        self._frames = list(frames)
        self.sent: list[dict] = []

    async def accept(self, subprotocol: str | None = None) -> None:
        pass

    async def close(self, code: int = 1000, reason: str = "") -> None:
        pass

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)

    async def receive_json(self):
        # A real socket read yields to the loop. Without this, a task the
        # handler dispatches would never get a chance to start and the test
        # would measure scheduling, not behaviour.
        await asyncio.sleep(0)
        while self._frames:
            frame = self._frames.pop(0)
            if callable(frame):
                result = frame()
                if asyncio.iscoroutine(result):
                    await result
                continue
            return frame
        raise WebSocketDisconnect(1000)


class _StubManager(lcs.ConnectionManager):
    def __init__(self):
        super().__init__()
        self.messages: list[tuple[str, str, str | None]] = []
        self.typing: list[str] = []

    async def connect_operator(self, operator_id, ws, **kwargs):
        await ws.accept(subprotocol=kwargs.get("subprotocol"))
        self.operator_connections[operator_id] = ws

    async def disconnect_operator_and_broadcast(self, operator_id, ws=None):
        self.operator_connections.pop(operator_id, None)

    async def route_operator_message(self, session_id, content, *a, **k):
        self.messages.append((session_id, content, k.get("delivered_content")))

    async def route_operator_file(self, session_id, file_url, filename, *a, **k):
        self.messages.append((session_id, f"[file] {filename}", None))

    async def send_typing_to_visitor(self, session_id):
        self.typing.append(session_id)

    def _invalidate_workspace_state_caches(self, client_id):
        pass


@pytest.fixture
def world(db, monkeypatch):
    client = Client(name="Acme", email="acme@ws.test", api_key="key-acme", hashed_password="h")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key="bot-acme", name="Acme Bot", language_config=MULTILINGUAL_ON)
    db.add(bot)
    db.flush()
    operator = Operator(
        client_id=client.id,
        bot_id=bot.id,
        name="Asha",
        email="asha@ws.test",
        operator_api_key="op-key-acme",
        role="owner",
        preferred_locale="en-IN",
    )
    db.add(operator)
    db.flush()
    for sid in ("sess-a", "sess-b"):
        db.add(
            ChatSession(
                id=sid,
                client_id=client.id,
                bot_id=bot.id,
                status="live",
                assigned_operator_id=operator.id,
                language_code="hi",
                locale="hi-IN",
            )
        )
    db.commit()

    @contextmanager
    def _ctx():
        yield db

    mgr = _StubManager()
    monkeypatch.setattr(ws_routes, "manager", mgr)
    monkeypatch.setattr(ws_routes, "get_session", _ctx)
    monkeypatch.setattr(lcs, "get_session", _ctx)
    monkeypatch.setattr(ws_routes, "is_translation_enabled", lambda bot: True)
    return {"db": db, "mgr": mgr, "operator": operator, "bot": bot}


def _drive(world, frames):
    ws = _ScriptedWebSocket(frames)
    asyncio.run(ws_routes.operator_websocket(ws, operator_key=world["operator"].operator_api_key))
    world["mgr"].assignments.clear()
    return ws


def _messages(db, session_id):
    stmt = select(ChatMessage).where(ChatMessage.session_id == session_id).order_by(ChatMessage.id)
    return db.execute(stmt).scalars().all()


# ── The operator's language, mid-shift ───────────────────────────────────────


class TestOperatorLocaleIsReReadPerMessage:
    def test_a_language_change_mid_shift_applies_to_the_next_reply(self, world, monkeypatch):
        calls = []

        async def _translate(session_id, message_id, content, bot, source, target):
            calls.append({"source": source, "target": target})
            return f"[{target}] {content}", source

        monkeypatch.setattr(ws_routes, "translate_outgoing", _translate)

        def _switch_to_french():
            # Exactly what PUT /operators/me/language does: it writes the row
            # and nothing else. No reconnect, no frame.
            world["operator"].preferred_locale = "fr-FR"
            world["db"].commit()

        _drive(
            world,
            [
                {"type": "message", "session_id": "sess-a", "content": "one"},
                _switch_to_french,
                {"type": "message", "session_id": "sess-a", "content": "two"},
            ],
        )

        assert [c["source"] for c in calls] == ["en-IN", "fr-FR"]

    def test_the_persisted_source_language_follows_the_change(self, world, monkeypatch):
        """A wrong ``source_language`` is not cosmetic: the transcript backfill
        reads it to decide what to translate from later."""

        async def _translate(session_id, message_id, content, bot, source, target):
            return content, source

        monkeypatch.setattr(ws_routes, "translate_outgoing", _translate)

        def _switch_to_french():
            world["operator"].preferred_locale = "fr-FR"
            world["db"].commit()

        _drive(
            world,
            [
                {"type": "message", "session_id": "sess-a", "content": "one"},
                _switch_to_french,
                {"type": "message", "session_id": "sess-a", "content": "two"},
            ],
        )

        world["db"].expire_all()
        stored = {m.content: m.source_language for m in _messages(world["db"], "sess-a")}
        assert stored == {"one": "en-IN", "two": "fr-FR"}

    def test_a_cleared_preference_falls_back_to_the_connect_time_value(self, world, monkeypatch):
        """A NULL row must not be read as "no language", which would silently
        turn translation off for an operator who never touched the setting."""
        sources = []

        async def _translate(session_id, message_id, content, bot, source, target):
            sources.append(source)
            return content, source

        monkeypatch.setattr(ws_routes, "translate_outgoing", _translate)

        def _clear():
            world["operator"].preferred_locale = None
            world["db"].commit()

        _drive(world, [_clear, {"type": "message", "session_id": "sess-a", "content": "one"}])

        assert sources == ["en-IN"]


# ── The loop keeps reading ───────────────────────────────────────────────────


class TestOutgoingTranslationDoesNotStallTheSocket:
    def test_other_frames_are_served_while_a_translation_is_in_flight(self, world, monkeypatch):
        observed = {}

        async def _slow_translate(session_id, message_id, content, bot, source, target):
            await asyncio.sleep(0.2)
            return f"[{target}] {content}", source

        monkeypatch.setattr(ws_routes, "translate_outgoing", _slow_translate)

        def _observe():
            # Reached while the translation above is still sleeping. If the
            # loop awaited it, this frame would not have been read yet and the
            # message would already be routed.
            observed["typing"] = list(world["mgr"].typing)
            observed["messages"] = list(world["mgr"].messages)

        _drive(
            world,
            [
                {"type": "message", "session_id": "sess-a", "content": "slow one"},
                {"type": "typing", "session_id": "sess-b"},
                _observe,
            ],
        )

        # The typing indicator for the OTHER conversation was delivered...
        assert observed["typing"] == ["sess-b"]
        # ...before the slow message finished.
        assert observed["messages"] == []
        # And the reply is still delivered, drained before the handler returns.
        assert world["mgr"].messages == [("sess-a", "slow one", "[hi] slow one")]

    def test_two_replies_in_one_conversation_keep_their_order(self, world, monkeypatch):
        """Concurrency must not reorder a conversation. The first reply is the
        slow one precisely so an unordered implementation delivers it second."""
        delays = {"first": 0.2, "second": 0.0}

        async def _translate(session_id, message_id, content, bot, source, target):
            await asyncio.sleep(delays[content])
            return content, source

        monkeypatch.setattr(ws_routes, "translate_outgoing", _translate)

        _drive(
            world,
            [
                {"type": "message", "session_id": "sess-a", "content": "first"},
                {"type": "message", "session_id": "sess-a", "content": "second"},
            ],
        )

        assert [m[1] for m in world["mgr"].messages] == ["first", "second"]
        assert [m.content for m in _messages(world["db"], "sess-a")] == ["first", "second"]

    def test_a_reply_sent_just_before_disconnect_is_not_lost(self, world, monkeypatch):
        async def _slow_translate(session_id, message_id, content, bot, source, target):
            await asyncio.sleep(0.1)
            return content, source

        monkeypatch.setattr(ws_routes, "translate_outgoing", _slow_translate)

        _drive(world, [{"type": "message", "session_id": "sess-a", "content": "last words"}])

        assert [m[1] for m in world["mgr"].messages] == ["last words"]

    def test_an_attachment_does_not_overtake_the_message_before_it(self, world, monkeypatch):
        """A file is conversation content, so it queues behind an earlier reply
        that is still being translated rather than arriving in front of it."""

        async def _slow_translate(session_id, message_id, content, bot, source, target):
            await asyncio.sleep(0.2)
            return content, source

        monkeypatch.setattr(ws_routes, "translate_outgoing", _slow_translate)

        _drive(
            world,
            [
                {"type": "message", "session_id": "sess-a", "content": "here it is"},
                {
                    "type": "file",
                    "session_id": "sess-a",
                    "file_url": "https://cdn.example.com/quote.pdf",
                    "filename": "quote.pdf",
                    "content_type": "application/pdf",
                },
            ],
        )

        assert [m[1] for m in world["mgr"].messages] == ["here it is", "[file] quote.pdf"]
