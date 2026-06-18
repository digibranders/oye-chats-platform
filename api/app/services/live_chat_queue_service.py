"""Live chat queue — FIFO waiting line backed by Postgres.

Why Postgres and not pure Redis: the queue is a low-volume, high-consequence
data structure. A handful of visitors per bot at any time, but losing one to
a Redis flush means a real customer abandoned. Persistence in Postgres lets
us recover after restarts and gives the admin a queryable history for the
"who waited how long" admin analytics in v2.

Redis is used as a thin coordination layer: a per-bot SET of waiting session
IDs for O(1) "is this session already queued?" checks during enqueue. The
Postgres row is the source of truth; Redis is the index.

## Mechanics

- ``enqueue`` appends an entry, returns position (1-indexed).
- ``dequeue_next`` pops the FIFO head and marks the previous tail entries
  as still waiting — called by the routing service when an operator frees up.
- ``timeout_expired`` walks dequeued_at-null entries that have aged past
  the bot's ``live_chat_queue_timeout_seconds`` and triggers fallback.
- ``abandon`` marks a single entry as visitor-disconnected.

All position numbers are computed at query time (``ROW_NUMBER() OVER (...)``)
rather than stored as a column we have to keep dense. This avoids the
"position renumbering" problem when entries leave the middle of the queue.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import and_, func, select, update
from sqlalchemy.orm import Session

from app.db.models import ChatSession, LiveChatQueueEntry
from app.services import live_chat_availability_service as availability

logger = logging.getLogger(__name__)


# ── Data types ─────────────────────────────────────────────────────────────


@dataclass
class QueueEnqueueResult:
    """Returned by enqueue() — tells the caller what happened."""

    entry_id: int
    position: int
    success: bool = True


# ── Dequeue reason constants ───────────────────────────────────────────────

REASON_ASSIGNED = "assigned"  # Operator picked up the chat
REASON_TIMEOUT = "timeout"  # Visitor waited past queue_timeout_seconds
REASON_ABANDONED = "abandoned"  # Visitor closed widget / disconnected
REASON_BOT_RETURNED = "bot_returned"  # Visitor chose to return to bot conversation


# ── Public API ─────────────────────────────────────────────────────────────


def enqueue(session_id: str, bot_id: int, db_session: Session) -> QueueEnqueueResult:
    """Add a chat session to the FIFO queue.

    Position is computed AFTER insert so it reflects true ordering even
    under concurrent enqueues. Caller is responsible for checking
    ``LiveChatAvailability.state != QUEUE_FULL`` before calling — this
    function doesn't double-check (would defeat the resolver's caching).
    """
    # Guard against double-enqueue if the same visitor clicks twice
    existing = db_session.execute(
        select(LiveChatQueueEntry).where(
            LiveChatQueueEntry.session_id == session_id,
            LiveChatQueueEntry.dequeued_at.is_(None),
        )
    ).scalar_one_or_none()
    if existing is not None:
        position = get_position(session_id, db_session)
        return QueueEnqueueResult(entry_id=existing.id, position=position)

    # Position assigned at insert time = current waiting count + 1.
    # Subsequent enqueues see the updated count; queries always compute
    # position fresh via _compute_positions() rather than trusting this value.
    current_size = db_session.execute(
        select(func.count(LiveChatQueueEntry.id)).where(
            LiveChatQueueEntry.bot_id == bot_id,
            LiveChatQueueEntry.dequeued_at.is_(None),
        )
    ).scalar_one()

    entry = LiveChatQueueEntry(
        session_id=session_id,
        bot_id=bot_id,
        position=int(current_size or 0) + 1,
    )
    db_session.add(entry)
    db_session.commit()
    db_session.refresh(entry)

    # Mark session as waiting so the existing ConnectionManager picks it up
    chat_session = db_session.get(ChatSession, session_id)
    if chat_session is not None and chat_session.status != "waiting":
        chat_session.status = "waiting"
        db_session.commit()

    # Bust the availability cache — the queue size just changed.
    availability.invalidate(bot_id)

    logger.info(
        "Live chat queue: session=%s bot=%s enqueued at position=%s",
        session_id,
        bot_id,
        entry.position,
    )

    return QueueEnqueueResult(entry_id=entry.id, position=entry.position)


def dequeue_next(bot_id: int, db_session: Session) -> ChatSession | None:
    """Pop the head of the queue (oldest waiting entry). Returns the
    ``ChatSession`` ready for routing, or None if the queue is empty.

    Called by the routing service when an operator becomes available.
    Marks the entry as ``assigned`` so it's excluded from future scans.
    """
    head = db_session.execute(
        select(LiveChatQueueEntry)
        .where(
            LiveChatQueueEntry.bot_id == bot_id,
            LiveChatQueueEntry.dequeued_at.is_(None),
        )
        .order_by(LiveChatQueueEntry.enqueued_at.asc())
        .limit(1)
    ).scalar_one_or_none()

    if head is None:
        return None

    head.dequeued_at = datetime.now(UTC)
    head.dequeue_reason = REASON_ASSIGNED

    chat_session = db_session.get(ChatSession, head.session_id)
    db_session.commit()

    availability.invalidate(bot_id)

    logger.info("Live chat queue: dequeued session=%s from bot=%s", head.session_id, bot_id)
    return chat_session


def get_position(session_id: str, db_session: Session) -> int:
    """Compute the current 1-indexed position of this session in its queue.

    Returns 0 if the session is not currently queued (already assigned,
    abandoned, or never enqueued).
    """
    entry = db_session.execute(
        select(LiveChatQueueEntry).where(
            LiveChatQueueEntry.session_id == session_id,
            LiveChatQueueEntry.dequeued_at.is_(None),
        )
    ).scalar_one_or_none()

    if entry is None:
        return 0

    ahead = db_session.execute(
        select(func.count(LiveChatQueueEntry.id)).where(
            LiveChatQueueEntry.bot_id == entry.bot_id,
            LiveChatQueueEntry.dequeued_at.is_(None),
            LiveChatQueueEntry.enqueued_at < entry.enqueued_at,
        )
    ).scalar_one()

    return int(ahead or 0) + 1


def abandon(session_id: str, db_session: Session) -> bool:
    """Mark this session's queue entry as abandoned (visitor left).

    Returns True if an entry was updated, False if there was nothing to
    abandon (already dequeued or never queued).
    """
    entry = db_session.execute(
        select(LiveChatQueueEntry).where(
            LiveChatQueueEntry.session_id == session_id,
            LiveChatQueueEntry.dequeued_at.is_(None),
        )
    ).scalar_one_or_none()

    if entry is None:
        return False

    entry.dequeued_at = datetime.now(UTC)
    entry.dequeue_reason = REASON_ABANDONED
    bot_id = entry.bot_id
    db_session.commit()

    availability.invalidate(bot_id)

    logger.info("Live chat queue: session=%s abandoned", session_id)
    return True


def find_timeouts(bot_id: int, timeout_seconds: int, db_session: Session) -> list[LiveChatQueueEntry]:
    """Return queue entries that have waited longer than ``timeout_seconds``.

    Caller (the timeout cron / WebSocket handler) is responsible for taking
    action — typically sending the visitor a "your wait timed out, would you
    like to leave a message" prompt and dequeuing with REASON_TIMEOUT.
    """
    from datetime import timedelta

    cutoff = datetime.now(UTC) - timedelta(seconds=timeout_seconds)

    return list(
        db_session.execute(
            select(LiveChatQueueEntry).where(
                LiveChatQueueEntry.bot_id == bot_id,
                LiveChatQueueEntry.dequeued_at.is_(None),
                LiveChatQueueEntry.enqueued_at <= cutoff,
            )
        )
        .scalars()
        .all()
    )


def mark_timeout(session_id: str, db_session: Session) -> bool:
    """Dequeue with REASON_TIMEOUT. Returns True if an entry was updated."""
    result = db_session.execute(
        update(LiveChatQueueEntry)
        .where(
            and_(
                LiveChatQueueEntry.session_id == session_id,
                LiveChatQueueEntry.dequeued_at.is_(None),
            )
        )
        .values(dequeued_at=datetime.now(UTC), dequeue_reason=REASON_TIMEOUT)
    )
    db_session.commit()

    if result.rowcount > 0:
        # Look up bot_id to invalidate cache
        entry = db_session.execute(
            select(LiveChatQueueEntry).where(LiveChatQueueEntry.session_id == session_id).limit(1)
        ).scalar_one_or_none()
        if entry is not None:
            availability.invalidate(entry.bot_id)
        logger.info("Live chat queue: session=%s timed out", session_id)
        return True
    return False


def get_queue_snapshot(bot_id: int, db_session: Session) -> list[dict]:
    """Admin-facing list of current queue entries with position + wait time.

    Used by the Support page status pill and the admin queue inspector.
    Returns a lightweight list of dicts rather than ORM objects so it can
    be JSON-serialized for the status WebSocket directly.
    """
    entries = (
        db_session.execute(
            select(LiveChatQueueEntry)
            .where(
                LiveChatQueueEntry.bot_id == bot_id,
                LiveChatQueueEntry.dequeued_at.is_(None),
            )
            .order_by(LiveChatQueueEntry.enqueued_at.asc())
        )
        .scalars()
        .all()
    )

    now = datetime.now(UTC)
    snapshot = []
    for idx, entry in enumerate(entries, start=1):
        enqueued = entry.enqueued_at
        if enqueued.tzinfo is None:
            enqueued = enqueued.replace(tzinfo=UTC)
        snapshot.append(
            {
                "session_id": entry.session_id,
                "position": idx,
                "waiting_seconds": int((now - enqueued).total_seconds()),
                "enqueued_at": enqueued.isoformat(),
            }
        )
    return snapshot
