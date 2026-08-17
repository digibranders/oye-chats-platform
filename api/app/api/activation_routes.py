"""Activation event stream + super-admin onboarding funnel.

Clients emit free-form activation milestones (``studio_opened``,
``first_doc_uploaded``, ``widget_installed``, …) as they progress through
onboarding. ``POST /activation/events`` is a lightweight, best-effort ingest
scoped to the authenticated client. ``GET /activation/funnel`` (super-admin
only) aggregates counts per ``event_type`` and reports TTVLW — "time to
verified live widget" — the time from a client's account creation to its first
bot going live (``widget_installed_at``), summarised as a median in seconds.
"""

from __future__ import annotations

from statistics import median

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.auth import get_current_client, get_superadmin
from app.db.models import ActivationEvent, Bot, Client
from app.db.session import get_session
from app.schemas.validators import RowId, SmallJsonObject

router = APIRouter(prefix="/activation", tags=["activation"])


class ActivationEventCreate(BaseModel):
    # Free-form by design so a new milestone needs no migration — but the
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


@router.get("/funnel")
def activation_funnel(_: Client = Depends(get_superadmin)):
    """Aggregate activation events and the TTVLW statistic (super-admin only).

    - ``counts``: number of events per ``event_type`` (GROUP BY).
    - ``ttvlw``: over clients with at least one bot whose ``widget_installed_at``
      is set, the seconds between ``client.created_at`` and the earliest such
      ``widget_installed_at``; reported as ``count`` of qualifying clients and
      the ``median_seconds`` (``null`` when there are none).
    """
    with get_session() as session:
        count_rows = session.execute(
            select(ActivationEvent.event_type, func.count())
            .group_by(ActivationEvent.event_type)
            .order_by(func.count().desc())
        ).all()
        counts = {event_type: count for event_type, count in count_rows}

        # One row per qualifying client: created_at + the earliest go-live time
        # across its bots. Clients with no live bot are excluded by the WHERE.
        ttvlw_rows = session.execute(
            select(Client.created_at, func.min(Bot.widget_installed_at))
            .join(Bot, Bot.client_id == Client.id)
            .where(Bot.widget_installed_at.is_not(None))
            .group_by(Client.id, Client.created_at)
        ).all()

        durations = [
            (first_live - created_at).total_seconds()
            for created_at, first_live in ttvlw_rows
            if created_at is not None and first_live is not None
        ]

    return {
        "counts": counts,
        "ttvlw": {
            "count": len(durations),
            "median_seconds": median(durations) if durations else None,
        },
    }
