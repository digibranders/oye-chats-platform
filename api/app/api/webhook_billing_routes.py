"""Razorpay billing webhook handler.

Receives and processes events from Razorpay, verifying signatures and
delegating dispatch to razorpay_service.handle_webhook_event.
"""

import logging
import threading
from datetime import UTC, datetime

import anyio
from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import update

from app.config import RAZORPAY_WEBHOOK_SECRET, WEBHOOK_RETRY_ON_ERROR
from app.db.models import FailedWebhook
from app.db.session import get_session
from app.services import invoice_service

# See razorpay_webhook: webhooks process in their own bounded slice of the
# threadpool so a delivery burst can't starve every other sync route.
_WEBHOOK_THREAD_LIMITER = anyio.CapacityLimiter(10)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks", tags=["billing-webhooks"])

# ── Input ceilings ───────────────────────────────────────────────────────────
# This route is unauthenticated until the HMAC verifies, so everything it
# touches before that point is attacker-controlled. Ceilings on the two
# headers, checked before the compare, the idempotency lookup, and the
# dead-letter write. Razorpay's event id is a ~20-character handle and the
# signature is a 64-character hex digest.
_MAX_SIGNATURE_LEN = 512
_MAX_EVENT_ID_LEN = 128
# ``event`` from the (by-then authenticated) body. Used in log lines and
# persisted on the dead-letter row.
_MAX_EVENT_TYPE_LEN = 128

# ── Signature-failure escalation (P1-6a) ─────────────────────────────────────
# A single bad signature is noise (scanner, replay). A BURST of them is a
# rotated/mistyped RAZORPAY_WEBHOOK_SECRET: every billing event 400s before
# the dead-letter path, so nothing reaches Sentry and revenue events silently
# drop for Razorpay's whole retry window. Track consecutive failures in a
# rolling window and escalate to ERROR (→ Sentry) at the threshold. Process-
# local by design. This is an alert, not an exact counter, and any verified
# event resets it.
_SIG_FAILURE_WINDOW_SECS = 900.0
_SIG_FAILURE_ALERT_THRESHOLD = 3
_sig_failures: dict[str, float] = {"count": 0.0, "window_start": 0.0}
# The webhook pipeline now runs in the threadpool, so this counter is mutated
# from multiple threads, an unlocked read-modify-write would under-count and
# could miss the alert threshold.
_sig_failures_lock = threading.Lock()


def _note_signature_failure(now: float) -> None:
    with _sig_failures_lock:
        if now - _sig_failures["window_start"] > _SIG_FAILURE_WINDOW_SECS:
            _sig_failures["window_start"] = now
            _sig_failures["count"] = 0.0
        _sig_failures["count"] += 1
        count = _sig_failures["count"]
    if count >= _SIG_FAILURE_ALERT_THRESHOLD:
        logger.error(
            "Razorpay webhook signature verification failed %d times in the last %.0f min. "
            "check RAZORPAY_WEBHOOK_SECRET against the Razorpay dashboard (a rotated or "
            "mistyped secret rejects EVERY billing event before dead-lettering)",
            int(count),
            _SIG_FAILURE_WINDOW_SECS / 60,
        )


def _note_signature_success() -> None:
    with _sig_failures_lock:
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
    mask the original error. We log critically and let the caller still 5xx
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
            "Failed to dead-letter %s webhook event_id=%s. Event may be lost if retries are exhausted",
            provider,
            event_id,
            exc_info=True,
        )


