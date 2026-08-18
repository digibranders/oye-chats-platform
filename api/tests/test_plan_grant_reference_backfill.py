"""Regression test for the plan_grant reference_id backfill.

``subscription.activated`` grants a subscription's first-period credits
before any Invoice exists (there's nothing to link yet), and sets the
per-period marker. The Invoice for that same charge only shows up moments
later via ``subscription.charged``, by which point ``grant_subscription_
period_once`` sees the marker already matches and no-ops, discarding the
invoice id it was just handed. That grant is left permanently unlinked.

Without a fix, a chargeback arriving on that (long-since-expired) first
invoice can't find its exact grant via ``reference_id`` and falls back to
"most recent matching grant in scope", which by then is a LATER, still
in-use period's grant. The clawback lands on the wrong month and wipes out
credits the customer already paid for and is actively using.

``credit_service._backfill_plan_grant_reference`` closes this by linking
the first period's grant to its invoice the moment that invoice exists
(inside the very no-op that used to discard it). This test reproduces the
full Jan-activate -> Jan-charge -> Feb-renew -> dispute-Jan sequence and
asserts the February balance survives untouched.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine, make_url
from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session

from app.db.models import Base, Client, CreditLedger, Invoice, Plan, Subscription
from app.services import credit_service
from app.services import razorpay_service as rzp

_TEST_DB_SUFFIX = "_backfilltest"


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


def _client(db, n=1) -> Client:
    c = Client(name=f"C{n}", email=f"backfill{n}@e.com", api_key=f"k-backfill-{n}", hashed_password="h")
    db.add(c)
    db.flush()
    return c


def _plan(db, *, credits=10_000) -> Plan:
    p = Plan(
        name="Standard",
        slug="std-backfill",
        monthly_price_cents=459900,
        annual_price_cents=4599000,
        monthly_price_usd_cents=459900,
        credits_per_month=credits,
        included_operator_seats=2,
        is_active=True,
        razorpay_plan_id_monthly="plan_std_backfill_monthly",
        razorpay_plan_id_annual="plan_std_backfill_annual",
    )
    db.add(p)
    db.flush()
    return p


def _activation_payload(*, razorpay_sub_id, client_id, plan_id, period_start, period_end):
    return {
        "subscription": {
            "entity": {
                "id": razorpay_sub_id,
                "notes": {"oyechats_client_id": str(client_id), "oyechats_plan_id": str(plan_id)},
                "current_start": int(period_start.timestamp()),
                "current_end": int(period_end.timestamp()),
                "quantity": 1,
                "customer_id": "cust_backfill",
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


def _dispute_payload(payment_id, *, amount, dispute_id="dp_backfill"):
    return {
        "dispute": {
            "entity": {
                "id": dispute_id,
                "payment_id": payment_id,
                "amount": amount,
                "status": "lost",
            }
        }
    }


def test_first_period_grant_gets_backfilled_and_protects_later_months(db):
    client = _client(db)
    plan = _plan(db, credits=10_000)
    db.commit()

    jan_start = datetime(2026, 1, 1, tzinfo=UTC)
    jan_end = datetime(2026, 1, 31, tzinfo=UTC)
    feb_start = datetime(2026, 2, 1, tzinfo=UTC)
    feb_end = datetime(2026, 2, 28, tzinfo=UTC)

    fake = MagicMock()
    with patch.object(rzp, "_get_razorpay", return_value=fake):
        # Jan: activation grants credits with NO invoice yet.
        rzp._handle_subscription_activated(
            db,
            _activation_payload(
                razorpay_sub_id="sub_backfill_1",
                client_id=client.id,
                plan_id=plan.id,
                period_start=jan_start,
                period_end=jan_end,
            ),
        )
        db.commit()

        sub = db.query(Subscription).filter_by(razorpay_subscription_id="sub_backfill_1").one()
        jan_grant = (
            db.query(CreditLedger)
            .filter_by(client_id=client.id, reason="plan_grant")
            .order_by(CreditLedger.created_at.asc())
            .first()
        )
        assert jan_grant is not None
        assert jan_grant.reference_id is None  # not linked yet, no invoice existed at grant time

        # Jan: subscription.charged arrives moments later WITH a payment entity.
        # This must be a marker no-op (same period) but must backfill the
        # reference onto the grant made above instead of discarding the invoice id.
        rzp._handle_subscription_charged(
            db,
            _charged_payload(
                razorpay_sub_id="sub_backfill_1",
                payment_id="pay_jan",
                amount_minor=459900,
                period_start=jan_start,
                period_end=jan_end,
            ),
        )
        db.commit()

        db.refresh(jan_grant)
        jan_invoice = db.query(Invoice).filter_by(razorpay_payment_id="pay_jan").one()
        assert jan_grant.reference_id == jan_invoice.id

        # Feb: renewal. Resets Jan's (fully unconsumed) leftover and grants a
        # fresh, separately-linked Feb grant.
        rzp._handle_subscription_charged(
            db,
            _charged_payload(
                razorpay_sub_id="sub_backfill_1",
                payment_id="pay_feb",
                amount_minor=459900,
                period_start=feb_start,
                period_end=feb_end,
            ),
        )
        db.commit()
        db.refresh(sub)

        # Customer actively uses their February credits.
        credit_service.check_and_deduct(db, client.id, 4_000, "ai_chat")
        db.commit()
        feb_balance_before = credit_service.get_balance(db, client.id, None)
        assert feb_balance_before == 6_000  # 10,000 - 4,000 spent

        # March: the January payment is disputed and lost. Correct outcome:
        # January's grant is long since reset to 0 (remaining <= 0), so NOTHING
        # should be clawed back, and February's active balance must be untouched.
        rzp._handle_dispute_lost(db, _dispute_payload("pay_jan", amount=459900))
        db.commit()

    feb_balance_after = credit_service.get_balance(db, client.id, None)
    assert feb_balance_after == feb_balance_before, (
        "dispute on the long-expired January invoice must not touch February's active, already-paid-for balance"
    )

    jan_invoice_after = db.query(Invoice).filter_by(razorpay_payment_id="pay_jan").one()
    assert jan_invoice_after.status == "dispute_lost"

    # No refund ledger row was written, the clawback correctly found nothing
    # left to reverse on January's grant, so it never touched February's.
    refund_rows = db.query(CreditLedger).filter_by(client_id=client.id, reason="refund").all()
    assert refund_rows == []
