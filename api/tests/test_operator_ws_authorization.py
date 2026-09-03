"""An operator socket may only drive conversations that operator actually holds.

``/ws/operator`` authenticates the operator and then checked, at most, that the
conversation's bot belonged to the same workspace. Two consequences:

* ``message`` / ``file`` / ``close_chat`` let operator B type into, attach files
  to, and end operator A's live conversation — a colleague, not an attacker, is
  enough to do it by clicking the wrong row;
* ``typing`` and ``read_receipt`` had **no** check at all, not even the
  workspace one, so any authenticated operator in any tenant could drive another
  workspace's visitor widget by naming its session id.

The socket is driven for real here (a scripted fake WebSocket through
``operator_websocket``), because the checks live inside the frame loop and a
unit test on a helper would not prove the loop consults it.
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


class _FakeWebSocket:
    """Replays a scripted list of frames, then disconnects."""

    def __init__(self, frames: list[dict]):
        self.headers: dict[str, str] = {}
        self._frames = list(frames)
        self.sent: list[dict] = []
        self.closed_with: tuple[int, str] | None = None

    async def accept(self, subprotocol: str | None = None) -> None:
        pass

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)

    async def receive_json(self):
        if self._frames:
            return self._frames.pop(0)
        raise WebSocketDisconnect(1000)


class _StubManager(lcs.ConnectionManager):
    """A real manager with the socket plumbing replaced by recorders.

    Subclassed rather than mocked so ``_assigned_operator`` (which the typing /
    read-receipt guard consults) keeps its real database-backed behaviour.
    """

    def __init__(self):
        super().__init__()
        self.typing: list[str] = []
        self.receipts: list[tuple[str, int]] = []
        self.messages: list[tuple[str, str]] = []
        self.files: list[str] = []
        self.closed: list[str] = []

    async def connect_operator(self, operator_id, ws, **kwargs):
        await ws.accept(subprotocol=kwargs.get("subprotocol"))
        self.operator_connections[operator_id] = ws

    async def disconnect_operator_and_broadcast(self, operator_id, ws=None):
        self.operator_connections.pop(operator_id, None)

    async def route_operator_message(self, session_id, content, *a, **k):
        self.messages.append((session_id, content))

    async def route_operator_file(self, session_id, *a, **k):
        self.files.append(session_id)

    async def send_typing_to_visitor(self, session_id):
        self.typing.append(session_id)

    async def send_read_receipt_to_visitor(self, session_id, last_read_id):
        self.receipts.append((session_id, last_read_id))

    async def close_chat(self, session_id, bot_name="AI Assistant", client_id=None):
        self.closed.append(session_id)

    def _invalidate_workspace_state_caches(self, client_id):
        pass


class World:
    def __init__(self, db, mgr, owner, holder, colleague, stranger):
        self.db = db
        self.mgr = mgr
        self.owner = owner  # owner-role operator of workspace A
        self.holder = holder  # the operator the session is assigned to
        self.colleague = colleague  # same workspace, not assigned
        self.stranger = stranger  # a different workspace entirely


@pytest.fixture
def world(db, monkeypatch):
    a = Client(name="A", email="a@ws.test", api_key="key-ws-a", hashed_password="h")
    b = Client(name="B", email="b@ws.test", api_key="key-ws-b", hashed_password="h")
    db.add_all([a, b])
    db.flush()
    bot_a = Bot(client_id=a.id, bot_key="bot-ws-a", name="A Bot")
    bot_b = Bot(client_id=b.id, bot_key="bot-ws-b", name="B Bot")
    db.add_all([bot_a, bot_b])
    db.flush()

    def _op(client, bot, suffix, role="operator"):
        op = Operator(
            client_id=client.id,
            bot_id=bot.id,
            name=f"Op {suffix}",
            email=f"{suffix}@ws.test",
            operator_api_key=f"opkey-{suffix}",
            role=role,
        )
        db.add(op)
        db.flush()
        return op

    holder = _op(a, bot_a, "holder")
    colleague = _op(a, bot_a, "colleague")
    owner = _op(a, bot_a, "owner", role="owner")
    stranger = _op(b, bot_b, "stranger")

    db.add(
        ChatSession(
            id="sess-owned",
            client_id=a.id,
            bot_id=bot_a.id,
            status="live",
            assigned_operator_id=holder.id,
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
    return World(db, mgr, owner, holder, colleague, stranger)


def _drive(world: World, operator: Operator, frames: list[dict]) -> _FakeWebSocket:
    ws = _FakeWebSocket(frames)
    asyncio.run(ws_routes.operator_websocket(ws, operator_key=operator.operator_api_key))
    world.mgr.assignments.clear()  # per-frame resolution, not a cross-test cache
    return ws


def _persisted(db, session_id: str) -> list[str]:
    return [
        m.content for m in db.execute(select(ChatMessage).where(ChatMessage.session_id == session_id)).scalars().all()
    ]


# ── message ──────────────────────────────────────────────────────────────────


def test_the_assigned_operator_can_message_their_own_conversation(world):
    _drive(world, world.holder, [{"type": "message", "session_id": "sess-owned", "content": "hi"}])

    assert world.mgr.messages == [("sess-owned", "hi")]
    assert _persisted(world.db, "sess-owned") == ["hi"]


def test_a_colleague_cannot_inject_a_message_into_someone_elses_conversation(world):
    _drive(world, world.colleague, [{"type": "message", "session_id": "sess-owned", "content": "hijack"}])

    assert world.mgr.messages == []
    assert _persisted(world.db, "sess-owned") == []


def test_an_owner_may_still_step_into_a_colleagues_conversation(world):
    """Escalation is a real product path: owners/admins already close and
    transfer other operators' chats over REST."""
    _drive(world, world.owner, [{"type": "message", "session_id": "sess-owned", "content": "stepping in"}])

    assert world.mgr.messages == [("sess-owned", "stepping in")]


