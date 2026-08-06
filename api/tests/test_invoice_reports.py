"""GSTR-1-style report rows + reconciliation anomalies (Phase 7)."""

import os
from datetime import UTC, datetime

import pytest
from sqlalchemy import update as _sa_update

from app import config
from app.db.models import Client, Invoice
from app.services import invoice_reports, invoice_service
from app.services.seller_profile_service import save_seller_profile


def _raw_tamper(db, inv, **cols):
    """Mutate a finalized invoice at the DB level, bypassing the ORM immutability
    guard (finding L). Models the out-of-band edits / corruption that the
    reconciliation anomaly detector exists to catch."""
    db.execute(_sa_update(Invoice).where(Invoice.id == inv.id).values(**cols))
    db.expire(inv)


pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

# Fixed month for the pure window test; the DB tests use the CURRENT IST month
# because finalize issues documents at "now" (a hardcoded month would rot).
JULY = "2026-07"
THIS_MONTH = f"{datetime.now(invoice_reports.IST):%Y-%m}"


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)


def _seller(db, **overrides):
    payload = {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}
    payload.update(overrides)
    save_seller_profile(db, payload, actor_id=None)


def _client_row(db, email, **billing):
    c = Client(name=f"C-{email}", email=email, api_key=f"key-{email}", **billing)
    db.add(c)
    db.flush()
    return c


def _finalized(db, email, *, gstin=None, state="27", country="IN", amount=179900, pay_ref=None):
    c = _client_row(db, email, gstin=gstin, billing_state_code=state, billing_country=country)
    if (country or "IN") != "IN":
        # Wave 1.1 export backstop: an INR-settled export only finalizes for
        # accounts with a genuine foreign-currency charge history — corroborate.
        db.add(Invoice(client_id=c.id, amount_cents=1900, currency="usd", status="paid", inr_amount_minor=160000))
        db.flush()
    inv = Invoice(
        client_id=c.id,
        amount_cents=amount,
        currency="inr",
        status="paid",
        razorpay_payment_id=pay_ref or f"pay-{email}",
    )
    db.add(inv)
    db.flush()
    assert invoice_service.finalize_invoice(db, inv) is True
    return inv


def _finalized_usd(db, email, *, amount=900, inr=80_507, pay_ref=None):
    """A finalized export: $9.00 that Razorpay converted to ₹805.07."""
    c = _client_row(db, email, billing_state_code=None, billing_country="US")
    inv = Invoice(
        client_id=c.id,
        amount_cents=amount,
        currency="usd",
        status="paid",
        inr_amount_minor=inr,
        razorpay_payment_id=pay_ref or f"pay-{email}",
    )
    db.add(inv)
    db.flush()
    assert invoice_service.finalize_invoice(db, inv) is True
    return inv


def test_month_window_is_ist():
    start, end = invoice_reports.month_window_utc(JULY)
    # 1 Jul 2026 00:00 IST == 30 Jun 2026 18:30 UTC.
    assert start == datetime(2026, 6, 30, 18, 30, tzinfo=UTC)
    assert end == datetime(2026, 7, 31, 18, 30, tzinfo=UTC)
    with pytest.raises(ValueError):
        invoice_reports.month_window_utc("garbage")


