"""Lead management endpoints. View, filter, and export qualified leads."""

import csv
import io
import logging
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, func, or_, select, update
from sqlalchemy.exc import IntegrityError

from app.api.auth import get_current_client_or_operator
from app.config import API_BASE_URL
from app.core.csv_safety import csv_safe_row
from app.core.visitor_privacy import redact_visitor_ip
from app.db.models import BANTSignal, Bot, ChatMessage, ChatSession, EmailSuppression, LeadInfo
from app.db.session import get_session
from app.schemas.validators import EmailAddress, RowId, SearchTerm, SessionId
from app.services.email_design import esc, h1, p, shell
from app.services.email_service import send_email_async
from app.services.lead_service import build_lead_response
from app.services.plan_entitlements_service import (
    is_lead_intelligence_enabled,
    is_lead_source_attribution_enabled,
    is_leads_dashboard_enabled,
    is_visitor_intelligence_enabled_for_bot,
)
from app.services.unsubscribe_token import make_unsubscribe_token

logger = logging.getLogger(__name__)


def _require_leads_dashboard(auth: dict = Depends(get_current_client_or_operator)) -> None:
    """Router-level gate. Every plan reaches the Leads dashboard.

    Free included: the dashboard itself is open, and the paid boundary is
    the lead-intelligence layer (score / tier / BANT / location / export),
    enforced per-route via ``is_lead_intelligence_enabled``. Responses
    are stripped server-side for Free, and ``/export`` 403s. This
    dependency now only denies when the entitlements resolver fails
    (deny-by-default), keeping the surface closed when plan state is
    unknowable. Runs BEFORE every route in this router via
    ``dependencies=[]`` on the ``APIRouter``.
    """
    with get_session() as session:
        if not is_leads_dashboard_enabled(auth["client_id"], session):
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "feature_not_available",
                    "feature": "leads",
                    "message": (
                        "The leads dashboard is included on Starter and above. "
                        "Please upgrade your plan to access captured leads."
                    ),
                },
            )


# The four qualification tiers ``lead_service`` computes. Previously a bare
# ``str`` on the filter params: an unknown value matched no lead and returned
# an empty page, which reads identically to "you have no qualified leads".
LeadTier = Literal["unqualified", "mql", "sal", "sql"]

router = APIRouter(
    prefix="/leads",
    tags=["leads"],
    dependencies=[Depends(_require_leads_dashboard)],
)


def _resolve_client_bot_ids(session, auth: dict, bot_id: int | None) -> list[int]:
    """Return the list of bot IDs this caller can act on.

    Two boundaries, not one:

    * **Tenant.** Only bots owned by ``auth["client_id"]``, the workspace owner.
    * **Operator.** ``Operator.bot_id`` is a NOT NULL one-to-one binding, and
      for an operator ``auth["client_id"]`` is the workspace OWNER's id — so
      scoping on it alone hands an operator bound to bot A every bot in the
      workspace. The rest of the product already treats that binding as a hard
      boundary: ``bot_routes.list_bots`` filters to it because "operators must
      not see or switch to other bots in the workspace", and
      ``offline_message_routes.list_offline_messages`` scopes the visitor
      contact details it serves the same way. Leads are the widest of those
      three surfaces (name, email, phone, company, transcript, and a WRITE that
      silences a bot's follow-ups), so it gets the same rule.

    An explicit ``bot_id`` is verified against the resulting set, so a sibling
    bot's id in the URL is a 403 rather than an escape hatch. Absent (defensive
    only, the column is NOT NULL) an operator binding, the caller resolves to no
    bots at all — the same fail-closed answer ``list_bots`` gives.

    Not covered here: the owner's ``X-Acting-Role: operator`` self-operator hat,
    which ``list_bots`` and the offline-message list both honour. That one is an
    owner looking at their own workspace's data, so it is a UI-consistency gap
    rather than a boundary, and it needs the header threaded through each route.
    """
    client_bot_ids = list(session.execute(select(Bot.id).where(Bot.client_id == auth["client_id"])).scalars().all())

    if auth.get("type") == "operator":
        # Fall back to the entity attribute when the resolver's cached
        # ``bot_id`` isn't populated, mirroring ``list_bots`` / the
        # offline-message list.
        operator_bot_id = auth.get("bot_id") or getattr(auth.get("entity"), "bot_id", None)
        client_bot_ids = [b for b in client_bot_ids if b == operator_bot_id]

    if bot_id is None:
        return client_bot_ids
    if bot_id not in client_bot_ids:
        raise HTTPException(status_code=403, detail="Bot not found or access denied.")
    return [bot_id]


