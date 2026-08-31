"""Live-chat fan-outs must reach operators whose socket lives in another process.

nginx routes ``/ws/`` to ``oyechats-ws`` (``WEB_CONCURRENCY=1``) and every HTTP
route to ``oyechats-api`` (``WEB_CONCURRENCY=2``), so the process that raises a
handoff, accepts a chat, transfers one or re-queues an orphaned conversation
holds NO operator sockets at all: ``ConnectionManager.operator_connections`` is
permanently ``{}`` there. Every fan-out written as
``for oid in self.operator_connections`` therefore notified nobody, silently.

Each test puts the manager in exactly that state - empty socket table, the
operator visible only through Redis presence - and asserts the frame is still
handed to the backplane for the process that does hold the socket.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import contextmanager

import pytest

from app.db.models import Bot, ChatSession, Client, Operator
from app.services import live_chat_service as lcs
from app.services import ws_backplane

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="the queue snapshot is derived from ChatSession rows, so this needs Postgres at DB_URL",
)


class Ctx:
    def __init__(self, mgr, client_id, bot_id, operator_id, foreign_operator_id):
        self.mgr = mgr
        self.client_id = client_id
        self.bot_id = bot_id
        self.operator = operator_id
        self.foreign_operator = foreign_operator_id


@pytest.fixture
def ctx(db, monkeypatch):
    """One workspace with a waiting visitor and an operator online *elsewhere*."""
    client = Client(name="C", email="fanout@ex.com", api_key="k-fanout", hashed_password="h")
    other = Client(name="D", email="fanout2@ex.com", api_key="k-fanout2", hashed_password="h")
    db.add_all([client, other])
    db.flush()
    bot = Bot(client_id=client.id, bot_key="bot-fanout", name="Fanout Bot")
    other_bot = Bot(client_id=other.id, bot_key="bot-fanout-2", name="Other Bot")
    db.add_all([bot, other_bot])
    db.flush()
    operator = Operator(client_id=client.id, bot_id=bot.id, name="Remote", email="remote@ex.com")
    foreign = Operator(client_id=other.id, bot_id=other_bot.id, name="Foreign", email="foreign@ex.com")
    db.add_all([operator, foreign])
    db.flush()
    db.add(
        ChatSession(
            id="sess-waiting",
            client_id=client.id,
            bot_id=bot.id,
            status="waiting",
        )
    )
    db.commit()

    @contextmanager
    def _fake_session():
        yield db

    monkeypatch.setattr(lcs, "get_session", _fake_session)

    mgr = lcs.ConnectionManager()
    assert mgr.operator_connections == {}
    return Ctx(mgr, client.id, bot.id, operator.id, foreign.id)


def _presence(monkeypatch, mapping: dict[int, set[int]]):
    """Redis presence: ``client_id -> online operator ids``, none of them local."""
    monkeypatch.setattr(lcs.presence, "get_online_operator_ids", lambda client_id: set(mapping.get(client_id, ())))


def _capture(mgr, monkeypatch):
    """Record every frame the backplane is asked to deliver to an operator."""
    sent: list[tuple[int, dict]] = []

    async def _deliver(manager, operator_id, payload):
        assert manager is mgr
        sent.append((operator_id, payload))
        return True

    async def _publish(operator_id, payload):
        sent.append((operator_id, payload))
        return True

    monkeypatch.setattr(ws_backplane, "deliver_to_operator", _deliver)
    monkeypatch.setattr(ws_backplane, "publish_to_operator", _publish)
    return sent


# ── Defect 1: a new handoff never reached a connected operator ───────────────


def test_a_new_handoff_reaches_an_operator_connected_to_another_process(ctx, monkeypatch):
    _presence(monkeypatch, {ctx.client_id: {ctx.operator}})
    sent = _capture(ctx.mgr, monkeypatch)

    asyncio.run(
        ctx.mgr.request_handoff(
            "sess-waiting",
            timeout_seconds=600,
            client_id=ctx.client_id,
            bot_id=ctx.bot_id,
        )
    )
    ctx.mgr._cancel_timeout("sess-waiting")

    queue_frames = [(oid, p) for oid, p in sent if p.get("type") == "queue_update"]
    assert [oid for oid, _ in queue_frames] == [ctx.operator]
    assert [row["session_id"] for row in queue_frames[0][1]["waiting"]] == ["sess-waiting"]
    assert queue_frames[0][1]["count"] == 1


def test_a_handoff_is_not_advertised_to_another_workspace(ctx, monkeypatch):
    """Presence is asked for THIS workspace only, and a local foreign operator
    is still filtered by ``_should_notify_operator``."""
    _presence(monkeypatch, {ctx.client_id: {ctx.operator}, 999: {ctx.foreign_operator}})
    ctx.mgr.operator_connections[ctx.foreign_operator] = object()
    ctx.mgr._operator_client_ids[ctx.foreign_operator] = 999
    sent = _capture(ctx.mgr, monkeypatch)

    asyncio.run(ctx.mgr.request_handoff("sess-waiting", timeout_seconds=600, client_id=ctx.client_id))
    ctx.mgr._cancel_timeout("sess-waiting")

    assert ctx.foreign_operator not in {oid for oid, p in sent if p.get("type") == "queue_update"}


# ── Defect 4: a re-queued session was orphaned ───────────────────────────────


def test_a_requeued_session_gets_a_timeout_and_is_re_advertised(ctx, db, monkeypatch):
    """An operator toggling offline hands their live chats back to the queue."""
    db.add(
        ChatSession(
            id="sess-orphan",
            client_id=ctx.client_id,
            bot_id=ctx.bot_id,
            status="live",
            assigned_operator_id=ctx.operator,
        )
    )
    db.commit()
    _presence(monkeypatch, {ctx.client_id: {ctx.operator}})
    sent = _capture(ctx.mgr, monkeypatch)
    ctx.mgr._operator_client_ids[ctx.operator] = ctx.client_id

    async def _run():
        requeued = await ctx.mgr.mark_operator_offline_now(ctx.operator)
        # Cancel before the loop closes so the pending task isn't destroyed.
        tasks = dict(ctx.mgr._timeout_tasks)
        for sid in tasks:
            ctx.mgr._cancel_timeout(sid)
        return requeued, set(tasks)

    requeued, timed = asyncio.run(_run())

    assert requeued == 1
    assert "sess-orphan" in timed, "a re-queued session must get a queue timeout, or it sits waiting forever"
    assert ctx.operator in {oid for oid, p in sent if p.get("type") == "queue_update"}


def test_the_grace_period_requeue_also_re_advertises(ctx, db, monkeypatch):
    db.add(
        ChatSession(
            id="sess-grace",
            client_id=ctx.client_id,
            bot_id=ctx.bot_id,
            status="live",
            assigned_operator_id=ctx.operator,
        )
    )
    db.commit()
    monkeypatch.setattr(lcs.ConnectionManager, "DEFAULT_OPERATOR_DISCONNECT_TIMEOUT", 0)
    _presence(monkeypatch, {ctx.client_id: {ctx.operator}})
    sent = _capture(ctx.mgr, monkeypatch)
    ctx.mgr._operator_client_ids[ctx.operator] = ctx.client_id

    async def _run():
        await ctx.mgr._operator_disconnect_timeout(ctx.operator)
        tasks = set(ctx.mgr._timeout_tasks)
        for sid in list(tasks):
            ctx.mgr._cancel_timeout(sid)
        return tasks

    timed = asyncio.run(_run())

    assert "sess-grace" in timed
    assert ctx.operator in {oid for oid, p in sent if p.get("type") == "queue_update"}


# ── Defect 8: three more local-only fan-outs ─────────────────────────────────


def test_accept_re_advertises_the_queue_to_operators_in_another_process(ctx, db, monkeypatch):
    db.add(
        ChatSession(
            id="sess-taken",
            client_id=ctx.client_id,
            bot_id=ctx.bot_id,
            status="live",
            assigned_operator_id=ctx.foreign_operator,
        )
    )
    db.commit()
    _presence(monkeypatch, {ctx.client_id: {ctx.operator}})
    sent = _capture(ctx.mgr, monkeypatch)
    ctx.mgr._session_client_ids["sess-taken"] = ctx.client_id

    asyncio.run(ctx.mgr.accept_chat("sess-taken", ctx.foreign_operator, "Foreign"))

    assert ctx.operator in {oid for oid, p in sent if p.get("type") == "queue_update"}


def test_transfer_re_advertises_the_queue_to_operators_in_another_process(ctx, monkeypatch):
    _presence(monkeypatch, {ctx.client_id: {ctx.operator}})
    sent = _capture(ctx.mgr, monkeypatch)
    ctx.mgr._session_client_ids["sess-waiting"] = ctx.client_id
    monkeypatch.setattr("app.worker.enqueue.enqueue_sync", lambda *a, **k: None)

    asyncio.run(ctx.mgr.transfer_chat("sess-waiting", None, ctx.foreign_operator, "Foreign"))

    assert ctx.operator in {oid for oid, p in sent if p.get("type") == "queue_update"}


def test_a_declined_connect_request_resolves_an_operator_in_another_process(ctx, monkeypatch):
    sent = _capture(ctx.mgr, monkeypatch)

    asyncio.run(ctx.mgr.notify_connect_request_resolved(ctx.operator, "sess-waiting", "declined"))

    assert [(oid, p["type"]) for oid, p in sent] == [(ctx.operator, "connect_request_resolved")]


def test_a_qualified_bot_change_reaches_an_operator_in_another_process(ctx, monkeypatch):
    _presence(monkeypatch, {ctx.client_id: {ctx.operator}})
    sent = _capture(ctx.mgr, monkeypatch)

    asyncio.run(ctx.mgr.broadcast_qualified_bot_changed(ctx.client_id, "sess-waiting"))

    assert [(oid, p["type"]) for oid, p in sent] == [(ctx.operator, "qualified_bot_changed")]


def test_a_qualified_bot_change_is_not_broadcast_across_tenants(ctx, monkeypatch):
    _presence(monkeypatch, {ctx.client_id: {ctx.operator}})
    sent = _capture(ctx.mgr, monkeypatch)
    ctx.mgr.operator_connections[ctx.foreign_operator] = object()
    ctx.mgr._operator_client_ids[ctx.foreign_operator] = 999

    asyncio.run(ctx.mgr.broadcast_qualified_bot_changed(ctx.client_id, "sess-waiting"))

    assert ctx.foreign_operator not in {oid for oid, _ in sent}


# ── Defect 8 (tail): a failed local send must arm the grace-period queue ─────


class _DeadSocket:
    async def send_json(self, data):
        raise RuntimeError("socket is wedged")


def test_a_failed_local_send_arms_the_grace_period(ctx):
    ctx.mgr.operator_connections[ctx.operator] = _DeadSocket()

    async def _run():
        await ctx.mgr._send_to_operator_local(ctx.operator, {"type": "message"})
        armed = ctx.mgr._operator_disconnect_tasks.get(ctx.operator)
        ctx.mgr._cancel_operator_disconnect_task(ctx.operator)
        return armed

    armed = asyncio.run(_run())

    assert ctx.operator not in ctx.mgr.operator_connections
    assert armed is not None, "without a grace-period task the visitor's next messages are dropped, not queued"


# ── Defect 9: a stale in-memory assignment must not eat the connected frame ──


def test_accept_still_tells_the_visitor_when_memory_disagrees_with_the_database(ctx, db, monkeypatch):
    """The database committed the accept; this process's map is simply behind."""
    db.add(
        ChatSession(
            id="sess-diverged",
            client_id=ctx.client_id,
            bot_id=ctx.bot_id,
            status="live",
            assigned_operator_id=ctx.operator,
        )
    )
    db.commit()
    _presence(monkeypatch, {ctx.client_id: set()})
    _capture(ctx.mgr, monkeypatch)
    # Memory still points at whoever held it before the transfer/accept.
    ctx.mgr.assignments["sess-diverged"] = ctx.foreign_operator

    visitor: list[dict] = []

    async def _to_visitor(session_id, data):
        visitor.append(data)

    monkeypatch.setattr(ctx.mgr, "_send_to_visitor", _to_visitor)

    accepted = asyncio.run(ctx.mgr.accept_chat("sess-diverged", ctx.operator, "Remote"))

    assert accepted is True
    assert [d["status"] for d in visitor] == ["connected"]
    assert ctx.mgr.assignments["sess-diverged"] == ctx.operator


def test_accept_still_refuses_when_the_database_names_someone_else(ctx, db, monkeypatch):
    """The guard is not removed, only re-based on the authoritative store."""
    db.add(
        ChatSession(
            id="sess-taken-by-other",
            client_id=ctx.client_id,
            bot_id=ctx.bot_id,
            status="live",
            assigned_operator_id=ctx.foreign_operator,
        )
    )
    db.commit()
    _presence(monkeypatch, {ctx.client_id: set()})
    _capture(ctx.mgr, monkeypatch)
    ctx.mgr.assignments["sess-taken-by-other"] = ctx.foreign_operator

    visitor: list[dict] = []

    async def _to_visitor(session_id, data):
        visitor.append(data)

    monkeypatch.setattr(ctx.mgr, "_send_to_visitor", _to_visitor)

    accepted = asyncio.run(ctx.mgr.accept_chat("sess-taken-by-other", ctx.operator, "Remote"))

    assert accepted is False
    assert visitor == []
