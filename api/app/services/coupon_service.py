"""Coupon resolution and redemption.

There was a ``coupons`` table and a superadmin CRUD for it, and no way to spend
one: checkout ran every code through a validator whose only outcomes were
"invalid" and "valid, but not redeemable online". This module is the realiser
that was missing.

A coupon resolves to exactly one of two shapes, and which one is decided by
``percent_off`` alone:

``free_months`` (``percent_off == 100``)
    N months at no charge, then the full price, delivered by deferring the
    Razorpay subscription's ``start_at``. The mandate is authorised once, for
    the full amount, and simply does not draw until the window ends. The same
    mechanism ``promotion_service`` already uses.

``discount_bps`` (``percent_off < 100``)
    A lower-amount plan that recurs for the life of the subscription, minted and
    cached by ``razorpay_service.resolve_discounted_plan``. The same mechanism a
    referral code already uses.

Neither ever needs the customer to re-authorise anything, which is the whole
reason the third shape (a partial discount that expires) is refused at the API
and by a CHECK constraint: expiring a partial discount means moving the
subscription from the discounted plan to the full-price one, and a plan change
on this gateway is a cancel, a recreate, and a re-auth mail
(``transition_service.promote_scheduled_change``). That would land a
"re-authorise your payment" email on every discounted customer in the month
their discount ended.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.db.models import Client, Coupon

# A month, for the purpose of a free window. Calendar months would make the
# window's length depend on when it was claimed, and a coupon sold as "3 months
# free" should be worth the same in February as in March.
DAYS_PER_MONTH = 30


class CouponError(ValueError):
    """A coupon that cannot be honoured, carrying the reason to show the buyer."""


@dataclass(frozen=True)
class CouponGrant:
    """What a resolved coupon is worth, in terms the checkout path can spend."""

    coupon_id: int
    code: str
    #: Basis points off the recurring price, for the life of the subscription.
    #: Zero when this coupon grants free months instead.
    discount_bps: int
    #: Whole months at no charge before the first real debit. Zero when this
    #: coupon grants a recurring discount instead.
    free_months: int

    @property
    def is_free_period(self) -> bool:
        return self.free_months > 0

    def free_period_end(self, now: datetime) -> datetime:
        """When the first real charge falls due."""
        return now + timedelta(days=DAYS_PER_MONTH * self.free_months)


def _normalise(code: str | None) -> str:
    return (code or "").strip()


def find_active(session: Session, code: str | None) -> Coupon | None:
    """The coupon for this code, or None. Case-insensitive, as typed."""
    normalised = _normalise(code)
    if not normalised:
        return None
    return session.execute(select(Coupon).where(func.lower(Coupon.code) == normalised.lower())).scalar_one_or_none()


def resolve(session: Session, code: str | None, *, plan_id: int | None = None) -> CouponGrant | None:
    """Resolve a code into what it grants, or raise ``CouponError`` saying why not.

    Returns None for an empty code, so the caller can treat "no coupon" and "a
    coupon that happens to grant nothing" the same way: as full price.

    Every refusal is a distinct message. "Invalid or expired" for all four of
    unknown, paused, lapsed and exhausted tells a customer with a genuinely
    valid code for another plan to go and look for a typo that is not there.
    """
    normalised = _normalise(code)
    if not normalised:
        return None

    coupon = find_active(session, normalised)
    if coupon is None:
        raise CouponError("That code is not recognised.")
    if not coupon.is_active:
        raise CouponError("That code is no longer active.")

    now = datetime.now(UTC)
    expires_at = coupon.expires_at
    if expires_at is not None:
        # A naive column value means the DB handed back a timestamp without a
        # zone; compare it as UTC rather than crash on the mixed comparison.
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        if expires_at <= now:
            raise CouponError("That code has expired.")

    if coupon.max_redemptions is not None and (coupon.redemptions or 0) >= coupon.max_redemptions:
        raise CouponError("That code has been fully redeemed.")

    eligible = coupon.applies_to_plan_ids
    if eligible and plan_id is not None and plan_id not in eligible:
        raise CouponError("That code does not apply to this plan.")

    percent = int(coupon.percent_off or 0)
    if percent <= 0:
        # ``amount_off_cents`` is a flat-amount discount the recurring path
        # cannot express: a plan is minted at one amount, and a flat sum off a
        # monthly price is a different percentage of every plan it touches.
        raise CouponError("That code cannot be applied to a subscription.")

    if percent >= 100:
        months = int(coupon.duration_months or 0)
        if months <= 0:
            # 100% off forever is a free plan, not a coupon.
            raise CouponError("That code is not configured for subscriptions.")
        return CouponGrant(coupon_id=coupon.id, code=coupon.code, discount_bps=0, free_months=months)

    return CouponGrant(coupon_id=coupon.id, code=coupon.code, discount_bps=percent * 100, free_months=0)


def consume(session: Session, grant: CouponGrant) -> bool:
    """Claim one redemption, atomically. False when the cap was just exhausted.

    A guarded UPDATE rather than read-then-write: two checkouts resolving the
    last slot of a capped coupon at the same time would both read
    ``redemptions < max_redemptions`` and both increment, overselling the cap.
    The WHERE clause makes the losing writer update zero rows.
    """
    result = session.execute(
        update(Coupon)
        .where(
            Coupon.id == grant.coupon_id,
            Coupon.is_active.is_(True),
            (Coupon.max_redemptions.is_(None)) | (Coupon.redemptions < Coupon.max_redemptions),
        )
        .values(redemptions=Coupon.redemptions + 1)
    )
    return bool(result.rowcount)


def attach(session: Session, client_id: int, grant: CouponGrant) -> None:
    """Record the standing attribution, so a later plan change keeps the discount.

    Idempotent and first-touch, matching ``affiliate_service.attribute_signup``:
    an account already on a coupon keeps the one it has. Re-running with the
    same coupon is a no-op rather than a second redemption.
    """
    client = session.get(Client, client_id)
    if client is None or client.coupon_id is not None:
        return
    client.coupon_id = grant.coupon_id
    client.coupon_attributed_at = datetime.now(UTC)


def standing_discount_bps(session: Session, client: Client) -> tuple[int, dict | None]:
    """The recurring discount from the client's attached coupon, for the provider layer.

    The twin of ``discount_service.resolve_customer_discount_bps``. Returns
    ``(0, None)`` for a free-months coupon: that grant is spent once, at
    checkout, as a deferred start date, and re-applying it on a later plan
    change would hand out the free window a second time.
    """
    coupon_id = getattr(client, "coupon_id", None)
    if not coupon_id:
        return 0, None
    coupon = session.get(Coupon, coupon_id)
    if coupon is None or not coupon.is_active:
        return 0, None
    percent = int(coupon.percent_off or 0)
    if percent <= 0 or percent >= 100:
        return 0, None
    return percent * 100, {"coupon_id": str(coupon.id), "coupon_code": coupon.code, "discount_bps": str(percent * 100)}