def _resolve_window(
    days: int | None, from_date: date | None, to_date: date | None
) -> tuple[datetime | None, datetime | None]:
    """The trailing-N-days preset and an explicit calendar range, as one
    ``(since, until)`` pair on ``created_at`` — never ``last_active_at``, see
    the note on the filter below.

    An explicit ``from_date``/``to_date`` wins over ``days`` when both somehow
    arrive: the UI's range control is one selection (a preset OR "Custom
    range"), so this only matters for a hand-built query string, and the more
    specific bound is the more likely intent. ``to_date`` is the last
    INCLUDED day, so its bound is that day's last microsecond, not its
    midnight — a naive ``<= to_date`` compares a `date` to a `datetime` and,
    worse, would drop every lead captured after midnight on the end day.
    """
    if from_date is not None or to_date is not None:
        if from_date is not None and to_date is not None and from_date > to_date:
            raise HTTPException(status_code=422, detail="from_date must not be after to_date.")
        since = datetime.combine(from_date, time.min, tzinfo=UTC) if from_date else None
        until = datetime.combine(to_date, time.max, tzinfo=UTC) if to_date else None
        return since, until
    if days is not None:
        return datetime.now(UTC) - timedelta(days=days), None
    return None, None


_DAYS_DESCRIPTION = "Restrict to leads captured in the trailing N days; omitted = all time."
_FROM_DATE_DESCRIPTION = "Custom range start (YYYY-MM-DD), inclusive. Wins over `days` when given."
_TO_DATE_DESCRIPTION = "Custom range end (YYYY-MM-DD), inclusive."


def _windowed(stmt, since: datetime | None, until: datetime | None):
    """Apply a `_resolve_window()` result to a `created_at`-filterable
    statement. One helper for both bounds, so a future caller cannot repeat
    the bug this one fixes: `lead_stats` applied `since` in three places and
    `until` in none of them, so `?to_date=` silently did nothing to any of
    the three figures it built."""
    if since is not None:
        stmt = stmt.where(ChatSession.created_at >= since)
    if until is not None:
        stmt = stmt.where(ChatSession.created_at <= until)
    return stmt


@router.get("")
def list_leads(
    bot_id: RowId | None = Query(None),
    tier: LeadTier | None = Query(None, description="unqualified|mql|sal|sql"),
    status: LeadTier | None = Query(None, description="backward-compat alias for tier"),
    min_score: int | None = Query(None, ge=0, le=100),
    days: int | None = Query(None, ge=1, le=365, description=_DAYS_DESCRIPTION),
    from_date: date | None = Query(None, description=_FROM_DATE_DESCRIPTION),
    to_date: date | None = Query(None, description=_TO_DATE_DESCRIPTION),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    auth: dict = Depends(get_current_client_or_operator),
):
    """List leads with BANT data, scores, and optional filters."""
    with get_session() as session:
        # The caller's bots: the workspace's for an owner, the ONE bound bot
        # for an operator. See ``_resolve_client_bot_ids``.
        bot_ids = _resolve_client_bot_ids(session, auth, bot_id)

        if not bot_ids:
            return {"leads": [], "total": 0, "page": page, "limit": limit}

        # Query sessions with message counts and optional lead info
        stmt = (
            select(ChatSession, func.count(ChatMessage.id).label("msg_count"))
            .outerjoin(ChatMessage, ChatMessage.session_id == ChatSession.id)
            .where(ChatSession.bot_id.in_(bot_ids))
            .group_by(ChatSession.id)
            .order_by(desc(ChatSession.last_active_at))
        )
        # `created_at`, not `last_active_at` — a lead captured 90 days ago
        # that a visitor reopened yesterday must not count as "captured in
        # the last 7 days" just because it is still active.
        stmt = _windowed(stmt, *_resolve_window(days, from_date, to_date))

        results = session.execute(stmt).all()

        bot_map: dict[int, Bot] = {}
        if bot_ids:
            bots = session.execute(select(Bot).where(Bot.id.in_(bot_ids))).scalars().all()
            bot_map = {bot.id: bot for bot in bots}

        # Batch-load all LeadInfo records for these sessions in a single query
        session_ids = [cs.id for cs, _ in results]
        lead_info_map: dict = {}
        if session_ids:
            lead_infos = session.execute(select(LeadInfo).where(LeadInfo.session_id.in_(session_ids))).scalars().all()
            lead_info_map = {li.session_id: li for li in lead_infos}

        attribution_enabled = is_lead_source_attribution_enabled(auth["client_id"], session)
        intelligence_enabled = is_lead_intelligence_enabled(auth["client_id"], session)
        # Visitor Intelligence resolves PER BOT, a workspace can hold a
        # Professional bot and a Free bot simultaneously, and the Free bot's
        # leads must not inherit the paid fields. Memoized per bot_id so a
        # 200-lead page still costs one entitlements lookup per bot, not per row.
        visitor_intel_by_bot: dict[int, bool] = {}

        def _visitor_intel_for(bot_id_: int | None) -> bool:
            if bot_id_ is None:
                return False
            if bot_id_ not in visitor_intel_by_bot:
                visitor_intel_by_bot[bot_id_] = is_visitor_intelligence_enabled_for_bot(bot_id_, session)
            return visitor_intel_by_bot[bot_id_]

        # Build leads with scores. Filters are Python-computed (score/tier not in DB)
        leads = []
        for chat_session, msg_count in results:
            lead = build_lead_response(
                chat_session,
                lead_info_map.get(chat_session.id),
                msg_count,
                bot=bot_map.get(chat_session.bot_id),
                include_attribution=attribution_enabled,
                include_intelligence=intelligence_enabled,
                include_visitor_intelligence=_visitor_intel_for(chat_session.bot_id),
            )

            # Apply filters (tier or legacy status param). Tier/score are part
            # of the paid intelligence layer, for Free the fields aren't in
            # the payload, so the filters are ignored rather than leaking the
            # qualification via a filterable side channel.
            if intelligence_enabled:
                effective_tier = tier or status
                if effective_tier and lead["tier"] != effective_tier:
                    continue
                if min_score is not None and lead["score"] < min_score:
                    continue

            leads.append(lead)

        total = len(leads)
        start = (page - 1) * limit
        paginated = leads[start : start + limit]

        return {"leads": paginated, "total": total, "page": page, "limit": limit}


