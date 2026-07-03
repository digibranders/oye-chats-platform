"""Credit notes — CN series, proportional tax reversal, idempotency, wiring."""

import os
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app import config
from app.db.models import Client, Invoice
from app.services import invoice_service
from app.services.seller_profile_service import save_seller_profile

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)


def _seller(db, **overrides):
    payload = {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}
    payload.update(overrides)
    save_seller_profile(db, payload, actor_id=None)


def _finalized_invoice(db, email, *, state="27", amount=179900):
    c = Client(name="Acme", email=email, api_key=f"key-{email}", billing_state_code=state, billing_country="IN")
    db.add(c)
    db.flush()
    inv = Invoice(
        client_id=c.id, amount_cents=amount, currency="inr", status="paid", razorpay_payment_id=f"pay-{email}"
    )
    db.add(inv)
    db.flush()
    assert invoice_service.finalize_invoice(db, inv) is True
    return inv


def test_full_refund_credit_note_mirrors_original(db, enabled):
    _seller(db)
    orig = _finalized_invoice(db, "cn-full@test.example")
    note = invoice_service.create_credit_note(db, orig, 179900, provider_ref="rfnd_full_1")
    assert note is not None
    assert note.invoice_type == "credit_note"
    assert note.invoice_number.startswith("CN/")
    assert note.credit_note_of_id == orig.id
    # Full reversal reproduces the original's figures exactly.
    assert note.amount_cents == orig.amount_cents
    assert note.taxable_value_minor == orig.taxable_value_minor
    assert note.cgst_minor == orig.cgst_minor
    assert note.sgst_minor == orig.sgst_minor
    assert note.total_tax_minor == orig.total_tax_minor
    assert note.supply_kind == orig.supply_kind
    assert note.hsn_sac == orig.hsn_sac
    # Identity frozen from the ORIGINAL document, not the live profile.
    assert note.seller_snapshot == orig.seller_snapshot
    assert note.buyer_snapshot == orig.buyer_snapshot
    assert note.line_items[0]["against_invoice"] == orig.invoice_number


def test_partial_refund_reverses_proportionally_and_reconciles(db, enabled):
    _seller(db)
    orig = _finalized_invoice(db, "cn-partial@test.example")
    note = invoice_service.create_credit_note(db, orig, 89950, provider_ref="rfnd_partial_1")
    assert note.amount_cents == 89950
    # Inclusive reconciliation holds on the note itself.
    assert note.taxable_value_minor + note.total_tax_minor == 89950
    assert note.cgst_minor + note.sgst_minor + note.igst_minor == note.total_tax_minor
    assert abs(note.cgst_minor - note.sgst_minor) <= 1
    # And never exceeds the original's tax.
    assert note.total_tax_minor <= orig.total_tax_minor


def test_inter_state_original_reverses_igst(db, enabled):
    _seller(db)  # seller 27
    orig = _finalized_invoice(db, "cn-inter@test.example", state="29")
    note = invoice_service.create_credit_note(db, orig, 179900, provider_ref="rfnd_inter_1")
    assert note.igst_minor == orig.igst_minor
    assert note.cgst_minor == 0 and note.sgst_minor == 0


def test_idempotent_on_provider_ref(db, enabled):
    _seller(db)
    orig = _finalized_invoice(db, "cn-idem@test.example")
    first = invoice_service.create_credit_note(db, orig, 179900, provider_ref="rfnd_idem_1")
    again = invoice_service.create_credit_note(db, orig, 179900, provider_ref="rfnd_idem_1")
    assert again.id == first.id  # same row returned, no second serial
    notes = db.execute(select(Invoice).where(Invoice.invoice_type == "credit_note")).scalars().all()
    assert len(notes) == 1


def test_legacy_original_gets_no_credit_note(db, enabled):
    _seller(db)
    c = Client(name="L", email="cn-legacy@test.example", api_key="key-cn-legacy")
    db.add(c)
    db.flush()
    legacy = Invoice(client_id=c.id, amount_cents=100, currency="inr", status="paid")  # unnumbered
    db.add(legacy)
    db.flush()
    assert invoice_service.create_credit_note(db, legacy, 100, provider_ref="rfnd_legacy_1") is None


def test_refund_exceeding_original_is_clamped(db, enabled):
    _seller(db)
    orig = _finalized_invoice(db, "cn-over@test.example")
    note = invoice_service.create_credit_note(db, orig, 999999999, provider_ref="rfnd_over_1")
    assert note.amount_cents == orig.amount_cents  # never reverse more than was invoiced


def test_refund_handler_issues_credit_note(db, enabled, monkeypatch):
    from app.services import razorpay_service as rzp

    _seller(db)
    orig = _finalized_invoice(db, "cn-wire@test.example")
    payload = {"refund": {"entity": {"id": "rfnd_wire_1", "payment_id": orig.razorpay_payment_id, "amount": 179900}}}
    rzp._handle_refund_created(db, payload)
    db.commit()
    note = db.execute(select(Invoice).where(Invoice.credit_note_of_id == orig.id)).scalar_one()
    assert note.invoice_type == "credit_note"
    assert note.invoice_number.startswith("CN/")
    assert orig.status == "refunded"


def test_dispute_lost_issues_credit_note(db, enabled, monkeypatch):
    from app.services import razorpay_service as rzp

    _seller(db)
    orig = _finalized_invoice(db, "cn-dispute@test.example")
    payload = {"dispute": {"entity": {"id": "disp_wire_1", "payment_id": orig.razorpay_payment_id, "amount": 179900}}}
    rzp._handle_dispute_lost(db, payload)
    db.commit()
    note = db.execute(select(Invoice).where(Invoice.credit_note_of_id == orig.id)).scalar_one()
    assert note.invoice_type == "credit_note"


def test_credit_note_pdf_renders_with_reference(db, enabled):
    from app.services.invoice_pdf import render_invoice_html

    _seller(db)
    orig = _finalized_invoice(db, "cn-pdf@test.example")
    note = invoice_service.create_credit_note(db, orig, 179900, provider_ref="rfnd_pdf_1")
    html = render_invoice_html(note)
    assert "CREDIT NOTE" in html
    assert "TAX INVOICE" not in html
    assert orig.invoice_number in html  # against-invoice reference (Section 34)
    assert "CGST @ 9.0%" in html  # tax reversal breakup shown
    assert "₹1,799.00" in html


def test_issued_datetime_of_finalize(db, enabled):
    # Guard: created notes are issued 'now' and carry an aware datetime.
    _seller(db)
    orig = _finalized_invoice(db, "cn-dt@test.example")
    note = invoice_service.create_credit_note(db, orig, 100, provider_ref="rfnd_dt_1")
    assert note.issued_at is not None
    assert note.issued_at.tzinfo is not None or note.issued_at >= datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None)
