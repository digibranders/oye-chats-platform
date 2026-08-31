"""Client-facing subscription, credit, and billing endpoints.

Powers the admin dashboard's Credits page: balance, ledger history,
top-up checkout, plan changes, operator-seat add-ons, invoices, and
subscription cancellation. Razorpay webhook handling lives in
``webhook_billing_routes``; all billing logic is in ``razorpay_service``.
"""

import json
import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import config as app_config
from app.api.auth import get_current_client_or_operator, require_verified_email
from app.api.auth import get_current_client_strict as get_current_client
from app.config import (
    BILLING_PROVIDER,
    DISPLAY_USD_TO_INR,
    INTL_PAYMENTS_ENABLED,
    RAZORPAY_ENABLED,
)
from app.core.dates import add_months
from app.core.geo import resolve_country
from app.core.gstin import VALID_STATE_CODES, is_valid_gstin, normalize_gstin
from app.core.pricing import annual_saving_percent, format_amount, resolve_billing_context, seat_price
from app.core.rate_limit import money_route_limit
from app.core.tax import gross_charge_minor
from app.db.models import Bot, Client, CreditLedger, Invoice, Plan, Subscription
from app.db.session import get_session
from app.schemas.validators import (
    EmailAddress,
    GatewayRef,
    GatewaySignature,
    MediumText,
    Name,
    RowId,
    SmallJsonObject,
)
from app.services import credit_service, invoice_service, plan_entitlements_service, razorpay_customer_service
from app.services.plan_service import (
    get_account_subscription,
    get_active_plans,
    get_client_plan,
    get_client_subscription,
    get_subscription_for_bot,
    has_used_trial,
    lock_client_for_billing,
)
from app.services.razorpay_service import TRIAL_CONVERSION_NOTE
from app.services.seat_math import UNLIMITED_SEATS as _UNLIMITED_SEATS
from app.services.seat_math import seat_ceiling_blocks, seat_floor_for
from app.services.seller_profile_service import charge_tax_rate_bps

logger = logging.getLogger(__name__)

# Absolute safety ceiling on operator seats when a plan defines no
# ``limits.operators``. Stops an unbounded seat delta from minting hundreds of
# seat charges in a single call (§5).
_MAX_OPERATOR_SEATS_ABSOLUTE = 100

# How long a client should wait before re-reading ``GET /subscriptions/current``
# while a paid subscription is still activating. Returned as
# ``retry_after_seconds`` from ``/verify-razorpay-subscription``.
#
# Honest provenance: this is NOT measured. A real value wants the distribution
# of "payment captured → local row exists" across live mandates, and that data
# is in production, which this work is not permitted to touch. What the incident
# does establish is a floor and a ceiling:
#
# * The floor: 3s is demonstrably too eager. The old frontend re-fetched at 0s
#   and 3s and stopped; at 3s the mandate still read ``created`` and the
#   customer saw no plan change.
# * The ceiling: a customer gave up and re-bought at 44s, so any budget under a
#   minute is inside the window where people take matters into their own hands.
#
# 5s is chosen as a cadence between those: fast enough that activation feels
# immediate when the webhook lands in the usual couple of seconds, slow enough
# that a two-minute wait is 24 polls rather than 40. The number that actually
# matters is not this one but the caller's give-up budget, which is why the
# field is documented as a cadence and the response says to poll until
# ``activation_pending`` clears. Replace this with a measured p95 the first time
# anyone can query production for it.
ACTIVATION_POLL_SECONDS = 5

router = APIRouter(prefix="/subscriptions", tags=["subscriptions"])

# monthly | annual, the only two cycles the plan catalog and the gateway
# plan ids are built for. Previously a bare ``str``: an unrecognised cycle
# fell through to the monthly branch instead of being refused.
BillingCycle = Literal["monthly", "annual"]

# Promo / coupon code as typed at checkout. Looked up verbatim.
CouponCode = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_\-]+$"),
]

# Seats added or removed in one request. Each unit is a real charge against
# the customer's mandate, so the delta is bounded, an unbounded one is an
# unbounded invoice. Well above any realistic single adjustment.
_MAX_SEAT_DELTA = 500
credits_router = APIRouter(prefix="/credits", tags=["credits"])


def _resolve_target_subscription(session, client_id: int, bot_id: int | None):
    """Resolve the subscription a mutation should act on (remediation N3).

    When ``bot_id`` is given, target that bot's own subscription so a client with
    several per-bot subscriptions can cancel/resume/reseat a specific one. An
    agent with NO subscription of its own draws on the account plan, so we fall
    back to it. Matching ``get_current_subscription`` and
    ``_resolve_invoice_scope``.

    That fallback is the whole point: without it the READ path fell back while
    the WRITE path did not, so Billing displayed the account plan (correctly)
    next to Cancel / Reactivate / Add-seat buttons that all 404'd with
    "No active subscription found" whenever an agent was selected in the
    switcher. The mutation must act on the subscription the customer is
    actually looking at.

    The fallback goes through ``get_account_subscription`` (``bot_id IS NULL``)
    and NOT ``get_client_subscription``. The latter spans per-bot rows and
    returns the highest-PRICED one. Correct for entitlements (H2), disastrous
    as a mutation target: with an unpaid agent selected it would resolve to a
    DIFFERENT agent's subscription, and ``/cancel`` would cancel that agent's
    Razorpay mandate. Razorpay has no un-cancel, so that is not customer
    recoverable. Same reasoning as the account-scoped guard in ``/checkout``.
    """
    if bot_id is not None:
        # Ownership first. Without this a bot_id the caller does NOT own falls
        # straight through to their own account subscription, so a mistyped or
        # copied id silently retargets a destructive action (cancel, seat
        # change) onto something the caller never named. There is no
        # cross-tenant leak either way (both resolvers filter by client_id);
        # the harm is acting on the wrong subscription without saying so.
        if not _client_owns_bot(session, client_id, bot_id):
            raise HTTPException(status_code=404, detail="Agent not found.")
        scoped = get_subscription_for_bot(session, client_id, bot_id)
        if scoped is not None:
            return scoped
    return get_account_subscription(session, client_id)


def _pooled_plan_scope_error(plan: Plan) -> HTTPException:
    """400 for "this plan is an ACCOUNT product, it cannot be bought per agent".

    A plan whose ``limits.bots`` is the ``UNLIMITED`` sentinel sells ONE credit
    pool shared across unlimited agents. Landed on a bot-scoped subscription its
    credits are granted and reset into that single bot's ISOLATED ledger
    (``credit_service.resolve_bot_ledger_bot_id``) while every further agent the
    tier entitles holds no subscription of its own and drains the shared pool the
    purchase never funded, one working agent and N silent ones.
    Raised only where the mutation would land the plan on an EXISTING bot-scoped
    subscription. ``POST /subscriptions/change-plan`` Branches 1/2a/2b and
    ``POST /subscriptions/resume``, plus ``POST /bots/checkout``, whose whole
    contract is per-agent. Where no subscription exists yet (``/change-plan``
    Branch 3) the request is DEMOTED to account scope instead: an account-scoped
    mandate is what the customer is buying, and refusing there simply made the
    tier unbuyable. ``razorpay_service._handle_subscription_activated`` still
    refuses to persist the state at the sink, whichever door a mandate came
    through.

    The message deliberately does NOT send the customer to "account-level
    Billing with no agent selected": ``BotContext`` resolves the shell to exactly
    one agent whenever the account has any, so that view no longer exists for
    them to reach. Self-service migration of an agency's existing per-agent
    subscriptions onto a pooled tier is an open product decision, so the only
    honest next step to offer is support.
    """
    return HTTPException(
        status_code=400,
        detail={
            "code": "plan_not_per_agent",
            "message": (
                f"The {plan.name} plan includes unlimited AI agents and is billed for your whole "
                "account, so it can't be bought for a single agent. Contact support and we'll move "
                f"your account onto {plan.name}. Your existing agents keep working."
            ),
        },
    )


def _client_owns_bot(session, client_id: int, bot_id: int) -> bool:
    """Does this bot belong to this workspace?"""
    return (
        session.execute(select(Bot.id).where(Bot.id == bot_id, Bot.client_id == client_id).limit(1)).first() is not None
    )


def effective_resets_at(sub: Subscription | None) -> datetime | None:
    """Return the next forward-looking reset date for this subscription.

    The renewal cron rolls ``current_period_end`` forward when it fires, but
    if the worker has been down (or hasn't caught up yet) the stored value
    can be in the past, which makes the UI's "Resets …" label show
    *yesterday*, which is obviously wrong.

    This helper computes the next reset *on read*: if the stored end is in
    the future we use it as-is; otherwise we advance by whole months (based
    on the original cycle length, default 1 month) until we land in the
    future. The DB row isn't mutated (the cron stays the source of truth
    for the actual renewal) we just make sure the user-facing label never
    lies.
    """
    if sub is None or sub.current_period_end is None:
        return None
    now = datetime.now(UTC)
    end = sub.current_period_end
    if end.tzinfo is None:
        end = end.replace(tzinfo=UTC)
    if end > now:
        return end
    start = sub.current_period_start
    if start is not None and start.tzinfo is None:
        start = start.replace(tzinfo=UTC)
    # Infer the cycle length. Round to nearest whole month; clamp to ≥ 1 so
    # a misconfigured row (start == end) doesn't hang in an infinite loop.
    cycle_months = 1
    if start is not None and end > start:
        approx_months = round((end - start).days / 30)
        cycle_months = max(1, approx_months)
    candidate = end
    # Cap the walk at a sane horizon (10 years) so a truly malformed row
    # can't loop forever, at that point we just return the latest computed
    # date and let the UI render whatever's there.
    for _ in range(120):
        if candidate > now:
            return candidate
        candidate = add_months(candidate, cycle_months)
    return candidate


def _resolve_provider() -> str:
    """Return the active billing provider (always razorpay)."""
    if not RAZORPAY_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
        )
    return "razorpay"


# ── Public: Pricing page ──


# Mandate lead time for eMandate / UPI pre-debit notification. A first debit
# scheduled sooner than this is one the gateway will not honour quietly.
_TRIAL_DEFER_FLOOR = timedelta(hours=48)


def resolve_trial_defer_at(
    *,
    trial_end: datetime | None,
    promo_start_at: datetime | None,
    now: datetime | None = None,
) -> datetime | None:
    """When a mid-trial purchase should take its FIRST debit, or None.

    The billing clock never moves: a customer who pays on day 3 keeps the
    eleven free days they were promised, so the mandate is minted with
    Razorpay's ``start_at`` at their trial end rather than charging today.

    Two adjustments, both customer-favourable. A consumed promo slot must be
    honoured, so the LATER of the two protections wins rather than the trial
    silently cancelling a longer free period. And the result is floored at 48
    hours out, which buys a day-13 buyer up to a day of extra grace.

    That floor is a safety margin, not a gateway rule, and the distinction was
    checked rather than assumed: probing Razorpay TEST on 2026-08-31, the
    subscriptions API accepted ``start_at`` at +30 minutes, +6 hours, +48 hours
    and +11 days alike, every one echoed back with zero drift. So the gateway
    will not refuse a near-term date at CREATION time. What the floor protects
    is the DEBIT: RBI's pre-debit notification applies to the charge, not to the
    subscription record, so a same-day first debit is the one plausibly at risk
    of failing later for want of notice. If that turns out to be unnecessary,
    ``_TRIAL_DEFER_FLOOR`` is the single constant to change, and shrinking it
    only ever moves a customer's first charge earlier.

    None when there is nothing to defer: no trial, or one that has already
    lapsed. Those buyers are charged normally.
    """
    reference = now or datetime.now(UTC)
    if trial_end is None:
        return None
    if trial_end.tzinfo is None:
        trial_end = trial_end.replace(tzinfo=UTC)
    if trial_end <= reference:
        return None
    candidates = [trial_end, reference + _TRIAL_DEFER_FLOOR]
    if promo_start_at is not None:
        candidates.append(promo_start_at)
    return max(candidates)


@router.get("/plans")
def list_plans():
    """Return every active PUBLIC plan for the pricing page. No auth required.

    ``is_public`` is the second filter. A row can be active (assignable, so
    ``get_default_plan`` can hand it to a signup) without ever being for sale,
    which is exactly what the 14-day trial row is.
    """
    with get_session() as session:
        plans = get_active_plans(session)
        return [
            {
                "id": p.id,
                "name": p.name,
                "slug": p.slug,
                "description": p.description,
                "pricing_model": p.pricing_model,
                "currency": p.currency,
                "monthly_price_cents": p.monthly_price_cents,
                "annual_price_cents": p.annual_price_cents,
                "monthly_price_usd_cents": p.monthly_price_usd_cents,
                "annual_price_usd_cents": p.annual_price_usd_cents,
                "extra_seat_price_usd_cents": p.extra_seat_price_usd_cents,
                # Derived from this payload's own prices, NOT the stored column.
                # See core.pricing.annual_saving_percent. The admin app derives
                # the same figure client-side (billingModel.annualSavingPercent);
                # serving the derived value is what keeps the two in agreement.
                "annual_discount_percent": annual_saving_percent(p.monthly_price_cents, p.annual_price_cents),
                "trial_days": p.trial_days,
                "credits_per_month": p.credits_per_month,
                "included_operator_seats": p.included_operator_seats,
                "extra_seat_price_cents": p.extra_seat_price_cents,
                "limits": p.limits,
                "features": p.features,
                "overage_rate_cents": p.overage_rate_cents,
                "sort_order": p.sort_order,
            }
            for p in plans
        ]


# ── Authenticated: Launch promotion (display) ──


@router.get("/promo")
def get_active_promotion(client: Client = Depends(get_current_client)):
    """The launch promotion the current client qualifies for, for billing display.

    Returns ``{"active": false}`` when none applies, else a display projection
    (``free_cycles``, ``ends_at``, ``eligible_plan_ids``). This is DISPLAY ONLY.
    Checkout independently re-validates eligibility server-side before deferring
    any charge, so a stale or forged response can never grant the offer.
    """
    from app.services import promotion_service

    with get_session() as session:
        # The dependency-provided client is detached; re-read in-session so the
        # eligibility query and created_at read are against a live row.
        row = session.get(Client, client.id) or client
        promo = promotion_service.resolve_client_promotion(session, row)
        return promotion_service.serialize_public(promo)


# ── Authenticated: Current subscription ──


@router.get("/current")
def get_current_subscription(
    auth: dict = Depends(get_current_client_or_operator),
    bot_id: int | None = None,
):
    """Return the current workspace's subscription details + plan info.

    Resolved via ``get_current_client_or_operator`` (not strict-client) so an
    invited operator presenting their own ``X-API-Key`` together with the
    switched workspace's ``X-Workspace-Id`` reads the WORKSPACE OWNER's plan,
    not their own personal Free plan. The LiveChat UI feature-gates on this
    response. Reading the wrong client's plan is what made "Live chat isn't
    included in your plan" appear on the operator's Support surface even
    though the workspace owner is on Standard.

    When ``bot_id`` is given (the per-agent Billing overview), resolve that
    agent's OWN subscription + plan instead of the account default, so the
    overview shows the money attached to the selected agent. ``bot_id`` is
    scoped by ``client_id`` inside ``get_subscription_for_bot``, so a foreign
    id simply yields no subscription rather than another workspace's plan.
    """
    client_id = auth["client_id"]
    with get_session() as session:
        if bot_id is not None:
            sub = get_subscription_for_bot(session, client_id, bot_id)
            if sub is not None:
                plan = sub.plan if sub.plan_id else None
            else:
                # The agent has no subscription of its own, it draws from the
                # shared account plan, so surface that instead of an empty panel.
                sub = get_client_subscription(session, client_id)
                plan = get_client_plan(session, client_id)
        else:
            sub = get_client_subscription(session, client_id)
            plan = get_client_plan(session, client_id)

        sub_data = None
        if sub:
            # Inline the queued change so the Billing page can render its
            # banner ("Switching to Starter on Aug 15. Cancel") off a single
            # call instead of fetching plans separately to resolve the name.
            scheduled_plan = None
            if sub.scheduled_plan_id:
                scheduled_plan = session.get(Plan, sub.scheduled_plan_id)

            sub_data = {
                "id": sub.id,
                "status": sub.status,
                "billing_cycle": sub.billing_cycle,
                "operator_quantity": sub.operator_quantity,
                "current_period_start": sub.current_period_start.isoformat() if sub.current_period_start else None,
                "current_period_end": sub.current_period_end.isoformat() if sub.current_period_end else None,
                "trial_start": sub.trial_start.isoformat() if sub.trial_start else None,
                "trial_end": sub.trial_end.isoformat() if sub.trial_end else None,
                # LEGACY. Wall-clock deadline for the post-trial data-purge
                # cron, and nothing sets it any more: a lapsed trial converts
                # to Free with nothing deleted. Non-NULL only on rows stamped
                # before 2026-08-28, which are draining. No surface should
                # render a deletion warning from it.
                "data_retention_until": (sub.data_retention_until.isoformat() if sub.data_retention_until else None),
                "canceled_at": sub.canceled_at.isoformat() if sub.canceled_at else None,
                "cancel_at_period_end": sub.cancel_at_period_end,
                "payment_provider": sub.payment_provider,
                "created_at": sub.created_at.isoformat() if sub.created_at else None,
                # Launch-promo free period end (first-charge date). Set only while
                # the subscription is on an offer; lets the UI show "Free until X"
                # so a promo customer knows they are not yet being billed.
                "promo_free_until": (sub.promo_free_until.isoformat() if sub.promo_free_until else None),
                "scheduled_change": (
                    {
                        "plan_id": sub.scheduled_plan_id,
                        "plan_slug": scheduled_plan.slug if scheduled_plan else None,
                        "plan_name": scheduled_plan.name if scheduled_plan else None,
                        "billing_cycle": sub.scheduled_billing_cycle,
                        "effective_at": sub.scheduled_change_at.isoformat() if sub.scheduled_change_at else None,
                    }
                    if sub.scheduled_plan_id
                    else None
                ),
            }

        # Downgrade re-auth grace state. During the window after a paid→paid
        # downgrade cutover, the customer sits on a short-lived ``past_due``
        # grace row on the TARGET plan (``transition_service.promote_scheduled_change``)
        # while they still owe the one-time authorization of the new UPI mandate.
        # ``sub.status`` reads ``past_due`` (which the billing UI would otherwise
        # render as a failed-payment banner) so surface a distinct signal the
        # frontend can turn into a "finish your downgrade" prompt instead. Only
        # populated for the grace row; ``None`` in every ordinary state.
        from app.services.transition_service import DOWNGRADE_REAUTH_GRACE_REASON

        reauth_data = None
        if sub is not None and sub.status == "past_due" and sub.cancel_reason == DOWNGRADE_REAUTH_GRACE_REASON:
            from app.config import PAYMENT_FAILED_GRACE_DAYS

            grace_until = None
            days_left = None
            if sub.past_due_since is not None:
                since = sub.past_due_since
                if since.tzinfo is None:
                    since = since.replace(tzinfo=UTC)
                grace_until_dt = since + timedelta(days=PAYMENT_FAILED_GRACE_DAYS)
                grace_until = grace_until_dt.isoformat()
                days_left = max(0, (grace_until_dt - datetime.now(UTC)).days)
            reauth_data = {
                "required": True,
                "reason": "downgrade_reauth",
                # ``plan`` here IS the grace row's plan. I.e. the tier the
                # customer downgraded TO and will keep if they re-authorize.
                "target_plan_name": plan.name if plan is not None else None,
                # Wall-clock deadline after which the grace row expires to Free
                # (``task_expire_past_due_subscriptions``), plus a rounded
                # days-left for the banner copy.
                "grace_until": grace_until,
                "days_left": days_left,
            }

        # Prices are published exclusive of tax, so every recurring figure this
        # payload carries is a BASE. The Billing page states the amount the
        # customer is actually debited, and the seat and branding cards quote a
        # price BEFORE any purchase response exists, so the grosses have to
        # travel here: without them those surfaces can only show the base or do
        # tax arithmetic in the browser, and the browser must never do it.
        current_tax_rate_bps = charge_tax_rate_bps(session)
        plan_currency = (plan.currency if plan is not None else "INR") or "INR"
        gross_kind = "export" if plan_currency.upper() == "USD" else "intra"

        def _gross(base_minor: int | None) -> int:
            return gross_charge_minor(int(base_minor or 0), rate_bps=current_tax_rate_bps, kind=gross_kind)

        seat_base_cents, _seat_currency = seat_price(
            inr_cents=app_config.RAZORPAY_SEAT_PLAN_PRICE_CENTS,
            usd_cents=app_config.EXTRA_SEAT_PRICE_USD_CENTS,
            currency=plan_currency,
        )
        branding_base_cents, _branding_currency = seat_price(
            inr_cents=app_config.RAZORPAY_BRANDING_PLAN_PRICE_CENTS,
            usd_cents=app_config.BRANDING_ADDON_PRICE_USD_CENTS,
            currency=plan_currency,
        )

        return {
            "subscription": sub_data,
            # Non-null only during a downgrade re-auth grace window (see above).
            "reauth": reauth_data,
            "tax_rate_bps": current_tax_rate_bps,
            # What each recurring line actually debits. Base figures stay on the
            # plan object below, unchanged, because they are what the invoice
            # carves back out and what the pricing page advertises.
            "gross_extra_seat_price_cents": _gross(seat_base_cents),
            "gross_branding_addon_price_cents": _gross(branding_base_cents),
            "gross_monthly_price_cents": _gross(plan.monthly_price_cents) if plan is not None else None,
            "gross_annual_price_cents": _gross(plan.annual_price_cents) if plan is not None else None,
            # ``plan`` can be None in the per-agent view when the selected agent
            # has no subscription of its own yet, the frontend renders that as
            # "no paid subscription", so emit null rather than dereferencing it.
            "plan": (
                {
                    "id": plan.id,
                    "name": plan.name,
                    "slug": plan.slug,
                    "description": plan.description,
                    "pricing_model": plan.pricing_model,
                    "currency": plan.currency,
                    "monthly_price_cents": plan.monthly_price_cents,
                    "annual_price_cents": plan.annual_price_cents,
                    # USD headline columns, the dashboard renders prices in USD,
                    # so these must travel with every plan payload (mirrors the
                    # /plans endpoint). Omitting them makes the UI read them as
                    # undefined and fall through to "No paid subscription".
                    "monthly_price_usd_cents": plan.monthly_price_usd_cents,
                    "annual_price_usd_cents": plan.annual_price_usd_cents,
                    "extra_seat_price_usd_cents": plan.extra_seat_price_usd_cents,
                    "credits_per_month": plan.credits_per_month,
                    "included_operator_seats": plan.included_operator_seats,
                    "extra_seat_price_cents": plan.extra_seat_price_cents,
                    "limits": plan.limits,
                    "features": plan.features,
                    "overage_rate_cents": plan.overage_rate_cents,
                }
                if plan is not None
                else None
            ),
            "billing": {
                "default_provider": BILLING_PROVIDER,
                "razorpay_enabled": RAZORPAY_ENABLED,
            },
            # Whether this client has ever held a trial. Since the 14-day
            # signup trial replaced the Standard-only offer there is no trial
            # to start from the Billing page, so this no longer gates a CTA;
            # it is retained as a read-only fact about the account, and the
            # rest of the payload's consumers still receive the same shape.
            "trial_used": has_used_trial(session, client_id),
        }


