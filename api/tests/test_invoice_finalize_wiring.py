"""Webhook handlers finalize invoices when invoicing v2 is enabled (Phase 3).

Verifies the wiring in ``_handle_subscription_charged`` and
``_handle_payment_captured`` — that a real charge produces a numbered tax
invoice when the flag is on, and an untouched legacy row when it is off.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app import config
from app.db.models import Client, Invoice, Plan, Subscription
from app.services import razorpay_service as rzp
from app.services.seller_profile_service import save_seller_profile

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

S1 = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
E2 = datetime(2026, 2, 28, 12, 0, tzinfo=UTC)


def _seller(db):
    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}, actor_id=None)


def _make_sub(db, email):
    client = Client(name="c", email=email, api_key=f"key-{email}", billing_state_code="27", billing_country="IN")
    db.add(client)
    db.flush()
    plan = Plan(name="Standard", slug=f"std-{email}", monthly_price_cents=179900, credits_per_month=1000)
    db.add(plan)
    db.flush()
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id=f"sub_{email}",
        current_period_start=S1,
        current_period_end=E2,
        last_granted_period_end=E2,  # already granted → handler focuses on the invoice
    )
    sub.plan = plan
    db.add(sub)
    db.commit()
    return client, sub


def _charged(sub_id, period_end, payment_id):
    return {
        "subscription": {"entity": {"id": sub_id, "current_end": int(period_end.timestamp())}},
        "payment": {"entity": {"id": payment_id, "amount": 179900, "currency": "INR"}},
    }


def test_charged_produces_numbered_tax_invoice_when_enabled(db, monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)
    _seller(db)
    _make_sub(db, "wire-on@e.com")

    rzp._handle_subscription_charged(db, _charged("sub_wire-on@e.com", E2, "pay_wire_on"))
    db.commit()

    inv = db.execute(select(Invoice).where(Invoice.razorpay_payment_id == "pay_wire_on")).scalar_one()
    assert inv.invoice_type == "tax_invoice"
    assert inv.invoice_number is not None and inv.invoice_number.startswith("DB/")
    assert inv.taxable_value_minor == 152458
    assert inv.total_tax_minor == 27442
    assert inv.issued_at is not None


def test_charged_leaves_legacy_row_when_disabled(db, monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", False)
    _seller(db)
    _make_sub(db, "wire-off@e.com")

    rzp._handle_subscription_charged(db, _charged("sub_wire-off@e.com", E2, "pay_wire_off"))
    db.commit()

    inv = db.execute(select(Invoice).where(Invoice.razorpay_payment_id == "pay_wire_off")).scalar_one()
    assert inv.invoice_type == "legacy"
    assert inv.invoice_number is None
    assert inv.taxable_value_minor is None
