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

# Circuit breaker: consecutive EXHAUSTED deliveries (every attempt for one event
# failed) that auto-disable an endpoint. ``_MAX_RETRIES`` bounds retries per
# EVENT only, so without this an endpoint dead for a week keeps costing five
# attempts for every event a busy bot produces, forever.
_CIRCUIT_BREAKER_THRESHOLD = 10

# Rows one retry sweep may claim. The sweep holds ``FOR UPDATE`` locks across a
# serial Redis round-trip per row while the 30s cron re-fires, so an unbounded
# claim after an outage means one transaction pinning the whole backlog. Later
# ticks drain the rest.
_RETRY_SWEEP_LIMIT = 200

_CIRCUIT_BREAKER_REASON = (
    f"Auto-disabled after {_CIRCUIT_BREAKER_THRESHOLD} consecutive deliveries exhausted every retry "
    "without a single success. Fix the endpoint, then re-enable this webhook."
)

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
        # Plan gate (deny-by-default): outbound webhooks are a paid feature.
        # The create-time gate in ``webhook_routes`` only blocks NEW
        # registrations, it never revokes existing rows. Without this
        # delivery-time check, a ``Webhook`` registered on a paid tier keeps
        # firing forever after the customer downgrades to a tier that lacks
        # ``webhooks`` (e.g. Starter). Resolve the owning client and consult
        # LIVE entitlements (60s cache) so the flip takes effect shortly after
        # the downgrade cuts over. Fails closed: a resolver error drops the
        # dispatch rather than leaking the paid feature.
        from app.services import plan_entitlements_service

        # Per-bot gate: outbound webhooks follow THIS bot's own subscription
        # (with account fallback). An unknown/deleted bot resolves to the Free
        # fallback and is therefore denied. Deny-by-default.
        if not plan_entitlements_service.get_bot_entitlements(bot_id, session).has_feature("webhooks"):
            logger.info(
                "fire_webhook: bot %s plan lacks 'webhooks'. Skipping %s dispatch",
                bot_id,
                event_type,
            )
            return

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


def _loggable_url(url: str) -> str:
    """The part of a webhook URL that is safe to write to a log: scheme and host.

    For the integrations customers actually wire up (Zapier
    ``hooks.zapier.com/hooks/catch/<id>/<token>/``, Make, n8n) the PATH is the
    credential: anyone holding it can post events into the customer's
    automation. A log line carrying the full URL lands in the journal and rides
    into Sentry as a breadcrumb on the worker's next event, and ``scrub_event``
    strips request headers, not log arguments. The host is all triage needs.
    """
    try:
        parsed = urlparse(url)
    except ValueError:
        return "<unparseable>"
    if not parsed.scheme or not parsed.hostname:
        return "<unparseable>"
    host = parsed.hostname
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return f"{parsed.scheme}://{host}"


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


def _trip_circuit_breaker_if_dead(session, webhook: Webhook) -> None:
    """Auto-disable ``webhook`` once its endpoint has been dead for N events.

    Called only after a terminal failure has been committed, so the row that
    just landed is part of the window.

    The streak is DERIVED from ``webhook_deliveries`` rather than tracked in a
    counter column: a counter would need its own migration, its own reset path,
    and would drift the moment a delivery row was written outside this function.

    "Outcome" rows are those with no ``next_retry_at``: a success clears the
    marker, and so does a final failure. A row that still carries one is a
    ladder rung mid-flight, not a verdict, and counting rungs would trip the
    breaker five times too early. A success anywhere in the most recent
    ``_CIRCUIT_BREAKER_THRESHOLD`` outcomes resets the streak, which is what
    makes "consecutive" mean consecutive.

    ``disabled_at`` bounds the window. Without it, a webhook the customer
    re-enables carries a full streak into its second life and the next single
    failing event re-disables it instantly.
    """
    outcomes = select(WebhookDelivery.delivered_at).where(
        WebhookDelivery.webhook_id == webhook.id,
        WebhookDelivery.next_retry_at.is_(None),
    )
    if webhook.disabled_at is not None:
        outcomes = outcomes.where(WebhookDelivery.created_at > webhook.disabled_at)

    recent = (
        session.execute(
            outcomes.order_by(WebhookDelivery.created_at.desc(), WebhookDelivery.id.desc()).limit(
                _CIRCUIT_BREAKER_THRESHOLD
            )
        )
        .scalars()
        .all()
    )
    if len(recent) < _CIRCUIT_BREAKER_THRESHOLD or any(delivered_at is not None for delivered_at in recent):
        return

    webhook.is_active = False
    webhook.disabled_reason = _CIRCUIT_BREAKER_REASON
    webhook.disabled_at = datetime.now(UTC)
    session.commit()
    # Once per endpoint: ``fire_webhook`` filters on ``is_active``, so no
    # further event reaches this branch until the customer re-enables it.
    logger.error(
        "Webhook %s AUTO-DISABLED: %d consecutive deliveries exhausted every attempt against %s. "
        "No further events will be dispatched until the customer re-enables it",
        webhook.id,
        _CIRCUIT_BREAKER_THRESHOLD,
        _loggable_url(webhook.url),
    )


