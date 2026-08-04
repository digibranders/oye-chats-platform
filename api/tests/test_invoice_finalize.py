"""finalize_invoice — flag gating, tax computation, snapshots, idempotency."""

import os

import pytest

from app import config
from app.db.models import Client, Invoice
from app.services import invoice_service
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


def _invoice(db, client_id, amount=179900, currency="inr", **kw):
    inv = Invoice(client_id=client_id, amount_cents=amount, currency=currency, status="paid", **kw)
    db.add(inv)
    db.flush()
    return inv


def test_noop_when_flag_disabled(db, monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", False)
    _seller(db)
    c = _client(db, "fin-off@test.example", billing_state_code="27")
    inv = _invoice(db, c.id)
    assert invoice_service.finalize_invoice(db, inv) is False
    assert inv.invoice_number is None
    assert inv.invoice_type == "legacy"


def test_intra_state_tax_invoice(db, enabled):
    _seller(db)  # seller GSTIN state 27
    c = _client(db, "fin-intra@test.example", billing_state_code="27", billing_country="IN")
    inv = _invoice(db, c.id)
    assert invoice_service.finalize_invoice(db, inv) is True
    assert inv.invoice_type == "tax_invoice"
    # Exact serial pinned against the FY derived from the actual issue instant
    # (a literal FY string would go stale; an `or startswith` could never fail).
    assert inv.invoice_number == f"DB/{invoice_service.financial_year_label(inv.issued_at)}/000001"
    assert inv.taxable_value_minor == 152458
    assert inv.cgst_minor == 13721 and inv.sgst_minor == 13721
    assert inv.igst_minor == 0
    assert inv.total_tax_minor == 27442
    assert inv.hsn_sac == "997331"
    assert inv.place_of_supply == "27"
    assert inv.supply_kind == "intra"
    assert inv.issued_at is not None


def test_inter_state_uses_igst(db, enabled):
    _seller(db)  # seller state 27
    c = _client(db, "fin-inter@test.example", billing_state_code="29", billing_country="IN")
    inv = _invoice(db, c.id)
    invoice_service.finalize_invoice(db, inv)
    assert inv.igst_minor == 27442
    assert inv.cgst_minor == 0 and inv.sgst_minor == 0
    assert inv.supply_kind == "inter"
    assert inv.place_of_supply == "29"


def test_export_with_lut_zero_rated(db, enabled):
    _seller(db, lut_active=True, lut_number="LUT-2026-1")
    c = _client(db, "fin-export@test.example", billing_country="US")
    inv = _invoice(db, c.id)
    invoice_service.finalize_invoice(db, inv)
    assert inv.total_tax_minor == 0
    assert inv.is_export is True
    assert inv.supply_kind == "export"
    assert inv.place_of_supply is None


def test_b2c_no_state_defaults_to_supplier_state(db, enabled):
    _seller(db)  # seller state 27
    c = _client(db, "fin-b2c@test.example", billing_country="IN")  # no state
    inv = _invoice(db, c.id)
    invoice_service.finalize_invoice(db, inv)
    assert inv.supply_kind == "intra"
    assert inv.place_of_supply == "27"  # supplier's own state (Circular 242)


def test_receipt_mode_without_seller_gstin(db, enabled):
    _seller(db, gstin=None)  # no GSTIN → receipt mode
    c = _client(db, "fin-receipt@test.example", billing_state_code="27")
    inv = _invoice(db, c.id)
    invoice_service.finalize_invoice(db, inv)
    assert inv.invoice_type == "receipt"
    # Receipts run on their own reserved series, never the tax-invoice range.
    assert inv.invoice_number.startswith("RCT/")
    assert inv.total_tax_minor is None  # no tax breakup in receipt mode


def test_receipts_never_consume_tax_invoice_serials(db, enabled):
    # Receipt issued pre-GSTIN, then GST mode enabled mid-FY: the first tax
    # invoice must still be serial 000001 of the DB series (Rule 46 gapless
    # range must not interleave receipts).
    _seller(db, gstin=None)
    c = _client(db, "fin-series@test.example", billing_state_code="27")
    receipt = _invoice(db, c.id)
    invoice_service.finalize_invoice(db, receipt)
    assert receipt.invoice_number.startswith("RCT/")

    _seller(db, gstin="27AAPFU0939F1ZV")  # GSTIN added mid-FY
    tax_inv = _invoice(db, c.id)
    invoice_service.finalize_invoice(db, tax_inv)
    assert tax_inv.invoice_type == "tax_invoice"
    assert tax_inv.invoice_number.endswith("000001")
    assert tax_inv.invoice_number.startswith("DB/")


def test_idempotent_second_call_is_noop(db, enabled):
    _seller(db)
    c = _client(db, "fin-idem@test.example", billing_state_code="27")
    inv = _invoice(db, c.id)
    assert invoice_service.finalize_invoice(db, inv) is True
    first_number = inv.invoice_number
    assert invoice_service.finalize_invoice(db, inv) is False  # already finalized
    assert inv.invoice_number == first_number


def test_snapshots_captured(db, enabled):
    _seller(db)
    c = _client(
        db,
        "fin-snap@test.example",
        legal_name="Acme Industries Pvt Ltd",
        gstin="29AAGCB7383J1Z4",
        billing_state_code="29",
        billing_country="IN",
    )
    inv = _invoice(db, c.id)
    invoice_service.finalize_invoice(db, inv)
    assert inv.seller_snapshot["gstin"] == "27AAPFU0939F1ZV"
    assert inv.buyer_snapshot["gstin"] == "29AAGCB7383J1Z4"
    assert inv.buyer_snapshot["legal_name"] == "Acme Industries Pvt Ltd"
    assert inv.line_items[0]["amount_minor"] == 179900


# ── non-INR (export) documents ────────────────────────────────────────────────
#
# A foreign charge is issued in the currency of supply and carries an INR
# mirror, because GSTR-1 Table 6A reports exports in rupees and IGST on a
# non-LUT export is remitted in rupees. The mirror is built from Razorpay's
# ``base_amount`` — the paise it actually converted at the processing bank's
# rate on the payment date, which is the Rule 34(2) GAAP rate for a service.
#
# $9.00 came back as ₹805.07, i.e. 89.452222 INR/USD.
_USD_MINOR = 900
_INR_MINOR = 80_507
_RATE_MICROS = 89_452_222


def test_export_in_usd_is_finalized_with_an_inr_mirror(db, enabled):
    _seller(db, lut_active=True, lut_number="LUT-2026-1")
    c = _client(db, "fin-usd-lut@test.example", billing_country="US")
    inv = _invoice(db, c.id, amount=_USD_MINOR, currency="usd", inr_amount_minor=_INR_MINOR)

    assert invoice_service.finalize_invoice(db, inv) is True
    assert inv.invoice_type == "tax_invoice"
    assert inv.invoice_number is not None
    assert inv.is_export is True
    # The DOCUMENT is denominated in the currency of supply.
    assert inv.taxable_value_minor == _USD_MINOR
    assert inv.total_tax_minor == 0  # zero-rated under LUT
    # The RETURN is denominated in rupees.
    assert inv.inr_amount_minor == _INR_MINOR
    assert inv.inr_taxable_value_minor == _INR_MINOR
    assert inv.inr_total_tax_minor == 0
    assert inv.fx_rate_micros == _RATE_MICROS
    assert inv.fx_rate_source == "razorpay_base_amount"


def test_export_without_lut_carves_igst_in_both_currencies(db, enabled):
    # Rule 96A: an export made WITHOUT a LUT is made on payment of IGST. The
    # tax is shown on the document in the currency of supply, and remitted to
    # the government in rupees — so both breakups have to exist and both have
    # to reconcile against their own total.
    _seller(db)  # lut_active defaults False
    c = _client(db, "fin-usd-nolut@test.example", billing_country="US")
    inv = _invoice(db, c.id, amount=_USD_MINOR, currency="usd", inr_amount_minor=_INR_MINOR)

    assert invoice_service.finalize_invoice(db, inv) is True
    assert (inv.taxable_value_minor, inv.igst_minor) == (763, 137)
    assert inv.taxable_value_minor + inv.total_tax_minor == _USD_MINOR
    assert (inv.inr_taxable_value_minor, inv.inr_total_tax_minor) == (68_226, 12_281)
    assert inv.inr_taxable_value_minor + inv.inr_total_tax_minor == _INR_MINOR


def test_non_inr_on_a_domestic_supply_is_refused(db, enabled):
    # A dollar charge whose buyer is now in India: the customer moved, so the
    # supply is domestic while the live mandate still bills USD. Numbering it
    # would produce a domestic tax invoice denominated in dollars with rupee
    # tax columns. Refuse and leave it for ops to re-point the mandate.
    _seller(db)
    c = _client(db, "fin-usd-domestic@test.example", billing_state_code="27", billing_country="IN")
    inv = _invoice(db, c.id, amount=_USD_MINOR, currency="usd", inr_amount_minor=_INR_MINOR)

    assert invoice_service.finalize_invoice(db, inv) is False
    assert inv.invoice_number is None
    assert inv.invoice_type == "legacy"


def test_non_inr_without_a_captured_conversion_is_refused(db, enabled):
    # No ``base_amount`` means no defensible Rule 34 rate. A document we cannot
    # report is worse than a document issued late — the sweep retries, and the
    # anomaly report surfaces it.
    _seller(db, lut_active=True, lut_number="LUT-2026-1")
    c = _client(db, "fin-usd-nofx@test.example", billing_country="US")
    inv = _invoice(db, c.id, amount=_USD_MINOR, currency="usd", inr_amount_minor=None)

    assert invoice_service.finalize_invoice(db, inv) is False
    assert inv.invoice_number is None


def test_non_inr_with_an_implausible_rate_is_refused(db, enabled):
    # base_amount delivered in rupees rather than paise → 8,945 INR/USD. A
    # 100x-off taxable value on a filed return is unrecoverable; refuse.
    _seller(db, lut_active=True, lut_number="LUT-2026-1")
    c = _client(db, "fin-usd-badfx@test.example", billing_country="US")
    inv = _invoice(db, c.id, amount=_USD_MINOR, currency="usd", inr_amount_minor=_INR_MINOR * 100)

    assert invoice_service.finalize_invoice(db, inv) is False
    assert inv.invoice_number is None


def test_inr_invoice_leaves_the_fx_mirror_null(db, enabled):
    # On a rupee document ``amount_cents``/``taxable_value_minor`` ARE the
    # reportable figures. A mirror here would be a second source of truth for
    # the same number — NULL, not a copy.
    _seller(db)
    c = _client(db, "fin-inr-nofx@test.example", billing_state_code="27", billing_country="IN")
    inv = _invoice(db, c.id)
    assert invoice_service.finalize_invoice(db, inv) is True
    assert inv.inr_amount_minor is None
    assert inv.inr_taxable_value_minor is None
    assert inv.inr_total_tax_minor is None
    assert inv.fx_rate_micros is None
    assert inv.fx_rate_source is None


def test_unconfigured_seller_stays_legacy(db, enabled):
    # ACTIVATION GATE: flags default ON, so an unconfigured seller profile must
    # mean "not activated yet" — no document (a receipt with an empty legal
    # name would be worse than none).
    c = _client(db, "fin-noseller@test.example", billing_state_code="27")
    inv = _invoice(db, c.id)
    assert invoice_service.finalize_invoice(db, inv) is False
    assert inv.invoice_type == "legacy"
    assert inv.invoice_number is None


def test_finalized_tax_fields_survive_status_flip(db, enabled):
    _seller(db)
    c = _client(db, "fin-immut@test.example", billing_state_code="27")
    inv = _invoice(db, c.id)
    invoice_service.finalize_invoice(db, inv)
    number, taxable, tax = inv.invoice_number, inv.taxable_value_minor, inv.total_tax_minor
    # A refund flips status for display only; the tax facts stay frozen.
    inv.status = "refunded"
    db.flush()
    assert inv.invoice_number == number
    assert inv.taxable_value_minor == taxable
    assert inv.total_tax_minor == tax


def test_finalize_safely_rolls_back_burned_serial_on_late_failure(db, enabled, monkeypatch):
    # A failure AFTER the serial is allocated must roll back the counter via the
    # savepoint, so no number is burned and the money path is unaffected.
    _seller(db)
    c = _client(db, "fin-safe@test.example", billing_state_code="27")
    inv = _invoice(db, c.id)

    def _boom(_buyer):
        raise RuntimeError("snapshot boom")

    original = invoice_service._buyer_snapshot
    monkeypatch.setattr(invoice_service, "_buyer_snapshot", _boom)
    assert invoice_service.finalize_invoice_safely(db, inv) is False
    assert inv.invoice_number is None  # savepoint rolled the enrichment back

    # Restore only the snapshot helper (keep the enabled flag) and prove the
    # serial was NOT burned by the failed attempt.
    monkeypatch.setattr(invoice_service, "_buyer_snapshot", original)
    c2 = _client(db, "fin-safe2@test.example", billing_state_code="27")
    inv2 = _invoice(db, c2.id)
    assert invoice_service.finalize_invoice_safely(db, inv2) is True
    assert inv2.invoice_number.endswith("000001")
