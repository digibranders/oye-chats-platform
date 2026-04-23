"""Lead management endpoints — view, filter, and export qualified leads."""

import csv
import io
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import desc, func, select, update

from app.api.auth import get_current_client_or_operator
from app.db.models import BANTSignal, Bot, ChatMessage, ChatSession, LeadInfo
from app.db.session import get_session
from app.services.lead_service import build_lead_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/leads", tags=["leads"])


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

        # Build leads with scores — filters are Python-computed (score/tier not in DB)
        leads = []
        for chat_session, msg_count in results:
            lead = build_lead_response(
                chat_session,
                lead_info_map.get(chat_session.id),
                msg_count,
                bot=bot_map.get(chat_session.bot_id),
            )

            # Apply filters (tier or legacy status param)
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
    """Export leads as a CSV file download."""
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

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(
            [
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
        )

        for chat_session, msg_count in results:
            lead_info = lead_info_map.get(chat_session.id)
            lead = build_lead_response(
                chat_session,
                lead_info,
                msg_count,
                bot=bot_map.get(chat_session.bot_id),
            )
            writer.writerow(
                [
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
            )

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
        lead = build_lead_response(chat_session, lead_info, msg_count, bot=bot)
        lead["messages"] = [
            {
                "role": m.role,
                "content": m.content,
                "timestamp": m.created_at.isoformat() if m.created_at else None,
                "feedback": m.feedback,
            }
            for m in messages
        ]

        # Add BANT signal evidence trail
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
