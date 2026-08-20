"""``GET /credits/history`` — the customer-facing credit ledger pager.

Two defects covered:

* **Ordering (the serious one).** ``CreditLedger.created_at`` is a
  ``server_default=func.now()`` transaction timestamp, so every row written in
  one transaction — a FIFO-boundary deduction writes two — carries an IDENTICAL
  value. ``ORDER BY created_at DESC`` alone is therefore not a total order and
  Postgres may resolve the tie differently for two OFFSET queries: the same
  movement can appear on two pages, or on none. No error is raised anywhere;
  the customer just sees a ledger that does not add up. An ``id`` tiebreak
  makes the order total.
* **Envelope.** The endpoint returned a bare list with no count, so a client
  could only guess whether another page existed. It now answers
  ``{entries, total, page, limit}``.

Real-Postgres route tests via the shared ``db`` fixture; skip without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Bot, Client, CreditLedger

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="credit-history route test needs a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h", is_verified=True)
    db.add(client)
    db.flush()
    return client


def _make_bot(db, client: Client, *, bot_key: str) -> Bot:
    bot = Bot(client_id=client.id, name="b", bot_key=bot_key)
    db.add(bot)
    db.flush()
    return bot


def _api(client) -> TestClient:
    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.credits_router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    return TestClient(app, raise_server_exceptions=False)


def _call(db, client, **params):
    from app.api import subscription_routes

    api = _api(client)
    query = "&".join(f"{k}={v}" for k, v in params.items())
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        return api.get(f"/credits/history?{query}" if query else "/credits/history")


# Enough tied rows that the planner sorts rather than trivially returning them
# in physical order. At this size, paging a tie WITHOUT the id tiebreak measurably
# duplicates one row and drops another on this Postgres; with four rows Postgres
# happens to answer consistently and the bug hides, which is precisely why it
# survives in production-shaped data and not in a toy fixture.
_TIED_ROWS = 60
_TIED_PAGE = 10


def test_pages_never_duplicate_or_drop_rows_sharing_a_timestamp(db) -> None:
    """The regression test. Fails on the un-tiebroken ``ORDER BY created_at DESC``."""
    client = _make_client(db, email="tie@e.com")
    # ONE transaction: ``created_at`` defaults to ``func.now()``, the
    # TRANSACTION timestamp, so every row shares it EXACTLY, exactly as the two
    # rows of a FIFO-boundary deduction do.
    for i in range(_TIED_ROWS):
        db.add(CreditLedger(client_id=client.id, delta=-1, reason="ai_chat", note=f"row-{i}"))
    db.commit()

    stamps = {row.created_at for row in db.query(CreditLedger).all()}
    assert len(stamps) == 1, "fixture must produce rows with one identical timestamp"
    expected = {row.id for row in db.query(CreditLedger).all()}

    seen: list[int] = []
    for page in range(1, _TIED_ROWS // _TIED_PAGE + 1):
        res = _call(db, client, page=page, limit=_TIED_PAGE)
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["total"] == _TIED_ROWS
        assert len(body["entries"]) == _TIED_PAGE
        seen.extend(row["id"] for row in body["entries"])

    assert len(seen) - len(set(seen)) == 0, "a row was served on two pages"
    assert set(seen) == expected, "a row was never served on any page"


def test_envelope_reports_total_page_and_limit(db) -> None:
    client = _make_client(db, email="envelope@e.com")
    for _ in range(3):
        db.add(CreditLedger(client_id=client.id, delta=-1, reason="ai_chat"))
    db.commit()

    body = _call(db, client, page=1, limit=2).json()
    assert body["total"] == 3
    assert body["page"] == 1
    assert body["limit"] == 2
    assert len(body["entries"]) == 2
    # The row shape itself is unchanged.
    assert set(body["entries"][0]) == {
        "id",
        "delta",
        "reason",
        "reference_id",
        "expires_at",
        "note",
        "created_at",
    }


def test_page_past_the_end_is_empty_with_the_real_total(db) -> None:
    client = _make_client(db, email="past-end@e.com")
    for _ in range(3):
        db.add(CreditLedger(client_id=client.id, delta=-1, reason="ai_chat"))
    db.commit()

    body = _call(db, client, page=9, limit=2).json()
    assert body["entries"] == []
    assert body["total"] == 3


def test_total_respects_the_bot_id_scope(db) -> None:
    client = _make_client(db, email="scoped@e.com")
    bot = _make_bot(db, client, bot_key="bot-scoped")
    # Two rows in the bot's own ledger, three in the client pool.
    for _ in range(2):
        db.add(CreditLedger(client_id=client.id, bot_id=bot.id, delta=-1, reason="ai_chat"))
    for _ in range(3):
        db.add(CreditLedger(client_id=client.id, bot_id=None, delta=-1, reason="ai_chat"))
    db.commit()

    workspace = _call(db, client, page=1, limit=50).json()
    assert workspace["total"] == 5
    assert len(workspace["entries"]) == 5

    scoped = _call(db, client, page=1, limit=50, bot_id=bot.id).json()
    assert scoped["total"] == 2
    assert len(scoped["entries"]) == 2


def test_a_foreign_bot_id_yields_nothing(db) -> None:
    mine = _make_client(db, email="mine@e.com")
    theirs = _make_client(db, email="theirs@e.com")
    their_bot = _make_bot(db, theirs, bot_key="bot-theirs")
    db.add(CreditLedger(client_id=theirs.id, bot_id=their_bot.id, delta=-1, reason="ai_chat"))
    db.add(CreditLedger(client_id=mine.id, delta=-1, reason="ai_chat"))
    db.commit()

    body = _call(db, mine, page=1, limit=50, bot_id=their_bot.id).json()
    assert body["total"] == 0
    assert body["entries"] == []
