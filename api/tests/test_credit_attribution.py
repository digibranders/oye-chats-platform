"""`attributed_bot_id`, which bot spent the credits, independent of scope.

`bot_id` is the SCOPE key (NULL = shared client pool) and balance maths keys
off it. This column is for reporting only and must never affect a balance.

The write-path tests below run against the real-Postgres ``db`` fixture and
skip without ``DB_URL``.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.models import Bot, Client, CreditLedger
from app.services import credit_service

needs_db = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="attribution write-path tests need a reachable Postgres at DB_URL",
)


def test_ledger_has_attributed_bot_id_column():
    assert hasattr(CreditLedger, "attributed_bot_id")


def test_attributed_bot_id_is_nullable_and_indexed():
    col = CreditLedger.__table__.columns["attributed_bot_id"]
    assert col.nullable is True
    assert col.index is True


# ── helpers ──────────────────────────────────────────────────────────────────


@contextmanager
def _session_ctx(session):
    yield session


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h", is_verified=True)
    db.add(client)
    db.flush()
    return client


def _make_bot(db, client: Client, *, bot_key: str) -> Bot:
    bot = Bot(client_id=client.id, name="Agent", bot_key=bot_key)
    db.add(bot)
    db.flush()
    return bot


def _debits(db, client_id: int) -> list[CreditLedger]:
    return list(
        db.execute(select(CreditLedger).where(CreditLedger.client_id == client_id, CreditLedger.delta < 0))
        .scalars()
        .all()
    )


# ── write path ───────────────────────────────────────────────────────────────


@needs_db
def test_pooled_deduction_records_the_bot(db):
    """A pooled deduction has bot_id NULL but attributed_bot_id set."""
    client = _make_client(db, email="attr-pooled@e.com")
    bot = _make_bot(db, client, bot_key="bot-attr-pooled")

    credit_service.grant_plan_credits(db, client.id, 1000, bot_id=None)
    credit_service.check_and_deduct(
        db,
        client.id,
        5,
        reason="ai_chat",
        bot_id=None,  # pooled scope
        attributed_bot_id=bot.id,  # which bot spent it
    )
    db.flush()

    (row,) = _debits(db, client.id)
    assert row.bot_id is None
    assert row.attributed_bot_id == bot.id


@needs_db
def test_bot_scoped_deduction_defaults_attribution_to_its_bot_id(db):
    """No explicit argument: a bot-scoped deduction attributes to its own scope."""
    client = _make_client(db, email="attr-scoped@e.com")
    bot = _make_bot(db, client, bot_key="bot-attr-scoped")

    credit_service.grant_plan_credits(db, client.id, 1000, bot_id=bot.id)
    credit_service.check_and_deduct(db, client.id, 7, reason="ai_chat", bot_id=bot.id)
    db.flush()

    (row,) = _debits(db, client.id)
    assert row.bot_id == bot.id
    assert row.attributed_bot_id == bot.id


@needs_db
def test_explicit_none_attribution_still_falls_back_to_scope(db):
    """Passing ``attributed_bot_id=None`` is the same as not passing it."""
    client = _make_client(db, email="attr-explicit-none@e.com")
    bot = _make_bot(db, client, bot_key="bot-attr-explicit-none")

    credit_service.grant_plan_credits(db, client.id, 100, bot_id=bot.id)
    credit_service.check_and_deduct(db, client.id, 3, reason="ai_chat", bot_id=bot.id, attributed_bot_id=None)
    db.flush()

    (row,) = _debits(db, client.id)
    assert row.attributed_bot_id == bot.id


@needs_db
def test_multi_grant_deduction_attributes_every_chunk(db):
    """A deduction that spans two grants writes two rows, both attributed."""
    client = _make_client(db, email="attr-multigrant@e.com")
    bot = _make_bot(db, client, bot_key="bot-attr-multigrant")

    credit_service.grant_plan_credits(db, client.id, 10, bot_id=None)
    credit_service.grant_manual(db, client.id, 10, "second grant")  # also pooled
    credit_service.check_and_deduct(
        db,
        client.id,
        15,  # straddles the grant boundary
        reason="url_scan",
        bot_id=None,
        attributed_bot_id=bot.id,
    )
    db.flush()

    rows = _debits(db, client.id)
    assert len(rows) == 2
    assert all(r.bot_id is None for r in rows)
    assert all(r.attributed_bot_id == bot.id for r in rows)


@needs_db
def test_refund_carries_the_same_attribution_as_the_deduction(db):
    """A refund reverses one bot's spend, so it reports against that bot too."""
    client = _make_client(db, email="attr-refund@e.com")
    bot = _make_bot(db, client, bot_key="bot-attr-refund")

    credit_service.grant_plan_credits(db, client.id, 100, bot_id=None)
    credit_service.check_and_deduct(db, client.id, 4, reason="ai_chat", bot_id=None, attributed_bot_id=bot.id)
    credit_service.refund(db, client.id, 4, reference_id=bot.id, bot_id=None, attributed_bot_id=bot.id)
    db.flush()

    refund_row = db.execute(
        select(CreditLedger).where(CreditLedger.client_id == client.id, CreditLedger.reason == "refund")
    ).scalar_one()
    assert refund_row.bot_id is None
    assert refund_row.attributed_bot_id == bot.id


