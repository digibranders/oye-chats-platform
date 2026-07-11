"""Finding G: finalize_invoice must derive the document date AND the FY serial
bucket from the payment instant (paid_at), not the wall-clock at finalize. A
charge captured just before a month/FY boundary but finalized after it must stay
in the old GSTR period with an in-sequence serial.
"""

import os
from datetime import UTC, datetime

import pytest

from app import config
from app.db.models import Client, Invoice
from app.services import invoice_service
from app.services.razorpay_service import _capture_paid_at
from app.services.seller_profile_service import save_seller_profile

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)


def _seller(db, **overrides):
    payload = {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}
    payload.update(overrides)
    save_seller_profile(db, payload, actor_id=None)


def _client(db, email, **billing):
    c = Client(name="Acme", email=email, api_key=f"key-{email}", **billing)
    db.add(c)
    db.flush()
    return c


# ── _capture_paid_at helper ──────────────────────────────────────────────────


def test_capture_paid_at_parses_epoch():
    # 2026-03-31 18:30:00 UTC == 2026-04-01 00:00 IST — an FY-boundary capture.
    dt = _capture_paid_at({"created_at": 1774981800})
    assert dt.tzinfo is not None
    assert dt.year == 2026 and dt.month == 3 and dt.day == 31


def test_capture_paid_at_falls_back_when_missing():
    dt = _capture_paid_at({})
    assert isinstance(dt, datetime) and dt.tzinfo is not None


def test_capture_paid_at_falls_back_on_garbage():
    dt = _capture_paid_at({"created_at": "not-an-int"})
    assert isinstance(dt, datetime) and dt.tzinfo is not None


# ── finalize dates from paid_at ──────────────────────────────────────────────


def test_finalize_dates_from_paid_at_not_now(db, enabled):
    _seller(db)  # seller GSTIN state 27
    c = _client(db, "g-dating@test.example", billing_state_code="27", billing_country="IN")
    # Paid on 20-Mar-2026 (FY 25-26); finalized "now" is whenever the test runs.
    paid = datetime(2026, 3, 20, 10, 0, tzinfo=UTC)
    inv = Invoice(client_id=c.id, amount_cents=179900, currency="inr", status="paid", paid_at=paid)
    db.add(inv)
    db.flush()

    assert invoice_service.finalize_invoice(db, inv) is True
    # issued_at must equal the payment instant, not the finalize wall-clock.
    assert inv.issued_at == paid
    # FY label for a 20-Mar-2026 IST supply is 25-26 → serial in that bucket.
    assert "25-26" in inv.invoice_number


def test_finalize_fy_boundary_ist(db, enabled):
    """End-to-end proof of the fix: a capture at 23:59 IST on 31-Mar (still FY
    25-26) vs 01:30 IST on 1-Apr (FY 26-27) must land in the right FY serial —
    exercising _capture_paid_at (UTC) x financial_year_label (IST) together, which
    is the exact interaction finding G is about. IST = UTC+5:30."""
    _seller(db)
    # 31-Mar-2026 23:59 IST == 31-Mar-2026 18:29 UTC → FY 25-26.
    late_fy2526 = datetime(2026, 3, 31, 18, 29, tzinfo=UTC)
    # 01-Apr-2026 01:30 IST == 31-Mar-2026 20:00 UTC → FY 26-27.
    early_fy2627 = datetime(2026, 3, 31, 20, 0, tzinfo=UTC)

    c1 = _client(db, "g-boundary-a@test.example", billing_state_code="27", billing_country="IN")
    inv1 = Invoice(client_id=c1.id, amount_cents=179900, currency="inr", status="paid", paid_at=late_fy2526)
    db.add(inv1)
    db.flush()
    assert invoice_service.finalize_invoice(db, inv1) is True
    assert "25-26" in inv1.invoice_number

    c2 = _client(db, "g-boundary-b@test.example", billing_state_code="27", billing_country="IN")
    inv2 = Invoice(client_id=c2.id, amount_cents=179900, currency="inr", status="paid", paid_at=early_fy2627)
    db.add(inv2)
    db.flush()
    assert invoice_service.finalize_invoice(db, inv2) is True
    assert "26-27" in inv2.invoice_number


def test_finalize_falls_back_to_now_without_paid_at(db, enabled):
    _seller(db)
    c = _client(db, "g-fallback@test.example", billing_state_code="27", billing_country="IN")
    inv = Invoice(client_id=c.id, amount_cents=179900, currency="inr", status="paid")  # no paid_at
    db.add(inv)
    db.flush()
    assert invoice_service.finalize_invoice(db, inv) is True
    assert inv.issued_at is not None  # dated from now(), still numbered
    assert inv.invoice_number is not None