@router.get("/geo")
def get_billing_geo(request: Request, client: Client = Depends(get_current_client)):
    """Return the geo / currency profile the UI should render against.

    Single call so the Billing page and PlanModal don't have to fan out a
    per-plan quote, the frontend converts INR paise to its local USD with
    the returned ``display_rate`` (a paid plan's INR price is the source of
    truth; USD is informational until international payments is live).

    Includes the Razorpay public key so the React layer doesn't have to
    re-stuff it from a separate env / endpoint when opening the modal.

    ``display_currency`` is NOT unconditionally the charge currency, the four
    cases, and what keeps each of them honest:

    * ``stored`` IN → INR shown, INR charged.
    * ``stored`` non-IN → USD shown, and no INR debit can contradict it because
      the charge paths refuse instead of charging: top-up always 409s
      ``intl_usd_pending`` (``create_topup_order`` is INR-only), checkout 409s
      unless ``INTL_PAYMENTS_ENABLED`` puts it on the USD rail.
    * ``detected`` (IP geo) non-IN → USD shown while the charge path would
      confirm IN. This divergence is DELIBERATE: an IP signal is display-grade
      only, the frontend never echoes it back as ``billing_country``
      (``usePlanCheckout.ts``) and ``_resolve_confirmed_billing_country_or_409``
      never resolves on it. It cannot turn into a wrong charge because that same
      gate 409s ``billing_country_required`` whenever a foreign IP is the ONLY
      signal, so the customer confirms a country before any money moves.
    * ``unresolved`` (no stored country, no IP signal) → INR, because the gate
      treats an unconfirmed buyer as domestic. Reporting USD here (the old rule)
      was a live money bug: nothing 409s an unresolved country, so the top-up
      modal rendered $13/$50/$125 and Razorpay debited ₹1,000/₹4,000/₹10,000.

    That last case is why the currency is taken from ``resolve_billing_context``
    rather than re-derived: it routes through ``charge_currency``, the same
    helper the quote and the charge gate use, so this endpoint cannot drift
    from the rail it is describing.
    """
    from app.config import RAZORPAY_KEY_ID

    # The saved billing country is authoritative (set at checkout / billing
    # settings / onboarding); IP geo is only the fallback for accounts that
    # haven't chosen one yet. This is what makes "set the country once, and the
    # currency follows everywhere" hold across sessions.
    ctx = resolve_billing_context(
        stored_country=client.billing_country,
        detected_country=resolve_country(request),
    )
    # Only the domestic rail can carry Indian GST, so an export caller keeps
    # this endpoint DB-free rather than paying for a seller-profile read whose
    # answer is already known.
    tax_rate_bps = 0
    if ctx.currency == "INR":
        with get_session() as session:
            tax_rate_bps = charge_tax_rate_bps(session)
    return {
        "country": ctx.country,
        # Trust grade for the frontend: a "detected" (IP geo) country is
        # DISPLAY-ONLY and must never be echoed back into a money route's
        # billing_country param. That would launder the IP signal into the
        # charge-grade request-confirmation slot and defeat the server's
        # refusal to charge on it (Wave 1.2). "unresolved" is reported as null
        # so the wire contract stays 'stored' | 'detected' | null.
        "country_source": None if ctx.source == "unresolved" else ctx.source,
        "display_currency": ctx.currency,
        "display_rate": DISPLAY_USD_TO_INR,
        # The rate that will be ADDED to this caller's charges, since prices are
        # published exclusive of tax. Zero is a real answer, not a placeholder:
        # an export pays no Indian GST, and an unregistered seller adds none.
        # Served here because the frontend already reads this endpoint for the
        # rail, so the rate cannot drift from the currency it applies to, and so
        # the disclosure copy is never a second hardcoded 18%.
        "tax_rate_bps": tax_rate_bps,
        "razorpay_enabled": RAZORPAY_ENABLED,
        "razorpay_key_id": RAZORPAY_KEY_ID if RAZORPAY_ENABLED else None,
        "checkout_available": RAZORPAY_ENABLED,
        "contact_sales_email": "developer@oyechats.com",
    }


class VerifyRazorpaySubscriptionRequest(BaseModel):
    # Gateway-issued handles echoed back by the browser after Checkout, plus
    # the hex HMAC. Bounded and charset-pinned before the signature compare
    # and the gateway lookup run.
    razorpay_payment_id: GatewayRef
    razorpay_subscription_id: GatewayRef
    razorpay_signature: GatewaySignature


@router.post("/verify-razorpay-subscription", dependencies=[Depends(money_route_limit("verify-sub", "30/minute"))])
def verify_razorpay_subscription(
    payload: VerifyRazorpaySubscriptionRequest,
    client: Client = Depends(get_current_client),
):
    """Verify the Razorpay Checkout return signature for a subscription.

     Razorpay's ``subscription.activated`` webhook is the canonical reconciler
    . This endpoint only exists so the UI can flip to a "Subscription
     active" state the moment the modal closes, without waiting for the
     out-of-band webhook round-trip.

     Response contract. Read ``status`` carefully, it is the narrowest field:

     * ``status: "verified"`` refers to the SIGNATURE, and nothing else. It says
       Razorpay signed this payment for this subscription. It does NOT say a
       subscription exists locally, and misreading it as "active" is how a
       caller ends up asserting a plan the app cannot see.
     * ``subscription_known``. Whether a local ``Subscription`` row exists yet.
       The long-standing flag; unchanged, and callers built against it keep
       working exactly as before.
     * ``activation_pending``, the same fact stated in the affirmative, added
       because "``status`` is about the signature" is a distinction a reader has
       to notice, and the cost of not noticing it is a double charge. ``True``
       means: the money is fine, the plan is not visible yet, keep polling.
     * ``retry_after_seconds``. How long to wait before re-reading
       ``GET /subscriptions/current``. Present only while activation is pending.
       It is a CADENCE, not a deadline: poll until ``activation_pending`` clears
       rather than giving up after a fixed number of attempts. The old frontend
       re-fetched twice (immediately, then at 3s) and stopped, the prod mandate
       was still non-billable well past that, so the customer saw no plan change
       and bought it a second time.

     Failure modes (caller-facing):
       * 400. Signature mismatch (replay / tampering).
       * 409. ``subscription_activation_conflict``: the money arrived but the
         local row collided with another active subscription in this scope.
       * 502. Razorpay SDK error (network / quota).
    """
    from app.services import razorpay_service

    try:
        razorpay_service.verify_subscription_payment_signature(
            razorpay_payment_id=payload.razorpay_payment_id,
            razorpay_subscription_id=payload.razorpay_subscription_id,
            razorpay_signature=payload.razorpay_signature,
        )
    except razorpay_service.SignatureMismatch as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # SDK transport / config failures
        logger.exception("Razorpay subscription signature verify failed for client %s", client.id)
        raise HTTPException(status_code=502, detail="Could not verify with Razorpay.") from exc

    # Idempotently reconcile the local Subscription row. The webhook is the
    # canonical path, but it can be delayed (Razorpay retries, worker outage,
    # network blip), without a reconcile here a paying customer would see
    # "no plan" in the UI until the webhook eventually fires. The reconcile
    # helper is gated by a synthetic event id in ``processed_webhooks`` so
    # this path and the webhook can't double-grant.
    with get_session() as session:
        sub = (
            session.execute(
                select(Subscription).where(
                    Subscription.razorpay_subscription_id == payload.razorpay_subscription_id,
                    Subscription.client_id == client.id,
                )
            )
            .scalars()
            .first()
        )
        if sub is None:
            try:
                sub = razorpay_service.reconcile_subscription_from_razorpay(
                    session, payload.razorpay_subscription_id, expected_client_id=client.id
                )
                session.commit()
            except razorpay_service.RazorpayBillingError:
                # Reconcile failed, the webhook may still arrive. Don't fail
                # verify; the UI will poll /subscriptions/current and pick up
                # the row whenever it lands.
                logger.warning(
                    "Razorpay reconcile failed for client %s, subscription %s. Falling back to webhook",
                    client.id,
                    payload.razorpay_subscription_id,
                )
            except IntegrityError as exc:
                # "One active subscription per scope" is a constraint this
                # endpoint can PREDICT (a second in-flight mandate collides with
                # the first active row) and a predictable constraint must not
                # reach a paying customer as a raw 500 mid-checkout. Any OTHER
                # integrity failure is a real bug and is re-raised untouched.
                session.rollback()
                constraint = razorpay_service.active_subscription_conflict(exc)
                if constraint is None:
                    raise
                raise razorpay_service.SubscriptionActivationConflict(
                    razorpay_subscription_id=payload.razorpay_subscription_id,
                    client_id=client.id,
                    constraint=constraint,
                ) from exc
            # Re-read with the client-id scope so we never expose somebody
            # else's row even if the notes were misconfigured server-side.
            sub = (
                session.execute(
                    select(Subscription).where(
                        Subscription.razorpay_subscription_id == payload.razorpay_subscription_id,
                        Subscription.client_id == client.id,
                    )
                )
                .scalars()
                .first()
            )

        # Create the first-charge invoice synchronously too. The
        # ``subscription.charged`` webhook is the canonical creator, but it
        # can't reach a local dev box and can lag in prod, without this a
        # paying customer sees an active plan with no invoice. Idempotent on
        # the payment id, so the eventual webhook never duplicates it.
        if sub is not None:
            razorpay_service.record_verified_subscription_charge(session, sub, payload.razorpay_payment_id)
            session.commit()
            invoice_service.request_pdf_render_soon()
        # Additive only. ``status`` and ``subscription_known`` keep their exact
        # meanings and values, a caller polling on ``subscription_known`` is
        # unaffected. The two new fields exist so a caller does not have to
        # infer the pending state from the ABSENCE of something.
        response: dict[str, object] = {
            "status": "verified",
            "subscription_known": sub is not None,
            "razorpay_subscription_id": payload.razorpay_subscription_id,
            "activation_pending": sub is None,
        }
        if sub is None:
            response["retry_after_seconds"] = ACTIVATION_POLL_SECONDS
        return response


@router.get("/usage")
def get_subscription_usage(client: Client = Depends(get_current_client)):
    """Backward-compat redirect to the credit-balance endpoint.

    The legacy per-metric usage summary has been retired in favour of the
    credit ledger. Kept here as a thin shim so older admin builds and any
    external consumers don't 404.
    """
    with get_session() as session:
        breakdown = credit_service.get_balance_breakdown(session, client.id)
        sub = get_client_subscription(session, client.id)
        plan = get_client_plan(session, client.id)
        next_reset = effective_resets_at(sub)
        return {
            "deprecated": True,
            "message": "Use /credits/balance instead.",
            "credits": breakdown,
            "monthly_grant": int(plan.credits_per_month or 0) if plan else 0,
            "resets_at": next_reset.isoformat() if next_reset else None,
        }


def _resolve_invoice_scope(session: Session, client_id: int, bot_id: int | None) -> int | None:
    """Resolve which invoices a Billing view should show.

    Mirrors ``get_current_subscription``'s fallback exactly: an agent with no
    subscription of its own draws on the ACCOUNT plan, so it must show the
    account's invoices. Without this the Billing page renders an account
    subscription beside an agent-scoped (empty) invoice list, the two panels
    can never agree, which is what made a paying customer see "No invoices yet"
    while their plan showed Active.

    ``get_subscription_for_bot`` filters by ``client_id``, so a foreign bot id
    resolves to None (account-wide for the caller); the query's own
    ``client_id`` filter still prevents any cross-workspace read.
    """
    if bot_id is None:
        return None
    return bot_id if get_subscription_for_bot(session, client_id, bot_id) is not None else None


@router.get("/invoices")
def list_invoices(client: Client = Depends(get_current_client), bot_id: int | None = None):
    """Return the client's payment history (most recent first).

    When ``bot_id`` is given AND that agent has its own subscription, the
    history is scoped to that agent's invoices (``Invoice.bot_id``). An agent
    without its own subscription falls back to the account-wide history,
    matching how ``/current`` resolves the subscription it is shown beside.
    See ``_resolve_invoice_scope``. Omit ``bot_id`` for the account-wide
    history.
    """
    with get_session() as session:
        scope_bot_id = _resolve_invoice_scope(session, client.id, bot_id)
        stmt = (
            select(Invoice)
            .where(
                Invoice.client_id == client.id,
                *([Invoice.bot_id == scope_bot_id] if scope_bot_id is not None else []),
            )
            .order_by(Invoice.created_at.desc())
            .limit(50)
        )
        invoices = session.execute(stmt).scalars().all()

        return [
            {
                "id": inv.id,
                "amount_cents": inv.amount_cents,
                "currency": inv.currency,
                "status": inv.status,
                # Description on numbered rows can carry serials ("Credit note
                # against DB/26-27/000001"). Gated like the other v2 fields.
                "description": (
                    inv.description if (inv.invoice_number is None or app_config.INVOICE_EMAILS_ENABLED) else None
                ),
                # v2 documents (numbered rows) follow the same customer-facing
                # kill switch as the tax fields below, a rendered PDF must
                # never leak while delivery is disabled. Unnumbered legacy rows
                # pass their provider URLs through untouched.
                "invoice_url": (
                    inv.invoice_url if (inv.invoice_number is None or app_config.INVOICE_EMAILS_ENABLED) else None
                ),
                "pdf_url": inv.pdf_url if (inv.invoice_number is None or app_config.INVOICE_EMAILS_ENABLED) else None,
                "period_start": inv.period_start.isoformat() if inv.period_start else None,
                "period_end": inv.period_end.isoformat() if inv.period_end else None,
                "paid_at": inv.paid_at.isoformat() if inv.paid_at else None,
                "created_at": inv.created_at.isoformat() if inv.created_at else None,
                # Invoicing v2 tax-document fields (null on legacy rows).
                # Nulled while invoices run in SHADOW mode. Customers must not
                # see (and book against) invoice numbers that are still under
                # verification. INVOICE_EMAILS_ENABLED is the customer-facing
                # switch (Phase 4/6); keys stay present so the schema is stable.
                "invoice_number": inv.invoice_number if app_config.INVOICE_EMAILS_ENABLED else None,
                "invoice_type": inv.invoice_type if app_config.INVOICE_EMAILS_ENABLED else None,
                "issued_at": (
                    inv.issued_at.isoformat() if (inv.issued_at and app_config.INVOICE_EMAILS_ENABLED) else None
                ),
                "taxable_value_minor": inv.taxable_value_minor if app_config.INVOICE_EMAILS_ENABLED else None,
                "total_tax_minor": inv.total_tax_minor if app_config.INVOICE_EMAILS_ENABLED else None,
                "cgst_minor": inv.cgst_minor if app_config.INVOICE_EMAILS_ENABLED else None,
                "sgst_minor": inv.sgst_minor if app_config.INVOICE_EMAILS_ENABLED else None,
                "igst_minor": inv.igst_minor if app_config.INVOICE_EMAILS_ENABLED else None,
                "tax_rate_bps": inv.tax_rate_bps if app_config.INVOICE_EMAILS_ENABLED else None,
                "hsn_sac": inv.hsn_sac if app_config.INVOICE_EMAILS_ENABLED else None,
                "supply_kind": inv.supply_kind if app_config.INVOICE_EMAILS_ENABLED else None,
                "is_export": inv.is_export if app_config.INVOICE_EMAILS_ENABLED else None,
            }
            for inv in invoices
        ]


# ── Billing details (buyer tax identity for invoicing v2) ─────────────────────


class BillingAddress(BaseModel):
    """Postal address printed on the customer's tax invoice."""

    model_config = ConfigDict(extra="forbid")

    line1: str | None = Field(default=None, max_length=200)
    line2: str | None = Field(default=None, max_length=200)
    city: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    postal_code: str | None = Field(default=None, max_length=20)
    country: str | None = Field(default=None, max_length=100)


class BillingDetailsBody(BaseModel):
    # All optional. PATCH semantics via exclude_unset: omitted fields keep
    # their stored value; an explicit null clears the field.
    legal_name: Name | None = None
    # Indian GSTIN. Format AND mod-36 checksum are verified in the handler by
    # ``is_valid_gstin`` (which also has to distinguish "" (clear the field)
    # from an invalid value), so this only bounds the length: 15 characters
    # plus room for the spacing people paste in.
    gstin: str | None = Field(default=None, max_length=32)
    # Printed on the invoice. Allow-listed keys, each a bounded string, it
    # used to be ``dict[str, str]``, which accepted any number of keys of any
    # length.
    billing_address: BillingAddress | None = None
    # ISO-2 country code; length-capped so a free-text value ("India") is a
    # clean 422 rather than a varchar(2) overflow → 500 at commit.
    billing_country: str | None = Field(default=None, max_length=2)
    # ISO 3166-2 subdivision suffix. Decides intra- vs inter-state GST.
    billing_state_code: str | None = Field(default=None, max_length=8)
    billing_email: EmailAddress | None = None


def _billing_details_dict(client: Client) -> dict:
    return {
        "legal_name": client.legal_name,
        "company_name": client.company_name,
        "gstin": client.gstin,
        "billing_address": client.billing_address,
        "billing_country": client.billing_country,
        "billing_state_code": client.billing_state_code,
        "billing_email": client.billing_email,
        # Read-only: where invoices actually go when billing_email is unset
        # (mirrors invoice_service's ``billing_email or email`` recipient).
        "account_email": client.email,
    }


# Rule 46(f): an invoice to an UNREGISTERED buyer needs the recipient's name,
# address and state only when its value is ₹50,000 or more. Every current
# OyeChats price (plans, annual, top-up packs, seats) sits well under this.
_RULE_46F_THRESHOLD_MINOR = 50_000 * 100


def _missing_billing_fields(client: Client, *, amount_minor: int | None = None) -> list[str]:
    """Which statutory buyer fields are absent for THIS buyer, in display order.

    Mandatory-fields matrix (CGST Rule 46 + Circular 242). Ask only for what
    the law requires from each kind of buyer, so payment stays open to
    everyone, registered or not, Indian or foreign:

    * **Registered buyer (GSTIN on record)**. Registered legal name and
      address are mandatory: the recipient details must match the GST
      registration or the buyer's GSTR-2B reconciliation fails and they lose
      the input tax credit. State derives from the GSTIN.
    * **Foreign buyer (export invoice)**. Rule 46's export proviso wants the
      recipient's name, address and destination country on the document. The
      country is already on record (it is what routed them here); the name
      falls back to the account name; only the address is asked for.
    * **Unregistered domestic buyer (B2C)**, nothing, below ₹50,000. Rule
      46(f) only demands name/address/state on invoices of ₹50,000+ to
      unregistered persons; below that the invoice is valid without recipient
      details, the name falls back to the account name, and the place of
      supply falls back to the supplier's state (Circular 242. Implemented in
      ``finalize_invoice``). Asking anyway was blocking legitimate B2C
      payments for details the law never required from them.

    A GSTIN itself is never required, it matters only for input tax credit,
    and the buyer can add it later.
    """
    has_gstin = bool((client.gstin or "").strip())
    is_export = (client.billing_country or "IN").strip().upper() not in ("", "IN")
    address = client.billing_address
    has_address = isinstance(address, dict) and bool(str(address.get("line1") or "").strip())
    big_b2c = not has_gstin and not is_export and amount_minor is not None and amount_minor >= _RULE_46F_THRESHOLD_MINOR

    missing: list[str] = []
    if has_gstin and not (client.legal_name or "").strip():
        missing.append("legal_name")
    if (has_gstin or is_export or big_b2c) and not has_address:
        missing.append("billing_address")
    if big_b2c and not (client.billing_state_code or "").strip():
        missing.append("billing_state_code")
    return missing


