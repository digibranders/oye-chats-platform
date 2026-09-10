"""The workspace owner's own self-operator row cannot be demoted.

When the account holder joins live chat, ``POST /me/self-operator`` mints an
``Operator`` row with ``role='owner'`` and ``linked_client_id == client.id``.
That row *is* the workspace owner; demoting it to admin or operator would leave
the workspace with no owner among its operators. The admin console hides every
role but Owner for this row (``MemberDialog``/``roles.assignableRoles``), and
``PATCH /operators/{id}`` enforces the same rule server-side. This file covers
the server guard, since the UI restriction is not a security boundary.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.core.rate_limit import limiter
from app.db.models import Bot, Client, Operator

pytestmark = pytest.mark.skipif(
    os.getenv("DB_URL") is None,
    reason="operator route tests need a reachable Postgres at DB_URL",
)

_seq = iter(range(700_000, 800_000))


@contextmanager
def _session_cm(session):
    yield session


def _make_client(db) -> Client:
    n = next(_seq)
    c = Client(
        name=f"Owner {n}",
        email=f"owner{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"api-key-{n}",
        is_verified=True,
    )
    db.add(c)
    db.commit()
    return c


def _make_bot(db, owner) -> Bot:
    n = next(_seq)
    bot = Bot(client_id=owner.id, bot_key=f"bot-owner-lock-{n}", name="Lock Bot")
    db.add(bot)
    db.commit()
    return bot


def _make_operator(db, owner, bot, *, role, linked_client_id=None) -> Operator:
    n = next(_seq)
    op = Operator(
        client_id=owner.id,
        bot_id=bot.id,
        name=f"Op {n}",
        email=f"op{n}@example.com",
        role=role,
        linked_client_id=linked_client_id,
        operator_api_key=f"op-key-{n}",
        max_concurrent_chats=3,
    )
    db.add(op)
    db.commit()
    return op


def _build_app(db, *, actor: Client) -> FastAPI:
    from app.api import auth, operator_routes

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(operator_routes.router)
    app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": actor,
        "client_id": actor.id,
        "operator_id": None,
        "linked_client_id": None,
    }
    return app


@contextmanager
def _routed(db, app):
    from app.api import auth, operator_routes

    with (
        patch.object(operator_routes, "get_session", lambda: _session_cm(db)),
        patch.object(auth, "get_session", lambda: _session_cm(db)),
    ):
        yield TestClient(app, raise_server_exceptions=False)


def test_owner_self_operator_cannot_be_demoted(db):
    """PATCH the account holder's own owner row to a lower role → 403."""
    owner = _make_client(db)
    bot = _make_bot(db, owner)
    self_op = _make_operator(db, owner, bot, role="owner", linked_client_id=owner.id)

    app = _build_app(db, actor=owner)
    with _routed(db, app) as client:
        resp = client.patch(f"/operators/{self_op.id}", json={"role": "operator"})

    assert resp.status_code == 403, resp.text
    assert "owner" in resp.json()["detail"].lower()
    db.refresh(self_op)
    assert self_op.role == "owner"


def test_owner_self_operator_other_fields_still_save(db):
    """The lock is on the role only: capacity and department still update, and
    re-sending the unchanged owner role alongside them is not treated as a
    demotion attempt."""
    owner = _make_client(db)
    bot = _make_bot(db, owner)
    self_op = _make_operator(db, owner, bot, role="owner", linked_client_id=owner.id)

    app = _build_app(db, actor=owner)
    with _routed(db, app) as client:
        resp = client.patch(
            f"/operators/{self_op.id}",
            json={"role": "owner", "max_concurrent_chats": 7},
        )

    assert resp.status_code == 200, resp.text
    db.refresh(self_op)
    assert self_op.role == "owner"
    assert self_op.max_concurrent_chats == 7


def test_linked_seat_that_drifted_off_owner_can_only_return_to_owner(db):
    """A linked account seat is detected by the link, not its stored role: even
    one that has drifted to ``admin`` may not be set to a non-owner role, and
    setting it back to owner (the self-heal the console performs on save) is
    allowed."""
    owner = _make_client(db)
    bot = _make_bot(db, owner)
    drifted = _make_operator(db, owner, bot, role="admin", linked_client_id=owner.id)

    app = _build_app(db, actor=owner)
    with _routed(db, app) as client:
        blocked = client.patch(f"/operators/{drifted.id}", json={"role": "operator"})
        healed = client.patch(f"/operators/{drifted.id}", json={"role": "owner"})

    assert blocked.status_code == 403, blocked.text
    assert healed.status_code == 200, healed.text
    db.refresh(drifted)
    assert drifted.role == "owner"


def test_a_normal_operator_is_still_promotable(db):
    """The guard is scoped to the owner self-op row: an ordinary teammate can
    still be promoted, so the fix does not freeze every role edit."""
    owner = _make_client(db)
    bot = _make_bot(db, owner)
    teammate = _make_operator(db, owner, bot, role="operator")

    app = _build_app(db, actor=owner)
    with _routed(db, app) as client:
        resp = client.patch(f"/operators/{teammate.id}", json={"role": "admin"})

    assert resp.status_code == 200, resp.text
    db.refresh(teammate)
    assert teammate.role == "admin"
