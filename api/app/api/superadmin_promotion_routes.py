"""Super admin launch-promotion management.

CRUD for :class:`~app.db.models.Promotion` — the time-boxed acquisition offers
(e.g. "sign up this month, 3 months free"). Config lives in a row so a super
admin can launch, pause (``is_active``), and expire a campaign without a deploy,
and read redemption/conversion stats per campaign.

Auth mirrors the other superadmin routers: ``get_superadmin`` (X-API-Key,
``is_superadmin``) gates every route; ``_require_write`` blocks read-only
super-admins from mutating. Eligibility resolution and the checkout money-path
live elsewhere (``promotion_service`` / ``subscription_routes``) — this module
is purely the admin control surface.
"""

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.auth import get_superadmin
from app.api.superadmin_routes_v2 import _require_write
from app.db.models import Bot, Client, Plan, Promotion, Subscription
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/superadmin", tags=["superadmin-promotions"])


# ── Helpers ──


def _ensure_utc(value: datetime) -> datetime:
    """Coerce a naive datetime to UTC-aware; pass through aware values."""
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def _validate_window_and_bounds(
    starts_at: datetime,
    ends_at: datetime,
    free_cycles: int,
    max_redemptions: int | None,
) -> None:
    """Mirror the DB CHECK constraints with friendly 400s before the write."""
    if ends_at <= starts_at:
        raise HTTPException(status_code=400, detail="ends_at must be after starts_at.")
    if free_cycles <= 0:
        raise HTTPException(status_code=400, detail="free_cycles must be greater than 0.")
    if max_redemptions is not None and max_redemptions <= 0:
        raise HTTPException(status_code=400, detail="max_redemptions must be greater than 0 (or null for uncapped).")


def _validate_eligible_plan_ids(session, plan_ids: list[int] | None) -> None:
    """Reject an eligible_plan_ids list that references non-existent plans.

    A dangling id would silently narrow the offer to nothing for that plan —
    a misconfiguration worth catching at write time, not at checkout.
    """
    if not plan_ids:
        return
    existing = set(session.execute(select(Plan.id).where(Plan.id.in_(plan_ids))).scalars())
    missing = sorted(set(plan_ids) - existing)
    if missing:
        raise HTTPException(status_code=400, detail=f"Unknown plan ids in eligible_plan_ids: {missing}")


def _promotion_stats(session, promo_id: int) -> dict:
    """Redemption + conversion funnel for a campaign, from its subscriptions.

    ``slots_claimed`` (the atomic checkout counter) can lead
    ``subscriptions_created`` (rows minted by the activation webhook) because a
    slot is claimed at checkout before the mandate authorises — the gap is
    in-flight or abandoned checkouts.
    """
    now = datetime.now(UTC)

    status_rows = session.execute(
        select(Subscription.status, func.count())
        .where(Subscription.promotion_id == promo_id)
        .group_by(Subscription.status)
    ).all()
    by_status = {str(status): int(count) for status, count in status_rows}

    # Converted = still active AND past the free period → a real charge has begun.
    converted = session.execute(
        select(func.count())
        .select_from(Subscription)
        .where(
            Subscription.promotion_id == promo_id,
            Subscription.status == "active",
            Subscription.promo_free_until.is_not(None),
            Subscription.promo_free_until <= now,
        )
    ).scalar_one()

    # Still inside the free window right now (active or trialing, charge ahead).
    in_free_period = session.execute(
        select(func.count())
        .select_from(Subscription)
        .where(
            Subscription.promotion_id == promo_id,
            Subscription.status.in_(("active", "trialing")),
            Subscription.promo_free_until.is_not(None),
            Subscription.promo_free_until > now,
        )
    ).scalar_one()

    return {
        "subscriptions_created": sum(by_status.values()),
        "by_status": by_status,
        "converted": int(converted),
        "in_free_period": int(in_free_period),
    }