def test_rows_sectioned_b2b_b2c_export_cdnr(db, enabled):
    _seller(db, lut_active=True, lut_number="LUT-1")
    b2b = _finalized(db, "rep-b2b@test.example", gstin="29AAGCB7383J1Z4", state="29")
    _finalized(db, "rep-b2c@test.example")  # no buyer GSTIN → B2C
    _finalized(db, "rep-exp@test.example", state=None, country="US")  # export
    note = invoice_service.create_credit_note(db, b2b, 89950, provider_ref="rfnd_rep_1")

    report = invoice_reports.gstr_document_rows(db, THIS_MONTH)
    sections = {r["section"] for r in report}
    assert sections == {"B2B", "B2CS", "EXP", "CDNR"}

    b2b_row = next(r for r in report if r["section"] == "B2B")
    assert b2b_row["buyer_gstin"] == "29AAGCB7383J1Z4"
    assert b2b_row["place_of_supply"] == "29"
    assert b2b_row["igst_minor"] == 27442  # inter-state (27 seller → 29 buyer)
    assert b2b_row["taxable_minor"] == 152458

    exp_row = next(r for r in report if r["section"] == "EXP")
    assert exp_row["place_of_supply"] == "96"  # GSTR-1 6A: exports report POS 96
    assert exp_row["total_tax_minor"] == 0  # zero-rated under LUT

    cdnr_row = next(r for r in report if r["section"] == "CDNR")
    assert cdnr_row["against_invoice"] == b2b.invoice_number
    assert cdnr_row["invoice_number"] == note.invoice_number


def test_rows_exclude_legacy_receipts_and_other_months(db, enabled):
    _seller(db)
    inv = _finalized(db, "rep-in@test.example")
    # Legacy row (unnumbered) and a receipt (no tax) must not appear.
    c = _client_row(db, "rep-leg@test.example")
    db.add(Invoice(client_id=c.id, amount_cents=100, currency="inr", status="paid"))
    db.flush()
    # Move a numbered doc out of the window.
    other = _finalized(db, "rep-aug@test.example", pay_ref="pay-aug")
    _, window_end = invoice_reports.month_window_utc(THIS_MONTH)
    _raw_tamper(db, other, issued_at=window_end)  # first instant of the NEXT month

    report = invoice_reports.gstr_document_rows(db, THIS_MONTH)
    numbers = {r["invoice_number"] for r in report}
    assert inv.invoice_number in numbers
    assert other.invoice_number not in numbers
    assert len(report) == 1


def test_summary_totals_reconcile(db, enabled):
    _seller(db)
    _finalized(db, "rep-s1@test.example")
    _finalized(db, "rep-s2@test.example", gstin="29AAGCB7383J1Z4", state="29")
    summary = invoice_reports.gstr_summary(db, THIS_MONTH)
    total = summary["sections"]["B2B"]
    assert total["count"] == 1
    assert total["taxable_minor"] + total["total_tax_minor"] == 179900
    grand = summary["grand_total"]
    assert grand["count"] == 2
    assert grand["taxable_minor"] == 152458 * 2
    assert grand["total_tax_minor"] == 27442 * 2


# ── foreign-currency documents on a rupee return ──────────────────────────────


def test_export_row_reports_rupees_not_the_face_currency(db, enabled):
    # GSTR-1 is rupee-denominated. The money columns of a $9 export must be the
    # ₹805.07 mirror, with the dollar figures carried separately for tie-out.
    _seller(db, lut_active=True, lut_number="LUT-1")
    _finalized_usd(db, "rep-usd@test.example")

    row = next(r for r in invoice_reports.gstr_document_rows(db, THIS_MONTH) if r["section"] == "EXP")
    assert row["gross_minor"] == 80_507
    assert row["taxable_minor"] == 80_507
    assert row["total_tax_minor"] == 0
    assert row["place_of_supply"] == "96"
    # The document the customer holds, for tying the return back to the invoice
    # and the bank's FIRC.
    assert row["currency"] == "USD"
    assert row["doc_gross_minor"] == 900
    assert row["fx_rate_micros"] == 89_452_222


def test_summary_never_adds_cents_to_paise(db, enabled):
    # The bug this prevents: summing a $9 document's FACE value (900 cents)
    # with a ₹1,799 document's paise (179900) produces 180800 — a number that
    # is not money in any currency, and looks entirely normal on a CA's sheet.
    _seller(db, lut_active=True, lut_number="LUT-1")
    _finalized(db, "rep-mix-inr@test.example")
    _finalized_usd(db, "rep-mix-usd@test.example")

    grand = invoice_reports.gstr_summary(db, THIS_MONTH)["grand_total"]
    assert grand["count"] == 2
    assert grand["gross_minor"] == 179_900 + 80_507
    assert grand["gross_minor"] != 179_900 + 900