def _with_contact_count(session, bot_ids: list[int], since, until) -> int:
    """Conversations that produced something you can follow up on.

    Distinct from ``total``, which counts CONVERSATIONS and is right for the
    leads list header — `/leads` returns every session, with contact details as
    enrichment. The onboarding checklist read that same number under a step
    called "Capture your first lead", so the step ticked the moment anyone said
    hello. Two numbers, because there are two questions.

    ``email OR phone``, never ``name``: a visitor who types "I'm Sam" has left
    nothing reachable. Empty strings are excluded because the capture form
    persists "" for a field the visitor skipped.
    """
    # Joined to ChatSession so `_windowed` filters on the CONVERSATION's date,
    # the same column `total` uses. Windowing on `LeadInfo.created_at` instead
    # would let the two figures describe different periods for the same request.
    stmt = _windowed(
        select(func.count(func.distinct(LeadInfo.session_id)))
        .select_from(LeadInfo)
        .join(ChatSession, ChatSession.id == LeadInfo.session_id)
        .where(
            LeadInfo.bot_id.in_(bot_ids),
            or_(
                func.trim(func.coalesce(LeadInfo.email, "")) != "",
                func.trim(func.coalesce(LeadInfo.phone, "")) != "",
            ),
        ),
        since,
        until,
    )
    return session.execute(stmt).scalar() or 0


