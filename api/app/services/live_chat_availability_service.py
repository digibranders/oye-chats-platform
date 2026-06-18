"""Live chat availability — the deterministic state resolver.

This is the **single source of truth** for "what should the widget do when a
visitor clicks Talk to Human?". Every code path that needs to know the live
chat state — the WebSocket handler, the queue service, the admin status pill —
reads from ``resolve_live_chat_state`` so behavior never diverges.

## States

The seven possible outcomes, in priority order (first matching wins):

1. ``FEATURE_DISABLED`` — workspace plan excludes live chat, or admin toggled
   ``bot.live_chat_enabled`` off. Widget shows offline form immediately.
2. ``NO_OPERATORS`` — workspace has zero operators in the DB. Admin nudge:
   "add your first operator". Widget shows offline form immediately.
3. ``OUT_OF_HOURS`` — current time is outside ``bot.business_hours``. Widget
   shows offline form + "back at {next_open}" copy.
4. ``ALL_OFFLINE`` — operators exist but none have an active presence. Widget
   shows offline form + "team is offline" copy.
5. ``QUEUE_FULL`` — operators online but queue is at ``max_queue_size``.
   Widget shows offline form + "very busy" copy.
6. ``ALL_BUSY`` — every online operator is at ``max_concurrent_chats``.
   Widget enters queue UI with progressive messaging + 20s timeout to form.
7. ``AVAILABLE`` — at least one operator can take the chat now. Routes.

## Why a state machine, not nested ifs

Adding a new state later (e.g. ``MAINTENANCE``, ``RATE_LIMITED``) means adding
one short block in ``resolve_live_chat_state`` and one frontend message variant
— nothing else changes. The flat early-return structure means every branch is
independently testable; we don't have to reason about how ``out_of_hours``
interacts with ``all_busy``.

## Caching

The resolver result is cached in Redis 5s per ``(bot_id,)``. Reads from the
widget can fire every few seconds during a queue wait, but the underlying
inputs (operator presence, queue size, business hours window) shift at most
once per second. Cache is invalidated explicitly on operator
online/offline/queue-change/bot-config-change to avoid stale-state UX.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.cache import PREFIX, get_redis
from app.db.models import Bot, LiveChatQueueEntry, Operator
from app.services import operator_presence_service as presence

logger = logging.getLogger(__name__)


# ── Constants ──────────────────────────────────────────────────────────────

# Resolver result is cached for this many seconds. Short window — state can
# change quickly when an operator comes online or queue moves; long enough that
# rapid-fire widget polls don't hammer Postgres on every request.
RESOLVER_CACHE_TTL_SECONDS = 5


# ── Data types ─────────────────────────────────────────────────────────────


class LiveChatState(StrEnum):
    """Every possible outcome the state machine can return. Strings on the
    wire so JSON serialization is direct (no enum-to-string ceremony in the
    WebSocket handler).
    """

    AVAILABLE = "available"
    NO_OPERATORS = "no_operators"
    OUT_OF_HOURS = "out_of_hours"
    ALL_OFFLINE = "all_offline"
    ALL_BUSY = "all_busy"
    QUEUE_FULL = "queue_full"
    FEATURE_DISABLED = "feature_disabled"


class SuggestedAction(StrEnum):
    """The frontend reads this single field to decide UI mode. Keeps the
    widget dumb — it doesn't have to map every state to a screen.
    """

    ROUTE = "route"  # Immediately route to an operator
    WAIT = "wait"  # Show queue UI with progressive messaging
    OFFLINE_FORM = "offline_form"  # Show offline form (with state-specific copy)


@dataclass
class LiveChatAvailability:
    """The resolver's return shape. Serialized straight to the widget."""

    state: LiveChatState
    suggested_action: SuggestedAction
    # Visitor-facing copy keys — the widget translates these to localized strings.
    # We pass keys instead of full text so admin-customized messages can be
    # injected by the WebSocket handler before send (separation of concerns).
    message_key: str = ""
    # Queue context (only populated when relevant)
    queue_position: int | None = None
    eta_seconds: int | None = None
    queue_timeout_seconds: int | None = None  # When to give up and show form
    online_operator_count: int = 0
    # ISO 8601 string for "back at..." messaging when out of hours.
    next_available_at: str | None = None
    # Arbitrary metadata for debugging / analytics — never used by widget UX.
    debug: dict[str, Any] = field(default_factory=dict)

    def to_json_dict(self) -> dict[str, Any]:
        """Plain dict for JSON serialization — enums become their string values."""
        d = asdict(self)
        d["state"] = self.state.value
        d["suggested_action"] = self.suggested_action.value
        return d