def _require_billing_identity(client: Client, *, amount_minor: int | None = None) -> None:
    """409 unless the buyer identity needed for a Rule 46 invoice is on record.

    409, not 400: the request is well-formed, the ACCOUNT is not ready. The
    machine-readable ``code`` lets the UI open the billing-details modal with
    the first missing field focused instead of showing a dead-end toast.
    """
    missing = _missing_billing_fields(client, amount_minor=amount_minor)
    if missing:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "billing_details_required",
                "missing": missing,
                "message": "Add your billing details so we can issue a valid tax invoice.",
            },
        )


@router.get("/payment-recovery")
def payment_recovery(client: Client = Depends(get_current_client), bot_id: int | None = None):
    """Recovery state + hosted link for a failing subscription.

    Drives the app-wide past-due banner and its CTA. Read-only and safe to
    poll: it resolves Razorpay's EXISTING hosted page and never mutates
    anything, in particular it never mints a second mandate, which would
    double-charge a customer whose original subscription is still recoverable
    (see ``dunning_service``).

    Scope resolution mirrors ``/current`` and ``_resolve_invoice_scope``: an
    agent with no subscription of its own draws on the ACCOUNT plan, so we fall
    back to it. Without that fallback the banner would stay silent for a
    past-due account whenever an agent happened to be selected in the switcher.
    """
    from app.config import PAYMENT_FAILED_GRACE_DAYS
    from app.services.dunning_service import DunningError, get_recovery_link

    with get_session() as session:
        sub = None
        if bot_id is not None:
            sub = get_subscription_for_bot(session, client.id, bot_id)
        if sub is None:
            sub = get_client_subscription(session, client.id)

        # A downgrade re-auth grace row is ``past_due`` but is NOT a failed
        # payment: it has no gateway mandate and awaits a first authorization,
        # not a rescue. Surfacing it in the dunning "payment failed. Recover"
        # banner would be wrong (and there is no mandate to build a recovery
        # link from). The re-auth CTA reaches the customer via the cutover email
        # instead, so this endpoint treats the grace row as not-past-due.
        from app.services.transition_service import DOWNGRADE_REAUTH_GRACE_REASON

        is_reauth_grace = sub is not None and sub.cancel_reason == DOWNGRADE_REAUTH_GRACE_REASON
        if sub is None or sub.status != "past_due" or is_reauth_grace:
            return {
                "past_due": False,
                "recoverable": False,
                "recovery_url": None,
                "days_left": None,
                "plan_name": None,
            }

        days_left = None
        if sub.past_due_since is not None:
            since = sub.past_due_since
            if since.tzinfo is None:
                since = since.replace(tzinfo=UTC)
            elapsed = (datetime.now(UTC) - since).days
            days_left = max(0, PAYMENT_FAILED_GRACE_DAYS - elapsed)

        plan_name = sub.plan.name if sub.plan else None

        try:
            link = get_recovery_link(sub.razorpay_subscription_id)
        except DunningError:
            # Gateway hiccup. Still tell the customer they are past due (that
            # part is locally known and true) but ``recoverable: None`` says
            # "we couldn't check", which must not be rendered as a dead button
            # or as "your subscription is gone".
            return {
                "past_due": True,
                "recoverable": None,
                "recovery_url": None,
                "days_left": days_left,
                "plan_name": plan_name,
            }

        return {
            "past_due": True,
            "recoverable": link.recoverable,
            "recovery_url": link.url,
            "days_left": days_left,
            "plan_name": plan_name,
        }


@router.get("/billing-details")
def get_billing_details(client: Client = Depends(get_current_client)):
    """The buyer identity used on tax invoices (invoicing v2 Phase 1)."""
    return _billing_details_dict(client)


@router.put("/billing-details")
def update_billing_details(
    body: BillingDetailsBody, http_request: Request = None, client: Client = Depends(get_current_client)
):
    fields = body.model_dump(exclude_unset=True)

    gstin_provided = "gstin" in fields
    new_gstin = None
    if gstin_provided and fields["gstin"]:
        new_gstin = normalize_gstin(fields["gstin"])
        if not is_valid_gstin(new_gstin):
            raise HTTPException(status_code=422, detail="GSTIN failed format/checksum validation")

    state_provided = "billing_state_code" in fields
    raw_state = str(fields.get("billing_state_code") or "").strip()
    new_state = raw_state.zfill(2) if raw_state else None  # ""/whitespace clears to NULL
    if new_state and new_state not in VALID_STATE_CODES:
        raise HTTPException(status_code=422, detail=f"Unknown GST state code: {new_state}")

    country_provided = "billing_country" in fields
    new_country = (str(fields.get("billing_country") or "")).strip().upper() or None
    if new_country and not re.fullmatch(r"[A-Z]{2}", new_country):
        raise HTTPException(status_code=422, detail="billing_country must be a 2-letter ISO code")

    with get_session() as session:
        row = session.get(Client, client.id)

        # ``billing_country`` is a TAX FACT, not a profile field: ``supply_kind``
        # classifies every invoice from it, so flipping it under a live INR
        # mandate turns subsequent renewals into self-declared zero-rated
        # exports (P0-2). While any active-set subscription carries a Razorpay
        # mandate the *classification* country is frozen. Writes that keep the
        # classification (IN→IN, NULL→IN) still pass so a subscribed customer
        # can complete their billing details. Rail change = churn event;
        # genuine relocations go through the audited superadmin override.
        if (
            country_provided
            and (new_country or "IN") != ((row.billing_country or "IN").strip().upper() or "IN")
            and _has_live_gateway_mandate(session, row.id)
        ):
            raise _billing_country_locked_409()

        # Cross-field consistency is checked on the EFFECTIVE (stored +
        # incoming) values so a two-request sequence can't assemble an
        # incoherent combination a single request would have rejected.
        eff_gstin = new_gstin if gstin_provided else row.gstin
        eff_state = new_state if state_provided else row.billing_state_code
        eff_country = new_country if country_provided else row.billing_country
        if eff_gstin:
            # The GSTIN's first two digits are the authoritative place-of-supply
            # state; a conflicting explicit state is a client error, not a
            # silent override.
            if state_provided and eff_state and eff_state != eff_gstin[:2]:
                raise HTTPException(
                    status_code=422, detail="billing_state_code does not match the GSTIN's state digits"
                )
            eff_state = eff_gstin[:2]
            # An Indian GST registration cannot belong to a foreign-billed
            # buyer. That combination would mint an export invoice carrying a
            # domestic GSTIN (and lets a customer self-declare out of IGST).
            if eff_country not in (None, "IN"):
                raise HTTPException(
                    status_code=422,
                    detail="billing_country must be IN when a GSTIN is set (clear the GSTIN first)",
                )

            # A registered buyer must name themselves. The recipient name on a
            # tax invoice has to match the GST registration or the buyer's
            # GSTR-2B reconciliation fails and they cannot claim the input tax
            # credit, so a GSTIN without a legal name is an incomplete
            # registration, not merely a cosmetic gap. (No GSTIN is fine: that
            # is an unregistered B2C buyer.)
            #
            # Checked LAST in this block: a contradictory GSTIN/state or
            # GSTIN/country pair is a harder error than an incomplete one, and
            # reporting "you're missing a name" to someone whose GSTIN
            # contradicts their state would send them fixing the wrong field.
            eff_legal_name = fields.get("legal_name") if "legal_name" in fields else row.legal_name
            if not str(eff_legal_name or "").strip():
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "legal_name is required when a GSTIN is provided, it must match the "
                        "registered business name on your GST certificate."
                    ),
                )

        if "legal_name" in fields:
            row.legal_name = (fields["legal_name"] or "").strip() or None
        if gstin_provided:
            row.gstin = new_gstin
        if "billing_address" in fields:
            row.billing_address = fields["billing_address"]
        if country_provided:
            row.billing_country = new_country
        if state_provided or gstin_provided:
            # Self-healing: whenever a GSTIN is on record the stored state
            # follows its digits.
            row.billing_state_code = eff_state if eff_gstin else (new_state if state_provided else eff_state)
        if "billing_email" in fields:
            row.billing_email = (fields["billing_email"] or "").strip() or None
        # An ACCEPTED foreign-country write (no live mandate → allowed) from an
        # IN-detected request is the P0-2 signal shape. Record it durably even
        # though the write itself is legitimate, so a later export
        # classification for this account has a review trail.
        if country_provided and new_country and http_request is not None:
            mismatch = _geo_mismatch_detail(new_country, resolve_country(http_request))
            if mismatch:
                _flag_geo_mismatch(session, row.id, mismatch)
        session.commit()
        session.refresh(row)
        # Keep the gateway's customer record aligned with the invoice buyer
        # snapshot, so the Razorpay dashboard and the tax document never
        # disagree about who was billed. Best-effort by design: the local row is
        # authoritative for invoicing, and a Razorpay outage must not fail the
        # customer's own edit.
        razorpay_customer_service.sync_customer(session, row)
        # Keep the dependency-injected object in sync for the response.
        for attr in (
            "legal_name",
            "gstin",
            "billing_address",
            "billing_country",
            "billing_state_code",
            "billing_email",
        ):
            setattr(client, attr, getattr(row, attr))
    return _billing_details_dict(client)


# ── Payment-funnel telemetry (Wave 3.0) ──────────────────────────────────────


class BillingFunnelEventBody(BaseModel):
    """Fire-and-forget drop-off signal from the app's Razorpay wrapper."""

    event: Literal["checkout_abandoned", "payment_failed"]
    # One member per checkout surface. A new paid surface MUST be added here at
    # the moment it ships, or its drop-offs are unreportable and the frontend's
    # only options are to stay silent or to mislabel them as another surface,
    # corrupting that surface's funnel.
    surface: Literal["plan", "topup", "seat", "resume", "branding"]
    # Telemetry, not a dumping ground. ``SmallJsonObject`` bounds serialized
    # size, nesting depth and key count; the check below keeps this route's
    # own tighter 2 KB ceiling on top of it.
    meta: SmallJsonObject | None = None

    @field_validator("meta")
    @classmethod
    def _bound_meta(cls, v: dict | None) -> dict | None:
        if v is not None and len(json.dumps(v)) > 2048:
            raise ValueError("meta too large")
        return v


@router.post(
    "/billing-events",
    status_code=204,
    dependencies=[Depends(money_route_limit("billing-events", "10/minute"))],
)
def record_billing_funnel_event(body: BillingFunnelEventBody, client: Client = Depends(get_current_client)):
    """Record a detected payment-funnel drop-off (customer closed the Razorpay
    sheet, or the gateway declined). Telemetry only, nothing downstream
    depends on these rows, so the write is simple and unconditional; the app
    calls this fire-and-forget and ignores failures."""
    from app.db.models import BillingFunnelEvent

    with get_session() as session:
        session.add(
            BillingFunnelEvent(
                client_id=client.id,
                event=body.event,
                surface=body.surface,
                meta=body.meta,
            )
        )
        session.commit()


# ── Checkout & Billing Portal ──


class CheckoutRequest(BaseModel):
    plan_id: RowId
    billing_cycle: BillingCycle = "monthly"
    coupon_code: CouponCode | None = None
    # Confirmed at checkout (country-confirmation step). None → fall back to the
    # client's stored country, else domestic (IN). Optional for backward compat:
    # legacy callers that omit it stay on the existing INR path.
    billing_country: str | None = Field(default=None, max_length=2)


# ── Checkout quote (currency + payment-method preview) ────────────────────────


# Razorpay's INR Checkout supports far more methods than we expose to the user;
# we whitelist the two we promise on the pricing page so the modal never shows
# rails we haven't tested against (netbanking quirks, wallet KYC limits, etc).
# Cards: Visa / Mastercard / Amex / Rupay. UPI: GPay / PhonePe / Paytm / BHIM.
_RAZORPAY_METHODS_INR = ("card", "upi")
# International rail: foreign cards only. UPI is domestic-only and cannot
# settle a USD charge, so offering it would open a modal that always fails.
_RAZORPAY_METHODS_USD = ("card",)


def _amount_for_cycle(plan, billing_cycle: str) -> int:
    """Minor-unit price (paise for INR, cents for USD) for the requested cycle."""
    if billing_cycle == "annual":
        return int(plan.annual_price_cents or 0)
    return int(plan.monthly_price_cents or 0)


def _tax_block(amount_minor: int, *, currency: str, is_domestic: bool, rate_bps: int) -> dict:
    """The tax half of a checkout quote, for one base amount.

    Published prices are BASE prices, so ``amount_minor`` alone is not what the
    mandate debits on the domestic rail. Every quote therefore has to carry
    three numbers, not one: the taxable base, the tax, and the gross the
    customer is actually charged. Returning only the base is what made this
    endpoint's own "single source of truth for what the checkout button will
    charge" docstring false by 18%.

    Exports carry no Indian GST, so the gross equals the base and the tax is
    zero. Same for a zero-price (free) plan, where there is nothing to tax.

    Built once and spread into all five return shapes rather than written out
    per branch, so a future branch cannot ship a quote with the tax missing.
    """
    gross_minor = gross_charge_minor(
        max(int(amount_minor), 0),
        rate_bps=rate_bps,
        kind="intra" if is_domestic else "export",
    )
    return {
        "tax_minor": gross_minor - int(amount_minor),
        "tax_rate_bps": rate_bps if is_domestic else 0,
        "gross_minor": gross_minor,
        "gross_display": format_amount(gross_minor, currency),
    }


@router.get("/checkout/quote")
def checkout_quote(
    request: Request,
    plan_id: int,
    billing_cycle: str = "monthly",
    billing_country: str | None = None,
    client: Client = Depends(get_current_client),
):
    """Single source of truth for what the checkout button will charge.

    The admin UI calls this before opening any payment modal so it can
    render the right currency, amount, payment methods, and CTA, without
    the frontend having to know provider routing rules.

    Response shape (always 200 unless inputs are invalid):

    ``{
        "country": "IN" | "US" | null,
        "currency": "INR" | "USD",
        "amount_minor": 149900,                # BASE, exclusive of GST
        "amount_display": "₹1,499",
        "tax_minor": 26982,                    # 0 on the USD rail (export)
        "tax_rate_bps": 1800,                  # 0 on the USD rail
        "gross_minor": 176882,                 # what the mandate ACTUALLY debits
        "gross_display": "₹1,768.82",
        "billing_cycle": "monthly",
        "provider": "razorpay",
        "methods": ["card", "upi"],
        "checkout_supported": true,            # false → render Contact Sales
        "contact_sales": null | "developer@oyechats.com",
    }``

    ``amount_minor`` is the advertised base and ``gross_minor`` is the charge.
    A UI that shows a customer one number before the Razorpay sheet opens
    should show ``gross_display``; anything quoting ``amount_display`` as the
    amount payable is understating it by the tax.

    A ``checkout_supported: false`` response carries ``contact_sales`` so
    the UI can surface a CTA instead of an empty button.
    """
    if billing_cycle not in ("monthly", "annual"):
        raise HTTPException(status_code=400, detail="billing_cycle must be 'monthly' or 'annual'.")

    with get_session() as session:
        from app.services.plan_service import get_plan_by_id

        plan = get_plan_by_id(session, plan_id)
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found.")
        if not plan.is_active:
            raise HTTPException(status_code=400, detail="This plan is not available.")
        if not plan.is_public:
            # The signup trial is assignable but not purchasable. Without this
            # it would price at zero and mint a mandate for nothing.
            raise HTTPException(status_code=400, detail="This plan cannot be purchased.")

        # ONE resolution order shared with the charge path (Wave 1.2):
        # explicit param (this checkout's country-confirmation) → the account's
        # saved country → IP geo (display-grade) → unresolved. The confirmed
        # country overrides IP so an Indian resident mis-detected abroad is
        # never routed to USD, and vice-versa (FEMA-safe). An UNRESOLVED buyer
        # is domestic, matching charge_currency's rule for every legacy account
        # (NULL country, INR mandate). Previously this quote treated unknown
        # as foreign and dead-ended a brand-new customer at Contact-sales
        # whenever the geo lookup failed.
        ctx = resolve_billing_context(
            stored_country=client.billing_country,
            request_country=billing_country,
            detected_country=resolve_country(request),
        )
        country = ctx.country
        is_domestic = ctx.currency == "INR"

        # INR price is the canonical amount. Use it as the free-plan test so a
        # missing USD column on a foreign quote can't misread a paid plan as free.
        inr_minor = _amount_for_cycle(plan, billing_cycle)
        currency = ctx.currency
        if is_domestic:
            amount_minor = inr_minor
        else:
            usd_minor = plan.annual_price_usd_cents if billing_cycle == "annual" else plan.monthly_price_usd_cents
            amount_minor = int(usd_minor or 0)
        amount_display = format_amount(amount_minor, currency)
        tax = _tax_block(
            amount_minor,
            currency=currency,
            is_domestic=is_domestic,
            rate_bps=charge_tax_rate_bps(session),
        )

        # Free plan (any zero-price plan): render a quote but mark checkout as
        # unsupported.
        if inr_minor == 0:
            return {
                "country": country,
                "currency": currency,
                "amount_minor": amount_minor,
                "amount_display": amount_display,
                **tax,
                "billing_cycle": billing_cycle,
                "provider": None,
                "methods": [],
                "checkout_supported": False,
                "contact_sales": None,
                "reason": "free_plan",
                "source": ctx.source,
            }

        # Foreign buyer, paid plan: charge on the USD rail only when the account
        # is enabled for international payments AND this tier actually has a USD
        # Razorpay plan wired for the cycle. Checking the id here (not just the
        # flag) keeps the quote honest. Promising a checkout the charge path
        # would reject with "no USD Razorpay plan id" is worse than the CTA.
        usd_plan_id = (
            plan.razorpay_plan_id_annual_usd if billing_cycle == "annual" else plan.razorpay_plan_id_monthly_usd
        )
        # amount_minor > 0 (F6): a wired USD plan id with a NULL/0 *_usd_cents
        # column would otherwise advertise "$0" with checkout_supported=true.
        # While the immutable Razorpay plan bills its real amount. A tier whose
        # USD price isn't configured is intl-pending, not free.
        if not is_domestic and INTL_PAYMENTS_ENABLED and usd_plan_id and amount_minor > 0:
            return {
                "country": country,
                "currency": currency,
                "amount_minor": amount_minor,
                "amount_display": amount_display,
                **tax,
                "billing_cycle": billing_cycle,
                "provider": "razorpay",
                # Cards only. UPI is a domestic rail and cannot settle a USD charge.
                "methods": list(_RAZORPAY_METHODS_USD),
                "checkout_supported": True,
                "contact_sales": None,
                "source": ctx.source,
            }

        # Foreign buyer we cannot charge yet (international payments off, or no
        # USD plan for this tier). Flag intl_usd_pending so the UI renders a
        # Contact-sales CTA instead of opening a Razorpay modal that would fail.
        if not is_domestic:
            return {
                "country": country,
                "currency": currency,
                "amount_minor": amount_minor,
                "amount_display": amount_display,
                **tax,
                "billing_cycle": billing_cycle,
                "provider": None,
                "methods": [],
                "checkout_supported": False,
                "contact_sales": "developer@oyechats.com",
                "reason": "intl_usd_pending",
                "source": ctx.source,
            }

        # Domestic paid plan: the live INR rail, but only when this tier
        # actually has an INR Razorpay plan wired for the cycle. Same principle
        # as the USD branch above, and it applies to every plan, not just newly
        # seeded ones. A tier with no INR plan id is LISTED on purpose (a
        # contact-sales tier needs no gateway id to appear on the pricing page.
        # See ``plan_service.plan_checkout_is_wired``), so this branch is the
        # only thing standing between the buyer and a checkout that cannot
        # complete. ``POST /subscriptions/checkout`` refuses in the SAME shape:
        # ``create_subscription`` raises ``PlanNotCheckoutable``, which the
        # app-level handler maps to a 409 carrying this same ``reason`` and
        # ``contact_sales``. Quote and button therefore agree.
        inr_plan_id = plan.razorpay_plan_id_annual if billing_cycle == "annual" else plan.razorpay_plan_id_monthly
        if not inr_plan_id:
            return {
                "country": country,
                "currency": currency,
                "amount_minor": amount_minor,
                "amount_display": amount_display,
                **tax,
                "billing_cycle": billing_cycle,
                "provider": None,
                "methods": [],
                "checkout_supported": False,
                "contact_sales": "developer@oyechats.com",
                "reason": "inr_plan_unconfigured",
                "source": ctx.source,
            }

        return {
            "country": country,
            "currency": currency,
            "amount_minor": amount_minor,
            "amount_display": amount_display,
            **tax,
            "billing_cycle": billing_cycle,
            "provider": "razorpay",
            "methods": list(_RAZORPAY_METHODS_INR),
            "checkout_supported": True,
            "contact_sales": None,
            "source": ctx.source,
        }


