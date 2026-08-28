"""Super-admin v2 reporting arithmetic: the credit ledger and the dunning queue.

Both endpoints returned numbers that were wrong rather than missing, which is
the failure mode no smoke test catches. The assertions here are on the two
axes that were actually broken: the ledger's running balance across a page
boundary and across ``(client_id, bot_id)`` scopes, and dunning's cycle price
and currency rail.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_routes_v2
from app.api.auth import get_superadmin
from app.db.models import Bot, Client, CreditLedger, Plan, Subscription
from app.services import credit_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

PAGE = 500  # the endpoint's row cap; the window must outlive it


@contextmanager
def _ctx(session):
    yield session


def _api(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(
        id=None, name="Admin", is_superadmin=True, superadmin_role="owner"
    )
    return TestClient(app)


def _account(db, slug: str, **kw) -> Client:
    client = Client(name=f"Acct {slug}", email=f"{slug}@test.example", api_key=f"key-{slug}", **kw)
    db.add(client)
    db.flush()
    return client


# ── credits ledger ──────────────────────────────────────────────────────────


def _entry(db, client_id: int, delta: int, when: datetime, *, bot_id: int | None = None, reason: str = "ai_chat"):
    db.add(
        CreditLedger(
            client_id=client_id,
            bot_id=bot_id,
            delta=delta,
            reason=reason,
            created_at=when,
        )
    )


def test_balance_after_survives_the_page_boundary(db, monkeypatch):
    """The old walk restarted at zero on each page, so every account with more
    than 500 rows of history reported a fictional balance. The window runs over
    full history; the page is applied outside it."""
    client = _account(db, "ledger-page")
    start = datetime(2026, 1, 1, tzinfo=UTC)

    _entry(db, client.id, 10_000, start, reason="plan_grant")
    for i in range(PAGE + 20):
        _entry(db, client.id, -1, start + timedelta(seconds=i + 1))
    db.flush()

    res = _api(db, monkeypatch).get("/superadmin/credits/ledger")

    assert res.status_code == 200, res.text
    rows = res.json()
    assert len(rows) == PAGE  # the grant itself has fallen off the page
    # ``get_balance`` is the platform's single source of truth for spendable
    # credits; the newest row's running total must agree with it.
    assert rows[0]["balance_after"] == credit_service.get_balance(db, client.id)
    assert rows[0]["balance_after"] == 10_000 - (PAGE + 20)


def test_pooled_and_per_bot_ledgers_do_not_contaminate_each_other(db, monkeypatch):
    """``CreditLedger`` is scoped per ``(client_id, bot_id)``: ``bot_id IS NULL``
    is the workspace pool, a non-null ``bot_id`` is that bot's isolated ledger
    (``credit_service._scope_clause``). A running total keyed on ``client_id``
    alone blends the two into a balance no scope actually holds."""
    client = _account(db, "ledger-scope")
    bot = Bot(client_id=client.id, bot_key="bot-ledger-scope")
    db.add(bot)
    db.flush()
    start = datetime(2026, 2, 1, tzinfo=UTC)

    _entry(db, client.id, 5_000, start, reason="plan_grant")  # pool
    _entry(db, client.id, 900, start + timedelta(seconds=1), bot_id=bot.id, reason="plan_grant")  # per-bot
    _entry(db, client.id, -100, start + timedelta(seconds=2), bot_id=bot.id)  # per-bot
    _entry(db, client.id, -50, start + timedelta(seconds=3))  # pool
    db.flush()

    res = _api(db, monkeypatch).get(f"/superadmin/credits/ledger?client_id={client.id}")

    assert res.status_code == 200, res.text
    rows = res.json()
    pooled = [r for r in rows if r["bot_id"] is None]
    per_bot = [r for r in rows if r["bot_id"] == bot.id]

    # Newest first, so index 0 of each list is that ledger's latest balance.
    assert pooled[0]["balance_after"] == 4_950
    assert per_bot[0]["balance_after"] == 800
    assert pooled[0]["balance_after"] == credit_service.get_balance(db, client.id)
    assert per_bot[0]["balance_after"] == credit_service.get_balance(db, client.id, bot_id=bot.id)
    # The blended figure the old walk produced. It must appear nowhere.
    assert all(r["balance_after"] != 5_750 for r in rows)


def test_ledger_filter_narrows_to_one_account(db, monkeypatch):
    first = _account(db, "ledger-a")
    second = _account(db, "ledger-b")
    start = datetime(2026, 3, 1, tzinfo=UTC)
    _entry(db, first.id, 100, start, reason="plan_grant")
    _entry(db, second.id, 700, start + timedelta(seconds=1), reason="plan_grant")
    db.flush()

    res = _api(db, monkeypatch).get(f"/superadmin/credits/ledger?client_id={second.id}")

    assert res.status_code == 200, res.text
    rows = res.json()
    assert [r["client_id"] for r in rows] == [second.id]
    assert rows[0]["balance_after"] == 700


def test_unfiltered_page_still_sums_each_accounts_full_history(db, monkeypatch):
    """The unfiltered listing computes its window in two steps, not one.

    Windowing the whole table and paging afterwards was correct but read every
    row in ``credit_ledger`` on a call the console makes by default. It now
    picks the page first and re-runs the window only over the accounts that
    page touches. That is only a safe trade if the running balance is still a
    sum over each partition's FULL history rather than over the page, so: two
    accounts, more history between them than fits on one page, and the newest
    row of each must still report that account's whole balance.
    """
    first = _account(db, "ledger-multi-a")
    second = _account(db, "ledger-multi-b")
    start = datetime(2026, 5, 1, tzinfo=UTC)

    _entry(db, first.id, 10_000, start, reason="plan_grant")
    _entry(db, second.id, 20_000, start + timedelta(seconds=1), reason="plan_grant")
    # Interleaved, so the 500-row page carries rows from both accounts and
    # leaves the oldest of both accounts' rows off it.
    for i in range(PAGE):
        _entry(db, first.id, -1, start + timedelta(seconds=2 * i + 2))
        _entry(db, second.id, -2, start + timedelta(seconds=2 * i + 3))
    db.flush()

    rows = _api(db, monkeypatch).get("/superadmin/credits/ledger").json()

    assert len(rows) == PAGE
    assert {r["client_id"] for r in rows} == {first.id, second.id}, "the page should mix both accounts"
    newest = {}
    for row in rows:  # newest first
        newest.setdefault(row["client_id"], row)
    assert newest[first.id]["balance_after"] == 10_000 - PAGE
    assert newest[second.id]["balance_after"] == 20_000 - 2 * PAGE


def test_a_client_with_no_ledger_rows_is_an_empty_list(db, monkeypatch):
    """The two-step query short-circuits on an empty page; it must still answer []."""
    client = _account(db, "ledger-empty")
    db.flush()

    res = _api(db, monkeypatch).get(f"/superadmin/credits/ledger?client_id={client.id}")

    assert res.status_code == 200, res.text
    assert res.json() == []


# ── dunning ─────────────────────────────────────────────────────────────────


def _plan(db, slug: str, **kw) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=kw.pop("monthly_price_cents", 94_900),
        annual_price_cents=kw.pop("annual_price_cents", 949_000),
        credits_per_month=6_000,
        included_operator_seats=1,
        is_active=True,
        **kw,
    )
    db.add(plan)
    db.flush()
    return plan


def _past_due(db, client: Client, plan: Plan, *, cycle: str = "monthly") -> Subscription:
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="past_due",
        billing_cycle=cycle,
        past_due_since=datetime.now(UTC) - timedelta(days=2),
        razorpay_subscription_id=f"sub_{client.email}",
    )
    db.add(sub)
    db.flush()
    return sub


def test_annual_subscription_reports_the_annual_cycle(db, monkeypatch):
    """The handler read ``monthly_price_cents`` whatever the cycle said, so an
    annual subscription understated the cycle at risk by roughly twelve."""
    client = _account(db, "dun-annual", billing_country="IN")
    plan = _plan(db, "std-annual")
    _past_due(db, client, plan, cycle="annual")

    res = _api(db, monkeypatch).get("/superadmin/billing/dunning")

    assert res.status_code == 200, res.text
    (item,) = res.json()["items"]
    assert item["billing_cycle"] == "annual"
    assert item["cycle_at_risk_minor"] == 949_000
    assert item["currency"] == "INR"


def test_monthly_inr_subscription_reports_the_monthly_price(db, monkeypatch):
    client = _account(db, "dun-monthly", billing_country="IN")
    plan = _plan(db, "std-monthly")
    _past_due(db, client, plan)

    (item,) = _api(db, monkeypatch).get("/superadmin/billing/dunning").json()["items"]

    assert item["cycle_at_risk_minor"] == 94_900
    assert item["currency"] == "INR"


def test_usd_rail_customer_is_priced_and_labelled_in_usd(db, monkeypatch):
    """``Plan.currency`` is always ``INR`` (the plan routes reject anything
    else), so reading it made a USD-rail customer's row wrong in BOTH the
    number and the label. The rail is the client's billing country."""
    client = _account(db, "dun-usd", billing_country="US")
    plan = _plan(db, "std-usd", monthly_price_usd_cents=2_900, annual_price_usd_cents=29_000)
    assert plan.currency == "INR"  # the plan row itself never says USD
    _past_due(db, client, plan)

    (item,) = _api(db, monkeypatch).get("/superadmin/billing/dunning").json()["items"]

    assert item["currency"] == "USD"
    assert item["cycle_at_risk_minor"] == 2_900


