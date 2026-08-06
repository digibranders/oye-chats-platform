"""Regression tests for the steve-merge resolution of ``_handle_subscription_activated``.

Two defects the merge review caught in the hand-resolved unification of the
promo / resume / revive activation paths (merge 54ba298):

1. **Immediate per-bot resume must NOT take the bot-scoped early return.** The
   bot-scoped grant branch (new per-bot purchase / revive-in-place) returns
   before ``apply_pending_proration`` and the deferred gateway-cancel loop. A
   per-bot ``/subscriptions/resume`` with no paid time left (Mode 2) parks the
   bot's unused plan credits in ``upgrade_credit_pending_cents`` expecting the
   activation to re-grant them as a top-up; early-returning lets the new
   period's reset destroy that snapshot.

2. **A promo activation must NOT inherit the swept sibling's period/marker.**
   The future-``start_at`` carry exists for the deferred-start RESUME (the
   customer already paid through ``start_at``). A promo sub also starts in the
   future, but sweeping a trialing/comped account row must not carry its
   ``current_period_end`` (the renewal cron would chase the promo row daily) or
   its ``last_granted_period_end`` (within the 4-day period-key tolerance it
   no-ops the promo's month-1 grant — zero credits for the whole free window).
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, make_url
from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session

from app.db.models import Base, Bot, Client, Plan, Promotion, Subscription
from app.services import credit_service
from app.services import razorpay_service as rzp

_TEST_DB_SUFFIX = "_mergeregrtest"


def _server_url():
    raw = os.getenv("DB_URL")
    return make_url(raw) if raw else None


def _server_reachable(url) -> bool:
    try:
        engine = create_engine(url, connect_args={"connect_timeout": 2})
        with engine.connect():
            pass
        engine.dispose()
        return True
    except Exception:
        return False


_BASE_URL = _server_url()

pytestmark = pytest.mark.skipif(
    _BASE_URL is None or not _server_reachable(_BASE_URL),
    reason="needs a reachable Postgres at DB_URL",
)


@pytest.fixture(scope="module")
def pg_engine():
    test_db = (_BASE_URL.database or "postgres") + _TEST_DB_SUFFIX
    admin = create_engine(_BASE_URL.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{test_db}"')
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
        conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{test_db}"')
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


def _client(db) -> Client:
    c = Client(name="C", email="mergeregr@e.com", api_key="k-mergeregr", hashed_password="h")
    db.add(c)
    db.flush()
    return c


def _plan(db, *, credits=10_000) -> Plan:
    p = Plan(
        name="Standard",
        slug="std-mergeregr",
        monthly_price_cents=94900,
        annual_price_cents=910800,
        credits_per_month=credits,
        included_operator_seats=2,
        is_active=True,
        razorpay_plan_id_monthly="plan_mergeregr_monthly",
        razorpay_plan_id_annual="plan_mergeregr_annual",
    )
    db.add(p)
    db.flush()
    return p


def test_immediate_per_bot_resume_applies_pending_proration(db):
    """Mode-2 resume (mandate dead, no paid time left) re-grants the parked rollover."""
    client = _client(db)
    plan = _plan(db, credits=10_000)

    bot = Bot(client_id=client.id, name="Support Bot", bot_key="bot-mergeregr-1")
    db.add(bot)
    db.flush()

    old_period_end = datetime.now(UTC) - timedelta(days=1)
    old_sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot.id,
        status="canceled",
        billing_cycle="monthly",
        operator_quantity=1,
        current_period_start=old_period_end - timedelta(days=30),
        current_period_end=old_period_end,
        payment_provider="razorpay",
        razorpay_subscription_id="sub_old_resume_regr",
        # The route's Mode-2 snapshot: unused plan credits parked for rollover.
        upgrade_credit_pending_cents=4_000,
    )
    db.add(old_sub)
    db.flush()

    # The bot's ledger still holds the old plan's unused credits — the live
    # figure ``apply_pending_proration`` clamps the snapshot against.
    credit_service.grant_subscription_period_once(db, old_sub, old_period_end)
    db.flush()
    assert credit_service.get_balance(db, client.id, bot_id=bot.id) == 10_000

    now = datetime.now(UTC)
    payload = {
        "subscription": {
            "entity": {
                "id": "sub_new_resume_regr",
                "notes": {
                    "oyechats_client_id": str(client.id),
                    "oyechats_plan_id": str(plan.id),
                    "oyechats_bot_id": str(bot.id),
                    "prev_razorpay_subscription_id": "sub_old_resume_regr",
                    "billing_cycle": "monthly",
                },
                # Immediate start: billing began at authorization.
                "start_at": int((now - timedelta(minutes=5)).timestamp()),
                "current_start": int(now.timestamp()),
                "current_end": int((now + timedelta(days=30)).timestamp()),
                "quantity": 1,
                "customer_id": "cust_mergeregr",
            }
        }
    }
    with patch.object(rzp, "cancel_subscription"):
        rzp._handle_subscription_activated(db, payload)
    db.flush()

    new_sub = db.query(Subscription).filter(Subscription.razorpay_subscription_id == "sub_new_resume_regr").one()
    assert new_sub.bot_id == bot.id

    # The rollover snapshot must be consumed, not stranded...
    db.refresh(old_sub)
    assert old_sub.upgrade_credit_pending_cents == 0
    # ...and re-granted on top of the new period's plan grant: 10,000 plan
    # credits + 4,000 rollover top-up. The pre-fix early return skipped
    # ``apply_pending_proration`` entirely, leaving exactly 10,000.
    assert credit_service.get_balance(db, client.id, bot_id=bot.id) == 14_000


def test_promo_activation_does_not_inherit_swept_sibling_period_or_marker(db):
    """A promo sub sweeps the old comped/trial row but carries NOTHING from it."""
    client = _client(db)
    plan = _plan(db, credits=10_000)

    promo = Promotion(
        code="LAUNCH3-REGR",
        name="Launch offer",
        starts_at=datetime.now(UTC) - timedelta(days=7),
        ends_at=datetime.now(UTC) + timedelta(days=30),
        free_cycles=3,
    )
    db.add(promo)
    db.flush()

    now = datetime.now(UTC)
    # A comped/manual account row granted ahead: its marker lands within the
    # 4-day period-key tolerance AFTER the promo's first free-month boundary
    # (~now+30d), which is exactly the shape that silently no-ops the promo's
    # month-1 grant if the marker is carried.
    old_marker = now + timedelta(days=32)
    comped = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        billing_cycle="monthly",
        operator_quantity=1,
        current_period_start=now - timedelta(days=1),
        current_period_end=old_marker,
        last_granted_period_end=old_marker,
        payment_provider="manual",
        razorpay_subscription_id=None,
    )
    db.add(comped)
    db.flush()

    promo_start_at = now + timedelta(days=90)
    payload = {
        "subscription": {
            "entity": {
                "id": "sub_promo_regr",
                "notes": {
                    "oyechats_client_id": str(client.id),
                    "oyechats_plan_id": str(plan.id),
                    "oyechats_promotion_id": str(promo.id),
                    "billing_cycle": "monthly",
                },
                # Deferred first charge — no current period exists yet.
                "start_at": int(promo_start_at.timestamp()),
                "quantity": 1,
                "customer_id": "cust_mergeregr_promo",
            }
        }
    }
    rzp._handle_subscription_activated(db, payload)
    db.flush()

    promo_sub = db.query(Subscription).filter(Subscription.razorpay_subscription_id == "sub_promo_regr").one()

    # The sibling is swept (superseded), but the promo row inherits nothing:
    db.refresh(comped)
    assert comped.status == "canceled"
    assert promo_sub.current_period_end is None  # not the comped row's date
    assert promo_sub.promotion_id == promo.id
    assert promo_sub.promo_free_until is not None

    # The month-1 grant must land, keyed on the free-month boundary — NOT
    # no-opped by the comped row's carried marker via the 4-day tolerance.
    assert promo_sub.last_granted_period_end is not None
    assert promo_sub.last_granted_period_end <= promo_sub.promo_free_until
    assert credit_service.get_balance(db, client.id) == 10_000