@router.get("/admin/plan-price-check")
def plan_price_check(client: Client = Depends(get_current_client)):
    """Super-admin diagnostic: local plan price vs the live Razorpay plan amount.

    The checkout disclosure quotes ``plan.monthly_price_cents``; if it drifts
    from the amount configured on the live Razorpay plan, the UI quotes a rupee
    figure the mandate will not debit. This surfaces drift per plan/cycle. A
    Razorpay error on any plan yields ``in_sync: null`` + an error string, a
    diagnostic must never 500.
    """
    if not client.is_superadmin:
        raise HTTPException(status_code=403, detail="Super admin only.")

    from app.services.plan_service import get_active_plans
    from app.services.razorpay_service import _get_razorpay

    rzp = _get_razorpay()
    out = []
    with get_session() as session:
        rate_bps = charge_tax_rate_bps(session)
        for plan in get_active_plans(session):
            row = {"plan_id": plan.id, "slug": plan.slug}
            # Both rails (P1-2/F2): USD drift is just as displayed-vs-charged
            # as INR drift, and was previously invisible to this diagnostic.
            for cycle, local_minor, rzp_id, is_export in (
                ("monthly", plan.monthly_price_cents, plan.razorpay_plan_id_monthly, False),
                ("annual", plan.annual_price_cents, plan.razorpay_plan_id_annual, False),
                ("monthly_usd", plan.monthly_price_usd_cents, plan.razorpay_plan_id_monthly_usd, True),
                ("annual_usd", plan.annual_price_usd_cents, plan.razorpay_plan_id_annual_usd, True),
            ):
                # Prices are published EXCLUSIVE of GST, so the live Razorpay
                # plan must be minted at base + tax on the domestic rail. The
                # comparison is against that expected charge, not against the
                # base: checking the base here would report every correctly
                # minted INR plan as drifted, and pass a plan still billing the
                # old GST-inclusive amount.
                base = int(local_minor or 0)
                expected = gross_charge_minor(base, rate_bps=rate_bps, kind="export" if is_export else "intra")
                entry = {
                    "local_minor": base,
                    "expected_charge_minor": expected,
                    "razorpay_minor": None,
                    "in_sync": None,
                    "error": None,
                }
                if rzp_id:
                    try:
                        item = (rzp.plan.fetch(rzp_id) or {}).get("item", {})
                        entry["razorpay_minor"] = int(item.get("amount") or 0)
                        entry["in_sync"] = entry["razorpay_minor"] == expected
                    except Exception as exc:  # diagnostic must not 500
                        entry["error"] = str(exc)
                row[cycle] = entry
            out.append(row)

        # The two env-pinned add-on plans carry the same OPS INVARIANT as the
        # tier plans (mint at base + GST) and were invisible here, so a
        # forgotten re-mint showed up only as a customer being debited less
        # than the checkout sheet quoted. Same shape as a plan row so the
        # dashboard can render them in the same table.
        addons = []
        for name, base_minor, inr_id, usd_id in (
            (
                "operator_seat",
                app_config.RAZORPAY_SEAT_PLAN_PRICE_CENTS,
                app_config.RAZORPAY_SEAT_PLAN_ID,
                app_config.RAZORPAY_SEAT_PLAN_ID_USD,
            ),
            (
                "branding_removal",
                app_config.RAZORPAY_BRANDING_PLAN_PRICE_CENTS,
                app_config.RAZORPAY_BRANDING_PLAN_ID,
                app_config.RAZORPAY_BRANDING_PLAN_ID_USD,
            ),
        ):
            addon_row = {"addon": name}
            for rail, rzp_id, is_export in (("inr", inr_id, False), ("usd", usd_id, True)):
                base = int(base_minor or 0)
                expected = gross_charge_minor(base, rate_bps=rate_bps, kind="export" if is_export else "intra")
                entry = {
                    "local_minor": base,
                    "expected_charge_minor": expected,
                    "razorpay_minor": None,
                    "in_sync": None,
                    "error": None if rzp_id else "not configured",
                }
                if rzp_id:
                    try:
                        item = (rzp.plan.fetch(rzp_id) or {}).get("item", {})
                        entry["razorpay_minor"] = int(item.get("amount") or 0)
                        entry["in_sync"] = entry["razorpay_minor"] == expected
                    except Exception as exc:  # diagnostic must not 500
                        entry["error"] = str(exc)
                addon_row[rail] = entry
            addons.append(addon_row)

    return {"plans": out, "addons": addons, "tax_rate_bps": rate_bps}


def _geo_mismatch_detail(confirmed_country: str, detected_country: str | None) -> str | None:
    """Describe a billing-country claim that contradicts the server-side geo
    signal, or ``None`` when there is nothing suspicious (audit F35 / P0-2).

    Bidirectional, because both directions are tax signals:

    * claims **IN**, detected foreign, a domestic INR/GST classification from
      abroad (FEMA / place-of-supply review);
    * claims **foreign**, detected IN, a zero-rated export classification from
      inside India: the exact self-declared flip that turns a domestic supply
      into GST leakage.

    Unknown detection (``None``. Geo lookups legitimately fail) is never
    suspicious, and a foreign claim from a *different* foreign country is a
    curiosity (travel, VPN), not a tax signal.
    """
    if detected_country is None or confirmed_country == detected_country:
        return None
    if confirmed_country == "IN":
        return f"claims billing_country=IN but IP geo detected {detected_country} (GST/FEMA review)"
    if detected_country == "IN":
        return f"claims billing_country={confirmed_country} (zero-rated export) but IP geo detected IN (GST review)"
    return None


def _flag_geo_mismatch(session, client_id: int, detail: str) -> None:
    """Stamp the persistent geo-mismatch columns on the account (newest wins).

    The WARN log is the alert; these columns are the durable review trail.
    Log retention is shorter than a GST assessment window.
    """
    logger.warning("Billing geo mismatch: client=%s %s", client_id, detail)
    row = session.get(Client, client_id)
    if row is not None:
        row.geo_mismatch_at = datetime.now(UTC)
        row.geo_mismatch_detail = detail[:500]


def _flag_geo_mismatch_standalone(client_id: int, detail: str) -> None:
    """Best-effort ``_flag_geo_mismatch`` for callers outside a session (the
    checkout/top-up resolver runs before their transaction opens). A flag
    write must never fail the customer's money path."""
    try:
        with get_session() as session:
            _flag_geo_mismatch(session, client_id, detail)
            session.commit()
    except Exception:
        logger.exception("Failed to persist geo-mismatch flag for client %s", client_id)


def _resolve_confirmed_billing_country_or_409(
    *,
    request_country: str | None,
    client: Client,
    http_request: Request,
    allow_usd: bool = False,
) -> str:
    """Resolve + gate the confirmed billing country shared by EVERY money-moving
    Razorpay path (checkout, top-up, ...).

    ``allow_usd`` is the caller's declaration that IT can actually charge a
    non-IN buyer, and defaults to False so a new money path is gated until it
    proves otherwise. Subscription checkout passes ``INTL_PAYMENTS_ENABLED``
    (the USD rail bills against the plan's USD Razorpay ids); top-up passes
    False because ``razorpay_service.create_topup_order`` is still INR-only.
    Letting it through would charge a foreign buyer rupees on a supply
    ``invoice_service`` classifies as an export (GST mis-classification /
    short-payment). When USD is not allowed, a confirmed non-IN buyer 409s with
    the ``intl_usd_pending`` contract the frontend already renders as a
    Contact-sales CTA.

    Resolution is ``resolve_billing_context`` (the SAME order the quote uses
    (request-confirmed → stored → detected)) with the charge path's trust
    rules layered on top (Wave 1.2):

    * The ``detected`` (IP geo) signal is never *charged on*. But when it is
      the ONLY signal and it says foreign, the old behavior (silently
      defaulting to IN and minting an INR mandate a USD quote never promised)
      is replaced by a 409 ``billing_country_required``: the customer confirms
      their country and checkout proceeds on the right rail.
    * A GSTIN on record with a confirmed non-IN country is a contradiction (a
      domestic GST registration cannot bill on the export rail) → 422, checked
      BEFORE the intl kill switch so the flag being off cannot mask it.
    * Unresolved with no foreign signal stays the domestic default (every
      legacy account: NULL country, INR mandate).

    The geo cross-check stays advisory (see ``_geo_mismatch_detail``), a
    charge-grade country that contradicts the IP signal is flagged, not
    blocked.
    """
    ctx = resolve_billing_context(
        stored_country=client.billing_country,
        request_country=request_country,
        detected_country=None,  # IP geo is display-grade; never charge on it
    )
    detected_country = resolve_country(http_request) if http_request is not None else None

    if ctx.source == "unresolved" and detected_country not in (None, "IN"):
        raise HTTPException(
            status_code=409,
            detail={
                "reason": "billing_country_required",
                "message": (
                    "Please confirm your billing country before checkout. "
                    "it determines the currency you are charged in."
                ),
            },
        )

    confirmed_country = ctx.country or "IN"

    if confirmed_country != "IN" and (client.gstin or "").strip():
        raise HTTPException(
            status_code=422,
            detail=(
                "Your account has an Indian GSTIN on record, which requires domestic (IN) billing. "
                "Clear the GSTIN from your billing details before billing from another country."
            ),
        )

    mismatch = _geo_mismatch_detail(confirmed_country, detected_country)
    if mismatch:
        _flag_geo_mismatch_standalone(client.id, mismatch)

    if confirmed_country != "IN" and not allow_usd:
        raise HTTPException(
            status_code=409,
            detail={
                "reason": "intl_usd_pending",
                "message": "USD billing for international customers is coming soon. Please contact sales.",
                "contact_sales": "developer@oyechats.com",
            },
        )

    return confirmed_country


def _billing_country_locked_409() -> HTTPException:
    """The one 409 every surface raises when a tax-classification country
    change is attempted under a live mandate. PUT /billing-details, checkout,
    and top-up must speak the same contract or the freeze has side doors."""
    return HTTPException(
        status_code=409,
        detail={
            "reason": "billing_country_locked",
            "message": (
                "Your billing country is locked while a subscription mandate is "
                "active, because it determines how your invoices are taxed. "
                "If you have genuinely relocated, contact support, the change "
                "requires re-pointing your payment mandate to the new billing rail."
            ),
            "contact": "developer@oyechats.com",
        },
    )


def _has_live_gateway_mandate(session, client_id: int) -> bool:
    """Any active-set subscription (account OR per-bot. Deliberately no
    ``bot_id`` filter) carrying a Razorpay mandate. The freeze must span
    per-bot mandates: a client whose only live mandate is bot-scoped can
    otherwise flip the account's tax country through a side door."""
    return (
        session.execute(
            select(Subscription.id)
            .where(
                Subscription.client_id == client_id,
                Subscription.status.in_(("active", "trialing", "past_due")),
                Subscription.razorpay_subscription_id.is_not(None),
            )
            .limit(1)
        ).first()
        is not None
    )


def _persist_confirmed_country(session, client: Client, confirmed_country: str) -> None:
    """Persist a checkout/top-up-confirmed billing country onto the account,
    honouring the SAME freeze as ``PUT /billing-details``.

    The persist writes at checkout and top-up used to bypass the freeze
    entirely (review finding): a client with only a per-bot INR mandate could
    flip IN→US via ``POST /checkout {billing_country}``, and a stored-US
    client could flip US→IN via a top-up, both exactly the writes the PUT
    endpoint 409s. Classification-preserving writes (IN→IN, NULL→IN) still
    pass so a confirmed country can land on a legacy NULL row.
    """
    row = session.get(Client, client.id)
    if row is None or row.gstin:
        # A GSTIN pins the country to IN; never let a money route flip it.
        return
    stored_class = (row.billing_country or "IN").strip().upper() or "IN"
    confirmed_class = (confirmed_country or "IN").strip().upper() or "IN"
    if stored_class == confirmed_class:
        if not row.billing_country:
            row.billing_country = confirmed_class
            client.billing_country = confirmed_class
        return
    if _has_live_gateway_mandate(session, client.id):
        raise _billing_country_locked_409()
    row.billing_country = confirmed_class
    client.billing_country = confirmed_class


def _require_precharge_gates(
    client: Client,
    http_request: Request | None = None,
    *,
    request_country: str | None = None,
    allow_usd: bool | None = None,
    amount_minor: int | None = None,
) -> str:
    """The shared pre-charge gate for EVERY route that can mint a new Razorpay
     mandate (Wave 1.3): /checkout, /change-plan Branch 3, /resume Mode 2, and
     top-ups.

     Runs the billing-country resolution with its trust rules
     (``billing_country_required`` / GSTIN⇒IN / ``intl_usd_pending`` / geo
     flagging) and then the Rule 46 billing-identity check. Before this,
     /change-plan and /resume created real gateway mandates with none of these
    , a trial→paid conversion through change-plan skipped identity collection
     entirely, so its activation webhook issued an invoice with no buyer.

     ``allow_usd`` defaults to the intl rail flag (plan mandates); top-up passes
     ``False`` because its order path is INR-only. Returns the resolved country
     for callers that need the rail.
    """
    country = _resolve_confirmed_billing_country_or_409(
        request_country=request_country,
        client=client,
        http_request=http_request,
        allow_usd=INTL_PAYMENTS_ENABLED if allow_usd is None else allow_usd,
    )
    _require_billing_identity(client, amount_minor=amount_minor)
    return country