def test_usd_rail_on_a_plan_with_no_usd_price_is_null_and_excluded(db, monkeypatch):
    """A USD-rail customer on a plan whose USD column was never filled in is a
    data defect. Emit null rather than silently quoting the rupee figure under
    a USD label, and keep it out of the totals."""
    client = _account(db, "dun-usd-null", billing_country="DE")
    plan = _plan(db, "std-usd-null")  # USD columns left NULL
    _past_due(db, client, plan)

    body = _api(db, monkeypatch).get("/superadmin/billing/dunning").json()

    (item,) = body["items"]
    assert item["currency"] == "USD"
    assert item["cycle_at_risk_minor"] is None
    assert body["at_risk_by_currency"] == []


def test_mixed_currencies_produce_two_buckets_and_no_cross_currency_sum(db, monkeypatch):
    inr_client = _account(db, "dun-mix-inr", billing_country="IN")
    usd_client = _account(db, "dun-mix-usd", billing_country="US")
    broken_client = _account(db, "dun-mix-broken", billing_country="AE")
    inr_plan = _plan(db, "mix-inr")
    usd_plan = _plan(db, "mix-usd", monthly_price_usd_cents=2_900)
    broken_plan = _plan(db, "mix-broken")
    _past_due(db, inr_client, inr_plan)
    _past_due(db, usd_client, usd_plan)
    _past_due(db, broken_client, broken_plan)

    body = _api(db, monkeypatch).get("/superadmin/billing/dunning").json()

    assert body["count"] == 3
    assert body["at_risk_by_currency"] == [
        {"currency": "INR", "minor": 94_900},
        {"currency": "USD", "minor": 2_900},
    ]
    # The scalar that added paise to cents is gone, not renamed.
    assert "at_risk_minor_total" not in body


