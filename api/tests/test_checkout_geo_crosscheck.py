"""Server-side geo cross-check at checkout (audit F35).

create_checkout routed currency/GST purely off the client-supplied
billing_country with no server-side signal. We now compute the IP-derived
country and flag a domestic (IN) claim that contradicts a specific foreign
detection — a GST/FEMA audit signal. We deliberately do NOT hard-block: the
platform intentionally lets a confirmed country override IP geo (an Indian
resident mis-detected abroad must still reach INR checkout), so enforcement is a
compliance-policy decision; flagging adds the missing server-side check safely.
"""

from app.api.subscription_routes import _is_suspicious_geo_claim


def test_domestic_claim_with_foreign_detection_is_flagged():
    assert _is_suspicious_geo_claim("IN", "US") is True
    assert _is_suspicious_geo_claim("IN", "GB") is True


def test_matching_or_unknown_detection_is_not_flagged():
    assert _is_suspicious_geo_claim("IN", "IN") is False  # matches
    assert _is_suspicious_geo_claim("IN", None) is False  # geo lookup failed — not suspicious
    # A non-IN confirmed country never reaches the INR rail (it 409s earlier),
    # so it is out of scope for this domestic-claim flag.
    assert _is_suspicious_geo_claim("US", "IN") is False
