"""Aggregations for the Journeys view under Analytics.

Reads ``chat_sessions.visitor_journey`` (JSONB) and produces three shapes
consumed by the admin dashboard:

1. Top pages, optionally scoped to a phase (pre|chat|post).
2. Paths that convert, for a given conversion event, the top pre-chat
   page sequences that preceded it, grouped and counted.
3. Post-chat destinations, for sessions where the visitor chatted, the
   top first-hop pages after chat close plus top full post-chat sequences.

All three are scoped by ``bot_id`` + a ``(since, until)`` date range and
return plain dicts ready for JSON serialization.

Aggregation runs in Python rather than JSONB SQL because the volumes
involved (per-bot, per-month) are modest and the query shapes are complex
enough that Python is clearer than layered CTEs. Add a pre-aggregated
materialized view later if a bot ever pushes this into the seconds range.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from datetime import datetime

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.db.models import ChatSession, LeadInfo

# Whitelisted conversion event names. Matches _JOURNEY_EVENTS in
# chat_routes.py minus the sentinel opens/closes. lead_captured is
# excluded from path attribution on purpose (it double-counts against
# handoff/demo forms that also collect email); it surfaces as a header
# metric only, via count_leads_captured().
CONVERSION_EVENTS: frozenset[str] = frozenset(
    {
        "meeting_booked",
        "handoff_requested",
        "offline_message_sent",
    }
)


def _fetch_journeys(db: Session, bot_id: int, since: datetime, until: datetime) -> list[list[dict]]:
    """Return the non-empty ``visitor_journey`` arrays for the window."""
    rows = db.execute(
        select(ChatSession.visitor_journey).where(
            and_(
                ChatSession.bot_id == bot_id,
                ChatSession.created_at >= since,
                ChatSession.created_at <= until,
                ChatSession.visitor_journey.isnot(None),
            )
        )
    ).all()
    return [row[0] for row in rows if row[0]]


def top_pages(
    db: Session,
    bot_id: int,
    since: datetime,
    until: datetime,
    phase: str | None = None,
    limit: int = 20,
) -> list[dict]:
    """Rank pages by distinct-session visits, optionally filtered by phase.

    Each returned row: ``{"path": "/pricing", "sessions": 42, "visits": 47}``
    where ``sessions`` is distinct-session count and ``visits`` is total
    entries (a session that landed on the same path twice counts twice
    for visits, once for sessions).
    """
    journeys = _fetch_journeys(db, bot_id, since, until)
    session_paths: Counter[str] = Counter()  # counts distinct sessions per path
    total_visits: Counter[str] = Counter()  # counts total entries per path
    for journey in journeys:
        seen_in_this_session: set[str] = set()
        for entry in journey:
            if phase and entry.get("phase") != phase:
                continue
            path = entry.get("path")
            if not path:
                continue
            total_visits[path] += 1
            if path not in seen_in_this_session:
                session_paths[path] += 1
                seen_in_this_session.add(path)
    return [
        {"path": path, "sessions": session_paths[path], "visits": total_visits[path]}
        for path, _ in session_paths.most_common(limit)
    ]


def paths_to_conversion(
    db: Session,
    bot_id: int,
    conversion_type: str,
    since: datetime,
    until: datetime,
    limit: int = 10,
    max_seq_len: int = 6,
) -> dict:
    """Top pre-chat page sequences that preceded a given conversion event.

    Returns a dict with ``conversion_type``, ``total_conversions`` (sessions
    where the event fired), and ``paths``, a list of
    ``{"sequence": [...], "sessions": N, "conversion_rate": F}`` rows.

    ``max_seq_len`` truncates long sequences from the head so noisy tails
    don't fragment counts (visitor A: /a/b/c/d/e/f → conv, visitor B:
    /x/b/c/d/e/f → conv should both be recognized as ending in the same
    /c/d/e/f pattern when max_seq_len=4). Set to 0 to keep full sequences.
    """
    if conversion_type not in CONVERSION_EVENTS:
        raise ValueError(f"Unknown conversion_type: {conversion_type!r}")

    journeys = _fetch_journeys(db, bot_id, since, until)
    total_sessions = len(journeys)
    if total_sessions == 0:
        return {
            "conversion_type": conversion_type,
            "total_conversions": 0,
            "total_sessions": 0,
            "paths": [],
        }

    sequence_counter: Counter[tuple[str, ...]] = Counter()
    total_conversions = 0

    for journey in journeys:
        converted = any(entry.get("event") == conversion_type for entry in journey)
        if not converted:
            continue
        total_conversions += 1
        pre_paths: list[str] = []
        for entry in journey:
            if entry.get("phase") != "pre":
                continue
            path = entry.get("path")
            if path and (not pre_paths or pre_paths[-1] != path):
                pre_paths.append(path)
        if not pre_paths:
            continue
        seq = tuple(pre_paths[-max_seq_len:]) if max_seq_len > 0 else tuple(pre_paths)
        sequence_counter[seq] += 1

    paths = [
        {
            "sequence": list(seq),
            "sessions": count,
            "conversion_rate": round(count / total_sessions, 4) if total_sessions else 0.0,
        }
        for seq, count in sequence_counter.most_common(limit)
    ]
    return {
        "conversion_type": conversion_type,
        "total_conversions": total_conversions,
        "total_sessions": total_sessions,
        "paths": paths,
    }


def post_chat_destinations(
    db: Session,
    bot_id: int,
    since: datetime,
    until: datetime,
    limit: int = 10,
) -> dict:
    """Where visitors go after the chat closes.

    Returns three aggregates:
    * ``first_hops``, the first post-phase page per session, ranked.
    * ``all_hops``. Every post-phase page visit, counted regardless of
      whether it was the first hop or a later one. Powers the
      destination column so pages visitors reached mid-post-chat-
      journey (e.g. ``chat → /about → /contact``) aren't invisible.
      Sessions is the number of DISTINCT sessions in which the page
      appeared as a post-chat stop.
    * ``full_sequences``. Top ordered post-phase paths, same shape
      as paths_to_conversion.
    """
    journeys = _fetch_journeys(db, bot_id, since, until)

    first_hop_counter: Counter[str] = Counter()
    all_hop_counter: Counter[str] = Counter()
    sequence_counter: Counter[tuple[str, ...]] = Counter()
    sessions_with_post = 0

    for journey in journeys:
        post_paths: list[str] = []
        for entry in journey:
            if entry.get("phase") != "post":
                continue
            path = entry.get("path")
            if path and (not post_paths or post_paths[-1] != path):
                post_paths.append(path)
        if not post_paths:
            continue
        sessions_with_post += 1
        first_hop_counter[post_paths[0]] += 1
        # ``all_hops`` counts DISTINCT sessions per path, a visitor who
        # touched /about twice in their post-chat sequence counts once,
        # not twice, matching how ``first_hops`` and ``top_pages``
        # denominate session-share.
        for unique_path in set(post_paths):
            all_hop_counter[unique_path] += 1
        sequence_counter[tuple(post_paths)] += 1

    return {
        "sessions_with_post_chat_activity": sessions_with_post,
        "first_hops": [{"path": path, "sessions": count} for path, count in first_hop_counter.most_common(limit)],
        "all_hops": [{"path": path, "sessions": count} for path, count in all_hop_counter.most_common(limit)],
        "full_sequences": [
            {"sequence": list(seq), "sessions": count} for seq, count in sequence_counter.most_common(limit)
        ],
    }


def top_pre_chat_sequences(
    db: Session,
    bot_id: int,
    since: datetime,
    until: datetime,
    limit: int = 5,
    max_seq_len: int = 8,
) -> dict:
    """Top pre-chat page sequences across ALL sessions, converted or not.

    Companion to :func:`paths_to_conversion` which only surfaces sequences
    that ended in a specific conversion event. This one covers every
    session with any pre-phase browsing, so the visual flow diagram in
    the admin can chain the "Home → About → Contact" journeys visitors
    took before they opened the chatbot.

    Consecutive same-path entries collapse to one (SPA hash changes or
    quick refires shouldn't fragment a sequence). ``max_seq_len`` clips
    long sequences from the head so noisy exploratory tails don't
    fragment counts. Visitors A: ``/a/b/c/d`` and B: ``/x/b/c/d`` both
    collapse to ``/b/c/d`` when ``max_seq_len=3``. Set to 0 to keep the
    full sequence.
    """
    journeys = _fetch_journeys(db, bot_id, since, until)
    total_sessions = len(journeys)
    if total_sessions == 0:
        return {"total_sessions": 0, "sequences": []}

    # Group by pre-chat pattern; also collect the post-chat sequence
    # each session took, so the flow diagram can render a matching
    # post-chain to the right of the chatbot per row. The "most
    # common" post_sequence per pattern wins, one representative
    # continuation per row keeps the diagram legible.
    grouped: dict[tuple[str, ...], dict] = {}
    sessions_with_pre = 0
    for journey in journeys:
        pre_paths: list[str] = []
        post_paths: list[str] = []
        for entry in journey:
            phase = entry.get("phase")
            path = entry.get("path")
            if not path:
                continue
            if phase == "pre" and (not pre_paths or pre_paths[-1] != path):
                pre_paths.append(path)
            elif phase == "post" and (not post_paths or post_paths[-1] != path):
                post_paths.append(path)
        if not pre_paths:
            continue
        sessions_with_pre += 1
        pre_key = tuple(pre_paths[-max_seq_len:]) if max_seq_len > 0 else tuple(pre_paths)
        bucket = grouped.setdefault(pre_key, {"sessions": 0, "post_counter": Counter()})
        bucket["sessions"] += 1
        if post_paths:
            post_key = tuple(post_paths[-max_seq_len:]) if max_seq_len > 0 else tuple(post_paths)
            bucket["post_counter"][post_key] += 1

    ranked = sorted(grouped.items(), key=lambda kv: kv[1]["sessions"], reverse=True)[:limit]

    def _top_post(counter: Counter[tuple[str, ...]]) -> tuple[list[str], int]:
        """Winning post-sequence for a pre-pattern, WITH its own session count.

        Returning the count is what lets the diagram label post-cards with
        the number of sessions that actually took that continuation, not
        the total session count of the pre-pattern, which vastly overstates
        how many visitors reached each post page.
        """
        if not counter:
            return [], 0
        top_seq, top_count = counter.most_common(1)[0]
        return list(top_seq), top_count

    sequences_out: list[dict] = []
    for pre_key, bucket in ranked:
        post_seq, post_count = _top_post(bucket["post_counter"])
        sequences_out.append(
            {
                "sequence": list(pre_key),
                "post_sequence": post_seq,
                "post_sessions": post_count,
                "sessions": bucket["sessions"],
            }
        )

    return {
        "total_sessions": total_sessions,
        "sessions_with_pre_chat": sessions_with_pre,
        "sequences": sequences_out,
    }


def summary_counts(db: Session, bot_id: int, since: datetime, until: datetime) -> dict:
    """Header-row totals shown above the three sections in the UI.

    Returns per-conversion session counts plus total leads captured. Lead
    capture is deliberately a separate metric (not folded into conversion
    attribution) because it double-counts against demo/handoff forms.
    """
    journeys = _fetch_journeys(db, bot_id, since, until)

    conversion_counts: Counter[str] = Counter()
    # Partition every journey into exactly one outcome bucket so the UI's
    # right-hand column reconciles with sessions_with_journey:
    #   converted  → counted per event in conversion_counts
    #   browsed    → no conversion event but at least one post-phase page
    #   no_activity→ no conversion event AND no post-phase page (drop-off)
    # Both remainder buckets are counted directly (not by subtraction):
    # subtracting (conversions + post-activity) from the total
    # double-counts any session that BOTH converted AND kept browsing,
    # which skewed drop-off low. A session is counted once here.
    sessions_no_activity = 0
    sessions_browsed_no_conversion = 0
    for journey in journeys:
        seen_events: set[str] = set()
        has_post = False
        for entry in journey:
            event = entry.get("event")
            if event in CONVERSION_EVENTS and event not in seen_events:
                conversion_counts[event] += 1
                seen_events.add(event)
            if not has_post and entry.get("phase") == "post" and entry.get("path"):
                has_post = True
        if not seen_events:
            if has_post:
                sessions_browsed_no_conversion += 1
            else:
                sessions_no_activity += 1

    # ``count()`` in SQL, not ``len()`` over hydrated ORM rows: the header only
    # ever needed the number, and materialising every lead of the month to
    # measure it costs a full row fetch plus an identity-map insert apiece.
    leads_captured = (
        db.execute(
            select(func.count(LeadInfo.id)).where(
                and_(
                    LeadInfo.bot_id == bot_id,
                    LeadInfo.created_at >= since,
                    LeadInfo.created_at <= until,
                )
            )
        ).scalar()
        or 0
    )

    return {
        "sessions_with_journey": len(journeys),
        "meeting_booked": conversion_counts.get("meeting_booked", 0),
        "handoff_requested": conversion_counts.get("handoff_requested", 0),
        "offline_message_sent": conversion_counts.get("offline_message_sent", 0),
        "sessions_no_activity": sessions_no_activity,
        "sessions_browsed_no_conversion": sessions_browsed_no_conversion,
        "leads_captured": leads_captured,
    }


def _iter_events(journeys: Iterable[list[dict]]) -> Iterable[dict]:
    """Flatten journeys into a stream of entries (test/debug helper)."""
    for journey in journeys:
        yield from journey
