"""CAS session transitions for the WS close paths + live queue size (audit F31, F33).

F31 — the ``leave_queue`` / ``visitor_end_chat`` / ``close_chat`` WS handlers
mutated ``ChatSession.status`` with a plain read-then-write, bypassing the
CAS-protected state machine. An operator accept (``waiting → live`` via a
guarded UPDATE) interleaving with a visitor's leave-queue write could be
silently clobbered back to ``bot`` — operator chatting into a dead session.
The handlers now route through module-level helpers that call
``transition_session`` with ``expected_current`` (row-locked CAS + audit log).

F33 — ``_current_queue_size`` counted ``LiveChatQueueEntry`` rows, but no code
path ever populates that table, so QUEUE_FULL protection (and real queue
positions) were permanently dead. It now counts ``waiting`` ChatSessions —
the state every handoff/accept/timeout path actually maintains — with a
staleness bound so crash-orphaned rows can't brick the queue.
"""

import os
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db.models import ChatAuditLog, ChatSession, Client, Operator
from app.services import session_state_machine as ssm
from app.services.session_state_machine import InvalidTransitionError, transition_session

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture
def wired(db, monkeypatch):
    """Point the state machine's own session factory at the test DB."""
    from contextlib import contextmanager

    @contextmanager
    def _ctx():
        yield db

    monkeypatch.setattr(ssm, "get_session", _ctx)
    return db


def _mk_session(db, sid, status, **kw):
    cs = ChatSession(id=sid, status=status, **kw)
    db.add(cs)
    db.commit()
    return cs


def _audit_actions(db, sid):
    return [
        a.action
        for a in db.execute(select(ChatAuditLog).where(ChatAuditLog.session_id == sid).order_by(ChatAuditLog.id))
        .scalars()
        .all()
    ]


# ── transition_session CAS semantics ─────────────────────────────────────────


def test_cas_rejects_when_already_at_target_but_expected_state_lost(wired):
    # The session is ALREADY 'bot' (e.g. a timeout fired first). A CAS that
    # expected 'waiting' must FAIL, not short-circuit as idempotent success —
    # callers key side effects (system message, close broadcast) off success.
    _mk_session(wired, "cas-1", "bot")
    with pytest.raises(InvalidTransitionError):
        transition_session("cas-1", "bot", expected_current="waiting", audit_action="visitor_left_queue")
    assert _audit_actions(wired, "cas-1") == []


def test_cas_succeeds_from_expected_state_and_audits(wired):
    _mk_session(wired, "cas-2", "waiting")
    assert transition_session("cas-2", "bot", expected_current="waiting", audit_action="visitor_left_queue") == "bot"
    assert wired.get(ChatSession, "cas-2").status == "bot"
    assert _audit_actions(wired, "cas-2") == ["visitor_left_queue"]


def test_cas_rejects_after_operator_accept_won_the_race(wired):
    # Operator accept committed waiting→live; the visitor's stale leave-queue
    # write must not clobber the live chat back to bot (the F31 lost update).
    _mk_session(wired, "cas-3", "live", assigned_operator_id=None)
    with pytest.raises(InvalidTransitionError):
        transition_session("cas-3", "bot", expected_current="waiting", audit_action="visitor_left_queue")
    assert wired.get(ChatSession, "cas-3").status == "live"


# ── WS handler helpers route through the CAS ─────────────────────────────────


def test_leave_queue_helper_flips_waiting_and_reports_race_loss(wired):
    from app.api import ws_routes

    _mk_session(wired, "lq-1", "waiting")
    assert ws_routes._leave_queue_transition("lq-1") is True
    assert wired.get(ChatSession, "lq-1").status == "bot"
    assert _audit_actions(wired, "lq-1") == ["visitor_left_queue"]

    _mk_session(wired, "lq-2", "live")  # accept won — leave_queue must lose
    assert ws_routes._leave_queue_transition("lq-2") is False
    assert wired.get(ChatSession, "lq-2").status == "live"