@router.post("/checkout", dependencies=[Depends(money_route_limit("checkout", "10/minute", "50/day"))])
def create_checkout(
    request: CheckoutRequest,
    http_request: Request,
    client: Client = Depends(get_current_client),
    _verified: Client = Depends(require_verified_email),
):
    """Create a Razorpay checkout session for a paid plan.

     Returns ``{provider, subscription_id, key_id, name, description, prefill, theme}``
    . Frontend opens ``new Razorpay({subscription_id, ...}).open()``.
    """
    if request.billing_cycle not in ("monthly", "annual"):
        raise HTTPException(status_code=400, detail="billing_cycle must be 'monthly' or 'annual'.")

    # Confirmed billing country routes currency/plan/invoice. A non-IN buyer is
    # charged on the USD rail once INTL_PAYMENTS_ENABLED is on, and directed to
    # sales while it is off. Unknown (no confirm + no stored country) defaults
    # to domestic; a country already on the client is honoured as the fallback.
    # Shared with /credits/topup, which passes allow_usd=False because its order
    # path is still INR-only. See _resolve_confirmed_billing_country_or_409.
    # Country trust rules + Rule 46 buyer identity, shared with every other
    # mandate-minting route (Wave 1.3). Identity is collected BEFORE the
    # charge: the invoice is issued from the payment webhook, so this is the
    # last point at which we can ask who is being billed.
    confirmed_country = _require_precharge_gates(client, http_request, request_country=request.billing_country)

    _assert_no_stacking(client, request.coupon_code)

    with get_session() as session:
        from app.services.plan_service import get_plan_by_id

        # Serialize billing mutations for this client (NV1, finishes H1). Without
        # this a double-clicked / concurrent checkout creates two Razorpay
        # subscriptions and two ReferralConversion rows for one client.
        lock_client_for_billing(session, client.id)

        plan = get_plan_by_id(session, request.plan_id)
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found.")
        if not plan.is_active:
            raise HTTPException(status_code=400, detail="This plan is not available.")
        if not plan.is_public:
            # The signup trial is assignable but not purchasable. Without this
            # it would price at zero and mint a mandate for nothing.
            raise HTTPException(status_code=400, detail="This plan cannot be purchased.")
        if plan.monthly_price_cents == 0:
            raise HTTPException(status_code=400, detail="Cannot checkout for a free plan.")

        # Never charge full price behind a believed discount (Wave 4a).
        _validate_coupon_or_400(session, request.coupon_code)

        # Already-subscribed guard (BL-4). ``/checkout`` is strictly for a
        # FIRST purchase. A subscribed customer hitting it again would mint a
        # SECOND Razorpay subscription + second UPI mandate. Razorpay can't
        # swap a UPI plan in place, so both mandates would debit the customer
        # (double-charge). Plan changes must go through ``/change-plan``, which
        # orchestrates the cancel+recreate+re-authorize re-auth flow. Only an
        # active/trialing/past_due sub WITH a gateway mandate blocks; a
        # terminal (canceled/expired) or manual (no razorpay id) sub does not.
        #
        # The guard is ACCOUNT-scoped (``bot_id IS NULL``). ``/checkout`` only
        # ever creates account-level subscriptions, so a per-bot subscription
        # (bot_id NOT NULL) must not block a legitimate first account purchase.
        # Deliberately NOT using ``get_client_subscription`` here. That spans
        # per-bot subs, which would wrongly 409 a per-bot-only client.
        existing_account_sub = session.execute(
            select(Subscription)
            .where(
                Subscription.client_id == client.id,
                Subscription.bot_id.is_(None),
                Subscription.status.in_(("active", "trialing", "past_due")),
                Subscription.razorpay_subscription_id.is_not(None),
            )
            .limit(1)
        ).scalar_one_or_none()
        if existing_account_sub is not None:
            raise HTTPException(
                status_code=409,
                detail="You already have an active subscription. Use change-plan to upgrade or downgrade.",
            )

        # Persist the confirmed billing country for invoice place-of-supply.
        # Through the freeze-honouring helper: a classification change under a
        # live mandate (including a PER-BOT one) 409s here exactly like
        # PUT /billing-details. Only writes when the caller explicitly
        # confirmed a country (an omitted field must not overwrite a stored
        # value with the IN default).
        if request.billing_country:
            _persist_confirmed_country(session, client, confirmed_country)

        from app.services import discount_service, pending_checkout_service, razorpay_service

        # Finding H1, first-checkout edition: a sequential re-submit (double
        # click, second tab, re-opened modal) must reuse the in-flight
        # authorizable subscription, not mint a sibling mandate. Placed BEFORE
        # the promo/discount work so a reuse never burns a second promo slot.
        # Gateway state decides staleness, and a request under a DIFFERENT key
        # (plan / cycle / rail) cancels the superseded mandate before minting.
        # See pending_checkout_service.
        client_row = session.get(Client, client.id)
        try:
            reused = pending_checkout_service.reuse_or_supersede(
                session,
                client_row=client_row,
                client=client,
                plan=plan,
                billing_cycle=request.billing_cycle,
                country=confirmed_country,
            )
        except razorpay_service.RazorpayBillingError as exc:
            # Never guess: a fetch failure is not evidence the pending sub is
            # dead, and minting a sibling against a live authorizable one is the
            # exact H1 hazard. Mirror /resume's doctrine.
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        if reused is not None:
            # Best-effort card-tokenisation hint, same as the fresh mint.
            try:
                reused_customer_id = razorpay_customer_service.ensure_customer(session, session.get(Client, client.id))
                if reused_customer_id:
                    reused["customer_id"] = reused_customer_id
            except razorpay_customer_service.RazorpayCustomerError:
                logger.warning("checkout reuse: could not ensure Razorpay customer for client %s", client.id)
            session.commit()
            return reused

        # Only resolve/apply the referral discount on a provider that can realise
        # it (N4). Today only Razorpay is live; gating here means that if the
        # a non-Razorpay path is ever added before its coupon realiser exists, the
        # discount is not silently dropped (customer over-charged), it's simply
        # not resolved until the provider can honour it.
        provider = _resolve_provider()
        if provider == "razorpay":
            discount_bps, _ = discount_service.resolve_customer_discount_bps(session, client)
        else:
            discount_bps = 0

        # Launch-promo: a time-boxed free period realised by deferring the first
        # charge (Razorpay ``start_at``). Only resolved on Razorpay, the sole
        # provider that can honour ``start_at`` today. A promo and a referral
        # discount do NOT stack: the promo already gives 100% off for its free
        # cycles, and billing must resume at FULL price afterwards, so we force
        # ``discount_bps = 0`` when a promo applies. The slot is claimed
        # atomically here (under the per-client billing lock) so a capped promo
        # can never oversell; if the cap was exhausted between eligibility and
        # here, we fall back to normal pricing.
        promo_start_at: int | None = None
        promo_extra_notes: dict[str, str] | None = None
        # Monthly-only: "3 months free" on an ANNUAL cycle would defer the first
        # charge 3 months and then bill the ENTIRE year at once, a nasty surprise
        # that does not match the offer. Annual checkouts are charged normally
        # (no promo). The frontend also hides the offer on the annual cycle.
        if provider == "razorpay" and request.billing_cycle == "monthly":
            from app.services import promotion_service

            promo = promotion_service.resolve_active_promotion(session, client, plan)
            if promo is not None and promotion_service.consume_slot(session, promo):
                free_until = promotion_service.free_period_end(promo, datetime.now(UTC))
                promo_start_at = int(free_until.timestamp())
                discount_bps = 0
                promo_extra_notes = {"oyechats_promotion_id": str(promo.id)}
        # Create the gateway Customer before minting the subscription. It is the
        # anchor every saved payment instrument hangs off
        # (/v1/customers/{id}/tokens), so without it saved cards are
        # structurally impossible. Non-fatal: a subscription does not need a
        # pre-made customer, and losing it only costs the saved-instrument
        # feature, which the next checkout retries. Never block a purchase.
        #
        # Re-read in-session: `client` from the dependency is DETACHED, so
        # writing to it would be silently discarded (see ensure_customer).
        customer_id = None
        try:
            customer_id = razorpay_customer_service.ensure_customer(session, session.get(Client, client.id))
        except razorpay_customer_service.RazorpayCustomerError:
            logger.warning("checkout: could not ensure Razorpay customer for client %s", client.id)

        # Park the referral snapshot in the subscription notes instead of
        # inserting a ReferralConversion here (Wave 1.4). Recording at
        # checkout-create credited the affiliate for ABANDONED checkouts.
        # Mandates never authorised, money never moved. The
        # ``subscription.charged`` handler now records the conversion from
        # these notes on the first real payment (unique-per-client, so replays
        # and later cycles no-op). Snapshot terms still freeze at subscribe
        # time. They travel in the immutable notes. Covers ANY attributed
        # code, not just discount-bearing ones (finding MED-2 preserved).
        # Mid-trial purchase: defer the first debit to the end of the free days
        # the customer was promised, and tell the webhook handlers that is what
        # this mandate is. Without the note they cannot tell this deferred start
        # from a resume (where the customer has ALREADY paid through start_at
        # and must be granted nothing) and the buyer would sit unentitled until
        # day 14, having just paid to stop being limited.
        trial_defer_at: int | None = None
        trialing_sub = session.execute(
            select(Subscription)
            .where(
                Subscription.client_id == client.id,
                Subscription.bot_id.is_(None),
                Subscription.status == "trialing",
            )
            .limit(1)
        ).scalar_one_or_none()
        if trialing_sub is not None:
            defer_at = resolve_trial_defer_at(
                trial_end=trialing_sub.trial_end,
                promo_start_at=datetime.fromtimestamp(promo_start_at, UTC) if promo_start_at else None,
            )
            if defer_at is not None:
                trial_defer_at = int(defer_at.timestamp())

        conv_meta = discount_service.resolve_referral_conversion_snapshot(session, client)
        extra_notes: dict[str, str] = dict(promo_extra_notes or {})
        if trial_defer_at is not None:
            extra_notes[TRIAL_CONVERSION_NOTE] = "1"
        if conv_meta:
            extra_notes.update(
                {
                    "oyechats_ref_code_id": str(conv_meta["referral_code_id"]),
                    "oyechats_ref_affiliate_id": str(conv_meta["affiliate_id"]),
                    "oyechats_ref_commission_bps": str(conv_meta["affiliate_commission_bps"]),
                    "oyechats_ref_discount_bps": str(conv_meta["discount_bps"]),
                }
            )

        try:
            result = razorpay_service.create_subscription(
                session,
                client,
                plan,
                request.billing_cycle,
                discount_bps=discount_bps,
                # ``resolve_trial_defer_at`` already took the LATER of the two,
                # so this cannot shorten a consumed promo.
                start_at=trial_defer_at if trial_defer_at is not None else promo_start_at,
                extra_notes=extra_notes or None,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except razorpay_service.RazorpayBillingError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        # Record the in-flight checkout for the H1 reuse above. Cleared by the
        # activation webhook once the customer authorises.
        if client_row is not None:
            pending_checkout_service.record(
                client_row,
                subscription_id=result.get("subscription_id"),
                plan_id=plan.id,
                billing_cycle=request.billing_cycle,
                country=confirmed_country,
            )
        session.commit()
        if isinstance(result, dict) and customer_id:
            # Checkout needs this to tokenise a card (customer_id + save=1).
            result["customer_id"] = customer_id
        return result


class ChangePlanRequest(BaseModel):
    plan_id: RowId
    billing_cycle: BillingCycle | None = None  # None = keep current cycle
    bot_id: RowId | None = None  # target a specific bot's subscription (N3); None = account


@router.post("/change-plan", dependencies=[Depends(money_route_limit("change-plan", "10/minute", "50/day"))])
def change_plan(
    request: ChangePlanRequest,
    http_request: Request,
    client: Client = Depends(get_current_client),
    _verified: Client = Depends(require_verified_email),
):
    """Upgrade or downgrade the client's subscription to a different plan.

    Response shape, the frontend branches on which key is present:

    * ``{"status": "checkout_required", ...}``. Razorpay subscription auth required
    * ``{"status": "downgrade_scheduled", ...}``. Scheduled for next cycle
    * ``{"status": "downgraded", "message": "..."}``. Free downgrade
    """
    with get_session() as session:
        # Serialize this client's billing mutations (H1) before reading state.
        lock_client_for_billing(session, client.id)
        from app.services.plan_service import get_plan_by_id

        new_plan = get_plan_by_id(session, request.plan_id)
        if not new_plan or not new_plan.is_active:
            raise HTTPException(status_code=404, detail="Target plan not found or inactive.")
        if not new_plan.is_public:
            # ``/change-plan`` resolves any active plan by id, so without this
            # the signup trial is reachable as a change target and would price
            # at zero.
            raise HTTPException(status_code=400, detail="This plan cannot be purchased.")

        # Target the subscription the customer is actually looking at (N3).
        # ``_resolve_target_subscription`` targets the selected bot's own row,
        # falling back to the ACCOUNT subscription (``bot_id IS NULL``). NOT
        # ``get_client_subscription``, which spans per-bot rows and returns the
        # highest-priced one. Using the latter here meant a downgrade/upgrade
        # from a per-agent Billing view mutated (and cancelled the Razorpay
        # mandate of) a DIFFERENT, pricier bot's subscription.
        sub = _resolve_target_subscription(session, client.id, request.bot_id)

        # Guard 1 of 2, the IN-PLACE branches (1, 2a, 2b) all act on ``sub``,
        # so the scope that matters is the RESOLVED subscription's, never the
        # request parameter's. Branch 2a hands ``sub`` to
        # ``transition_service.execute_paid_upgrade``, which stamps
        # ``oyechats_bot_id`` into the replacement mandate's notes only when
        # ``sub.bot_id is not None``; Branch 2b queues ``scheduled_plan_id`` on
        # ``sub``, and the cutover row inherits its scope; Branch 1 writes
        # ``sub.plan_id`` straight onto it.
        #
        # Keying this off ``request.bot_id`` instead (as it briefly did) blocked
        # the case the resolver exists for: an agent with no subscription of its
        # own falls back to the ACCOUNT row, where the very same upgrade is
        # account-scoped and entirely correct. Branch 3 is the one place a
        # ``request.bot_id`` still creates bot scope on its own. Guarded there.
        if (
            sub is not None
            and sub.bot_id is not None
            and plan_entitlements_service.plan_grants_unlimited_bots(new_plan)
        ):
            raise _pooled_plan_scope_error(new_plan)

        # Universal precheck, same plan + SAME CYCLE is a no-op UNLESS the
        # current subscription is a trial that hasn't been paid for yet (a
        # trialing customer picking their own plan is a valid trial→paid
        # conversion and falls through to Branch 3), or the plan is
        # cancel-pending (the customer is trying to STAY. Hand off to the
        # Reactivate flow instead of a dead-end 400). A same-plan DIFFERENT-
        # cycle request is a real billing change (Wave 4a): monthly→annual is
        # an upgrade-now (bigger commitment, charged via the upgrade path),
        # annual→monthly schedules at period end like any downgrade. Plan-id
        # equality alone used to reject both as "already on this plan".
        current_cycle = (sub.billing_cycle or "monthly") if sub is not None else "monthly"
        requested_cycle = request.billing_cycle or current_cycle
        same_plan = sub is not None and sub.plan_id == request.plan_id and sub.status != "trialing"
        if same_plan:
            # Re-picking the current plan while a DOWNGRADE is queued means
            # "I changed my mind. Keep my plan". The cure is cancelling the
            # scheduled change, NOT /resume: schedule_paid_downgrade also sets
            # cancel_at_period_end + gateway_cancel_executed_at, so the
            # resume_required hand-off below would route the customer into
            # Mode 2, mint a re-auth checkout, and leave scheduled_plan_id
            # set, so the promotion cron would STILL execute the downgrade
            # they walked away from (review P2-1).
            if sub.scheduled_plan_id:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "scheduled_change_pending",
                        "message": (
                            "You have a plan change scheduled for the end of this period. "
                            "Cancel the scheduled change to keep your current plan."
                        ),
                    },
                )
            # A cancel-pending sub blocks BOTH the same-cycle re-pick and a
            # cycle switch (review P2-4): executing a billing change on a
            # subscription the customer explicitly cancelled would silently
            # resurrect it. Reactivation must be its own deliberate step.
            if sub.cancel_at_period_end:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "resume_required",
                        "message": (
                            "Your plan is scheduled to cancel at the end of the period. "
                            "Use Reactivate first, then you can change the billing cycle."
                        ),
                    },
                )
            if requested_cycle == current_cycle:
                raise HTTPException(status_code=400, detail="You are already on this plan.")
        cycle_switch_up = same_plan and current_cycle == "monthly" and requested_cycle == "annual"
        cycle_switch_down = same_plan and current_cycle == "annual" and requested_cycle == "monthly"

        # ── Branch 1: target is Free ──
        # No payment needed. If the customer has an upstream provider sub
        # schedule cancellation at period-end so they
        # keep paid features for the rest of the cycle they already paid for,
        # AND cancel the upstream mandate so the provider stops charging the
        # card / UPI. If they have a manual sub (no upstream id), the swap is
        # immediate and we have to reset+regrant credits so the Plan card
        # doesn't show the old tier's grant under the new (smaller) denominator.
        if new_plan.monthly_price_cents == 0 and new_plan.slug == "free":
            if sub is None:
                # ``get_client_subscription`` only returns rows in the
                # active-set (active/trialing/past_due). A customer whose
                # trial has already expired lands here with sub=None even
                # though they hold a real ``trial_expired`` row. That row
                # is what makes them locked out of their workspace. Treat
                # "downgrade to Free" as the legitimate way to reactivate:
                # cancel the expired row (clearing ``data_retention_until``
                # so the hard-delete cron never fires on it), then insert a
                # fresh active Free subscription and grant Free credits.
                expired_sub = session.execute(
                    select(Subscription)
                    .where(
                        Subscription.client_id == client.id,
                        Subscription.status == "trial_expired",
                        Subscription.bot_id.is_(None),
                    )
                    .order_by(Subscription.created_at.desc())
                    .limit(1)
                ).scalar_one_or_none()
                if expired_sub is None:
                    raise HTTPException(
                        status_code=400,
                        detail="You're already on Free, nothing to downgrade.",
                    )

                now = datetime.now(UTC)
                expired_sub.status = "canceled"
                expired_sub.canceled_at = now
                expired_sub.cancel_reason = "downgrade_to_free_from_trial_expired"
                # Belt-and-braces: null the retention marker so the
                # hard-delete cron never sees the row again even if a
                # future refactor broadens its status filter.
                expired_sub.data_retention_until = None

                new_sub = Subscription(
                    client_id=client.id,
                    plan_id=new_plan.id,
                    status="active",
                    billing_cycle="monthly",
                    operator_quantity=1,
                    current_period_start=now,
                    current_period_end=add_months(now, 1),
                    payment_provider="manual",
                )
                new_sub.plan = new_plan
                session.add(new_sub)
                session.flush()
                credit_service.reset_monthly_plan_credits(session, client.id, bot_id=new_sub.bot_id)
                credit_service.grant_for_subscription(session, new_sub)
                session.commit()
                plan_entitlements_service.invalidate(client.id)
                logger.info(
                    "Client %s reactivated from trial_expired onto Free (old sub %s canceled)",
                    client.id,
                    expired_sub.id,
                )
                return {
                    "status": "downgraded",
                    "message": f"Reactivated on {new_plan.name}. Your workspace is back online with Free-tier limits.",
                }
            if sub.razorpay_subscription_id:
                # Without this branch the local row would flip to Free while
                # Razorpay's UPI mandate kept debiting the customer at the
                # next cycle. Real "still charging after cancellation"
                # support tickets and chargeback risk.
                #
                # Skip the provider call if our DB already shows the mandate
                # as cancelled/expired, it means the webhook already fired
                # and Razorpay would reject a second cancel with a 400.
                already_cancelled = sub.status in ("canceled", "cancelled", "expired", "completed")
                if not already_cancelled:
                    from app.services.razorpay_service import (
                        RazorpayBillingError,
                    )
                    from app.services.razorpay_service import (
                        cancel_subscription as cancel_razorpay_subscription,
                    )

                    try:
                        cancel_razorpay_subscription(sub, at_period_end=True)
                    except RazorpayBillingError as exc:
                        raise HTTPException(
                            status_code=502,
                            detail="Could not cancel your subscription with the payment provider. Please try again in a moment.",
                        ) from exc
                    # The mandate is dead at Razorpay. Unlike ``/cancel`` (which
                    # now defers the gateway call so the customer can change
                    # their mind for free) a downgrade to Free must stop the
                    # debit right away. Record it so ``/resume`` knows a fresh
                    # mandate is required rather than clearing the flag against a
                    # subscription Razorpay will never charge again.
                    sub.gateway_cancel_executed_at = datetime.now(UTC)
                sub.cancel_at_period_end = True
                # Abandon any queued paid→paid downgrade: the customer is now
                # heading to Free, so a leftover ``scheduled_plan_id`` would let
                # the cancelled webhook / cron promote a downgrade they walked
                # away from, an unwanted checkout + re-auth email (Fix C).
                from app.services import transition_service

                transition_service.cancel_scheduled_change(session, sub)
                msg = f"Scheduled downgrade to {new_plan.name} at the end of the current billing cycle."
            else:
                sub.plan_id = new_plan.id
                sub.billing_cycle = request.billing_cycle or sub.billing_cycle
                session.flush()
                # Immediate manual-sub flip → balance must follow the plan.
                # The renewal cron is what normally hands out monthly grants;
                # since manual subs aren't on the cron we do it inline here.
                credit_service.reset_monthly_plan_credits(session, client.id, bot_id=sub.bot_id)
                credit_service.grant_for_subscription(session, sub)
                msg = f"Switched to {new_plan.name} immediately."
            session.commit()
            # Plan (or its cancellation track) just changed → drop cached
            # entitlements so Free-tier limits/features apply without the 60s lag.
            plan_entitlements_service.invalidate(client.id)
            logger.info(
                "Client %s downgraded to Free (had_razorpay=%s)",
                client.id,
                bool(sub.razorpay_subscription_id),
            )
            return {"status": "downgraded", "message": msg}

        # ── Branch 2a: paid → paid via Razorpay → upgrade-now, credit rollover ──
        # Razorpay can't modify a subscription's plan in place. We must
        # cancel the current mandate and open a fresh one. Upgrades take
        # effect immediately because the customer wants the new features
        # now; we roll the customer's unused plan credits into the new
        # subscription as a top-up grant (stashed in
        # ``upgrade_credit_pending_cents`` for the activation webhook to
        # redeem) so message credits they've already paid for aren't lost.
        if (
            sub is not None
            and sub.razorpay_subscription_id
            and sub.plan
            and (new_plan.monthly_price_cents > (sub.plan.monthly_price_cents or 0) or cycle_switch_up)
        ):
            from app.services import razorpay_service, transition_service

            billing_cycle = request.billing_cycle or sub.billing_cycle or "monthly"
            # Upgrade-now mints a REAL replacement mandate, same pre-charge
            # gates as every other mint (identity fields are freely clearable
            # after the original checkout, so "they had identity once" is not
            # a guarantee they still do).
            _require_precharge_gates(client, http_request)
            try:
                payload = transition_service.execute_paid_upgrade(session, client, sub, new_plan, billing_cycle)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except razorpay_service.RazorpayBillingError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc

            session.commit()
            payload.setdefault("provider", "razorpay")
            payload.setdefault("status", "checkout_required")
            payload.setdefault(
                "message",
                f"Confirm payment to activate {new_plan.name}. Your unused {sub.plan.name} time will be credited.",
            )
            return payload

        # ── Branch 2b: paid → paid via Razorpay → downgrade scheduled at period end ──
        # Customer keeps the higher tier until the current cycle ends. No
        # immediate Razorpay action is needed except telling the gateway to
        # stop autopay after the current cycle; the cutover spawns a fresh
        # subscription for the lower tier (handled by webhook + cron).
        if (
            sub is not None
            and sub.razorpay_subscription_id
            and sub.plan
            and (new_plan.monthly_price_cents < (sub.plan.monthly_price_cents or 0) or cycle_switch_down)
        ):
            from app.services import razorpay_service, transition_service

            # Seat overflow → 409 with picker payload; frontend lists the
            # offending operators and asks the admin to deactivate enough
            # before retrying.
            overflow = transition_service.check_seat_overflow(session, client.id, new_plan)
            if overflow is not None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "seat_overflow",
                        "active_seats": overflow.active_seats,
                        "allowed_seats": overflow.allowed_seats,
                        "excess": overflow.excess,
                        "message": (
                            f"You have {overflow.active_seats} active operator(s) but "
                            f"{new_plan.name} only includes {overflow.allowed_seats}. "
                            f"Deactivate {overflow.excess} operator(s) before downgrading."
                        ),
                    },
                )

            # Document overflow → 409, same hard-block contract as seats. A
            # downgrade to a tier with a smaller knowledge-base allowance is
            # refused until the customer deletes enough uploaded documents to
            # fit; the frontend points them at the Knowledge base to do so.
            doc_overflow = transition_service.check_document_overflow(session, client.id, new_plan)
            if doc_overflow is not None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "document_overflow",
                        "current_documents": doc_overflow.current_documents,
                        "allowed_documents": doc_overflow.allowed_documents,
                        "excess": doc_overflow.excess,
                        "message": (
                            f"You have {doc_overflow.current_documents} uploaded document(s) but "
                            f"{new_plan.name} includes {doc_overflow.allowed_documents}. "
                            f"Delete {doc_overflow.excess} document(s) before downgrading."
                        ),
                    },
                )

            billing_cycle = request.billing_cycle or sub.billing_cycle or "monthly"
            try:
                cutover_at = transition_service.schedule_paid_downgrade(session, sub, new_plan, billing_cycle)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except razorpay_service.RazorpayBillingError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc

            session.commit()
            return {
                "status": "downgrade_scheduled",
                "effective_at": cutover_at.isoformat(),
                "scheduled_plan_slug": new_plan.slug,
                "scheduled_plan_name": new_plan.name,
                "message": (
                    f"Downgrade to {new_plan.name} scheduled for "
                    f"{cutover_at:%b %d, %Y}. You'll keep {sub.plan.name} until then."
                ),
            }

        # Equal-price, different plan (Wave 4a): matches neither the upgrade
        # (>) nor the downgrade (<) branch, and the old fall-through to Branch
        # 3 minted a SECOND mandate while immediately gateway-cancelling the
        # current one. Eating the customer's remaining paid days. There is no
        # meaningful billing action to take between equal-priced tiers, so
        # refuse explicitly and let support handle the rare genuine ask.
        if (
            sub is not None
            and sub.razorpay_subscription_id
            and sub.plan
            and sub.plan_id != new_plan.id
            and (sub.plan.monthly_price_cents or 0) > 0
            and new_plan.monthly_price_cents == sub.plan.monthly_price_cents
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "plans_equal_price",
                    "message": (
                        f"Switching between {new_plan.name} and your current plan isn't "
                        "automated yet because they are priced the same. Contact support "
                        "and we'll move you over."
                    ),
                },
            )

        # ── Branch 3: paid target → Razorpay checkout ──
        # Reached when the targeted bot has no active subscription: a downgraded
        # (Free) bot returning to paid, or a first Free bot going paid. When a
        # bot_id is targeted (per-agent Billing), revive THAT bot in place.
        # Carry its id so activation reattaches the new sub and reactivates its
        # knowledge, keeping the same bot_key/embed. Without a bot_id it is an
        # account-level purchase.
        #
        # DEMOTION, not refusal. This is the one branch whose scope comes from
        # the REQUEST rather than from ``sub``: ``create_bot_resubscription``
        # stamps ``request.bot_id`` onto the new subscription whatever
        # ``_resolve_target_subscription`` returned, so the account-row fallback
        # that makes Guard 1 pass does not make this branch account-scoped.
        #
        # But refusing here was wrong. Branch 3 is reached WITH a ``bot_id``
        # whenever the resolved subscription is the account row carrying no
        # Razorpay mandate. Every Free, manual, and trialing account. The
        # trial→paid conversion documented above falls through to exactly this
        # branch, so a refusal made a pooled tier unbuyable by the customers
        # most likely to buy it.
        #
        # Nothing is being re-scoped: no subscription exists on this path yet.
        # An ACCOUNT-scoped mandate is precisely the product a pooled plan
        # sells, so mint one and drop the agent scope the UI happened to carry.
        # Migrating an agency's EXISTING per-agent subscriptions onto a pooled
        # tier is a separate, unresolved product question, the demotion applies
        # only to the new mandate minted below.
        route_bot_id = None if plan_entitlements_service.plan_grants_unlimited_bots(new_plan) else request.bot_id
        if route_bot_id != request.bot_id:
            logger.info(
                "Client %s picked pooled plan %s from agent %s's Billing view. Minting the mandate "
                "at ACCOUNT scope (bot_id NULL), which is what the tier sells",
                client.id,
                new_plan.slug,
                request.bot_id,
            )

        billing_cycle = request.billing_cycle or (sub.billing_cycle if sub else "monthly")
        from app.services import pending_checkout_service, razorpay_service

        # Same pre-charge gates as /checkout (Wave 1.3): this branch mints a
        # REAL authorizable mandate, so it must refuse (for a missing buyer
        # identity or an untrusted/foreign country) BEFORE subscription.create,
        # not discover the gap at invoice time. The resolved country is also
        # half of the in-flight-checkout reuse key below.
        confirmed_country = _require_precharge_gates(client, http_request)

        # This branch mints the SAME kind of first mandate /checkout does, so it
        # shares /checkout's idempotency marker (``clients.pending_checkout_*``).
        # Without it a retry here minted a SECOND authorizable subscription and
        # the customer paid two full cycles for one month. Prod client 18,
        # sub_TPaGNnEfFML4Lr + sub_TPaHBPNyYV3tfe, ₹11,998 for one ₹5,999 plan.
        # Serialised by the ``lock_client_for_billing`` taken at the top of this
        # route, so a concurrent retry reads the committed marker rather than
        # racing past a read-then-write check.
        client_row = session.get(Client, client.id)
        try:
            reused = pending_checkout_service.reuse_or_supersede(
                session,
                client_row=client_row,
                client=client,
                plan=new_plan,
                billing_cycle=billing_cycle,
                country=confirmed_country,
                bot_id=route_bot_id,
            )
        except razorpay_service.RazorpayBillingError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        if reused is not None:
            session.commit()
            reused.setdefault("status", "checkout_required")
            logger.info(
                "Client %s re-opened the in-flight checkout for plan %s (%s) instead of minting a second mandate",
                client.id,
                new_plan.slug,
                billing_cycle,
            )
            return reused

        # Branch 3 is the branch a MID-TRIAL BUYER actually reaches. The console
        # treats a trialing subscription as an active one and routes plan picks
        # to /change-plan rather than /checkout, and the trial row carries no
        # gateway mandate, so branches 2a and 2b (which both require one) fall
        # through to here. Without the deferral the customer is charged today
        # and loses the free days they were promised, and the mandate carries no
        # conversion note, so it gets neither the grant at authentication nor
        # the forfeit protection that balances it.
        trial_defer_at: int | None = None
        trial_notes: dict[str, str] | None = None
        if sub is not None and sub.status == "trialing" and route_bot_id is None:
            defer_at = resolve_trial_defer_at(trial_end=sub.trial_end, promo_start_at=None)
            if defer_at is not None:
                trial_defer_at = int(defer_at.timestamp())
                trial_notes = {TRIAL_CONVERSION_NOTE: "1"}

        try:
            if route_bot_id is not None:
                result = razorpay_service.create_bot_resubscription(
                    session, client, new_plan, bot_id=route_bot_id, billing_cycle=billing_cycle
                )
            else:
                result = razorpay_service.create_subscription(
                    session,
                    client,
                    new_plan,
                    billing_cycle,
                    start_at=trial_defer_at,
                    extra_notes=trial_notes,
                )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except razorpay_service.RazorpayBillingError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        if client_row is not None:
            pending_checkout_service.record(
                client_row,
                subscription_id=result.get("subscription_id"),
                plan_id=new_plan.id,
                billing_cycle=billing_cycle,
                country=confirmed_country,
                bot_id=route_bot_id,
            )
        session.commit()
        logger.info(
            "Client %s requires Razorpay subscription auth for plan %s (%s)",
            client.id,
            new_plan.slug,
            billing_cycle,
        )
        result.setdefault("provider", "razorpay")
        result.setdefault("status", "checkout_required")
        return result


