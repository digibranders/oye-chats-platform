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

from app.db.models import Bot, ChatSession, Client, LeadInfo, Operator
from app.db.repository import get_operator_rated_chats, get_operator_ratings_breakdown

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


# ── Chats handled, per-star counts, and the calendar-month report ────────────


def _chat_at(db, bot: Bot, *, sid: str, operator: Operator, created_at: datetime, rating: int | None = None):
    row = ChatSession(
        id=sid,
        client_id=bot.client_id,
        bot_id=bot.id,
        created_at=created_at,
        visitor_rating=rating,
        assigned_operator_id=operator.id,
    )
    db.add(row)
    db.flush()
    return row


def test_handled_counts_every_assigned_chat_whether_or_not_it_was_rated(db) -> None:
    """A 4.8 from 5 rated chats out of 200 is not a 4.8 from 150 out of 200.
    ``handled`` is the number that tells them apart."""
    client = _make_client(db, email="opcsat-handled@e.com")
    bot = _make_bot(db, client, key="bot-opcsat-handled")
    ana = _make_operator(db, bot, name="Ana", email="ana-h@e.com")

    _rated(db, bot, sid="h1", rating=5, operator=ana)
    _rated(db, bot, sid="h2", rating=2, operator=ana)
    _rated(db, bot, sid="h3", rating=None, operator=ana)
    _rated(db, bot, sid="h4", rating=None, operator=ana)
    db.commit()

    [row] = get_operator_ratings_breakdown(db, client_id=client.id, bot_id=bot.id)

    assert row["handled"] == 4
    assert row["total"] == 2
    assert row["avg"] == 3.5
    assert row["stars"] == {"5": 1, "4": 0, "3": 0, "2": 1, "1": 0}


def test_min_ratings_zero_keeps_an_operator_who_handled_chats_nobody_rated(db) -> None:
    """The report exists partly to show exactly this operator. The on-screen
    ranking, which keeps the default floor of one, still leaves them out."""
    client = _make_client(db, email="opcsat-unrated@e.com")
    bot = _make_bot(db, client, key="bot-opcsat-unrated")
    rated = _make_operator(db, bot, name="Rated", email="rated@e.com")
    unrated = _make_operator(db, bot, name="Unrated", email="unrated@e.com")

    _rated(db, bot, sid="u1", rating=4, operator=rated)
    _rated(db, bot, sid="u2", rating=None, operator=unrated)
    _rated(db, bot, sid="u3", rating=None, operator=unrated)
    db.commit()

    ranking = get_operator_ratings_breakdown(db, client_id=client.id, bot_id=bot.id)
    report = get_operator_ratings_breakdown(db, client_id=client.id, bot_id=bot.id, min_ratings=0)

    assert [r["operator_id"] for r in ranking] == [rated.id]
    assert [r["operator_id"] for r in report] == [rated.id, unrated.id], "operators nobody rated sort last"
    assert (report[1]["handled"], report[1]["total"], report[1]["avg"]) == (2, 0, None)


def test_a_month_is_cut_on_the_calendar_in_the_readers_zone(db) -> None:
    """August means 1 August 00:00 to 1 September 00:00 where the reader is.

    Three chats sit on month edges, each with a distinct rating so the averages
    say which ones landed where:

    * 5 stars at 23:30 IST on 31 August (18:00 UTC): August in both zones.
    * 1 star at 00:30 IST on 1 September (19:00 UTC on 31 August): September
      in India, still August in UTC.
    * 3 stars at 00:30 IST on 1 August (19:00 UTC on 31 July): August in
      India, July in UTC.
    """
    client = _make_client(db, email="opcsat-month@e.com")
    bot = _make_bot(db, client, key="bot-opcsat-month")
    ana = _make_operator(db, bot, name="Ana", email="ana-m@e.com")

    _chat_at(db, bot, sid="m1", operator=ana, rating=5, created_at=datetime(2025, 8, 31, 18, 0, tzinfo=UTC))
    _chat_at(db, bot, sid="m2", operator=ana, rating=1, created_at=datetime(2025, 8, 31, 19, 0, tzinfo=UTC))
    _chat_at(db, bot, sid="m3", operator=ana, rating=3, created_at=datetime(2025, 7, 31, 19, 0, tzinfo=UTC))
    db.commit()

    def month(value: str, tz: str) -> tuple[int, float]:
        [row] = get_operator_ratings_breakdown(db, client_id=client.id, bot_id=bot.id, month=value, tz=tz)
        return row["handled"], row["avg"]

    assert month("2025-08", "Asia/Kolkata") == (2, 4.0), "31 Aug 23:30 and 1 Aug 00:30 IST"
    assert month("2025-09", "Asia/Kolkata") == (1, 1.0), "1 Sep 00:30 IST belongs to September"
    assert month("2025-08", "UTC") == (2, 3.0), "in UTC both 31 August chats are August"
    assert month("2025-07", "UTC") == (1, 3.0), "and 1 Aug 00:30 IST is still July"


