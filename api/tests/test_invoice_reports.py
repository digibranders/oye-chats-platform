"""GSTR-1-style report rows + reconciliation anomalies (Phase 7)."""

import os
from datetime import UTC, datetime

import pytest

from app import config
from app.db.models import Client, Invoice
from app.services import invoice_reports, invoice_service
from app.services.seller_profile_service import save_seller_profile

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
    other.issued_at = window_end  # first instant of the NEXT month
    db.flush()

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
    stuck.issued_at = datetime(2026, 7, 1, tzinfo=UTC)  # long past the sweep interval
    broken = _finalized(db, "rep-broken@test.example", pay_ref="pay-broken")
    # Simulate a corrupted row (should be impossible — that's the point).
    broken.total_tax_minor = broken.total_tax_minor + 1
    db.flush()

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