# ── Cancellation ──


@router.post("/cancel-scheduled-change")
def cancel_scheduled_change_endpoint(client: Client = Depends(get_current_client)):
    """Clear a queued downgrade so the customer stays on their current plan.

    Idempotent: returns ``{"status": "no_change_pending"}`` when nothing is
    queued. When a change WAS queued, this resets ``scheduled_*`` to NULL and
    leaves ``cancel_at_period_end`` alone, the gateway mandate was cancelled
    at-cycle-end when the downgrade was scheduled, so the customer must
    re-authorise to keep the current plan past cycle end. We surface that as
    ``mandate_action`` in the response so the frontend can prompt accordingly.
    """
    from app.services import transition_service

    with get_session() as session:
        lock_client_for_billing(session, client.id)  # serialize billing mutations (H1)
        sub = get_client_subscription(session, client.id)
        if sub is None:
            raise HTTPException(status_code=404, detail="No subscription found.")

        cleared = transition_service.cancel_scheduled_change(session, sub)
        if not cleared:
            return {"status": "no_change_pending"}

        session.commit()
        logger.info(
            "Client %s cancelled scheduled change on sub=%s",
            client.id,
            sub.id,
        )
        # The mandate was cancelled at the gateway when the downgrade was
        # scheduled; tell the UI so it can show a "Re-authorise to stay on
        # current plan" CTA. We don't auto-resume, the customer should make
        # an explicit choice rather than being silently re-billed.
        return {
            "status": "scheduled_change_cancelled",
            "mandate_action": "reauthorise_required",
            "message": "Scheduled downgrade cancelled. Re-authorise payment to stay on your current plan past cycle end.",
        }


class CancelSubscriptionRequest(BaseModel):
    # Free-text churn reason, stored and surfaced in ops reporting.
    reason: MediumText | None = None
    bot_id: RowId | None = None  # target a specific bot's subscription (N3); None = account


@router.post("/cancel")
def cancel_subscription(request: CancelSubscriptionRequest, client: Client = Depends(get_current_client)):
    """Cancel the client's subscription at the end of the current billing period.

    Records the customer's INTENT to churn (``cancel_at_period_end=True``) and
    (deliberately) touches nothing at Razorpay yet. The irreversible gateway
    cancel is executed by ``task_execute_pending_cancellations`` a couple of
    days before ``current_period_end`` (or inline below when the customer
    cancels inside that window).

    That split is the whole point. Razorpay has NO un-cancel API, so issuing
    the gateway cancel the moment the customer clicked Cancel destroyed the
    mandate ~30 days early: "Reactivate" then had to mint a brand-new
    subscription, which Razorpay starts and charges immediately, so the
    customer paid a second time for days they had already bought. With the
    gateway call deferred, changing your mind before the sweep is a free,
    instant flag flip (see ``/subscriptions/resume``).

    The operator-seat add-on rides along with the deferred cancel for the same
    reason. Cancelling it here took away seats the customer had paid for
    through period end while the plan itself kept running.

    Pass ``bot_id`` to cancel a specific bot's subscription under the per-bot
    model (N3); omit it to act on the account.
    """
    from app.services import transition_service

    with get_session() as session:
        lock_client_for_billing(session, client.id)  # serialize billing mutations (H1)
        sub = _resolve_target_subscription(session, client.id, request.bot_id)
        if not sub:
            raise HTTPException(status_code=404, detail="No active subscription found.")

        # Accept both spellings (§5): a British-spelled "cancelled" terminal row
        # would otherwise slip this guard and be cancelled a second time.
        if sub.status in ("canceled", "cancelled"):
            raise HTTPException(status_code=400, detail="Subscription is already canceled.")

        sub.cancel_at_period_end = True
        sub.canceled_at = datetime.now(UTC)
        sub.cancel_reason = request.reason
        # Clear any queued paid→paid downgrade, an outright cancel supersedes
        # it. Left set, the cancelled webhook / cron backstop would promote the
        # abandoned downgrade into a fresh checkout + re-auth email (Fix C).
        transition_service.cancel_scheduled_change(session, sub)

        # Kill any in-flight replacement checkout (from a reactivation or an
        # abandoned upgrade). Razorpay leaves a `created` subscription
        # authorizable indefinitely, so a customer who opened one, walked away,
        # and then cancelled could authorise that stale link weeks later, its
        # activation webhook would mint a fresh active subscription and RESTART
        # billing after an explicit cancellation. Best-effort: the cancellation
        # the customer asked for must not fail because a dead checkout wouldn't
        # tidy up.
        if sub.upgrade_pending_subscription_id:
            from app.services import razorpay_service as _rzp

            stale_checkout_id = sub.upgrade_pending_subscription_id
            try:
                _rzp.cancel_subscription_by_id(stale_checkout_id)
            except Exception:
                logger.warning(
                    "Could not cancel the in-flight replacement checkout %s while cancelling "
                    "subscription %s (client %s). It is unauthorised, so it cannot charge on its "
                    "own, but it should be voided at Razorpay if it is ever authorised.",
                    stale_checkout_id,
                    sub.id,
                    client.id,
                    exc_info=True,
                )
            sub.upgrade_pending_subscription_id = None
            sub.upgrade_pending_plan_id = None

        # Cancelling on (or after) the last days of the cycle leaves no room for
        # the daily sweep. Razorpay would debit the next cycle before it ran.
        # Execute inline instead. A gateway failure here IS fatal: the customer
        # asked to stop being billed and we could not make that true.
        provider = (sub.payment_provider or "razorpay").lower()
        if provider == "razorpay" and transition_service.gateway_cancel_is_due(sub):
            try:
                transition_service.execute_gateway_cancellation(session, sub)
            except Exception as exc:
                logger.exception("Provider cancel failed for sub %s: %s", sub.id, exc)
                raise HTTPException(status_code=502, detail="Could not cancel with payment provider.") from exc

        session.commit()

        logger.info(
            "Client %s canceled subscription %s (reason: %s, gateway_executed=%s)",
            client.id,
            sub.id,
            request.reason,
            sub.gateway_cancel_executed_at is not None,
        )

        return {"message": "Subscription will be canceled at the end of the current billing period."}


class ResumeSubscriptionRequest(BaseModel):
    bot_id: RowId | None = None  # target a specific bot's subscription (N3); None = account


@router.post("/resume", dependencies=[Depends(money_route_limit("resume", "10/minute", "50/day"))])
def resume_subscription(
    http_request: Request,
    request: ResumeSubscriptionRequest = ResumeSubscriptionRequest(),
    client: Client = Depends(get_current_client),
):
    """Resume a subscription that was scheduled for cancellation.

    Two modes, decided by whether the IRREVERSIBLE gateway cancel has been
    issued yet (``gateway_cancel_executed_at``).

    **Mode 1, the mandate is still live.** ``/cancel`` now records only the
    customer's intent and leaves Razorpay alone until
    ``task_execute_pending_cancellations`` runs near period end, so for almost
    every customer who changes their mind there is nothing to re-authorise:
    clear the flags and the subscription simply keeps renewing. No checkout, no
    payment. We confirm liveness with the gateway first rather than trusting the
    local marker. If the customer cancelled from Razorpay's own emails, or a
    sweep half-completed, clearing the flag would promise a renewal that never
    comes, which is the BL-3 lie this endpoint exists to avoid.

    **Mode 2, the mandate is already dead.** Razorpay has NO un-cancel API for
    an at-cycle-end cancellation, so we re-authorise by minting a FRESH
    subscription for the same plan/cycle (tagging the predecessor via
    ``prev_razorpay_subscription_id`` so it is retired at the new sub's
    activation webhook) and return ``mandate_action: "reauthorise_required"``
    with the checkout payload. The local cancel flags are NOT cleared here, the
    row must not pretend the cancellation was undone until the customer actually
    re-authorises and the activation webhook lands.

    Mode 2 mints with ``start_at`` set to the current period end so the new
    mandate first charges when the paid period actually runs out. Without it
    Razorpay starts the subscription immediately and captures a full second
    cycle for days the customer had already bought.

    Pass ``bot_id`` to resume a specific bot's subscription (N3); omit to act on
    the account's highest-tier subscription.
    """
    from app.services import razorpay_service, transition_service

    with get_session() as session:
        lock_client_for_billing(session, client.id)  # serialize billing mutations (H1)
        sub = _resolve_target_subscription(session, client.id, request.bot_id)
        if not sub:
            raise HTTPException(status_code=404, detail="No active subscription found.")

        if not sub.cancel_at_period_end:
            raise HTTPException(status_code=400, detail="Subscription is not scheduled for cancellation.")

        plan = sub.plan
        if plan is None:
            raise HTTPException(status_code=500, detail="Subscription has no associated plan.")

        billing_cycle = sub.billing_cycle or "monthly"

        _reauth_message = (
            "The previous mandate was cancelled at the payment provider and "
            "cannot be un-cancelled. Re-authorise payment to keep your plan."
        )

        # ── Mode 1: nothing was cancelled at the gateway yet ──────────────────
        if sub.gateway_cancel_executed_at is None and sub.razorpay_subscription_id:
            try:
                mandate_live = razorpay_service.is_subscription_live(sub.razorpay_subscription_id)
            except razorpay_service.RazorpayBillingError as exc:
                # Never guess. A network blip is not evidence the mandate is
                # live, and claiming "reactivated" on one is how a customer ends
                # up silently churned while the UI says the opposite.
                raise HTTPException(status_code=502, detail=str(exc)) from exc

            if mandate_live:
                sub.cancel_at_period_end = False
                sub.canceled_at = None
                sub.cancel_reason = None
                session.commit()
                logger.info(
                    "Client %s reactivated subscription %s in place (mandate %s still live)",
                    client.id,
                    sub.id,
                    sub.razorpay_subscription_id,
                )
                renews_on = sub.current_period_end.date().isoformat() if sub.current_period_end else None
                return {
                    "status": "resumed",
                    "mandate_action": "none",
                    "message": (
                        f"Subscription reactivated, it will keep renewing on {renews_on}."
                        if renews_on
                        else "Subscription reactivated, it will keep renewing."
                    ),
                    "renews_on": renews_on,
                }

            # The gateway disagrees with our marker. Self-heal so the sweep
            # doesn't try to cancel a dead mandate, then fall through to
            # re-authorisation, which is genuinely what this customer needs.
            logger.warning(
                "Subscription %s (client %s) has no gateway_cancel_executed_at but Razorpay "
                "reports mandate %s is not live. Self-healing the marker and re-authorising",
                sub.id,
                client.id,
                sub.razorpay_subscription_id,
            )
            sub.gateway_cancel_executed_at = datetime.now(UTC)
            session.flush()

        # ── Mode 2: the mandate is dead. Re-authorise ────────────────────────

        # A bot-scoped resume of a POOLED plan is refused HERE. Before the
        # gateway call. Because Mode 2 stamps ``oyechats_bot_id`` +
        # ``purpose=per_bot_subscription`` into the replacement mandate's notes
        # whenever ``sub.bot_id is not None`` (below), with no plan check of its
        # own. Authorising that mandate would land a pooled plan on a bot-scoped
        # row, funding one agent's isolated ledger while every other agent the
        # tier entitles drains the unfunded shared pool.
        #
        # Refused rather than demoted, unlike Branch 3 of /change-plan: this
        # path REPLACES an existing subscription rather than opening a new one,
        # so silently re-scoping it to the account would move that agent's
        # credit ledger, and could collide with the client's existing account
        # row on ``ix_subscriptions_client_bot_active``. Only reachable for a
        # subscription that got into this shape before the sink guard shipped;
        # support has to move it deliberately.
        #
        # Deliberately NOT applied to Mode 1 above: that path only clears a flag
        # on a mandate that is already live and already in this shape, and
        # trapping such a customer on the cancellation track adds a second
        # failure to the first.
        if sub.bot_id is not None and plan_entitlements_service.plan_grants_unlimited_bots(plan):
            raise _pooled_plan_scope_error(plan)

        # Mode 2 mints a REAL new mandate, so it runs the same pre-charge gates
        # as /checkout (Wave 1.3). Deliberately NOT applied to Mode 1 above.
        # That path only clears a flag on a live mandate, and an identity gap
        # must not block a customer from un-cancelling their own subscription.
        _require_precharge_gates(client, http_request)

        # Bill the replacement from the moment the paid period actually runs
        # out. Omitted, Razorpay starts the subscription at authorization and
        # captures a full cycle immediately. Charging the customer a second
        # time for days they already own, with no proration or refund anywhere
        # in the flow to give it back.
        start_at = int(sub.current_period_end.timestamp()) if sub.current_period_end else None
        deferred_start = sub.current_period_end is not None and sub.current_period_end > datetime.now(UTC)
        first_charge_at = sub.current_period_end.date().isoformat() if deferred_start else None
        if deferred_start:
            _reauth_message = (
                "The previous mandate was cancelled at the payment provider and cannot be "
                "un-cancelled, so a new one has to be authorised. You keep everything you've "
                f"already paid for, the first charge on the new mandate is {first_charge_at}."
            )

        # Finding H1: in-flight idempotency. /resume mints a FRESH Razorpay
        # subscription (Razorpay has no un-cancel), so a sequential double
        # /resume (two open modals, or an emailed re-auth link clicked twice)
        # would mint TWO mandates; if the customer authorises both, both first
        # cycles charge and Razorpay does NOT refund the sibling the activation
        # sweep retires. lock_client_for_billing only serialises CONCURRENT
        # calls, not a sequential re-submit. Mirror the upgrade path (finding D):
        # if a re-auth checkout for the SAME plan is already in flight, reuse it
        # instead of minting again. The markers are cleared at activation by
        # apply_pending_proration (matched via prev_razorpay_subscription_id).
        #
        # Shared with the upgrade path via ``pending_checkout_service``, because
        # "is the pending checkout dead?" is the wrong question on its own:
        # ``rebuild_upgrade_checkout`` answers ``None`` just as readily for a
        # mandate the customer has ALREADY PAID as for one they abandoned, and
        # re-minting on that answer is how a month gets charged twice.
        from app.services import pending_checkout_service

        reused = pending_checkout_service.reuse_pending_upgrade(
            session, sub=sub, client=client, plan=plan, billing_cycle=billing_cycle
        )
        if reused is not None:
            return {
                "status": "reauthorise_required",
                "mandate_action": "reauthorise_required",
                "message": _reauth_message,
                "first_charge_at": first_charge_at,
                "checkout": reused,
            }

        extra_notes: dict[str, str] = {}
        if sub.razorpay_subscription_id:
            extra_notes["prev_razorpay_subscription_id"] = sub.razorpay_subscription_id
        if sub.bot_id is not None:
            # Name the bot this mandate funds. The activation handler scopes its
            # "retire the superseded row" sweep by it; without it the sweep looks
            # for the ACCOUNT row, never retires this bot's row, and the customer
            # ends up with two live mandates and a "won't renew" banner that can
            # never clear.
            extra_notes["purpose"] = "per_bot_subscription"
            extra_notes["oyechats_bot_id"] = str(sub.bot_id)

        if not deferred_start:
            # No paid time left to protect (period already ended, or we have no
            # anchor), so the replacement bills now and its activation resets the
            # plan allowance. Snapshot the unused credits the way the upgrade
            # path does so ``apply_pending_proration`` re-grants them as a top-up
            # instead of letting the reset silently destroy them. Scoped to the
            # subscription being resumed, a per-bot resume must snapshot that
            # bot's own pool, not the account pool.
            sub.upgrade_credit_pending_cents = transition_service.remaining_plan_credits(
                session, client.id, bot_id=sub.bot_id
            )

        try:
            checkout = razorpay_service.create_subscription(
                session,
                client,
                plan,
                billing_cycle,
                extra_notes=extra_notes or None,
                start_at=start_at,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except razorpay_service.RazorpayBillingError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        # Record the in-flight checkout so a sequential re-submit reuses it
        # (finding H1). Cleared at activation by apply_pending_proration.
        sub.upgrade_pending_subscription_id = checkout.get("subscription_id")
        sub.upgrade_pending_plan_id = plan.id
        session.flush()

        session.commit()
        checkout.setdefault("provider", "razorpay")
        logger.info(
            "Client %s requested resume for sub=%s → re-authorise required (fresh sub %s, first charge %s)",
            client.id,
            sub.id,
            checkout.get("subscription_id"),
            first_charge_at or "immediately",
        )
        return {
            "status": "reauthorise_required",
            "mandate_action": "reauthorise_required",
            "message": _reauth_message,
            "first_charge_at": first_charge_at,
            "checkout": checkout,
        }


# ── Operator-seat add-on ──


class SeatChangeRequest(BaseModel):
    # +1 to add a seat, -1 to remove. Must keep the total at or above the
    # plan's included floor (checked against the subscription below). Bounded
    # here because each unit is a real charge on the customer's mandate, an
    # unbounded delta is an unbounded invoice.
    delta: int = Field(..., ge=-_MAX_SEAT_DELTA, le=_MAX_SEAT_DELTA)
    bot_id: RowId | None = None  # target a specific bot's subscription (N3); None = account


@router.post("/seats", dependencies=[Depends(money_route_limit("seats", "10/minute", "50/day"))])
def change_seat_count(
    request: SeatChangeRequest,
    http_request: Request,
    client: Client = Depends(get_current_client),
    _verified: Client = Depends(require_verified_email),
):
    """Add or remove operator seats from the active subscription.

    Each seat above ``plan.included_operator_seats`` is billed through a
    SEPARATE Razorpay add-on subscription (``RAZORPAY_SEAT_PLAN_ID``, whose
    plan amount IS the per-seat price). The main plan subscription is never
    edited for seats. Razorpay ``quantity`` multiplies the WHOLE plan
    amount, which would overcharge the customer (P0-3). The local
    ``operator_quantity`` mirror is updated immediately so live-chat seat
    enforcement sees the new limit without webhook latency.
    """
    if request.delta == 0:
        raise HTTPException(status_code=400, detail="Delta must be non-zero.")

    # Adding seats mints (or edits) a real seat-addon mandate whose charges are
    # invoiced, same pre-charge gates as every other mint. Removing seats
    # charges nothing and stays ungated.
    if request.delta > 0:
        _require_precharge_gates(client, http_request)

    with get_session() as session:
        lock_client_for_billing(session, client.id)  # serialize billing mutations (H1)
        sub = _resolve_target_subscription(session, client.id, request.bot_id)
        if not sub:
            raise HTTPException(status_code=404, detail="No active subscription found.")
        plan = sub.plan
        if plan is None:
            raise HTTPException(status_code=500, detail="Subscription has no associated plan.")

        floor = seat_floor_for(plan)
        if floor < 0:
            # UNLIMITED (-1) included seats: there is no add-on to sell. Falling
            # through would compute ``extra_seats = new_total - (-1)`` and mint a
            # real, charged seat mandate for capacity the plan already grants.
            raise HTTPException(
                status_code=400,
                detail="Your plan includes unlimited operator seats. Seats cannot be added or removed.",
            )

        new_total = (sub.operator_quantity or floor) + request.delta
        if new_total < floor:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot reduce below the {floor} included seat(s) on your plan.",
            )

        # Mirror the floor check with a ceiling check: a client should never
        # be able to pay for more seats than the plan allows them to
        # actually use. `operator_routes.create_operator` caps operator
        # *creation* at this same value, without this check here, billing
        # would happily sell seats past that cap, charging for capacity
        # the client could never activate.
        ceiling = (plan.limits or {}).get("operators")
        has_ceiling = isinstance(ceiling, int) and not isinstance(ceiling, bool) and ceiling != _UNLIMITED_SEATS
        if has_ceiling:
            if seat_ceiling_blocks(plan, new_total=new_total):
                # A plan granting zero operators can never use a seat, so say
                # that rather than quoting a "0 seat(s) allowed" limit at
                # someone who is trying to buy their first one.
                detail = (
                    "Your plan does not include operator seats. Upgrade to add a teammate."
                    if ceiling == 0
                    else f"Cannot exceed the {ceiling} seat(s) allowed on your plan. Upgrade for more."
                )
                raise HTTPException(status_code=400, detail=detail)
        elif new_total > _MAX_OPERATOR_SEATS_ABSOLUTE:
            # §5: a plan with no ``limits.operators`` had NO ceiling, so an
            # unbounded delta could mint hundreds of seat charges in one call.
            # Enforce an absolute safety cap.
            raise HTTPException(
                status_code=400,
                detail=f"Cannot exceed {_MAX_OPERATOR_SEATS_ABSOLUTE} operator seats. Contact support for more.",
            )

        # Seats above the plan's included floor are billed via a SEPARATE
        # add-on subscription, the main plan's quantity is never touched
        # (P0-3). extra_seats is clamped at 0 inside the helper.
        extra_seats = new_total - floor

        # Finding H3/J: all extra seats bill against the single global seat plan,
        # so the amount charged is the canonical seat price. NOT a plan's own
        # ``extra_seat_price_cents``. Resolve the charged price in the customer's
        # currency (₹449 INR / $5 international) so the displayed price always
        # equals what the add-on bills. Log any per-plan divergence so a
        # misconfigured plan row is visible (the plan-edit guard normally keeps
        # them equal).
        seat_price_cents, seat_currency = seat_price(
            inr_cents=app_config.RAZORPAY_SEAT_PLAN_PRICE_CENTS,
            usd_cents=app_config.EXTRA_SEAT_PRICE_USD_CENTS,
            currency=plan.currency,
        )
        # ``seat_price_cents`` is the BASE. The add-on mandate collects base +
        # GST, and the Razorpay sheet in this same response already says so, so
        # the caller needs the gross too or its card and its checkout disagree.
        seat_tax_rate_bps = charge_tax_rate_bps(session)
        gross_seat_price_cents = gross_charge_minor(
            seat_price_cents,
            rate_bps=seat_tax_rate_bps,
            kind="export" if seat_currency == "USD" else "intra",
        )
        if extra_seats > 0 and int(plan.extra_seat_price_cents or 0) != app_config.RAZORPAY_SEAT_PLAN_PRICE_CENTS:
            logger.warning(
                "Plan %s extra_seat_price_cents=%s but the seat add-on charges %s. "
                "displaying the charged price; fix the plan config to match.",
                plan.id,
                plan.extra_seat_price_cents,
                app_config.RAZORPAY_SEAT_PLAN_PRICE_CENTS,
            )

        try:
            from app.services import razorpay_service

            checkout = razorpay_service.edit_seat_addon_quantity(session, sub, extra_seats)
        except razorpay_service.IntlPaymentsDisabled:
            # Policy refusal, not a gateway fault. Propagate to the app-level
            # handler so /seats renders the 409 intl_usd_pending contact-sales
            # contract instead of a "try again" 502.
            raise
        except razorpay_service.RazorpayBillingError as exc:
            logger.exception("Seat add-on update failed for client %s: %s", client.id, exc)
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Seat update failed for client %s: %s", client.id, exc)
            raise HTTPException(status_code=502, detail="Could not update seats with payment provider.") from exc

        if checkout is not None:
            # First seat purchase → the mandate isn't authorized yet, so we do
            # NOT grant entitlement (finding A). The client opens this checkout;
            # the seat ``activated`` webhook bumps operator_quantity. Persist the
            # pending marker set inside the helper and return the checkout.
            session.commit()
            logger.info(
                "Client %s seat purchase pending authorization → %s (extra=%s)", client.id, new_total, extra_seats
            )
            return {
                "message": "Authorize the seat add-on to activate your new seats.",
                "requires_authorization": True,
                "checkout": checkout,
                "pending_seats": extra_seats,
                "operator_quantity": sub.operator_quantity,  # unchanged until webhook
                "included_operator_seats": floor,
                "extra_seat_price_cents": seat_price_cents,
                "gross_extra_seat_price_cents": gross_seat_price_cents,
                "tax_rate_bps": seat_tax_rate_bps,
                "currency": seat_currency,
            }

        # Edit against an already-authorized add-on (or a reduction) → the change
        # applies immediately, so the local entitlement mirror can move now.
        sub.operator_quantity = new_total
        session.commit()
        logger.info("Client %s changed seat count → %s (extra=%s)", client.id, new_total, extra_seats)
        return {
            "message": "Seats updated.",
            "total_seats": new_total,
            "extra_seats": extra_seats,
            "operator_quantity": new_total,
            "included_operator_seats": floor,
            "extra_seat_price_cents": seat_price_cents,
            "gross_extra_seat_price_cents": gross_seat_price_cents,
            "tax_rate_bps": seat_tax_rate_bps,
            "currency": seat_currency,
        }


