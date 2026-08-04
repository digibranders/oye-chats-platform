"""Customer-facing saved payment instruments.

Scope note: these are instruments for ONE-OFF payments (credit top-ups). The
instrument funding a subscription is its MANDATE, which Razorpay cannot swap in
place — replacing that runs the re-mandate flow via ``/subscriptions/resume``,
not an endpoint here. Conflating the two would promise a swap the gateway
cannot perform.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api.auth import get_current_client_strict as get_current_client
from app.core.rate_limit import limiter
from app.db.models import Client, PaymentMethod
from app.db.session import get_session
from app.services.payment_method_service import (
    NoSavedInstruments,
    PaymentMethodError,
    cached_rows,
    delete_payment_method,
    is_stale,
    sync_payment_methods,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payment-methods", tags=["billing"])


def _serialize(row: PaymentMethod) -> dict:
    """RBI-permitted fields only — there is deliberately no expiry to expose."""
    return {
        "id": row.id,
        "token_id": row.razorpay_token_id,
        "type": row.type,
        "last4": row.last4,
        "network": row.network,
        "issuer": row.issuer,
        "upi_handle": row.upi_handle,
        "is_default": row.is_default,
    }


@router.get("")
@limiter.limit("20/minute")
def list_payment_methods(request: Request, client: Client = Depends(get_current_client)):
    """Saved instruments for one-off payments.

    Serves the local mirror and only calls Razorpay when it is stale, or when
    ``?refresh=true``. A naive read-through would fire one gateway call per
    Billing page load — burning our rate limit and turning a page refresh into
    a DoS against our own Razorpay account. The rate limit is a second
    backstop.

    A stale-mirror refresh that fails at the gateway degrades to the cached
    rows: showing a slightly old list beats blanking the page over a transient
    blip. Only an explicit ``?refresh=true`` surfaces the failure, because
    there the customer asked and deserves to know it did not work.
    """
    refresh = request.query_params.get("refresh") == "true"
    with get_session() as session:
        # Re-read in-session: the dependency's `client` is DETACHED, so writes
        # against it (synced_at, new rows) would be silently discarded.
        row = session.get(Client, client.id)
        if row is None:
            raise HTTPException(status_code=404, detail="Account not found.")

        cached = cached_rows(session, row.id)
        if not refresh and not is_stale(cached):
            return [_serialize(r) for r in cached]

        try:
            rows = sync_payment_methods(session, row)
            session.commit()
        except PaymentMethodError as exc:
            if refresh:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            logger.info("payment-methods: serving cached mirror for client %s (%s)", row.id, exc)
            return [_serialize(r) for r in cached]
        return [_serialize(r) for r in rows]


@router.delete("/{token_id}")
@limiter.limit("10/minute")
def remove_payment_method(token_id: str, request: Request, client: Client = Depends(get_current_client)):
    """Revoke a saved instrument.

    ``token_id`` is resolved against THIS client's Razorpay customer inside the
    service, so a token belonging to another account fails at the gateway
    rather than deleting someone else's instrument.
    """
    with get_session() as session:
        row = session.get(Client, client.id)
        if row is None:
            raise HTTPException(status_code=404, detail="Account not found.")
        try:
            delete_payment_method(session, row, token_id)
        except NoSavedInstruments as exc:
            # 404, not 502: nothing to revoke is a local fact, and reporting it
            # as a gateway error would tell the customer our payment provider
            # is broken when it is fine.
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except PaymentMethodError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        session.commit()
        return {"ok": True}
