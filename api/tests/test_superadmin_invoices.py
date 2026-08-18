"""Super-admin invoice console endpoints. List/detail/resend/regenerate."""

import os
from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_routes_v2
from app.api.auth import get_superadmin
from app.db.models import Client, Invoice

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _client(db, monkeypatch, role="owner") -> TestClient:
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(
        id=None, name="Admin", is_superadmin=True, superadmin_role=role
    )
    return TestClient(app)


def _mk_invoice(db, email, number, **kw):
    c = Client(name=f"C-{email}", email=email, api_key=f"key-{email}")
    db.add(c)
    db.flush()
    inv = Invoice(
        client_id=c.id,
        amount_cents=kw.pop("amount_cents", 179900),
        currency="inr",
        status=kw.pop("status", "paid"),
        invoice_type=kw.pop("invoice_type", "tax_invoice"),
        invoice_number=number,
        issued_at=kw.pop("issued_at", datetime(2026, 7, 2, tzinfo=UTC)),
        total_tax_minor=27442,
        taxable_value_minor=152458,
        buyer_snapshot={"email": f"buyer-{email}", "legal_name": "Acme Pvt Ltd"},
        **kw,
    )
    db.add(inv)
    db.flush()
    return inv


def test_list_returns_documents_with_client_names(db, monkeypatch):
    _mk_invoice(db, "sa-list-1@test.example", "DB/26-27/000001")
    _mk_invoice(db, "sa-list-2@test.example", "CN/26-27/000001", invoice_type="credit_note", status="issued")
    c = _client(db, monkeypatch)
    res = c.get("/superadmin/invoices")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total"] == 2
    numbers = {r["invoice_number"] for r in body["items"]}
    assert numbers == {"DB/26-27/000001", "CN/26-27/000001"}
    row = next(r for r in body["items"] if r["invoice_number"] == "DB/26-27/000001")
    assert row["client_name"].startswith("C-sa-list-1")
    assert row["total_tax_minor"] == 27442


def test_list_filters_by_type_and_search(db, monkeypatch):
    _mk_invoice(db, "sa-f1@test.example", "DB/26-27/000010")
    _mk_invoice(db, "sa-f2@test.example", "CN/26-27/000010", invoice_type="credit_note")
    c = _client(db, monkeypatch)
    assert c.get("/superadmin/invoices?invoice_type=credit_note").json()["total"] == 1
    assert c.get("/superadmin/invoices?search=DB/26-27/000010").json()["total"] == 1
    assert c.get("/superadmin/invoices?search=sa-f2@test.example").json()["total"] == 1


def test_list_excludes_legacy_by_default_but_can_include(db, monkeypatch):
    _mk_invoice(db, "sa-leg@test.example", None, invoice_type="legacy")
    _mk_invoice(db, "sa-num@test.example", "DB/26-27/000020")
    c = _client(db, monkeypatch)
    assert c.get("/superadmin/invoices").json()["total"] == 1
    assert c.get("/superadmin/invoices?include_legacy=true").json()["total"] == 2


def test_detail_returns_full_document(db, monkeypatch):
    inv = _mk_invoice(db, "sa-detail@test.example", "DB/26-27/000030")
    c = _client(db, monkeypatch)
    res = c.get(f"/superadmin/invoices/{inv.id}")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["invoice_number"] == "DB/26-27/000030"
    assert body["buyer_snapshot"]["legal_name"] == "Acme Pvt Ltd"
    assert body["taxable_value_minor"] == 152458
    assert c.get("/superadmin/invoices/999999").status_code == 404


def test_resend_email_requires_pdf_and_buyer_email(db, monkeypatch):
    sent = []
    monkeypatch.setattr(
        superadmin_routes_v2, "_send_invoice_email_now", lambda to, inv, url: sent.append((to, inv.invoice_number))
    )
    no_pdf = _mk_invoice(db, "sa-resend-1@test.example", "DB/26-27/000040")
    with_pdf = _mk_invoice(db, "sa-resend-2@test.example", "DB/26-27/000041", pdf_url="https://cdn.test/x.pdf")
    c = _client(db, monkeypatch)
    assert c.post(f"/superadmin/invoices/{no_pdf.id}/resend-email").status_code == 409  # no PDF yet
    res = c.post(f"/superadmin/invoices/{with_pdf.id}/resend-email")
    assert res.status_code == 200, res.text
    assert sent == [("buyer-sa-resend-2@test.example", "DB/26-27/000041")]


def test_regenerate_pdf_clears_url_for_sweep(db, monkeypatch):
    inv = _mk_invoice(db, "sa-regen@test.example", "DB/26-27/000050", pdf_url="https://cdn.test/old.pdf")
    c = _client(db, monkeypatch)
    res = c.post(f"/superadmin/invoices/{inv.id}/regenerate-pdf")
    assert res.status_code == 200, res.text
    assert inv.pdf_url is None  # sweep re-renders within one tick
    # Legacy/unnumbered rows can't be regenerated.
    legacy = _mk_invoice(db, "sa-regen-leg@test.example", None, invoice_type="legacy")
    assert c.post(f"/superadmin/invoices/{legacy.id}/regenerate-pdf").status_code == 409


def test_readonly_admin_cannot_mutate(db, monkeypatch):
    inv = _mk_invoice(db, "sa-ro@test.example", "DB/26-27/000060", pdf_url="https://cdn.test/x.pdf")
    c = _client(db, monkeypatch, role="readonly")
    assert c.get("/superadmin/invoices").status_code == 200  # reads fine
    assert c.post(f"/superadmin/invoices/{inv.id}/resend-email").status_code == 403
    assert c.post(f"/superadmin/invoices/{inv.id}/regenerate-pdf").status_code == 403


def test_resend_email_blocked_by_kill_switch(db, monkeypatch):
    from app import config as app_config

    monkeypatch.setattr(app_config, "INVOICE_EMAILS_ENABLED", False)
    inv = _mk_invoice(db, "sa-kill@test.example", "DB/26-27/000070", pdf_url="https://cdn.test/x.pdf")
    c = _client(db, monkeypatch)
    res = c.post(f"/superadmin/invoices/{inv.id}/resend-email")
    assert res.status_code == 409
    assert "disabled" in res.json()["detail"]


def test_resend_email_stamps_emailed_at(db, monkeypatch):
    from app import config as app_config

    monkeypatch.setattr(app_config, "INVOICE_EMAILS_ENABLED", True)
    monkeypatch.setattr(superadmin_routes_v2, "_send_invoice_email_now", lambda to, inv, url: None)
    inv = _mk_invoice(db, "sa-stamp@test.example", "DB/26-27/000071", pdf_url="https://cdn.test/x.pdf")
    c = _client(db, monkeypatch)
    assert c.post(f"/superadmin/invoices/{inv.id}/resend-email").status_code == 200
    assert inv.emailed_at is not None
