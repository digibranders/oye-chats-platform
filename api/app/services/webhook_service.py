import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
import urllib.request
from datetime import UTC, datetime

from sqlalchemy import select

from app.core.thread_pool import submit_background
from app.db.models import Webhook, WebhookDelivery
from app.db.session import get_session

logger = logging.getLogger(__name__)

SUPPORTED_EVENTS = ["tier_transition", "lead_captured", "handoff_requested", "chat_closed", "meeting_booked"]
_MAX_RETRIES = 4
_RETRY_DELAYS = [30, 120, 600, 3600]
_DELIVERY_TIMEOUT = 10
_RETRY_POLL_INTERVAL_SECONDS = 30

_retry_worker_thread: threading.Thread | None = None
_retry_worker_stop_event = threading.Event()


def generate_webhook_secret() -> str:
    return secrets.token_hex(32)


def sign_payload(payload_bytes: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), payload_bytes, hashlib.sha256).hexdigest()


def queue_webhook_delivery(webhook_id: int, event_type: str, data: dict, attempt: int = 1) -> None:
    """Queue a delivery attempt for exactly one webhook."""
    if event_type not in SUPPORTED_EVENTS:
        logger.warning(f"Ignoring unsupported webhook event: {event_type}")
        return
    submit_background(_deliver_webhook, webhook_id, event_type, data, attempt)


def fire_webhook(bot_id: int, event_type: str, data: dict) -> None:
    """Fire-and-forget: dispatch webhooks for bot_id matching event_type."""
    if event_type not in SUPPORTED_EVENTS:
        logger.warning(f"Ignoring unsupported webhook event: {event_type}")
        return

    with get_session() as session:
        webhooks = (
            session.execute(
                select(Webhook).where(
                    Webhook.bot_id == bot_id,
                    Webhook.is_active.is_(True),
                    Webhook.events.contains([event_type]),
                )
            )
            .scalars()
            .all()
        )

        for webhook in webhooks:
            queue_webhook_delivery(webhook.id, event_type, data)


def _deliver_webhook(webhook_id: int, event_type: str, data: dict, attempt: int = 1) -> None:
    """Deliver a single webhook — called in background thread."""
    with get_session() as session:
        webhook = session.execute(select(Webhook).where(Webhook.id == webhook_id)).scalar_one_or_none()
        if not webhook:
            return

        now = datetime.now(UTC)
        payload = data
        if not (
            isinstance(data, dict) and "event" in data and "bot_id" in data and "timestamp" in data and "data" in data
        ):
            payload = {
                "event": event_type,
                "bot_id": webhook.bot_id,
                "timestamp": now.isoformat(),
                "data": data,
            }

        payload_bytes = json.dumps(payload).encode("utf-8")
        signature = sign_payload(payload_bytes, webhook.secret)

        status_code = 0
        response_body = None
        delivered_at = None
        next_retry_at = None

        try:
            req = urllib.request.Request(
                webhook.url,
                data=payload_bytes,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "X-OyeChats-Signature": f"sha256={signature}",
                },
            )
            with urllib.request.urlopen(req, timeout=_DELIVERY_TIMEOUT) as resp:
                status_code = getattr(resp, "status", 200)
                response_body = resp.read().decode("utf-8", errors="replace")[:1000]
                if 200 <= status_code < 300:
                    delivered_at = now
                elif attempt < _MAX_RETRIES:
                    delay = _RETRY_DELAYS[min(attempt - 1, len(_RETRY_DELAYS) - 1)]
                    next_retry_at = datetime.fromtimestamp(time.time() + delay, UTC)
        except Exception as exc:
            response_body = str(exc)[:1000]
            if attempt < _MAX_RETRIES:
                delay = _RETRY_DELAYS[min(attempt - 1, len(_RETRY_DELAYS) - 1)]
                next_retry_at = datetime.fromtimestamp(time.time() + delay, UTC)

        session.add(
            WebhookDelivery(
                webhook_id=webhook.id,
                event_type=event_type,
                payload=payload,
                status_code=status_code,
                response_body=response_body,
                attempt=attempt,
                next_retry_at=next_retry_at,
                delivered_at=delivered_at,
            )
        )
        session.commit()


def process_pending_retries() -> int:
    """Process pending webhook retries that are due now."""
    now = datetime.now(UTC)
    with get_session() as session:
        pending = (
            session.execute(
                select(WebhookDelivery).where(
                    WebhookDelivery.next_retry_at.is_not(None),
                    WebhookDelivery.next_retry_at <= now,
                    WebhookDelivery.delivered_at.is_(None),
                    WebhookDelivery.attempt < _MAX_RETRIES,
                )
            )
            .scalars()
            .all()
        )

        for delivery in pending:
            queue_webhook_delivery(delivery.webhook_id, delivery.event_type, delivery.payload, attempt=delivery.attempt + 1)
            delivery.next_retry_at = None

        if pending:
            session.commit()
        return len(pending)


def _retry_worker_loop() -> None:
    while not _retry_worker_stop_event.is_set():
        try:
            queued = process_pending_retries()
            if queued:
                logger.info(f"Queued {queued} pending webhook retries.")
        except Exception as exc:
            logger.warning(f"Webhook retry poll failed: {exc}")
        _retry_worker_stop_event.wait(_RETRY_POLL_INTERVAL_SECONDS)


def start_retry_worker() -> None:
    """Start a background poller so retries continue while the app is running."""
    global _retry_worker_thread
    if _retry_worker_thread and _retry_worker_thread.is_alive():
        return

    _retry_worker_stop_event.clear()
    _retry_worker_thread = threading.Thread(target=_retry_worker_loop, name="webhook-retry-worker", daemon=True)
    _retry_worker_thread.start()
    logger.info(f"Webhook retry worker started (poll interval: {_RETRY_POLL_INTERVAL_SECONDS}s).")


def stop_retry_worker(join_timeout_seconds: float = 2.0) -> None:
    """Stop the retry poller on app shutdown."""
    global _retry_worker_thread
    if not _retry_worker_thread:
        return

    _retry_worker_stop_event.set()
    _retry_worker_thread.join(timeout=join_timeout_seconds)
    _retry_worker_thread = None
    logger.info("Webhook retry worker stopped.")