@router.get("/stats")
def lead_stats(
    bot_id: RowId | None = Query(None),
    days: int | None = Query(None, ge=1, le=365, description=_DAYS_DESCRIPTION),
    from_date: date | None = Query(None, description=_FROM_DATE_DESCRIPTION),
    to_date: date | None = Query(None, description=_TO_DATE_DESCRIPTION),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Aggregate lead stats: total, unqualified, MQL, SAL, and SQL counts."""
    with get_session() as session:
        bot_ids = _resolve_client_bot_ids(session, auth, bot_id)
        # Every figure in the strip states the same window (`StatRow` requires
        # it), so the window narrows every count below it, not just the
        # headline total. See the identical `created_at` note in `list_leads`.
        since, until = _resolve_window(days, from_date, to_date)

        if not is_lead_intelligence_enabled(auth["client_id"], session):
            # Free plan: total + unread keep the list header and sidebar badge
            # working; the qualification aggregates (tier counts, avg score)
            # are the paid intelligence layer and are not computed at all.
            total = 0
            unread = 0
            if bot_ids:
                total_stmt = _windowed(
                    select(func.count(ChatSession.id)).where(ChatSession.bot_id.in_(bot_ids)), since, until
                )
                unread_stmt = _windowed(
                    select(func.count(ChatSession.id)).where(
                        ChatSession.bot_id.in_(bot_ids),
                        ChatSession.lead_viewed_at.is_(None),
                    ),
                    since,
                    until,
                )
                total = session.execute(total_stmt).scalar() or 0
                unread = session.execute(unread_stmt).scalar() or 0
            return {
                "total": total,
                "unread": unread,
                "with_contact": _with_contact_count(session, bot_ids, since, until) if bot_ids else 0,
            }

        sessions_stmt = _windowed(select(ChatSession).where(ChatSession.bot_id.in_(bot_ids)), since, until)
        sessions = session.execute(sessions_stmt).scalars().all()
        bots = session.execute(select(Bot).where(Bot.id.in_(bot_ids))).scalars().all() if bot_ids else []
        bot_map = {bot.id: bot for bot in bots}

        counts = {"unqualified": 0, "mql": 0, "sal": 0, "sql": 0}
        total_score = 0

        for s in sessions:
            lead = build_lead_response(s, None, bot=bot_map.get(s.bot_id))
            counts[lead["tier"]] += 1
            total_score += lead["score"]

        # Unread count drives the sidebar badge. Covered by the partial index
        # ix_chat_sessions_bot_id_lead_viewed_at (migration d4e5f6a7b8c9).
        unread = 0
        if bot_ids:
            unread_stmt = _windowed(
                select(func.count(ChatSession.id)).where(
                    ChatSession.bot_id.in_(bot_ids),
                    ChatSession.lead_viewed_at.is_(None),
                ),
                since,
                until,
            )
            unread = session.execute(unread_stmt).scalar() or 0

        total = len(sessions)
        return {
            "total": total,
            "unread": unread,
            # Conversations that left an email or a phone. `total` counts
            # conversations; these are two different questions and the setup
            # checklist was asking the second one with the first one's answer.
            "with_contact": _with_contact_count(session, bot_ids, since, until) if bot_ids else 0,
            **counts,
            # backward-compat aliases for frontend expecting old status names
            "cold": counts["unqualified"],
            "warm": counts["mql"],
            "hot": counts["sal"],
            "qualified": counts["sql"],
            "avg_score": round(total_score / total) if total > 0 else 0,
        }


@router.post("/mark-all-viewed", status_code=204)
def mark_all_leads_viewed(
    bot_id: RowId | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Bulk-clear the unread flag on every lead for the caller's bot(s).

    Matches the `PATCH /offline-messages/{id} → read` UX, a single
    "Mark all as read" click on the Leads page drops the sidebar badge
    to zero without opening every drawer.
    """
    with get_session() as session:
        bot_ids = _resolve_client_bot_ids(session, auth, bot_id)
        if not bot_ids:
            return Response(status_code=204)

        session.execute(
            update(ChatSession)
            .where(
                ChatSession.bot_id.in_(bot_ids),
                ChatSession.lead_viewed_at.is_(None),
            )
            .values(lead_viewed_at=datetime.now(UTC))
        )
        session.commit()
        return Response(status_code=204)


@router.post("/{session_id}/view", status_code=204)
def mark_lead_viewed(
    session_id: str,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Mark a single lead as viewed. Idempotent. Subsequent calls are no-ops.

    Returns 204 (no body) so the frontend can fire-and-forget on drawer open.
    """
    with get_session() as session:
        bot_ids = _resolve_client_bot_ids(session, auth, None)
        if not bot_ids:
            raise HTTPException(status_code=404, detail="Lead not found")

        lead = session.execute(
            select(ChatSession).where(
                ChatSession.id == session_id,
                ChatSession.bot_id.in_(bot_ids),
            )
        ).scalar_one_or_none()
        if lead is None:
            raise HTTPException(status_code=404, detail="Lead not found")

        if lead.lead_viewed_at is None:
            lead.lead_viewed_at = datetime.now(UTC)
            session.commit()
        return Response(status_code=204)


def _qualification_value(lead: dict, dimension: str) -> str:
    """Read one BANT dimension out of a lead payload, tolerating other frameworks.

    ``build_lead_response`` emits the dimensions of the bot's *actual*
    framework, so a bot on MEDDIC / CHAMP / GPCTBA+C&I has no ``need`` key at
    all, it has ``metrics``, ``economic_buyer``, and so on. Indexing the four
    BANT names directly raised ``KeyError`` for those bots, and since this
    handler has no ``except``, every one of those customers got a 500 and could
    never export their leads.

    This restores the export for them with the file's shape unchanged: the four
    BANT columns come back empty rather than crashing. Emitting each bot's real
    dimensions instead would be the better end state, but it changes what the
    columns *mean* per row and is a product decision, not a bug fix. Tracked
    separately so it doesn't gate unbreaking the endpoint.
    """
    entry = (lead.get("bant") or {}).get(dimension) or {}
    return entry.get("value") or ""


@router.get("/export")
def export_leads_csv(
    bot_id: RowId | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Export leads as a CSV file download. Paid plans only.

    The CSV is the lead-intelligence layer in bulk (Score / Status / BANT /
    Location / Device columns), so it is gated the same way the fields are
    stripped from the JSON responses, a Free API key gets a 403, not a
    file with the locked columns filled in.
    """
    with get_session() as session:
        if not is_lead_intelligence_enabled(auth["client_id"], session):
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "feature_not_available",
                    "feature": "lead_intelligence",
                    "message": (
                        "Lead export is included on Starter and above. "
                        "Please upgrade your plan to export captured leads."
                    ),
                },
            )
        bot_ids = _resolve_client_bot_ids(session, auth, bot_id)

        results = session.execute(
            select(ChatSession, func.count(ChatMessage.id).label("msg_count"))
            .outerjoin(ChatMessage, ChatMessage.session_id == ChatSession.id)
            .where(ChatSession.bot_id.in_(bot_ids))
            .group_by(ChatSession.id)
            .order_by(desc(ChatSession.last_active_at))
        ).all()

        bot_map: dict[int, Bot] = {}
        if bot_ids:
            bots = session.execute(select(Bot).where(Bot.id.in_(bot_ids))).scalars().all()
            bot_map = {bot.id: bot for bot in bots}

        session_ids = [chat_session.id for chat_session, _ in results]
        lead_info_map: dict[str, LeadInfo] = {}
        if session_ids:
            lead_infos = session.execute(select(LeadInfo).where(LeadInfo.session_id.in_(session_ids))).scalars().all()
            lead_info_map = {lead_info.session_id: lead_info for lead_info in lead_infos}

        attribution_enabled = is_lead_source_attribution_enabled(auth["client_id"], session)

        output = io.StringIO()
        writer = csv.writer(output)
        header = [
            "Session ID",
            "Name",
            "Email",
            "Phone",
            "Company",
            "Score",
            "Status",
            "Need",
            "Budget",
            "Authority",
            "Timeline",
            "Location",
            "Device",
            "Messages",
            "Created",
            "Last Active",
        ]
        if attribution_enabled:
            # Add attribution columns for Standard+ so operators can pipe
            # the CSV into their own CRM with per-lead source context.
            header.extend(
                [
                    "Source",
                    "Medium",
                    "Campaign",
                    "Referrer",
                    "Landing Page",
                    "Journey",
                ]
            )
        writer.writerow(header)

        for chat_session, msg_count in results:
            lead_info = lead_info_map.get(chat_session.id)
            lead = build_lead_response(
                chat_session,
                lead_info,
                msg_count,
                bot=bot_map.get(chat_session.bot_id),
                include_attribution=attribution_enabled,
            )
            # Nearly every string in this row reaches it from outside the
            # server: the session id is minted by the widget, contact fields are
            # typed into the lead form by a visitor, the qualification values
            # are LLM-extracted from what that visitor said, and location/device
            # are derived from request headers. ``csv_safe_row`` escapes the
            # whole row as a unit rather than each cell at its call site, so a
            # column added below is safe without its author having to know that.
            # Integers (score, message count) pass through untouched and stay
            # numeric in the recipient's sheet.
            #
            # Absence is an EMPTY CELL, never a word. ``build_lead_response``
            # answers "Unknown" for a missing location/device because that
            # reads well in the dashboard table, but a file says "no value"
            # with an empty cell, a CRM importing "Unknown" creates a country
            # by that name. The client-side "Export selected" download
            # (``app/src/features/leads/leadsCsv.ts``) blanks the same
            # placeholder so a customer merging the two files never sees one
            # lead described two ways. Hence ``or ""`` on the Location column
            # below rather than ``format_visitor_location``.
            row = [
                chat_session.id,
                lead_info.name if lead_info else "",
                lead_info.email if lead_info else "",
                lead_info.phone if lead_info else "",
                lead_info.company if lead_info else "",
                lead["score"],
                lead["tier"],
                _qualification_value(lead, "need"),
                _qualification_value(lead, "budget"),
                _qualification_value(lead, "authority"),
                _qualification_value(lead, "timeline"),
                # This column is the reason ``core.visitor_privacy`` exists.
                # It used to be ``chat_session.location or ""``, the stored
                # string, IP and all, for every lead in the workspace, in a file
                # that then gets mailed around and loaded into a CRM. The
                # dashboard beside it had been stripping the IP the whole time.
                redact_visitor_ip(chat_session.location) or "",
                chat_session.device or "",
                msg_count,
                chat_session.created_at.isoformat() if chat_session.created_at else "",
                chat_session.last_active_at.isoformat() if chat_session.last_active_at else "",
            ]
            if attribution_enabled:
                source = lead.get("source") or {}
                utm = source.get("utm_params") or {}
                journey = source.get("journey") or []
                journey_summary = " → ".join(
                    entry.get("path", "") for entry in journey if isinstance(entry, dict) and entry.get("path")
                )
                # All six come off the host page the widget was embedded on.
                # Query string, document.referrer, and the recorded path list,
                # so an attacker controls them by linking a visitor to the
                # customer's own site with a crafted URL.
                row.extend(
                    [
                        utm.get("utm_source", "") or "",
                        utm.get("utm_medium", "") or "",
                        utm.get("utm_campaign", "") or "",
                        source.get("referrer", "") or "",
                        source.get("landing_page", "") or "",
                        journey_summary,
                    ]
                )
            row = csv_safe_row(row)
            writer.writerow(row)

        output.seek(0)
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=oyechats-leads.csv"},
        )


