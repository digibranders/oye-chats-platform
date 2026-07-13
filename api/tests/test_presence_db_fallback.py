"""Operator-presence DB fallback when Redis is unavailable (audit F08).

``get_online_operator_ids`` read only Redis and returned an empty set on any
failure (Redis unset or a mid-op error). Since availability routing treats an
empty set as ALL_OFFLINE, a brief Redis blip made *every* workspace report no
operators online platform-wide. It must fall back to the ``Operator.is_online``
column — the online flag actually maintained in the DB (set on WS connect,
cleared on disconnect) — scoped to the workspace.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest

from app.db.models import Bot, Client, Operator
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

    # Every operator is bound to exactly one bot (``Operator.bot_id`` NOT
    # NULL — see migration ``b1c7e9d3f2a5_operator_bot_one_to_one``). The
    # test doesn't exercise the binding directly, but the FK constraint
    # forces us to seed a bot per workspace so the inserts don't blow up.
    bot_a = Bot(client_id=client_a.id, bot_key="bot-a", name="Bot A", system_prompt="")
    bot_b = Bot(client_id=client_b.id, bot_key="bot-b", name="Bot B", system_prompt="")
    db.add_all([bot_a, bot_b])
    db.flush()

    # Production truth: operator online-ness in the DB is tracked by the
    # is_online column (set True on WS connect, cleared on disconnect /
    # _fix_stale_online_flags). last_seen_at is NOT maintained, so the fallback
    # must key on is_online.
    online = Operator(client_id=client_a.id, bot_id=bot_a.id, name="Online", email="f@ex.com", is_online=True)
    offline = Operator(client_id=client_a.id, bot_id=bot_a.id, name="Offline", email="s@ex.com", is_online=False)
    other = Operator(client_id=client_b.id, bot_id=bot_b.id, name="Other", email="o@ex.com", is_online=True)
    db.add_all([online, offline, other])
    db.commit()

    # Simulate Redis being unavailable and route the fallback's session to the
    # throwaway test DB.
    monkeypatch.setattr(presence, "get_redis", lambda: None)

    import app.db.session as db_session

    @contextmanager
    def _fake_session():
        yield db

    monkeypatch.setattr(db_session, "get_session", _fake_session)

    result_ids = presence.get_online_operator_ids(client_a.id)

    # Only the online operator of client A — not the offline one, not client B's.
    assert result_ids == {online.id}
