"""Finding L: a finalized (numbered) invoice is a legal document — its frozen tax
and identity columns must be immutable; only delivery/lifecycle fields may change.
"""

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


def _finalized(db) -> Invoice:
    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}, actor_id=None)
    c = Client(name="Acme", email="imm@test.example", api_key="k-imm", billing_state_code="27", billing_country="IN")
    db.add(c)
    db.flush()
    inv = Invoice(client_id=c.id, amount_cents=179900, currency="inr", status="paid")
    db.add(inv)
    db.flush()
    assert invoice_service.finalize_invoice(db, inv) is True
    db.flush()
    return inv


def test_frozen_column_mutation_rejected(db, enabled):
    inv = _finalized(db)
    inv.amount_cents = 999999  # tamper with a frozen tax column
    with pytest.raises(ValueError, match="frozen"):
        db.flush()
    db.rollback()


def test_snapshot_mutation_rejected(db, enabled):
    inv = _finalized(db)
    inv.seller_snapshot = {"legal_name": "Someone Else"}
    with pytest.raises(ValueError, match="frozen"):
        db.flush()
    db.rollback()


def test_delivery_columns_allowed(db, enabled):
    inv = _finalized(db)
    inv.pdf_url = "https://cdn/x.pdf"
    inv.emailed_at = inv.issued_at
    inv.status = "refunded"
    db.flush()  # must NOT raise
    assert inv.pdf_url.endswith("x.pdf")


def test_unfinalized_invoice_is_mutable(db, enabled):
    c = Client(name="Acme", email="imm2@test.example", api_key="k-imm2")
    db.add(c)
    db.flush()
    inv = Invoice(client_id=c.id, amount_cents=1000, currency="inr", status="pending")  # no invoice_number
    db.add(inv)
    db.flush()
    inv.amount_cents = 2000  # legacy row, not numbered → freely mutable
    db.flush()
    assert inv.amount_cents == 2000