# ── Branding-removal add-on ──


class BrandingAddonRequest(BaseModel):
    bot_id: RowId | None = None  # target a specific bot's subscription; None = account


def _branding_addon_state(sub, session, *, checkout=None, message: str) -> dict:
    """Uniform response body for every branding add-on route.

    The frontend renders one card off this shape, so purchase, re-open and
    cancel must all answer with the same keys, ``active`` being the entitlement
    the UI unlocks on.
    """
    price_cents, currency = seat_price(
        inr_cents=app_config.RAZORPAY_BRANDING_PLAN_PRICE_CENTS,
        usd_cents=app_config.BRANDING_ADDON_PRICE_USD_CENTS,
        currency=sub.plan.currency if sub.plan else "INR",
    )
    # ``price_cents`` is the BASE. The card that renders this response has a buy
    # button on it, so it also needs the gross the mandate will collect.
    tax_rate_bps = charge_tax_rate_bps(session)
    gross_price_cents = gross_charge_minor(
        price_cents, rate_bps=tax_rate_bps, kind="export" if currency == "USD" else "intra"
    )
    return {
        "message": message,
        "active": bool(sub.branding_addon_active),
        "pending": bool(sub.branding_addon_pending),
        "requires_authorization": checkout is not None,
        "checkout": checkout,
        "price_cents": price_cents,
        "gross_price_cents": gross_price_cents,
        "tax_rate_bps": tax_rate_bps,
        "currency": currency,
    }


@router.post("/branding-addon", dependencies=[Depends(money_route_limit("branding_addon", "10/minute", "50/day"))])
def purchase_branding_addon(
    request: BrandingAddonRequest,
    http_request: Request,
    client: Client = Depends(get_current_client),
    _verified: Client = Depends(require_verified_email),
):
    """Buy the branding-removal add-on for a subscription.

    Branding removal is not bundled into any plan tier: it is sold only here,
    on its own Razorpay mandate, for the same reason seats are (a Razorpay
    ``quantity`` would multiply the whole plan amount). The entitlement is NOT
    granted by this call. The mandate is minted in ``created`` state and
    charges nothing until the customer authorizes the returned checkout, so
    ``branding_addon_active`` is flipped by the ``activated`` webhook instead.
    """
    _require_precharge_gates(client, http_request)

    with get_session() as session:
        lock_client_for_billing(session, client.id)  # serialize billing mutations (H1)
        sub = _resolve_target_subscription(session, client.id, request.bot_id)
        if not sub:
            raise HTTPException(status_code=404, detail="No active subscription found.")
        if sub.plan is None:
            raise HTTPException(status_code=500, detail="Subscription has no associated plan.")
        if (sub.plan.slug or "").lower() == "free":
            # The add-on rides on a paid subscription. Selling it against Free
            # would mint a mandate for an entitlement the resolver refuses to
            # grant, so the customer would pay and see nothing change.
            raise HTTPException(
                status_code=400,
                detail="The branding removal add-on requires a paid plan.",
            )

        if sub.branding_addon_active:
            return _branding_addon_state(sub, session, message="The branding removal add-on is already active.")

        try:
            from app.services import razorpay_service

            checkout = razorpay_service.purchase_branding_addon(session, sub)
        except razorpay_service.IntlPaymentsDisabled:
            # Policy refusal, not a gateway fault. Propagate so the app-level
            # handler renders the 409 intl_usd_pending contact-sales contract.
            raise
        except razorpay_service.RazorpayBillingError as exc:
            logger.exception("Branding add-on purchase failed for client %s: %s", client.id, exc)
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Branding add-on purchase failed for client %s: %s", client.id, exc)
            raise HTTPException(
                status_code=502, detail="Could not start the branding add-on with the payment provider."
            ) from exc

        session.commit()
        logger.info("Client %s branding add-on purchase pending authorization", client.id)
        return _branding_addon_state(
            sub,
            session,
            checkout=checkout,
            message="Authorize the add-on to remove OyeChats branding.",
        )


@router.delete("/branding-addon")
def cancel_branding_addon(
    request: BrandingAddonRequest,
    client: Client = Depends(get_current_client),
):
    """Cancel the branding-removal add-on.

    Cancels immediately rather than at cycle end, matching the seat add-on, so
    the customer stops being billed the moment they ask. The badge reappears on
    their widget within the entitlements cache TTL.

    Not behind ``require_verified_email`` or the pre-charge gates: this call
    only ever REMOVES a charge, and blocking it would trap a customer in a
    subscription they are trying to leave.
    """
    with get_session() as session:
        lock_client_for_billing(session, client.id)
        sub = _resolve_target_subscription(session, client.id, request.bot_id)
        if not sub:
            raise HTTPException(status_code=404, detail="No active subscription found.")
        if not sub.branding_addon_subscription_id and not sub.branding_addon_active:
            return _branding_addon_state(sub, session, message="The branding removal add-on is not active.")

        try:
            from app.services import razorpay_service

            razorpay_service.cancel_branding_addon(session, sub)
        except razorpay_service.RazorpayBillingError as exc:
            logger.exception("Branding add-on cancel failed for client %s: %s", client.id, exc)
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        session.commit()
        _invalidate_branding_caches(session, client.id)
        logger.info("Client %s cancelled the branding add-on", client.id)
        return _branding_addon_state(
            sub, session, message="Branding removal cancelled. The badge will reappear shortly."
        )


def _invalidate_branding_caches(session, client_id: int) -> None:
    """Drop the entitlement caches a branding add-on change invalidates.

    The widget reads the PER-BOT resolver, so dropping only the account slot
    would leave the badge hidden for up to the 60s TTL after a cancel, i.e. a
    paid feature still running after the customer stopped paying for it.
    Best-effort: a cache miss only costs a query.
    """
    try:
        plan_entitlements_service.invalidate(client_id)
        for bot_id in session.execute(select(Bot.id).where(Bot.client_id == client_id)).scalars().all():
            plan_entitlements_service.invalidate_bot(bot_id)
    except Exception:
        logger.debug("branding add-on cache invalidation failed for client=%s", client_id, exc_info=True)


# ── Credits API (companion router) ──


