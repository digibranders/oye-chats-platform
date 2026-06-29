"""Razorpay billing webhook handler.

Receives and processes events from Razorpay, verifying signatures and
delegating dispatch to razorpay_service.handle_webhook_event.
"""

import logging

from fastapi import APIRouter, HTTPException, Request

from app.config import RAZORPAY_WEBHOOK_SECRET
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks", tags=["billing-webhooks"])


@router.post("/razorpay")
async def razorpay_webhook(request: Request):
    """Handle Razorpay webhook events.

    Verifies the ``X-Razorpay-Signature`` HMAC against the raw request body
    using ``RAZORPAY_WEBHOOK_SECRET``, then delegates dispatch to
    :func:`razorpay_service.handle_webhook_event`. Idempotency is keyed on
    the ``X-Razorpay-Event-Id`` header (present on all modern deliveries).

    On exception during processing, returns 200 OK to Razorpay to suppress
    the retry storm — the error is captured to Sentry/logs and can be
    reprocessed manually if needed.
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
        # Return 200 so Razorpay doesn't retry-storm us. Sentry has the trace.
        return {"status": "error", "event": event_type, "message": str(exc)}

    return {"status": "ok", "event": event_type, "result": result}
