"""The golden invoice matrix (blueprint §8.4) — the intl-launch code gate.

Every supply classification × document type, asserted TO THE PAISA against
hand-verified figures. These are deliberately literal numbers, not re-derived
through the tax engine: the point is that a future "harmless" change to
rounding, inclusive-price math, or the largest-remainder split fails a test a
CA can re-verify by hand.

Matrix rows (supply kinds):
  * IN intra-state B2C   — CGST+SGST, place of supply = buyer state
  * IN inter-state B2C   — IGST
  * IN inter-state B2B   — IGST + buyer GSTIN on the document (ITC)
  * export + LUT         — zero-rated, USD document with INR mirror
  * export, no LUT       — Rule 96A: IGST carved out of the export charge

Columns (document types): subscription charge · renewal (serial continuity +
identical math) · top-up · credit note (Section 34 reversal from FROZEN
original parameters).

Hand-verification of the goldens (18% GST, inclusive pricing):
  ₹949.00 → taxable 94900×100/118 = 80423.72Ⓡ → 80424; tax 14476;
            CGST/SGST largest-remainder split = 7238 + 7238.
  ₹1599.00 (top-up) → taxable 135508.47Ⓡ → 135508; tax 24392 → 12196+12196.
  $19.00 export+LUT → zero-rated: taxable 1900¢, tax 0; INR mirror 160000p.
  $19.00 export no-LUT → taxable 1610.17Ⓡ → 1610¢, IGST 290¢.
"""

import os
from datetime import UTC, datetime

import pytest

from app import config
from app.db.models import Client, Invoice
from app.services import invoice_service
from app.services.seller_profile_service import save_seller_profile

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

PAID_AT = datetime(2026, 8, 1, 10, 0, tzinfo=UTC)


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)


def _seller(db, *, lut_active=False):
    save_seller_profile(
        db,
        {
            "legal_name": "Digibranders Pvt Ltd",
            "gstin": "27AAPFU0939F1ZV",  # seller state 27 (MH)
            **({"lut_active": True, "lut_number": "LUT-2026-GOLD"} if lut_active else {}),
        },
        actor_id=None,
    )


def _buyer(db, email, **fields):
    c = Client(name="GoldenBuyer", email=email, api_key=f"key-{email}", **fields)
    db.add(c)
    db.flush()
    return c


def _invoice(db, buyer, *, amount, currency="inr", kind="plan_charge", pay_ref=None, inr_minor=None):
    inv = Invoice(
        client_id=buyer.id,
        amount_cents=amount,
        currency=currency,
        status="paid",
        kind=kind,
        paid_at=PAID_AT,
        razorpay_payment_id=pay_ref,
        inr_amount_minor=inr_minor,
    )
    db.add(inv)
    db.flush()
    assert invoice_service.finalize_invoice(db, inv) is True, "finalize refused"
    return inv


# ── Row 1: IN intra-state B2C (CGST + SGST) ──────────────────────────────────


def test_intra_state_b2c_charge_to_the_paisa(db, enabled):
    _seller(db)
    buyer = _buyer(db, "gold-intra@t.dev", billing_country="IN", billing_state_code="27")
    inv = _invoice(db, buyer, amount=94900)

    assert inv.supply_kind == "intra"
    assert inv.taxable_value_minor == 80424
    assert inv.cgst_minor == 7238
    assert inv.sgst_minor == 7238
    assert inv.igst_minor in (0, None)
    assert inv.total_tax_minor == 14476
    assert inv.taxable_value_minor + inv.total_tax_minor == 94900  # inclusive: reconstructs exactly
    assert inv.place_of_supply == "27"
    assert inv.is_export is not True


def test_intra_state_renewal_continues_the_serial_with_identical_math(db, enabled):
    _seller(db)
    buyer = _buyer(db, "gold-renew@t.dev", billing_country="IN", billing_state_code="27")
    first = _invoice(db, buyer, amount=94900, pay_ref="pay_gold_r1")
    renewal = _invoice(db, buyer, amount=94900, pay_ref="pay_gold_r2")

    assert renewal.taxable_value_minor == first.taxable_value_minor == 80424
    assert renewal.total_tax_minor == first.total_tax_minor == 14476
    n1 = int(first.invoice_number.rsplit("/", 1)[-1])
    n2 = int(renewal.invoice_number.rsplit("/", 1)[-1])
    assert n2 == n1 + 1  # gapless FY serial