@credits_router.get("/balance")
def get_credit_balance(http_request: Request, client: Client = Depends(get_current_client)):
    """Return everything the Billing page needs in one round-trip:

    * Current credit balance (plan + top-up + soonest expiry).
    * Monthly grant + reset date (driven by the active subscription period).
    * Per-action credit costs from ``pricing_config`` so the UI can render
      "1 AI chat = 1 credit" without baking the values in.
    * This-period usage (count of chats / URL crawls / customer emails the
      customer has consumed since the last ``plan_grant``). Useful for the
      "How you're using credits" panel.
    * Currency display info (symbol + code) so localisation is centralised.
    """
    from sqlalchemy import func

    from app.db.models import Bot, CreditLedger, Document, LeadInfo, Operator

    def _scope_period_and_usage(session, client_id: int, bot_id: int | None):
        """Pull period anchor + per-reason usage for one ledger scope."""
        scope = (
            CreditLedger.client_id == client_id,
            CreditLedger.bot_id.is_(None) if bot_id is None else CreditLedger.bot_id == bot_id,
        )
        period_start = (
            session.execute(
                select(CreditLedger.created_at)
                .where(*scope, CreditLedger.reason == "plan_grant", CreditLedger.delta > 0)
                .order_by(CreditLedger.created_at.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )
        usage_q = select(
            CreditLedger.reason,
            func.coalesce(func.sum(-CreditLedger.delta), 0).label("credits_used"),
            func.count(CreditLedger.id).label("event_count"),
        ).where(
            *scope,
            CreditLedger.delta < 0,
            CreditLedger.reason.in_(_CONSUMPTION_REASONS),
        )
        if period_start is not None:
            usage_q = usage_q.where(CreditLedger.created_at >= period_start)
        usage_q = usage_q.group_by(CreditLedger.reason)
        usage_by_reason = {
            row.reason: {"credits_used": int(row.credits_used), "event_count": int(row.event_count)}
            for row in session.execute(usage_q).all()
        }
        empty = {"credits_used": 0, "event_count": 0}
        return period_start, {reason: usage_by_reason.get(reason, dict(empty)) for reason in _CONSUMPTION_REASONS}

    with get_session() as session:
        # Account-level pool (legacy + Free bot drain from here).
        breakdown = credit_service.get_balance_breakdown(session, client.id)
        sub = get_client_subscription(session, client.id)
        plan = get_client_plan(session, client.id)

        period_start, usage_dict = _scope_period_and_usage(session, client.id, None)

        # Per-bot ledgers, one entry per bot that has its own paid
        # subscription. Frontend renders one card per entry so the
        # customer sees an isolated balance + usage panel for each bot.
        #
        # PAUSED agents are included deliberately. ``Bot.is_active`` is the
        # pause switch (``bot_routes.update_bot``), not a delete: a paused
        # per-bot-funded agent keeps its own subscription, keeps being charged
        # for it, and keeps a balance that expires on schedule. Filtering the
        # column here dropped that agent's card entirely, so the customer saw
        # no balance, no usage and no expiry warning for a ledger their money
        # is still funding. The pause is disclosed on the entry instead
        # (``is_active``), which is the honest shape: show the balance, say why
        # the agent is not answering.
        #
        # Bots with no ledger of their own are still skipped below via
        # ``resolve_bot_ledger_bot_id``, so this widens the query, not the
        # output: only bots whose subscription is scoped to themselves get a
        # card, active or paused.
        bot_rows = session.execute(select(Bot).where(Bot.client_id == client.id).order_by(Bot.id)).scalars().all()
        bot_ledgers: list[dict] = []
        for bot in bot_rows:
            ledger_bot_id = credit_service.resolve_bot_ledger_bot_id(bot)
            if ledger_bot_id is None:
                continue  # legacy / Free bot, its usage rolls up to the account pool
            bot_plan = bot.plan if bot.plan_id else None
            bot_breakdown = credit_service.get_balance_breakdown(session, client.id, bot_id=ledger_bot_id)
            bot_period_start, bot_usage = _scope_period_and_usage(session, client.id, ledger_bot_id)
            bot_sub = bot.subscription

            # ── Per-agent plan ceilings + usage (drives the Usage page's
            # "Plan limits" section when this agent is the active scope). Limits
            # come straight from the agent's own plan; usage is counted scoped to
            # this bot so it mirrors the per-agent Members / Knowledge / Leads
            # surfaces rather than the account-wide totals.
            bot_limits = dict(bot_plan.limits or {}) if bot_plan else {}
            bot_operators_used = int(
                session.execute(
                    select(func.count(Operator.id)).where(
                        Operator.client_id == client.id,
                        Operator.bot_id == bot.id,
                        Operator.is_active.is_(True),
                    )
                ).scalar()
                or 0
            )
            bot_documents_used = int(
                session.execute(
                    select(func.count(func.distinct(Document.document_name))).where(
                        Document.bot_id == bot.id,
                        Document.source == "upload",
                    )
                ).scalar()
                or 0
            )
            lead_period_start = (
                bot_sub.current_period_start if bot_sub and bot_sub.current_period_start else bot_period_start
            )
            bot_leads_used = 0
            if lead_period_start is not None:
                bot_leads_used = int(
                    session.execute(
                        select(func.count(LeadInfo.id)).where(
                            LeadInfo.bot_id == bot.id,
                            LeadInfo.created_at >= lead_period_start,
                        )
                    ).scalar()
                    or 0
                )

            bot_ledgers.append(
                {
                    "bot_id": bot.id,
                    "bot_name": bot.name,
                    "bot_key": bot.bot_key,
                    # Paused agents still bill and still hold credits; the card
                    # says so rather than vanishing.
                    "is_active": bool(bot.is_active),
                    "plan_slug": bot_plan.slug if bot_plan else None,
                    "plan_name": bot_plan.name if bot_plan else None,
                    "monthly_grant": int(bot_plan.credits_per_month or 0) if bot_plan else 0,
                    "billing_cycle": bot_sub.billing_cycle if bot_sub else None,
                    "subscription_status": bot_sub.status if bot_sub else None,
                    "plan": bot_breakdown["plan"],
                    "topup": bot_breakdown["topup"],
                    "total": bot_breakdown["total"],
                    "soonest_expiry": bot_breakdown["soonest_expiry"].isoformat()
                    if bot_breakdown["soonest_expiry"]
                    else None,
                    "period_start": bot_period_start.isoformat() if bot_period_start else None,
                    "resets_at": effective_resets_at(bot_sub).isoformat()
                    if bot_sub and effective_resets_at(bot_sub)
                    else None,
                    "usage": bot_usage,
                    # Per-agent "Plan limits" data.
                    "limits": bot_limits,
                    "limit_usage": {
                        "operators": bot_operators_used,
                        "documents": bot_documents_used,
                        "leads": bot_leads_used,
                    },
                }
            )

        # Count of bots that still drain from the account pool. Drives
        # whether the UI shows the "Account credits" card. When zero (a
        # paid-only account whose only bot has its own subscription) the
        # account pool is hidden entirely. Counted over the same unfiltered
        # ``bot_rows``: a paused pooled bot still has its usage rolled into the
        # account pool, so hiding the pool card because the only pooled bot is
        # paused would hide a live balance for the same reason.
        account_pool_bot_count = sum(1 for bot in bot_rows if credit_service.resolve_bot_ledger_bot_id(bot) is None)

        costs = _credit_costs_payload(session)

        # Stored country first, IP geo as display fallback (Wave 1.2), the
        # old IP-only rule rendered $ on a rupee account whenever the geo
        # lookup failed, and ignored the account's own tax fact entirely.
        currency_code = resolve_billing_context(
            stored_country=client.billing_country,
            detected_country=resolve_country(http_request),
        ).currency
        currency_symbol = "₹" if currency_code == "INR" else "$"

        next_reset = effective_resets_at(sub)
        return {
            "plan": breakdown["plan"],
            "topup": breakdown["topup"],
            "total": breakdown["total"],
            "soonest_expiry": breakdown["soonest_expiry"].isoformat() if breakdown["soonest_expiry"] else None,
            "monthly_grant": int(plan.credits_per_month or 0) if plan else 0,
            "resets_at": next_reset.isoformat() if next_reset else None,
            "period_start": period_start.isoformat() if period_start else None,
            "costs": costs,
            "usage": usage_dict,
            "currency": currency_code,
            "currency_symbol": currency_symbol,
            # ── Per-bot ledger breakdown ──
            # ``bots`` is one entry per bot with its own paid
            # subscription. The account-level fields above describe the
            # client pool (legacy + Free bots). When ``bots`` is non-empty
            # the Billing page renders one card per bot in addition to
            # (or instead of) the account card.
            "bots": bot_ledgers,
            "account_pool_bot_count": account_pool_bot_count,
        }


def _credit_costs_payload(session: Session) -> dict[str, int]:
    """The per-action credit prices ``GET /credits/balance`` serves, all from ``pricing_config``.

    Module-level so the price the customer is SHOWN can be asserted against the
    price they are CHARGED (``tests/test_document_upload_rate.py``). It used to
    be an inline dict, which meant the only way to pin the two together was to
    grep the console's TSX for a hard-coded sentence, across two repositories,
    and that guard broke the moment the console was rebuilt.

    ``document_upload`` is the per-file FLOOR, not the price: a document with
    at least one extractable word is charged
    ``ceil(words / document_upload_words_per_credit)`` credits, never below that
    floor (``credit_service.get_document_upload_cost_for_size``). Serving only
    the floor left the console unable to state what an upload actually costs, so
    the rate is served beside it.

    Every field is read through the accessor the deduction path uses —
    ``credit_service.get_credit_cost`` for the per-action prices,
    ``get_document_upload_floor`` / ``get_document_upload_words_per_credit`` for
    the upload pair — so the price shown and the price charged are one value,
    including when the stored config is unusable.
    """
    # EVERY number here comes from the deduction path's own accessors, never
    # from a re-read of the raw config. ``value`` is untyped JSONB and a super
    # admin can save 0, a negative, null, a decimal or a word into any of these
    # keys: a 0 rate would reach the console as "1 credit per 0 words", a 0
    # floor would advertise a free upload that
    # ``get_document_upload_cost_for_size`` still charges 1 credit for, and a
    # bare ``int(...)`` on a word or a list RAISES — which turned one typo in an
    # internal pricing panel into a 500 on the Usage and Billing pages for every
    # customer, while billing carried on charging correctly. Reading what the
    # charge path reads is the only way the two cannot disagree.
    # ``warn=False`` on the rate because the deduction path already logs a bad
    # one on every upload; repeating it on every balance poll would bury it.
    return {
        "ai_chat": credit_service.get_credit_cost(session, "ai_chat"),
        "url_scan": credit_service.get_credit_cost(session, "url_scan"),
        "email_send": credit_service.get_credit_cost(session, "email_send"),
        "document_upload": credit_service.get_document_upload_floor(session),
        "email_verification": credit_service.get_credit_cost(session, "email_verification"),
        "company_name": credit_service.get_credit_cost(session, "company_name"),
        "document_upload_words_per_credit": credit_service.get_document_upload_words_per_credit(session, warn=False),
    }


@credits_router.get("/history")
def get_credit_history(
    client: Client = Depends(get_current_client),
    page: int = 1,
    limit: int = 50,
    bot_id: int | None = None,
):
    """Return paginated ledger entries for the client (most recent first).

    Answers ``{entries, total, page, limit}``. ``total`` is a count over the
    same filtered query, so a client can page the ledger honestly instead of
    guessing from whether the last page came back full.

    When ``bot_id`` is given, the history is scoped to that agent's own ledger
    (entries carry ``CreditLedger.bot_id``); the ``client_id`` filter still
    applies, so a foreign ``bot_id`` simply matches nothing rather than leaking
    another workspace's rows. Omit ``bot_id`` for the workspace-wide history.
    """
    page = max(int(page or 1), 1)
    limit = max(min(int(limit or 50), 200), 1)
    with get_session() as session:
        base = select(CreditLedger).where(
            CreditLedger.client_id == client.id,
            *([CreditLedger.bot_id == bot_id] if bot_id is not None else []),
        )
        total = session.execute(select(func.count()).select_from(base.subquery())).scalar() or 0
        rows = (
            session.execute(
                # ``created_at`` is a ``server_default=func.now()`` transaction
                # timestamp, so every row written in one transaction shares it
                # EXACTLY. A FIFO-boundary deduction writes two such rows. With
                # no tiebreak the sort is not a total order and Postgres may
                # resolve the tie differently for the OFFSET 0 query and the
                # OFFSET N one, so the same movement appears on two pages, or on
                # neither. That is a customer-visible billing discrepancy that
                # raises no error anywhere. The id tiebreak makes the order
                # total, and matches insertion order within a transaction.
                base.order_by(CreditLedger.created_at.desc(), CreditLedger.id.desc())
                .limit(limit)
                .offset((page - 1) * limit)
            )
            .scalars()
            .all()
        )
        return {
            "entries": [
                {
                    "id": r.id,
                    "delta": r.delta,
                    "reason": r.reason,
                    "reference_id": r.reference_id,
                    "expires_at": r.expires_at.isoformat() if r.expires_at else None,
                    "note": r.note,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in rows
            ],
            "total": int(total),
            "page": page,
            "limit": limit,
        }


# Reasons that represent actual metered consumption (always debit rows). Kept
# in sync with the four usage buckets the balance breakdown reports, so the
# trend and the breakdown agree on what "credits used" means. Deliberately
# excludes plan_grant (grants + monthly resets), topup, refund, expiry, and
# manual_adjust. None of which are consumption.
_CONSUMPTION_REASONS = (
    "ai_chat",
    "url_scan",
    "email_send",
    "document_upload",
    "email_verification",
    "company_name",
)


@credits_router.get("/daily")
def get_credit_daily(
    client: Client = Depends(get_current_client),
    days: int = 30,
    bot_id: int | None = None,
):
    """Daily credit consumption for the last ``days`` days (zero-filled).

    Sums the magnitude of consumption debits per calendar day (UTC) so the
    Usage page can render a trend line. Returns a complete ascending series
    (one entry per day in the window, ``credits_used = 0`` on quiet days) so
    the client can render without gap-filling.
    """
    days = max(min(int(days or 30), 90), 1)
    now = datetime.now(UTC)
    window_start = now - timedelta(days=days)
    first_day = (now - timedelta(days=days - 1)).date()

    # Cast to a UTC calendar date so grouping is stable regardless of the DB
    # session timezone (created_at is a timezone-aware UTC timestamp).
    day_col = func.date(func.timezone("UTC", CreditLedger.created_at))

    with get_session() as session:
        rows = session.execute(
            select(
                day_col.label("day"),
                func.coalesce(func.sum(-CreditLedger.delta), 0).label("used"),
            )
            .where(
                CreditLedger.client_id == client.id,
                CreditLedger.reason.in_(_CONSUMPTION_REASONS),
                CreditLedger.created_at >= window_start,
                *([CreditLedger.bot_id == bot_id] if bot_id is not None else []),
            )
            .group_by(day_col)
        ).all()

        by_day = {str(r.day): int(r.used or 0) for r in rows}
        series = [
            {
                "date": (day := (first_day + timedelta(days=offset)).isoformat()),
                "credits_used": by_day.get(day, 0),
            }
            for offset in range(days)
        ]
        return {"days": days, "series": series}


class TopupRequest(BaseModel):
    """Top-up purchase request.

    ``amount`` is the pack amount matching one of the configured packs in
    ``pricing_config.topup_packs``. ``pack_usd`` is kept as a backward-compat
    alias for older admin builds, at least one of the two must be provided.

    ``bot_id`` scopes the purchase to a specific per-bot ledger. Omit
    (or pass null) to top up the account-level client pool. That's the
    correct shape for Free / legacy-pooled bots whose usage drains
    shared credits. Per-bot subscriptions must always pass their bot_id
    so the credits land in the right isolated bucket.
    """

    amount: int | None = None
    pack_usd: int | None = None  # legacy alias
    bot_id: int | None = None
    # Confirmed at the top-up modal (same country-confirmation contract as
    # /checkout's CheckoutRequest.billing_country). None → fall back to the
    # client's stored country, else domestic (IN) for backward-compat callers.
    billing_country: str | None = None


def _match_topup_pack(packs: list[dict], requested_amount: int) -> dict | None:
    """Find a pack whose configured INR price matches ``requested_amount``.

    Packs carry their INR BASE price under ``inr`` (``amount`` is a legacy
    alias); the amount charged is that plus GST. The frontend sends the base, so
    we match on the base: matching on the gross would make the selection depend
    on the tax rate and break every client that sends the advertised figure.
    ``usd`` is a display-only figure and is accepted only as a last-resort
    legacy fallback.
    """
    for pack in packs:
        # round(), not int(): pack prices come from operator-edited JSON in
        # pricing_config and can arrive as floats. Int() truncation turned a
        # "1599.99" pack into 1599 and silently failed every match.
        if int(round(float(pack.get("inr") or pack.get("amount") or pack.get("usd") or 0))) == requested_amount:
            return pack
    return None


def _validate_coupon_or_400(session, coupon_code: str | None) -> None:
    """Refuse any coupon we cannot actually honour (Wave 4a).

    ``coupon_code`` used to be accepted and silently IGNORED, the customer
    believed a discount applied and was charged full price. There is a
    ``coupons`` table (superadmin CRUD) but no online redemption realiser, so
    the honest behaviour is: unknown/inactive/expired → "invalid"; a genuinely
    valid code → an explicit "not redeemable online" refusal, never a silent
    full-price charge. (Product default: kill the field; wire redemption only
    if product asks for it.)
    """
    code = (coupon_code or "").strip()
    if not code:
        return
    from app.db.models import Coupon

    coupon = session.execute(select(Coupon).where(func.lower(Coupon.code) == code.lower())).scalar_one_or_none()
    now = datetime.now(UTC)
    valid = (
        coupon is not None
        and coupon.is_active
        and (coupon.expires_at is None or coupon.expires_at > now)
        and (coupon.max_redemptions is None or (coupon.redemptions or 0) < coupon.max_redemptions)
    )
    if not valid:
        raise HTTPException(status_code=400, detail="Invalid or expired coupon code.")
    raise HTTPException(
        status_code=400,
        detail=(
            "Coupon codes can't be redeemed online yet. Contact developer@oyechats.com "
            "and we'll apply it to your account."
        ),
    )


def _assert_no_stacking(client, coupon_code: str | None) -> None:
    """Prevent a referral-code discount from being combined with a manual coupon.

    A referral code already locks in the customer discount at subscription
    creation. Layering a second coupon on top would double-discount the same
    period and pay the affiliate commission twice on revenue we're not
    collecting. Raise 400 so the frontend can surface a friendly message.
    """
    if getattr(client, "referral_code_id", None) and coupon_code:
        raise HTTPException(
            status_code=400,
            detail="Cannot apply a coupon when a referral code is already active on your account.",
        )


@credits_router.post("/topup", dependencies=[Depends(money_route_limit("topup", "10/minute", "50/day"))])
def initiate_topup(
    request: TopupRequest,
    http_request: Request,
    client: Client = Depends(get_current_client),
    _verified: Client = Depends(require_verified_email),
):
    """Initiate a top-up purchase via Razorpay.

     Returns a Razorpay order payload:
     ``{provider, order_id, amount, currency, key_id, name, description, prefill, theme}``
    . Frontend opens ``new Razorpay({order_id, ...}).open()``.

     Credits are granted asynchronously via the Razorpay webhook on payment
     capture; the frontend should also call ``/credits/topup/verify`` so the
     success modal is signature-verified server-side before showing confetti
     (defence-in-depth against tampered callbacks).
    """
    requested_amount = request.amount or request.pack_usd
    if not requested_amount:
        raise HTTPException(status_code=400, detail="amount is required.")

    # Same billing-country gate as /checkout (audit F-topup-gst): a top-up is
    # also a Razorpay charge, and razorpay_service.create_topup_order hard-codes
    # the INR rail. Without this gate a confirmed/stored non-IN buyer's top-up
    # would be silently charged in INR and later invoiced as an export by
    # invoice_service (which classifies supply from buyer.billing_country).
    # GST mis-classified / short-paid. Gate BEFORE opening a session so a
    # rejected buyer never reaches Razorpay at all.
    confirmed_country = _resolve_confirmed_billing_country_or_409(
        request_country=request.billing_country,
        client=client,
        http_request=http_request,
        # Explicitly closed even when INTL_PAYMENTS_ENABLED opens subscription
        # checkout: create_topup_order still charges the INR pack price, so a
        # foreign buyer must keep 409ing here until top-up packs carry a USD
        # amount of their own.
        allow_usd=False,
    )

    # A top-up is invoiced exactly like a subscription charge, so both money
    # paths collect the Rule 46 buyer identity. Ordered AFTER the country gate
    # on purpose: an unservable country is the more fundamental refusal, and
    # asking a foreign buyer to complete Indian billing details we will then
    # reject anyway would be a dead end.
    _require_billing_identity(client)

    with get_session() as session:
        provider = _resolve_provider()

        # topup_allowed is a PLAN feature and was only ever enforced by the
        # frontend hiding the button (Wave 4b): calling the API directly let a
        # Free account buy credits the plan matrix says it can't have. All
        # paid tiers carry the flag; Free does not.
        from app.services import plan_entitlements_service

        ents = plan_entitlements_service.get_entitlements(client.id, session)
        if not ents.has_feature("topup_allowed"):
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "topup_not_allowed",
                    "plan_slug": ents.plan_slug,
                    "message": (
                        f"Credit top-ups aren't available on the {ents.plan_name} plan. "
                        "upgrade to a paid plan to buy extra credits."
                    ),
                },
            )

        # Persist the confirmed country for invoice place-of-supply, mirroring
        # create_checkout. A GSTIN pins the country to IN, so never let a
        # top-up flip it. Only write when the caller explicitly confirmed a
        # country (don't overwrite a stored value with the IN default of an
        # omitted field).
        if request.billing_country:
            # Freeze-honouring persist, a top-up must not be a side door for
            # flipping the tax country under a live mandate (review finding).
            _persist_confirmed_country(session, client, confirmed_country)

        pricing = credit_service.get_pricing(session)
        packs = pricing.get("topup_packs") or []
        pack = _match_topup_pack(packs, int(requested_amount))
        if not pack:
            raise HTTPException(status_code=400, detail="Invalid top-up pack.")

        # NOTE: referral discounts intentionally do NOT apply to top-ups.
        # The customer-facing discount fires only on plan checkout
        # (subscription_routes.create_checkout). This keeps the affiliate
        # incentive tied to recurring revenue rather than a one-off pack.
        # Affiliates earn from the customer's subscription, so the discount
        # also lives there. Referral *attribution* still happens via
        # /affiliate/apply-referral (unchanged); we just don't honour the
        # discount on the top-up checkout amount.

        # Validate per-bot top-up target, the bot must belong to this
        # client AND have its own paid subscription (per-bot ledger).
        # Topping up a legacy/Free bot via bot_id is silently coerced to
        # an account-pool top-up because those bots drain the pool anyway.
        target_bot_id: int | None = None
        if request.bot_id is not None:
            from app.db.models import Bot

            bot = session.get(Bot, int(request.bot_id))
            if bot is None or bot.client_id != client.id:
                raise HTTPException(status_code=404, detail="Bot not found.")
            target_bot_id = credit_service.resolve_bot_ledger_bot_id(bot)

        if provider == "razorpay":
            from app.services import razorpay_service

            # Gateway Customer first: it is what a saved card token attaches
            # to, and a top-up is the natural place to offer saving one.
            # Non-fatal -- losing it only costs the saved-instrument feature.
            # Re-read in-session; the dependency's `client` is DETACHED.
            customer_id = None
            try:
                customer_id = razorpay_customer_service.ensure_customer(session, session.get(Client, client.id))
            except razorpay_customer_service.RazorpayCustomerError:
                logger.warning("topup: could not ensure Razorpay customer for client %s", client.id)

            try:
                result = razorpay_service.create_topup_order(session, client, pack, bot_id=target_bot_id)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except razorpay_service.RazorpayBillingError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            session.commit()
            if isinstance(result, dict) and customer_id:
                # Checkout needs this to tokenise a card (customer_id + save=1).
                result["customer_id"] = customer_id
            return result

        # Unreachable while _resolve_provider only knows Razorpay, but a
        # future provider slipping past that guard used to fall off the end of
        # this function and return an implicit 200 with a null body, which the
        # frontend would open as a broken checkout. Fail loudly instead.
        raise HTTPException(status_code=503, detail=f"Top-ups are not supported on provider '{provider}'.")


class TopupVerifyRequest(BaseModel):
    """Razorpay Checkout success callback verification.

    The frontend sends the trio Razorpay returns in its handler callback;
    we verify the HMAC server-side to make sure the success was genuinely
    signed by Razorpay (defence against tampered modal responses).

    The credit grant itself happens via the Razorpay webhook. This
    endpoint just confirms the modal closure to the user.
    """

    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str


@credits_router.post("/topup/verify", dependencies=[Depends(money_route_limit("topup-verify", "30/minute"))])
def verify_topup_payment(
    body: TopupVerifyRequest,
    client: Client = Depends(get_current_client),
):
    """Verify a Razorpay Checkout success callback and reconcile the grant.

    The credit grant normally lands via the ``payment.captured`` / ``order.paid``
    webhook. This endpoint signature-verifies the modal callback and then runs
    an idempotent reconcile (L3) so a dropped webhook still credits the customer
    instead of leaving them paid-but-no-credits.
    """
    from app.services import razorpay_service

    try:
        razorpay_service.verify_topup_signature(
            razorpay_order_id=body.razorpay_order_id,
            razorpay_payment_id=body.razorpay_payment_id,
            razorpay_signature=body.razorpay_signature,
        )
    except razorpay_service.SignatureMismatch as exc:
        raise HTTPException(status_code=400, detail="Signature verification failed.") from exc

    # Idempotent safety net for a dropped capture webhook. The webhook remains
    # the canonical path; this reconcile is gated so the two can't double-grant.
    with get_session() as session:
        try:
            razorpay_service.reconcile_topup_from_razorpay(
                session,
                body.razorpay_order_id,
                body.razorpay_payment_id,
                expected_client_id=client.id,
            )
            session.commit()
            invoice_service.request_pdf_render_soon()
        except razorpay_service.RazorpayBillingError:
            # Reconcile failed (e.g. Razorpay fetch blip), the webhook may still
            # arrive. Don't fail verify; the UI polls /credits/balance.
            logger.warning(
                "Top-up reconcile failed for client %s, order %s. Falling back to webhook",
                client.id,
                body.razorpay_order_id,
            )
    return {"status": "verified"}


@credits_router.get("/packs")
def list_topup_packs():
    """Public list of currently-offered top-up packs (no auth).

    Each pack's ``inr`` is the BASE price. ``gross_inr`` is what the order will
    actually collect, so a tile rendered from this feed cannot advertise less
    than the Razorpay sheet beside it. No auth here, so the buyer's rail is
    unknown and the domestic (worst-case) rate is quoted; the authenticated
    top-up flow charges per the buyer's own supply kind.
    """
    with get_session() as session:
        pricing = credit_service.get_pricing(session)
        packs = pricing.get("topup_packs", [])
        rate_bps = charge_tax_rate_bps(session)
        out = []
        for pack in packs:
            base_inr = pack.get("inr") if pack.get("inr") is not None else pack.get("amount")
            enriched = dict(pack)
            enriched["tax_rate_bps"] = rate_bps
            if base_inr is not None:
                enriched["gross_inr"] = (
                    gross_charge_minor(int(round(float(base_inr))) * 100, rate_bps=rate_bps, kind="intra") / 100
                )
            out.append(enriched)
        return out
