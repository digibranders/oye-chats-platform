"""Unit tests for add_months clamping (M5/N8) and webhook SSRF pinning (N7)."""

from datetime import UTC, datetime

from app.core.dates import add_months
from app.services import webhook_service


def test_add_months_clamps_short_month():
    # Jan 31 + 1 month → Feb 28 (non-leap year).
    assert add_months(datetime(2026, 1, 31, tzinfo=UTC), 1) == datetime(2026, 2, 28, tzinfo=UTC)
    # Leap year → Feb 29.
    assert add_months(datetime(2028, 1, 31, tzinfo=UTC), 1) == datetime(2028, 2, 29, tzinfo=UTC)


def test_add_months_preserves_wall_clock_and_rolls_year():
    src = datetime(2026, 11, 30, 17, 18, tzinfo=UTC)
    out = add_months(src, 2)  # Nov 30 → Jan 30 next year
    assert (out.year, out.month, out.day, out.hour, out.minute) == (2027, 1, 30, 17, 18)


def test_add_months_anchor_chain_from_original_does_not_drift():
    # Rolling from the ORIGINAL Jan-31 anchor recovers full days on long months.
    anchor = datetime(2026, 1, 31, tzinfo=UTC)
    assert add_months(anchor, 2).day == 31  # March has 31 days
    assert add_months(anchor, 4).day == 31  # May has 31 days


def test_is_safe_webhook_url_rejects_internal_addresses():
    assert webhook_service._is_safe_webhook_url("http://127.0.0.1/hook") is False
    assert webhook_service._is_safe_webhook_url("http://10.0.0.5/hook") is False
    assert webhook_service._is_safe_webhook_url("http://169.254.169.254/latest") is False  # cloud metadata
    assert webhook_service._is_safe_webhook_url("https://8.8.8.8/hook") is True


def test_resolve_pinned_public_ip_rejects_loopback():
    # localhost resolves to a loopback address → must fail closed (None).
    assert webhook_service._resolve_pinned_public_ip("localhost") is None
