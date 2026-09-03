"""The BANT merge must be serialised, and must notify only after it commits.

Audit R4: two turns of the same conversation can finish extraction at the same
time on the shared thread pool. Both read the same ``dimension_scores`` and the
same ``old_tier``, so one silently overwrote the other's dimensions and both
fired the ``tier_transition`` webhook and the qualified-lead email. The
notifications also went out BEFORE the commit, so a rollback announced a
transition that never happened.

Audit R1: the post-commit operator-console broadcast used ``asyncio.run`` when
no loop was running. That closes the temporary loop (and the backplane's Redis
publisher built on it) and writes to sockets owned by the main loop.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import contextmanager

import pytest
from sqlalchemy import event

from app.db.models import Bot, ChatSession, Client
from app.services import rag_service as rs

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="BANT merge tests need a reachable Postgres at DB_URL",
)

_CONFIG = {
    "framework": "bant",
    "budget": {"weight": 25, "options": [{"label": "big", "score": 10}]},
    "authority": {"weight": 25, "options": [{"label": "owner", "score": 10}]},
    "need": {"weight": 25, "options": [{"label": "urgent", "score": 10}]},
    "timeline": {"weight": 25, "options": [{"label": "now", "score": 10}]},
}


def _signal(dimension):
    return {
        "dimension": dimension,
        "score": 10,
        "signal_text": f"visitor described {dimension}",
        "extracted_value": dimension.upper(),
        "confidence": 0.9,
    }


@pytest.fixture()
def wired(db, monkeypatch):
    client = Client(name="W", email="bant@ex.com", api_key="k-bant", hashed_password="h")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key="bot-bant-merge", name="B", email_on_qualified=True)
    db.add(bot)
    db.flush()
    db.add(ChatSession(id="sess-bant", client_id=client.id, bot_id=bot.id, status="bot"))
    db.commit()

    @contextmanager
    def _fake_session():
        yield db

    monkeypatch.setattr(rs, "get_session", _fake_session)
    monkeypatch.setattr(
        rs,
        "extract_qualification_signals",
        lambda *a, **k: [_signal(d) for d in ("budget", "authority", "need", "timeline")],
    )

    from app.services import email_service, webhook_service

    monkeypatch.setattr(email_service, "get_notification_recipients", lambda bot, kind: ["ops@ex.com"])

    events: list[str] = []
    real_commit = db.commit

    def _tracked_commit():
        events.append("commit")
        return real_commit()

    monkeypatch.setattr(db, "commit", _tracked_commit)
    monkeypatch.setattr(rs, "send_qualified_lead_email", lambda *a, **k: events.append("email"))
    monkeypatch.setattr(webhook_service, "fire_webhook", lambda *a, **k: events.append("webhook"))

    return client, bot, events


def _run_extraction(bot, client):
    rs._background_bant_extraction(
        "sess-bant",
        client.id,
        bot.id,
        "",
        "we need this now, I sign the cheques, budget is big",
        "Great, let's talk.",
        {},
        bot.id,
        _CONFIG,
        None,
    )


def test_tier_transition_is_announced_only_after_the_commit(db, wired):
    client, bot, events = wired

    _run_extraction(bot, client)

    cs = db.get(ChatSession, "sess-bant")
    assert cs.bant_tier == "sql"
    assert events, "the merge must commit and notify"
    assert events.index("commit") < events.index("email"), "email must not precede the commit"
    assert events.index("commit") < events.index("webhook"), "webhook must not precede the commit"


def test_the_session_row_is_locked_for_the_merge(db, wired):
    client, bot, _events = wired
    statements: list[str] = []
    engine = db.get_bind()

    def _record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", _record)
    try:
        _run_extraction(bot, client)
    finally:
        event.remove(engine, "before_cursor_execute", _record)

    locking = [s for s in statements if "FROM chat_sessions" in s and "FOR UPDATE" in s]
    assert locking, "the chat_sessions row must be selected FOR UPDATE for the read-modify-write"


def test_the_operator_broadcast_never_runs_on_a_throwaway_loop(db, wired, monkeypatch):
    client, bot, _events = wired

    ran: list = []

    def _spy_run(coro, *args, **kwargs):
        # Record instead of raising: the broadcast is wrapped in a broad
        # ``except Exception`` that would swallow an assertion raised here.
        ran.append(coro)
        coro.close()

    monkeypatch.setattr(asyncio, "run", _spy_run)

    # No loop is bound (this is exactly the ARQ / thread-pool situation), so the
    # broadcast is skipped rather than improvised, and the merge still commits.
    _run_extraction(bot, client)

    cs = db.get(ChatSession, "sess-bant")
    assert cs.bant_tier == "sql"
    assert ran == [], "the broadcast must not be driven by asyncio.run from a pool thread"