def test_igst_paid_export_reports_remittable_tax_in_rupees(db, enabled):
    # No LUT → IGST is owed in rupees, and the rupee figure is what is filed.
    _seller(db)  # lut_active defaults False
    _finalized_usd(db, "rep-usd-nolut@test.example")

    row = next(r for r in invoice_reports.gstr_document_rows(db, THIS_MONTH) if r["section"] == "EXP")
    assert (row["taxable_minor"], row["igst_minor"]) == (68_226, 12_281)
    assert row["taxable_minor"] + row["total_tax_minor"] == row["gross_minor"]
    assert (row["doc_taxable_minor"], row["doc_total_tax_minor"]) == (763, 137)


def test_full_refund_of_an_export_nets_rupee_turnover_to_zero(db, enabled):
    # A credit note is reported in the same rupee terms as the document it
    # reverses. Re-converting at a later rate would leave a residue in export
    # turnover that no refund could ever clear.
    _seller(db, lut_active=True, lut_number="LUT-1")
    inv = _finalized_usd(db, "rep-usd-refund@test.example")
    note = invoice_service.create_credit_note(db, inv, 900, provider_ref="rfnd_usd_full")
    assert note.inr_amount_minor == inv.inr_amount_minor
    assert note.fx_rate_micros == inv.fx_rate_micros

    grand = invoice_reports.gstr_summary(db, THIS_MONTH)["grand_total"]
    assert grand["gross_minor"] == 0
    assert grand["taxable_minor"] == 0


def test_partial_refund_of_an_export_converts_at_the_original_rate(db, enabled):
    _seller(db, lut_active=True, lut_number="LUT-1")
    inv = _finalized_usd(db, "rep-usd-part@test.example")
    note = invoice_service.create_credit_note(db, inv, 300, provider_ref="rfnd_usd_part")
    # $3.00 at the document's frozen 89.452222 → ₹268.36.
    assert note.inr_amount_minor == 26_836
    assert note.currency == "usd"

    grand = invoice_reports.gstr_summary(db, THIS_MONTH)["grand_total"]
    assert grand["gross_minor"] == 80_507 - 26_836


def test_anomaly_flags_a_numbered_export_with_no_inr_mirror(db, enabled):
    # Unreachable through finalize; models an out-of-band write. Such a row
    # cannot be placed on a rupee return at all.
    _seller(db, lut_active=True, lut_number="LUT-1")
    inv = _finalized_usd(db, "rep-usd-tamper@test.example")
    _raw_tamper(db, inv, inr_amount_minor=None)

    anomalies = invoice_reports.reconciliation_anomalies(db)
    assert [a["id"] for a in anomalies["exports_without_fx"]] == [inv.id]
    # ...and its rupee columns read as absent, never as a zero-value supply.
    row = next(r for r in invoice_reports.gstr_document_rows(db, THIS_MONTH) if r["section"] == "EXP")
    assert row["gross_minor"] is None
    assert row["taxable_minor"] is None


def test_anomaly_flags_an_unnumbered_foreign_charge(db, enabled):
    # These used to be excluded because finalize refused every non-INR charge,
    # so flagging them would have been permanent noise. Now an un-numbered
    # export means a paying customer holding no invoice.
    _seller(db, lut_active=True, lut_number="LUT-1")
    c = _client_row(db, "rep-usd-unnum@test.example", billing_country="US")
    stale = datetime.now(UTC) - invoice_reports.PDF_STUCK_AFTER * 2
    inv = Invoice(
        client_id=c.id,
        amount_cents=900,
        currency="usd",
        status="paid",
        paid_at=stale,  # no inr_amount_minor → finalize refused it
    )
    db.add(inv)
    db.flush()

    anomalies = invoice_reports.reconciliation_anomalies(db)
    assert inv.id in [a["id"] for a in anomalies["unnumbered_charges"]]