# ── Email suppressions ───────────────────────────────────────────────────────
#
# ``EmailSuppression`` is the permanent per-bot do-not-email list. Until now it
# was written only by the public unsubscribe link and read only by Gate 3 in
# ``send_manual_follow_up`` above, so a customer had no way to see who had
# unsubscribed, or to notice that an address they expected to reach was
# suppressed. These two endpoints expose it.
#
# There is deliberately **no DELETE**: the model's own docstring states a row is
# never removed by application code. Re-enabling mail to someone who asked to
# stop is a consent decision (this product's lawful basis under India's DPDP Act
# is consent-only), not a CRUD operation.


class CreateSuppressionRequest(BaseModel):
    """Body for ``POST /leads/suppressions``.

    Lets a customer honour an out-of-band "stop emailing me" (said on a call,
    replied to the email, raised in a ticket) without waiting for the visitor
    to click the unsubscribe link. Safe in every direction: the only thing it
    can do is stop mail.
    """

    bot_id: RowId
    email: EmailAddress
    # The three values the model documents. ``unsubscribe`` is what a customer
    # recording a manual opt-out means; the other two exist so a bounce or
    # complaint imported by hand keeps its real provenance.
    reason: Literal["unsubscribe", "hard_bounce", "spam_complaint"] = "unsubscribe"


