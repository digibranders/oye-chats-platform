"""Dead-letter table for billing webhooks (Phase 0, unblocks C1).

When a verified webhook's processing fails, the raw signed event must be
persisted so it can be replayed later — the exact bytes are kept (not parsed
JSON) so the signature can be re-verified on replay.
"""

from __future__ import annotations


def test_failed_webhook_table_name():
    from app.db.models import FailedWebhook

    assert FailedWebhook.__tablename__ == "failed_webhooks"


def test_failed_webhook_has_required_columns():
    from app.db.models import FailedWebhook

    cols = FailedWebhook.__table__.columns
    for name in (
        "id",
        "provider",
        "event_id",
        "event_type",
        "raw_payload",
        "signature",
        "headers",
        "error",
        "status",
        "created_at",
        "replayed_at",
    ):
        assert name in cols, f"missing column {name!r}"


def test_failed_webhook_nullability_contract():
    from app.db.models import FailedWebhook

    cols = FailedWebhook.__table__.columns
    # provider and the raw bytes are always required (replay needs both).
    assert cols["provider"].nullable is False
    assert cols["raw_payload"].nullable is False
    assert cols["status"].nullable is False
    # event_id may be absent (some deliveries lack x-razorpay-event-id).
    assert cols["event_id"].nullable is True


def test_failed_webhook_raw_payload_is_binary():
    """Raw payload must preserve exact bytes so the HMAC can be re-verified."""
    from sqlalchemy import LargeBinary

    from app.db.models import FailedWebhook

    assert isinstance(FailedWebhook.__table__.columns["raw_payload"].type, LargeBinary)
