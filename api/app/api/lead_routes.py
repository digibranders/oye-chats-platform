"""Lead management endpoints — view, filter, and export qualified leads."""

import csv
import io
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import desc, func, select

from app.api.auth import get_current_client_or_operator
from app.db.models import Bot, ChatMessage, ChatSession, LeadInfo
from app.db.session import get_session
from app.services.lead_service import build_lead_response, calculate_lead_score, get_lead_status

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/leads", tags=["leads"])


@router.get("")
def list_leads(
    bot_id: int | None = Query(None),
    status: str | None = Query(None, description="cold|warm|hot|qualified"),
    min_score: int | None = Query(None, ge=0, le=100),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    auth: dict = Depends(get_current_client_or_operator),
):
    """List leads with BANT data, scores, and optional filters."""
    with get_session() as session:
        # Get bot IDs for this client
        if bot_id:
            bot_ids = [bot_id]
        else:
            bot_ids = list(session.execute(select(Bot.id).where(Bot.client_id == auth["client_id"])).scalars().all())

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

        # Batch-load all LeadInfo records for these sessions in a single query
        session_ids = [cs.id for cs, _ in results]
        lead_info_map: dict = {}
        if session_ids:
            lead_infos = session.execute(select(LeadInfo).where(LeadInfo.session_id.in_(session_ids))).scalars().all()
            lead_info_map = {li.session_id: li for li in lead_infos}

        # Build leads with scores — filters are Python-computed (score/status not in DB)
        leads = []
        for chat_session, msg_count in results:
            lead = build_lead_response(chat_session, lead_info_map.get(chat_session.id), msg_count)

            # Apply filters
            if status and lead["status"] != status:
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
    """Aggregate lead stats: total, cold, warm, hot, qualified counts."""
    with get_session() as session:
        if bot_id:
            bot_ids = [bot_id]
        else:
            bot_ids = list(session.execute(select(Bot.id).where(Bot.client_id == auth["client_id"])).scalars().all())

        sessions = session.execute(select(ChatSession).where(ChatSession.bot_id.in_(bot_ids))).scalars().all()

        counts = {"cold": 0, "warm": 0, "hot": 0, "qualified": 0}
        total_score = 0

        for s in sessions:
            score = calculate_lead_score(s)
            status = get_lead_status(score)
            counts[status] += 1
            total_score += score

        total = len(sessions)
        return {
            "total": total,
            **counts,
            "avg_score": round(total_score / total) if total > 0 else 0,
        }


@router.get("/export")
def export_leads_csv(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Export leads as a CSV file download."""
    with get_session() as session:
        if bot_id:
            bot_ids = [bot_id]
        else:
            bot_ids = list(session.execute(select(Bot.id).where(Bot.client_id == auth["client_id"])).scalars().all())

        results = session.execute(
            select(ChatSession, func.count(ChatMessage.id).label("msg_count"))
            .outerjoin(ChatMessage, ChatMessage.session_id == ChatSession.id)
            .where(ChatSession.bot_id.in_(bot_ids))
            .group_by(ChatSession.id)
            .order_by(desc(ChatSession.last_active_at))
        ).all()

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
            lead_info = session.execute(
                select(LeadInfo).where(LeadInfo.session_id == chat_session.id).limit(1)
            ).scalar_one_or_none()

            score = calculate_lead_score(chat_session)
            writer.writerow(
                [
                    chat_session.id,
                    lead_info.name if lead_info else "",
                    lead_info.email if lead_info else "",
                    lead_info.phone if lead_info else "",
                    lead_info.company if lead_info else "",
                    score,
                    get_lead_status(score),
                    chat_session.bant_need or "",
                    chat_session.bant_budget or "",
                    chat_session.bant_authority or "",
                    chat_session.bant_timeline or "",
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
        lead = build_lead_response(chat_session, lead_info, msg_count)
        lead["messages"] = [
            {
                "role": m.role,
                "content": m.content,
                "timestamp": m.created_at.isoformat() if m.created_at else None,
                "feedback": m.feedback,
            }
            for m in messages
        ]

        return lead