def _suppression_response(row: EmailSuppression, bot_names: dict[int, str]) -> dict:
    return {
        "id": row.id,
        "bot_id": row.bot_id,
        "bot_name": bot_names.get(row.bot_id),
        "email": row.email,
        "reason": row.reason,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.get("/suppressions")
def list_suppressions(
    bot_id: RowId | None = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    search: SearchTerm | None = Query(None, description="Case-insensitive substring match on the email address"),
    auth: dict = Depends(get_current_client_or_operator),
):
    """List the addresses suppressed for the bots this caller can act on.

    SCOPING: ``EmailSuppression`` carries no ``client_id``, only ``bot_id``.
    Every row returned here is therefore filtered through the caller's own bot
    ids (``_resolve_client_bot_ids``, the same helper / same 403 ``list_leads``
    uses) — the workspace's bots for an owner, the single bound bot for an
    operator. Without that filter this endpoint would hand out other tenants'
    visitors' email addresses, and, before the operator half of the helper
    existed, a sibling bot's.
    """
    with get_session() as session:
        bot_ids = _resolve_client_bot_ids(session, auth, bot_id)
        if not bot_ids:
            return {"suppressions": [], "total": 0, "page": page, "limit": limit}

        conditions = [EmailSuppression.bot_id.in_(bot_ids)]
        if search:
            # ``ilike`` needs the wildcards escaped or a stray ``%`` in the
            # search box would match every row.
            escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            conditions.append(EmailSuppression.email.ilike(f"%{escaped}%", escape="\\"))

        total = int(session.execute(select(func.count(EmailSuppression.id)).where(*conditions)).scalar_one() or 0)

        rows = (
            session.execute(
                select(EmailSuppression)
                .where(*conditions)
                .order_by(desc(EmailSuppression.created_at), desc(EmailSuppression.id))
                .offset((page - 1) * limit)
                .limit(limit)
            )
            .scalars()
            .all()
        )

        bot_names: dict[int, str] = {}
        page_bot_ids = {row.bot_id for row in rows}
        if page_bot_ids:
            bot_names = dict(session.execute(select(Bot.id, Bot.name).where(Bot.id.in_(page_bot_ids))).all())

        return {
            "suppressions": [_suppression_response(row, bot_names) for row in rows],
            "total": total,
            "page": page,
            "limit": limit,
        }


@router.post("/suppressions", status_code=201)
def create_suppression(
    body: CreateSuppressionRequest,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Suppress an address for one of the caller's bots. Idempotent.

    Same scoping as the list above: ``_resolve_client_bot_ids`` raises the 403
    ``list_leads`` raises when ``bot_id`` is not one the caller can act on, so
    nobody can seed a suppression on another workspace's bot — or, for an
    operator, on a sibling bot in their own workspace. This is a write that
    permanently silences that bot's follow-ups to an address.

    The insert mirrors ``unsubscribe_routes._do_unsubscribe``: read-then-add,
    with an ``IntegrityError`` rollback against ``uq_email_suppressions_bot_email``
    so two concurrent calls both settle on "already suppressed" instead of
    500ing.
    """
    with get_session() as session:
        _resolve_client_bot_ids(session, auth, body.bot_id)

        existing = session.execute(
            select(EmailSuppression).where(
                EmailSuppression.bot_id == body.bot_id,
                EmailSuppression.email == body.email,
            )
        ).scalar_one_or_none()
        if existing is not None:
            bot_name = session.execute(select(Bot.name).where(Bot.id == existing.bot_id)).scalar_one_or_none()
            return _suppression_response(existing, {existing.bot_id: bot_name})

        row = EmailSuppression(bot_id=body.bot_id, email=body.email, reason=body.reason)
        try:
            session.add(row)
            session.commit()
        except IntegrityError:
            # Race: a concurrent unsubscribe click inserted it first. Already
            # suppressed is the outcome we wanted, so re-read and return it.
            session.rollback()
            existing = session.execute(
                select(EmailSuppression).where(
                    EmailSuppression.bot_id == body.bot_id,
                    EmailSuppression.email == body.email,
                )
            ).scalar_one_or_none()
            if existing is None:
                raise
            bot_name = session.execute(select(Bot.name).where(Bot.id == existing.bot_id)).scalar_one_or_none()
            return _suppression_response(existing, {existing.bot_id: bot_name})

        session.refresh(row)
        # PRIVACY: never log the address itself. It is visitor personal data.
        logger.info("Suppression added | bot=%s | operator=%s", body.bot_id, auth.get("operator_id"))
        bot_name = session.execute(select(Bot.name).where(Bot.id == row.bot_id)).scalar_one_or_none()
        return _suppression_response(row, {row.bot_id: bot_name})


@router.get("/{session_id}")
def get_lead_detail(
    session_id: str,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Get full lead detail: BANT + contact info + chat history."""
    with get_session() as session:
        bot_ids = _resolve_client_bot_ids(session, auth, None)

        chat_session = session.execute(
            select(ChatSession).where(
                ChatSession.id == session_id,
                ChatSession.bot_id.in_(bot_ids),
            )
        ).scalar_one_or_none()

        if not chat_session:
            raise HTTPException(status_code=404, detail="Lead not found")

        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id).limit(1)).scalar_one_or_none()

        lead_info = session.execute(
            select(LeadInfo).where(LeadInfo.session_id == session_id).limit(1)
        ).scalar_one_or_none()

        messages = (
            session.execute(
                select(ChatMessage)
                .where(ChatMessage.session_id == session_id)
                .order_by(ChatMessage.created_at)
                .limit(100)
            )
            .scalars()
            .all()
        )

        msg_count = len(messages)
        attribution_enabled = is_lead_source_attribution_enabled(auth["client_id"], session)
        intelligence_enabled = is_lead_intelligence_enabled(auth["client_id"], session)
        # Per-bot, not per-account: this lead belongs to one specific bot, so
        # it gets exactly that bot's subscription's features.
        visitor_intelligence_enabled = is_visitor_intelligence_enabled_for_bot(chat_session.bot_id, session)
        lead = build_lead_response(
            chat_session,
            lead_info,
            msg_count,
            bot=bot,
            include_attribution=attribution_enabled,
            include_intelligence=intelligence_enabled,
            include_visitor_intelligence=visitor_intelligence_enabled,
        )
        lead["messages"] = [
            {
                "role": m.role,
                "content": m.content,
                "timestamp": m.created_at.isoformat() if m.created_at else None,
                "feedback": m.feedback,
            }
            for m in messages
        ]

        # Add BANT signal evidence trail. Intelligence-layer data, so Free
        # gets the transcript above but never the extraction evidence.
        if intelligence_enabled:
            signals = (
                session.execute(
                    select(BANTSignal).where(BANTSignal.session_id == session_id).order_by(BANTSignal.created_at)
                )
                .scalars()
                .all()
            )
            lead["signals"] = [
                {
                    "dimension": s.dimension,
                    "signal_text": s.signal_text,
                    "extracted_value": s.extracted_value,
                    "confidence": s.confidence,
                    "score_before": s.score_before,
                    "score_after": s.score_after,
                    # llm | cta_click | operator_override. Lets the UI separate
                    # visitor-stated evidence from manual operator score edits.
                    "source": getattr(s, "source", None),
                    "created_at": s.created_at.isoformat() if s.created_at else None,
                }
                for s in signals
            ]

        # Attach the quotation-flow summary (itemised requirement lines + total,
        # resolved against the bot's current catalog) if the session went
        # through it. Uses the single ``build_quotation_summary`` helper so this
        # surface reads identically to the operator session-details panel.
        from app.api.quotation_routes import build_quotation_summary

        quotation_summary = build_quotation_summary(bot, chat_session)
        if quotation_summary is not None:
            lead["quotation"] = quotation_summary

        return lead