def test_intra_state_topup_to_the_paisa(db, enabled):
    _seller(db)
    buyer = _buyer(db, "gold-topup@t.dev", billing_country="IN", billing_state_code="27")
    inv = _invoice(db, buyer, amount=159900, kind="topup", pay_ref="pay_gold_topup")

    assert inv.taxable_value_minor == 135508
    assert inv.cgst_minor == 12196
    assert inv.sgst_minor == 12196
    assert inv.total_tax_minor == 24392
    assert inv.taxable_value_minor + inv.total_tax_minor == 159900


def test_intra_state_full_credit_note_reproduces_the_original_exactly(db, enabled):
    _seller(db)
    buyer = _buyer(db, "gold-cn-intra@t.dev", billing_country="IN", billing_state_code="27")
    inv = _invoice(db, buyer, amount=94900, pay_ref="pay_gold_cn1")

    note = invoice_service.create_credit_note(db, inv, 94900, provider_ref="rfnd_gold_1")
    assert note is not None
    assert note.taxable_value_minor == 80424
    assert note.cgst_minor == 7238
    assert note.sgst_minor == 7238
    assert note.total_tax_minor == 14476


# ── Row 2: IN inter-state B2C (IGST) ─────────────────────────────────────────


def test_inter_state_b2c_charge_to_the_paisa(db, enabled):
    _seller(db)
    buyer = _buyer(db, "gold-inter@t.dev", billing_country="IN", billing_state_code="29")
    inv = _invoice(db, buyer, amount=94900)

    assert inv.supply_kind == "inter"
    assert inv.taxable_value_minor == 80424
    assert inv.igst_minor == 14476
    assert (inv.cgst_minor or 0) == 0
    assert (inv.sgst_minor or 0) == 0
    assert inv.total_tax_minor == 14476
    assert inv.place_of_supply == "29"


def test_inter_state_partial_credit_note_to_the_paisa(db, enabled):
    # Half refund of ₹949.00 → ₹474.50 note: taxable 47450×100/118 = 40211.86Ⓡ
    # → 40212; IGST 7238.
    _seller(db)
    buyer = _buyer(db, "gold-cn-inter@t.dev", billing_country="IN", billing_state_code="29")
    inv = _invoice(db, buyer, amount=94900, pay_ref="pay_gold_cn2")

    note = invoice_service.create_credit_note(db, inv, 47450, provider_ref="rfnd_gold_2")
    assert note is not None
    assert note.taxable_value_minor == 40212
    assert note.igst_minor == 7238
    assert note.total_tax_minor == 7238


# ── Row 3: IN inter-state B2B (GSTIN on the document) ────────────────────────


def test_b2b_charge_carries_buyer_gstin_and_igst(db, enabled):
    _seller(db)
    buyer = _buyer(
        db,
        "gold-b2b@t.dev",
        billing_country="IN",
        billing_state_code="29",
        gstin="29AAGCB7383J1Z4",
        legal_name="Bengaluru Widgets Pvt Ltd",
    )
    inv = _invoice(db, buyer, amount=94900)

    assert inv.supply_kind == "inter"
    assert inv.taxable_value_minor == 80424
    assert inv.igst_minor == 14476
    assert inv.buyer_snapshot["gstin"] == "29AAGCB7383J1Z4"
    assert inv.buyer_snapshot["legal_name"] == "Bengaluru Widgets Pvt Ltd"


# ── Row 4: export + LUT (zero-rated USD document with INR mirror) ────────────


def test_export_lut_usd_charge_is_zero_rated_with_inr_mirror(db, enabled):
    _seller(db, lut_active=True)
    buyer = _buyer(db, "gold-exp-lut@t.dev", billing_country="US")
    inv = _invoice(db, buyer, amount=1900, currency="usd", inr_minor=160000)

    assert inv.supply_kind == "export"
    assert inv.is_export is True
    assert inv.taxable_value_minor == 1900  # zero-rated: full value, no carve-out
    assert inv.total_tax_minor == 0
    assert (inv.igst_minor or 0) == 0
    assert inv.inr_amount_minor == 160000  # GSTR-1 Table 6A files in rupees
    assert inv.place_of_supply is None  # no Indian state on an export


