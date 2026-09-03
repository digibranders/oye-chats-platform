"""Verify path creates the first-charge invoice when subscription.charged can't
reach the box (local dev / webhook lag), the INV-8 gap fix."""

import os
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from app import config
from app.db.models import Client, Invoice, Plan, Subscription
from app.services import razorpay_service as rzp
from app.services.seller_profile_service import save_seller_profile

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _standard_sub(db, email, rzp_sub):
    c = Client(name="Acme", email=email, api_key=f"key-{email}", billing_state_code="27", billing_country="IN")
    db.add(c)
    db.flush()
    plan = Plan(name="Standard", slug=f"std-{email}", monthly_price_cents=459900, credits_per_month=10000)
    db.add(plan)
    db.flush()
    sub = Subscription(
        client_id=c.id,
        plan_id=plan.id,
        status="active",
        billing_cycle="monthly",
        payment_provider="razorpay",
        razorpay_subscription_id=rzp_sub,
        current_period_start=datetime(2026, 7, 3, tzinfo=UTC),
        current_period_end=datetime(2026, 8, 3, tzinfo=UTC),
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


def test_verify_records_first_charge_invoice(db, monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)
    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}, actor_id=None)
    sub = _standard_sub(db, "verify-inv@test.example", "sub_verify_1")

    # Stub the Razorpay payment fetch (no live gateway in tests).
    monkeypatch.setattr(
        rzp,
        "_get_razorpay",
        lambda: SimpleNamespace(
            payment=SimpleNamespace(
                fetch=lambda pid: {"status": "captured", "amount": 459900, "currency": "INR", "invoice_id": "inv_rzp_1"}
            )
        ),
    )
    inv = rzp.record_verified_subscription_charge(db, sub, "pay_verify_1")
    assert inv is not None
    assert inv.invoice_type == "tax_invoice"  # seller configured → finalized
    assert inv.invoice_number.startswith("DB/")
    assert inv.amount_cents == 459900
    assert inv.subscription_id == sub.id
    assert inv.taxable_value_minor == 389746  # ₹4,599 inclusive carve-out


def test_idempotent_with_later_charged_webhook(db, monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)
    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}, actor_id=None)
    sub = _standard_sub(db, "verify-idem@test.example", "sub_verify_2")
    monkeypatch.setattr(
        rzp,
        "_get_razorpay",
        lambda: SimpleNamespace(
            payment=SimpleNamespace(fetch=lambda pid: {"status": "captured", "amount": 459900, "currency": "INR"})
        ),
    )
    first = rzp.record_verified_subscription_charge(db, sub, "pay_shared")
    # The webhook path later finds the SAME payment id → no duplicate invoice.
    again = rzp._ensure_subscription_charge_invoice(
        db,
        sub,
        payment_id="pay_shared",
        amount_minor=459900,
        currency="INR",
        period_start=None,
        period_end=None,
    )
    assert again.id == first.id
    rows = db.execute(Invoice.__table__.select().where(Invoice.razorpay_payment_id == "pay_shared")).fetchall()
    assert len(rows) == 1


def test_uncaptured_payment_defers_to_webhook(db, monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)
    sub = _standard_sub(db, "verify-uncap@test.example", "sub_verify_3")
    monkeypatch.setattr(
        rzp,
        "_get_razorpay",
        lambda: SimpleNamespace(
            payment=SimpleNamespace(fetch=lambda pid: {"status": "authorized", "amount": 459900, "currency": "INR"})
        ),
    )
    assert rzp.record_verified_subscription_charge(db, sub, "pay_uncap") is None


def test_verify_does_not_invoice_a_mandate_that_has_not_billed(db, monkeypatch):
    """A deferred-start mandate (mid-trial conversion, resume, launch promo)
    returns the authorisation transaction's payment id from Checkout. That is
    the token amount Razorpay auto-refunds, not a plan charge. Recording it as
    a paid ``plan_charge`` mints a numbered tax invoice for money that never
    moved and lets ``_revoke_unpaid_activation_grant`` see a "paid" activation.
    ``current_period_start`` is written at the first REAL debit and nowhere
    else, so its absence is the signal."""
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)
    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}, actor_id=None)
    sub = _standard_sub(db, "verify-unbilled@test.example", "sub_verify_unbilled")
    sub.current_period_start = None
    sub.current_period_end = None
    db.flush()

    fetched: list[str] = []

    def _fetch(pid):
        fetched.append(pid)
        return {"status": "captured", "amount": 100, "currency": "INR", "invoice_id": None}

    monkeypatch.setattr(rzp, "_get_razorpay", lambda: SimpleNamespace(payment=SimpleNamespace(fetch=_fetch)))

    assert rzp.record_verified_subscription_charge(db, sub, "pay_auth_token") is None
    assert fetched == ["pay_auth_token"]
    assert db.query(Invoice).filter(Invoice.subscription_id == sub.id).count() == 0