# ── file ─────────────────────────────────────────────────────────────────────


def test_a_colleague_cannot_attach_a_file_to_someone_elses_conversation(world):
    _drive(
        world,
        world.colleague,
        [
            {
                "type": "file",
                "session_id": "sess-owned",
                "file_url": "https://cdn.oyechats.com/x.pdf",
                "filename": "x.pdf",
                "content_type": "application/pdf",
            }
        ],
    )

    assert world.mgr.files == []
    assert _persisted(world.db, "sess-owned") == []


# ── close_chat ───────────────────────────────────────────────────────────────


def test_a_colleague_cannot_close_someone_elses_conversation(world):
    _drive(world, world.colleague, [{"type": "close_chat", "session_id": "sess-owned"}])

    assert world.mgr.closed == []
    assert world.db.get(ChatSession, "sess-owned").status == "live"


def test_the_assigned_operator_can_close_their_own_conversation(world):
    _drive(world, world.holder, [{"type": "close_chat", "session_id": "sess-owned"}])

    assert world.mgr.closed == ["sess-owned"]
    assert world.db.get(ChatSession, "sess-owned").status == "bot"


# ── typing / read_receipt: no check at all before the fix ────────────────────


def test_a_stranger_cannot_drive_another_workspaces_typing_indicator(world):
    _drive(world, world.stranger, [{"type": "typing", "session_id": "sess-owned"}])

    assert world.mgr.typing == []


def test_a_stranger_cannot_forge_a_read_receipt_in_another_workspace(world):
    _drive(world, world.stranger, [{"type": "read_receipt", "session_id": "sess-owned", "last_read_id": 5}])

    assert world.mgr.receipts == []


def test_a_colleague_cannot_drive_the_typing_indicator_either(world):
    _drive(world, world.colleague, [{"type": "typing", "session_id": "sess-owned"}])

    assert world.mgr.typing == []


def test_the_assigned_operator_still_drives_typing_and_read_receipts(world):
    _drive(
        world,
        world.holder,
        [
            {"type": "typing", "session_id": "sess-owned"},
            {"type": "read_receipt", "session_id": "sess-owned", "last_read_id": 7},
        ],
    )

    assert world.mgr.typing == ["sess-owned"]
    assert world.mgr.receipts == [("sess-owned", 7)]
