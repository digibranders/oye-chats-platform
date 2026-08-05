"""Regression tests for the unpaid-activation-grant clawback (finding #2).

A UPI ``subscription.activated`` grants the first period's credits BEFORE the
first debit. If that debit fails (``subscription.halted`` / ``pending`` with no
successful ``subscription.charged``), the customer must not keep a full period
of credits they never paid for. ``_revoke_unpaid_activation_grant`` reverses
that grant — but ONLY the unpaid first period, and in a way that lets a later
successful retry re-grant cleanly.

Covered:
  1. halted with no paid charge → unused plan credits reset + marker rolled back
     to current_period_start; a subsequent successful charge re-grants.
  2. halted when the period WAS paid (a paid invoice exists) → no clawback.
  3. idempotency: a redelivered halted doesn't double-revoke.
  4. pending behaves like halted.
"""

import os
from datetime import UTC, datetime
from unittest.mock import patch

import pytest

from app.db.models import Client, Invoice, Plan, Subscription
from app.services import credit_service
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _client(db, email):
    c = Client(name="C", email=email, api_key=f"k-{email}", hashed_password="h")
    db.add(c)
    db.flush()
    return c


def _plan(db, *, slug, credits=10_000):
    p = Plan(name="Standard", slug=slug, monthly_price_cents=94900, credits_per_month=credits, is_active=True)
    db.add(p)
    db.flush()
    return p


def _activated_sub(db, client, plan, *, rzp_id, period_start, period_end):
    """A subscription in the just-activated state: credits granted, marker set,
    no paid charge yet — exactly the UPI activated-before-charged window."""
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id=rzp_id,
        billing_cycle="monthly",
        current_period_start=period_start,
        current_period_end=period_end,
        last_granted_period_end=period_end,  # activation advanced the marker
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    # The activation grant itself.
    credit_service.grant_plan_credits(db, client.id, plan.credits_per_month, bot_id=None)
    db.flush()
    return sub


def _halted_payload(rzp_id):
    return {"subscription": {"entity": {"id": rzp_id}}}


PERIOD_START = datetime(2026, 1, 1, tzinfo=UTC)
PERIOD_END = datetime(2026, 2, 1, tzinfo=UTC)


def test_halted_revokes_unpaid_activation_grant_and_allows_regrant_on_retry(db):
    client = _client(db, "clawback1@e.com")
    plan = _plan(db, slug="std-cb1", credits=10_000)
    sub = _activated_sub(db, client, plan, rzp_id="sub_cb1", period_start=PERIOD_START, period_end=PERIOD_END)
    db.commit()
    assert credit_service.get_balance(db, client.id, bot_id=None) == 10_000

    # Customer consumed some during the auth→charge window.
    credit_service.check_and_deduct(db, client.id, 2_000, reason="ai_chat", bot_id=None)
    db.commit()
    assert credit_service.get_balance(db, client.id, bot_id=None) == 8_000

    # First debit fails → halted. The unpaid grant's UNUSED portion is revoked.
    rzp._handle_subscription_halted(db, _halted_payload("sub_cb1"))
    db.commit()
    db.refresh(sub)
    assert sub.status == "past_due"
    assert credit_service.get_balance(db, client.id, bot_id=None) == 0  # unused revoked
    # Marker rolled back to the period start so a retry can re-grant.
    assert sub.last_granted_period_end == PERIOD_START

    # Customer re-authorizes and the retry succeeds → subscription.charged
    # re-grants the full period (marker start < period_end).
    charged = {
        "subscription": {
            "entity": {
                "id": "sub_cb1",
                "notes": {},
                "current_start": int(PERIOD_START.timestamp()),
                "current_end": int(PERIOD_END.timestamp()),
            }
        },
        "payment": {"entity": {"id": "pay_cb1", "amount": 94900, "currency": "INR"}},
    }
    with patch.object(rzp, "_ensure_subscription_charge_invoice", return_value=None):
        rzp._handle_subscription_charged(db, charged)
    db.commit()
    assert credit_service.get_balance(db, client.id, bot_id=None) == 10_000  # re-granted


