"""Seller profile service — defaults, validation, persistence."""

import os

import pytest

from app.db.models import Client
from app.services.seller_profile_service import (
    SellerProfileError,
    get_seller_profile,
    save_seller_profile,
)

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture
def admin_id(db):
    admin = Client(name="Admin", email="seller-profile-admin@test.example", api_key="key-seller-profile-admin")
    db.add(admin)
    db.flush()
    return admin.id


def test_defaults_when_unconfigured(db):
    profile = get_seller_profile(db)
    assert profile.configured is False
    assert profile.gst_enabled is False
    assert profile.trade_name == "OyeChats"
    assert profile.sac_code == "997331"
    assert profile.tax_rate_bps == 1800
    assert profile.price_inclusive is True
    assert profile.invoice_prefix == "DB"


def test_save_and_reload_roundtrip(db, admin_id):
    save_seller_profile(
        db,
        {
            "legal_name": "Digibranders Pvt Ltd",
            "trade_name": "OyeChats",
            "gstin": "27AAPFU0939F1ZV",
            "address_lines": ["1 Example Road", "Mumbai 400001"],
        },
        actor_id=admin_id,
    )
    profile = get_seller_profile(db)
    assert profile.configured is True
    assert profile.gst_enabled is True
    assert profile.legal_name == "Digibranders Pvt Ltd"
    # State code derives from the GSTIN's first two digits.
    assert profile.state_code == "27"


def test_invalid_gstin_rejected(db):
    with pytest.raises(SellerProfileError, match="GSTIN"):
        save_seller_profile(db, {"legal_name": "X Ltd", "gstin": "27AAPFU0939F1ZW"}, actor_id=1)


def test_legal_name_required(db):
    with pytest.raises(SellerProfileError, match="legal_name"):
        save_seller_profile(db, {"legal_name": "  ", "gstin": None}, actor_id=1)


def test_prefix_bounds(db):
    # 4-char prefix would make DB/25-26/000001-style numbers exceed 16 chars (Rule 46).
    with pytest.raises(SellerProfileError, match="prefix"):
        save_seller_profile(db, {"legal_name": "X Ltd", "invoice_prefix": "ABCD"}, actor_id=1)


def test_no_gstin_means_receipt_mode(db, admin_id):
    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd", "gstin": None}, actor_id=admin_id)
    profile = get_seller_profile(db)
    assert profile.configured is True
    assert profile.gst_enabled is False