def _deliver_webhook(webhook_id: int, event_type: str, data: dict, attempt: int = 1) -> None:
    """Deliver a single webhook. Called in background thread."""
    with get_session() as session:
        webhook = session.execute(select(Webhook).where(Webhook.id == webhook_id)).scalar_one_or_none()
        if not webhook:
            return

        if not _is_safe_webhook_url(webhook.url):
            logger.warning(
                "Webhook %s blocked: URL at %s resolves to internal address",
                webhook_id,
                _loggable_url(webhook.url),
            )
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
            # No breaker evaluation here. A blocked row is terminal, so it still
            # COUNTS toward a later streak, but an SSRF block is a rejection at
            # our own edge rather than a customer endpoint that failed, and
            # tripping on it would disable a webhook whose owner never saw a
            # single request leave.
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

        # L-4: the LAST attempt failing is the moment a customer integration
        # goes permanently dark for this event. Say so at ERROR (Sentry picks
        # it up) instead of burying it as one more attempt row.
        if delivered_at is None and next_retry_at is None and attempt >= _MAX_RETRIES:
            logger.error(
                "Webhook delivery EXHAUSTED after %d attempts: webhook %s event %s last_status=%s. "
                "the customer endpoint never accepted this event and no further retries will run",
                attempt,
                webhook.id,
                event_type,
                status_code,
            )

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

        # Only a terminal failure can extend the streak. A success or a rung
        # still awaiting its retry cannot, so the query is not worth running.
        if delivered_at is None and next_retry_at is None and webhook.is_active:
            _trip_circuit_breaker_if_dead(session, webhook)


def process_pending_retries() -> int:
    """Process pending webhook retries that are due now.

     ``FOR UPDATE SKIP LOCKED`` (M-4): the ARQ cron and any legacy in-process
     poller can sweep concurrently; without row locks both would enqueue the
     same delivery and the customer receives duplicates. SKIP LOCKED lets
     concurrent sweepers partition the due set instead of double-claiming it.

     The ``next_retry_at`` marker is cleared ONLY after the enqueue call
     returns (M-1): clearing first meant a Redis hiccup lost the retry forever
    , the marker is the sole record that a redelivery is owed. On enqueue
     failure the row keeps its marker and the next sweep retries it.

     The claim is capped at ``_RETRY_SWEEP_LIMIT``. Unbounded, one sweep after
     an outage claimed every due row and then held its ``FOR UPDATE`` locks
     across a serial Redis round-trip per row, while the 30s cron kept firing
     on top of it. Oldest-due first, so a bounded sweep drains a backlog in
     order rather than starving the rows that have waited longest.
    """
    now = datetime.now(UTC)
    queued = 0
    with get_session() as session:
        pending = (
            session.execute(
                select(WebhookDelivery)
                .where(
                    WebhookDelivery.next_retry_at.is_not(None),
                    WebhookDelivery.next_retry_at <= now,
                    WebhookDelivery.delivered_at.is_(None),
                    WebhookDelivery.attempt < _MAX_RETRIES,
                )
                .order_by(WebhookDelivery.next_retry_at.asc(), WebhookDelivery.id.asc())
                .limit(_RETRY_SWEEP_LIMIT)
                .with_for_update(skip_locked=True)
            )
            .scalars()
            .all()
        )

        for delivery in pending:
            try:
                queue_webhook_delivery(
                    delivery.webhook_id, delivery.event_type, delivery.payload, attempt=delivery.attempt + 1
                )
            except Exception:
                logger.exception(
                    "Webhook retry enqueue failed for delivery %s (webhook %s). Keeping next_retry_at "
                    "so the next sweep re-claims it",
                    delivery.id,
                    delivery.webhook_id,
                )
                continue
            delivery.next_retry_at = None
            queued += 1

        if pending:
            session.commit()
        return queued


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