def test_inr_rail_on_a_plan_with_no_price_for_that_cycle_is_null_and_excluded(db, monkeypatch):
    """The INR half of the SAME defect the test above covers on USD.

    ``annual_price_cents`` is ``NOT NULL DEFAULT 0``, so a plan that only ever
    had its monthly price filled in reports ``0`` for an annual subscription
    instead of NULL. Serving that ``0`` told an operator there was ₹0.00 at
    risk on a customer about to lose a real billing cycle, and counted the row
    in the INR total as if nothing were at stake — while the identical USD
    defect correctly reported null and stayed out of the totals. One defect,
    one answer.
    """
    client = _account(db, "dun-inr-zero", billing_country="IN")
    plan = _plan(db, "inr-monthly-only", annual_price_cents=0)
    _past_due(db, client, plan, cycle="annual")

    body = _api(db, monkeypatch).get("/superadmin/billing/dunning").json()

    (item,) = body["items"]
    assert item["currency"] == "INR"
    assert item["cycle_at_risk_minor"] is None, "₹0.00 at risk is a lie about a live billing cycle"
    assert body["at_risk_by_currency"] == []


def test_a_zero_priced_usd_column_is_also_null(db, monkeypatch):
    """Both rails read one expression, so an explicit 0 answers the same either way."""
    client = _account(db, "dun-usd-zero", billing_country="US")
    plan = _plan(db, "usd-zero", monthly_price_usd_cents=0, annual_price_usd_cents=0)
    _past_due(db, client, plan)

    body = _api(db, monkeypatch).get("/superadmin/billing/dunning").json()

    (item,) = body["items"]
    assert item["currency"] == "USD"
    assert item["cycle_at_risk_minor"] is None
    assert body["at_risk_by_currency"] == []
