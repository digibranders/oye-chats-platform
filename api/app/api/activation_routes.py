"""Activation event stream + super-admin onboarding funnel.

Clients emit free-form activation milestones (``studio_opened``,
``first_doc_uploaded``, ``widget_installed``, …) as they progress through
onboarding. ``POST /activation/events`` is a lightweight, best-effort ingest
scoped to the authenticated client. ``GET /activation/funnel`` (super-admin
only) aggregates counts per ``event_type`` and reports TTVLW ("time to
verified live widget") the time from a client's account creation to its first
bot going live (``widget_installed_at``), summarised as a median in seconds.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field

from app.api.auth import get_current_client
from app.db.models import ActivationEvent, Client
from app.db.session import get_session
from app.schemas.validators import RowId, SmallJsonObject

router = APIRouter(prefix="/activation", tags=["activation"])


class ActivationEventCreate(BaseModel):
    # Free-form by design so a new milestone needs no migration, but the
    # value is a grouping key in the super-admin funnel aggregation, so it is
    # held to an identifier shape rather than accepting arbitrary text.
    event_type: str = Field(..., min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.\-]+$")
    bot_id: RowId | None = None
    # Instrumentation metadata, not a document store: bounded so the
    # append-only events table cannot be grown with megabyte blobs by any
    # authenticated client.
    event_data: SmallJsonObject | None = None


@router.post("/events", status_code=status.HTTP_201_CREATED)
def create_activation_event(
    body: ActivationEventCreate,
    client: Client = Depends(get_current_client),
):
    """Record a single activation milestone for the calling client.

    Best-effort instrumentation: the row is scoped to the authenticated client
    and (optionally) a specific bot. ``event_type`` is free-form by design so
    new milestones can be added without a migration.
    """
    with get_session() as session:
        session.add(
            ActivationEvent(
                client_id=client.id,
                bot_id=body.bot_id,
                event_type=body.event_type,
                event_data=body.event_data,
            )
        )
        session.commit()

    return {"success": True}
