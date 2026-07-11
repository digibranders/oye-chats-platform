"""Finding A: operator seats must not be entitled until the seat add-on's
mandate is authorized, and a seat charge must produce a GST invoice.

Before the fix: change_seat_count bumped operator_quantity immediately (seats ran
free until/unless the customer authorized), and seat subscription.* events were
ack-dropped before dispatch (a paid seat charge created no Invoice).
"""

import os
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import select

from app.db.models import Client, Invoice, Plan, Subscription
from app.services import razorpay_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _sub(db, included=1):
    client = Client(name="Seat", email="seat-a@test.local", hashed_password="x", api_key="k-seat-a")
    db.add(client)
    db.flush()
    plan = Plan(
        name="Standard",
        slug="standard",
        monthly_price_cents=459900,
        currency="INR",
        included_operator_seats=included,
        extra_seat_price_cents=49900,
        is_active=True,
    )
    db.add(plan)
    db.flush()
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        operator_quantity=included,
        razorpay_subscription_id="sub_main",
    )
    db.add(sub)
    db.flush()
    return client, sub


def test_first_seat_purchase_does_not_entitle_until_webhook(db):
    client, sub = _sub(db)
    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_seat"}
    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        checkout = razorpay_service.edit_seat_addon_quantity(db, sub, extra_seats=2)

    assert checkout is not None and checkout["subscription_id"] == "sub_seat"
    assert sub.seat_addon_subscription_id == "sub_seat"
    assert sub.seat_addon_pending_quantity == 2  # desired, awaiting auth
    assert sub.seat_addon_quantity == 0  # NOT yet authorized
    assert sub.operator_quantity == 1  # entitlement unchanged until webhook


def test_seat_activation_webhook_entitles(db):
    client, sub = _sub(db)
    sub.seat_addon_subscription_id = "sub_seat"
    sub.seat_addon_pending_quantity = 2
    sub.seat_addon_quantity = 0
    db.flush()

    event = {
        "event": "subscription.activated",
        "payload": {"subscription": {"entity": {"id": "sub_seat", "notes": {"purpose": "seat_addon"}}}},
    }
    razorpay_service.handle_webhook_event(db, event, event_id="evt_seat_act")

    assert sub.seat_addon_quantity == 2  # now authorized
    assert sub.operator_quantity == 3  # 1 included + 2 seats
    assert sub.seat_addon_pending_quantity is None


def test_seat_charged_creates_invoice(db):
    client, sub = _sub(db)
    sub.seat_addon_subscription_id = "sub_seat"
    sub.seat_addon_quantity = 2
    db.flush()

    event = {
        "event": "subscription.charged",
        "payload": {
            "subscription": {"entity": {"id": "sub_seat", "notes": {"purpose": "seat_addon"}}},
            "payment": {"entity": {"id": "pay_seat", "amount": 99800, "currency": "INR", "created_at": 1_780_000_000}},
        },
    }
    razorpay_service.handle_webhook_event(db, event, event_id="evt_seat_chg")

    inv = db.scalars(select(Invoice).where(Invoice.razorpay_payment_id == "pay_seat")).first()
    assert inv is not None
    assert inv.amount_cents == 99800
    assert "seat" in (inv.description or "").lower()


def test_dismiss_then_retry_does_not_entitle(db):
    """C1: a customer who dismisses the first-purchase checkout (never authorizes)
    and retries must get the checkout AGAIN, not silently entitled seats — the
    seat sub is still in `created` state and never charged."""
    client, sub = _sub(db)
    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_seat"}
    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        first = razorpay_service.edit_seat_addon_quantity(db, sub, extra_seats=2)
        # ... customer dismisses; nothing authorized. Retry:
        retry = razorpay_service.edit_seat_addon_quantity(db, sub, extra_seats=2)

    assert first is not None and retry is not None  # both return a checkout
    assert retry["subscription_id"] == "sub_seat"
    assert sub.seat_addon_pending_quantity == 2
    assert sub.seat_addon_quantity == 0  # STILL not authorized
    assert sub.operator_quantity == 1  # STILL not entitled
    rzp.subscription.edit.assert_not_called()  # same qty → no needless edit


def test_retry_with_changed_quantity_updates_created_sub(db):
    client, sub = _sub(db)
    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_seat"}
    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        razorpay_service.edit_seat_addon_quantity(db, sub, extra_seats=2)
        retry = razorpay_service.edit_seat_addon_quantity(db, sub, extra_seats=3)  # changed mind

    assert retry is not None and sub.seat_addon_pending_quantity == 3
    assert sub.operator_quantity == 1  # still gated
    rzp.subscription.edit.assert_called_once()  # created sub quantity updated


def test_carry_sets_operator_quantity(db):
    """H1: the system seat-carry (require_authorization=False) must bump
    operator_quantity, else carried seats vanish after a plan cutover."""
    client, sub = _sub(db, included=1)
    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_seat_new"}
    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        result = razorpay_service.edit_seat_addon_quantity(db, sub, extra_seats=2, require_authorization=False)

    assert result is None  # no re-auth needed on a carry
    assert sub.seat_addon_quantity == 2
    assert sub.operator_quantity == 3  # 1 included + 2 carried — usable immediately


def test_seat_cancelled_resets_entitlement(db):
    client, sub = _sub(db)
    sub.seat_addon_subscription_id = "sub_seat"
    sub.seat_addon_quantity = 2
    sub.operator_quantity = 3
    db.flush()

    event = {
        "event": "subscription.cancelled",
        "payload": {"subscription": {"entity": {"id": "sub_seat", "notes": {"purpose": "seat_addon"}}}},
    }
    razorpay_service.handle_webhook_event(db, event, event_id="evt_seat_cancel")

    assert sub.seat_addon_quantity == 0
    assert sub.operator_quantity == 1  # back to included