def test_anomaly_refund_without_credit_note(db, enabled):
    _seller(db)
    ok = _finalized(db, "rep-ok@test.example")
    invoice_service.create_credit_note(db, ok, 179900, provider_ref="rfnd_ok")
    ok.status = "refunded"
    orphan = _finalized(db, "rep-orphan@test.example", pay_ref="pay-orphan")
    orphan.status = "refunded"  # refunded but the CN creation was swallowed
    db.flush()

    anomalies = invoice_reports.reconciliation_anomalies(db)
    missing = anomalies["refunds_without_credit_note"]
    assert [r["id"] for r in missing] == [orphan.id]


def test_anomaly_stuck_pdfs_and_broken_totals(db, enabled):
    _seller(db)
    stuck = _finalized(db, "rep-stuck@test.example")
    _raw_tamper(db, stuck, issued_at=datetime(2026, 7, 1, tzinfo=UTC))  # long past the sweep interval
    broken = _finalized(db, "rep-broken@test.example", pay_ref="pay-broken")
    # Simulate a corrupted row via raw SQL — the ORM guard (finding L) now makes
    # this impossible through normal code; reconciliation is the backstop.
    _raw_tamper(db, broken, total_tax_minor=broken.total_tax_minor + 1)

    anomalies = invoice_reports.reconciliation_anomalies(db)
    assert any(r["id"] == stuck.id for r in anomalies["pdfs_pending"])
    assert [r["id"] for r in anomalies["broken_totals"]] == [broken.id]


def test_gstr_export_csv_endpoint(db, enabled, monkeypatch):
    from contextlib import contextmanager
    from types import SimpleNamespace

    from fastapi import FastAPI
    from fastapi.testclient import TestClient as HttpClient

    from app.api import superadmin_routes_v2
    from app.api.auth import get_superadmin

    @contextmanager
    def _ctx(session):
        yield session

    _seller(db)
    inv = _finalized(db, "rep-csv@test.example", gstin="29AAGCB7383J1Z4", state="29")
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(
        id=None, name="A", is_superadmin=True, superadmin_role="owner"
    )
    c = HttpClient(app)
    res = c.get(f"/superadmin/billing/gstr-export?month={THIS_MONTH}")
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/csv")
    body = res.text
    assert inv.invoice_number in body
    assert "B2B" in body
    # Rupee-denominated with the exact carve-out figures.
    assert "1524.58" in body and "274.42" in body
    assert "SUMMARY,TOTAL,1" in body
    # Malformed month → validation error, not a crash.
    assert c.get("/superadmin/billing/gstr-export?month=garbage").status_code == 422


def test_reconciliation_endpoint(db, enabled, monkeypatch):
    from contextlib import contextmanager
    from types import SimpleNamespace

    from fastapi import FastAPI
    from fastapi.testclient import TestClient as HttpClient

    from app.api import superadmin_routes_v2
    from app.api.auth import get_superadmin

    @contextmanager
    def _ctx(session):
        yield session

    _seller(db)
    orphan = _finalized(db, "rep-rec@test.example")
    orphan.status = "refunded"
    db.flush()
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(
        id=None, name="A", is_superadmin=True, superadmin_role="owner"
    )
    res = HttpClient(app).get("/superadmin/billing/reconciliation")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["counts"]["refunds_without_credit_note"] == 1
    assert body["refunds_without_credit_note"][0]["id"] == orphan.id


