"""Regression test for the per-bot activation period-marker (finding H-A).

The account-level ``subscription.activated`` path advances
``last_granted_period_end`` (via ``_grant_subscription_period``) so the first
``subscription.charged`` for the same period is a clean no-op. The PER-BOT
branch of :func:`razorpay_service._handle_subscription_activated` instead called
``grant_for_subscription`` directly and returned early, never setting the
marker.

Consequence: the first ``subscription.charged`` sees ``last_granted_period_end
is None``, so ``grant_subscription_period_once`` skips its idempotency guard,
runs ``reset_monthly_plan_credits`` (zeroing whatever the customer already
consumed this period) and grants a SECOND full allowance for the same period.
Silently refunding first-cycle consumption (up to 72,000 credits on an annual
per-bot plan) and erasing the usage audit.

This test drives the real Jan-activate -> consume -> Jan-charge sequence for a
per-bot subscription and asserts (1) the marker is set at activation and
(2) the first charge does not reset or re-grant the period.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, make_url
from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session

from app.db.models import Base, Bot, Client, Plan, Subscription
from app.services import credit_service
from app.services import razorpay_service as rzp

_TEST_DB_SUFFIX = "_perbotmarkertest"


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
    c = Client(name="C", email="perbot@e.com", api_key="k-perbot", hashed_password="h")
    db.add(c)
    db.flush()
    return c


def _plan(db, *, credits=10_000) -> Plan:
    p = Plan(
        name="Standard",
        slug="std-perbot",
        monthly_price_cents=94900,
        annual_price_cents=910800,
        monthly_price_usd_cents=94900,
        credits_per_month=credits,
        included_operator_seats=2,
        is_active=True,
        razorpay_plan_id_monthly="plan_perbot_monthly",
        razorpay_plan_id_annual="plan_perbot_annual",
    )
    db.add(p)
    db.flush()
    return p


def _per_bot_activation_payload(*, razorpay_sub_id, client_id, plan_id, period_start, period_end):
    return {
        "subscription": {
            "entity": {
                "id": razorpay_sub_id,
                "notes": {
                    "oyechats_client_id": str(client_id),
                    "oyechats_plan_id": str(plan_id),
                    "purpose": "per_bot_subscription",
                    "bot_name": "Support Bot",
                },
                "current_start": int(period_start.timestamp()),
                "current_end": int(period_end.timestamp()),
                "quantity": 1,
                "customer_id": "cust_perbot",
            }
        }
    }


def _charged_payload(*, razorpay_sub_id, payment_id, amount_minor, period_start, period_end):
    return {
        "subscription": {
            "entity": {
                "id": razorpay_sub_id,
                "notes": {},
                "current_start": int(period_start.timestamp()),
                "current_end": int(period_end.timestamp()),
                "quantity": 1,
            }
        },
        "payment": {
            "entity": {
                "id": payment_id,
                "amount": amount_minor,
                "currency": "INR",
            }
        },
    }


def test_per_bot_activation_sets_marker_and_first_charge_does_not_regrant(db):
    client = _client(db)
    plan = _plan(db, credits=10_000)

    period_start = datetime(2026, 1, 1, tzinfo=UTC)
    period_end = datetime(2026, 2, 1, tzinfo=UTC)
    rzp_sub_id = "sub_perbot_marker"

    # 1) Per-bot mandate authenticates -> activation creates the bot + sub and
    #    grants the first period's credits into the bot's isolated ledger.
    rzp._handle_subscription_activated(
        db,
        _per_bot_activation_payload(
            razorpay_sub_id=rzp_sub_id,
            client_id=client.id,
            plan_id=plan.id,
            period_start=period_start,
            period_end=period_end,
        ),
    )
    db.flush()

    sub = db.query(Subscription).filter(Subscription.razorpay_subscription_id == rzp_sub_id).one()
    bot = db.query(Bot).filter(Bot.subscription_id == sub.id).one()

    assert sub.bot_id == bot.id
    assert credit_service.get_balance(db, client.id, bot_id=bot.id) == 10_000
    # The core defect: activation must advance the period marker exactly like
    # the account-level path, so the imminent first charge is a no-op.
    assert sub.last_granted_period_end == period_end

    # 2) Customer consumes some of the bot's credits between activation and the
    #    first successful charge (the UPI activated-before-charged window).
    credit_service.check_and_deduct(db, client.id, 3_000, reason="ai_chat", bot_id=bot.id)
    db.flush()
    assert credit_service.get_balance(db, client.id, bot_id=bot.id) == 7_000

    # 3) First subscription.charged lands for the SAME period. With the marker
    #    set it must no-op, no reset of consumed credits, no second grant.
    #    Stub invoice creation so the test isolates credit-grant idempotency
    #    from the seller-config / PDF finalization machinery.
    with patch.object(rzp, "_ensure_subscription_charge_invoice", return_value=None):
        rzp._handle_subscription_charged(
            db,
            _charged_payload(
                razorpay_sub_id=rzp_sub_id,
                payment_id="pay_perbot_1",
                amount_minor=94900,
                period_start=period_start,
                period_end=period_end,
            ),
        )
    db.flush()

    # Balance is unchanged: consumption survived, no free re-grant.
    assert credit_service.get_balance(db, client.id, bot_id=bot.id) == 7_000