def test_visitor_end_helper_only_ends_live_chats(wired):
    from app.api import ws_routes

    _mk_session(wired, "ve-1", "live")
    assert ws_routes._visitor_end_transition("ve-1") is True
    assert wired.get(ChatSession, "ve-1").status == "bot"
    assert _audit_actions(wired, "ve-1") == ["visitor_ended_chat"]

    _mk_session(wired, "ve-2", "waiting")  # not live → no side effects
    assert ws_routes._visitor_end_transition("ve-2") is False
    assert wired.get(ChatSession, "ve-2").status == "waiting"


def test_operator_close_helper_never_resurrects_closed_sessions(wired):
    from app.api import ws_routes

    from app.db.models import Bot

    c = Client(name="W", email="cas-op@test.example", api_key="key-cas-op")
    wired.add(c)
    wired.flush()
    # ``Operator.bot_id`` is NOT NULL — seed a bot in the workspace and bind
    # the operator to it. The test's close-transition path doesn't inspect
    # the binding; the FK constraint is the only reason we need it here.
    b = Bot(client_id=c.id, name="B", bot_key="bot-cas-op")
    wired.add(b)
    wired.flush()
    op = Operator(client_id=c.id, bot_id=b.id, name="Op", email="op@test.example")
    wired.add(op)
    wired.commit()

    _mk_session(wired, "oc-1", "live", assigned_operator_id=op.id)
    assert ws_routes._operator_close_transition("oc-1", op.id) is True
    cs = wired.get(ChatSession, "oc-1")
    assert cs.status == "bot"
    assert cs.assigned_operator_id is None
    assert _audit_actions(wired, "oc-1") == ["closed"]

    # Old code set closed→bot unconditionally, resurrecting terminal sessions.
    _mk_session(wired, "oc-2", "closed")
    assert ws_routes._operator_close_transition("oc-2", op.id) is False
    assert wired.get(ChatSession, "oc-2").status == "closed"


# ── F33: queue size derives from waiting sessions ────────────────────────────


def test_queue_size_counts_waiting_sessions_for_the_bot(db):
    from app.db.models import Bot
    from app.services.live_chat_availability_service import _current_queue_size

    c = Client(name="Q", email="qsize@test.example", api_key="key-qsize")
    db.add(c)
    db.flush()
    b1 = Bot(client_id=c.id, name="B1", bot_key="bot-qsize-1")
    b2 = Bot(client_id=c.id, name="B2", bot_key="bot-qsize-2")
    db.add_all([b1, b2])
    db.flush()

    _mk_session(db, "qs-1", "waiting", bot_id=b1.id, client_id=c.id)
    _mk_session(db, "qs-2", "waiting", bot_id=b1.id, client_id=c.id)
    _mk_session(db, "qs-3", "live", bot_id=b1.id, client_id=c.id)  # not queued
    _mk_session(db, "qs-4", "waiting", bot_id=b2.id, client_id=c.id)  # other bot

    assert _current_queue_size(b1.id, db) == 2
    assert _current_queue_size(b2.id, db) == 1


def test_queue_size_ignores_crash_orphaned_stale_waiting_rows(db):
    from app.db.models import Bot
    from app.services.live_chat_availability_service import _current_queue_size

    c = Client(name="Q2", email="qstale@test.example", api_key="key-qstale")
    db.add(c)
    db.flush()
    b = Bot(client_id=c.id, name="B", bot_key="bot-qstale")
    db.add(b)
    db.flush()

    _mk_session(db, "st-1", "waiting", bot_id=b.id, client_id=c.id)
    stale = _mk_session(db, "st-2", "waiting", bot_id=b.id, client_id=c.id)
    stale.last_active_at = datetime.now(UTC) - timedelta(hours=3)
    db.commit()

    # A row abandoned hours ago (crashed worker, lost timeout task) must not
    # count toward QUEUE_FULL — that would permanently push visitors to the
    # offline form.
    assert _current_queue_size(b.id, db) == 1
