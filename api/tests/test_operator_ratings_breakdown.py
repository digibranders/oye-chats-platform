"""Per-operator post-chat ratings, and who is allowed to read them.

The workspace-wide CSAT number answers "are visitors happy?". It cannot answer
"how do my operators compare?", which is the question a team lead actually
opens the Feedback tab with. ``get_operator_ratings_breakdown`` answers the
second one, and because the answer is performance data about named people it
carries two obligations the aggregate does not:

* every average ships with the count behind it, so a 2.0 drawn from one chat
  cannot masquerade as a verdict; and
* only an owner or an admin may read it. A plain operator seat covers the
  inbox, not a ranking of their colleagues.

Real-Postgres tests: the grouping, the join to ``operators`` and the window all
live in SQL, so a mocked session would assert the shape of the code rather than
the meaning of the answer.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Bot, ChatSession, Client, Operator
from app.db.repository import get_operator_ratings_breakdown

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="operator ratings tests need a reachable Postgres at DB_URL",
)

NOW = datetime.now(UTC)


@contextmanager
def _session_cm(session):
    yield session


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h", is_verified=True)
    db.add(client)
    db.flush()
    return client


def _make_bot(db, client: Client, *, key: str) -> Bot:
    bot = Bot(client_id=client.id, bot_key=key, name="Bot")
    db.add(bot)
    db.flush()
    return bot


def _make_operator(db, bot: Bot, *, name: str, email: str, role: str = "operator") -> Operator:
    op = Operator(
        client_id=bot.client_id,
        bot_id=bot.id,
        name=name,
        email=email,
        role=role,
        hashed_password="h",
        is_active=True,
    )
    db.add(op)
    db.flush()
    return op


def _rated(db, bot: Bot, *, sid: str, rating: int | None, operator: Operator | None, age_days=1):
    row = ChatSession(
        id=sid,
        client_id=bot.client_id,
        bot_id=bot.id,
        created_at=NOW - timedelta(days=age_days),
        visitor_rating=rating,
        assigned_operator_id=operator.id if operator else None,
    )
    db.add(row)
    db.flush()
    return row


# ── The aggregate ────────────────────────────────────────────────────────────


def test_ratings_are_grouped_per_operator_with_the_count_behind_each_average(db) -> None:
    client = _make_client(db, email="opcsat-group@e.com")
    bot = _make_bot(db, client, key="bot-opcsat-group")
    ana = _make_operator(db, bot, name="Ana", email="ana@e.com")
    bo = _make_operator(db, bot, name="Bo", email="bo@e.com")

    _rated(db, bot, sid="g1", rating=5, operator=ana)
    _rated(db, bot, sid="g2", rating=4, operator=ana)
    _rated(db, bot, sid="g3", rating=2, operator=bo)
    db.commit()

    rows = get_operator_ratings_breakdown(db, client_id=client.id, bot_id=bot.id)
    by_id = {r["operator_id"]: r for r in rows}

    assert by_id[ana.id]["avg"] == 4.5
    assert by_id[ana.id]["total"] == 2, "the count is part of the row, not a tooltip"
    assert by_id[ana.id]["unhappy"] == 0
    assert by_id[bo.id]["avg"] == 2.0
    assert by_id[bo.id]["unhappy"] == 1, "1-2 stars counts as unhappy"


def test_rows_are_returned_best_first_so_the_caller_need_not_sort(db) -> None:
    client = _make_client(db, email="opcsat-order@e.com")
    bot = _make_bot(db, client, key="bot-opcsat-order")
    low = _make_operator(db, bot, name="Low", email="low@e.com")
    high = _make_operator(db, bot, name="High", email="high@e.com")

    _rated(db, bot, sid="o1", rating=1, operator=low)
    _rated(db, bot, sid="o2", rating=5, operator=high)
    db.commit()

    rows = get_operator_ratings_breakdown(db, client_id=client.id, bot_id=bot.id)

    assert [r["operator_id"] for r in rows] == [high.id, low.id]


def test_bot_only_conversations_are_excluded_because_nobody_handled_them(db) -> None:
    """An unassigned chat has no operator to attribute the score to. Counting
    it against the team would be inventing an attribution the data lacks."""
    client = _make_client(db, email="opcsat-botonly@e.com")
    bot = _make_bot(db, client, key="bot-opcsat-botonly")
    ana = _make_operator(db, bot, name="Ana", email="ana2@e.com")

    _rated(db, bot, sid="b1", rating=5, operator=ana)
    _rated(db, bot, sid="b2", rating=1, operator=None)  # bot-only, drags the average down
    _rated(db, bot, sid="b3", rating=None, operator=ana)  # handled but never rated
    db.commit()

    rows = get_operator_ratings_breakdown(db, client_id=client.id, bot_id=bot.id)

    assert len(rows) == 1
    assert rows[0]["total"] == 1, "only the one rated, operator-handled chat counts"
    assert rows[0]["avg"] == 5.0


def test_the_email_rides_along_so_a_duplicate_name_can_be_told_apart(db) -> None:
    """Operator names are not unique. Two seats can carry the same display
    name, and a name-only ranking is one the reader cannot act on."""
    client = _make_client(db, email="opcsat-dupe@e.com")
    bot = _make_bot(db, client, key="bot-opcsat-dupe")
    one = _make_operator(db, bot, name="Sam Rae", email="sam@e.com")
    two = _make_operator(db, bot, name="Sam Rae", email="sam.rae@e.com")

    _rated(db, bot, sid="d1", rating=5, operator=one)
    _rated(db, bot, sid="d2", rating=3, operator=two)
    db.commit()

    rows = get_operator_ratings_breakdown(db, client_id=client.id, bot_id=bot.id)

    assert {r["email"] for r in rows} == {"sam@e.com", "sam.rae@e.com"}
    assert {r["operator_id"] for r in rows} == {one.id, two.id}


def test_the_window_is_honoured(db) -> None:
    client = _make_client(db, email="opcsat-window@e.com")
    bot = _make_bot(db, client, key="bot-opcsat-window")
    ana = _make_operator(db, bot, name="Ana", email="ana3@e.com")

    _rated(db, bot, sid="w1", rating=5, operator=ana, age_days=2)
    _rated(db, bot, sid="w2", rating=1, operator=ana, age_days=90)
    db.commit()

    recent = get_operator_ratings_breakdown(db, client_id=client.id, bot_id=bot.id, days=30)
    all_time = get_operator_ratings_breakdown(db, client_id=client.id, bot_id=bot.id)

    assert recent[0]["total"] == 1 and recent[0]["avg"] == 5.0
    assert all_time[0]["total"] == 2 and all_time[0]["avg"] == 3.0


def test_min_ratings_drops_operators_below_the_volume_floor(db) -> None:
    client = _make_client(db, email="opcsat-floor@e.com")
    bot = _make_bot(db, client, key="bot-opcsat-floor")
    thin = _make_operator(db, bot, name="Thin", email="thin@e.com")
    solid = _make_operator(db, bot, name="Solid", email="solid@e.com")

    _rated(db, bot, sid="f1", rating=5, operator=thin)
    for i, score in enumerate([5, 4, 4]):
        _rated(db, bot, sid=f"f2{i}", rating=score, operator=solid)
    db.commit()

    rows = get_operator_ratings_breakdown(db, client_id=client.id, bot_id=bot.id, min_ratings=3)

    assert [r["operator_id"] for r in rows] == [solid.id]


def test_another_workspaces_operators_are_never_included(db) -> None:
    mine = _make_client(db, email="opcsat-mine@e.com")
    theirs = _make_client(db, email="opcsat-theirs@e.com")
    my_bot = _make_bot(db, mine, key="bot-opcsat-mine")
    their_bot = _make_bot(db, theirs, key="bot-opcsat-theirs")
    my_op = _make_operator(db, my_bot, name="Mine", email="mine@e.com")
    their_op = _make_operator(db, their_bot, name="Theirs", email="theirs@e.com")

    _rated(db, my_bot, sid="t1", rating=5, operator=my_op)
    _rated(db, their_bot, sid="t2", rating=1, operator=their_op)
    db.commit()

    rows = get_operator_ratings_breakdown(db, client_id=mine.id)

    assert [r["operator_id"] for r in rows] == [my_op.id]


# ── The gate ─────────────────────────────────────────────────────────────────


def _error_body(res) -> dict:
    """The refusal payload, however this app happens to be wrapping it.

    The production app installs an exception handler that flattens
    ``HTTPException.detail`` to the top level (``{"error": ...}`` on the wire);
    the bare router mounted here does not, so it arrives under ``detail``.
    The test asserts the marker either way rather than pinning the wrapper.
    """
    body = res.json()
    return body.get("detail") if isinstance(body.get("detail"), dict) else body


def _get_as(db, auth: dict, url: str):
    from unittest.mock import patch

    from app.api import analytics_routes
    from app.api.auth import get_current_client_or_operator

    app = FastAPI()
    app.include_router(analytics_routes.router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: auth
    with patch.object(analytics_routes, "get_session", lambda: _session_cm(db)):
        return TestClient(app, raise_server_exceptions=False).get(url)


@pytest.mark.parametrize("role", ["owner", "admin"])
def test_owners_and_admins_may_read_the_breakdown(db, role: str) -> None:
    client = _make_client(db, email=f"opcsat-gate-{role}@e.com")
    bot = _make_bot(db, client, key=f"bot-opcsat-gate-{role}")
    op = _make_operator(db, bot, name="Lead", email=f"lead-{role}@e.com", role=role)
    _rated(db, bot, sid=f"gate-{role}", rating=5, operator=op)
    db.commit()

    res = _get_as(
        db,
        {"type": "operator", "entity": op, "client_id": client.id},
        f"/analytics/operator-ratings?bot_id={bot.id}",
    )

    assert res.status_code == 200
    assert res.json()[0]["operator_id"] == op.id


def test_a_plain_operator_is_refused(db) -> None:
    """An operator seat covers the inbox, not a ranking of colleagues."""
    client = _make_client(db, email="opcsat-gate-op@e.com")
    bot = _make_bot(db, client, key="bot-opcsat-gate-op")
    op = _make_operator(db, bot, name="Seat", email="seat@e.com", role="operator")
    _rated(db, bot, sid="gate-op", rating=5, operator=op)
    db.commit()

    res = _get_as(
        db,
        {"type": "operator", "entity": op, "client_id": client.id},
        f"/analytics/operator-ratings?bot_id={bot.id}",
    )

    assert res.status_code == 403
    assert _error_body(res)["error"] == "manager_role_required"


def test_the_account_owner_reading_as_a_client_is_allowed(db) -> None:
    client = _make_client(db, email="opcsat-gate-client@e.com")
    bot = _make_bot(db, client, key="bot-opcsat-gate-client")
    op = _make_operator(db, bot, name="Seat", email="seat2@e.com")
    _rated(db, bot, sid="gate-client", rating=4, operator=op)
    db.commit()

    res = _get_as(
        db,
        {"type": "client", "entity": client, "client_id": client.id},
        f"/analytics/operator-ratings?bot_id={bot.id}",
    )

    assert res.status_code == 200
