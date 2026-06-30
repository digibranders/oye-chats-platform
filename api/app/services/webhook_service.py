import hashlib
import hmac
import http.client
import ipaddress
import json
import logging
import secrets
import socket
import ssl
import threading
import time
from datetime import UTC, datetime
from urllib.parse import urlparse

from sqlalchemy import select

from app.core.thread_pool import submit_background
from app.db.models import Webhook, WebhookDelivery
from app.db.session import get_session
from app.schemas.client import _is_public_hostname

logger = logging.getLogger(__name__)

SUPPORTED_EVENTS = ["tier_transition", "lead_captured", "handoff_requested", "chat_closed", "meeting_booked"]
_MAX_RETRIES = 5
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
    """Queue a delivery attempt for exactly one webhook.

    When WORKER_ENABLED=true, uses the ARQ task queue (durable, retryable).
    Otherwise falls back to the in-process thread pool (fire-and-forget).
    """
    if event_type not in SUPPORTED_EVENTS:
        logger.warning(f"Ignoring unsupported webhook event: {event_type}")
        return

    from app.worker.enqueue import WORKER_ENABLED

    if WORKER_ENABLED:
        from app.worker.enqueue import enqueue_sync

        enqueue_sync("task_deliver_webhook", webhook_id, event_type, data, attempt)
    else:
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


def _ip_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return not (ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local or ip.is_multicast)


def _is_safe_webhook_url(url: str) -> bool:
    """Re-validate webhook URL at delivery time to block DNS rebinding SSRF."""
    parsed = urlparse(url)
    hostname = parsed.hostname
    if not hostname:
        return False
    try:
        ip = ipaddress.ip_address(hostname)
        return _ip_is_public(ip)
    except ValueError:
        return _is_public_hostname(hostname)


def _resolve_pinned_public_ip(hostname: str) -> str | None:
    """Resolve ``hostname`` once and return a single public IP to pin to.

    Closes the SSRF TOCTOU (N7): the previous code validated the hostname with
    one DNS lookup and then let ``urlopen`` do its OWN lookup, so a short-TTL
    record could return a public IP to the check and a private IP to the
    connection microseconds later. We resolve once here and connect to exactly
    this IP. Fail-closed: if ANY resolved address is non-public, reject the host.
    """
    try:
        infos = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return None
    pinned: str | None = None
    for info in infos:
        ip_str = info[4][0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            return None
        if not _ip_is_public(ip):
            return None  # any private/internal answer → reject the whole host
        if pinned is None:
            pinned = ip_str
    return pinned


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection that dials a pre-validated IP but keeps the original
    hostname for TLS SNI + certificate verification (so pinning doesn't weaken
    TLS)."""

    def __init__(self, host, *args, pinned_ip: str, **kwargs):
        super().__init__(host, *args, **kwargs)
        self._pinned_ip = pinned_ip

    def connect(self):
        sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, *args, pinned_ip: str, **kwargs):
        super().__init__(host, *args, **kwargs)
        self._pinned_ip = pinned_ip

    def connect(self):
        self.sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)


def _open_pinned(url: str, *, data: bytes, headers: dict, timeout: int) -> tuple[int, str]:
    """POST ``data`` to ``url``, connecting to a re-validated pinned public IP.

    Returns ``(status_code, body)``. Raises on transport failure (caller logs).
    Only http/https are allowed; redirects are NOT followed (a 3xx is surfaced
    as-is so a redirect can't bounce the request to an internal address).
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Unsupported webhook URL scheme")
    pinned_ip = _resolve_pinned_public_ip(parsed.hostname)
    if pinned_ip is None:
        raise ValueError("Webhook host did not resolve to a public address")

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if parsed.scheme == "https":
        conn = _PinnedHTTPSConnection(
            parsed.hostname, port=port, timeout=timeout, pinned_ip=pinned_ip, context=ssl.create_default_context()
        )
    else:
        conn = _PinnedHTTPConnection(parsed.hostname, port=port, timeout=timeout, pinned_ip=pinned_ip)
    try:
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        conn.request("POST", path, body=data, headers=headers)
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", errors="replace")[:1000]
        return resp.status, body
    finally:
        conn.close()


def _deliver_webhook(webhook_id: int, event_type: str, data: dict, attempt: int = 1) -> None:
    """Deliver a single webhook — called in background thread."""
    with get_session() as session:
        webhook = session.execute(select(Webhook).where(Webhook.id == webhook_id)).scalar_one_or_none()
        if not webhook:
            return

        if not _is_safe_webhook_url(webhook.url):
            logger.warning("Webhook %s blocked: URL %r resolves to internal address", webhook_id, webhook.url)
            session.add(
                WebhookDelivery(
                    webhook_id=webhook.id,
                    event_type=event_type,
                    payload=data,
                    status_code=0,
                    response_body="Blocked: URL resolves to a private/internal address (DNS rebinding protection)",
                    attempt=attempt,
                    next_retry_at=None,
                    delivered_at=None,
                )
            )
            session.commit()
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
            status_code, response_body = _open_pinned(
                webhook.url,
                data=payload_bytes,
                headers={
                    "Content-Type": "application/json",
                    "X-OyeChats-Signature": f"sha256={signature}",
                },
                timeout=_DELIVERY_TIMEOUT,
            )
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
            queue_webhook_delivery(
                delivery.webhook_id, delivery.event_type, delivery.payload, attempt=delivery.attempt + 1
            )
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