def test_export_lut_document_carries_the_rule_46_endorsement(db, enabled):
    from app.services.invoice_pdf import render_invoice_html

    _seller(db, lut_active=True)
    buyer = _buyer(db, "gold-exp-html@t.dev", billing_country="US")
    inv = _invoice(db, buyer, amount=1900, currency="usd", inr_minor=160000)

    html = render_invoice_html(inv)
    # Rule 46 export endorsement, with the LUT number on the document.
    assert "export under LUT without payment of IGST" in html
    assert "LUT-2026-GOLD" in html
    assert "United States" in html  # destination country
    assert "$19.00" in html  # document in its own currency


def test_export_lut_full_credit_note_stays_zero_rated(db, enabled):
    _seller(db, lut_active=True)
    buyer = _buyer(db, "gold-exp-cn@t.dev", billing_country="US")
    inv = _invoice(db, buyer, amount=1900, currency="usd", inr_minor=160000, pay_ref="pay_gold_exp1")

    note = invoice_service.create_credit_note(db, inv, 1900, provider_ref="rfnd_gold_3")
    assert note is not None
    assert note.taxable_value_minor == 1900
    assert note.total_tax_minor == 0


def test_export_lut_survives_a_later_lut_lapse(db, enabled):
    # Section 34: the note unwinds with the ORIGINAL's frozen parameters — the
    # seller letting the LUT lapse later must not turn an old zero-rated
    # export's reversal into an IGST-bearing note.
    _seller(db, lut_active=True)
    buyer = _buyer(db, "gold-exp-freeze@t.dev", billing_country="US")
    inv = _invoice(db, buyer, amount=1900, currency="usd", inr_minor=160000, pay_ref="pay_gold_exp2")

    _seller(db, lut_active=False)  # LUT lapses AFTER the original issued
    note = invoice_service.create_credit_note(db, inv, 1900, provider_ref="rfnd_gold_4")
    assert note is not None
    assert note.total_tax_minor == 0  # frozen zero-rating, not today's config


# ── Row 5: export without LUT (Rule 96A — IGST on the export) ────────────────


def test_export_without_lut_carries_igst_to_the_cent(db, enabled):
    _seller(db, lut_active=False)
    buyer = _buyer(db, "gold-exp-nolut@t.dev", billing_country="US")
    inv = _invoice(db, buyer, amount=1900, currency="usd", inr_minor=160000)

    assert inv.supply_kind == "export"
    assert inv.taxable_value_minor == 1610
    assert inv.igst_minor == 290
    assert inv.total_tax_minor == 290
    assert inv.taxable_value_minor + inv.total_tax_minor == 1900


def test_export_without_lut_document_shows_the_igst_line(db, enabled):
    from app.services.invoice_pdf import render_invoice_html

    _seller(db, lut_active=False)
    buyer = _buyer(db, "gold-nolut-html@t.dev", billing_country="US")
    inv = _invoice(db, buyer, amount=1900, currency="usd", inr_minor=160000)

    html = render_invoice_html(inv)
    assert "IGST" in html
    assert "United States" in html


def test_export_lut_pdf_renders(db, enabled):
    """The export document must survive the REAL PDF pipeline, not just HTML —
    WeasyPrint chokes on layout constructs plain-string assertions never see.
    Skips where pango is unavailable (bare dev boxes); runs fully in CI/prod
    environments that render real invoices."""
    try:
        import weasyprint
    except (ImportError, OSError):
        pytest.skip("weasyprint or its system pango libraries unavailable")
    try:
        weasyprint.HTML(string="<p>probe</p>").write_pdf()
    except Exception:
        pytest.skip("weasyprint present but cannot render (missing native libs)")

    from app.services.invoice_pdf import render_invoice_html

    _seller(db, lut_active=True)
    buyer = _buyer(db, "gold-exp-pdf@t.dev", billing_country="US")
    inv = _invoice(db, buyer, amount=1900, currency="usd", inr_minor=160000)

    pdf = weasyprint.HTML(string=render_invoice_html(inv)).write_pdf()
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 5_000  # a real multi-section document, not a blank page