# ── the invariant: attribution must never move a balance ─────────────────────


@needs_db
def test_attribution_never_moves_a_balance(db):
    """Balance maths keys off ``bot_id`` ALONE and must ignore attribution.

    A pooled deduction attributed to a bot must (a) still come out of the pool
    and (b) leave that bot's own isolated ledger untouched. This fails the day
    someone adds ``attributed_bot_id`` to ``_scope_clause``, the regression
    this column invites.
    """
    client = _make_client(db, email="attr-invariant@e.com")
    bot = _make_bot(db, client, bot_key="bot-attr-invariant")

    credit_service.grant_plan_credits(db, client.id, 1000, bot_id=None)  # shared pool
    credit_service.grant_plan_credits(db, client.id, 500, bot_id=bot.id)  # the bot's own ledger

    pool_before = credit_service.get_balance(db, client.id, bot_id=None)
    bot_before = credit_service.get_balance(db, client.id, bot_id=bot.id)
    assert (pool_before, bot_before) == (1000, 500)

    credit_service.check_and_deduct(
        db,
        client.id,
        40,
        reason="ai_chat",
        bot_id=None,  # spent from the POOL
        attributed_bot_id=bot.id,  # but reported against the bot
    )
    db.flush()

    # The pool paid for it. Attribution did not move the row out of the pool.
    assert credit_service.get_balance(db, client.id, bot_id=None) == pool_before - 40
    # The bot's own ledger is untouched. Attribution did not pull the pooled
    # row into it.
    assert credit_service.get_balance(db, client.id, bot_id=bot.id) == bot_before

    # Same story for the breakdown, which shares the FIFO allocator.
    assert credit_service.get_balance_breakdown(db, client.id, bot_id=bot.id)["total"] == bot_before


# ── end to end: a real chat reply lands the attribution ──────────────────────


@needs_db
def test_chat_reply_lands_attribution_end_to_end(db):
    """POST /chat on a pooled bot writes bot_id NULL + attributed_bot_id=bot.id.

    Proves the route actually threads the real bot through, not merely that
    ``check_and_deduct`` accepts the keyword.
    """
    from app.api.auth import get_bot_for_chat, get_current_bot
    from app.api.chat_routes import router

    client = _make_client(db, email="attr-chat@e.com")
    # No subscription → resolve_bot_ledger_bot_id() routes to the client pool.
    bot = _make_bot(db, client, bot_key="bot-attr-chat")
    assert credit_service.resolve_bot_ledger_bot_id(bot) is None

    credit_service.grant_plan_credits(db, client.id, 1000, bot_id=None)
    db.commit()

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_bot] = lambda: bot
    app.dependency_overrides[get_bot_for_chat] = lambda: bot

    with (
        patch("app.api.chat_routes.get_session", return_value=_session_ctx(db)),
        patch("app.api.chat_routes.bot_subscription_status", return_value="active"),
        patch("app.api.chat_routes._resolve_session_id", return_value="session-1"),
        patch("app.api.chat_routes._parse_request_context", return_value=("1.2.3.4", "Desktop Chrome")),
        patch("app.api.chat_routes.submit_background"),
        patch(
            "app.api.chat_routes.rag_pipeline",
            return_value={"answer": "Hi!", "sources": [], "session_id": "session-1", "message_id": 1},
        ),
    ):
        response = TestClient(app).post(
            "/chat",
            json={"question": "Hello"},
            headers={"X-Bot-Key": bot.bot_key},
        )

    assert response.status_code == 200

    (row,) = _debits(db, client.id)
    assert row.reason == "ai_chat"
    assert row.bot_id is None  # pooled scope. Routing unchanged
    assert row.attributed_bot_id == bot.id  # attribution landed
