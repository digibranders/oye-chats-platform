"""Operator presence tracking — Redis-backed heartbeat with DB fallback.

The presence layer answers two questions for the rest of the live-chat stack:

1. *Is operator X currently reachable?* — used by the routing service to filter
   candidates, by the availability resolver to compute states like
   ``all_offline``, and by the admin Support page to render the live status pill.

2. *Which operators in workspace Y are reachable?* — used by the routing service
   to pick the best candidate and by the availability resolver to short-circuit
   to ``no_operators`` / ``all_offline`` without scanning capacity.

**Why Redis, not Postgres.** Heartbeats fire every 30s from every connected
operator WebSocket. With 50 connected operators that's 100 writes per minute to
the heartbeat column — pointless I/O on the primary DB. Redis with a 60s TTL
solves the same problem at constant cost and gives us O(1) lookups.

**Why also Postgres.** Two reasons. (1) The existing ``Operator.last_seen_at``
column is the analytics-friendly source of truth — we keep it for "last seen 3h
ago" admin UX. (2) If Redis is down we still want live chat to work in degraded
mode — ``is_online(...)`` falls back to ``last_seen_at`` within a generous
window so a Redis blip doesn't take live chat offline.

**Failure mode.** Every method in this module is best-effort. A Redis outage
must NOT crash the WebSocket handler — it must silently degrade to "treat the
operator as online if their connection is still open" (handled by callers
checking ``ConnectionManager.operator_connections`` as a secondary signal).
"""

from __future__ import annotations

import contextlib
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.cache import PREFIX, get_redis
from app.db.models import ChatSession, Operator

logger = logging.getLogger(__name__)


# ── Constants ──────────────────────────────────────────────────────────────

# Heartbeat key lives for 60s — operator must refresh every ≤30s to stay online.
# Two missed heartbeats (60s gap) and they fall off the online roster.
PRESENCE_TTL_SECONDS = 60

# DB-fallback window when Redis is unavailable: treat any operator whose
# ``last_seen_at`` is within this many seconds as "probably online". Wider than
# Redis TTL because the DB column updates less frequently (every heartbeat
# attempts a Redis write, only some succeed and bubble to DB).
DB_FALLBACK_FRESHNESS_SECONDS = 120


# ── Key builders ───────────────────────────────────────────────────────────


def _online_key(operator_id: int) -> str:
    """Per-operator online flag (TTL ${PRESENCE_TTL_SECONDS}s)."""
    return f"{PREFIX}operator:online:{operator_id}"


def _workspace_set_key(client_id: int) -> str:
    """Redis set of online operator IDs for a workspace. Cheaper than scanning."""
    return f"{PREFIX}workspace:online_operators:{client_id}"


# ── Public API ─────────────────────────────────────────────────────────────


def mark_online(operator_id: int, client_id: int) -> None:
    """Stamp this operator as online — call on every heartbeat.

    Writes both the per-operator TTL key and the workspace set membership.
    The workspace set membership has no TTL on its own (Redis sets don't
    support per-member TTL) — the periodic ``prune_stale_members`` task and
    the explicit ``mark_offline`` call keep it consistent.
    """
    client = get_redis()
    if client is None:
        # Redis unavailable — DB fallback fires inside is_online().
        return
    try:
        # SETEX sets value + TTL atomically. The value is a sentinel timestamp
        # we can read back for "online since" diagnostics.
        client.setex(_online_key(operator_id), PRESENCE_TTL_SECONDS, datetime.now(UTC).isoformat())
        client.sadd(_workspace_set_key(client_id), str(operator_id))
    except Exception:
        # Heartbeat failures are silent — the WebSocket connection itself
        # already indicates the operator is reachable.
        logger.debug("Presence mark_online failed for operator=%s", operator_id, exc_info=True)


def mark_offline(operator_id: int, client_id: int) -> None:
    """Explicitly remove this operator from the online roster.

    Called when the operator WebSocket disconnects with no grace period
    pending, when the grace period expires, or when the admin manually
    revokes the operator's access.
    """
    client = get_redis()
    if client is None:
        return
    try:
        client.delete(_online_key(operator_id))
        client.srem(_workspace_set_key(client_id), str(operator_id))
    except Exception:
        logger.debug("Presence mark_offline failed for operator=%s", operator_id, exc_info=True)


def is_online(operator_id: int, *, db_session: Session | None = None) -> bool:
    """Return ``True`` if the operator is currently reachable.

    Checks Redis first; falls back to ``Operator.last_seen_at`` within the
    DB freshness window if Redis is unavailable. The DB fallback prevents a
    Redis outage from collapsing live chat for the whole platform.
    """
    redis_client = get_redis()
    if redis_client is not None:
        try:
            if redis_client.exists(_online_key(operator_id)):
                return True
            # Key absent — operator went offline cleanly OR Redis just doesn't
            # have it cached. Fall through to DB check rather than trusting
            # absence as proof of offline.
        except Exception:
            logger.debug("Presence is_online Redis check failed", exc_info=True)

    # Redis says "not present" — verify against DB. If Operator.last_seen_at
    # is recent enough, treat as online. This handles the cold-start case
    # where Redis is fresh but the operator's heartbeat hasn't fired yet.
    if db_session is None:
        return False

    operator = db_session.get(Operator, operator_id)
    if operator is None or operator.last_seen_at is None:
        return False

    threshold = datetime.now(UTC) - timedelta(seconds=DB_FALLBACK_FRESHNESS_SECONDS)
    last_seen = operator.last_seen_at
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=UTC)
    return last_seen >= threshold