def _serialize(promo: Promotion, stats: dict | None = None) -> dict:
    """Full admin projection — unlike the client-facing ``serialize_public``,
    this exposes the internal counters a super admin needs."""
    data = {
        "id": promo.id,
        "code": promo.code,
        "name": promo.name,
        "is_active": promo.is_active,
        "starts_at": promo.starts_at.isoformat() if promo.starts_at else None,
        "ends_at": promo.ends_at.isoformat() if promo.ends_at else None,
        "free_cycles": promo.free_cycles,
        "eligible_plan_ids": (list(promo.eligible_plan_ids) if promo.eligible_plan_ids else None),
        "max_redemptions": promo.max_redemptions,
        "slots_claimed": promo.redeemed_count,
        "created_at": promo.created_at.isoformat() if promo.created_at else None,
        "updated_at": promo.updated_at.isoformat() if promo.updated_at else None,
    }
    if stats is not None:
        data["stats"] = stats
    return data


# ── Request models ──


class CreatePromotionRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    code: str | None = Field(default=None, max_length=64)
    starts_at: datetime
    ends_at: datetime
    free_cycles: int = Field(default=3, ge=1, le=36)
    eligible_plan_ids: list[int] | None = None
    max_redemptions: int | None = Field(default=None, ge=1)
    is_active: bool = True


class UpdatePromotionRequest(BaseModel):
    """All fields optional — only provided fields are modified (PATCH-style PUT).

    ``is_active`` is the pause switch: ``{"is_active": false}`` freezes new
    redemptions instantly without deleting the campaign or touching the
    subscriptions already on it.
    """

    name: str | None = Field(default=None, min_length=1, max_length=120)
    code: str | None = Field(default=None, max_length=64)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    free_cycles: int | None = Field(default=None, ge=1, le=36)
    eligible_plan_ids: list[int] | None = None
    max_redemptions: int | None = Field(default=None, ge=1)
    is_active: bool | None = None


# ── Routes ──


@router.get("/promotions")
def list_promotions(superadmin: Client = Depends(get_superadmin)):
    """All promotions, newest first, each with its redemption/conversion stats."""
    with get_session() as session:
        promos = session.execute(select(Promotion).order_by(Promotion.created_at.desc())).scalars().all()
        return {"promotions": [_serialize(p, _promotion_stats(session, p.id)) for p in promos]}


@router.get("/promotions/{promotion_id}")
def get_promotion(promotion_id: int, superadmin: Client = Depends(get_superadmin)):
    """A single promotion with its stats."""
    with get_session() as session:
        promo = session.get(Promotion, promotion_id)
        if promo is None:
            raise HTTPException(status_code=404, detail="Promotion not found.")
        return _serialize(promo, _promotion_stats(session, promo.id))


@router.get("/promotions/{promotion_id}/redemptions")
def list_promotion_redemptions(promotion_id: int, superadmin: Client = Depends(get_superadmin)):
    """The customers who redeemed this promotion.

    One row per subscription carrying this ``promotion_id`` (a redemption is a
    subscription minted through the offer), newest first, joined to the client,
    bot, and plan. ``status`` is the subscription's lifecycle (active / past_due
    / canceled / expired) so a superadmin can see who is still in the free
    period, who converted to paid, and who churned.
    """
    with get_session() as session:
        promo = session.get(Promotion, promotion_id)
        if promo is None:
            raise HTTPException(status_code=404, detail="Promotion not found.")

        rows = session.execute(
            select(Subscription, Client, Bot, Plan)
            .join(Client, Client.id == Subscription.client_id)
            .outerjoin(Bot, Bot.id == Subscription.bot_id)
            .outerjoin(Plan, Plan.id == Subscription.plan_id)
            .where(Subscription.promotion_id == promotion_id)
            .order_by(Subscription.created_at.desc())
        ).all()

        now = datetime.now(UTC)
        redemptions = [
            {
                "subscription_id": sub.id,
                "status": sub.status,
                "client_id": sub.client_id,
                "client_name": client.name if client else None,
                "client_email": client.email if client else None,
                "bot_id": sub.bot_id,
                "bot_name": bot.name if bot else None,
                "plan_name": plan.name if plan else None,
                "promo_free_until": sub.promo_free_until.isoformat() if sub.promo_free_until else None,
                # Convenience flags for the UI: still in the free window vs past it.
                "in_free_period": bool(sub.promo_free_until and _ensure_utc(sub.promo_free_until) > now),
                "redeemed_at": sub.created_at.isoformat() if sub.created_at else None,
            }
            for sub, client, bot, plan in rows
        ]
        return {
            "promotion": _serialize(promo, _promotion_stats(session, promo.id)),
            "redemptions": redemptions,
        }


