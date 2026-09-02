"""A chargeback must never relabel returned money as money we kept.

``payment.dispute.created`` used to stamp ``status = "disputed"`` on any invoice
it found, and ``payment.dispute.won`` then stamped ``"paid"``. Run that sequence
over an invoice that had already been REFUNDED and the row ends up reading
"paid" for money the customer got back: the refund is invisible to the billing
page, to reconciliation and to the GST export, while ``refunded_minor`` still
says otherwise. A dispute opened after a refund is not exotic. It is the normal
shape of "I was charged, I asked for my money back, and I also raised it with my
bank".

The rule these tests pin: ``created`` only moves an invoice that is still
holding the money, and ``won`` restores what the row said BEFORE the dispute
rather than assuming it said "paid".

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest

from app.db.models import Client, Invoice
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="dispute status tests need a reachable Postgres at DB_URL",
)

CHARGE_MINOR = 141482


def _invoice(db, *, email: str, payment_id: str, status: str, refunded_minor: int) -> Invoice:
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()
    invoice = Invoice(
        client_id=client.id,
        amount_cents=CHARGE_MINOR,
        currency="inr",
        status=status,
        refunded_minor=refunded_minor,
        razorpay_payment_id=payment_id,
        kind="plan_charge",
        paid_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    db.add(invoice)
    db.flush()
    return invoice


def _dispute_payload(payment_id: str, dispute_id: str) -> dict:
    return {"dispute": {"entity": {"id": dispute_id, "payment_id": payment_id, "amount": CHARGE_MINOR}}}


def test_dispute_on_a_refunded_invoice_leaves_the_refund_status_standing(db):
    inv = _invoice(
        db, email="disp-refunded@e.com", payment_id="pay_refunded", status="refunded", refunded_minor=CHARGE_MINOR
    )
    db.commit()

    rzp._handle_dispute_created(db, _dispute_payload("pay_refunded", "disp_1"))
    db.commit()

    db.refresh(inv)
    assert inv.status == "refunded"


def test_dispute_won_after_a_refund_does_not_relabel_the_invoice_paid(db):
    inv = _invoice(
        db, email="disp-refund-won@e.com", payment_id="pay_refund_won", status="refunded", refunded_minor=CHARGE_MINOR
    )
    db.commit()

    rzp._handle_dispute_created(db, _dispute_payload("pay_refund_won", "disp_2"))
    rzp._handle_dispute_won(db, _dispute_payload("pay_refund_won", "disp_2"))
    db.commit()

    db.refresh(inv)
    assert inv.status == "refunded"
    assert inv.refunded_minor == CHARGE_MINOR


def test_dispute_on_a_partially_refunded_invoice_keeps_the_partial_label(db):
    inv = _invoice(
        db,
        email="disp-partial@e.com",
        payment_id="pay_partial",
        status="partially_refunded",
        refunded_minor=CHARGE_MINOR // 2,
    )
    db.commit()

    rzp._handle_dispute_created(db, _dispute_payload("pay_partial", "disp_3"))
    rzp._handle_dispute_won(db, _dispute_payload("pay_partial", "disp_3"))
    db.commit()

    db.refresh(inv)
    assert inv.status == "partially_refunded"


def test_dispute_created_then_won_on_an_unrefunded_invoice_still_round_trips(db):
    """The ordinary case must keep working: flag it, then hand it back as paid."""
    inv = _invoice(db, email="disp-plain@e.com", payment_id="pay_plain", status="paid", refunded_minor=0)
    db.commit()

    rzp._handle_dispute_created(db, _dispute_payload("pay_plain", "disp_4"))
    db.commit()
    db.refresh(inv)
    assert inv.status == "disputed"

    rzp._handle_dispute_won(db, _dispute_payload("pay_plain", "disp_4"))
    db.commit()
    db.refresh(inv)
    assert inv.status == "paid"
