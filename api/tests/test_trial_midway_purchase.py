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
    # The purchased plan's credits, not the trial's leftovers carried forward.
    assert credit_service.get_balance(db, client.id) == 2500
    assert bought.last_granted_period_end is not None, "the grant-once marker must be set"


def test_the_day14_charge_does_not_regrant(db):
    """``charged``, not ``activated``, is the event that grants a deferred sub.

    The marker set at authentication is what makes the first real debit a
    no-op rather than a second month of credits.
    """
    client = _client(db)
    trial = _plan(db, "trial", credits=500, trial_days=14)
    paid = _plan(db, "standard", credits=2500)
    old = _trialing(db, client, trial)
    db.flush()

    rzp._handle_subscription_activated(
        db,
        _activation_payload(client=client, plan=paid, start_at=old.trial_end, conversion=True, sub_id="sub_conv_2"),
    )
    db.flush()
    balance_after_auth = credit_service.get_balance(db, client.id)
    bought = db.query(Subscription).filter(Subscription.razorpay_subscription_id == "sub_conv_2").one()

    charged = {
        "subscription": {
            "entity": {
                "id": "sub_conv_2",
                "notes": {
                    "oyechats_client_id": str(client.id),
                    "oyechats_plan_id": str(paid.id),
                    "oyechats_trial_conversion": "1",
                    "billing_cycle": "monthly",
                },
                "current_start": int(bought.current_period_start.timestamp())
                if bought.current_period_start
                else int(datetime.now(UTC).timestamp()),
                "current_end": int(bought.last_granted_period_end.timestamp()),
                "quantity": 1,
                "customer_id": "cust_trialbuy",
            }
        },
        "payment": {"entity": {"id": "pay_conv_2", "amount": 119900, "status": "captured"}},
    }
    rzp._handle_subscription_charged(db, charged)
    db.flush()

    assert credit_service.get_balance(db, client.id) == balance_after_auth, "the first debit re-granted"


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
    assert credit_service.get_balance(db, client.id) == 2500

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
    assert after.paid_plan_starts_at is not None


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
