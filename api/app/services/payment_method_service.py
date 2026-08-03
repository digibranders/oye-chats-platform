"""Saved payment instruments — a mirror of Razorpay's per-customer token list.

Razorpay is authoritative. This module never invents an instrument locally; it
reflects ``GET /v1/customers/{id}/tokens`` into ``payment_methods`` so the UI
renders without a gateway round-trip, and prunes anything the gateway no longer
returns (a token revoked in the issuer's portal must disappear here too).

RBI card-on-file rules cap what may be persisted at last4 + network + issuer.
``_row_from_token`` is the single place that decides this — keep it that way,
and if you find yourself adding a column for expiry or cardholder name, that is
the bug, not the missing column.

Scope note: these are instruments for ONE-OFF payments (credit top-ups). The
instrument funding a subscription is its MANDATE, which Razorpay cannot swap in
place — replacing that runs the re-mandate flow in ``transition_service``, not
anything here.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Client, PaymentMethod

logger = logging.getLogger(__name__)

# How long a mirrored list is trusted before we re-ask Razorpay. A naive
# read-through would fire one gateway call per Billing page load, burning our
# rate limit and turning a page refresh into a DoS against our own account.
SYNC_TTL = timedelta(minutes=10)


class PaymentMethodError(RuntimeError):
    """The gateway refused a token operation."""


def _client():
    """Indirection so tests can substitute a fake without patching razorpay."""
    from app.services.razorpay_service import _get_razorpay

    return _get_razorpay()


def _row_values(client_id: int, customer_id: str, token: dict) -> dict:
    """Project a Razorpay token onto the RBI-permitted subset.

    Deliberately drops ``card.name`` and ``card.expiry_*``: retaining either
    after 1 Oct 2022 breaches the card-on-file guidelines. If the UI ever needs
    an expiry it must fetch it live and discard it.
    """
    method = token.get("method") or "card"
    card = token.get("card") or {}
    vpa = token.get("vpa") or {}
    handle = None
    if vpa.get("username") and vpa.get("handle"):
        handle = f"{vpa['username']}@{vpa['handle']}"
    return {
        "client_id": client_id,
        "provider": "razorpay",
        "type": method,
        "last4": card.get("last4"),
        "network": card.get("network"),
        "issuer": card.get("issuer"),
        "upi_handle": handle,
        "razorpay_token_id": token.get("id"),
        "razorpay_customer_id": customer_id,
        "synced_at": datetime.now(UTC),
    }


def cached_rows(session: Session, client_id: int) -> list[PaymentMethod]:
    """The mirror as it stands, without touching the gateway."""
    return list(session.execute(select(PaymentMethod).where(PaymentMethod.client_id == client_id)).scalars())


def is_stale(rows: list[PaymentMethod], ttl: timedelta = SYNC_TTL) -> bool:
    """Stale if any row has never synced, or the oldest sync is past the TTL.

    An empty list is stale on purpose: "no saved cards" and "we have not looked
    yet" are indistinguishable locally, and only one of them is safe to show.
    """
    if not rows:
        return True
    stamps = [r.synced_at for r in rows]
    if any(s is None for s in stamps):
        return True
    oldest = min(s if s.tzinfo else s.replace(tzinfo=UTC) for s in stamps)
    return (datetime.now(UTC) - oldest) > ttl


def sync_payment_methods(session: Session, client: Client) -> list[PaymentMethod]:
    """Refresh this client's instrument mirror from Razorpay.

    A client with no ``razorpay_customer_id`` has never paid, so it has no
    tokens by definition — return empty rather than calling the gateway.
    """
    customer_id = client.razorpay_customer_id
    if not customer_id:
        return []

    try:
        page = _client().token.all(customer_id) or {}
    except Exception as exc:  # noqa: BLE001 — normalised into our own error type
        logger.warning("token list failed for client %s: %s", client.id, exc)
        raise PaymentMethodError(str(exc)) from exc

    tokens = [t for t in (page.get("items") or []) if t.get("id")]
    seen = {t["id"] for t in tokens}

    existing = {row.razorpay_token_id: row for row in cached_rows(session, client.id)}

    rows: list[PaymentMethod] = []
    for token in tokens:
        values = _row_values(client.id, customer_id, token)
        row = existing.get(token["id"])
        if row is None:
            row = PaymentMethod(**values)
            session.add(row)
        else:
            for key, value in values.items():
                setattr(row, key, value)
        rows.append(row)

    # Prune: a token revoked at the issuer or in Razorpay's dashboard must not
    # linger, or we would offer the customer an instrument that cannot be
    # charged. The token.* webhooks prune on arrival; this catches whatever
    # they missed.
    for token_id, row in existing.items():
        if token_id not in seen:
            session.delete(row)

    session.flush()
    return rows


def delete_payment_method(session: Session, client: Client, token_id: str) -> None:
    """Revoke a saved instrument at the gateway, then drop the mirror row.

    Gateway first: if Razorpay refuses, the local row must survive so the list
    keeps reflecting what can actually be charged. Deleting locally first would
    hide an instrument that is still live and still chargeable.
    """
    customer_id = client.razorpay_customer_id
    if not customer_id:
        raise PaymentMethodError("No saved payment methods for this account")

    try:
        _client().token.delete(customer_id, token_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("token delete failed for client %s token %s: %s", client.id, token_id, exc)
        raise PaymentMethodError(str(exc)) from exc

    row = session.execute(
        select(PaymentMethod).where(
            PaymentMethod.client_id == client.id,
            PaymentMethod.razorpay_token_id == token_id,
        )
    ).scalar_one_or_none()
    if row is not None:
        session.delete(row)
        session.flush()
