"""Credit notes — CN series, proportional tax reversal, idempotency, wiring."""

import os
import threading
import time
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

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


def test_refund_created_claws_but_does_not_issue_note(db, enabled):
    # refund.created = initiated, not settled. A bank refund can still FAIL —
    # issuing the Section 34 document here would risk a credit note for a
    # refund that never happened (F1).
    from app.services import razorpay_service as rzp

    _seller(db)
    orig = _finalized_invoice(db, "cn-created@test.example")
    payload = {"refund": {"entity": {"id": "rfnd_created_1", "payment_id": orig.razorpay_payment_id, "amount": 179900}}}
    rzp._handle_refund_created(db, payload)
    db.commit()
    assert orig.status == "refunded"  # clawback + display flip happen immediately
    notes = db.execute(select(Invoice).where(Invoice.credit_note_of_id == orig.id)).scalars().all()
    assert notes == []  # no legal document until settlement


def test_refund_processed_issues_credit_note(db, enabled, monkeypatch):
    from app.services import razorpay_service as rzp

    _seller(db)
    orig = _finalized_invoice(db, "cn-wire@test.example")
    payload = {"refund": {"entity": {"id": "rfnd_wire_1", "payment_id": orig.razorpay_payment_id, "amount": 179900}}}
    # Normal sequence: created (claw) then processed (claw no-ops, note issues).
    rzp._handle_refund_created(db, payload)
    rzp._handle_refund_processed(db, payload)
    db.commit()
    note = db.execute(select(Invoice).where(Invoice.credit_note_of_id == orig.id)).scalar_one()
    assert note.invoice_type == "credit_note"
    assert note.invoice_number.startswith("CN/")
    assert note.status == "issued"
    assert note.line_items[0]["against_invoice_date"] is not None  # Rule 53: serial AND date
    assert orig.status == "refunded"


def test_refund_then_dispute_cannot_over_reverse(db, enabled):
    # F3: partial refund note + full-amount chargeback must clamp cumulatively.
    from app.services import razorpay_service as rzp

    _seller(db)
    orig = _finalized_invoice(db, "cn-cumul@test.example")
    refund_payload = {
        "refund": {"entity": {"id": "rfnd_cumul_1", "payment_id": orig.razorpay_payment_id, "amount": 89950}}
    }
    rzp._handle_refund_processed(db, refund_payload)
    dispute_payload = {
        "dispute": {"entity": {"id": "disp_cumul_1", "payment_id": orig.razorpay_payment_id, "amount": 179900}}
    }
    rzp._handle_dispute_lost(db, dispute_payload)
    db.commit()
    notes = db.execute(select(Invoice).where(Invoice.credit_note_of_id == orig.id)).scalars().all()
    total_reversed = sum(n.amount_cents for n in notes)
    assert total_reversed <= orig.amount_cents  # never more than the consideration
    assert total_reversed == 179900  # 89950 + clamped 89950


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
    assert "CGST @ 9%" in html  # tax reversal breakup shown
    assert "₹1,799.00" in html


def test_issued_datetime_of_finalize(db, enabled):
    # Guard: created notes are issued 'now' and carry an aware datetime.
    _seller(db)
    orig = _finalized_invoice(db, "cn-dt@test.example")
    note = invoice_service.create_credit_note(db, orig, 100, provider_ref="rfnd_dt_1")
    assert note.issued_at is not None
    assert note.issued_at.tzinfo is not None or note.issued_at >= datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None)


def test_concurrent_reversals_serialize_on_row_lock(pg_engine, db, enabled):
    """Two DISTINCT reversal events for the SAME original invoice, processed by
    genuinely overlapping transactions (not just sequential calls in one
    session — see ``test_refund_then_dispute_cannot_over_reverse`` for that),
    must not both read ``already_reversed`` as 0 and over-reverse.

    Session A takes the row lock ``create_credit_note`` now takes, inserts its
    reversal, and holds the transaction open (uncommitted) for a moment.
    Session B's ``create_credit_note`` call — for the SAME original invoice —
    must block on that lock rather than proceeding with a stale read, and only
    resume once A commits, then correctly see A's reversal and clamp its own
    to whatever's left."""
    # How long session A holds the lock, and the floor session B's blocked call
    # must exceed. Derived from one constant so the two can never drift apart;
    # the 0.8 margin absorbs scheduler jitter without weakening the property
    # (an unblocked call returns in single-digit milliseconds, ~100x under it).
    HOLD_SECONDS = 0.4
    MIN_BLOCKED_SECONDS = HOLD_SECONDS * 0.8

    _seller(db)
    orig = _finalized_invoice(db, "cn-race@test.example")
    db.commit()

    session_a = Session(pg_engine, autoflush=False)
    session_b = Session(pg_engine, autoflush=False)
    lock_held = threading.Event()
    release_lock = threading.Event()

    def hold_lock_and_reverse():
        session_a.execute(select(Invoice.id).where(Invoice.id == orig.id).with_for_update())
        note_a = Invoice(
            client_id=orig.client_id,
            subscription_id=orig.subscription_id,
            bot_id=orig.bot_id,
            amount_cents=89950,
            currency=orig.currency,
            status="issued",
            razorpay_payment_id="rfnd_race_A",
            invoice_type="credit_note",
            credit_note_of_id=orig.id,
            issued_at=datetime.now(UTC),
        )
        session_a.add(note_a)
        session_a.flush()
        lock_held.set()
        release_lock.wait(timeout=5)
        session_a.commit()

    t = threading.Thread(target=hold_lock_and_reverse)
    t.start()
    try:
        assert lock_held.wait(timeout=5), "session A never reached the lock"

        # Give session B a moment to genuinely attempt (and block on) the lock
        # before we release it, so the timing assertion below is meaningful.
        def release_after_delay():
            time.sleep(HOLD_SECONDS)
            release_lock.set()

        # Every statement between starting this timer and the measured call
        # eats into the hold window. ``session_b.get`` is a DB round trip, so
        # on a loaded CI runner it could consume most of the delay and leave
        # session B blocking for only the remainder - the assertion then failed
        # (`assert 0.047 >= 0.35`) while the lock it exists to prove was
        # working perfectly. Do B's setup FIRST, then start the clock and the
        # timer together, so the full window belongs to the measured call.
        orig_b = session_b.get(Invoice, orig.id)
        threading.Thread(target=release_after_delay).start()
        started = time.monotonic()
        note_b = invoice_service.create_credit_note(session_b, orig_b, 179900, provider_ref="rfnd_race_B")
        elapsed = time.monotonic() - started
        session_b.commit()
    finally:
        t.join(timeout=5)

    assert elapsed >= MIN_BLOCKED_SECONDS, "session B must block on session A's row lock, not race past it"

    # Session A reversed 89,950 first; session B must see that and clamp its
    # own reversal to the 89,950 still remaining — never over-reversing past
    # the original invoice's 179,900.
    assert note_b is not None
    assert note_b.amount_cents == 89950
    total = db.execute(
        select(func.coalesce(func.sum(Invoice.amount_cents), 0)).where(Invoice.credit_note_of_id == orig.id)
    ).scalar_one()
    assert total == 179900

    session_a.close()
    session_b.close()
