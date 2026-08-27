"""The visitor-to-operator path must survive the live-chat process split.

WHAT BROKE
----------
nginx routes ``/ws/`` to oyechats-ws and every HTTP route to oyechats-api, so
``POST /operators/accept`` runs in one process and the visitor's socket lives in
another. ``ConnectionManager.assignments`` is per-process memory written by the
accept, so the WS process found an empty map and dropped every visitor message.
It logged nothing: the caller only reports a failed route while the session is
still ``waiting``, and by then the session is ``live``.

Reproduced against a mirror of the production topology (accept on the API
process, both sockets on a single-worker WS process): zero of five visitor
messages reached the operator, while operator-to-visitor worked throughout,
because that direction has no equivalent gate.

These are unit tests on purpose. ``test_live_chat_cross_process.py`` covers the
same ground end to end but skips unless two nodes are provisioned, which is why
this class of bug reached production unnoticed. Everything here runs in CI.
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
    reason="assignment resolution reads ChatSession, so it needs a reachable Postgres at DB_URL",
)


class Ctx:
    """The manager under test plus the two operator ids the database knows."""

    def __init__(self, mgr, operator: int, other: int):
        self.mgr = mgr
        self.operator = operator
        self.other = other


@pytest.fixture
def ctx(db, monkeypatch):
    """A session the database calls ``live`` and assigned, as after an accept.

    The manager is built fresh with an EMPTY ``assignments`` map, which is
    exactly the state the WS process is in: the accept that wrote the
    assignment happened in a different process.
    """
    client = Client(name="C", email="assign@ex.com", api_key="k-assign", hashed_password="h")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key="bot-assign-test")
    db.add(bot)
    db.flush()
    taker = Operator(client_id=client.id, bot_id=bot.id, name="Taker", email="taker@ex.com")
    receiver = Operator(client_id=client.id, bot_id=bot.id, name="Receiver", email="recv@ex.com")
    db.add_all([taker, receiver])
    db.flush()
    db.add(
        ChatSession(
            id="sess-live",
            client_id=client.id,
            bot_id=bot.id,
            status="live",
            assigned_operator_id=taker.id,
        )
    )
    db.add(ChatSession(id="sess-bot", client_id=client.id, bot_id=bot.id, status="bot"))
    db.commit()

    @contextmanager
    def _fake_session():
        yield db

    monkeypatch.setattr(lcs, "get_session", _fake_session)
    mgr = lcs.ConnectionManager()
    assert mgr.assignments == {}
    return Ctx(mgr, taker.id, receiver.id)


class TestAssignmentResolution:
    def test_a_live_session_resolves_from_the_database(self, ctx):
        # The whole bug in one line: memory says nobody, the database says 4242.
        assert ctx.mgr._assigned_operator("sess-live", consult_db=True) == ctx.operator

    def test_the_result_is_cached(self, ctx):
        ctx.mgr._assigned_operator("sess-live", consult_db=True)
        assert ctx.mgr.assignments["sess-live"] == ctx.operator

    def test_a_bot_session_resolves_to_nobody(self, ctx):
        # Not merely "no operator assigned": status is not live, so even a
        # stale assigned_operator_id must not route anywhere.
        assert ctx.mgr._assigned_operator("sess-bot", consult_db=True) is None

    def test_an_unknown_session_resolves_to_nobody(self, ctx):
        assert ctx.mgr._assigned_operator("no-such-session", consult_db=True) is None

    def test_the_database_is_not_consulted_unless_asked(self, ctx, monkeypatch):
        """The opt-in is a load guard, not a style choice.

        Most sessions on the platform are bot-only and will never have an
        operator, so a lookup on every miss would put a query behind every
        keystroke. If this ever becomes unconditional, that regression is
        invisible in staging and expensive in production.
        """

        def _explode():
            raise AssertionError("consulted the database on a cache miss")

        monkeypatch.setattr(lcs, "get_session", _explode)
        assert ctx.mgr._assigned_operator("sess-live") is None

    def test_a_lookup_failure_returns_none_rather_than_raising(self, ctx, monkeypatch):
        # This runs inside a WebSocket handler. An exception here takes the
        # socket down, which is worse than an undelivered frame.
        @contextmanager
        def _broken():
            raise RuntimeError("database is having a moment")
            yield  # pragma: no cover

        monkeypatch.setattr(lcs, "get_session", _broken)
        assert ctx.mgr._assigned_operator("sess-live", consult_db=True) is None


class TestVisitorMessageDelivery:
    @staticmethod
    def _capture(mgr, monkeypatch, *, landed: bool):
        """Stand in for the backplane, recording what it was asked to deliver."""
        sent: list[tuple[int, dict]] = []

        async def _deliver(manager, operator_id, payload):
            assert manager is mgr
            sent.append((operator_id, payload))
            return landed

        monkeypatch.setattr(ws_backplane, "deliver_to_operator", _deliver)
        return sent

    def test_a_message_reaches_an_operator_assigned_in_another_process(self, ctx, monkeypatch):
        sent = self._capture(ctx.mgr, monkeypatch, landed=True)
        delivered = asyncio.run(ctx.mgr.route_visitor_message("sess-live", "hello", db_id=1, session_status="live"))
        assert delivered is True
        assert [op for op, _ in sent] == [ctx.operator]
        assert sent[0][1]["content"] == "hello"

    def test_delivery_does_not_require_a_local_socket(self, ctx, monkeypatch):
        """The removed gate, stated as behaviour.

        ``operator_connections`` is empty here, as it is in the API process for
        an operator connected to the WS process. The old code read that as "no
        operator" and returned False without ever reaching the backplane.
        """
        assert ctx.mgr.operator_connections == {}
        sent = self._capture(ctx.mgr, monkeypatch, landed=True)
        assert asyncio.run(ctx.mgr.route_visitor_message("sess-live", "hi", session_status="live"))
        assert len(sent) == 1

    def test_a_bot_session_delivers_nowhere_and_asks_nothing(self, ctx, monkeypatch):
        sent = self._capture(ctx.mgr, monkeypatch, landed=True)
        assert asyncio.run(ctx.mgr.route_visitor_message("sess-bot", "hi", session_status="bot")) is False
        assert sent == []

    def test_an_undeliverable_message_is_queued_for_the_grace_period(self, ctx, monkeypatch):
        sent = self._capture(ctx.mgr, monkeypatch, landed=False)
        ctx.mgr._operator_disconnect_tasks[ctx.operator] = object()
        delivered = asyncio.run(ctx.mgr.route_visitor_message("sess-live", "still here?", session_status="live"))
        assert delivered is False
        assert len(sent) == 1  # it was attempted before being queued
        queued = ctx.mgr._operator_message_queue[ctx.operator]
        assert [m["content"] for m in queued] == ["still here?"]

    def test_a_file_reaches_an_operator_in_another_process(self, ctx, monkeypatch):
        sent = self._capture(ctx.mgr, monkeypatch, landed=True)
        delivered = asyncio.run(ctx.mgr.route_visitor_file("sess-live", "https://r2/x.pdf", "x.pdf", "application/pdf"))
        assert delivered is True
        assert sent[0][1]["filename"] == "x.pdf"


class TestTranslationFrame:
    def test_the_translation_frame_resolves_the_operator_from_the_database(self, ctx, monkeypatch):
        """The frame that carries a Hindi visitor's words to an English operator.

        It was gated on the same empty map, so operator translation could not
        work in the split topology no matter how well the translation itself
        performed.
        """
        sent: list[tuple[int, dict]] = []

        async def _send(operator_id, payload):
            sent.append((operator_id, payload))

        monkeypatch.setattr(ctx.mgr, "_send_to_operator", _send)
        asyncio.run(
            ctx.mgr.send_translation_to_operator("sess-live", {"type": "message_translation", "language": "en"})
        )
        assert sent == [(ctx.operator, {"type": "message_translation", "language": "en"})]


class TestReconciliation:
    def test_a_transfer_made_elsewhere_is_re_synced(self, ctx, db):
        """Caching an assignment is only safe if a moved chat gets corrected.

        A transfer performed in the API process updates that process's map. The
        WS process would otherwise keep delivering to whoever accepted first,
        which is a message going to the wrong person, not merely a lost one.
        """
        ctx.mgr._assigned_operator("sess-live", consult_db=True)
        assert ctx.mgr.assignments["sess-live"] == ctx.operator

        db.query(ChatSession).filter_by(id="sess-live").update({"assigned_operator_id": ctx.other})
        db.commit()

        ctx.mgr._cleanup_stale_entries()
        assert ctx.mgr.assignments["sess-live"] == ctx.other

    def test_a_closed_session_is_still_dropped(self, ctx, db):
        ctx.mgr._assigned_operator("sess-live", consult_db=True)
        db.query(ChatSession).filter_by(id="sess-live").update({"status": "closed"})
        db.commit()

        ctx.mgr._cleanup_stale_entries()
        assert "sess-live" not in ctx.mgr.assignments
