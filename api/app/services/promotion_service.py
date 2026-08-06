"""Launch-promotion eligibility + slot accounting.

A :class:`~app.db.models.Promotion` is a time-boxed acquisition offer — e.g.
"sign up this month, 3 months free". This module owns the read side (is this
client eligible for an active offer on this plan?) and the write side (claim a
redemption slot atomically). The *billing* mechanics — deferring the first
charge via a Razorpay ``start_at`` — live in ``razorpay_service`` and the
checkout route; this module only decides *whether* the offer applies and for
how many free cycles.

Mirrors the shape of ``discount_service.resolve_customer_discount_bps`` so the
checkout route resolves a promo the same way it resolves a referral discount.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.dates import add_months
from app.db.models import Client, Plan, Promotion, Subscription

logger = logging.getLogger(__name__)


def _as_utc(value: datetime | None) -> datetime | None:
    """Coerce a possibly-naive datetime to UTC-aware, or return None."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def _active_promotions_in_window(session: Session, now: datetime):
    """Active promotions whose signup window covers ``now`` (most recent first)."""
    stmt = (
        select(Promotion)
        .where(
            Promotion.is_active.is_(True),
            Promotion.starts_at <= now,
            Promotion.ends_at >= now,
        )
        .order_by(Promotion.starts_at.desc())
    )
    return session.execute(stmt).scalars()


def resolve_active_promotion(
    session: Session,
    client: Client,
    plan: Plan,
    *,
    now: datetime | None = None,
) -> Promotion | None:
    """Return the active promotion this client qualifies for on ``plan``, or None.

    Eligibility (all must hold):
      * the promotion is active (pause switch on) and ``now`` is within its
        ``[starts_at, ends_at]`` window;
      * the client signed up within that same window (``Client.created_at``);
      * ``plan`` is in ``eligible_plan_ids`` (or the offer targets all plans);
      * the client has not already redeemed this promotion (one per account);
      * the cap, if any, is not already exhausted (a soft pre-check — the hard
        guarantee is the atomic :func:`consume_slot`).

    When several promotions are live, the most recently started wins. This is the
    plan-specific resolver used by the checkout money-path.
    """
    now = now or datetime.now(UTC)
    for promo in _active_promotions_in_window(session, now):
        if _is_eligible(session, client, plan, promo, now):
            return promo
    return None


def resolve_client_promotion(
    session: Session,
    client: Client,
    *,
    now: datetime | None = None,
) -> Promotion | None:
    """The active promotion this client qualifies for, independent of any plan.

    Same window / one-per-account / cap checks as :func:`resolve_active_promotion`
    but WITHOUT the plan-eligibility filter — used by the billing UI to decide
    whether to show "Free for N months" and (via ``eligible_plan_ids``) which
    plans it covers. Checkout re-validates per-plan via
    :func:`resolve_active_promotion`, so this display-side call is never the gate.
    """
    now = now or datetime.now(UTC)
    for promo in _active_promotions_in_window(session, now):
        if _client_eligible(session, client, promo, now):
            return promo
    return None


def attribute_signup_code(session: Session, client_id: int, code: str | None) -> bool:
    """Stamp a launch-promo code on a freshly-created client, if it's real.

    Called at registration from the campaign link's ``?code=``. Stores the
    canonical ``Promotion.code`` (not the raw input) only when the code matches a
    known promotion — junk codes are silently ignored so a bad link never blocks
    signup and never persists noise. First-touch and immutable: never overwrites
    an already-attributed code. Returns True when a code was stamped.
    """
    normalized = _norm_code(code)
    if not normalized:
        return False
    client = session.get(Client, client_id)
    if client is None or getattr(client, "signup_promo_code", None):
        return False  # unknown client, or already attributed (first-touch)
    promo = session.execute(
        select(Promotion).where(func.lower(Promotion.code) == normalized).limit(1)
    ).scalar_one_or_none()
    if promo is None:
        return False
    client.signup_promo_code = promo.code
    return True


def _plan_eligible(plan: Plan, promo: Promotion) -> bool:
    """Whether ``plan`` is in the promotion's scope (all paid plans when unset)."""
    if not promo.eligible_plan_ids:
        return True
    try:
        allowed = {int(pid) for pid in promo.eligible_plan_ids}
    except (TypeError, ValueError):
        logger.warning("promotion %s has malformed eligible_plan_ids", promo.id)
        return False
    return plan.id in allowed


def _norm_code(value: str | None) -> str:
    """Canonical form for comparing promo codes — trimmed, case-insensitive."""
    return (value or "").strip().lower()