def get_online_operator_ids(client_id: int) -> set[int]:
    """Return the set of online operator IDs for a workspace.

    Reads from the Redis workspace set in a single SMEMBERS call (O(N) where
    N = number of online operators, typically <10). Then double-checks each
    against the per-operator TTL key so stale set entries (race condition
    between TTL expiry and srem) don't return false positives.
    """
    redis_client = get_redis()
    if redis_client is None:
        return set()
    try:
        candidates = redis_client.smembers(_workspace_set_key(client_id))
        if not candidates:
            return set()

        # Validate each candidate has a live TTL key. Use a pipeline for one
        # round-trip regardless of how many candidates there are.
        candidate_ids = [int(c) for c in candidates]
        pipe = redis_client.pipeline()
        for op_id in candidate_ids:
            pipe.exists(_online_key(op_id))
        results = pipe.execute()

        online = {op_id for op_id, exists in zip(candidate_ids, results, strict=True) if exists}

        # Clean up stale set members — they had TTL expire but weren't srem'd.
        # This is the self-healing path so the set doesn't grow unbounded.
        stale = set(candidate_ids) - online
        if stale:
            redis_client.srem(_workspace_set_key(client_id), *[str(s) for s in stale])

        return online
    except Exception:
        logger.debug("get_online_operator_ids failed for client=%s", client_id, exc_info=True)
        return set()


def get_online_operators_with_capacity(client_id: int, db_session: Session) -> list[Operator]:
    """Return online operators in this workspace who can accept another chat.

    Filters by: is_active, is_accepting_chats, online (presence), and active
    chat count < ``max_concurrent_chats``. Returned list is the candidate
    pool the routing service picks from.
    """
    online_ids = get_online_operator_ids(client_id)
    if not online_ids:
        # Redis miss or genuine zero — fall through to a DB-driven candidate
        # list. Slower but correct when Redis is down.
        rows = (
            db_session.execute(
                select(Operator).where(
                    Operator.client_id == client_id,
                    Operator.is_active.is_(True),
                    Operator.is_accepting_chats.is_(True),
                    Operator.is_online.is_(True),
                )
            )
            .scalars()
            .all()
        )
        candidates = list(rows)
    else:
        rows = (
            db_session.execute(
                select(Operator).where(
                    Operator.id.in_(online_ids),
                    Operator.is_active.is_(True),
                    Operator.is_accepting_chats.is_(True),
                )
            )
            .scalars()
            .all()
        )
        candidates = list(rows)

    if not candidates:
        return []

    # Count active chats per candidate in one query — avoids N+1.
    active_counts: dict[int, int] = dict(
        db_session.execute(
            select(ChatSession.assigned_operator_id, func.count(ChatSession.id))
            .where(
                ChatSession.assigned_operator_id.in_([op.id for op in candidates]),
                ChatSession.status == "live",
            )
            .group_by(ChatSession.assigned_operator_id)
        ).all()
    )

    return [op for op in candidates if active_counts.get(op.id, 0) < (op.max_concurrent_chats or 5)]


def get_active_chat_count(operator_id: int, db_session: Session) -> int:
    """How many live chats this operator is currently handling.

    Used by the least-busy routing strategy to break ties between equally
    available operators.
    """
    count = db_session.execute(
        select(func.count(ChatSession.id)).where(
            ChatSession.assigned_operator_id == operator_id,
            ChatSession.status == "live",
        )
    ).scalar_one()
    return int(count or 0)


def touch_last_seen(operator_id: int, db_session: Session) -> None:
    """Update ``Operator.last_seen_at`` in DB — best-effort, never raises.

    Called less frequently than Redis heartbeats (every ~5 heartbeats / 2-3
    minutes) so we don't hammer Postgres while still keeping a DB-side trail
    for analytics and Redis-outage fallback. Callers can rate-limit this with
    their own cadence; the function itself does no rate limiting.
    """
    try:
        operator = db_session.get(Operator, operator_id)
        if operator is None:
            return
        operator.last_seen_at = datetime.now(UTC)
        db_session.commit()
    except Exception:
        logger.debug("touch_last_seen failed for operator=%s", operator_id, exc_info=True)
        with contextlib.suppress(Exception):
            db_session.rollback()


def set_accepting_chats(operator_id: int, accepting: bool, db_session: Session) -> bool:
    """Manual DND toggle. Returns True on success, False on operator-not-found."""
    operator = db_session.get(Operator, operator_id)
    if operator is None:
        return False
    operator.is_accepting_chats = bool(accepting)
    db_session.commit()
    return True
