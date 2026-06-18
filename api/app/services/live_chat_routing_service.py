"""Live chat routing — pick the best operator for the next chat.

The routing service has exactly one job: given a workspace and a chat session
that needs a human, return the operator who should receive it. Everything
else (notifying the operator, updating session status, removing from queue)
is the WebSocket handler's responsibility.

## Strategies

Customers can pick from three routing strategies via
``bot.live_chat_routing_strategy``:

* ``least_busy`` (default) — pick the operator with the fewest active chats.
  Ties broken by a round-robin cursor so the same operator doesn't always win
  when everyone has zero active chats. Best for evenly distributing load.

* ``round_robin`` — strict cursor advance regardless of load. Useful when
  customers want predictable fairness over throughput.

* ``first_available`` — return the first online+capacity operator by ID.
  Simplest and cheapest; effectively round-robin without the cursor. Mostly
  useful for single-operator workspaces where the choice doesn't matter.

The selection is intentionally synchronous and short — even with 100 online
operators, the O(N) capacity check is microseconds. We don't try to cache
"the next operator" because operator state changes faster than any cache TTL
worth maintaining.

## Why no department routing yet

The spec ships single-pool routing first. Department-aware routing is a v2
feature (pre-chat form picks Sales/Support/Billing → only operators in that
department are candidates). The current code path doesn't filter by
department but the data model supports it — adding the filter is a one-line
change once the visitor UI exists.
"""

from __future__ import annotations

import contextlib
import logging

from sqlalchemy.orm import Session

from app.core.cache import PREFIX, get_redis
from app.db.models import Bot, Operator
from app.services import operator_presence_service as presence

logger = logging.getLogger(__name__)


# ── Cursor state (Redis) ───────────────────────────────────────────────────


# Round-robin cursor key per bot. Stores the last-assigned operator ID so the
# next assignment picks the operator immediately after in sorted order.
def _rr_cursor_key(bot_id: int) -> str:
    return f"{PREFIX}live_chat:rr_cursor:{bot_id}"


def _read_rr_cursor(bot_id: int) -> int | None:
    client = get_redis()
    if client is None:
        return None
    try:
        raw = client.get(_rr_cursor_key(bot_id))
        return int(raw) if raw is not None else None
    except Exception:
        return None


def _write_rr_cursor(bot_id: int, operator_id: int) -> None:
    client = get_redis()
    if client is None:
        return
    # 1-day TTL so a dormant bot doesn't accumulate stale cursors. Failures
    # here are non-fatal — routing falls back to fresh-cursor selection.
    with contextlib.suppress(Exception):
        client.setex(_rr_cursor_key(bot_id), 86400, str(operator_id))


# ── Public API ─────────────────────────────────────────────────────────────


def select_operator(bot: Bot, db_session: Session) -> Operator | None:
    """Return the operator who should receive the next chat for this bot.

    Returns None if no operator is currently routable. Callers must treat
    this as the "ALL_BUSY" or "ALL_OFFLINE" signal and either enqueue the
    visitor or fall back to the offline form.

    This is deliberately read-only: it does not mark the operator as
    "assigned", does not update any state, does not send notifications.
    Callers chain it with their own assignment + WebSocket notification logic.
    """
    candidates = presence.get_online_operators_with_capacity(bot.client_id, db_session)
    if not candidates:
        return None

    strategy = (bot.live_chat_routing_strategy or "least_busy").lower()

    if strategy == "round_robin":
        chosen = _round_robin(candidates, bot.id)
    elif strategy == "first_available":
        chosen = _first_available(candidates)
    else:  # "least_busy" — default
        chosen = _least_busy(candidates, bot.id, db_session)

    if chosen is not None:
        _write_rr_cursor(bot.id, chosen.id)

    logger.info(
        "Live chat routing: bot=%s strategy=%s chose operator=%s out of %d candidates",
        bot.id,
        strategy,
        chosen.id if chosen else None,
        len(candidates),
    )
    return chosen


# ── Strategy implementations ───────────────────────────────────────────────


def _least_busy(candidates: list[Operator], bot_id: int, db_session: Session) -> Operator | None:
    """Pick the operator with the fewest active chats. Ties broken by
    round-robin cursor so distribution stays fair across zero-load periods.
    """
    if not candidates:
        return None

    # Get active chat count per candidate in a single query (avoids N+1).
    chat_counts: dict[int, int] = {}
    for op in candidates:
        chat_counts[op.id] = presence.get_active_chat_count(op.id, db_session)

    min_count = min(chat_counts.values())
    least_busy_pool = [op for op in candidates if chat_counts[op.id] == min_count]

    if len(least_busy_pool) == 1:
        return least_busy_pool[0]

    # Tie — apply round-robin fallback within the tied subset
    return _round_robin(least_busy_pool, bot_id)


def _round_robin(candidates: list[Operator], bot_id: int) -> Operator | None:
    """Pick the operator whose ID is the smallest greater than the last cursor.
    Wraps to the smallest ID if cursor exceeds all candidates.
    """
    if not candidates:
        return None

    sorted_ops = sorted(candidates, key=lambda o: o.id)
    cursor = _read_rr_cursor(bot_id)
    if cursor is None:
        return sorted_ops[0]

    for op in sorted_ops:
        if op.id > cursor:
            return op

    # Cursor was at or past the last candidate — wrap to the front
    return sorted_ops[0]


def _first_available(candidates: list[Operator]) -> Operator | None:
    """Return the lowest-ID online operator with capacity. Trivial and cheap."""
    if not candidates:
        return None
    return min(candidates, key=lambda o: o.id)
