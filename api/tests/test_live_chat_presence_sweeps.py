"""The periodic sweeps must not judge a multi-process deployment alone (audit R8).

``_fix_stale_online_flags`` and ``_recover_orphaned_sessions`` decide whether an
operator is really gone from this process's ``operator_connections`` dict. On a
host that runs ``oyechats-ws`` (or WEB_CONCURRENCY > 1), an operator connected
to a sibling process holds no socket here: every five minutes they were flipped
offline in the database and their live chats handed back to the queue. Redis
presence is the cross-process truth, so both sweeps consult it first.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest

from app.db.models import Bot, ChatSession, Client, Operator
from app.services import live_chat_service as lcs

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="presence sweep tests need a reachable Postgres at DB_URL",
)


def _workspace(db):
    client = Client(name="W", email="w@ex.com", api_key="kw", hashed_password="h")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key="bot-presence-sweep", name="B")
    db.add(bot)
    db.flush()
    return client, bot


def _patch_session(monkeypatch, db):
    @contextmanager
    def _fake_session():
        yield db

    monkeypatch.setattr(lcs, "get_session", _fake_session)


def test_operator_online_elsewhere_keeps_their_online_flag(db, monkeypatch):
    client, bot = _workspace(db)
    remote = Operator(client_id=client.id, bot_id=bot.id, name="Remote", email="remote@ex.com", is_online=True)
    gone = Operator(client_id=client.id, bot_id=bot.id, name="Gone", email="gone@ex.com", is_online=True)
    db.add_all([remote, gone])
    db.commit()

    _patch_session(monkeypatch, db)
    monkeypatch.setattr(lcs.presence, "get_online_operator_ids", lambda cid: {remote.id})

    mgr = lcs.ConnectionManager()
    mgr._fix_stale_online_flags()

    db.refresh(remote)
    db.refresh(gone)
    assert remote.is_online is True, "an operator holding a socket on another process is still online"
    assert gone.is_online is False, "an operator absent everywhere is still swept"


def test_live_chat_is_not_re_queued_when_the_operator_is_online_elsewhere(db, monkeypatch):
    client, bot = _workspace(db)
    remote = Operator(client_id=client.id, bot_id=bot.id, name="Remote", email="remote@ex.com", is_online=False)
    db.add(remote)
    db.flush()
    db.add(
        ChatSession(
            id="sess-remote-live",
            client_id=client.id,
            bot_id=bot.id,
            status="live",
            assigned_operator_id=remote.id,
        )
    )
    db.commit()

    _patch_session(monkeypatch, db)
    monkeypatch.setattr(lcs.presence, "get_online_operator_ids", lambda cid: {remote.id})

    mgr = lcs.ConnectionManager()
    mgr._recover_orphaned_sessions()

    cs = db.get(ChatSession, "sess-remote-live")
    assert cs.status == "live"
    assert cs.assigned_operator_id == remote.id


def test_live_chat_is_still_recovered_when_nobody_holds_the_operator(db, monkeypatch):
    client, bot = _workspace(db)
    gone = Operator(client_id=client.id, bot_id=bot.id, name="Gone", email="gone@ex.com", is_online=False)
    db.add(gone)
    db.flush()
    db.add(
        ChatSession(
            id="sess-orphan-live",
            client_id=client.id,
            bot_id=bot.id,
            status="live",
            assigned_operator_id=gone.id,
        )
    )
    db.commit()

    _patch_session(monkeypatch, db)
    monkeypatch.setattr(lcs.presence, "get_online_operator_ids", lambda cid: set())

    mgr = lcs.ConnectionManager()
    mgr._recover_orphaned_sessions()

    cs = db.get(ChatSession, "sess-orphan-live")
    assert cs.status == "bot"
    assert cs.assigned_operator_id is None
