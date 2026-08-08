"""Lead management endpoints — view, filter, and export qualified leads."""

import csv
import io
import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, func, select, update

from app.api.auth import get_current_client_or_operator
from app.config import API_BASE_URL
from app.db.models import BANTSignal, Bot, ChatMessage, ChatSession, EmailSuppression, LeadInfo
from app.db.session import get_session
from app.services.email_design import esc, h1, p, shell
from app.services.email_service import send_email_async
from app.services.lead_service import build_lead_response
from app.services.plan_entitlements_service import (
    is_lead_intelligence_enabled,
    is_lead_source_attribution_enabled,
    is_leads_dashboard_enabled,
    is_visitor_intelligence_enabled,
)
from app.services.unsubscribe_token import make_unsubscribe_token

logger = logging.getLogger(__name__)


def _require_leads_dashboard(auth: dict = Depends(get_current_client_or_operator)) -> None:
    """Router-level gate — every plan reaches the Leads dashboard.

    Free included: the dashboard itself is open, and the paid boundary is
    the lead-intelligence layer (score / tier / BANT / location / export),
    enforced per-route via ``is_lead_intelligence_enabled`` — responses
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


router = APIRouter(
    prefix="/leads",
    tags=["leads"],
    dependencies=[Depends(_require_leads_dashboard)],
)


def _resolve_client_bot_ids(session, auth: dict, bot_id: int | None) -> list[int]:
    """Return the list of bot IDs this caller can act on.

    If `bot_id` is provided, verify the caller owns it (raises 403 otherwise).
    If not, return every bot owned by the caller's client.
    """
    client_bot_ids = list(session.execute(select(Bot.id).where(Bot.client_id == auth["client_id"])).scalars().all())
    if bot_id is None:
        return client_bot_ids
    owns_bot = session.execute(
        select(Bot.id).where(Bot.id == bot_id, Bot.client_id == auth["client_id"])
    ).scalar_one_or_none()
    if not owns_bot:
        raise HTTPException(status_code=403, detail="Bot not found or access denied.")
    return [bot_id]


@router.get("")
def list_leads(
    bot_id: int | None = Query(None),
    tier: str | None = Query(None, description="unqualified|mql|sal|sql"),
    status: str | None = Query(None, description="backward-compat alias for tier"),
    min_score: int | None = Query(None, ge=0, le=100),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    auth: dict = Depends(get_current_client_or_operator),
):
    """List leads with BANT data, scores, and optional filters."""
    with get_session() as session:
        # Get bot IDs for this client (always scoped to authenticated client)
        client_bot_ids = list(session.execute(select(Bot.id).where(Bot.client_id == auth["client_id"])).scalars().all())
        if bot_id:
            # Verify the bot belongs to the authenticated client
            owns_bot = session.execute(
                select(Bot.id).where(Bot.id == bot_id, Bot.client_id == auth["client_id"])
            ).scalar_one_or_none()
            if not owns_bot:
                raise HTTPException(status_code=403, detail="Bot not found or access denied.")
            bot_ids = [bot_id]
        else:
            bot_ids = client_bot_ids

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
        visitor_intelligence_enabled = is_visitor_intelligence_enabled(auth["client_id"], session)

        # Build leads with scores — filters are Python-computed (score/tier not in DB)
        leads = []
        for chat_session, msg_count in results:
            lead = build_lead_response(
                chat_session,
                lead_info_map.get(chat_session.id),
                msg_count,
                bot=bot_map.get(chat_session.bot_id),
                include_attribution=attribution_enabled,
                include_intelligence=intelligence_enabled,
                include_visitor_intelligence=visitor_intelligence_enabled,
            )

            # Apply filters (tier or legacy status param). Tier/score are part
            # of the paid intelligence layer — for Free the fields aren't in
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


@router.get("/stats")
def lead_stats(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Aggregate lead stats: total, unqualified, MQL, SAL, and SQL counts."""
    with get_session() as session:
        client_bot_ids = list(session.execute(select(Bot.id).where(Bot.client_id == auth["client_id"])).scalars().all())
        if bot_id:
            owns_bot = session.execute(
                select(Bot.id).where(Bot.id == bot_id, Bot.client_id == auth["client_id"])
            ).scalar_one_or_none()
            if not owns_bot:
                raise HTTPException(status_code=403, detail="Bot not found or access denied.")
            bot_ids = [bot_id]
        else:
            bot_ids = client_bot_ids

        if not is_lead_intelligence_enabled(auth["client_id"], session):
            # Free plan: total + unread keep the list header and sidebar badge
            # working; the qualification aggregates (tier counts, avg score)
            # are the paid intelligence layer and are not computed at all.
            total = 0
            unread = 0
            if bot_ids:
                total = (
                    session.execute(select(func.count(ChatSession.id)).where(ChatSession.bot_id.in_(bot_ids))).scalar()
                    or 0
                )
                unread = (
                    session.execute(
                        select(func.count(ChatSession.id)).where(
                            ChatSession.bot_id.in_(bot_ids),
                            ChatSession.lead_viewed_at.is_(None),
                        )
                    ).scalar()
                    or 0
                )
            return {"total": total, "unread": unread}

        sessions = session.execute(select(ChatSession).where(ChatSession.bot_id.in_(bot_ids))).scalars().all()
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
            unread = (
                session.execute(
                    select(func.count(ChatSession.id)).where(
                        ChatSession.bot_id.in_(bot_ids),
                        ChatSession.lead_viewed_at.is_(None),
                    )
                ).scalar()
                or 0
            )

        total = len(sessions)
        return {
            "total": total,
            "unread": unread,
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
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Bulk-clear the unread flag on every lead for the caller's bot(s).

    Matches the `PATCH /offline-messages/{id} → read` UX — a single
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
    """Mark a single lead as viewed. Idempotent — subsequent calls are no-ops.

    Returns 204 (no body) so the frontend can fire-and-forget on drawer open.
    """
    with get_session() as session:
        bot_ids = list(session.execute(select(Bot.id).where(Bot.client_id == auth["client_id"])).scalars().all())
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


@router.get("/export")
def export_leads_csv(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Export leads as a CSV file download. Paid plans only.

    The CSV is the lead-intelligence layer in bulk (Score / Status / BANT /
    Location / Device columns), so it is gated the same way the fields are
    stripped from the JSON responses — a Free API key gets a 403, not a
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
        client_bot_ids = list(session.execute(select(Bot.id).where(Bot.client_id == auth["client_id"])).scalars().all())
        if bot_id:
            owns_bot = session.execute(
                select(Bot.id).where(Bot.id == bot_id, Bot.client_id == auth["client_id"])
            ).scalar_one_or_none()
            if not owns_bot:
                raise HTTPException(status_code=403, detail="Bot not found or access denied.")
            bot_ids = [bot_id]
        else:
            bot_ids = client_bot_ids

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
            row = [
                chat_session.id,
                lead_info.name if lead_info else "",
                lead_info.email if lead_info else "",
                lead_info.phone if lead_info else "",
                lead_info.company if lead_info else "",
                lead["score"],
                lead["tier"],
                lead["bant"]["need"]["value"] or "",
                lead["bant"]["budget"]["value"] or "",
                lead["bant"]["authority"]["value"] or "",
                lead["bant"]["timeline"]["value"] or "",
                chat_session.location or "",
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
            writer.writerow(row)

        output.seek(0)
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=oyechats-leads.csv"},
        )


@router.get("/{session_id}")
def get_lead_detail(
    session_id: str,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Get full lead detail: BANT + contact info + chat history."""
    with get_session() as session:
        bot_ids = list(session.execute(select(Bot.id).where(Bot.client_id == auth["client_id"])).scalars().all())

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
        visitor_intelligence_enabled = is_visitor_intelligence_enabled(auth["client_id"], session)
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

        # Add BANT signal evidence trail — intelligence-layer data, so Free
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
                    "created_at": s.created_at.isoformat() if s.created_at else None,
                }
                for s in signals
            ]

        return lead


FOLLOWUP_COOLDOWN = timedelta(days=14)


class SendFollowUpRequest(BaseModel):
    confirm_override: bool = False


@router.post("/{session_id}/follow-up")
def send_manual_follow_up(
    session_id: str,
    body: SendFollowUpRequest | None = None,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Admin manually sends a follow-up email to a captured lead.

    There is no automatic or timed send anywhere in this system — an
    operator triggers this explicitly, but every gate below still runs at
    click time (not just when deciding whether to show the button), so a
    bad send stays structurally hard to make. See
    docs/superpowers/plans/2026-08-08-visitor-intelligence.md §02.
    """
    confirm_override = bool(body and body.confirm_override)

    with get_session() as session:
        bot_ids = list(session.execute(select(Bot.id).where(Bot.client_id == auth["client_id"])).scalars().all())

        chat_session = session.execute(
            select(ChatSession).where(ChatSession.id == session_id, ChatSession.bot_id.in_(bot_ids))
        ).scalar_one_or_none()

        if not chat_session:
            raise HTTPException(status_code=404, detail="Lead not found")

        if not is_visitor_intelligence_enabled(auth["client_id"], session):
            raise HTTPException(status_code=403, detail="Visitor Intelligence not enabled on your plan")

        lead_info = session.execute(select(LeadInfo).where(LeadInfo.session_id == session_id)).scalar_one_or_none()

        # Gate 1 — hard stop, no override. No email captured, or Reoon
        # never confirmed it's safe to send (covers "not yet validated"
        # and "flagged unsafe" identically — both mean don't send).
        if not lead_info or not lead_info.email or lead_info.is_valid_email is not True:
            raise HTTPException(status_code=400, detail="Lead is not eligible — no validated, safe-to-send email.")

        # Gate 2 — soft stop, operator can override.
        if lead_info.last_followup_sent_at:
            elapsed = datetime.now(UTC) - lead_info.last_followup_sent_at
            if elapsed < FOLLOWUP_COOLDOWN and not confirm_override:
                raise HTTPException(
                    status_code=409,
                    detail=(f"Already followed up {elapsed.days} day(s) ago. Resend with confirm_override to proceed."),
                )

        # Gate 3 — hard stop, no override, ever. Scoped to THIS bot —
        # unsubscribing from one company's follow-ups must never suppress
        # a different, unrelated customer's bot from emailing the same address.
        suppressed = session.execute(
            select(EmailSuppression).where(
                EmailSuppression.bot_id == chat_session.bot_id,
                EmailSuppression.email == lead_info.email.strip().lower(),
            )
        ).scalar_one_or_none()
        if suppressed:
            raise HTTPException(status_code=403, detail="This email has unsubscribed — cannot send.")

        # Gate 4 — hard stop, no override.
        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        if bot and bot.followup_sending_paused:
            raise HTTPException(status_code=423, detail="Sending is paused for this bot — contact ops.")

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
            logger.error(f"Failed to send follow up to {lead_info.email}: {e}")
            raise HTTPException(status_code=500, detail="Failed to send email") from e

        lead_info.last_followup_sent_at = datetime.now(UTC)
        lead_info.followup_sent_by_operator_id = auth.get("operator_id")
        session.commit()

        logger.info(f"Follow-up sent | session={session_id} | operator={auth.get('operator_id')}")
        return {"success": True}
