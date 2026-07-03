"""Client deletion is blocked while issued tax invoices exist (GST retention)."""

import os
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_routes
from app.api.auth import get_superadmin
from app.db.models import Client, Invoice

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _client(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(superadmin_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(id=999999, name="Admin", is_superadmin=True)
    return TestClient(app)


def test_delete_blocked_when_issued_invoices_exist(db, monkeypatch):
    target = Client(name="T", email="del-guard@test.example", api_key="key-del-guard")
    db.add(target)
    db.flush()
    db.add(
        Invoice(
            client_id=target.id,
            amount_cents=179900,
            currency="inr",
            status="paid",
            invoice_type="tax_invoice",
            invoice_number="DB/25-26/000777",
        )
    )
    db.flush()
    c = _client(db, monkeypatch)
    res = c.delete(f"/superadmin/clients/{target.id}")
    assert res.status_code == 409
    assert "retained" in res.json()["detail"]
    assert db.get(Client, target.id) is not None  # still there


def test_delete_allowed_with_only_legacy_rows(db, monkeypatch):
    target = Client(name="T2", email="del-ok@test.example", api_key="key-del-ok")
    db.add(target)
    db.flush()
    db.add(Invoice(client_id=target.id, amount_cents=100, currency="inr", status="paid"))  # legacy, unnumbered
    db.flush()
    c = _client(db, monkeypatch)
    res = c.delete(f"/superadmin/clients/{target.id}")
    assert res.status_code == 200, res.text
    assert db.get(Client, target.id) is None