def _client_eligible(session: Session, client: Client, promo: Promotion, now: datetime) -> bool:
    """Link-exclusivity / window + one-per-account + cap — plan-independent gate.

    Gate depends on whether the promotion has a ``code``:
      * **Coded promo (link-exclusive):** the client must have signed up via that
        exact code (``Client.signup_promo_code``). Organic accounts — no code, or
        a different code — do NOT qualify. The active window (enforced by
        :func:`_active_promotions_in_window`) still bounds *when* the code works.
      * **Uncoded promo (public time-window):** the client must have signed up
        within ``[starts_at, ends_at]`` — the original inclusive behaviour.
    """
    if promo.code:
        if _norm_code(getattr(client, "signup_promo_code", None)) != _norm_code(promo.code):
            return False
    else:
        created = _as_utc(client.created_at)
        if created is None:
            return False
        if not (_as_utc(promo.starts_at) <= created <= _as_utc(promo.ends_at)):
            return False

    # One redemption per account, for this promotion, across the client's
    # whole subscription history (including cancelled promo subs — the free
    # period is not re-grantable).
    already_redeemed = session.execute(
        select(Subscription.id)
        .where(
            Subscription.client_id == client.id,
            Subscription.promotion_id == promo.id,
        )
        .limit(1)
    ).scalar_one_or_none()
    if already_redeemed is not None:
        return False

    cap_exhausted = promo.max_redemptions is not None and (promo.redeemed_count or 0) >= promo.max_redemptions
    return not cap_exhausted


def _is_eligible(
    session: Session,
    client: Client,
    plan: Plan,
    promo: Promotion,
    now: datetime,
) -> bool:
    """Full eligibility including plan scope — used by the checkout money-path."""
    if not _plan_eligible(plan, promo):
        return False
    return _client_eligible(session, client, promo, now)


def serialize_public(promo: Promotion | None) -> dict:
    """Shape a promotion for the billing UI. ``{"active": False}`` when None.

    Display-only projection — no internal counters (``redeemed_count``,
    ``max_redemptions``) are exposed to the client.
    """
    if promo is None:
        return {"active": False}
    return {
        "active": True,
        "id": promo.id,
        "name": promo.name,
        "free_cycles": promo.free_cycles,
        "ends_at": promo.ends_at.isoformat() if promo.ends_at else None,
        "eligible_plan_ids": ([int(pid) for pid in promo.eligible_plan_ids] if promo.eligible_plan_ids else None),
    }


def consume_slot(session: Session, promo: Promotion) -> bool:
    """Atomically claim one redemption slot. Returns True when claimed.

    Uncapped promotions always succeed (the increment is a running tally for
    reporting). Capped promotions use a guarded ``UPDATE ... WHERE
    redeemed_count < max_redemptions`` so concurrent checkouts can never
    oversell the cap — a zero-row result means the cap was hit between the
    eligibility read and here, and the caller must fall back to normal pricing.

    Does not commit — the caller owns the transaction so the slot claim and the
    subscription row land atomically.
    """
    if promo.max_redemptions is None:
        session.execute(
            update(Promotion).where(Promotion.id == promo.id).values(redeemed_count=Promotion.redeemed_count + 1)
        )
        return True

    result = session.execute(
        update(Promotion)
        .where(
            Promotion.id == promo.id,
            Promotion.redeemed_count < promo.max_redemptions,
        )
        .values(redeemed_count=Promotion.redeemed_count + 1)
    )
    return result.rowcount == 1


def free_period_end(promo: Promotion, start: datetime | None = None) -> datetime:
    """The moment the free period ends and the first real charge lands.

    ``start + free_cycles`` whole months. This value is used both as the
    Razorpay ``start_at`` (deferred first charge) and as
    ``Subscription.promo_free_until`` (drives reminder emails).
    """
    start = start or datetime.now(UTC)
    return add_months(start, promo.free_cycles)


def current_free_period_end(promo_free_until: datetime, now: datetime | None = None) -> datetime:
    """End of the free-window month that ``now`` falls in.

    Monthly boundaries are aligned to ``promo_free_until`` (the first-charge
    date), stepping back one whole month at a time. Returns the smallest
    boundary strictly greater than ``now`` — the end of the current free month.

    This is the per-period grant key for the free-window credit refresh. Because
    the boundaries land on ``promo_free_until`` and earlier (never later), they
    can never collide with a paid charge's key (Razorpay keys those on the paid
    period end, which is always after ``promo_free_until``), so the free refresh
    and the first real charge never double-grant.
    """
    now = _as_utc(now or datetime.now(UTC))
    end = _as_utc(promo_free_until)
    # promo_free_until is only a few months out, so this loop is tightly bounded.
    while add_months(end, -1) > now:
        end = add_months(end, -1)
    return end
