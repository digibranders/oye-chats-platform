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

    # Verify webhook signature
    try:
        if STRIPE_WEBHOOK_SECRET:
            event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
        else:
            # No webhook secret configured — parse without verification (dev only)
            import json

            event = json.loads(payload)
            logger.warning("Stripe webhook signature verification SKIPPED (no STRIPE_WEBHOOK_SECRET)")
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
    """Handle Razorpay webhook events with signature verification.

    Razorpay integration will be fully implemented in a later phase.
    This endpoint validates the signature and logs the event for now.
    """
    payload = await request.body()

    # Verify webhook signature if secret is configured
    if RAZORPAY_WEBHOOK_SECRET:
        import hashlib
        import hmac

        sig_header = request.headers.get("x-razorpay-signature", "")
        expected = hmac.new(
            RAZORPAY_WEBHOOK_SECRET.encode(),
            payload,
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(expected, sig_header):
            logger.warning("Razorpay webhook signature verification failed")
            raise HTTPException(status_code=400, detail="Invalid webhook signature.")

    import json

    try:
        event = json.loads(payload)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.") from e

    event_type = event.get("event", "unknown")
    logger.info(f"Razorpay webhook received: {event_type}")

    # TODO: Implement Razorpay event processing in Phase 2b
    # Key events to handle:
    # - subscription.activated
    # - subscription.charged
    # - subscription.cancelled
    # - payment.captured
    # - payment.failed

    return {
        "status": "ok",
        "event": event_type,
        "message": "Razorpay webhook received (processing not yet implemented)",
    }
