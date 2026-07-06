"""Operator-presence DB fallback when Redis is unavailable (audit F08).

``get_online_operator_ids`` read only Redis and returned an empty set on any
failure (Redis unset or a mid-op error). Since availability routing treats an
empty set as ALL_OFFLINE, a brief Redis blip made *every* workspace report no
operators online platform-wide. It must fall back to ``Operator.last_seen_at``
freshness (DB), scoped to the workspace.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Client, Operator
from app.services import operator_presence_service as presence

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="presence DB-fallback test needs a reachable Postgres at DB_URL",
)


def test_get_online_operator_ids_falls_back_to_db_when_redis_down(db, monkeypatch):
    client_a = Client(name="A", email="a@ex.com", api_key="ka", hashed_password="h")
    client_b = Client(name="B", email="b@ex.com", api_key="kb", hashed_password="h")
    db.add_all([client_a, client_b])
    db.flush()

    now = datetime.now(UTC)
    fresh = Operator(client_id=client_a.id, name="Fresh", email="f@ex.com", last_seen_at=now)
    stale = Operator(
        client_id=client_a.id,
        name="Stale",
        email="s@ex.com",
        last_seen_at=now - timedelta(seconds=presence.DB_FALLBACK_FRESHNESS_SECONDS + 60),
    )
    other = Operator(client_id=client_b.id, name="Other", email="o@ex.com", last_seen_at=now)
    db.add_all([fresh, stale, other])
    db.commit()

    # Simulate Redis being unavailable and route the fallback's session to the
    # throwaway test DB.
    monkeypatch.setattr(presence, "get_redis", lambda: None)

    import app.db.session as db_session

    @contextmanager
    def _fake_session():
        yield db

    monkeypatch.setattr(db_session, "get_session", _fake_session)

    online = presence.get_online_operator_ids(client_a.id)

    # Only the fresh operator of client A — not the stale one, not client B's.
    assert online == {fresh.id}
