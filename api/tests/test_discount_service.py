"""Unit tests for the provider-agnostic discount resolver.

All tests are offline — no database, no Razorpay/Stripe calls.
The resolver's job is purely: given a client and session, return
(discount_bps, audit_meta) based on the client's attached referral code.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from app.services import discount_service


def _make_client(referral_code_id=None):
    return SimpleNamespace(referral_code_id=referral_code_id)


def _make_code(
    *, active=True, customer_discount_bps=1500, affiliate_commission_bps=500, code="PARTNER15", affiliate_id=7
):
    return SimpleNamespace(
        id=9,
        code=code,
        active=active,
        affiliate_id=affiliate_id,
        customer_discount_bps=customer_discount_bps,
        affiliate_commission_bps=affiliate_commission_bps,
    )


def _session_with_code(code):
    session = MagicMock()
    session.get.return_value = code
    return session


def test_no_referral_code_returns_zero():
    client = _make_client(referral_code_id=None)
    bps, meta = discount_service.resolve_customer_discount_bps(MagicMock(), client)
    assert bps == 0
    assert meta is None


def test_active_code_with_discount_returns_bps_and_meta():
    code = _make_code(customer_discount_bps=1500, affiliate_commission_bps=500)
    client = _make_client(referral_code_id=9)
    bps, meta = discount_service.resolve_customer_discount_bps(_session_with_code(code), client)

    assert bps == 1500
    assert meta["referral_code_id"] == "9"
    assert meta["referral_code"] == "PARTNER15"
    assert meta["discount_bps"] == "1500"
    assert meta["affiliate_commission_bps"] == "500"
    assert meta["affiliate_id"] == "7"  # N6 — snapshot affiliate for payout attribution


def test_inactive_code_returns_zero():
    code = _make_code(active=False, customer_discount_bps=1500)
    client = _make_client(referral_code_id=9)
    bps, meta = discount_service.resolve_customer_discount_bps(_session_with_code(code), client)
    assert bps == 0
    assert meta is None


def test_code_with_zero_discount_returns_zero():
    code = _make_code(customer_discount_bps=0)
    client = _make_client(referral_code_id=9)
    bps, meta = discount_service.resolve_customer_discount_bps(_session_with_code(code), client)
    assert bps == 0
    assert meta is None


def test_missing_code_row_returns_zero():
    session = MagicMock()
    session.get.return_value = None  # code deleted from DB
    client = _make_client(referral_code_id=99)
    bps, meta = discount_service.resolve_customer_discount_bps(session, client)
    assert bps == 0
    assert meta is None