# ── Cache keys ─────────────────────────────────────────────────────────────


def _resolver_cache_key(bot_id: int, department_id: int | None = None) -> str:
    # Department gets its own cache slot because business hours are
    # per-department now — Sales and Support can have different OUT_OF_HOURS
    # answers at the same moment for the same bot.
    if department_id is None:
        return f"{PREFIX}live_chat:state:{bot_id}"
    return f"{PREFIX}live_chat:state:{bot_id}:dept:{department_id}"


def invalidate(bot_id: int) -> None:
    """Drop the cached resolver result for a bot.

    Call this whenever an input to the state machine changes: an operator
    comes online/offline, queue size changes, ``bot.live_chat_enabled``
    toggles, etc. The next ``resolve_live_chat_state(bot)`` call re-computes
    from primary sources.
    """
    client = get_redis()
    if client is None:
        return
    try:
        # Drop the bot-level key + all per-department keys for this bot.
        # SCAN keeps memory usage bounded even with hundreds of departments
        # (would not happen in practice, but defensive).
        client.delete(_resolver_cache_key(bot_id))
        pattern = f"{PREFIX}live_chat:state:{bot_id}:dept:*"
        cursor = 0
        while True:
            cursor, keys = client.scan(cursor=cursor, match=pattern, count=100)
            if keys:
                client.delete(*keys)
            if cursor == 0:
                break
    except Exception:
        logger.debug("Failed to invalidate live chat state cache for bot=%s", bot_id, exc_info=True)


# ── Main resolver ──────────────────────────────────────────────────────────


def resolve_live_chat_state(
    bot: Bot,
    db_session: Session,
    *,
    department_id: int | None = None,
    use_cache: bool = True,
) -> LiveChatAvailability:
    """Decide what the widget should do for this bot right now.

    Returns within ~5ms on cache hit, ~20-50ms on miss (one Redis SMEMBERS + one
    DB query for capacity). Safe to call on every WebSocket open and every
    queue-update tick.

    When ``department_id`` is provided, business hours are read from that
    department's ``business_hours`` column instead of the bot's. This lets
    Sales 9-6 and Support 24/7 coexist in the same workspace without
    contradiction. With no department, falls back to ``bot.business_hours``
    as the workspace-wide schedule.

    The function is intentionally side-effect-free: it does NOT enqueue, route,
    or notify. Those are the caller's job once they see the returned state.
    Keeping the resolver pure means we can call it from anywhere (audit logs,
    admin dashboard polling, queue-timeout cron) without spurious behavior.
    """
    if use_cache:
        cached = _read_cache(bot.id, department_id)
        if cached is not None:
            return cached

    result = _compute(bot, db_session, department_id=department_id)
    _write_cache(bot.id, result, department_id)
    return result


