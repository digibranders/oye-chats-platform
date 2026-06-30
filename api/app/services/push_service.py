"""Web Push (VAPID) — operator notifications when the dashboard tab is closed.

This service is the **delivery layer**. It does not decide *when* to push;
that lives in ``operator_routes.py`` (handoff) and ``ws_routes.py`` (visitor
message in an unattended session). Both call into ``send_push_to_operator``
which fans out to every subscription belonging to the target operator.

Why "all subscriptions per operator":
    An operator can subscribe from multiple devices (laptop + work desktop +
    phone). We fire to every device; whichever device the operator clicks
    first wins (via ``accept_chat``'s race-safe lock). Subsequent pushes for
    the same chat carry the same ``tag``, which tells the browser to replace
    the earlier notification on the other devices with the "Claimed by X"
    update — preventing the operator from racing against themselves.

Failures:
    Push providers (FCM, Mozilla autopush, APNs bridge) return ``410 Gone``
    when a subscription has been revoked (user cleared cookies, disabled
    notifications, uninstalled the browser). We prune the row immediately on
    410; subsequent codes (404, 5xx) are logged but the row is kept since
    they're typically transient.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

from py_vapid import Vapid
from pywebpush import WebPushException, webpush
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import (
    PUSH_ENABLED,
    VAPID_PRIVATE_KEY,
    VAPID_PRIVATE_KEY_FILE,
    VAPID_SUBJECT,
)
from app.db.models import OperatorPushSubscription

logger = logging.getLogger(__name__)


# Default TTL for a push (seconds). Browsers buffer pushes while the device is
# offline; this caps how long a stale chat-waiting alert lingers. A waiting
# session times out after ~20s anyway, so 60s is plenty.
DEFAULT_TTL_SECONDS = 60

# Cached ``Vapid`` instance built from the configured private key. pywebpush
# accepts a ``Vapid`` object via ``vapid_private_key``, sidestepping its
# internal ``Vapid.from_string()`` call which only handles raw / DER base64 —
# **not** PEM strings. Building this once at module load avoids re-parsing
# the key on every push send.
_VAPID_INSTANCE: Vapid | None = None


def _load_private_key_pem() -> str:
    """Resolve the VAPID private key PEM from env (inline) or file path."""
    if VAPID_PRIVATE_KEY:
        # python-dotenv un-escapes \\n already; if a literal "\n" slipped
        # through (e.g. raw paste without quotes), fix it defensively.
        return VAPID_PRIVATE_KEY.replace("\\n", "\n")
    if VAPID_PRIVATE_KEY_FILE:
        with open(VAPID_PRIVATE_KEY_FILE, encoding="utf-8") as f:
            return f.read()
    raise RuntimeError("VAPID private key not configured")


def _get_vapid() -> Vapid:
    """Return the cached Vapid instance, loading the PEM on first use."""
    global _VAPID_INSTANCE
    if _VAPID_INSTANCE is None:
        pem = _load_private_key_pem()
        _VAPID_INSTANCE = Vapid.from_pem(pem.encode("utf-8"))
    return _VAPID_INSTANCE


def send_push_to_subscription(
    endpoint: str,
    p256dh: str,
    auth: str,
    payload: dict[str, Any],
    *,
    tag: str | None = None,
    ttl: int = DEFAULT_TTL_SECONDS,
) -> tuple[bool, int | None]:
    """Send a single push to a single subscription.

    Returns ``(success, status_code)``. ``status_code`` is ``None`` for
    network-level errors. A ``410`` means the caller must prune this row.
    """
    if not PUSH_ENABLED:
        return False, None

    subscription_info = {
        "endpoint": endpoint,
        "keys": {"p256dh": p256dh, "auth": auth},
    }
    # Carry the tag inside the payload so the service worker can pass it to
    # the Notification options. It's the SW's `tag` field that drives the
    # "replace earlier notification" semantics, not anything at the protocol
    # layer.
    data = dict(payload)
    if tag is not None and "tag" not in data:
        data["tag"] = tag

    try:
        response = webpush(
            subscription_info=subscription_info,
            data=json.dumps(data),
            vapid_private_key=_get_vapid(),
            vapid_claims={"sub": VAPID_SUBJECT},
            ttl=ttl,
        )
        return True, getattr(response, "status_code", 201)
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status == 410:
            logger.info("Push endpoint gone (410), will prune: %s", endpoint[:80])
        else:
            logger.warning("Push failed (status=%s): %s", status, exc)
        return False, status
    except Exception:
        logger.exception("Unexpected push send failure for endpoint %s", endpoint[:80])
        return False, None


def _send_push_to_rows(
    session: Session,
    subs: list[OperatorPushSubscription],
    payload: dict[str, Any],
    *,
    tag: str | None,
    ttl: int,
) -> int:
    """Inner fan-out: send to a pre-fetched list, prune 410s, return count."""
    if not subs:
        return 0
    stale_ids: list[int] = []
    delivered = 0
    now = datetime.now(UTC)
    for sub in subs:
        ok, status = send_push_to_subscription(sub.endpoint, sub.p256dh, sub.auth, payload, tag=tag, ttl=ttl)
        if ok:
            sub.last_used_at = now
            delivered += 1
        elif status == 410:
            stale_ids.append(sub.id)
    if stale_ids:
        session.execute(delete(OperatorPushSubscription).where(OperatorPushSubscription.id.in_(stale_ids)))
    return delivered


def send_push_to_operator(
    session: Session,
    operator_id: int,
    payload: dict[str, Any],
    *,
    tag: str | None = None,
    ttl: int = DEFAULT_TTL_SECONDS,
) -> int:
    """Send the same payload to every subscription owned by an operator.

    Prunes subscriptions that return 410 in the same DB transaction. Returns
    the number of successful deliveries (best-effort — push is fire-and-forget,
    not delivery-guaranteed).
    """
    if not PUSH_ENABLED:
        return 0
    subs = (
        session.execute(select(OperatorPushSubscription).where(OperatorPushSubscription.operator_id == operator_id))
        .scalars()
        .all()
    )
    return _send_push_to_rows(session, subs, payload, tag=tag, ttl=ttl)


def send_push_to_client(
    session: Session,
    client_id: int,
    payload: dict[str, Any],
    *,
    tag: str | None = None,
    ttl: int = DEFAULT_TTL_SECONDS,
) -> int:
    """Send the same payload to every subscription owned by a workspace owner.

    Mirrors ``send_push_to_operator`` but for ``client_id``-keyed rows so the
    small-team case (workspace owner is the primary chat-taker) gets push
    coverage without a separate Operator record.
    """
    if not PUSH_ENABLED:
        return 0
    subs = (
        session.execute(select(OperatorPushSubscription).where(OperatorPushSubscription.client_id == client_id))
        .scalars()
        .all()
    )
    return _send_push_to_rows(session, subs, payload, tag=tag, ttl=ttl)


def send_push_to_operators(
    session: Session,
    operator_ids: list[int],
    payload: dict[str, Any],
    *,
    tag: str | None = None,
    ttl: int = DEFAULT_TTL_SECONDS,
) -> int:
    """Fan-out helper: send the same push to many operators at once.

    Returns total deliveries across all recipients.
    """
    total = 0
    for operator_id in operator_ids:
        total += send_push_to_operator(session, operator_id, payload, tag=tag, ttl=ttl)
    return total
