"""Wave 3.5 (blueprint §7): the daily gateway reconciliation safety net.

Report-only diff of Razorpay's view of the world against ours:

* every CAPTURED gateway payment in the window → a local invoice, and a
  plan-charge invoice → a linked credit grant;
* every LIVE gateway subscription → a live local row (a gateway mandate
  billing a terminal local row is money leaving with no service);
* every live LOCAL gateway-backed row → a live gateway subscription (a dead
  mandate under an active local row is service leaving with no money).

The fetchers are injectable so these tests exercise the diff logic with fake
gateway pages; the cron wires the real SDK.
"""

import os
from datetime import UTC, datetime

import pytest

from app.db.models import Client, CreditLedger, Invoice, Plan, ReconciliationRun, Subscription
from app.services.gateway_reconciliation import run_gateway_reconciliation

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _client(db, email="recon@test.example") -> Client:
    c = Client(name="R", email=email, api_key=f"key-{email}")
    db.add(c)
    db.flush()
    return c


def _plan(db) -> Plan:
    p = Plan(
        name="Standard",
        slug="std-recon",
        monthly_price_cents=94900,
        annual_price_cents=910800,
        credits_per_month=10_000,
        included_operator_seats=2,
        is_active=True,
    )
    db.add(p)
    db.flush()
    return p


def _run(db, *, payments=(), subscriptions=()):
    return run_gateway_reconciliation(
        db,
        fetch_captured_payments=lambda window_from, window_to: list(payments),
        fetch_gateway_subscriptions=lambda: list(subscriptions),
    )


def test_clean_state_reports_no_deltas(db):
    client = _client(db)
    inv = Invoice(
        client_id=client.id,
        amount_cents=94900,
        currency="inr",
        status="paid",
        kind="plan_charge",
        razorpay_payment_id="pay_recon_ok",
        paid_at=datetime.now(UTC),
    )
    db.add(inv)
    db.flush()
    db.add(
        CreditLedger(
            client_id=client.id,
            delta=10_000,
            reason="plan_grant",
            reference_id=inv.id,
        )
    )
    db.flush()

    report = _run(db, payments=[{"id": "pay_recon_ok", "status": "captured", "amount": 94900}])
    assert report["delta_count"] == 0


def test_captured_payment_without_invoice_is_a_delta(db):
    _client(db)
    report = _run(
        db,
        payments=[
            {"id": "pay_recon_ghost", "status": "captured", "amount": 94900, "notes": {"oyechats_client_id": "1"}}
        ],
    )
    assert report["delta_count"] == 1
    assert report["deltas"]["captured_payment_without_invoice"] == ["pay_recon_ghost"]


def test_plan_charge_without_grant_is_a_delta(db):
    client = _client(db)
    inv = Invoice(
        client_id=client.id,
        amount_cents=94900,
        currency="inr",
        status="paid",
        kind="plan_charge",
        razorpay_payment_id="pay_recon_nogrant",
        paid_at=datetime.now(UTC),
    )
    db.add(inv)
    db.flush()

    report = _run(db, payments=[{"id": "pay_recon_nogrant", "status": "captured", "amount": 94900}])
    assert report["deltas"]["plan_charge_without_grant"] == [inv.id]


def test_seat_and_withheld_invoices_need_no_grant(db):
    client = _client(db)
    for kind, pay_id in (("seat", "pay_recon_seat"), ("withheld_charge", "pay_recon_wh")):
        db.add(
            Invoice(
                client_id=client.id,
                amount_cents=49900,
                currency="inr",
                status="paid",
                kind=kind,
                razorpay_payment_id=pay_id,
                paid_at=datetime.now(UTC),
            )
        )
    db.flush()
    report = _run(
        db,
        payments=[
            {"id": "pay_recon_seat", "status": "captured", "amount": 49900},
            {"id": "pay_recon_wh", "status": "captured", "amount": 49900},
        ],
    )
    assert report["delta_count"] == 0