FOLLOWUP_COOLDOWN = timedelta(days=14)


class SendFollowUpRequest(BaseModel):
    confirm_override: bool = False


@router.post("/{session_id}/follow-up")
def send_manual_follow_up(
    session_id: SessionId,
    body: SendFollowUpRequest | None = None,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Admin manually sends a follow-up email to a captured lead.

    There is no automatic or timed send anywhere in this system, an
    operator triggers this explicitly, but every gate below still runs at
    click time (not just when deciding whether to show the button), so a
    bad send stays structurally hard to make. See
    docs/superpowers/plans/2026-08-08-visitor-intelligence.md §02.
    """
    confirm_override = bool(body and body.confirm_override)

    with get_session() as session:
        bot_ids = _resolve_client_bot_ids(session, auth, None)

        chat_session = session.execute(
            select(ChatSession).where(ChatSession.id == session_id, ChatSession.bot_id.in_(bot_ids))
        ).scalar_one_or_none()

        if not chat_session:
            raise HTTPException(status_code=404, detail="Lead not found")

        # Gated on THIS bot's subscription, not the account's best plan, a
        # Free bot must not be able to send follow-ups just because a sibling
        # bot in the same workspace is on Professional.
        if not is_visitor_intelligence_enabled_for_bot(chat_session.bot_id, session):
            raise HTTPException(
                status_code=403,
                detail="Visitor Intelligence is not enabled on this agent's plan.",
            )

        lead_info = session.execute(select(LeadInfo).where(LeadInfo.session_id == session_id)).scalar_one_or_none()

        # Gate 1a. Hard stop, no override. Nothing to send to.
        if not lead_info or not lead_info.email:
            raise HTTPException(status_code=400, detail="Lead is not eligible, no email address was captured.")

        # Gate 1b. Hard stop, no override. Reoon positively flagged this
        # address as junk (bad syntax / disposable / spamtrap / dead MX).
        # Sending here is what gets a sending domain blacklisted.
        if lead_info.is_valid_email is False:
            raise HTTPException(
                status_code=400,
                detail="Lead is not eligible. This address failed email validation and cannot be contacted.",
            )

        # Gate 1c. SOFT stop, operator can override. ``None`` means "never
        # validated", not "known bad": the lead predates this feature, was
        # captured on a plan without email validation, or Reoon was
        # unreachable at capture time. Treating that identically to
        # "flagged unsafe" (as this gate originally did) permanently locked
        # follow-up for every such lead with no way out, the operator can
        # see the address on screen, so let them take responsibility for it.
        if lead_info.is_valid_email is None and not confirm_override:
            raise HTTPException(
                status_code=409,
                detail=("This address hasn't been checked for deliverability. Double-check it before sending."),
            )

        # Gate 2. Soft stop, operator can override.
        if lead_info.last_followup_sent_at:
            elapsed = datetime.now(UTC) - lead_info.last_followup_sent_at
            if elapsed < FOLLOWUP_COOLDOWN and not confirm_override:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"You already followed up with this lead {elapsed.days} day(s) ago. "
                        "Sending again this soon may feel like spam."
                    ),
                )

        # Gate 3. Hard stop, no override, ever. Scoped to THIS bot.
        # Unsubscribing from one company's follow-ups must never suppress
        # a different, unrelated customer's bot from emailing the same address.
        suppressed = session.execute(
            select(EmailSuppression).where(
                EmailSuppression.bot_id == chat_session.bot_id,
                EmailSuppression.email == lead_info.email.strip().lower(),
            )
        ).scalar_one_or_none()
        if suppressed:
            raise HTTPException(status_code=403, detail="This email has unsubscribed. Cannot send.")

        # Gate 4. Hard stop, no override.
        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        if bot and bot.followup_sending_paused:
            raise HTTPException(
                status_code=423,
                detail="Follow-up sending is paused for this agent. Turn it back on in Settings to send this email.",
            )

        unsubscribe_url = (
            f"{API_BASE_URL}/leads/unsubscribe?token={make_unsubscribe_token(chat_session.bot_id, lead_info.email)}"
        )

        subject = "Following up on your chat with us"
        safe_name = esc(lead_info.name) if lead_info.name else "there"
        inner = (
            h1(subject)
            + p(f"Hi {safe_name},")
            + p("We noticed you were chatting with our assistant. How can we help you further?")
            + p(f'<a href="{esc(unsubscribe_url)}">Unsubscribe from future follow-ups</a>')
        )
        html_body = shell(subject=subject, preheader="Following up on your chat", inner=inner, visitor=True)

        try:
            send_email_async(
                to_email=lead_info.email,
                subject=subject,
                html_body=html_body,
            )
        except Exception as e:
            # PRIVACY. ``session_id``, never the address. This is a visitor's
            # email (the lead captured in the chat), personal data under GDPR and
            # under India's DPDP Act, where this product's basis is consent-only.
            # ``logger.error`` is not a log line here: Sentry's LoggingIntegration
            # promotes ERROR records to full events, so the address was the
            # event's own message, the one field no scrubber gets to see. The
            # session is the join key to the lead row for anyone with DB access.
            logger.error(f"Failed to send follow up | session={session_id} | {e}")
            raise HTTPException(status_code=500, detail="Failed to send email") from e

        lead_info.last_followup_sent_at = datetime.now(UTC)
        lead_info.followup_sent_by_operator_id = auth.get("operator_id")
        session.commit()

        logger.info(f"Follow-up sent | session={session_id} | operator={auth.get('operator_id')}")
        return {"success": True}
