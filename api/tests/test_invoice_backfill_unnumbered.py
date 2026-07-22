"""Regression tests for the un-numbered-invoice self-heal + visibility (H-B).

A charge whose ``finalize_invoice`` returned False — most commonly because the
super-admin hadn't saved the seller profile yet — leaves a legacy ``Invoice``
row with no ``invoice_number`` and no tax document. Before the fix nothing ever
re-numbered it (the PDF sweep and every reconciliation query filter on
``invoice_number IS NOT NULL``), so the customer was charged with no legal
document and no alarm.

These tests cover both halves of the fix:
  1. ``backfill_unnumbered_invoices`` re-numbers such a row once the seller
     profile exists (self-heal), and no-ops harmlessly when it still can't.
  2. ``reconciliation_anomalies`` surfaces the un-numbered paid charge so ops
     can see it (visibility).
"""

import os
from datetime import UTC, datetime, timedelta

import pytest

from app import config
from app.db.models import Client, Invoice
from app.services import invoice_reports, invoice_service
from app.services.seller_profile_service import save_seller_profile

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)


def _client(db, email, **billing):
    c = Client(name="Acme", email=email, api_key=f"key-{email}", **billing)
    db.add(c)
    db.flush()
    return c


def _seller(db, **overrides):
    payload = {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}
    payload.update(overrides)
    save_seller_profile(db, payload, actor_id=None)


def _paid_invoice(db, client_id, *, amount=179900, currency="inr", paid_at=None, **kw):
    inv = Invoice(
        client_id=client_id,
        amount_cents=amount,
        currency=currency,
        status="paid",
        paid_at=paid_at or datetime.now(UTC),
        **kw,
    )
    db.add(inv)
    db.flush()
    return inv


def test_backfill_renumbers_charge_left_legacy_before_seller_config(db, enabled):
    # Charge captured while the seller profile was NOT yet saved → legacy row.
    c = _client(db, "hb-preconfig@test.example", billing_state_code="27")
    inv = _paid_invoice(db, c.id, razorpay_payment_id="pay_hb_1")
    assert invoice_service.finalize_invoice_safely(db, inv) is False
    assert inv.invoice_number is None

    # Super-admin later saves the company's legal identity.
    _seller(db)

    # Self-heal sweep re-numbers the previously un-numbered charge.
    healed = invoice_service.backfill_unnumbered_invoices(db)
    assert healed == 1
    db.refresh(inv)
    assert inv.invoice_number is not None
    assert inv.invoice_type == "tax_invoice"

    # Idempotent: a second sweep finds nothing new to number.
    assert invoice_service.backfill_unnumbered_invoices(db) == 0


def test_backfill_noops_while_still_unfinalizable(db, enabled):
    # No seller profile saved yet: the row cannot be numbered, and the sweep
    # must leave it legacy rather than mint a document with an empty identity.
    c = _client(db, "hb-still-blocked@test.example", billing_state_code="27")
    inv = _paid_invoice(db, c.id, razorpay_payment_id="pay_hb_2")
    invoice_service.finalize_invoice_safely(db, inv)
    assert inv.invoice_number is None

    assert invoice_service.backfill_unnumbered_invoices(db) == 0
    db.refresh(inv)
    assert inv.invoice_number is None


def test_reconciliation_surfaces_unnumbered_paid_charge(db, enabled):
    c = _client(db, "hb-visible@test.example", billing_state_code="27")
    # Paid over an hour ago and still un-numbered → past the sweep interval.
    stale = datetime.now(UTC) - timedelta(hours=2)
    inv = _paid_invoice(db, c.id, razorpay_payment_id="pay_hb_3", paid_at=stale)
    invoice_service.finalize_invoice_safely(db, inv)  # stays legacy (no seller)
    assert inv.invoice_number is None

    anomalies = invoice_reports.reconciliation_anomalies(db)
    ids = [row["id"] for row in anomalies["unnumbered_charges"]]
    assert inv.id in ids

    # Once healed, it drops out of the anomaly list.
    _seller(db)
    invoice_service.backfill_unnumbered_invoices(db)
    anomalies_after = invoice_reports.reconciliation_anomalies(db)
    assert [row["id"] for row in anomalies_after["unnumbered_charges"]] == []
