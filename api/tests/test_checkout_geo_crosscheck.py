"""Server-side geo cross-check at checkout (audit F35, extended by Wave 1.1).

create_checkout routed currency/GST purely off the client-supplied
billing_country with no server-side signal. We compute the IP-derived country
and flag contradictions in BOTH directions, a domestic (IN) claim from a
foreign-detected request (FEMA/place-of-supply review) and, since Wave 1.1, a
foreign claim (zero-rated export) from an IN-detected request (the P0-2 GST
leakage direction). We deliberately do NOT hard-block: the platform
intentionally lets a confirmed country override IP geo (an Indian resident
mis-detected abroad must still reach INR checkout), so enforcement is a
compliance-policy decision; flagging adds the missing server-side check safely.

The full behavior matrix (both directions, persistence) lives in
``test_billing_country_freeze.py``; this file keeps the original checkout-angle
assertions on the helper.
"""

from app.api.subscription_routes import _geo_mismatch_detail


def test_domestic_claim_with_foreign_detection_is_flagged():
    assert _geo_mismatch_detail("IN", "US") is not None
    assert _geo_mismatch_detail("IN", "GB") is not None


def test_export_claim_with_domestic_detection_is_flagged():
    # Wave 1.1: the reverse direction is the actual GST-leakage shape, a
    # zero-rated export claim originating from inside India.
    assert _geo_mismatch_detail("US", "IN") is not None
    assert _geo_mismatch_detail("AE", "IN") is not None


def test_matching_or_unknown_detection_is_not_flagged():
    assert _geo_mismatch_detail("IN", "IN") is None  # matches
    assert _geo_mismatch_detail("US", "US") is None  # matches
    assert _geo_mismatch_detail("IN", None) is None  # geo lookup failed, not suspicious
    assert _geo_mismatch_detail("US", None) is None
    # Foreign claim from a different foreign country: travel/VPN, not a tax signal.
    assert _geo_mismatch_detail("US", "GB") is None
