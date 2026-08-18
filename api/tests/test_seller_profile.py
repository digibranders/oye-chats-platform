"""Seller profile service. Defaults, validation, persistence."""

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


def test_partial_update_preserves_unspecified_fields(db, admin_id):
    save_seller_profile(
        db,
        {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV", "tax_rate_bps": 1200},
        actor_id=admin_id,
    )
    # A partial edit that omits gstin/tax_rate_bps must NOT reset them.
    save_seller_profile(db, {"legal_name": "Digibranders Private Limited"}, actor_id=admin_id)
    profile = get_seller_profile(db)
    assert profile.legal_name == "Digibranders Private Limited"
    assert profile.gstin == "27AAPFU0939F1ZV"
    assert profile.tax_rate_bps == 1200


def test_explicit_null_gstin_clears_it(db, admin_id):
    save_seller_profile(db, {"legal_name": "X Ltd", "gstin": "27AAPFU0939F1ZV"}, actor_id=admin_id)
    save_seller_profile(db, {"gstin": None}, actor_id=admin_id)
    profile = get_seller_profile(db)
    assert profile.gstin is None
    assert profile.gst_enabled is False


def test_save_twice_reflects_latest(db, admin_id):
    save_seller_profile(db, {"legal_name": "First Co", "gstin": "27AAPFU0939F1ZV"}, actor_id=admin_id)
    save_seller_profile(db, {"legal_name": "Second Co", "gstin": "29AAGCB7383J1Z4"}, actor_id=admin_id)
    profile = get_seller_profile(db)
    assert profile.legal_name == "Second Co"
    assert profile.state_code == "29"


def test_state_code_without_gstin_is_validated(db, admin_id):
    save_seller_profile(db, {"legal_name": "X Ltd", "state_code": "29"}, actor_id=admin_id)
    assert get_seller_profile(db).state_code == "29"
    with pytest.raises(SellerProfileError, match="state code"):
        save_seller_profile(db, {"legal_name": "X Ltd", "state_code": "99"}, actor_id=admin_id)


def test_lut_active_requires_number(db, admin_id):
    with pytest.raises(SellerProfileError, match="lut_number"):
        save_seller_profile(db, {"legal_name": "X Ltd", "lut_active": True}, actor_id=admin_id)


def test_bad_tax_rate_raises_domain_error_not_valueerror(db, admin_id):
    with pytest.raises(SellerProfileError, match="tax_rate_bps"):
        save_seller_profile(db, {"legal_name": "X Ltd", "tax_rate_bps": "eighteen"}, actor_id=admin_id)


def test_reader_survives_corrupt_stored_row(db, admin_id):
    from app.db.models import PricingConfig
    from app.services.seller_profile_service import SELLER_PROFILE_KEY

    db.add(
        PricingConfig(key=SELLER_PROFILE_KEY, value={"legal_name": "X", "tax_rate_bps": "garbage"}, updated_by=admin_id)
    )
    db.flush()
    profile = get_seller_profile(db)  # must not raise
    assert profile.tax_rate_bps == 1800  # falls back to default


def test_null_legal_name_rejected_not_stored_as_string_none(db, admin_id):
    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd"}, actor_id=admin_id)
    with pytest.raises(SellerProfileError, match="legal_name"):
        save_seller_profile(db, {"legal_name": None}, actor_id=admin_id)
    assert get_seller_profile(db).legal_name == "Digibranders Pvt Ltd"


def test_null_sac_and_price_inclusive_restore_defaults(db, admin_id):
    save_seller_profile(db, {"legal_name": "X Ltd", "sac_code": "998434"}, actor_id=admin_id)
    profile = save_seller_profile(
        db, {"legal_name": "X Ltd", "sac_code": None, "price_inclusive": None}, actor_id=admin_id
    )
    assert profile.sac_code == "997331"  # default restored, never "None"
    assert profile.price_inclusive is True


def test_overlong_or_nondigit_sac_rejected(db, admin_id):
    with pytest.raises(SellerProfileError, match="sac_code"):
        save_seller_profile(db, {"legal_name": "X Ltd", "sac_code": "997331 - SaaS"}, actor_id=admin_id)
    with pytest.raises(SellerProfileError, match="sac_code"):
        save_seller_profile(db, {"legal_name": "X Ltd", "sac_code": "997331000"}, actor_id=admin_id)


def test_unicode_prefix_rejected(db, admin_id):
    with pytest.raises(SellerProfileError, match="prefix"):
        save_seller_profile(db, {"legal_name": "X Ltd", "invoice_prefix": "١٢٣"}, actor_id=admin_id)


def test_reserved_receipt_prefix_rejected(db, admin_id):
    with pytest.raises(SellerProfileError, match="reserved"):
        save_seller_profile(db, {"legal_name": "X Ltd", "invoice_prefix": "RCT"}, actor_id=admin_id)


def test_exclusive_pricing_rejected(db, admin_id):
    with pytest.raises(SellerProfileError, match="price_inclusive"):
        save_seller_profile(db, {"legal_name": "X Ltd", "price_inclusive": False}, actor_id=admin_id)


def test_bad_country_rejected(db, admin_id):
    with pytest.raises(SellerProfileError, match="country"):
        save_seller_profile(db, {"legal_name": "X Ltd", "country": "India"}, actor_id=admin_id)


def test_read_path_clamps_corrupt_prefix_and_state(db, admin_id):
    from app.db.models import PricingConfig
    from app.services.seller_profile_service import SELLER_PROFILE_KEY

    # Simulate a raw psql edit that bypassed validation.
    db.add(
        PricingConfig(
            key=SELLER_PROFILE_KEY,
            value={"legal_name": "X", "invoice_prefix": "OYEC", "state_code": "7"},
            updated_by=admin_id,
        )
    )
    db.flush()
    profile = get_seller_profile(db)
    assert profile.invoice_prefix == "DB"  # clamped to default, not "OYEC"
    assert profile.state_code == "07"  # zero-padded on read
