"""Razorpay billing webhook handler.

Receives and processes events from Razorpay, verifying signatures and
delegating dispatch to razorpay_service.handle_webhook_event.
"""

import logging

from fastapi import APIRouter, HTTPException, Request

from app.config import RAZORPAY_WEBHOOK_SECRET, WEBHOOK_RETRY_ON_ERROR
from app.db.models import FailedWebhook
from app.db.session import get_session
from app.services import invoice_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks", tags=["billing-webhooks"])

# ── Signature-failure escalation (P1-6a) ─────────────────────────────────────
# A single bad signature is noise (scanner, replay). A BURST of them is a
# rotated/mistyped RAZORPAY_WEBHOOK_SECRET: every billing event 400s before
# the dead-letter path, so nothing reaches Sentry and revenue events silently
# drop for Razorpay's whole retry window. Track consecutive failures in a
# rolling window and escalate to ERROR (→ Sentry) at the threshold. Process-
# local by design — this is an alert, not an exact counter, and any verified
# event resets it.
_SIG_FAILURE_WINDOW_SECS = 900.0
_SIG_FAILURE_ALERT_THRESHOLD = 3
_sig_failures: dict[str, float] = {"count": 0.0, "window_start": 0.0}


def _note_signature_failure(now: float) -> None:
    if now - _sig_failures["window_start"] > _SIG_FAILURE_WINDOW_SECS:
        _sig_failures["window_start"] = now
        _sig_failures["count"] = 0.0
    _sig_failures["count"] += 1
    if _sig_failures["count"] >= _SIG_FAILURE_ALERT_THRESHOLD:
        logger.error(
            "Razorpay webhook signature verification failed %d times in the last %.0f min — "
            "check RAZORPAY_WEBHOOK_SECRET against the Razorpay dashboard (a rotated or "
            "mistyped secret rejects EVERY billing event before dead-lettering)",
            int(_sig_failures["count"]),
            _SIG_FAILURE_WINDOW_SECS / 60,
        )


def _note_signature_success() -> None:
    _sig_failures["count"] = 0.0
    _sig_failures["window_start"] = 0.0


def _dead_letter(
    *,
    provider: str,
    raw_payload: bytes,
    signature: str | None,
    event_id: str | None,
    event_type: str | None,
    error: BaseException,
    headers: dict[str, str] | None = None,
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
                    headers=headers,
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

    # L5 — alert on event-id-less deliveries. A missing X-Razorpay-Event-Id means
    # idempotency dedup can't key on it; in bulk it usually signals a dashboard
    # misconfiguration that would silently drop billing events. Surface loudly.
    if not event_id:
        logger.warning("razorpay_webhook_missing_event_id signature_present=%s", bool(signature))

    from app.services import razorpay_service

    try:
        razorpay_service.verify_webhook_signature(payload=raw_payload, signature=signature)
    except razorpay_service.SignatureMismatch as exc:
        import time as _time

        logger.warning("Razorpay webhook signature verification failed: %s", exc)
        _note_signature_failure(_time.monotonic())
        raise HTTPException(status_code=400, detail="Invalid webhook signature.") from exc
    _note_signature_success()

    import json

    try:
        event = json.loads(raw_payload)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.") from exc

    event_type = event.get("event", "unknown")
    logger.info("Razorpay webhook received: %s | id=%s", event_type, event_id or "N/A")

    # Headers worth keeping for replay/debug (not the whole set) — reused by both
    # the missing-id and processing-error dead-letter paths below.
    replay_headers = {
        k: request.headers.get(k)
        for k in ("x-razorpay-event-id", "x-razorpay-signature", "content-type")
        if request.headers.get(k) is not None
    }

    # Finding #4: a delivery with no X-Razorpay-Event-Id cannot be idempotency-
    # deduped, and the dispatcher would treat a null id as a "duplicate" and
    # silently ACK-drop it — a revenue-affecting event (subscription.charged /
    # payment.captured) would be lost forever behind a 200. Route it to the same
    # dead-letter + retry path as a processing failure so it is never silently
    # dropped. Modern Razorpay always sends the id, so this should be vanishingly
    # rare; when it does happen the raw event is preserved for manual replay.
    if not event_id:
        exc = RuntimeError("razorpay webhook missing x-razorpay-event-id — cannot dedup")
        logger.error("Razorpay webhook %s has no event id — dead-lettering instead of dropping", event_type)
        _dead_letter(
            provider="razorpay",
            raw_payload=raw_payload,
            signature=signature,
            event_id=None,
            event_type=event_type,
            error=exc,
            headers=replay_headers,
        )
        if WEBHOOK_RETRY_ON_ERROR:
            raise HTTPException(status_code=500, detail="Webhook missing event id; will retry.")
        return {"status": "error", "event": event_type, "message": str(exc)}

    try:
        with get_session() as session:
            result = razorpay_service.handle_webhook_event(session, event, event_id)
            session.commit()
            logger.info("Razorpay webhook processed: %s → %s", event_type, result)
        # Post-commit: nudge the PDF renderer so invoices/credit notes created
        # by this event get their Download link in seconds, not at the next
        # 5-minute sweep. No-op for events that created nothing.
        invoice_service.request_pdf_render_soon()
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
            headers=replay_headers,
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
