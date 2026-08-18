"""mark-paid must not violate the finalized-invoice immutability guard (F8).

``paid_at`` is a frozen column once an invoice is numbered (models.py
``_INVOICE_FROZEN_EXEMPT``), and rightly so: a numbered document's supply date
is what its FY serial and GSTR period were derived from. Writing it on a
numbered row raises, so the endpoint 500s.
"""

import os
from datetime import UTC, datetime

import pytest

from app.db.models import Client, Invoice
from app.services import invoice_service
from app.services.seller_profile_service import save_seller_profile

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture
def enabled(monkeypatch):
    from app import config

    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)


def _numbered_invoice(db, email):
    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}, actor_id=None)
    client = Client(name="MP", email=email, api_key=f"key-{email}")
    db.add(client)
    db.flush()
    inv = Invoice(
        client_id=client.id,
        amount_cents=94900,
        currency="inr",
        status="issued",
        paid_at=datetime.now(UTC),
    )
    db.add(inv)
    db.flush()
    assert invoice_service.finalize_invoice(db, inv) is True
    assert inv.invoice_number is not None
    return inv


def test_mark_paid_on_a_numbered_invoice_does_not_raise(db, enabled):
    from app.api.superadmin_ops_routes import _apply_mark_paid

    inv = _numbered_invoice(db, "mp@test.dev")
    original_paid_at = inv.paid_at

    _apply_mark_paid(inv)
    db.flush()  # would raise ValueError from the immutability guard

    assert inv.status == "paid"
    # The supply date the FY serial was derived from must be untouched.
    assert inv.paid_at == original_paid_at


def test_mark_paid_on_a_legacy_row_stamps_paid_at(db, enabled):
    """Manual reconciliation only ever applies to un-numbered legacy rows, and
    for those the timestamp is exactly what the operator is recording."""
    from app.api.superadmin_ops_routes import _apply_mark_paid

    client = Client(name="Legacy", email="legacy@test.dev", api_key="key-legacy")
    db.add(client)
    db.flush()
    inv = Invoice(client_id=client.id, amount_cents=94900, currency="inr", status="pending")
    db.add(inv)
    db.flush()
    assert inv.invoice_number is None

    _apply_mark_paid(inv)
    db.flush()

    assert inv.status == "paid"
    assert inv.paid_at is not None


def test_shadowed_ops_invoice_list_route_is_gone():
    """superadmin_ops_routes registered GET /superadmin/invoices on the same
    prefix as superadmin_routes_v2, which main.py includes FIRST, so the ops
    handler was unreachable and its ?status= filter silently no-opped."""
    from app.api.superadmin_ops_routes import router

    invoice_list_routes = [
        r
        for r in router.routes
        if getattr(r, "path", None) == "/superadmin/invoices" and "GET" in getattr(r, "methods", set())
    ]
    assert invoice_list_routes == []
