"""get_feedback_data must not issue one query per feedback row (audit F28).

The old code ran a separate SELECT for each bot message to find its preceding
user question — N+1 round-trips. The preceding question must be resolved in the
same query so the count stays constant as feedback grows.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest
from sqlalchemy import event

from app.db.models import ChatMessage, ChatSession, Client
from app.db.repository import get_feedback_data

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="feedback N+1 test needs a reachable Postgres at DB_URL",
)


def _seed_feedback(db, client_id, sid, question, answer, t0):
    db.add(ChatSession(id=sid, client_id=client_id, status="closed"))
    db.add(ChatMessage(session_id=sid, role="user", content=question, created_at=t0))
    db.add(
        ChatMessage(
            session_id=sid,
            role="bot",
            content=answer,
            feedback=1,
            created_at=datetime(t0.year, t0.month, t0.day, 12, 1, tzinfo=UTC),
        )
    )


def test_get_feedback_data_is_single_query_and_correct(db):
    client = Client(name="A", email="a@ex.com", api_key="ka", hashed_password="h")
    db.add(client)
    db.flush()
    cid = client.id  # capture before commit so reading it later can't reload (skews the query count)

    _seed_feedback(db, cid, "s1", "Q1?", "A1", datetime(2026, 1, 1, 12, 0, tzinfo=UTC))
    _seed_feedback(db, cid, "s2", "Q2?", "A2", datetime(2026, 1, 2, 12, 0, tzinfo=UTC))
    _seed_feedback(db, cid, "s3", "Q3?", "A3", datetime(2026, 1, 3, 12, 0, tzinfo=UTC))
    db.commit()

    engine = db.get_bind()
    n = {"queries": 0}

    def _count(*_args):
        n["queries"] += 1

    event.listen(engine, "before_cursor_execute", _count)
    try:
        result = get_feedback_data(db, client_id=cid)
    finally:
        event.remove(engine, "before_cursor_execute", _count)

    assert len(result) == 3
    # Correct question resolved for each feedback row.
    by_answer = {r["answer"]: r["question"] for r in result}
    assert by_answer == {"A1": "Q1?", "A2": "Q2?", "A3": "Q3?"}
    # No N+1: a single query regardless of row count (was 1 + 3 = 4 before).
    assert n["queries"] == 1, f"expected 1 query, got {n['queries']} (N+1 regression)"