def test_gateway_active_with_terminal_local_row_is_a_delta(db):
    client = _client(db)
    plan = _plan(db)
    db.add(
        Subscription(
            client_id=client.id,
            plan_id=plan.id,
            status="canceled",
            billing_cycle="monthly",
            operator_quantity=1,
            payment_provider="razorpay",
            razorpay_subscription_id="sub_recon_zombie",
            canceled_at=datetime.now(UTC),
        )
    )
    db.flush()
    report = _run(db, subscriptions=[{"id": "sub_recon_zombie", "status": "active"}])
    # A live mandate billing a dead local row: money leaves, no service.
    assert report["deltas"]["gateway_active_local_terminal"] == ["sub_recon_zombie"]


def test_gateway_sub_unknown_locally_is_a_delta(db):
    report = _run(db, subscriptions=[{"id": "sub_recon_alien", "status": "active"}])
    assert report["deltas"]["gateway_sub_without_local"] == ["sub_recon_alien"]


def test_local_active_with_dead_gateway_sub_is_a_delta(db):
    client = _client(db)
    plan = _plan(db)
    db.add(
        Subscription(
            client_id=client.id,
            plan_id=plan.id,
            status="active",
            billing_cycle="monthly",
            operator_quantity=1,
            payment_provider="razorpay",
            razorpay_subscription_id="sub_recon_dead_gw",
        )
    )
    db.flush()
    report = _run(db, subscriptions=[{"id": "sub_recon_dead_gw", "status": "cancelled"}])
    # Service continues locally while the mandate is dead at the gateway.
    assert report["deltas"]["local_active_gateway_dead"] == ["sub_recon_dead_gw"]


def test_authenticated_deferred_sub_is_live_not_a_zombie(db):
    # A promo/deferred-start sub sits in `authenticated` at the gateway with an
    # ACTIVE local row — that is the designed state, not a delta.
    client = _client(db)
    plan = _plan(db)
    db.add(
        Subscription(
            client_id=client.id,
            plan_id=plan.id,
            status="active",
            billing_cycle="monthly",
            operator_quantity=1,
            payment_provider="razorpay",
            razorpay_subscription_id="sub_recon_authd",
        )
    )
    db.flush()
    report = _run(db, subscriptions=[{"id": "sub_recon_authd", "status": "authenticated"}])
    assert report["delta_count"] == 0


def test_report_is_persisted_with_delta_count(db):
    _client(db)
    report = _run(
        db,
        payments=[
            {"id": "pay_recon_persist", "status": "captured", "amount": 100, "notes": {"oyechats_client_id": "1"}}
        ],
    )
    assert report["delta_count"] == 1
    row = db.query(ReconciliationRun).order_by(ReconciliationRun.id.desc()).first()
    assert row is not None
    assert row.delta_count == 1
    assert row.report["deltas"]["captured_payment_without_invoice"] == ["pay_recon_persist"]


def test_fetch_failure_is_reported_not_raised(db):
    def _boom(window_from, window_to):
        raise RuntimeError("gateway 503")

    report = run_gateway_reconciliation(
        db,
        fetch_captured_payments=_boom,
        fetch_gateway_subscriptions=lambda: [],
    )
    # A fetch failure is a monitoring gap, not a crash — reported as its own
    # delta so silence still means "nothing is wrong".
    assert "payments_fetch_failed" in report["deltas"]
    assert report["delta_count"] >= 1


def test_unattributed_payment_is_a_soft_delta_not_an_alert(db):
    # A ₹1 smoke-test charge or dashboard payment link carries no oyechats_*
    # notes — reported for visibility, but never allowed to poison the ERROR
    # alert with false accusations.
    _client(db)
    report = _run(db, payments=[{"id": "pay_recon_foreign", "status": "captured", "amount": 100, "notes": {}}])
    assert report["delta_count"] == 0
    assert report["soft_deltas"]["captured_payment_unattributed"] == ["pay_recon_foreign"]


def test_seat_addon_subscription_is_known_locally(db):
    # Seat add-ons are real gateway subscriptions stored in
    # seat_addon_subscription_id — they must NOT flag as unknown (that was a
    # guaranteed daily false positive per seated customer).
    client = _client(db)
    plan = _plan(db)
    db.add(
        Subscription(
            client_id=client.id,
            plan_id=plan.id,
            status="active",
            billing_cycle="monthly",
            operator_quantity=3,
            payment_provider="razorpay",
            razorpay_subscription_id="sub_recon_main",
            seat_addon_subscription_id="sub_recon_seataddon",
        )
    )
    db.flush()
    report = _run(
        db,
        subscriptions=[
            {"id": "sub_recon_main", "status": "active"},
            {"id": "sub_recon_seataddon", "status": "active"},
        ],
    )
    assert report["delta_count"] == 0


