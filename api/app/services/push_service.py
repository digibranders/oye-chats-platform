"""Web Push (VAPID). Operator notifications when the dashboard tab is closed.

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
    update. Preventing the operator from racing against themselves.

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
from datetime import UTC, datetime, time
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from py_vapid import Vapid
from pywebpush import WebPushException, webpush
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import (
    EXPO_PUSH_ENABLED,
    VAPID_PRIVATE_KEY,
    VAPID_PRIVATE_KEY_FILE,
    VAPID_SUBJECT,
    WEB_PUSH_ENABLED,
)
from app.db.models import Client, Operator, OperatorExpoPushToken, OperatorPushSubscription

logger = logging.getLogger(__name__)


# Default TTL for a push (seconds). Browsers buffer pushes while the device is
# offline; this caps how long a stale chat-waiting alert lingers. A waiting
# session times out after ~20s anyway, so 60s is plenty.
DEFAULT_TTL_SECONDS = 60

# Cached ``Vapid`` instance built from the configured private key. pywebpush
# accepts a ``Vapid`` object via ``vapid_private_key``, sidestepping its
# internal ``Vapid.from_string()`` call which only handles raw / DER base64.
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
    if not WEB_PUSH_ENABLED:
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
            # Bounded HTTP timeout (pywebpush → requests.post): one unresponsive
            # push endpoint must not hang the fan-out to other subscribers (F44).
            timeout=10,
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


def _send_expo_pushes_to_rows(
    session: Session,
    tokens: list[OperatorExpoPushToken],
    payload: dict[str, Any],
) -> int:
    """Inner fan-out for Expo pushes: send to a pre-fetched list of tokens, prune stale ones."""
    if not EXPO_PUSH_ENABLED or not tokens:
        return 0

    messages = []
    for t in tokens:
        message = {
            "to": t.token,
            "sound": "default",
            "body": payload.get("body"),
            "data": payload,
        }
        if "title" in payload:
            message["title"] = payload["title"]
        messages.append(message)

    delivered = 0
    stale_ids = []
    now = datetime.now(UTC)

    try:
        response = httpx.post("https://exp.host/--/api/v2/push/send", json=messages, timeout=10)
        # Expo returns a list of results corresponding to the messages array
        if response.status_code == 200:
            results = response.json().get("data", [])
            for i, result in enumerate(results):
                token_row = tokens[i]
                status = result.get("status")
                if status == "ok":
                    delivered += 1
                    token_row.last_used_at = now
                elif status == "error":
                    details = result.get("details", {})
                    error_code = details.get("error")
                    if error_code in ("DeviceNotRegistered", "InvalidCredentials"):
                        logger.info("Expo Push token stale, will prune: %s", token_row.token)
                        stale_ids.append(token_row.id)
                    else:
                        logger.warning("Expo push error: %s", result.get("message"))
        else:
            logger.warning("Expo API failed with status %s: %s", response.status_code, response.text)
    except httpx.RequestError as exc:
        logger.warning("Expo Push API request failed: %s", exc)

    if stale_ids:
        session.execute(delete(OperatorExpoPushToken).where(OperatorExpoPushToken.id.in_(stale_ids)))

    return delivered


def send_push_to_operator(
    session: Session,
    operator_id: int,
    payload: dict[str, Any],
    *,
    tag: str | None = None,
    ttl: int = DEFAULT_TTL_SECONDS,
    web: bool = True,
    expo: bool = True,
) -> int:
    """Send the same payload to every subscription owned by an operator.

    Prunes subscriptions that return 410 in the same DB transaction. Returns
    the number of successful deliveries (best-effort. Push is fire-and-forget,
    not delivery-guaranteed).

    ``web`` / ``expo`` select which transports to use. Callers suppress *web*
    push for an operator with an open dashboard tab (the in-page toast already
    covers them) but must still send *expo*: a browser toast is not visible on
    a phone, so the two are never duplicates of each other.
    """
    subs = (
        session.execute(select(OperatorPushSubscription).where(OperatorPushSubscription.operator_id == operator_id))
        .scalars()
        .all()
        if web
        else []
    )
    expo_tokens = (
        session.execute(select(OperatorExpoPushToken).where(OperatorExpoPushToken.operator_id == operator_id))
        .scalars()
        .all()
        if expo
        else []
    )

    web_delivered = _send_push_to_rows(session, subs, payload, tag=tag, ttl=ttl)
    expo_delivered = _send_expo_pushes_to_rows(session, expo_tokens, payload)

    return web_delivered + expo_delivered


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
    subs = (
        session.execute(select(OperatorPushSubscription).where(OperatorPushSubscription.client_id == client_id))
        .scalars()
        .all()
    )
    expo_tokens = (
        session.execute(select(OperatorExpoPushToken).where(OperatorExpoPushToken.client_id == client_id))
        .scalars()
        .all()
    )

    web_delivered = _send_push_to_rows(session, subs, payload, tag=tag, ttl=ttl)
    expo_delivered = _send_expo_pushes_to_rows(session, expo_tokens, payload)

    return web_delivered + expo_delivered


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


# ── Notification preferences filter ─────────────────────────────────────────
#
# ``Operator.notification_preferences`` is a JSONB column with (currently) this
# shape:
#
#   {
#     "push": {
#       "enabled": true,
#       "quiet_hours": { "start": "22:00", "end": "07:00", "tz": "Asia/Kolkata" },
#       "events": {
#         "handoff_request": true,
#         "offline_message": true,
#         "chat_transferred": true
#       }
#     }
#   }
#
# Absent / null prefs = fully opted in (backward compat). Malformed prefs are
# treated as fully opted in too, an operator missing a push in a config-parse
# edge case is a worse outcome than one extra push.

_EVENT_CATEGORY = {
    # Every handoff-related notification (initial + escalations) shares one
    # opt-out category so an operator either wants handoff pings or doesn't.
    "handoff_request": "handoff_request",
    "handoff_moved_to_offline": "handoff_request",
    "handoff_expired": "handoff_request",
    "chat_transferred": "chat_transferred",
    "offline_message_received": "offline_message",
}


def _parse_hhmm(raw: Any) -> time | None:
    """Parse ``"HH:MM"`` → ``datetime.time``; return None on any fault."""
    if not isinstance(raw, str) or len(raw) < 3:
        return None
    try:
        hh, mm = raw.split(":", 1)
        return time(int(hh), int(mm))
    except (ValueError, TypeError):
        return None


def _in_quiet_hours(quiet: dict[str, Any], now_utc: datetime) -> bool:
    """Return True if ``now_utc`` falls inside the operator's quiet window."""
    start = _parse_hhmm(quiet.get("start"))
    end = _parse_hhmm(quiet.get("end"))
    if start is None or end is None or start == end:
        return False

    tz_name = quiet.get("tz") if isinstance(quiet.get("tz"), str) else "UTC"
    try:
        tz = ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        tz = ZoneInfo("UTC")

    local_now = now_utc.astimezone(tz).time()
    if start < end:
        # Same-day window (e.g. 13:00-17:00).
        return start <= local_now < end
    # Wraps midnight (e.g. 22:00-07:00). Quiet if either side of midnight.
    return local_now >= start or local_now < end


