"""Razorpay Customer identity for a client.

The Customer is the anchor every saved payment instrument hangs off
(``GET /v1/customers/{id}/tokens``). Until this existed,
``razorpay_customer_id`` was only ever scraped passively off subscription
webhooks and was routinely NULL, which is why ``payment_methods`` has been a
dead table: saved cards were structurally impossible.

Created lazily at the first paid intent (checkout / top-up) rather than at
signup, so free accounts never touch the gateway.
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.db.models import Client

logger = logging.getLogger(__name__)


class RazorpayCustomerError(RuntimeError):
    """The gateway refused to create or update the customer."""


def _client():
    """Indirection so tests can substitute a fake without patching razorpay.

    ``_get_razorpay`` is the codebase's single SDK factory; it raises
    ``RuntimeError`` when ``RAZORPAY_ENABLED`` is false, which is the behaviour
    we want, a customer cannot be created without credentials.
    """
    from app.services.razorpay_service import _get_razorpay

    return _get_razorpay()


def _payload(client: Client) -> dict[str, str]:
    """The gateway's view of this buyer.

    Mirrors what the invoice buyer snapshot records, so the Razorpay dashboard
    and the tax document never disagree about who was billed.
    """
    payload = {
        # Razorpay's `name` is the payer-facing label; prefer the registered
        # legal name (what the tax invoice carries) and fall back to the
        # account name so this never sends an empty string.
        "name": (client.legal_name or client.name or "Customer").strip(),
        # billing_email first: invoices already go there, and a finance inbox
        # is more useful on the gateway record than a login address.
        "email": (client.billing_email or client.email or "").strip(),
        # Razorpay 400s on a duplicate email unless told otherwise; "0" makes
        # it return the EXISTING customer instead, which is what we want for a
        # re-created local row pointing at the same real buyer.
        "fail_existing": "0",
    }
    # Omitted rather than sent empty. Razorpay stores what it is given, and a
    # blank GSTIN on the gateway record is worse than no GSTIN.
    if client.gstin:
        payload["gstin"] = client.gstin
    return payload


def _customer_exists(customer_id: str) -> bool:
    """Is ``customer_id`` still live on the currently-configured gateway key?

    A stored id can go stale without our data ever changing: switching the
    account between Razorpay's live and test key sets (or the customer being
    deleted on the gateway side) leaves a syntactically valid id that the
    *current* key simply cannot see. Razorpay answers that with a 400
    (``BadRequestError``), the one case here that means "reissue". Anything
    else (a network blip, a 5xx) is not evidence the id is dead, and treating
    it as such would mint a needless duplicate customer on a mere hiccup, so
    those fail open (assume it still exists).
    """
    from razorpay.errors import BadRequestError

    try:
        _client().customer.fetch(customer_id)
        return True
    except BadRequestError:
        return False
    except Exception as exc:  # noqa: BLE001  Transient gateway/network issue
        logger.warning("razorpay customer fetch failed transiently for %s: %s", customer_id, exc)
        return True


def ensure_customer(session: Session, client: Client) -> str:
    """Return this client's Razorpay customer id, creating it if needed.

    Idempotent: a client that already has a *live* id short-circuits with
    only a cheap existence check, not a full create. On gateway failure the
    column is left NULL and the caller decides whether that is fatal, a
    customer is required for saving an instrument, but not for a plain
    one-off charge.

    ``client`` MUST be attached to ``session``. ``get_current_client`` returns a
    DETACHED row loaded in another session, and assigning to a detached
    instance silently does nothing, the write is simply lost, with no error
    and a green test suite. Every caller therefore re-reads the row with
    ``session.get(Client, client.id)`` first, which is the established pattern
    in ``subscription_routes``. The guard below turns that silent no-op into an
    immediate failure.
    """
    if client not in session:
        raise RazorpayCustomerError(
            "ensure_customer requires a session-attached Client; re-read it with session.get(Client, client.id) first"
        )
    if client.razorpay_customer_id:
        if _customer_exists(client.razorpay_customer_id):
            return client.razorpay_customer_id
        # Stale across a live/test key switch (or deleted on the gateway).
        # Handing this id to Razorpay Checkout is what surfaces as "The id
        # provided does not exist" mid-checkout. Clear and fall through to
        # mint a fresh one under the key that is actually live right now.
        logger.warning(
            "razorpay customer %s for client %s not found on the current gateway key. Reissuing",
            client.razorpay_customer_id,
            client.id,
        )
        client.razorpay_customer_id = None
        session.flush()

    try:
        created = _client().customer.create(_payload(client))
    except Exception as exc:  # noqa: BLE001  Normalised into our own error type
        logger.warning("razorpay customer create failed for client %s: %s", client.id, exc)
        raise RazorpayCustomerError(str(exc)) from exc

    customer_id = (created or {}).get("id")
    if not customer_id:
        raise RazorpayCustomerError("Razorpay returned no customer id")

    client.razorpay_customer_id = customer_id
    session.flush()
    logger.info("razorpay customer %s created for client %s", customer_id, client.id)
    return customer_id


def sync_customer(session: Session, client: Client) -> None:
    """Push updated billing identity to Razorpay. Best-effort.

    Called after a billing-details save so the gateway's record matches the
    invoice buyer snapshot. A failure here must never block the customer's
    edit, the local row is authoritative for invoicing, and the next
    ``ensure_customer`` or save will reconcile.
    """
    if not client.razorpay_customer_id:
        return
    try:
        _client().customer.edit(client.razorpay_customer_id, _payload(client))
    except Exception as exc:  # noqa: BLE001
        logger.warning("razorpay customer sync failed for client %s: %s", client.id, exc)
