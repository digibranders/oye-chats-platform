"""Tenant isolation must survive a server restart (code-review RV1 / audit F03).

``_recover_orphaned_sessions`` restores every ``status='waiting'`` ChatSession
from ALL tenants into the shared in-memory ``waiting_queue`` on startup. If it
doesn't also populate ``_session_client_ids``, the F03 queue guard
(``session_client_id is None`` → treated as unscoped) fails open, so a restored
tenant-B session shows up in tenant-A's operator queue, the exact cross-tenant
leak F03 closed, re-exposed on every deploy (F05 restarts services).
"""

from __future__ import annotations

import asyncio
import os
from contextlib import contextmanager

import pytest

from app.db.models import ChatSession, Client
from app.services import live_chat_service as lcs

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="recovery-isolation test needs a reachable Postgres at DB_URL",
)


def test_recovered_waiting_sessions_are_tenant_scoped(db, monkeypatch):
    client_a = Client(name="A", email="a@ex.com", api_key="ka", hashed_password="h")
    client_b = Client(name="B", email="b@ex.com", api_key="kb", hashed_password="h")
    db.add_all([client_a, client_b])
    db.flush()

    # A waiting session owned by client B, as it would sit in the DB across a restart.
    db.add(ChatSession(id="sess-b", client_id=client_b.id, status="waiting"))
    db.commit()

    @contextmanager
    def _fake_session():
        yield db

    monkeypatch.setattr(lcs, "get_session", _fake_session)

    mgr = lcs.ConnectionManager()
    mgr._recover_orphaned_sessions()

    # The restored session must carry its owning client_id.
    assert mgr._session_client_ids.get("sess-b") == client_b.id

    # And it must not surface in a different tenant's operator queue.
    mgr._operator_client_ids = {10: client_a.id, 20: client_b.id}
    captured: dict[int, dict] = {}

    async def _fake_send(operator_id, data):
        captured[operator_id] = data

    mgr._send_to_operator = _fake_send
    asyncio.run(mgr._notify_operator_queue(10))  # client-A operator
    asyncio.run(mgr._notify_operator_queue(20))  # client-B operator

    assert captured[10]["waiting"] == []
    assert [w["session_id"] for w in captured[20]["waiting"]] == ["sess-b"]