def test_halted_does_not_revoke_when_period_was_paid(db):
    client = _client(db, "clawback2@e.com")
    plan = _plan(db, slug="std-cb2", credits=10_000)
    sub = _activated_sub(db, client, plan, rzp_id="sub_cb2", period_start=PERIOD_START, period_end=PERIOD_END)
    # A successful charge for this subscription → a paid invoice exists.
    db.add(
        Invoice(
            client_id=client.id,
            subscription_id=sub.id,
            amount_cents=94900,
            currency="inr",
            status="paid",
            razorpay_payment_id="pay_cb2",
        )
    )
    db.commit()

    # A later-cycle charge fails → halted. The FIRST period was paid, so the
    # activation grant must NOT be revoked.
    rzp._handle_subscription_halted(db, _halted_payload("sub_cb2"))
    db.commit()
    db.refresh(sub)
    assert sub.status == "past_due"
    assert credit_service.get_balance(db, client.id, bot_id=None) == 10_000  # retained
    assert sub.last_granted_period_end == PERIOD_END  # marker untouched


def test_redelivered_halted_does_not_double_revoke(db):
    client = _client(db, "clawback3@e.com")
    plan = _plan(db, slug="std-cb3", credits=10_000)
    sub = _activated_sub(db, client, plan, rzp_id="sub_cb3", period_start=PERIOD_START, period_end=PERIOD_END)
    db.commit()

    rzp._handle_subscription_halted(db, _halted_payload("sub_cb3"))
    rzp._handle_subscription_halted(db, _halted_payload("sub_cb3"))  # redelivery
    db.commit()
    db.refresh(sub)
    # Revoked exactly once: marker at start, balance 0 — the second call
    # short-circuits on the marker guard.
    assert sub.last_granted_period_end == PERIOD_START
    assert credit_service.get_balance(db, client.id, bot_id=None) == 0


def test_pending_also_revokes_unpaid_activation_grant(db):
    client = _client(db, "clawback4@e.com")
    plan = _plan(db, slug="std-cb4", credits=10_000)
    sub = _activated_sub(db, client, plan, rzp_id="sub_cb4", period_start=PERIOD_START, period_end=PERIOD_END)
    db.commit()

    rzp._handle_subscription_pending(db, _halted_payload("sub_cb4"))
    db.commit()
    db.refresh(sub)
    assert sub.status == "past_due"
    assert credit_service.get_balance(db, client.id, bot_id=None) == 0
    assert sub.last_granted_period_end == PERIOD_START


def test_paid_seat_invoice_does_not_mask_unpaid_activation(db):
    """F5 — seat add-on invoices stamp the main sub's id but pay for seats,
    not the plan. A successfully-charged seat mandate must not defeat the
    unpaid-activation revoke when the first PLAN debit failed."""
    client = _client(db, "seat-mask@e.com")
    plan = _plan(db, slug="std-seat-mask")
    sub = _activated_sub(db, client, plan, rzp_id="sub_seat_mask", period_start=PERIOD_START, period_end=PERIOD_END)
    # The seat charge succeeded while the plan's first debit failed.
    db.add(
        Invoice(
            client_id=client.id,
            subscription_id=sub.id,
            amount_cents=44900,
            currency="inr",
            status="paid",
            kind="seat",
            description="Operator seat add-on",
            razorpay_payment_id="pay_seat_mask",
        )
    )
    db.commit()
    assert credit_service.get_balance(db, client.id, bot_id=None) == plan.credits_per_month

    rzp._handle_subscription_halted(db, _halted_payload("sub_seat_mask"))
    db.commit()

    # The unpaid activation grant is revoked despite the paid seat invoice.
    assert credit_service.get_balance(db, client.id, bot_id=None) == 0


def test_legacy_null_kind_paid_invoice_still_masks_revoke(db):
    """Legacy rows (kind IS NULL) must keep counting as plan charges — the
    is_distinct_from filter excludes only known seat invoices."""
    client = _client(db, "legacy-mask@e.com")
    plan = _plan(db, slug="std-legacy-mask")
    sub = _activated_sub(db, client, plan, rzp_id="sub_legacy_mask", period_start=PERIOD_START, period_end=PERIOD_END)
    db.add(
        Invoice(
            client_id=client.id,
            subscription_id=sub.id,
            amount_cents=94900,
            currency="inr",
            status="paid",
            kind=None,
            razorpay_payment_id="pay_legacy_mask",
        )
    )
    db.commit()

    rzp._handle_subscription_halted(db, _halted_payload("sub_legacy_mask"))
    db.commit()

    # Paid (legacy) plan charge exists → no revoke.
    assert credit_service.get_balance(db, client.id, bot_id=None) == plan.credits_per_month
