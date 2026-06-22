"""Bot-seat add-on service — buy and release purchasable bot seats.

A "bot seat" is a paid add-on that raises the client's effective bot
allowance above their plan's included quota (``limits.bots``). The
effective limit is computed in :mod:`plan_entitlements_service` as
``min(limits.bots + client.extra_bot_seats, limits.max_bots_cap)`` — so
the work here is purely to mutate ``Client.extra_bot_seats`` after the
right validations, then invalidate the entitlements cache so subsequent
requests see the new ceiling immediately.

## Why this mirrors operator-seat semantics, not topups

Operator seats (``update_seat_quantity`` in billing_service.py) maintain
a quantity column on the subscription and let the provider's renewal
invoice reflect the change — the route updates the counter synchronously
and trusts upstream proration to do the math at the next billing cycle.
We follow the same pattern: ``change_bot_seats`` is the canonical write,
and a follow-up will hook the count into provider subscription items so
the next invoice charges ``extra_bot_seats × $5``. Treating bot seats as
one-off Checkout topups would be wrong — they're a recurring quantity,
not a one-time spend.

## Why not a separate add-on subscription

Two distinct Stripe/Razorpay subscriptions per customer would double the
webhook surface, fragment invoice history, and double the "plan changes"
the entitlements cache has to invalidate. Keeping the seat as a counter
on the base Client row (mirroring how ``Client.max_bots`` lives on
Client) keeps every existing billing path unaware of the add-on while
the entitlements service does the math.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Bot, Client
from app.services import plan_entitlements_service

logger = logging.getLogger(__name__)


# ── Errors raised to the route layer ──────────────────────────────────────


class BotSeatError(ValueError):
    """Base class so routes can translate to HTTP 400 in one place."""


class FreePlanError(BotSeatError):
    """Free plan can't purchase add-ons — must upgrade first."""


class HardCapReached(BotSeatError):
    """The plan's ``max_bots_cap`` has been hit."""


class WouldStrandActiveBots(BotSeatError):
    """Decrement would drop the effective limit below the active bot count."""


class PricingNotConfigured(BotSeatError):
    """PricingConfig is missing the bot-seat price keys."""


# ── Response payload ──────────────────────────────────────────────────────


@dataclass
class BotSeatState:
    """Snapshot of a client's bot-seat situation for the UI to render.

    Returned by both the read and write endpoints so the Billing page and
    the upgrade modal can show "X of Y bots used" and the next-purchase
    impact without a second round-trip.
    """

    plan_slug: str
    included_bots: int  # plan.limits.bots — never changes per purchase
    extra_bot_seats: int  # what the client has bought
    effective_limit: int  # included + extra, capped at hard ceiling
    hard_cap: int  # plan.limits.max_bots_cap (-1 = unlimited)
    active_bots: int  # current Bot rows owned by this client
    can_purchase: bool  # convenience flag for the UI
    price_usd_cents: int | None
    price_inr_paise: int | None

    def to_json(self) -> dict[str, Any]:
        return {
            "plan_slug": self.plan_slug,
            "included_bots": self.included_bots,
            "extra_bot_seats": self.extra_bot_seats,
            "effective_limit": self.effective_limit,
            "hard_cap": self.hard_cap,
            "active_bots": self.active_bots,
            "can_purchase": self.can_purchase,
            "price_usd_cents": self.price_usd_cents,
            "price_inr_paise": self.price_inr_paise,
        }


# ── Read ──────────────────────────────────────────────────────────────────


def get_state(session: Session, client_id: int) -> BotSeatState:
    """Build the current snapshot for the requesting client.

    Reads entitlements (which already does the included/cap/pricing
    resolution) and joins the live Bot count.
    """
    ent = plan_entitlements_service.get_entitlements(client_id, session, include_usage=True)
    pricing = ent.bot_seat_pricing or {}
    return BotSeatState(
        plan_slug=ent.plan_slug,
        included_bots=int(ent.limits.get("bots") or 0),
        extra_bot_seats=int(ent.extra_bot_seats),
        effective_limit=ent.limit_for("bots"),
        hard_cap=int(ent.limits.get("max_bots_cap") or 0),
        active_bots=int(ent.usage.get("bots") or 0),
        can_purchase=ent.can_purchase_bot_seat(),
        price_usd_cents=pricing.get("usd_cents"),
        price_inr_paise=pricing.get("inr_paise"),
    )


# ── Write ─────────────────────────────────────────────────────────────────


def change_bot_seats(session: Session, client: Client, delta: int) -> BotSeatState:
    """Add or remove paid bot seats. ``delta`` must be non-zero.

    Validation order is the same as the operator-seat route: cheap checks
    first (zero delta, Free plan), then plan-level (hard cap), then
    expensive checks (active bot count for decrements). On success the
    column is written and the entitlements cache is invalidated so the
    next request sees the new effective limit.

    Returns the post-write state. Raises a typed BotSeatError on
    validation failure so the route can translate to HTTP 400 with the
    user-facing message.

    Note on billing: this only updates the local counter. The actual
    provider-side billing adjustment (Stripe subscription item quantity
    or Razorpay addon) is hooked into the renewal invoice via a follow-up
    — same maturity level as ``billing_service.update_seat_quantity`` for
    operator seats. The customer is told this is recurring; the next
    renewal invoice will reflect the new quantity.
    """
    if delta == 0:
        raise BotSeatError("Delta must be non-zero.")

    # Refresh entitlements so the validation below uses the latest plan +
    # current count, not a stale snapshot from before a recent upgrade.
    plan_entitlements_service.invalidate(client.id)
    ent = plan_entitlements_service.get_entitlements(client.id, session)

    if ent.plan_slug == "free":
        raise FreePlanError(
            "Free plans don't include paid bot seats. Upgrade to Starter or Standard to add bots.",
        )

    if not ent.bot_seat_pricing:
        raise PricingNotConfigured(
            "Bot-seat pricing isn't configured. Contact support.",
        )

    current_extra = int(client.extra_bot_seats or 0)
    new_extra = current_extra + delta
    if new_extra < 0:
        raise BotSeatError("Cannot release more seats than you've purchased.")

    included = int(ent.limits.get("bots") or 0)
    cap = ent.limits.get("max_bots_cap")
    if cap is not None and int(cap) != -1:
        new_effective = min(included + new_extra, int(cap))
        if delta > 0 and (included + current_extra) >= int(cap):
            raise HardCapReached(
                f"You've reached the {int(cap)}-bot ceiling on the {ent.plan_name} plan. Upgrade to add more.",
            )
    else:
        new_effective = included + new_extra

    # Decrement guard: never let a release strand bots above the new cap.
    # Without this the customer could buy 2 seats, create 3 bots, release
    # both seats, and have 3 bots active under a 1-bot effective limit.
    if delta < 0:
        active_bots = int(
            session.execute(
                select(func.count(Bot.id)).where(
                    Bot.client_id == client.id,
                    Bot.is_active.is_(True),
                )
            ).scalar_one()
            or 0
        )
        if active_bots > new_effective:
            raise WouldStrandActiveBots(
                f"You have {active_bots} active bots — delete "
                f"{active_bots - new_effective} before releasing this seat.",
            )

    client.extra_bot_seats = new_extra
    session.flush()

    plan_entitlements_service.invalidate(client.id)
    logger.info(
        "client=%s bot seats %d → %d (delta=%+d, plan=%s)",
        client.id,
        current_extra,
        new_extra,
        delta,
        ent.plan_slug,
    )

    return get_state(session, client.id)
