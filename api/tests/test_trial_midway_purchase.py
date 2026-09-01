"""Buying mid-trial: mandate now, first debit at day 14, entitlements instantly.

The billing clock never moves. A customer who pays on day 3 is not charged on
day 3 and then again a month later; the mandate is minted with Razorpay's
``start_at`` set to their trial end, so the eleven days they were promised stay
free. What they DO get immediately is the plan they bought, because the whole
point of paying early is to stop being limited.

That combination is the harvest risk this file also pins: entitlements and
credits ahead of any payment. It is closed at the other end, in the
cancellation handler, which forfeits the unspent remainder and converts the
account to Free rather than leaving it in limbo.

Its own throwaway database, mirroring tests/test_merge_promo_resume_regressions.py,
because it drives the real webhook handler.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, make_url
from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session

from app.db.models import Base, Client, Plan, Subscription
from app.services import credit_service
from app.services import razorpay_service as rzp

_TEST_DB_SUFFIX = "_trialbuytest"

_BASE_URL = make_url(os.getenv("DB_URL")) if os.getenv("DB_URL") else None

pytestmark = pytest.mark.skipif(_BASE_URL is None, reason="needs a reachable Postgres at DB_URL")


@pytest.fixture(scope="module")
def pg_engine():
    test_db = (_BASE_URL.database or "postgres") + _TEST_DB_SUFFIX
    admin = create_engine(_BASE_URL.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{test_db}" WITH (FORCE)')
        conn.exec_driver_sql(f'CREATE DATABASE "{test_db}"')
    admin.dispose()

    engine = create_engine(_BASE_URL.set(database=test_db))
    with engine.connect() as conn:
        conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS citext")
        conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")
        conn.commit()
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()

    admin = create_engine(_BASE_URL.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{test_db}" WITH (FORCE)')
    admin.dispose()


@pytest.fixture()
def db(pg_engine):
    session = Session(pg_engine)
    yield session
    session.rollback()
    names = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    session.execute(sa_text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))
    session.commit()
    session.close()


def _client(db, email="trialbuy@e.com") -> Client:
    c = Client(name="C", email=email, api_key=f"k-{email}", hashed_password="h")
    db.add(c)
    db.flush()
    return c


def _plan(db, slug: str, *, credits: int, trial_days: int = 0, price: int = 119900) -> Plan:
    p = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=0 if trial_days else price,
        annual_price_cents=0 if trial_days else price * 10,
        credits_per_month=credits,
        included_operator_seats=1,
        trial_days=trial_days,
        is_active=True,
        is_public=not trial_days,
        limits={"bots": 1, "credits": credits},
        features={},
        razorpay_plan_id_monthly=f"plan_{slug}_m",
        razorpay_plan_id_annual=f"plan_{slug}_a",
    )
    db.add(p)
    db.flush()
    return p


def _trialing(db, client: Client, trial: Plan, *, days_left: int = 11) -> Subscription:
    now = datetime.now(UTC)
    sub = Subscription(
        client_id=client.id,
        plan_id=trial.id,
        bot_id=None,
        status="trialing",
        billing_cycle="monthly",
        operator_quantity=1,
        current_period_start=now - timedelta(days=14 - days_left),
        current_period_end=now + timedelta(days=days_left),
        trial_start=now - timedelta(days=14 - days_left),
        trial_end=now + timedelta(days=days_left),
        payment_provider="manual",
    )
    sub.plan = trial
    db.add(sub)
    db.flush()
    credit_service.grant_for_subscription(db, sub)
    db.flush()
    return sub


def _activation_payload(*, client: Client, plan: Plan, start_at: datetime, conversion: bool, sub_id: str) -> dict:
    notes = {
        "oyechats_client_id": str(client.id),
        "oyechats_plan_id": str(plan.id),
        "billing_cycle": "monthly",
    }
    if conversion:
        notes["oyechats_trial_conversion"] = "1"
    return {
        "subscription": {
            "entity": {
                "id": sub_id,
                "notes": notes,
                "start_at": int(start_at.timestamp()),
                "quantity": 1,
                "customer_id": "cust_trialbuy",
            }
        }
    }


# ── The deferred start ───────────────────────────────────────────────────────


def test_trialing_checkout_start_at_is_the_later_of_trial_end_promo_and_a_48h_floor():
    """The billing clock never moves, but only if the gateway accepts the date.

    Three inputs, all customer-favourable: the trial's own end, any promo free
    period that was already consumed, and a 48-hour floor for eMandate and UPI
    pre-debit notice. A day-13 buyer gets billing at now+48h, i.e. up to a day
    of extra grace, rather than a date Razorpay would refuse.
    """
    from app.api.subscription_routes import resolve_trial_defer_at

    now = datetime(2026, 9, 1, tzinfo=UTC)
    trial_end = now + timedelta(days=11)
    assert resolve_trial_defer_at(trial_end=trial_end, promo_start_at=None, now=now) == trial_end

    later_promo = now + timedelta(days=40)
    assert resolve_trial_defer_at(trial_end=trial_end, promo_start_at=later_promo, now=now) == later_promo

    earlier_promo = now + timedelta(days=2)
    assert resolve_trial_defer_at(trial_end=trial_end, promo_start_at=earlier_promo, now=now) == trial_end

    # Day 13: the trial ends in under 48 hours, so the floor wins.
    soon = now + timedelta(hours=6)
    assert resolve_trial_defer_at(trial_end=soon, promo_start_at=None, now=now) == now + timedelta(hours=48)


def test_a_trial_that_has_already_lapsed_defers_nothing():
    """Past trial_end there is nothing to protect; charge normally."""
    from app.api.subscription_routes import resolve_trial_defer_at

    now = datetime(2026, 9, 1, tzinfo=UTC)
    assert resolve_trial_defer_at(trial_end=now - timedelta(days=1), promo_start_at=None, now=now) is None
    assert resolve_trial_defer_at(trial_end=None, promo_start_at=None, now=now) is None


# ── Grant at authentication ──────────────────────────────────────────────────


def test_conversion_marked_auth_grants_once_and_the_existing_sweep_retires_the_trial(db):
    """Entitlements land at authentication, and no second retirement path exists.

    The activation handler already sweeps and cancels the sibling account row,
    explicitly including a trialing one. This asserts that existing behaviour
    rather than adding to it.
    """
    client = _client(db)
    trial = _plan(db, "trial", credits=500, trial_days=14)
    paid = _plan(db, "standard", credits=2500)
    old = _trialing(db, client, trial)
    db.flush()

    rzp._handle_subscription_activated(
        db,
        _activation_payload(client=client, plan=paid, start_at=old.trial_end, conversion=True, sub_id="sub_conv_1"),
    )
    db.flush()

    bought = db.query(Subscription).filter(Subscription.razorpay_subscription_id == "sub_conv_1").one()
    db.refresh(old)

    assert old.status == "canceled", "the existing sweep must retire the trial row"
    assert bought.status == "active", "entitlements are instant, that is what paying early buys"
    assert bought.plan_id == paid.id
    # The purchased plan's credits ON TOP of the trial's unspent remainder.
    # Converting used to zero the trial grant, so a customer three days into a
    # 14-day trial lost what was left of it on the day they paid. The remainder
    # expires at the trial's own end and is ordered ahead of the paid grant, so
    # it is spent first and cannot outlive its window.
    assert credit_service.get_balance(db, client.id) == 2500 + 500
    assert bought.last_granted_period_end is not None, "the grant-once marker must be set"


def test_the_grant_marker_is_the_period_the_first_charge_will_present(db):
    """``charged``, not ``activated``, is what grants a deferred subscription.

    So the marker set at authentication has to name the period that first debit
    carries, and Razorpay sends ``current_start = start_at`` with
    ``current_end = start_at + one interval``. Keyed on ``start_at`` itself the
    marker sits a whole interval behind what the charge presents, far outside
    ``_PERIOD_KEY_TOLERANCE``, so the day-14 debit resets the allowance the
    customer just bought and grants a second one.

    Asserted on the marker rather than by replaying a charge, because plan
    credits are use-it-or-lose-it: a re-grant resets and re-grants the same
    number, so neither the balance nor a naive replay distinguishes the two.
    """
    from app.core.dates import add_months

    client = _client(db, email="trialbuy-marker@e.com")
    trial = _plan(db, "trial", credits=500, trial_days=14)
    paid = _plan(db, "standard", credits=2500)
    old = _trialing(db, client, trial)
    db.flush()
    start_at = old.trial_end
    if start_at.tzinfo is None:
        start_at = start_at.replace(tzinfo=UTC)

    rzp._handle_subscription_activated(
        db,
        _activation_payload(client=client, plan=paid, start_at=start_at, conversion=True, sub_id="sub_conv_2"),
    )
    db.flush()
    bought = db.query(Subscription).filter(Subscription.razorpay_subscription_id == "sub_conv_2").one()

    marker = bought.last_granted_period_end
    assert marker is not None, "the grant-once marker must be set at authentication"
    if marker.tzinfo is None:
        marker = marker.replace(tzinfo=UTC)
    # ``start_at`` round-trips through a unix timestamp, so compare at second
    # resolution rather than chasing microseconds.
    expected = add_months(start_at.replace(microsecond=0), 1)
    marker = marker.replace(microsecond=0)
    assert marker == expected, (
        f"marker {marker.isoformat()} is not the period the first charge presents "
        f"({expected.isoformat()}); the day-14 debit will re-grant"
    )
    # And it is strictly later than start_at, which is the shape of the bug.
    assert marker > start_at.replace(microsecond=0)


def test_cancel_before_the_first_charge_forfeits_and_converts_to_free(db):
    """The buy-burn-cancel harvest, closed, and the limbo it used to leave.

    A conversion-marked mandate cancelled before it ever billed has been given
    credits it did not pay for. The unspent remainder is forfeited and the
    account lands on Free, rather than sitting outside both the expiry sweep
    (which filters trialing) and /auth/me's trial payload.
    """
    client = _client(db)
    trial = _plan(db, "trial", credits=500, trial_days=14)
    paid = _plan(db, "standard", credits=2500)
    _plan(db, "free", credits=200, price=0)
    old = _trialing(db, client, trial)
    db.flush()

    rzp._handle_subscription_activated(
        db,
        _activation_payload(client=client, plan=paid, start_at=old.trial_end, conversion=True, sub_id="sub_conv_3"),
    )
    db.flush()
    # Trial remainder survives a PAID conversion, so the activation balance is
    # the plan's credits plus what the trial had left.
    assert credit_service.get_balance(db, client.id) == 2500 + 500

    rzp._handle_subscription_cancelled(db, {"subscription": {"entity": {"id": "sub_conv_3", "notes": {}}}})
    db.flush()

    free_sub = (
        db.query(Subscription)
        .filter(Subscription.client_id == client.id, Subscription.status == "active")
        .one_or_none()
    )
    assert free_sub is not None, "a cancelled unbilled conversion must not leave the account in limbo"
    assert free_sub.plan.slug == "free"
    assert credit_service.get_balance(db, client.id) == 200, "the unpaid-for remainder must be forfeited"


def test_auth_me_describes_a_deferred_purchase_instead_of_a_countdown(db):
    """The card state the artifact calls for: "Standard starts in N days".

    A customer who has already bought must not be shown a trial countdown next
    to an Upgrade button they have pressed. The payload carries the plan they
    bought and when its billing starts.
    """
    from app.api.auth_routes import _build_trial_payload

    client = _client(db, email="trialbuy-me@e.com")
    trial = _plan(db, "trial", credits=500, trial_days=14)
    paid = _plan(db, "standard", credits=2500)
    old = _trialing(db, client, trial)
    db.flush()

    before = _build_trial_payload(db, client.id)
    assert before is not None
    assert before.paid_plan_starts_at is None, "nothing bought yet"
    # The trial's LENGTH, from the plan row. The console divides the days left
    # by it to decide whether days or credits are the binding constraint, and
    # it used to hardcode 14 for that denominator while reading the numerator
    # from this payload. A super-admin retuning ``plans.trial_days`` would then
    # have mis-classified every account, silently and forever.
    assert before.trial_days == 14
    assert before.status == "trialing"

    rzp._handle_subscription_activated(
        db,
        _activation_payload(client=client, plan=paid, start_at=old.trial_end, conversion=True, sub_id="sub_conv_me"),
    )
    db.flush()
    # The sweep retires the trial row: one account-level row per client may sit
    # in the active set, so there is no trialing row left to read. The payload
    # has to come from the PURCHASED row, which is the whole point of this case.
    db.refresh(old)
    assert old.status == "canceled"

    after = _build_trial_payload(db, client.id)
    assert after is not None
    assert after.paid_plan_name == "Standard"
    # The DATE, not merely its presence. It must be the deferred start, the day
    # the customer is first charged, and NOT the grant marker, which is that
    # day plus one billing interval: reading the marker told a buyer eleven
    # days from their first debit that their plan started in forty-one.
    trial_end = old.trial_end
    if trial_end.tzinfo is None:
        trial_end = trial_end.replace(tzinfo=UTC)
    assert after.paid_plan_starts_at is not None
    starts = datetime.fromisoformat(after.paid_plan_starts_at)
    assert abs((starts - trial_end).total_seconds()) < 2, (
        f"paid_plan_starts_at {starts.isoformat()} is not the trial end {trial_end.isoformat()}"
    )
    assert after.days_remaining is not None and after.days_remaining <= 11
    # The status the console's bought state actually receives. This branch is
    # reachable only through an ``active`` row and returns that row's status,
    # so a browser test that mocked ``trialing`` here was asserting against a
    # payload no account can produce.
    assert after.status == "active"
    assert after.trial_end_at is not None
    # The purchased row is a paid tier, not a trial, so its length is zero.
    assert after.trial_days == 0


def test_verify_and_the_webhook_are_the_same_function_and_idempotent(db):
    """The plan's decision: verify is the fast path, the webhook the backstop.

    Both go through ``_handle_subscription_activated``; ``verify`` reaches it
    via ``reconcile_subscription_from_razorpay`` under a synthetic idempotency
    key. So there is one conversion routine, and a double delivery grants once.
    """
    import inspect

    source = inspect.getsource(rzp.reconcile_subscription_from_razorpay)
    assert "_handle_subscription_activated(session, synthetic_payload" in source, (
        "verify must reconcile through the same handler the webhook uses"
    )

    client = _client(db, email="trialbuy-idem@e.com")
    trial = _plan(db, "trial", credits=500, trial_days=14)
    paid = _plan(db, "standard", credits=2500)
    old = _trialing(db, client, trial)
    db.flush()

    payload = _activation_payload(
        client=client, plan=paid, start_at=old.trial_end, conversion=True, sub_id="sub_conv_idem"
    )
    rzp._handle_subscription_activated(db, payload)
    db.flush()
    once = credit_service.get_balance(db, client.id)

    # Redelivery of the very same event.
    rzp._handle_subscription_activated(db, payload)
    db.flush()
    assert credit_service.get_balance(db, client.id) == once, "a redelivered activation granted twice"


def test_the_paid_plan_card_stops_once_billing_has_actually_started(db):
    """ "Standard starts in N days" must not be true forever.

    The grant marker is written once and never cleared, and
    ``last_granted_period_end`` rolls forward on every renewal, so gating on
    those alone left a customer who bought in September being told in March
    that their plan starts in 29 days, with the Upgrade action suppressed.
    """
    from datetime import timedelta

    from app.api.auth_routes import _build_trial_payload

    client = _client(db, email="trialbuy-stale@e.com")
    trial = _plan(db, "trial", credits=500, trial_days=14)
    paid = _plan(db, "standard", credits=2500)
    old = _trialing(db, client, trial)
    db.flush()

    rzp._handle_subscription_activated(
        db,
        _activation_payload(client=client, plan=paid, start_at=old.trial_end, conversion=True, sub_id="sub_conv_stale"),
    )
    db.flush()
    bought = db.query(Subscription).filter(Subscription.razorpay_subscription_id == "sub_conv_stale").one()
    assert _build_trial_payload(db, client.id) is not None

    # Months later: billing has started and the marker has rolled forward.
    bought.current_period_start = datetime.now(UTC) - timedelta(days=150)
    bought.last_granted_period_end = datetime.now(UTC) + timedelta(days=29)
    db.flush()

    assert _build_trial_payload(db, client.id) is None, (
        "a long-paying account is still being shown a trial-conversion card"
    )


def test_change_plan_defers_the_first_debit_for_a_mid_trial_buyer(db, monkeypatch):
    """The route, not the helper.

    ``resolve_trial_defer_at`` has four unit tests and they all passed while the
    feature was broken, because the console routes a trialing customer's plan
    pick to ``/change-plan`` rather than ``/checkout`` and that call site did not
    exist. This drives the endpoint and asserts on what reaches Razorpay: a
    future ``start_at`` and the conversion note that earns the grant at
    authentication and the forfeit that balances it.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import auth as auth_dep
    from app.api import subscription_routes as sr

    client = _client(db, email="changeplan-defer@e.com")
    # A real mid-trial buyer has verified; the route gates on it.
    client.is_verified = True
    db.flush()
    db.commit()
    trial = _plan(db, "trial", credits=500, trial_days=14, price=0)
    standard = _plan(db, "standard", credits=2500)
    sub = _trialing(db, client, trial, days_left=11)

    captured: dict = {}

    def _fake_create_subscription(session, cl, plan, cycle, *, start_at=None, extra_notes=None, **kw):
        captured["start_at"] = start_at
        captured["notes"] = extra_notes
        return {"subscription_id": "sub_deferred_test", "short_url": "https://rzp.test/x"}

    monkeypatch.setattr(rzp, "create_subscription", _fake_create_subscription)

    app = FastAPI()
    app.include_router(sr.router)
    app.dependency_overrides[auth_dep.get_current_client] = lambda: client
    app.dependency_overrides[auth_dep.get_current_client_strict] = lambda: client

    from contextlib import contextmanager

    @contextmanager
    def _session_cm():
        yield db

    monkeypatch.setattr(sr, "get_session", _session_cm)

    api = TestClient(app, raise_server_exceptions=False)
    res = api.post("/subscriptions/change-plan", json={"plan_id": standard.id, "billing_cycle": "monthly"})

    assert res.status_code in (200, 201, 202), res.text
    # The billing clock never moves: the debit is the trial's own end, which is
    # in the future and well past the 48h floor at 11 days out.
    assert captured["start_at"] is not None, "mid-trial change-plan charged immediately"
    assert captured["start_at"] > int(datetime.now(UTC).timestamp())
    assert abs(captured["start_at"] - int(sub.trial_end.timestamp())) <= 1
    # The note is what makes the grant-at-auth and the forfeit-on-cancel fire.
    assert (captured["notes"] or {}).get(sr.TRIAL_CONVERSION_NOTE) == "1"


