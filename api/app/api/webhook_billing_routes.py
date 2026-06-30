"""Razorpay billing webhook handler.

Receives and processes events from Razorpay, verifying signatures and
delegating dispatch to razorpay_service.handle_webhook_event.
"""

import logging

from fastapi import APIRouter, HTTPException, Request

from app.config import RAZORPAY_WEBHOOK_SECRET, WEBHOOK_RETRY_ON_ERROR
from app.db.models import FailedWebhook
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks", tags=["billing-webhooks"])


def _dead_letter(
    *,
    provider: str,
    raw_payload: bytes,
    signature: str | None,
    event_id: str | None,
    event_type: str | None,
    error: BaseException,
) -> None:
    """Persist a failed webhook in its own transaction so it survives the
    handler's rollback. Best-effort: a dead-letter write failure must never
    mask the original error — we log critically and let the caller still 5xx
    so the provider keeps retrying.
    """
    try:
        with get_session() as session:
            session.add(
                FailedWebhook(
                    provider=provider,
                    event_id=event_id,
                    event_type=event_type,
                    raw_payload=raw_payload,
                    signature=signature,
                    error=repr(error),
                )
            )
            session.commit()
    except Exception:
        logger.critical(
            "Failed to dead-letter %s webhook event_id=%s — event may be lost if retries are exhausted",
            provider,
            event_id,
            exc_info=True,
        )


@router.post("/razorpay")
async def razorpay_webhook(request: Request):
    """Handle Razorpay webhook events.

    Verifies the ``X-Razorpay-Signature`` HMAC against the raw request body
    using ``RAZORPAY_WEBHOOK_SECRET``, then delegates dispatch to
    :func:`razorpay_service.handle_webhook_event`. Idempotency is keyed on
    the ``X-Razorpay-Event-Id`` header (present on all modern deliveries).

    On a processing failure the raw signed event is dead-lettered (so it can
    be replayed) and, when ``WEBHOOK_RETRY_ON_ERROR`` is on (default), the
    route returns 5xx so Razorpay retries — safe because event-id idempotency
    makes the eventual successful retry a no-op. The flag can be turned off to
    fall back to the legacy 200-on-error behaviour, but the event is still
    dead-lettered either way.
    """
    if not RAZORPAY_WEBHOOK_SECRET:
        logger.error("RAZORPAY_WEBHOOK_SECRET is not configured — rejecting unverified webhook.")
        raise HTTPException(
            status_code=503,
            detail="Webhook signature verification is not configured.",
        )

    raw_payload = await request.body()
    signature = request.headers.get("x-razorpay-signature", "")
    event_id = request.headers.get("x-razorpay-event-id")

    from app.services import razorpay_service

    try:
        razorpay_service.verify_webhook_signature(payload=raw_payload, signature=signature)
    except razorpay_service.SignatureMismatch as exc:
        logger.warning("Razorpay webhook signature verification failed: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid webhook signature.") from exc

    import json

    try:
        event = json.loads(raw_payload)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.") from exc

    event_type = event.get("event", "unknown")
    logger.info("Razorpay webhook received: %s | id=%s", event_type, event_id or "N/A")

    try:
        with get_session() as session:
            result = razorpay_service.handle_webhook_event(session, event, event_id)
            session.commit()
            logger.info("Razorpay webhook processed: %s → %s", event_type, result)
    except Exception as exc:
        logger.error("Razorpay webhook processing error for %s: %s", event_type, exc, exc_info=True)
        # The handler's transaction (including the processed_webhooks dedup row)
        # has rolled back, so the event is NOT marked processed and a retry can
        # reprocess it. Persist the raw event as a dead-letter backstop, then
        # ask Razorpay to retry by returning 5xx (idempotency makes that safe).
        _dead_letter(
            provider="razorpay",
            raw_payload=raw_payload,
            signature=signature,
            event_id=event_id,
            event_type=event_type,
            error=exc,
        )
        if WEBHOOK_RETRY_ON_ERROR:
            raise HTTPException(
                status_code=500,
                detail="Webhook processing failed; will retry.",
            ) from exc
        # Legacy escape hatch: ACK 200 so Razorpay stops retrying. The event is
        # still dead-lettered above for manual replay.
        return {"status": "error", "event": event_type, "message": str(exc)}

    return {"status": "ok", "event": event_type, "result": result}
