"""Invoice tax-document columns + invoice_counters round-trip and defaults."""

import os

import pytest

from app.db.models import Client, Invoice, InvoiceCounter

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _mk_client(db, email):
    c = Client(name="T", email=email, api_key=f"key-{email}")
    db.add(c)
    db.flush()
    return c


def test_new_invoice_defaults_to_legacy_type(db):
    c = _mk_client(db, "inv-schema-1@test.example")
    inv = Invoice(client_id=c.id, amount_cents=179900, currency="inr", status="paid")
    db.add(inv)
    db.flush()
    assert inv.invoice_type == "legacy"
    assert inv.invoice_number is None
    assert inv.is_export is False


def test_tax_fields_roundtrip(db):
    c = _mk_client(db, "inv-schema-2@test.example")
    inv = Invoice(
        client_id=c.id,
        amount_cents=179900,
        currency="inr",
        status="paid",
        invoice_type="tax_invoice",
        invoice_number="DB/25-26/000001",
        place_of_supply="27",
        supply_kind="intra",
        taxable_value_minor=152458,
        tax_rate_bps=1800,
        cgst_minor=13721,
        sgst_minor=13721,
        igst_minor=0,
        total_tax_minor=27442,
        hsn_sac="997331",
        seller_snapshot={"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"},
        buyer_snapshot={"name": "T", "state_code": "27"},
        line_items=[{"description": "Starter — monthly", "amount_minor": 179900}],
    )
    db.add(inv)
    db.flush()
    got = db.get(Invoice, inv.id)
    assert got.cgst_minor + got.sgst_minor == got.total_tax_minor
    assert got.seller_snapshot["gstin"] == "27AAPFU0939F1ZV"


def test_invoice_number_unique(db):
    c = _mk_client(db, "inv-schema-3@test.example")
    db.add(Invoice(client_id=c.id, amount_cents=1, currency="inr", status="paid", invoice_number="DB/25-26/000002"))
    db.flush()
    db.add(Invoice(client_id=c.id, amount_cents=1, currency="inr", status="paid", invoice_number="DB/25-26/000002"))
    with pytest.raises(Exception, match="unique|Unique|duplicate"):
        db.flush()


def test_credit_note_self_fk(db):
    c = _mk_client(db, "inv-schema-4@test.example")
    original = Invoice(client_id=c.id, amount_cents=100, currency="inr", status="paid")
    db.add(original)
    db.flush()
    note = Invoice(
        client_id=c.id,
        amount_cents=-100,
        currency="inr",
        status="paid",
        invoice_type="credit_note",
        credit_note_of_id=original.id,
    )
    db.add(note)
    db.flush()
    assert note.credit_note_of_id == original.id


def test_invoice_counter_composite_key(db):
    from sqlalchemy import text

    db.add(InvoiceCounter(financial_year="25-26", prefix="DB", last_serial=41))
    db.flush()
    row = db.execute(
        text("SELECT last_serial FROM invoice_counters WHERE financial_year='25-26' AND prefix='DB'")
    ).scalar()
    assert row == 41


def test_list_invoices_exposes_tax_fields(db, monkeypatch):
    from contextlib import contextmanager

    from fastapi import FastAPI
    from fastapi.testclient import TestClient as HttpClient

    from app.api import subscription_routes
    from app.api.auth import get_current_client_strict

    @contextmanager
    def _ctx(session):
        yield session

    client = _mk_client(db, "inv-list-tax@test.example")
    db.add(
        Invoice(
            client_id=client.id,
            amount_cents=179900,
            currency="inr",
            status="paid",
            invoice_type="tax_invoice",
            invoice_number="DB/25-26/000009",
            total_tax_minor=27442,
            taxable_value_minor=152458,
            hsn_sac="997331",
            supply_kind="intra",
        )
    )
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    res = HttpClient(app).get("/subscriptions/invoices")
    assert res.status_code == 200, res.text
    row = next(r for r in res.json() if r.get("invoice_number") == "DB/25-26/000009")
    assert row["invoice_type"] == "tax_invoice"
    assert row["total_tax_minor"] == 27442
    assert row["taxable_value_minor"] == 152458
