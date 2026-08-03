"""token.* webhooks prune a revoked instrument immediately.

Razorpay is the source of truth for saved cards, and ``payment_methods`` is a
display mirror. Without these handlers a card revoked at the issuer -- or in
Razorpay's dashboard -- keeps showing in the customer's saved list until the
next read-sync, so the UI offers an instrument that cannot be charged.
"""

import os

import pytest

from app.db.models import Client, PaymentMethod

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _mirrored(db, email="tok@test.dev", token_id="token_A"):
    client = Client(name="T", email=email, api_key=f"k-{email}", razorpay_customer_id="cust_1")
    db.add(client)
    db.flush()
    pm = PaymentMethod(
        client_id=client.id,
        provider="razorpay",
        type="card",
        last4="4242",
        network="Visa",
        razorpay_token_id=token_id,
        razorpay_customer_id="cust_1",
    )
    db.add(pm)
    db.flush()
    return client, pm


def _payload(token_id="token_A", customer_id="cust_1"):
    return {"token": {"entity": {"id": token_id, "customer_id": customer_id}}}


def test_token_cancelled_prunes_the_mirror_row(db):
    from app.services.razorpay_service import _handle_token_revoked

    client, _ = _mirrored(db)

    _handle_token_revoked(db, _payload())
    db.flush()

    assert db.query(PaymentMethod).filter_by(client_id=client.id).count() == 0


def test_pruning_is_idempotent(db):
    """Razorpay retries webhooks; a second delivery must be a clean no-op."""
    from app.services.razorpay_service import _handle_token_revoked

    _mirrored(db, "tok2@test.dev", "token_B")

    _handle_token_revoked(db, _payload("token_B"))
    result = _handle_token_revoked(db, _payload("token_B"))
    db.flush()

    assert "token_B" in result


def test_an_unknown_token_is_not_an_error(db):
    """A token we never mirrored (or already pruned) must not raise -- raising
    would dead-letter the event and retry forever."""
    from app.services.razorpay_service import _handle_token_revoked

    assert _handle_token_revoked(db, _payload("token_never_seen")) is not None


def test_a_malformed_payload_is_reported_not_raised(db):
    from app.services.razorpay_service import _handle_token_revoked

    assert "missing" in _handle_token_revoked(db, {}).lower()


def test_only_the_named_token_is_pruned(db):
    """A revoke must never take out the customer's other saved cards."""
    from app.services.razorpay_service import _handle_token_revoked

    client, _ = _mirrored(db, "tok3@test.dev", "token_C")
    keep = PaymentMethod(
        client_id=client.id,
        provider="razorpay",
        type="card",
        last4="1111",
        razorpay_token_id="token_KEEP",
    )
    db.add(keep)
    db.flush()

    _handle_token_revoked(db, _payload("token_C"))
    db.flush()

    remaining = db.query(PaymentMethod).filter_by(client_id=client.id).all()
    assert [r.razorpay_token_id for r in remaining] == ["token_KEEP"]


def test_both_token_events_are_dispatched(db):
    """token.cancelled and token.paused both mean 'not chargeable right now'."""
    from app.services import razorpay_service

    for event in ("token.cancelled", "token.paused"):
        assert event in razorpay_service.TOKEN_REVOKED_EVENTS