def _compute(bot: Bot, db_session: Session, *, department_id: int | None = None) -> LiveChatAvailability:
    """Run the state machine. Internal — most callers should use the public
    cached entry point above.
    """
    # 1. Feature gate — bot toggle + (future) plan entitlement check.
    if not bot.live_chat_enabled:
        return LiveChatAvailability(
            state=LiveChatState.FEATURE_DISABLED,
            suggested_action=SuggestedAction.OFFLINE_FORM,
            message_key="feature_disabled",
        )

    # 2. Are there any operators at all in this workspace?
    operator_count = db_session.execute(
        select(func.count(Operator.id)).where(
            Operator.client_id == bot.client_id,
            Operator.is_active.is_(True),
        )
    ).scalar_one()

    if operator_count == 0:
        return LiveChatAvailability(
            state=LiveChatState.NO_OPERATORS,
            suggested_action=SuggestedAction.OFFLINE_FORM,
            message_key="no_operators",
        )

    # 3. Business hours check. If the visitor's session has a department_id,
    # use that department's hours (per-department scheduling — Sales 9-6
    # vs Support 24/7). Otherwise fall back to the bot-level hours for
    # workspaces with no department configured. Null/empty → 24/7.
    business_hours = bot.business_hours
    if department_id is not None:
        from app.db.models import Department

        dept = db_session.get(Department, department_id)
        if dept is not None and dept.business_hours is not None:
            business_hours = dept.business_hours

    if not _within_business_hours(business_hours):
        return LiveChatAvailability(
            state=LiveChatState.OUT_OF_HOURS,
            suggested_action=SuggestedAction.OFFLINE_FORM,
            message_key="out_of_hours",
            next_available_at=_next_business_hour_iso(business_hours),
        )

    # 4. Any operators online?
    online_ids = presence.get_online_operator_ids(bot.client_id)
    if not online_ids:
        return LiveChatAvailability(
            state=LiveChatState.ALL_OFFLINE,
            suggested_action=SuggestedAction.OFFLINE_FORM,
            message_key="all_offline",
        )

    # 5. Is the queue at capacity? Check BEFORE capacity check — if queue is
    # full and operators are busy, we want "queue_full" copy not "all_busy".
    current_queue_size = _current_queue_size(bot.id, db_session)
    if current_queue_size >= (bot.live_chat_max_queue_size or 10):
        return LiveChatAvailability(
            state=LiveChatState.QUEUE_FULL,
            suggested_action=SuggestedAction.OFFLINE_FORM,
            message_key="queue_full",
            online_operator_count=len(online_ids),
        )

    # 6. Anyone with capacity? Reuses the presence helper that already
    # combines online+is_active+is_accepting_chats+max_concurrent_chats.
    available = presence.get_online_operators_with_capacity(bot.client_id, db_session)
    if not available:
        return LiveChatAvailability(
            state=LiveChatState.ALL_BUSY,
            suggested_action=SuggestedAction.WAIT,
            message_key="all_busy",
            queue_position=current_queue_size + 1,
            eta_seconds=_estimate_wait_seconds(current_queue_size + 1, online_ids, db_session),
            queue_timeout_seconds=bot.live_chat_queue_timeout_seconds or 20,
            online_operator_count=len(online_ids),
        )

    # 7. ✅ Available — route immediately.
    return LiveChatAvailability(
        state=LiveChatState.AVAILABLE,
        suggested_action=SuggestedAction.ROUTE,
        message_key="connecting",
        online_operator_count=len(online_ids),
    )


# ── Cache helpers ──────────────────────────────────────────────────────────


def _read_cache(bot_id: int, department_id: int | None = None) -> LiveChatAvailability | None:
    client = get_redis()
    if client is None:
        return None
    try:
        raw = client.get(_resolver_cache_key(bot_id, department_id))
        if raw is None:
            return None
        data = json.loads(raw)
        return LiveChatAvailability(
            state=LiveChatState(data["state"]),
            suggested_action=SuggestedAction(data["suggested_action"]),
            message_key=data.get("message_key", ""),
            queue_position=data.get("queue_position"),
            eta_seconds=data.get("eta_seconds"),
            queue_timeout_seconds=data.get("queue_timeout_seconds"),
            online_operator_count=data.get("online_operator_count", 0),
            next_available_at=data.get("next_available_at"),
            debug=data.get("debug", {}),
        )
    except Exception:
        logger.debug("Resolver cache read failed for bot=%s", bot_id, exc_info=True)
        return None


def _write_cache(bot_id: int, availability: LiveChatAvailability, department_id: int | None = None) -> None:
    client = get_redis()
    if client is None:
        return
    try:
        client.setex(
            _resolver_cache_key(bot_id, department_id),
            RESOLVER_CACHE_TTL_SECONDS,
            json.dumps(availability.to_json_dict()),
        )
    except Exception:
        logger.debug("Resolver cache write failed for bot=%s", bot_id, exc_info=True)


# ── Helpers ────────────────────────────────────────────────────────────────


def _current_queue_size(bot_id: int, db_session: Session) -> int:
    """Number of visitors currently waiting in this bot's queue."""
    count = db_session.execute(
        select(func.count(LiveChatQueueEntry.id)).where(
            LiveChatQueueEntry.bot_id == bot_id,
            LiveChatQueueEntry.dequeued_at.is_(None),
        )
    ).scalar_one()
    return int(count or 0)


