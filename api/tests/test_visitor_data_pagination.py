"""get_visitor_data must be bounded and tenant-scoped (audit F26).

The query had no LIMIT, on a busy workspace it loads every ChatSession row into
memory for the dashboard. It must accept a bounded limit/offset and return the
most-recent sessions first, scoped to the caller's workspace.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest

from app.db.models import ChatSession, Client
from app.db.repository import get_visitor_data

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="visitor-data pagination test needs a reachable Postgres at DB_URL",
)


def test_get_visitor_data_is_bounded_and_recent_first(db):
    client = Client(name="A", email="a@ex.com", api_key="ka", hashed_password="h")
    other = Client(name="B", email="b@ex.com", api_key="kb", hashed_password="h")
    db.add_all([client, other])
    db.flush()

    # Three sessions for client A at increasing times, one for client B.
    for i in range(3):
        db.add(
            ChatSession(
                id=f"a-{i}",
                client_id=client.id,
                status="closed",
                created_at=datetime(2026, 1, 1 + i, 12, 0, tzinfo=UTC),
            )
        )
    db.add(ChatSession(id="b-0", client_id=other.id, status="closed", created_at=datetime(2026, 1, 5, tzinfo=UTC)))
    db.commit()

    page = get_visitor_data(db, client_id=client.id, limit=2)

    # Bounded to 2, most-recent first, and only client A's sessions.
    assert [v["session_id"] for v in page] == ["a-2", "a-1"]

    page2 = get_visitor_data(db, client_id=client.id, limit=2, offset=2)
    assert [v["session_id"] for v in page2] == ["a-0"]
