"""A queue-timeout task must never tear down a conversation it no longer owns.

``_timeout_handler`` guarded only on this process's ``waiting_queue`` and then
emitted ``{"status": "unavailable"}`` unconditionally, so two everyday sequences
killed a healthy chat:

* ``leave_queue`` wrote the database but left the session id in
  ``manager.waiting_queue`` and never cancelled the task, so the orphan fired
  minutes later at a visitor who was back in bot mode;
* across the two API workers ``/handoff`` starts the timer on worker 1 while
  ``/accept`` runs on worker 2, so ``_cancel_timeout`` cancels nothing and at
  t+120s a chat that had been live for ~110s was closed under the visitor.

The database CAS is the arbiter in both cases: it fails when the session has
already left ``waiting``, and a lost CAS must silence the notification.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import contextmanager

import pytest

from app.db.models import ChatSession
from app.services import live_chat_service as lcs
from app.services import session_state_machine as ssm

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture
def mgr(db, monkeypatch):
    @contextmanager
    def _ctx():
        yield db

    monkeypatch.setattr(lcs, "get_session", _ctx)
    monkeypatch.setattr(ssm, "get_session", _ctx)
    return lcs.ConnectionManager()


def _seed(db, sid: str, status: str) -> None:
    db.add(ChatSession(id=sid, status=status))
    db.commit()


def _visitor_frames(mgr, monkeypatch) -> list[dict]:
    frames: list[dict] = []

    async def _send(session_id, data):
        frames.append(data)

    monkeypatch.setattr(mgr, "_send_to_visitor", _send)
    return frames


# ── The CAS result has to be observable ──────────────────────────────────────


def test_the_waiting_exit_reports_whether_the_cas_won(mgr, db):
    _seed(db, "won", "waiting")
    _seed(db, "lost", "live")

    assert mgr._mark_session_waiting_exit("won") is True
    assert mgr._mark_session_waiting_exit("lost") is False
    assert db.get(ChatSession, "lost").status == "live"


# ── A timeout that lost the race must stay silent ────────────────────────────


def test_a_timeout_does_not_end_a_chat_another_worker_already_accepted(mgr, db, monkeypatch):
    """``/accept`` ran on the other worker; this timer must not fire at all."""
    _seed(db, "accepted-elsewhere", "live")
    mgr.waiting_queue.append("accepted-elsewhere")
    frames = _visitor_frames(mgr, monkeypatch)

    asyncio.run(mgr._timeout_handler("accepted-elsewhere", 0))

    assert frames == [], "a live conversation must not be told the workspace is unavailable"
    assert db.get(ChatSession, "accepted-elsewhere").status == "live"


def test_a_timeout_still_ends_a_session_that_is_genuinely_still_waiting(mgr, db, monkeypatch):
    _seed(db, "really-waiting", "waiting")
    mgr.waiting_queue.append("really-waiting")
    frames = _visitor_frames(mgr, monkeypatch)

    asyncio.run(mgr._timeout_handler("really-waiting", 0))

    assert [f["status"] for f in frames] == ["unavailable"]
    assert db.get(ChatSession, "really-waiting").status == "bot"


# ── leave_queue must not leave an orphan behind ──────────────────────────────


def test_leaving_the_queue_drops_the_local_entry_and_kills_the_timer(mgr, monkeypatch):
    from app.api import ws_routes

    monkeypatch.setattr(ws_routes, "manager", mgr)

    async def _run():
        mgr.waiting_queue.append("bailed")
        mgr._start_timeout("bailed", 3600)
        task = mgr._timeout_tasks["bailed"]
        ws_routes._drop_from_local_queue("bailed")
        await asyncio.sleep(0)
        return task

    task = asyncio.run(_run())

    assert "bailed" not in mgr.waiting_queue
    assert "bailed" not in mgr._timeout_tasks
    assert task.cancelled() or task.done()


def test_a_repeated_handoff_does_not_push_the_visitors_deadline_out(mgr, monkeypatch):
    """The widget re-requests a handoff every 15s while the visitor waits.

    ``_start_timeout`` cancels and re-creates, so restarting it on every poll
    moved the deadline out by a full window each time and the fallback to the
    offline form could never fire.
    """
    _visitor_frames(mgr, monkeypatch)

    async def _run():
        await mgr.request_handoff("repoll", timeout_seconds=3600, notify_operators=False)
        first = mgr._timeout_tasks["repoll"]
        await mgr.request_handoff("repoll", timeout_seconds=3600, notify_operators=False)
        second = mgr._timeout_tasks["repoll"]
        mgr._cancel_timeout("repoll")
        return first, second

    first, second = asyncio.run(_run())

    assert first is second