def _operator_wants_push(prefs: Any, event_type: str, now_utc: datetime) -> bool:
    """Consult a single operator's prefs for a specific ``event_type``.

    Absent / non-dict prefs → True (opted in). Explicit ``push.enabled=False``
    or ``push.events.<category>=False`` → False. Quiet hours match → False.
    """
    if not isinstance(prefs, dict):
        return True
    push = prefs.get("push")
    if not isinstance(push, dict):
        return True
    if push.get("enabled") is False:
        return False

    events = push.get("events")
    if isinstance(events, dict):
        category = _EVENT_CATEGORY.get(event_type, event_type)
        # Missing key = opted in; explicit False = opted out.
        if events.get(category) is False:
            return False

    quiet = push.get("quiet_hours")
    return not (isinstance(quiet, dict) and _in_quiet_hours(quiet, now_utc))


# The three per-event push categories a freshly created account starts opted
# OUT of. Mirrors ``_PUSH_EVENT_KEYS`` in ``api/app/api/operator_routes.py``.
_NEW_ACCOUNT_MUTED_EVENTS = ("chat_transferred", "handoff_request", "offline_message")


def muted_push_preferences() -> dict:
    """Push prefs stamped on a NEW account: reachable, but every event off.

    Absent prefs still mean "fully opted in" for every account created before
    this (see ``_operator_wants_push``); that convention is unchanged. Only new
    signups and new operators carry this explicit body, so they begin quiet and
    turn on the events they want rather than being paged from minute one. The
    master ``enabled`` stays True so the account only has to flip individual
    events, and the shape matches ``_normalize_prefs`` so the preferences GET
    echoes it back unchanged.
    """
    return {
        "push": {
            "enabled": True,
            "events": {key: False for key in sorted(_NEW_ACCOUNT_MUTED_EVENTS)},
            "quiet_hours": None,
        }
    }


def client_wants_push(
    session: Session,
    client_id: int,
    event_type: str,
    *,
    now: datetime | None = None,
) -> bool:
    """Consult a workspace owner's prefs, mirroring the operator filter.

    The owner is a genuine push recipient (``send_push_to_client``), so the same
    opt-outs and quiet hours must apply. Unknown client → True, matching the
    "absent prefs = opted in" convention used everywhere else here.
    """
    prefs = session.execute(select(Client.notification_preferences).where(Client.id == client_id)).scalar_one_or_none()
    return _operator_wants_push(prefs, event_type, now or datetime.now(UTC))


def filter_operators_by_push_prefs(
    session: Session,
    operator_ids: list[int],
    event_type: str,
    *,
    now: datetime | None = None,
) -> list[int]:
    """Drop operator IDs whose ``notification_preferences`` opt them out.

    Consulted by every dispatch task before the fan-out. Preserves input order
    so downstream ordering (round-robin, tie-breakers) isn't perturbed.
    Operators not found in the DB are dropped defensively.
    """
    if not operator_ids:
        return []
    now_utc = now or datetime.now(UTC)
    rows = session.execute(
        select(Operator.id, Operator.notification_preferences).where(Operator.id.in_(operator_ids))
    ).all()
    prefs_by_id = {row[0]: row[1] for row in rows}
    return [
        op_id
        for op_id in operator_ids
        if op_id in prefs_by_id and _operator_wants_push(prefs_by_id[op_id], event_type, now_utc)
    ]