def _resolve_dead_letters(*, provider: str, event_id: str) -> None:
    """Close any dead letters this event has now been processed past.

    A dead letter is a request for a retry, and Razorpay usually grants it: the
    out-of-order case this mostly catches (``subscription.charged`` landing a
    second before ``subscription.activated``) is resolved by the gateway's own
    redelivery moments later. Nothing used to close the row when that happened,
    so ``failed_webhooks`` filled with ``pending`` entries for events that had
    already succeeded. The first live payment on this platform finished with a
    correct ledger, a correct invoice, and a table reporting one failure, which
    is a signal that reads identically whether or not anything is wrong.

    Only ``pending`` rows move. ``ignored`` is an operator's conclusion about
    the event and overwriting it would rewrite their own record; ``replayed``
    keeps its first timestamp, so a third redelivery cannot restage when the
    recovery actually happened.

    Runs in its OWN session, AFTER the handler has committed, and swallows
    everything. By this point the money has moved and the event is recorded;
    letting a bookkeeping update raise would turn that into a 500 and invite
    Razorpay to redeliver something already applied.
    """
    try:
        with get_session() as session:
            session.execute(
                update(FailedWebhook)
                .where(
                    FailedWebhook.provider == provider,
                    FailedWebhook.event_id == event_id,
                    FailedWebhook.status == "pending",
                )
                .values(status="replayed", replayed_at=datetime.now(UTC))
            )
            session.commit()
    except Exception:
        logger.warning(
            "Could not close the dead letter for %s event_id=%s. The event itself processed "
            "successfully; the row is stale bookkeeping, not a lost event",
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
    route returns 5xx so Razorpay retries. Safe because event-id idempotency
    makes the eventual successful retry a no-op. The flag can be turned off to
    fall back to the legacy 200-on-error behaviour, but the event is still
    dead-lettered either way.

    Only the body read is async; the ENTIRE processing stack (HMAC, dispatch,
    DB writes, invoice work) is synchronous and runs in Starlette's threadpool
    via ``run_in_threadpool`` (P1-4). Running it inline on the event loop
    stalled every concurrent request (including /health) for the duration of
    each webhook's DB/gateway round-trips.
    """
    if not RAZORPAY_WEBHOOK_SECRET:
        logger.error("RAZORPAY_WEBHOOK_SECRET is not configured. Rejecting unverified webhook.")
        raise HTTPException(
            status_code=503,
            detail="Webhook signature verification is not configured.",
        )

    # ``BodySizeLimitMiddleware`` already refuses anything over the global
    # ceiling before we get here, which matters more on this route than any
    # other, because the HMAC cannot be checked until the bytes are in hand,
    # so the allocation is controlled by an unauthenticated caller.
    raw_payload = await request.body()
    signature = request.headers.get("x-razorpay-signature", "")
    event_id = request.headers.get("x-razorpay-event-id")
    # Bound the two header values before they are compared, used as an
    # idempotency key, or written to the dead-letter table. Razorpay's event
    # id is a ~20-char handle and the signature is a 64-char hex digest;
    # anything materially longer is not a delivery from them.
    if len(signature) > _MAX_SIGNATURE_LEN or (event_id is not None and len(event_id) > _MAX_EVENT_ID_LEN):
        logger.warning("Razorpay webhook rejected: oversized signature/event-id header")
        raise HTTPException(status_code=400, detail="Malformed webhook headers.")
    # Headers worth keeping for replay/debug (not the whole set). Reused by both
    # the missing-id and processing-error dead-letter paths.
    replay_headers = {
        k: request.headers.get(k)
        for k in ("x-razorpay-event-id", "x-razorpay-signature", "content-type")
        if request.headers.get(k) is not None
    }

    import anyio.to_thread

    # Dedicated capacity limiter: run_in_threadpool draws from anyio's default
    # 40-token pool shared with EVERY sync route in the app. A Razorpay retry
    # burst (synchronized redelivery after an outage) with handlers that make
    # inline gateway calls could otherwise occupy all 40 tokens and queue the
    # entire API. Webhooks get their own 10 tokens and can never starve the
    # rest of the app.
    return await anyio.to_thread.run_sync(
        _process_razorpay_webhook,
        raw_payload,
        signature,
        event_id,
        replay_headers,
        limiter=_WEBHOOK_THREAD_LIMITER,
    )


def _process_razorpay_webhook(
    raw_payload: bytes,
    signature: str,
    event_id: str | None,
    replay_headers: dict[str, str],
):
    """The synchronous webhook pipeline. Runs in the threadpool, never on the
    event loop. ``HTTPException`` raised here propagates through
    ``run_in_threadpool`` exactly like an inline raise."""
    # L5. Alert on event-id-less deliveries. A missing X-Razorpay-Event-Id means
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

    # Post-signature, so the payload is authenticated, but "signed by
    # Razorpay" is not "shaped the way this handler assumes". A JSON document
    # is not necessarily an object, and ``event`` is not necessarily a string:
    # both used to flow straight into ``.get()`` and into a log format.
    if not isinstance(event, dict):
        raise HTTPException(status_code=400, detail="Webhook payload must be a JSON object.")
    raw_event_type = event.get("event")
    event_type = raw_event_type[:_MAX_EVENT_TYPE_LEN] if isinstance(raw_event_type, str) else "unknown"
    logger.info("Razorpay webhook received: %s | id=%s", event_type, event_id or "N/A")

    # Finding #4: a delivery with no X-Razorpay-Event-Id cannot be idempotency-
    # deduped, and the dispatcher would treat a null id as a "duplicate" and
    # silently ACK-drop it, a revenue-affecting event (subscription.charged /
    # payment.captured) would be lost forever behind a 200. Route it to the same
    # dead-letter + retry path as a processing failure so it is never silently
    # dropped. Modern Razorpay always sends the id, so this should be vanishingly
    # rare; when it does happen the raw event is preserved for manual replay.
    if not event_id:
        exc = RuntimeError("razorpay webhook missing x-razorpay-event-id. Cannot dedup")
        logger.error("Razorpay webhook %s has no event id. Dead-lettering instead of dropping", event_type)
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
        import hashlib

        payload_digest = hashlib.sha256(raw_payload).hexdigest()
        with get_session() as session:
            result = razorpay_service.handle_webhook_event(session, event, event_id, payload_digest)
            session.commit()
            logger.info("Razorpay webhook processed: %s → %s", event_type, result)
        # This delivery may be the retry an earlier failure asked for, so close
        # the dead letter it left behind. Post-commit and best-effort: see
        # `_resolve_dead_letters`.
        _resolve_dead_letters(provider="razorpay", event_id=event_id)
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