def test_the_silent_conversion_tells_the_customer(db, monkeypatch):
    """Cancelling an unbilled conversion moved the account to Free in silence.

    The day-15 path emails (``worker/tasks.py`` sends ``send_trial_ended_email``
    on every conversion it makes). This path makes the same conversion, for a
    customer who went further than most by authorising a mandate, and said
    nothing: their credits dropped and their knowledge paused with no message.
    Same email, same reason, so the two conversions read identically.
    """
    sent: list[dict] = []
    from app.services import email_service

    monkeypatch.setattr(
        email_service,
        "send_trial_ended_email",
        lambda to_email, **kw: sent.append({"to": to_email, **kw}),
    )

    client = _client(db, email="silent-convert@e.com")
    standard = _plan(db, "standard", credits=2500)
    free = _plan(db, "free", credits=200, price=0)
    local = Subscription(
        client_id=client.id,
        plan_id=standard.id,
        status="authenticated",
        billing_cycle="monthly",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_unbilled_cancel",
    )
    local.plan = standard
    db.add(local)
    db.flush()
    db.commit()

    rzp._forfeit_and_convert_to_free(db, local)
    db.commit()

    assert len(sent) == 1, "an unbilled conversion cancel converted the account in silence"
    assert sent[0]["to"] == client.email
    assert sent[0]["plan_name"] == free.name