def _estimate_wait_seconds(
    position: int,
    online_operator_ids: set[int],
    db_session: Session,
) -> int:
    """Estimate seconds until this position reaches an operator.

    Bootstrap heuristic: assume 5 minutes average chat duration, distribute
    queue across all online operators. Real impl in v2 will use rolling
    7-day chat duration average. The number is intentionally a rough hint;
    the widget will show "longer than usual" copy if reality drifts.
    """
    _ = db_session  # Reserved for future rolling-average lookup
    operator_count = max(1, len(online_operator_ids))
    avg_chat_duration_seconds = 5 * 60
    # Position 1 means "next in line" — multiply by (position - 1) for prior queue
    waiting_chats_ahead = max(0, position - 1)
    return int((waiting_chats_ahead * avg_chat_duration_seconds) / operator_count)


# ── Business hours ─────────────────────────────────────────────────────────


# Bot.business_hours shape:
# {
#   "timezone": "Asia/Kolkata",
#   "mon": {"start": "09:00", "end": "17:00"},
#   "tue": {"start": "09:00", "end": "17:00"},
#   ...
#   "sun": null,                           # closed all day
# }
_WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _within_business_hours(business_hours: dict | None) -> bool:
    """True if the bot's configured business hours include "now".

    A null/empty config means 24/7 (no restriction). Per-day null means closed
    that day. The check happens in the configured timezone (defaults to UTC)
    so an admin in IST sees their workday consistently.
    """
    if not business_hours:
        return True  # No config = always available

    try:
        now = _now_in_timezone(business_hours.get("timezone"))
    except Exception:
        # Bad timezone string — fail open rather than locking the bot out
        logger.warning("Invalid business_hours timezone, falling back to 'always open'")
        return True

    weekday_key = _WEEKDAY_KEYS[now.weekday()]
    day_config = business_hours.get(weekday_key)
    if not day_config:
        return False  # Day not configured / explicitly closed

    try:
        start_str = day_config.get("start", "00:00")
        end_str = day_config.get("end", "23:59")
        start_h, start_m = map(int, start_str.split(":"))
        end_h, end_m = map(int, end_str.split(":"))
    except (ValueError, AttributeError):
        return True  # Malformed entry — fail open

    current_minutes = now.hour * 60 + now.minute
    start_minutes = start_h * 60 + start_m
    end_minutes = end_h * 60 + end_m

    # Handle ranges that cross midnight (e.g. 22:00 - 02:00 for late-night support)
    if end_minutes < start_minutes:
        return current_minutes >= start_minutes or current_minutes <= end_minutes
    return start_minutes <= current_minutes <= end_minutes


def _next_business_hour_iso(business_hours: dict | None) -> str | None:
    """Return ISO timestamp of the next time the bot opens. Used for
    "back at 9am tomorrow" copy in the offline form.

    Walks forward up to 7 days looking for the first open slot. Returns None
    if no day in the config has open hours (degenerate config — admin error).
    """
    if not business_hours:
        return None

    try:
        now = _now_in_timezone(business_hours.get("timezone"))
    except Exception:
        return None

    for day_offset in range(8):  # today + 7 days
        from datetime import timedelta

        candidate_date = (now + timedelta(days=day_offset)).date()
        weekday_key = _WEEKDAY_KEYS[candidate_date.weekday()]
        day_config = business_hours.get(weekday_key)
        if not day_config:
            continue

        try:
            start_str = day_config.get("start", "00:00")
            start_h, start_m = map(int, start_str.split(":"))
        except (ValueError, AttributeError):
            continue

        from datetime import time

        candidate_dt = datetime.combine(candidate_date, time(start_h, start_m), tzinfo=now.tzinfo)
        # For "today" we only count it if the open time is still in the future
        if candidate_dt > now:
            return candidate_dt.isoformat()

    return None


def _now_in_timezone(tz_name: str | None) -> datetime:
    """Return current datetime in the named timezone. Defaults to UTC."""
    if not tz_name:
        return datetime.now(UTC)
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(tz_name))
    except Exception:
        # zoneinfo raises on unknown names — caller treats this as "fail open"
        return datetime.now(UTC)