def test_delta_lists_are_capped(db):
    _client(db)
    payments = [
        {"id": f"pay_recon_bulk_{i}", "status": "captured", "amount": 100, "notes": {"oyechats_client_id": "1"}}
        for i in range(150)
    ]
    report = _run(db, payments=payments)
    bucket = report["deltas"]["captured_payment_without_invoice"]
    assert len(bucket) == 101
    assert bucket[-1] == "... and 50 more"


# ── Cron wrapper + SDK fetchers ──────────────────────────────────────────────


def test_cron_wrapper_runs_the_reconciliation(db, monkeypatch):
    import asyncio
    from contextlib import contextmanager

    from app.worker import tasks as worker_tasks

    @contextmanager
    def _cm():
        yield db

    import app.db.session as db_session_module

    monkeypatch.setattr(db_session_module, "get_session", _cm)

    import app.services.gateway_reconciliation as recon

    monkeypatch.setattr(
        recon,
        "_fetch_captured_payments_sdk",
        lambda window_from, window_to: [
            {"id": "pay_recon_cron", "status": "captured", "amount": 100, "notes": {"oyechats_client_id": "1"}}
        ],
    )
    monkeypatch.setattr(recon, "_fetch_gateway_subscriptions_sdk", lambda: [])

    deltas = asyncio.run(worker_tasks.task_gateway_reconciliation({}))
    assert deltas == 1  # the ghost payment above
    assert db.query(ReconciliationRun).count() >= 1


class _FakeCollection:
    def __init__(self, pages):
        self._pages = pages
        self.calls = []

    def all(self, params):
        self.calls.append(dict(params))
        skip = params.get("skip", 0)
        count = params.get("count", 100)
        page = skip // count
        items = self._pages[page] if page < len(self._pages) else []
        return {"items": items}


def test_sdk_payment_fetcher_paginates_and_filters_captured(monkeypatch):
    from datetime import UTC, datetime

    import app.services.gateway_reconciliation as recon

    page1 = [{"id": f"pay_{i}", "status": "captured"} for i in range(100)]
    page2 = [{"id": "pay_authorized", "status": "authorized"}, {"id": "pay_last", "status": "captured"}]
    fake_payments = _FakeCollection([page1, page2])

    class _FakeClient:
        payment = fake_payments

    monkeypatch.setattr("app.services.razorpay_service._get_razorpay", lambda: _FakeClient())

    window_to = datetime.now(UTC)
    window_from = window_to
    items = recon._fetch_captured_payments_sdk(window_from, window_to)

    assert len(items) == 101  # authorized filtered out
    assert all(p["status"] == "captured" for p in items)
    assert len(fake_payments.calls) == 2  # stopped after the short page
    assert fake_payments.calls[0]["from"] == int(window_from.timestamp())
    assert fake_payments.calls[1]["skip"] == 100


def test_sdk_subscription_fetcher_paginates(monkeypatch):
    import app.services.gateway_reconciliation as recon

    page1 = [{"id": f"sub_{i}", "status": "active"} for i in range(100)]
    page2 = [{"id": "sub_tail", "status": "cancelled"}]
    fake_subs = _FakeCollection([page1, page2])

    class _FakeClient:
        subscription = fake_subs

    monkeypatch.setattr("app.services.razorpay_service._get_razorpay", lambda: _FakeClient())

    items = recon._fetch_gateway_subscriptions_sdk()
    assert len(items) == 101
    assert len(fake_subs.calls) == 2


def test_subscriptions_fetch_failure_is_reported_not_raised(db):
    def _boom():
        raise RuntimeError("gateway 503")

    report = run_gateway_reconciliation(
        db,
        fetch_captured_payments=lambda window_from, window_to: [],
        fetch_gateway_subscriptions=_boom,
    )
    assert "subscriptions_fetch_failed" in report["deltas"]
    assert report["delta_count"] >= 1
