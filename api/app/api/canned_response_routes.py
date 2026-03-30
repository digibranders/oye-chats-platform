"""Canned response CRUD endpoints — pre-saved quick replies for agents."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.api.auth import get_current_client_or_agent
from app.db.models import CannedResponse
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/canned-responses", tags=["canned-responses"])


# ── Request Models ──


class CreateCannedResponseRequest(BaseModel):
    title: str
    content: str
    shortcut: str | None = None
    category: str | None = None


class UpdateCannedResponseRequest(BaseModel):
    title: str | None = None
    content: str | None = None
    shortcut: str | None = None
    category: str | None = None


# ── Endpoints ──


@router.get("")
def list_canned_responses(
    category: str | None = Query(None),
    auth=Depends(get_current_client_or_agent),
):
    """List canned responses for the client."""
    with get_session() as session:
        query = select(CannedResponse).where(CannedResponse.client_id == auth["client_id"])
        if category:
            query = query.where(CannedResponse.category == category)
        query = query.order_by(CannedResponse.title)

        responses = session.execute(query).scalars().all()
        return {
            "responses": [
                {
                    "id": r.id,
                    "title": r.title,
                    "content": r.content,
                    "shortcut": r.shortcut,
                    "category": r.category,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in responses
            ]
        }


def _require_canned_response_write_access(auth: dict) -> None:
    """Allow clients and owner/admin agents to manage shared quick replies.

    Regular agents are read-only: they use quick replies in live chat but
    cannot add, edit, or delete workspace-level shared responses.
    """
    if auth["type"] == "client":
        return
    if getattr(auth["entity"], "role", "agent") not in {"owner", "admin"}:
        raise HTTPException(
            status_code=403,
            detail="Only workspace owners and admins can modify quick replies.",
        )


@router.post("")
def create_canned_response(
    request: CreateCannedResponseRequest,
    auth=Depends(get_current_client_or_agent),
):
    """Create a new canned response."""
    _require_canned_response_write_access(auth)
    with get_session() as session:
        response = CannedResponse(
            client_id=auth["client_id"],
            title=request.title.strip(),
            content=request.content.strip(),
            shortcut=request.shortcut.strip() if request.shortcut else None,
            category=request.category.strip() if request.category else None,
            created_by_agent_id=auth["agent_id"],
        )
        session.add(response)
        session.commit()
        session.refresh(response)

        return {
            "id": response.id,
            "title": response.title,
            "content": response.content,
            "shortcut": response.shortcut,
            "category": response.category,
        }


@router.patch("/{response_id}")
def update_canned_response(
    response_id: int,
    request: UpdateCannedResponseRequest,
    auth=Depends(get_current_client_or_agent),
):
    """Update a canned response."""
    _require_canned_response_write_access(auth)
    with get_session() as session:
        response = session.execute(
            select(CannedResponse).where(
                CannedResponse.id == response_id,
                CannedResponse.client_id == auth["client_id"],
            )
        ).scalar_one_or_none()
        if not response:
            raise HTTPException(status_code=404, detail="Canned response not found.")

        if request.title is not None:
            response.title = request.title.strip()
        if request.content is not None:
            response.content = request.content.strip()
        if request.shortcut is not None:
            response.shortcut = request.shortcut.strip() if request.shortcut else None
        if request.category is not None:
            response.category = request.category.strip() if request.category else None

        session.commit()
        return {"success": True, "message": "Canned response updated."}


@router.delete("/{response_id}")
def delete_canned_response(
    response_id: int,
    auth=Depends(get_current_client_or_agent),
):
    """Delete a canned response."""
    _require_canned_response_write_access(auth)
    with get_session() as session:
        response = session.execute(
            select(CannedResponse).where(
                CannedResponse.id == response_id,
                CannedResponse.client_id == auth["client_id"],
            )
        ).scalar_one_or_none()
        if not response:
            raise HTTPException(status_code=404, detail="Canned response not found.")

        session.delete(response)
        session.commit()
        return {"success": True}