def test_reconciliation_cron_counts_and_logs(db, enabled, monkeypatch, caplog):
    import asyncio
    import logging
    from contextlib import contextmanager

    from app.worker import tasks as worker_tasks

    @contextmanager
    def _ctx():
        yield db

    _seller(db)
    orphan = _finalized(db, "rep-cron@test.example")
    orphan.status = "dispute_lost"
    db.flush()
    monkeypatch.setattr(worker_tasks, "_invoice_pdf_session", _ctx)
    with caplog.at_level(logging.ERROR):
        total = asyncio.run(worker_tasks.task_invoice_reconciliation_alert({}))
    assert total >= 1
    assert any("reconciliation anomalies" in r.message for r in caplog.records)


def test_b2cl_split_for_large_interstate_b2c(db, enabled):
    _seller(db)  # seller state 27
    # Inter-state (29), unregistered, > ₹1,00,000 → B2CL, not B2CS.
    big = _finalized(db, "rep-b2cl@test.example", state="29", amount=150_000_00)
    small = _finalized(db, "rep-b2cs@test.example", state="29", amount=4_599_00, pay_ref="pay-small")
    report = invoice_reports.gstr_document_rows(db, THIS_MONTH)
    by_num = {r["invoice_number"]: r["section"] for r in report}
    assert by_num[big.invoice_number] == "B2CL"
    assert by_num[small.invoice_number] == "B2CS"


def test_receipt_credit_note_excluded_from_report(db, enabled):
    _seller(db, gstin=None)  # receipt mode (no GSTIN)
    receipt = _finalized(db, "rep-rcpt@test.example")
    assert receipt.invoice_type == "receipt"
    note = invoice_service.create_credit_note(db, receipt, 179900, provider_ref="rfnd_rcpt")
    assert note.invoice_type == "credit_note"
    assert note.tax_rate_bps is None  # no GST breakup
    report = invoice_reports.gstr_document_rows(db, THIS_MONTH)
    # Neither the receipt nor its non-tax reversal belongs in GSTR-1.
    assert report == []


def test_grand_total_is_net_of_credit_notes(db, enabled):
    _seller(db)
    inv = _finalized(db, "rep-net@test.example")
    invoice_service.create_credit_note(db, inv, 179900, provider_ref="rfnd_net")  # full reversal
    summary = invoice_reports.gstr_summary(db, THIS_MONTH)
    # Sale (B2CS) minus its credit note (CDNUR) → net zero turnover.
    assert summary["grand_total"]["taxable_minor"] == 0
    assert summary["grand_total"]["total_tax_minor"] == 0
    # But per-section magnitudes stay positive.
    assert summary["sections"]["B2CS"]["taxable_minor"] == 152458
    assert summary["sections"]["CDNUR"]["taxable_minor"] == 152458


def test_csv_export_neutralizes_formula_injection(db, enabled, monkeypatch):
    from contextlib import contextmanager
    from types import SimpleNamespace

    from fastapi import FastAPI
    from fastapi.testclient import TestClient as HttpClient

    from app.api import superadmin_routes_v2
    from app.api.auth import get_superadmin

    @contextmanager
    def _ctx(session):
        yield session

    _seller(db)
    # Customer-controlled legal name with an Excel formula payload.
    c = _client_row(db, "rep-inject@test.example", legal_name='=HYPERLINK("http://evil")', billing_state_code="27")
    inv = Invoice(client_id=c.id, amount_cents=179900, currency="inr", status="paid", razorpay_payment_id="pay-inject")
    db.add(inv)
    db.flush()
    invoice_service.finalize_invoice(db, inv)

    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(
        id=None, name="A", is_superadmin=True, superadmin_role="owner"
    )
    body = HttpClient(app).get(f"/superadmin/billing/gstr-export?month={THIS_MONTH}").text
    assert "'=HYPERLINK" in body  # neutralised with a leading quote
    # Never appears as a bare cell (right after a delimiter or opening quote) —
    # only ever behind the neutralising apostrophe.
    assert ",=HYPERLINK" not in body
    assert '"=HYPERLINK' not in body
    assert body.startswith("﻿")  # UTF-8 BOM for Excel
