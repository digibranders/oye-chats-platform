"""Stripe and Razorpay billing webhook handlers.

These endpoints receive events from payment providers and update
subscription/invoice state in the database. Both endpoints verify
the webhook signature before processing.

Stripe CLI testing:
  stripe listen --forward-to localhost:8000/webhooks/stripe
"""

import logging

from fastapi import APIRouter, HTTPException, Request

from app.config import RAZORPAY_WEBHOOK_SECRET, STRIPE_ENABLED, STRIPE_WEBHOOK_SECRET
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks", tags=["billing-webhooks"])


@router.post("/stripe")
async def stripe_webhook(request: Request):
    """Handle Stripe webhook events with signature verification."""
    if not STRIPE_ENABLED:
        raise HTTPException(status_code=503, detail="Stripe is not configured.")

    import stripe

    from app.config import STRIPE_SECRET_KEY

    stripe.api_key = STRIPE_SECRET_KEY

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature")

    if not sig_header:
        raise HTTPException(status_code=400, detail="Missing Stripe signature header.")

    # Verify webhook signature — NEVER process unverified events.
    if not STRIPE_WEBHOOK_SECRET:
        logger.error("STRIPE_WEBHOOK_SECRET is not configured — rejecting unverified webhook.")
        raise HTTPException(
            status_code=503,
            detail="Webhook signature verification is not configured.",
        )

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except stripe.error.SignatureVerificationError as e:
        logger.warning(f"Stripe webhook signature verification failed: {e}")
        raise HTTPException(status_code=400, detail="Invalid webhook signature.") from e
    except Exception as e:
        logger.error(f"Stripe webhook parsing error: {e}")
        raise HTTPException(status_code=400, detail="Invalid webhook payload.") from e

    event_type = event.get("type", "unknown")
    logger.info(f"Stripe webhook received: {event_type} | id={event.get('id', 'N/A')}")

    # Process the event
    from app.services.billing_service import handle_stripe_webhook_event

    try:
        with get_session() as session:
            result = handle_stripe_webhook_event(session, event)
            session.commit()
            logger.info(f"Stripe webhook processed: {event_type} → {result}")
    except Exception as e:
        logger.error(f"Stripe webhook processing error for {event_type}: {e}", exc_info=True)
        # Return 200 to Stripe even on processing errors to prevent retry storms.
        # The error is logged and can be investigated via Sentry.
        return {"status": "error", "message": str(e)}

    return {"status": "ok", "result": result}


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
