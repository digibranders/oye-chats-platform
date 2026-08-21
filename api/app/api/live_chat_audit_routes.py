"""Read path for ``ChatAuditLog`` — written on every live-chat state
transition (handoff, accept, close, transfer, timeout) since the model was
added, and never read by anything until this file. See ``ChatAuditLog`` in
``db/models.py`` and the writers in ``chat_routes.py`` / ``operator_routes.py``.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from app.api.auth import get_current_client_or_operator
from app.db.models import ChatAuditLog, ChatSession
from app.db.session import get_session

router = APIRouter(prefix="/chat", tags=["chat"])


@router.get("/sessions/{session_id}/audit")
def get_session_audit_trail(session_id: str, auth: dict = Depends(get_current_client_or_operator)):
    """The ordered state-transition history for one conversation.

    Scoped the same way every other session-level read in this codebase is:
    an operator sees it only for the bot they're bound to, a client sees it
    only for a session under one of their own bots. A session that exists
    but belongs to someone else 404s, not 403 — matching `lead_routes.py`'s
    own reasoning: confirming a session id exists on someone else's account
    is itself an information leak.
    """
    with get_session() as db_session:
        session_row = db_session.execute(
            select(ChatSession).where(ChatSession.id == session_id)
        ).scalar_one_or_none()
        if session_row is None:
            raise HTTPException(status_code=404, detail="Session not found.")

        if auth.get("type") == "operator":
            operator_bot_id = auth.get("bot_id") or getattr(auth.get("entity"), "bot_id", None)
            if session_row.bot_id != operator_bot_id:
                raise HTTPException(status_code=404, detail="Session not found.")
        elif session_row.client_id != auth["client_id"]:
            raise HTTPException(status_code=404, detail="Session not found.")

        rows = (
            db_session.execute(
                select(ChatAuditLog)
                .where(ChatAuditLog.session_id == session_id)
                .order_by(ChatAuditLog.created_at.asc())
            )
            .scalars()
            .all()
        )

        return {
            "entries": [
                {
                    "action": row.action,
                    "operator_id": row.operator_id,
                    "details": row.details,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                }
                for row in rows
            ]
        }
