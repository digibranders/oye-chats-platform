"""A canceled/expired subscription must never be silently resurrected by a
stray, out-of-order, or redelivered webhook — and the per-period grant
marker must be monotonic, not exact-equality, so a replayed OLDER event
can't regress it and trigger a second grant.

Scenarios:

1. ``subscription.charged`` arrives for a subscription the customer already
   cancelled (a charge in flight at the moment of cancel, or simple
   out-of-order delivery). Real money moved, so the invoice is still
   recorded — but the subscription must stay cancelled and no fresh
   credits are granted.
2. ``subscription.activated`` (also reached via the ``subscription.resumed``
   alias) arrives for an existing local row that is already
   canceled/expired. Must not flip it back to active.
3. ``grant_subscription_period_once``'s marker check must be monotonic:
   replaying an event for a period at or before the current marker (e.g. via
   the superadmin dead-letter replay tool, after a newer period already
   granted) must no-op, not regress the marker and grant again.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest

from app.db.models import Client, CreditLedger, Invoice, Plan, Subscription
from app.services import credit_service
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

JAN_START = datetime(2026, 1, 1, tzinfo=UTC)
JAN_END = datetime(2026, 1, 31, tzinfo=UTC)
FEB_START = datetime(2026, 2, 1, tzinfo=UTC)
FEB_END = datetime(2026, 2, 28, tzinfo=UTC)


def _client(db, email) -> Client:
    c = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(c)
    db.flush()
    return c


def _plan(db, slug, credits=1000) -> Plan:
    p = Plan(name=slug, slug=slug, monthly_price_cents=399900, credits_per_month=credits)
    db.add(p)
    db.flush()
    return p


def _sub(db, client, plan, *, razorpay_subscription_id, status, last_granted=None) -> Subscription:
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status=status,
        payment_provider="razorpay",
        razorpay_subscription_id=razorpay_subscription_id,
        current_period_start=JAN_START,
        current_period_end=JAN_END,
        last_granted_period_end=last_granted,
        canceled_at=datetime.now(UTC) if status in ("canceled", "expired") else None,
    )
    sub.plan = plan
    db.add(sub)
    db.commit()
    return sub


def _charged_payload(sub_id, *, period_start, period_end, payment_id):
    return {
        "subscription": {
            "entity": {
                "id": sub_id,
                "current_start": int(period_start.timestamp()),
                "current_end": int(period_end.timestamp()),
            }
        },
        "payment": {"entity": {"id": payment_id, "amount": 399900, "currency": "INR"}},
    }


def _activation_payload(*, razorpay_sub_id, client_id, plan_id, period_start, period_end):
    return {
        "subscription": {
            "entity": {
                "id": razorpay_sub_id,
                "notes": {"oyechats_client_id": str(client_id), "oyechats_plan_id": str(plan_id)},
                "current_start": int(period_start.timestamp()),
                "current_end": int(period_end.timestamp()),
                "quantity": 1,
                "customer_id": "cust_guard",
            }
        }
    }


def test_charged_after_cancellation_records_invoice_but_does_not_reactivate(db):
    client = _client(db, "guard-charged@e.com")
    plan = _plan(db, "std-guard-charged")
    sub = _sub(db, client, plan, razorpay_subscription_id="sub_guard_charged", status="canceled", last_granted=JAN_END)

    result = rzp._handle_subscription_charged(
        db,
        _charged_payload(
            "sub_guard_charged", period_start=FEB_START, period_end=FEB_END, payment_id="pay_guard_charged"
        ),
    )
    db.commit()

    assert "not reactivated" in result or "not granting" in result
    db.refresh(sub)
    assert sub.status == "canceled"
    assert sub.last_granted_period_end == JAN_END  # unchanged — no grant happened

    # The captured payment is still recorded for reconciliation/refund.
    inv = db.query(Invoice).filter_by(razorpay_payment_id="pay_guard_charged").one()
    assert inv.client_id == client.id

    # No new plan_grant ledger row.
    grants = db.query(CreditLedger).filter_by(client_id=client.id, reason="plan_grant").all()
    assert grants == []


def test_activated_after_cancellation_does_not_reactivate(db):
    client = _client(db, "guard-activated@e.com")
    plan = _plan(db, "std-guard-activated")
    sub = _sub(db, client, plan, razorpay_subscription_id="sub_guard_activated", status="canceled")

    result = rzp._handle_subscription_activated(
        db,
        _activation_payload(
            razorpay_sub_id="sub_guard_activated",
            client_id=client.id,
            plan_id=plan.id,
            period_start=FEB_START,
            period_end=FEB_END,
        ),
    )
    db.commit()

    assert "ignored" in result
    db.refresh(sub)
    assert sub.status == "canceled"


def test_expired_subscription_also_protected(db):
    client = _client(db, "guard-expired@e.com")
    plan = _plan(db, "std-guard-expired")
    sub = _sub(db, client, plan, razorpay_subscription_id="sub_guard_expired", status="expired", last_granted=JAN_END)

    rzp._handle_subscription_charged(
        db,
        _charged_payload(
            "sub_guard_expired", period_start=FEB_START, period_end=FEB_END, payment_id="pay_guard_expired"
        ),
    )
    db.commit()

    db.refresh(sub)
    assert sub.status == "expired"
    grants = db.query(CreditLedger).filter_by(client_id=client.id, reason="plan_grant").all()
    assert grants == []


def test_active_subscription_still_reactivates_and_grants_normally(db):
    """Regression guard: the new check must not block the legitimate case —
    an ACTIVE (or past_due) subscription's charged/activated events still
    work exactly as before."""
    client = _client(db, "guard-active-control@e.com")
    plan = _plan(db, "std-guard-control")
    sub = _sub(db, client, plan, razorpay_subscription_id="sub_guard_control", status="active", last_granted=JAN_END)

    result = rzp._handle_subscription_charged(
        db,
        _charged_payload(
            "sub_guard_control", period_start=FEB_START, period_end=FEB_END, payment_id="pay_guard_control"
        ),
    )
    db.commit()

    assert result == "Subscription sub_guard_control charged"
    db.refresh(sub)
    assert sub.status == "active"
    assert sub.last_granted_period_end == FEB_END
    grants = db.query(CreditLedger).filter_by(client_id=client.id, reason="plan_grant").all()
    assert len(grants) == 1


def test_grant_marker_is_monotonic_against_stale_replay(db):
    """A replayed OLDER period (e.g. a dead-lettered event redelivered via the
    superadmin replay tool, after a NEWER period already granted) must no-op
    instead of regressing the marker and granting a second time."""
    client = _client(db, "guard-monotonic@e.com")
    plan = _plan(db, "std-guard-monotonic")
    sub = _sub(db, client, plan, razorpay_subscription_id="sub_guard_mono", status="active", last_granted=FEB_END)

    # Stale replay of the OLDER January period, arriving after February
    # already granted.
    granted = credit_service.grant_subscription_period_once(db, sub, JAN_END, invoice_id=None)
    db.commit()

    assert granted is False
    db.refresh(sub)
    assert sub.last_granted_period_end == FEB_END, "marker must not regress to the older, already-superseded period"

    grants = db.query(CreditLedger).filter_by(client_id=client.id, reason="plan_grant").all()
    assert grants == [], "no grant should have been written for the stale replay"