def test_days_and_month_together_are_refused(db) -> None:
    with pytest.raises(ValueError, match="either days or month"):
        get_operator_ratings_breakdown(db, client_id=1, days=30, month="2025-08")


@pytest.mark.parametrize(
    ("month", "tz", "message"),
    [
        ("2025-13", "UTC", "YYYY-MM"),
        ("2025-8", "UTC", "YYYY-MM"),
        ("25-08", "UTC", "YYYY-MM"),
        ("2025-08", "Mars/Olympus_Mons", "Unknown timezone"),
        ("2999-01", "UTC", "has not started"),
    ],
)
def test_a_month_that_cannot_be_reported_on_is_refused(db, month: str, tz: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        get_operator_ratings_breakdown(db, client_id=1, month=month, tz=tz)


def test_the_route_serves_a_calendar_month_and_refuses_one_it_cannot(db) -> None:
    client = _make_client(db, email="opcsat-route-month@e.com")
    bot = _make_bot(db, client, key="bot-opcsat-route-month")
    lead = _make_operator(db, bot, name="Lead", email="lead-month@e.com", role="owner")
    _chat_at(db, bot, sid="rm1", operator=lead, rating=4, created_at=datetime(2025, 8, 10, 12, 0, tzinfo=UTC))
    _chat_at(db, bot, sid="rm2", operator=lead, created_at=datetime(2025, 8, 11, 12, 0, tzinfo=UTC))
    db.commit()
    auth = {"type": "client", "entity": client, "client_id": client.id}
    base = f"/analytics/operator-ratings?bot_id={bot.id}"

    ok = _get_as(db, auth, f"{base}&month=2025-08&tz=Asia/Kolkata&min_ratings=0")
    assert ok.status_code == 200
    assert (ok.json()[0]["handled"], ok.json()[0]["total"]) == (2, 1)

    assert _get_as(db, auth, f"{base}&month=2999-01").status_code == 422, "not started yet"
    assert _get_as(db, auth, f"{base}&month=2025-13").status_code == 422, "no such month"
    assert _get_as(db, auth, f"{base}&month=2025-08&days=30").status_code == 422, "two windows at once"


# ── The drill-down: which chats, and with whom ───────────────────────────────


def _lead(db, bot: Bot, chat: ChatSession, *, name: str | None, email: str | None) -> None:
    db.add(LeadInfo(session_id=chat.id, bot_id=bot.id, name=name, email=email))
    db.flush()


def test_rated_chats_come_worst_first_then_newest_with_the_visitor_named(db) -> None:
    """A manager expands an operator to read the bad chats, so those lead."""
    client = _make_client(db, email="opchats-order@e.com")
    bot = _make_bot(db, client, key="bot-opchats-order")
    ana = _make_operator(db, bot, name="Ana", email="ana-c@e.com")
    other = _make_operator(db, bot, name="Other", email="other-c@e.com")

    good_old = _rated(db, bot, sid="oc-1", rating=5, operator=ana, age_days=9)
    _rated(db, bot, sid="oc-2", rating=1, operator=ana, age_days=8)
    bad_new = _rated(db, bot, sid="oc-3", rating=1, operator=ana, age_days=2)
    _rated(db, bot, sid="oc-4", rating=None, operator=ana, age_days=1)
    _rated(db, bot, sid="oc-5", rating=2, operator=other, age_days=1)
    _lead(db, bot, bad_new, name="  Priya Sharma ", email="priya@acme.in")
    _lead(db, bot, good_old, name=None, email="   ")
    db.commit()

    result = get_operator_rated_chats(db, client_id=client.id, operator_id=ana.id, bot_id=bot.id)

    assert [c["session_id"] for c in result["items"]] == ["oc-3", "oc-2", "oc-1"]
    assert (result["total"], result["unrated"]) == (3, 1), "oc-4 was handled but never rated"
    assert (result["items"][0]["visitor_name"], result["items"][0]["visitor_email"]) == (
        "Priya Sharma",
        "priya@acme.in",
    )
    assert result["items"][1]["visitor_name"] is None, "a visitor who never left details stays anonymous"
    assert result["items"][2]["visitor_email"] is None, "a blank address is not an address"


def test_rated_chats_page_and_honour_the_window(db) -> None:
    client = _make_client(db, email="opchats-page@e.com")
    bot = _make_bot(db, client, key="bot-opchats-page")
    ana = _make_operator(db, bot, name="Ana", email="ana-p@e.com")
    for i in range(5):
        _rated(db, bot, sid=f"oc-p{i}", rating=3, operator=ana, age_days=i + 1)
    _rated(db, bot, sid="oc-p-old", rating=1, operator=ana, age_days=90)
    db.commit()

    first = get_operator_rated_chats(db, client_id=client.id, operator_id=ana.id, days=30, limit=2)
    rest = get_operator_rated_chats(db, client_id=client.id, operator_id=ana.id, days=30, limit=2, offset=2)
    everything = get_operator_rated_chats(db, client_id=client.id, operator_id=ana.id)

    assert first["total"] == 5, "the 90-day-old chat is outside the window"
    assert [c["session_id"] for c in first["items"]] == ["oc-p0", "oc-p1"]
    assert [c["session_id"] for c in rest["items"]] == ["oc-p2", "oc-p3"]
    assert everything["items"][0]["session_id"] == "oc-p-old", "across all time the 1-star chat leads"


def test_an_operator_from_another_workspace_is_not_found(db) -> None:
    """A 404, not an empty list: an empty list would confirm the id exists."""
    mine = _make_client(db, email="opchats-mine@e.com")
    theirs = _make_client(db, email="opchats-theirs@e.com")
    their_bot = _make_bot(db, theirs, key="bot-opchats-theirs")
    their_op = _make_operator(db, their_bot, name="Theirs", email="theirs-c@e.com")
    _rated(db, their_bot, sid="oc-x1", rating=1, operator=their_op)
    db.commit()

    assert get_operator_rated_chats(db, client_id=mine.id, operator_id=their_op.id) is None
    res = _get_as(
        db,
        {"type": "client", "entity": mine, "client_id": mine.id},
        f"/analytics/operator-ratings/{their_op.id}/chats",
    )
    assert res.status_code == 404


def test_the_drill_down_is_for_owners_and_admins_only(db) -> None:
    """It names visitors, so a plain seat is refused just as it is for the ranking."""
    client = _make_client(db, email="opchats-gate@e.com")
    bot = _make_bot(db, client, key="bot-opchats-gate")
    seat = _make_operator(db, bot, name="Seat", email="seat-c@e.com", role="operator")
    admin = _make_operator(db, bot, name="Admin", email="admin-c@e.com", role="admin")
    _rated(db, bot, sid="oc-g1", rating=2, operator=seat)
    db.commit()
    url = f"/analytics/operator-ratings/{seat.id}/chats?bot_id={bot.id}"

    refused = _get_as(db, {"type": "operator", "entity": seat, "client_id": client.id}, url)
    allowed = _get_as(db, {"type": "operator", "entity": admin, "client_id": client.id}, url)

    assert refused.status_code == 403
    assert allowed.status_code == 200
    assert allowed.json()["items"][0]["session_id"] == "oc-g1"
