"""Canned response CRUD endpoints — pre-saved quick replies for operators."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.api.auth import get_current_client_or_operator, impersonation_writable
from app.db.models import CannedResponse
from app.db.session import get_session
from app.schemas.validators import OptionalName, RequiredLongText, RequiredName, RowId, Shortcut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/canned-responses", tags=["canned-responses"])


# ── Request Models ──


class CreateCannedResponseRequest(BaseModel):
    title: RequiredName
    # The body an operator sends verbatim into a live visitor conversation.
    content: RequiredLongText
    # A ``/slash`` trigger typed in the composer. Constrained to a slug so it
    # is actually typeable and cannot collide with composer syntax.
    shortcut: Shortcut | None = None
    category: OptionalName = None


class UpdateCannedResponseRequest(BaseModel):
    title: RequiredName | None = None
    content: RequiredLongText | None = None
    shortcut: Shortcut | None = None
    category: OptionalName = None


# ── Endpoints ──


@router.get("")
def list_canned_responses(
    category: OptionalName = Query(None),
    auth=Depends(get_current_client_or_operator),
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
    """Allow clients and all agents to manage shared quick replies.

    All team members can add, edit, and delete workspace-level quick replies
    since they are the primary users of these responses in live chat.
    """
    # Both clients and agents of any role are allowed.
    return


@router.post("")
@impersonation_writable
def create_canned_response(
    request: CreateCannedResponseRequest,
    auth=Depends(get_current_client_or_operator),
):
    """Create a new canned response.

    Writable under a super-admin impersonation session (design §6.1,
    "Canned-response CRUD") — pure workspace content, and reversible.
    """
    _require_canned_response_write_access(auth)
    with get_session() as session:
        response = CannedResponse(
            client_id=auth["client_id"],
            title=request.title.strip(),
            content=request.content.strip(),
            shortcut=request.shortcut.strip() if request.shortcut else None,
            category=request.category.strip() if request.category else None,
            created_by_operator_id=auth["operator_id"],
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
@impersonation_writable
def update_canned_response(
    response_id: RowId,
    request: UpdateCannedResponseRequest,
    auth=Depends(get_current_client_or_operator),
):
    """Update a canned response.

    Writable under a super-admin impersonation session (design §6.1,
    "Canned-response CRUD").
    """
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
@impersonation_writable
def delete_canned_response(
    response_id: RowId,
    auth=Depends(get_current_client_or_operator),
):
    """Delete a canned response.

    Writable under a super-admin impersonation session (design §6.1,
    "Canned-response CRUD"). The deletion denied by §6.2 is Account / AI Agent
    deletion — a quick reply is neither, and re-creating one is trivial.
    """
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