@router.post("/promotions")
def create_promotion(request: CreatePromotionRequest, superadmin: Client = Depends(get_superadmin)):
    """Create a campaign. ``code`` must be unique when set (409 on clash)."""
    _require_write(superadmin)
    starts_at = _ensure_utc(request.starts_at)
    ends_at = _ensure_utc(request.ends_at)
    _validate_window_and_bounds(starts_at, ends_at, request.free_cycles, request.max_redemptions)

    with get_session() as session:
        _validate_eligible_plan_ids(session, request.eligible_plan_ids)
        promo = Promotion(
            name=request.name,
            code=(request.code or None),
            starts_at=starts_at,
            ends_at=ends_at,
            free_cycles=request.free_cycles,
            eligible_plan_ids=request.eligible_plan_ids or None,
            max_redemptions=request.max_redemptions,
            is_active=request.is_active,
        )
        session.add(promo)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(status_code=409, detail="A promotion with this code already exists.") from None
        session.refresh(promo)
        logger.info("Superadmin %s created promotion %s (%s)", superadmin.id, promo.id, promo.name)
        return _serialize(promo, _promotion_stats(session, promo.id))


@router.put("/promotions/{promotion_id}")
def update_promotion(
    promotion_id: int,
    request: UpdatePromotionRequest,
    superadmin: Client = Depends(get_superadmin),
):
    """Update a campaign. Only provided fields change; ``is_active`` toggles pause."""
    _require_write(superadmin)
    updates = request.model_dump(exclude_unset=True)

    with get_session() as session:
        promo = session.get(Promotion, promotion_id)
        if promo is None:
            raise HTTPException(status_code=404, detail="Promotion not found.")

        if "starts_at" in updates and updates["starts_at"] is not None:
            updates["starts_at"] = _ensure_utc(updates["starts_at"])
        if "ends_at" in updates and updates["ends_at"] is not None:
            updates["ends_at"] = _ensure_utc(updates["ends_at"])

        # Validate the EFFECTIVE window/bounds (merge provided over current).
        _validate_window_and_bounds(
            updates.get("starts_at", promo.starts_at),
            updates.get("ends_at", promo.ends_at),
            updates.get("free_cycles", promo.free_cycles),
            updates.get("max_redemptions", promo.max_redemptions),
        )
        if "eligible_plan_ids" in updates:
            _validate_eligible_plan_ids(session, updates["eligible_plan_ids"])
            updates["eligible_plan_ids"] = updates["eligible_plan_ids"] or None
        if "code" in updates:
            updates["code"] = updates["code"] or None

        for field, value in updates.items():
            setattr(promo, field, value)

        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(status_code=409, detail="A promotion with this code already exists.") from None
        session.refresh(promo)
        logger.info("Superadmin %s updated promotion %s (%s)", superadmin.id, promo.id, list(updates))
        return _serialize(promo, _promotion_stats(session, promo.id))


@router.delete("/promotions/{promotion_id}")
def delete_promotion(promotion_id: int, superadmin: Client = Depends(get_superadmin)):
    """Delete a campaign. Subscriptions created under it keep their history —
    ``Subscription.promotion_id`` is ``ON DELETE SET NULL`` — so deleting is safe
    for cleanup, but PAUSING (``is_active=false``) is preferred to preserve the
    per-campaign stats link."""
    _require_write(superadmin)
    with get_session() as session:
        promo = session.get(Promotion, promotion_id)
        if promo is None:
            raise HTTPException(status_code=404, detail="Promotion not found.")
        session.delete(promo)
        session.commit()
        logger.info("Superadmin %s deleted promotion %s", superadmin.id, promotion_id)
        return {"deleted": True, "id": promotion_id}
