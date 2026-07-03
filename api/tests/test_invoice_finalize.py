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


def test_non_inr_currency_is_skipped(db, enabled):
    _seller(db)
    c = _client(db, "fin-usd@test.example", billing_state_code="27")
    inv = _invoice(db, c.id, currency="usd")
    assert invoice_service.finalize_invoice(db, inv) is False
    assert inv.invoice_number is None
    assert inv.invoice_type == "legacy"


def test_unconfigured_seller_yields_receipt(db, enabled):
    # No seller profile persisted at all → defaults (gst_enabled False) → receipt.
    c = _client(db, "fin-noseller@test.example", billing_state_code="27")
    inv = _invoice(db, c.id)
    assert invoice_service.finalize_invoice(db, inv) is True
    assert inv.invoice_type == "receipt"
    assert inv.invoice_number.startswith("RCT/")  # reserved receipt series


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
