"""``GET /operators/me/waiting-count`` — the number behind the rail's Inbox badge.

The badge used to derive that number in the frontend, from the notifications
feed: every unread ``handoff_request`` row. That is a pile of history, not a
queue. Notifications stay unread until somebody clears them, so a console
showed "6" beside Inbox for visitors who had asked for a person weeks earlier
and long since left — on the same screen where the inbox itself said
``Waiting (0)``.

So the case that matters most here is ``test_unread_handoff_notifications_do_not_count``:
the two numbers must not be able to disagree again.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Bot, ChatSession, Client, Notification, Operator

pytestmark = pytest.mark.skipif(
    os.getenv("DB_URL") is None,
    reason="waiting-count route tests need a reachable Postgres at DB_URL",
)

_seq = iter(range(700_000, 800_000))


@contextmanager
def _session_cm(session):
    yield session


def _make_workspace(db) -> tuple[Client, Bot, Operator]:
    """An owner who is also their own operator — the common single-seat setup."""
    n = next(_seq)
    owner = Client(
        name=f"Owner {n}",
        email=f"owner{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"api-key-{n}",
        is_verified=True,
    )
    db.add(owner)
    db.commit()

    bot = Bot(client_id=owner.id, bot_key=f"bot-wait-{n}", name="Waiting Bot")
    db.add(bot)
    db.commit()

    operator = Operator(
        client_id=owner.id,
        bot_id=bot.id,
        name=f"Owner {n}",
        email=owner.email,
        role="owner",
        is_active=True,
        linked_client_id=owner.id,
        operator_api_key=f"op-key-{n}",
    )
    db.add(operator)
    db.commit()
    return owner, bot, operator


def _seed_session(db, owner, bot, *, status: str) -> ChatSession:
    n = next(_seq)
    chat = ChatSession(
        id=f"sess-{n}",
        client_id=owner.id,
        bot_id=bot.id,
        status=status,
    )
    db.add(chat)
    db.commit()
    return chat


def _seed_handoff_notification(db, owner, *, is_read: bool = False) -> Notification:
    notification = Notification(
        client_id=owner.id,
        type="handoff_request",
        title="A visitor asked for a person",
        is_read=is_read,
    )
    db.add(notification)
    db.commit()
    return notification


def _build_app(actor: Client) -> FastAPI:
    from app.api import auth, operator_routes

    app = FastAPI()
    app.include_router(operator_routes.router)
    app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": actor,
        "client_id": actor.id,
        "operator_id": None,
    }
    return app


@contextmanager
def _routed(db, app):
    """Point every ``get_session()`` in the request path at the test session.

    ``live_chat_service`` is in that list: the route resolves the operator
    itself but the queue is built inside ``_visible_queue_for_operator``, which
    opens its own session.
    """
    from app.api import auth, operator_routes
    from app.services import live_chat_service

    with (
        patch.object(operator_routes, "get_session", lambda: _session_cm(db)),
        patch.object(auth, "get_session", lambda: _session_cm(db)),
        patch.object(live_chat_service, "get_session", lambda: _session_cm(db)),
    ):
        yield TestClient(app, raise_server_exceptions=False)


def _count(db, owner) -> int:
    with _routed(db, _build_app(owner)) as api:
        response = api.get("/operators/me/waiting-count")
        assert response.status_code == 200, response.text
        return response.json()["count"]


def test_counts_the_visitors_actually_waiting(db):
    owner, bot, _ = _make_workspace(db)
    _seed_session(db, owner, bot, status="waiting")
    _seed_session(db, owner, bot, status="waiting")

    assert _count(db, owner) == 2


def test_ignores_conversations_that_are_no_longer_waiting(db):
    # `waiting` is the only status that means "nobody has taken this yet".
    owner, bot, _ = _make_workspace(db)
    _seed_session(db, owner, bot, status="waiting")
    for status in ("live", "closed", "bot"):
        _seed_session(db, owner, bot, status=status)

    assert _count(db, owner) == 1


def test_unread_handoff_notifications_do_not_count(db):
    """The defect this endpoint exists to fix.

    Six unread handoff notifications and nobody waiting must read as zero. The
    old badge read the notifications feed and said six.
    """
    owner, bot, _ = _make_workspace(db)
    for _ in range(6):
        _seed_handoff_notification(db, owner)
    _seed_session(db, owner, bot, status="closed")

    assert _count(db, owner) == 0


def test_does_not_count_another_workspaces_queue(db):
    # The queue is partitioned by client_id (audit F03); a badge that leaked
    # across tenants would leak the fact of another company's traffic.
    owner, _, _ = _make_workspace(db)
    other_owner, other_bot, _ = _make_workspace(db)
    _seed_session(db, other_owner, other_bot, status="waiting")

    assert _count(db, owner) == 0
    assert _count(db, other_owner) == 1


def test_a_caller_with_no_operator_profile_reads_zero(db):
    """Not a 404. "How many are waiting for me" has an answer for someone who
    takes no chats, and it is none."""
    n = next(_seq)
    owner = Client(
        name=f"Seatless {n}",
        email=f"seatless{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"api-key-{n}",
        is_verified=True,
    )
    db.add(owner)
    db.commit()

    assert _count(db, owner) == 0
