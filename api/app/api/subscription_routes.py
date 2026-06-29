"""Client-facing subscription, credit, and billing endpoints.

Powers the admin dashboard's Credits page: balance, ledger history,
top-up checkout, plan changes, operator-seat add-ons, invoices, and
subscription cancellation. Stripe/Razorpay webhook handling lives in
``webhook_billing_routes`` and ``billing_service`` / ``razorpay_service``.

Provider selection — Razorpay is the default for new Indian customers; Stripe
is available for international flows. The active provider for a single
customer is pinned on ``Subscription.payment_provider`` (set when the
checkout flow is initiated). For new flows where no subscription yet
exists, ``BILLING_PROVIDER`` (env, default ``"razorpay"``) is used.
"""

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.auth import get_current_client_strict as get_current_client
from app.config import (
    BILLING_PROVIDER,
    DISPLAY_USD_TO_INR,
    INTL_PAYMENTS_ENABLED,
    RAZORPAY_ENABLED,
    STRIPE_ENABLED,
)
from app.core.dates import add_months
from app.core.geo import resolve_country
from app.core.pricing import display_price, format_amount
from app.db.models import Client, CreditLedger, Invoice, Plan, Subscription
from app.db.session import get_session
from app.services import credit_service
from app.services.plan_service import get_active_plans, get_client_plan, get_client_subscription

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/subscriptions", tags=["subscriptions"])
credits_router = APIRouter(prefix="/credits", tags=["credits"])


def effective_resets_at(sub: Subscription | None) -> datetime | None:
    """Return the next forward-looking reset date for this subscription.

    The renewal cron rolls ``current_period_end`` forward when it fires, but
    if the worker has been down (or hasn't caught up yet) the stored value
    can be in the past — which makes the UI's "Resets …" label show
    *yesterday*, which is obviously wrong.

    This helper computes the next reset *on read*: if the stored end is in
    the future we use it as-is; otherwise we advance by whole months (based
    on the original cycle length, default 1 month) until we land in the
    future. The DB row isn't mutated — the cron stays the source of truth
    for the actual renewal — we just make sure the user-facing label never
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
    # can't loop forever — at that point we just return the latest computed
    # date and let the UI render whatever's there.
    for _ in range(120):
        if candidate > now:
            return candidate
        candidate = add_months(candidate, cycle_months)
    return candidate


_KNOWN_PROVIDERS = frozenset({"razorpay", "stripe"})


def _resolve_provider(requested: str | None, *, current_sub_provider: str | None = None) -> str:
    """Pick a billing provider for this flow.

    Priority order:
      1. Explicit ``requested`` (from the route request body) if it's a known gateway.
      2. The active subscription's existing provider, but only when it's a known
         payment gateway — subscriptions seeded/upgraded manually may carry
         ``payment_provider = 'manual'`` which must not propagate to checkout.
      3. The configured default ``BILLING_PROVIDER``.

    Raises 503 if the chosen provider is not configured (env keys missing).
    """
    requested_norm = (requested or "").lower()
    sub_norm = (current_sub_provider or "").lower()

    # Walk the priority chain, skipping any value that isn't a gateway we know.
    candidate = next(
        (p for p in [requested_norm, sub_norm, BILLING_PROVIDER.lower()] if p in _KNOWN_PROVIDERS),
        None,
    )

    if candidate == "razorpay":
        if not RAZORPAY_ENABLED:
            raise HTTPException(
                status_code=503,
                detail="Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
            )
        return "razorpay"
    if candidate == "stripe":
        if not STRIPE_ENABLED:
            raise HTTPException(
                status_code=503,
                detail="Stripe is not configured. Set STRIPE_SECRET_KEY.",
            )
        return "stripe"
    raise HTTPException(status_code=400, detail=f"Unknown billing provider '{candidate}'")


# ── Public: Pricing page ──


@router.get("/plans")
def list_plans():
    """Return all active plans for the pricing page. No auth required."""
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
                "annual_discount_percent": p.annual_discount_percent,
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


# ── Authenticated: Current subscription ──


class StartTrialRequest(BaseModel):
    """Body for ``POST /subscriptions/start-trial``.

    The slug is the public plan identifier the pricing page renders against
    (``starter`` / ``standard``). The slug must point at an active plan with
    ``trial_days > 0`` — the free plan and enterprise tier are intentionally
    excluded.
    """

    plan_slug: str = Field(..., min_length=1, max_length=64)


@router.post("/start-trial")
def start_trial_endpoint(body: StartTrialRequest, client: Client = Depends(get_current_client)):
    """Begin a 14-day free trial of the named paid plan.

    Triggered when the customer clicks "Start free trial" on Starter or
    Standard. No card is required; on day 14 the expiry cron (PR4) flips
    the subscription to ``trial_expired`` and the customer must pick a
    plan + enter a card to keep their bot live.

    Trial credits = the plan's full ``credits_per_month`` so the prospect
    experiences the real product. The welcome email fires here, not on
    registration, since registration now lands the customer on the free
    tier without a trial.

    Error mapping (matches :class:`TrialUnavailable.reason`):

    * ``plan_not_found``           → 404
    * ``plan_not_trialable``       → 400
    * ``already_trialed``          → 409
    * ``active_paid_subscription`` → 409
    """
    from datetime import UTC, datetime

    from app.services.email_service import send_trial_welcome_email
    from app.services.plan_service import TrialUnavailable, start_trial

    with get_session() as session:
        try:
            sub = start_trial(session, client.id, body.plan_slug)
        except TrialUnavailable as exc:
            session.rollback()
            code_to_status = {
                "plan_not_found": 404,
                "plan_not_trialable": 400,
                "already_trialed": 409,
                "active_paid_subscription": 409,
            }
            raise HTTPException(
                status_code=code_to_status.get(exc.reason, 400),
                detail={"error": exc.reason, "message": exc.message},
            ) from exc

        # Snapshot every value we'll need post-commit. SQLAlchemy expires
        # ORM attributes on ``session.commit()``, so reading anything off
        # ``sub`` after the with-block closes would raise
        # ``DetachedInstanceError``. Pulling everything into locals here
        # keeps the response builder and the email send path safe.
        trial_end = sub.trial_end
        if trial_end is not None and trial_end.tzinfo is None:
            trial_end = trial_end.replace(tzinfo=UTC)
        plan = sub.plan
        credits_granted = int(plan.credits_per_month or 0) if plan else 0
        duration_days = int(plan.trial_days or 14) if plan else 14
        sub_status = sub.status
        session.commit()

    # Fire-and-forget welcome email AFTER the commit so a transport blip
    # cannot block (or roll back) the trial activation. The helper itself
    # is defensive; this outer catch is the belt-and-braces guard.
    try:
        send_trial_welcome_email(
            client.email,
            name=client.name,
            trial_end=trial_end or datetime.now(UTC),
            credits=credits_granted,
            duration_days=duration_days,
        )
    except Exception as mail_err:
        logger.warning(
            "trial_welcome_dispatch_failed for client %s: %s",
            client.id,
            mail_err,
        )

    days_remaining = max(0, (trial_end - datetime.now(UTC)).days) if trial_end else None
    return {
        "status": sub_status,
        "plan_slug": body.plan_slug,
        "trial_end_at": trial_end.isoformat() if trial_end else None,
        "days_remaining": days_remaining,
        "credits_granted": credits_granted,
    }


@router.get("/current")
def get_current_subscription(client: Client = Depends(get_current_client)):
    """Return the client's current subscription details + plan info."""
    with get_session() as session:
        sub = get_client_subscription(session, client.id)
        plan = get_client_plan(session, client.id)

        sub_data = None
        if sub:
            # Inline the queued change so the Billing page can render its
            # banner ("Switching to Starter on Aug 15 — Cancel") off a single
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
                "canceled_at": sub.canceled_at.isoformat() if sub.canceled_at else None,
                "cancel_at_period_end": sub.cancel_at_period_end,
                "payment_provider": sub.payment_provider,
                "created_at": sub.created_at.isoformat() if sub.created_at else None,
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

        return {
            "subscription": sub_data,
            "plan": {
                "id": plan.id,
                "name": plan.name,
                "slug": plan.slug,
                "description": plan.description,
                "pricing_model": plan.pricing_model,
                "currency": plan.currency,
                "monthly_price_cents": plan.monthly_price_cents,
                "annual_price_cents": plan.annual_price_cents,
                "credits_per_month": plan.credits_per_month,
                "included_operator_seats": plan.included_operator_seats,
                "extra_seat_price_cents": plan.extra_seat_price_cents,
                "limits": plan.limits,
                "features": plan.features,
                "overage_rate_cents": plan.overage_rate_cents,
            },
            "billing": {
                "default_provider": BILLING_PROVIDER,
                "razorpay_enabled": RAZORPAY_ENABLED,
                "stripe_enabled": STRIPE_ENABLED,
            },
        }


@router.get("/geo")
def get_billing_geo(request: Request, _client: Client = Depends(get_current_client)):
    """Return the geo / currency profile the UI should render against.

    Single call so the Billing page and PlanModal don't have to fan out a
    per-plan quote — the frontend converts INR paise to its local USD with
    the returned ``display_rate`` (a paid plan's INR price is the source of
    truth; USD is informational until international payments is live).

    Includes the Razorpay public key so the React layer doesn't have to
    re-stuff it from a separate env / endpoint when opening the modal.
    """
    from app.config import RAZORPAY_KEY_ID

    country = resolve_country(request)
    indian = country == "IN"
    # Allow checkout ONLY when the edge has confirmed the visitor is Indian
    # (``CF-IPCountry: IN`` / ``x-vercel-ip-country: IN``). Unknown geo
    # (localhost without override, requests bypassing the edge) and any
    # non-Indian country code both route to Contact Sales until
    # ``INTL_PAYMENTS_ENABLED`` is flipped. Devs needing a live Razorpay
    # checkout on localhost can use the ``?country=IN`` query override
    # that ``resolve_country`` honours.
    return {
        "country": country,
        "display_currency": "INR" if indian else "USD",
        "display_rate": DISPLAY_USD_TO_INR,
        "intl_payments_enabled": INTL_PAYMENTS_ENABLED,
        "razorpay_enabled": RAZORPAY_ENABLED,
        "razorpay_key_id": RAZORPAY_KEY_ID if RAZORPAY_ENABLED else None,
        # ``checkout_available`` is the headline boolean the UI flips its
        # CTA on: True → render the live "Subscribe" button, False → render
        # the "Contact sales" fallback. Keeping it server-side ensures both
        # the modal and the marketing site agree on which path is live.
        "checkout_available": RAZORPAY_ENABLED and (indian or INTL_PAYMENTS_ENABLED),
        "contact_sales_email": "developer@oyechats.com",
    }


class VerifyRazorpaySubscriptionRequest(BaseModel):
    razorpay_payment_id: str
    razorpay_subscription_id: str
    razorpay_signature: str


@router.post("/verify-razorpay-subscription")
def verify_razorpay_subscription(
    payload: VerifyRazorpaySubscriptionRequest,
    client: Client = Depends(get_current_client),
):
    """Verify the Razorpay Checkout return signature for a subscription.

    Razorpay's ``subscription.activated`` webhook is the canonical reconciler
    — this endpoint only exists so the UI can flip to a "Subscription
    active" state the moment the modal closes, without waiting for the
    out-of-band webhook round-trip.

    Failure modes (caller-facing):
      * 400 — signature mismatch (replay / tampering).
      * 502 — Razorpay SDK error (network / quota).
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
    # network blip) — without a reconcile here a paying customer would see
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
                sub = razorpay_service.reconcile_subscription_from_razorpay(session, payload.razorpay_subscription_id)
                session.commit()
            except razorpay_service.RazorpayBillingError:
                # Reconcile failed — the webhook may still arrive. Don't fail
                # verify; the UI will poll /subscriptions/current and pick up
                # the row whenever it lands.
                logger.warning(
                    "Razorpay reconcile failed for client %s, subscription %s — falling back to webhook",
                    client.id,
                    payload.razorpay_subscription_id,
                )
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
        return {
            "status": "verified",
            "subscription_known": sub is not None,
            "razorpay_subscription_id": payload.razorpay_subscription_id,
        }


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


@router.get("/invoices")
def list_invoices(client: Client = Depends(get_current_client)):
    """Return the client's payment history (most recent first)."""
    with get_session() as session:
        stmt = select(Invoice).where(Invoice.client_id == client.id).order_by(Invoice.created_at.desc()).limit(50)
        invoices = session.execute(stmt).scalars().all()

        return [
            {
                "id": inv.id,
                "amount_cents": inv.amount_cents,
                "currency": inv.currency,
                "status": inv.status,
                "description": inv.description,
                "invoice_url": inv.invoice_url,
                "pdf_url": inv.pdf_url,
                "period_start": inv.period_start.isoformat() if inv.period_start else None,
                "period_end": inv.period_end.isoformat() if inv.period_end else None,
                "paid_at": inv.paid_at.isoformat() if inv.paid_at else None,
                "created_at": inv.created_at.isoformat() if inv.created_at else None,
            }
            for inv in invoices
        ]


# ── Checkout & Billing Portal ──


class CheckoutRequest(BaseModel):
    plan_id: int
    billing_cycle: str = "monthly"  # monthly|annual
    provider: str | None = None  # "razorpay" | "stripe" — defaults to BILLING_PROVIDER
    coupon_code: str | None = None  # future Stripe coupons; blocked when referral code is active


# ── Checkout quote (currency + payment-method preview) ────────────────────────


# Razorpay's INR Checkout supports far more methods than we expose to the user;
# we whitelist the two we promise on the pricing page so the modal never shows
# rails we haven't tested against (netbanking quirks, wallet KYC limits, etc).
# Cards: Visa / Mastercard / Amex / Rupay. UPI: GPay / PhonePe / Paytm / BHIM.
_RAZORPAY_METHODS_INR = ("card", "upi")


def _amount_for_cycle(plan, billing_cycle: str) -> int:
    """Minor-unit price (paise for INR, cents for USD) for the requested cycle."""
    if billing_cycle == "annual":
        return int(plan.annual_price_cents or 0)
    return int(plan.monthly_price_cents or 0)


@router.get("/checkout/quote")
def checkout_quote(
    request: Request,
    plan_id: int,
    billing_cycle: str = "monthly",
    client: Client = Depends(get_current_client),
):
    """Single source of truth for what the checkout button will charge.

    The admin UI calls this before opening any payment modal so it can
    render the right currency, amount, payment methods, and CTA — without
    the frontend having to know provider routing rules.

    Response shape (always 200 unless inputs are invalid):

    ``{
        "country": "IN" | "US" | null,
        "currency": "INR" | "USD",
        "amount_minor": 149900,
        "amount_display": "₹1,499",
        "billing_cycle": "monthly",
        "provider": "razorpay",
        "methods": ["card", "upi"],
        "checkout_supported": true,            # false → render Contact Sales
        "contact_sales": null | "developer@oyechats.com",
    }``

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

        country = resolve_country(request)
        indian = country == "IN"
        inr_paise = _amount_for_cycle(plan, billing_cycle)
        usd_minor = plan.annual_price_usd_cents if billing_cycle == "annual" else plan.monthly_price_usd_cents
        amount_minor, currency = display_price(
            inr_paise=inr_paise, usd_cents=usd_minor, country=country, rate=DISPLAY_USD_TO_INR
        )
        amount_display = format_amount(amount_minor, currency)

        # Free plan: render a quote but mark checkout as unsupported.
        if amount_minor == 0 and plan.slug != "enterprise":
            return {
                "country": country,
                "currency": currency,
                "amount_minor": 0,
                "amount_display": amount_display,
                "billing_cycle": billing_cycle,
                "provider": None,
                "methods": [],
                "checkout_supported": False,
                "contact_sales": None,
                "reason": "free_plan",
            }

        # Enterprise is always contact-sales regardless of geography.
        if plan.slug == "enterprise":
            return {
                "country": country,
                "currency": currency,
                "amount_minor": amount_minor,
                "amount_display": amount_display,
                "billing_cycle": billing_cycle,
                "provider": None,
                "methods": [],
                "checkout_supported": False,
                "contact_sales": "developer@oyechats.com",
                "reason": "enterprise",
            }

        # Allow only confirmed Indian visitors through to Razorpay. Unknown
        # geo and any non-Indian country code both fall back to Contact
        # Sales until international payments is enabled. Same Indian-only
        # gate as ``/subscriptions/geo``.
        if not indian and not INTL_PAYMENTS_ENABLED:
            return {
                "country": country,
                "currency": currency,
                "amount_minor": amount_minor,
                "amount_display": amount_display,
                "billing_cycle": billing_cycle,
                "provider": None,
                "methods": [],
                "checkout_supported": False,
                "contact_sales": "developer@oyechats.com",
                "reason": "intl_payments_disabled",
            }

        return {
            "country": country,
            "currency": "INR" if indian else "USD",
            "amount_minor": amount_minor,
            "amount_display": amount_display,
            "billing_cycle": billing_cycle,
            "provider": "razorpay",
            "methods": list(_RAZORPAY_METHODS_INR),
            "checkout_supported": True,
            "contact_sales": None,
        }


@router.post("/checkout")
def create_checkout(
    request: CheckoutRequest,
    http_request: Request,
    client: Client = Depends(get_current_client),
):
    """Create a checkout session for a paid plan.

    Routes to Razorpay for Indian customers (and for international customers
    once ``INTL_PAYMENTS_ENABLED`` is True). Until then, confirmed non-Indian
    requests are rejected with HTTP 402 carrying a ``contact_sales`` body so
    the UI can surface the sales CTA.

    Returns provider-specific payload:
      * Razorpay → ``{provider, subscription_id, key_id, name, description, prefill, theme}``
        — frontend opens ``new Razorpay({subscription_id, ...}).open()``.
      * Stripe   → ``{checkout_url, session_id}`` — frontend redirect.
        Reachable only when an existing subscription is already pinned to
        Stripe; new sign-ups never get this path.
    """
    if request.billing_cycle not in ("monthly", "annual"):
        raise HTTPException(status_code=400, detail="billing_cycle must be 'monthly' or 'annual'.")

    _assert_no_stacking(client, request.coupon_code)

    with get_session() as session:
        from app.services.plan_service import get_plan_by_id

        plan = get_plan_by_id(session, request.plan_id)
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found.")
        if not plan.is_active:
            raise HTTPException(status_code=400, detail="This plan is not available.")
        if plan.monthly_price_cents == 0 and plan.slug != "enterprise":
            raise HTTPException(status_code=400, detail="Cannot checkout for a free plan.")

        existing_sub = get_client_subscription(session, client.id)

        # Razorpay-only for new sign-ups. Existing Stripe subscribers keep
        # their Stripe rail (so renewal / cancel still works) — this is the
        # grandfather window, not a user-selectable option. Even if a request
        # tries to force ``provider="stripe"``, we honour it only when the
        # customer already has a Stripe-pinned sub; otherwise we silently
        # route to Razorpay so no fresh Stripe customers can be created.
        existing_provider = (existing_sub.payment_provider or "").lower() if existing_sub else ""
        if existing_provider == "stripe" and existing_sub and existing_sub.stripe_subscription_id:
            provider = "stripe"  # grandfathered — preserve their rail
        else:
            provider = "razorpay"

        # Indian-only gating — let confirmed Indian visitors through to
        # Razorpay; everyone else (unknown geo + non-Indian) gets a 402
        # with ``contact_sales`` so the UI can surface the sales CTA.
        # Flipping ``INTL_PAYMENTS_ENABLED=true`` opens the gateway for
        # everyone once Razorpay International is activated.
        ctry = resolve_country(http_request)
        if ctry != "IN" and not INTL_PAYMENTS_ENABLED and provider == "razorpay":
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "intl_payments_unavailable",
                    "message": (
                        "International checkout isn't live yet — please contact "
                        "developer@oyechats.com to start a subscription."
                    ),
                    "contact_sales": "developer@oyechats.com",
                },
            )

        if provider == "razorpay":
            from app.db.models import ReferralConversion
            from app.services import discount_service, razorpay_service

            discount_bps, disc_meta = discount_service.resolve_customer_discount_bps(session, client)
            try:
                result = razorpay_service.create_subscription(
                    session, client, plan, request.billing_cycle, discount_bps=discount_bps
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except razorpay_service.RazorpayBillingError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            if disc_meta:
                session.add(
                    ReferralConversion(
                        client_id=client.id,
                        referral_code_id=int(disc_meta["referral_code_id"]),
                        affiliate_id=None,
                        commission_bps=int(disc_meta["affiliate_commission_bps"]),
                        customer_discount_bps=int(disc_meta["discount_bps"]),
                    )
                )
            session.commit()
            return result

        # Stripe path — only reachable for legacy subscribers pinned to Stripe.
        from app.services.billing_service import create_checkout_session

        # Honour the customer-facing referral discount on subscription
        # checkout. Top-ups skip this on purpose — the discount is recurring
        # so it fires every billing cycle, aligning the affiliate's reward
        # with the customer's lifetime value.
        discount_bps, discount_meta = _resolve_referral_discount(session, client)

        result = create_checkout_session(
            session,
            client,
            plan,
            request.billing_cycle,
            discount_bps=discount_bps,
            extra_metadata=discount_meta or None,
        )
        result.setdefault("provider", "stripe")
        session.commit()
        return result


@router.post("/portal")
def billing_portal(client: Client = Depends(get_current_client)):
    """Return a Stripe Billing Portal URL for self-service billing management."""
    from app.config import STRIPE_ENABLED

    if not STRIPE_ENABLED:
        raise HTTPException(status_code=503, detail="Billing is not configured yet.")

    with get_session() as session:
        from app.services.billing_service import create_billing_portal_session

        url = create_billing_portal_session(session, client)
        return {"portal_url": url}


class ChangePlanRequest(BaseModel):
    plan_id: int
    billing_cycle: str | None = None  # None = keep current cycle


@router.post("/change-plan")
def change_plan(
    request: ChangePlanRequest,
    http_request: Request,
    client: Client = Depends(get_current_client),
):
    """Upgrade or downgrade the client's subscription to a different plan.

    Three branches:

    * **Paid → Paid via Stripe** (``sub.stripe_subscription_id`` present, target
      plan has a price) — modify the Stripe subscription in place. Stripe
      prorates the difference automatically; we then sync the local row and
      return a "switched" status with no redirect. This is the only path that
      stays silent — the customer's card on file is charged on the next
      invoice and they never leave the admin app.

    * **No-Stripe-link → Paid** (manual / seeded sub OR no sub at all, target
      plan is paid) — there is no Stripe subscription to modify and no
      payment method on file we can charge silently. We have to create a
      proper Stripe Checkout session and return its URL so the customer can
      complete payment. On success the webhook handler will set up the
      stripe-linked subscription row.

    * **Anything → Free** (target plan is free) — no payment required. We
      cancel the existing Stripe sub at period end (if any) and mark the
      local row so the customer keeps their paid features through the end
      of the billing period.

    Response shape — the frontend branches on which key is present:

    * ``{"status": "checkout_required", "checkout_url": "...", "session_id": "..."}`` — redirect
    * ``{"status": "switched", "message": "..."}``                                  — silent prorated swap
    * ``{"status": "downgraded", "message": "..."}``                                — Free downgrade scheduled
    """
    with get_session() as session:
        from app.services.plan_service import get_client_subscription, get_plan_by_id

        new_plan = get_plan_by_id(session, request.plan_id)
        if not new_plan or not new_plan.is_active:
            raise HTTPException(status_code=404, detail="Target plan not found or inactive.")

        sub = get_client_subscription(session, client.id)

        # Universal precheck — same plan is a no-op regardless of branch.
        # Doing this up here means a customer on a manual Standard sub
        # who picks Standard again gets a friendly 400 instead of
        # falling through to checkout and getting a confusing
        # "configure Stripe price" error.
        if sub is not None and sub.plan_id == request.plan_id:
            raise HTTPException(status_code=400, detail="You are already on this plan.")

        # ── Branch 1: target is Free ──
        # No payment needed. If the customer has an upstream provider sub
        # (Stripe OR Razorpay), schedule cancellation at period-end so they
        # keep paid features for the rest of the cycle they already paid for,
        # AND cancel the upstream mandate so the provider stops charging the
        # card / UPI. If they have a manual sub (no upstream id), the swap is
        # immediate and we have to reset+regrant credits so the Plan card
        # doesn't show the old tier's grant under the new (smaller) denominator.
        if new_plan.monthly_price_cents == 0 and new_plan.slug == "free":
            if sub is None:
                raise HTTPException(
                    status_code=400,
                    detail="You're already on Free — nothing to downgrade.",
                )
            if sub.stripe_subscription_id:
                from app.services.billing_service import cancel_stripe_subscription

                cancel_stripe_subscription(sub, at_period_end=True)
                sub.cancel_at_period_end = True
                msg = f"Scheduled downgrade to {new_plan.name} at the end of the current period."
            elif sub.razorpay_subscription_id:
                # Without this branch the local row would flip to Free while
                # Razorpay's UPI mandate kept debiting the customer at the
                # next cycle — real "still charging after cancellation"
                # support tickets and chargeback risk.
                #
                # Skip the provider call if our DB already shows the mandate
                # as cancelled/expired — it means the webhook already fired
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
                sub.cancel_at_period_end = True
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
            logger.info(
                "Client %s downgraded to Free (had_stripe=%s, had_razorpay=%s)",
                client.id,
                bool(sub.stripe_subscription_id),
                bool(sub.razorpay_subscription_id),
            )
            return {"status": "downgraded", "message": msg}

        # ── Branch 2a: paid → paid via Razorpay → upgrade-now, credit rollover ──
        # Razorpay can't modify a subscription's plan in place — we must
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
            and new_plan.monthly_price_cents > (sub.plan.monthly_price_cents or 0)
        ):
            from app.services import razorpay_service, transition_service

            billing_cycle = request.billing_cycle or sub.billing_cycle or "monthly"
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
            and new_plan.monthly_price_cents < (sub.plan.monthly_price_cents or 0)
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

        # ── Branch 2: real Stripe subscription → silent prorated swap ──
        if sub is not None and sub.stripe_subscription_id:
            billing_cycle = request.billing_cycle or sub.billing_cycle
            from app.services.billing_service import change_stripe_plan

            try:
                change_stripe_plan(sub, new_plan, billing_cycle)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

            sub.plan_id = new_plan.id
            sub.billing_cycle = billing_cycle
            session.flush()

            # Reset whatever's left of the old plan's monthly grant and
            # immediately grant the new plan's allowance. Without this the
            # customer keeps their previous tier's leftover balance under
            # the new tier's denominator — the "268 / 2000" bug. Stripe
            # also emits ``invoice.paid`` on the proration, but webhooks
            # may not reach this server (local dev) so we do not rely
            # on them to make the customer's balance correct.
            credit_service.reset_monthly_plan_credits(session, client.id, bot_id=sub.bot_id)
            credit_service.grant_for_subscription(session, sub)
            session.commit()

            logger.info(
                "Client %s switched Stripe sub %s to %s (%s); credits reset + re-granted",
                client.id,
                sub.stripe_subscription_id,
                new_plan.slug,
                billing_cycle,
            )
            return {
                "status": "switched",
                "message": f"Plan changed to {new_plan.name}. Stripe will prorate the difference on your next invoice.",
            }

        # ── Branch 3: paid target with no Stripe link → first-time checkout ──
        # Covers "no subscription at all" and "manual/seeded sub without a
        # stripe_subscription_id" (the free-tier and post-trial cases that
        # land here from the plan modal's Upgrade/Switch path). The
        # customer must authorise a payment method before we flip them
        # onto the paid plan. Provider routing mirrors ``/checkout``:
        # honour an existing real provider, otherwise default to
        # Razorpay (the configured primary).
        billing_cycle = request.billing_cycle or (sub.billing_cycle if sub else "monthly")
        existing_provider = (sub.payment_provider if sub else None) or ""
        if existing_provider.lower() in ("razorpay", "stripe"):
            provider = _resolve_provider(None, current_sub_provider=existing_provider)
        else:
            provider = "razorpay" if RAZORPAY_ENABLED else _resolve_provider(None)

        # Indian-only gating for Razorpay (same rule the /checkout path
        # enforces). Flip ``INTL_PAYMENTS_ENABLED=true`` to open the
        # gateway to non-IN customers once Razorpay International is
        # active. Returns 402 with a ``contact_sales`` hint the frontend
        # already knows how to surface as a sales-mail CTA.
        if provider == "razorpay":
            country = resolve_country(http_request)
            if country != "IN" and not INTL_PAYMENTS_ENABLED:
                raise HTTPException(
                    status_code=402,
                    detail={
                        "code": "intl_payments_unavailable",
                        "message": (
                            "International checkout isn't live yet — please contact "
                            "developer@oyechats.com to start a subscription."
                        ),
                        "contact_sales": "developer@oyechats.com",
                    },
                )

            from app.services import razorpay_service

            try:
                result = razorpay_service.create_subscription(session, client, new_plan, billing_cycle)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except razorpay_service.RazorpayBillingError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc

            session.commit()
            logger.info(
                "Client %s requires Razorpay subscription auth for plan %s (%s)",
                client.id,
                new_plan.slug,
                billing_cycle,
            )
            # Razorpay path returns the full sheet-init payload so the
            # frontend's ``openRazorpayCheckout`` can take over directly.
            result.setdefault("provider", "razorpay")
            result.setdefault("status", "checkout_required")
            return result

        # Stripe path — only when the customer is already pinned to Stripe.
        from app.services.billing_service import create_checkout_session

        discount_bps, discount_meta = _resolve_referral_discount(session, client)

        try:
            result = create_checkout_session(
                session,
                client,
                new_plan,
                billing_cycle,
                discount_bps=discount_bps,
                extra_metadata=discount_meta or None,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        session.commit()
        logger.info(
            "Client %s requires Stripe checkout for plan %s (%s) — session %s",
            client.id,
            new_plan.slug,
            billing_cycle,
            result.get("session_id"),
        )
        return {
            "status": "checkout_required",
            "checkout_url": result["checkout_url"],
            "session_id": result["session_id"],
            "provider": "stripe",
        }


# ── Cancellation ──


@router.post("/cancel-scheduled-change")
def cancel_scheduled_change_endpoint(client: Client = Depends(get_current_client)):
    """Clear a queued downgrade so the customer stays on their current plan.

    Idempotent: returns ``{"status": "no_change_pending"}`` when nothing is
    queued. When a change WAS queued, this resets ``scheduled_*`` to NULL and
    leaves ``cancel_at_period_end`` alone — the gateway mandate was cancelled
    at-cycle-end when the downgrade was scheduled, so the customer must
    re-authorise to keep the current plan past cycle end. We surface that as
    ``mandate_action`` in the response so the frontend can prompt accordingly.
    """
    from app.services import transition_service

    with get_session() as session:
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
        # current plan" CTA. We don't auto-resume — the customer should make
        # an explicit choice rather than being silently re-billed.
        return {
            "status": "scheduled_change_cancelled",
            "mandate_action": "reauthorise_required",
            "message": "Scheduled downgrade cancelled. Re-authorise payment to stay on your current plan past cycle end.",
        }


class CancelSubscriptionRequest(BaseModel):
    reason: str | None = None


@router.post("/cancel")
def cancel_subscription(request: CancelSubscriptionRequest, client: Client = Depends(get_current_client)):
    """Cancel the client's subscription at the end of the current billing period.

    Calls the upstream provider's cancel-at-cycle-end API; the local row is
    only marked ``cancel_at_period_end=True`` until the provider's webhook
    fires the actual cancellation.
    """
    with get_session() as session:
        sub = get_client_subscription(session, client.id)
        if not sub:
            raise HTTPException(status_code=404, detail="No active subscription found.")

        if sub.status == "canceled":
            raise HTTPException(status_code=400, detail="Subscription is already canceled.")

        provider = (sub.payment_provider or "razorpay").lower()
        try:
            if provider == "razorpay" and sub.razorpay_subscription_id:
                from app.services import razorpay_service

                razorpay_service.cancel_subscription(sub, at_period_end=True)
            elif provider == "stripe" and sub.stripe_subscription_id:
                from app.services.billing_service import cancel_stripe_subscription

                cancel_stripe_subscription(sub, at_period_end=True)
        except Exception as exc:
            logger.exception("Provider cancel failed for sub %s: %s", sub.id, exc)
            raise HTTPException(status_code=502, detail="Could not cancel with payment provider.") from exc

        from datetime import UTC, datetime

        sub.cancel_at_period_end = True
        sub.canceled_at = datetime.now(UTC)
        sub.cancel_reason = request.reason
        session.commit()

        logger.info("Client %s canceled subscription %s (reason: %s)", client.id, sub.id, request.reason)

        return {"message": "Subscription will be canceled at the end of the current billing period."}


def _reconcile_stripe_subscription(
    session,
    client: Client,
    *,
    stripe_module,
    stripe_session,
    sync_key: str,
) -> dict:
    """Idempotently fold a paid Stripe Checkout Session into the local sub row.

    Shared core for both ``/verify-stripe`` (success-URL self-redemption) and
    ``/reconcile`` (manual sync button). The caller has already validated:
    that the session belongs to this client, that ``mode='subscription'``,
    and that payment captured.

    Behaviour:

    1. **Already done by webhook?** — if a local Subscription row already
       has this ``stripe_subscription_id`` on this client and is active +
       on the right plan, return ``{verified: True, reason: 'Already
       provisioned (webhook)'}`` without writing anything. This stops
       duplicate ledger entries when the webhook and self-verify both
       fire in production.
    2. **Idempotency** — record a synthetic event id (``sync_key``) so
       repeat calls within the same session are no-ops.
    3. **Pull subscription period dates** from Stripe so the "Resets MMM
       DD" label on the Overview tab is accurate.
    4. **Update local sub row in place** (or create one), pin to Stripe.
    5. **Reset prior plan grants + grant the new plan's allowance.**

    Returns the JSON the route should serialize.
    """
    from app.services.billing_service import _record_or_skip_webhook
    from app.services.plan_service import get_client_subscription, get_plan_by_id

    metadata = (
        dict(stripe_session["metadata"]._data) if "metadata" in stripe_session and stripe_session["metadata"] else {}
    )
    plan_id_str = metadata.get("oyechats_plan_id")
    billing_cycle = metadata.get("billing_cycle", "monthly")
    # noqa: SIM401 — Stripe's StripeObject has no .get(); use [] + in.
    stripe_sub_id = (
        stripe_session["subscription"] if "subscription" in stripe_session else None  # noqa: SIM401
    )
    stripe_customer_id = (
        stripe_session["customer"] if "customer" in stripe_session else None  # noqa: SIM401
    )
    if not plan_id_str or not stripe_sub_id:
        return {"verified": False, "reason": "Session missing plan or subscription id"}

    new_plan = get_plan_by_id(session, int(plan_id_str))
    if new_plan is None:
        raise HTTPException(status_code=404, detail="Plan from session not found.")

    # Webhook already handled it? Bail early — no need to re-reset +
    # re-grant credits and write noise to the ledger.
    already_provisioned = (
        session.execute(
            select(Subscription).where(
                Subscription.client_id == client.id,
                Subscription.stripe_subscription_id == stripe_sub_id,
                Subscription.plan_id == new_plan.id,
                Subscription.status.in_(("active", "trialing")),
            )
        )
        .scalars()
        .first()
    )
    if already_provisioned is not None:
        return {
            "verified": True,
            "plan_slug": new_plan.slug,
            "reason": "Already provisioned (webhook handled it).",
        }

    # Synthetic-event-id idempotency — protects against the same client
    # spamming the endpoint with the same session_id. Cleared in DB so
    # later sessions for the same client are unaffected.
    if not _record_or_skip_webhook(session, sync_key, "stripe"):
        session.commit()
        return {
            "verified": True,
            "plan_slug": new_plan.slug,
            "reason": "Already reconciled (no changes).",
        }

    # Pull the live subscription so we can record period dates accurately.
    # If retrieve fails the customer is still on a paid sub on Stripe's
    # side — fall back to the dates that come down on the Checkout session
    # rather than refusing to provision.
    period_start = None
    period_end = None
    sub_status: str | None = None
    trial_start = None
    trial_end = None
    try:
        live_sub = stripe_module.Subscription.retrieve(stripe_sub_id)
        if "current_period_start" in live_sub and live_sub["current_period_start"]:
            period_start = datetime.fromtimestamp(live_sub["current_period_start"], tz=UTC)
        if "current_period_end" in live_sub and live_sub["current_period_end"]:
            period_end = datetime.fromtimestamp(live_sub["current_period_end"], tz=UTC)
        if "status" in live_sub and live_sub["status"]:
            sub_status = str(live_sub["status"])
        if "trial_start" in live_sub and live_sub["trial_start"]:
            trial_start = datetime.fromtimestamp(live_sub["trial_start"], tz=UTC)
        if "trial_end" in live_sub and live_sub["trial_end"]:
            trial_end = datetime.fromtimestamp(live_sub["trial_end"], tz=UTC)
    except Exception as exc:
        logger.warning("Stripe Subscription retrieve failed for %s: %s", stripe_sub_id, exc)

    sub = get_client_subscription(session, client.id)
    if sub is None:
        sub = Subscription(
            client_id=client.id,
            plan_id=new_plan.id,
            status=sub_status or "active",
            billing_cycle=billing_cycle,
        )
        session.add(sub)
        session.flush()

    sub.plan_id = new_plan.id
    sub.billing_cycle = billing_cycle
    sub.payment_provider = "stripe"
    sub.stripe_subscription_id = stripe_sub_id
    if stripe_customer_id:
        sub.stripe_customer_id = stripe_customer_id
    if sub_status:
        sub.status = sub_status
    elif sub.status not in ("active", "trialing"):
        sub.status = "active"
    if period_start:
        sub.current_period_start = period_start
    if period_end:
        sub.current_period_end = period_end
    if trial_start:
        sub.trial_start = trial_start
    if trial_end:
        sub.trial_end = trial_end
    sub.cancel_at_period_end = False
    sub.canceled_at = None
    session.flush()

    credit_service.reset_monthly_plan_credits(session, client.id, bot_id=sub.bot_id)
    credit_service.grant_for_subscription(session, sub)
    session.commit()

    logger.info(
        "Client %s reconciled Stripe subscription %s (plan=%s); credits reset + re-granted",
        client.id,
        stripe_sub_id,
        new_plan.slug,
    )
    return {
        "verified": True,
        "plan_slug": new_plan.slug,
        "billing_cycle": billing_cycle,
    }


class SubscriptionStripeVerifyRequest(BaseModel):
    """Stripe Checkout success self-redemption for subscription mode."""

    session_id: str


@router.post("/verify-stripe")
def verify_stripe_subscription(
    body: SubscriptionStripeVerifyRequest,
    client: Client = Depends(get_current_client),
):
    """Fallback subscription-sync path for when the Stripe webhook can't reach us.

    Stripe Checkout in ``subscription`` mode normally lands its state via
    ``checkout.session.completed`` + ``invoice.paid``. Local dev (and
    occasionally production) doesn't always see those events, which is how
    we end up with the "$19 Starter ACTIVE — but only 268 plan credits"
    bug: the customer paid, Stripe knows it, but our DB still has the
    Free-tier grant + an unlinked sub row.

    This endpoint takes the ``session_id`` from the Stripe success redirect,
    pulls the session from Stripe (the source of truth), confirms it's
    paid + matches the caller, and idempotently:

      * links the local subscription row to the Stripe sub id;
      * pins ``payment_provider='stripe'`` so future change-plan calls
        take the silent-swap branch instead of falling through to
        another checkout;
      * resets any leftover plan credits from the prior tier and grants
        the new plan's monthly allowance.

    Idempotency uses ``_record_or_skip_webhook`` keyed on a synthetic
    event id derived from the checkout session id, so concurrent
    webhook + self-verify never double-grant credits.
    """
    from app.config import STRIPE_ENABLED

    if not STRIPE_ENABLED:
        raise HTTPException(status_code=503, detail="Stripe is not configured.")

    import stripe

    from app.config import STRIPE_SECRET_KEY

    stripe.api_key = STRIPE_SECRET_KEY

    try:
        sess = stripe.checkout.Session.retrieve(body.session_id)
    except Exception as exc:
        logger.warning("Stripe session retrieve failed for %s: %s", body.session_id, exc)
        raise HTTPException(status_code=404, detail="Checkout session not found.") from exc

    payment_status = sess["payment_status"]
    if payment_status not in ("paid", "no_payment_required"):
        return {"verified": False, "reason": f"Payment not captured (status={payment_status})"}

    if sess["mode"] != "subscription":
        return {"verified": False, "reason": "Session is not a subscription checkout"}

    metadata = dict(sess["metadata"]._data) if "metadata" in sess and sess["metadata"] else {}
    sess_client_id = metadata.get("oyechats_client_id")
    if str(sess_client_id) != str(client.id):
        # 404 (not 403) so attackers can't probe other customers' sessions.
        raise HTTPException(status_code=404, detail="Checkout session not found.")

    with get_session() as session:
        return _reconcile_stripe_subscription(
            session,
            client,
            stripe_module=stripe,
            stripe_session=sess,
            sync_key=f"cs_self_verify_{body.session_id}",
        )


@router.post("/reconcile")
def reconcile_subscription(client: Client = Depends(get_current_client)):
    """Walk the customer's recent Stripe sessions and self-verify the latest paid one.

    Manual escape hatch for the "I upgraded but the dashboard still shows the
    old plan" case. The /verify-stripe path requires a session_id from the
    success redirect; this one does not — it asks Stripe directly for the
    customer's most recent paid subscription checkout and reconciles it
    against the local row. Idempotent.

    Returns ``{ reconciled: bool, plan_slug?, reason? }``.
    """
    from app.config import STRIPE_ENABLED

    if not STRIPE_ENABLED:
        raise HTTPException(status_code=503, detail="Stripe is not configured.")

    import stripe

    from app.config import STRIPE_SECRET_KEY
    from app.services.billing_service import get_or_create_stripe_customer

    stripe.api_key = STRIPE_SECRET_KEY

    with get_session() as session:
        customer_id = get_or_create_stripe_customer(session, client)
        session.commit()

    sessions = stripe.checkout.Session.list(customer=customer_id, limit=20).data
    paid_subscription_sessions = [
        s
        for s in sessions
        if s["mode"] == "subscription"
        and s["payment_status"] in ("paid", "no_payment_required")
        and ("subscription" in s and s["subscription"])
    ]
    if not paid_subscription_sessions:
        return {"reconciled": False, "reason": "No paid subscription checkout found for this account."}

    latest = paid_subscription_sessions[0]
    with get_session() as session:
        result = _reconcile_stripe_subscription(
            session,
            client,
            stripe_module=stripe,
            stripe_session=latest,
            sync_key=f"cs_self_verify_{latest['id']}",
        )
        # Normalise the reconcile route's response shape (keep the existing
        # ``reconciled`` boolean for frontend compatibility).
        return {
            "reconciled": bool(result.get("verified")),
            "plan_slug": result.get("plan_slug"),
            "reason": result.get("reason"),
        }


@router.post("/resume")
def resume_subscription(client: Client = Depends(get_current_client)):
    """Resume a subscription that was scheduled for cancellation."""
    with get_session() as session:
        sub = get_client_subscription(session, client.id)
        if not sub:
            raise HTTPException(status_code=404, detail="No active subscription found.")

        if not sub.cancel_at_period_end:
            raise HTTPException(status_code=400, detail="Subscription is not scheduled for cancellation.")

        sub.cancel_at_period_end = False
        sub.canceled_at = None
        sub.cancel_reason = None
        session.commit()

        logger.info(f"Client {client.id} resumed subscription {sub.id}")

        return {"message": "Subscription resumed successfully."}


# ── Operator-seat add-on ──


class SeatChangeRequest(BaseModel):
    delta: int  # +1 to add a seat, -1 to remove. Must keep total >= included floor.


@router.post("/seats")
def change_seat_count(request: SeatChangeRequest, client: Client = Depends(get_current_client)):
    """Add or remove operator seats from the active subscription.

    Each seat above ``plan.included_operator_seats`` costs
    ``extra_seat_price_cents`` per month (default ₹1,199). Both Razorpay
    (``subscription.edit`` with new quantity, ``schedule_change_at='now'``)
    and Stripe (subscription item quantity update) handle the upstream
    proration. The local mirror is updated immediately so live-chat seat
    enforcement sees the new limit without webhook latency.
    """
    if request.delta == 0:
        raise HTTPException(status_code=400, detail="Delta must be non-zero.")

    with get_session() as session:
        sub = get_client_subscription(session, client.id)
        if not sub:
            raise HTTPException(status_code=404, detail="No active subscription found.")
        plan = sub.plan
        if plan is None:
            raise HTTPException(status_code=500, detail="Subscription has no associated plan.")

        new_total = (sub.operator_quantity or plan.included_operator_seats or 1) + request.delta
        floor = int(plan.included_operator_seats or 1)
        if new_total < floor:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot reduce below the {floor} included seat(s) on your plan.",
            )

        provider = (sub.payment_provider or "razorpay").lower()
        try:
            if provider == "razorpay":
                from app.services import razorpay_service

                razorpay_service.update_subscription_quantity(session, sub, new_total)
            else:
                from app.services.billing_service import update_seat_quantity

                update_seat_quantity(session, sub, new_total)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Seat update failed for client %s: %s", client.id, exc)
            raise HTTPException(status_code=502, detail="Could not update seats with payment provider.") from exc

        session.commit()
        logger.info("Client %s changed seat count → %s", client.id, sub.operator_quantity)
        return {
            "operator_quantity": sub.operator_quantity,
            "included_operator_seats": floor,
            "extra_seat_price_cents": int(plan.extra_seat_price_cents or 0),
            "currency": plan.currency,
        }


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

    from app.db.models import Bot, CreditLedger

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
            CreditLedger.reason.in_(("ai_chat", "url_scan", "email_send", "document_upload")),
        )
        if period_start is not None:
            usage_q = usage_q.where(CreditLedger.created_at >= period_start)
        usage_q = usage_q.group_by(CreditLedger.reason)
        usage_by_reason = {
            row.reason: {"credits_used": int(row.credits_used), "event_count": int(row.event_count)}
            for row in session.execute(usage_q).all()
        }
        return period_start, {
            "ai_chat": usage_by_reason.get("ai_chat", {"credits_used": 0, "event_count": 0}),
            "url_scan": usage_by_reason.get("url_scan", {"credits_used": 0, "event_count": 0}),
            "email_send": usage_by_reason.get("email_send", {"credits_used": 0, "event_count": 0}),
            "document_upload": usage_by_reason.get("document_upload", {"credits_used": 0, "event_count": 0}),
        }

    with get_session() as session:
        # Account-level pool (legacy + Free bot drain from here).
        breakdown = credit_service.get_balance_breakdown(session, client.id)
        sub = get_client_subscription(session, client.id)
        plan = get_client_plan(session, client.id)
        pricing = credit_service.get_pricing(session)

        period_start, usage_dict = _scope_period_and_usage(session, client.id, None)

        # Per-bot ledgers — one entry per bot that has its own paid
        # subscription. Frontend renders one card per entry so the
        # customer sees an isolated balance + usage panel for each bot.
        bot_rows = (
            session.execute(select(Bot).where(Bot.client_id == client.id, Bot.is_active.is_(True)).order_by(Bot.id))
            .scalars()
            .all()
        )
        bot_ledgers: list[dict] = []
        for bot in bot_rows:
            ledger_bot_id = credit_service.resolve_bot_ledger_bot_id(bot)
            if ledger_bot_id is None:
                continue  # legacy / Free bot — its usage rolls up to the account pool
            bot_plan = bot.plan if bot.plan_id else None
            bot_breakdown = credit_service.get_balance_breakdown(session, client.id, bot_id=ledger_bot_id)
            bot_period_start, bot_usage = _scope_period_and_usage(session, client.id, ledger_bot_id)
            bot_sub = bot.subscription
            bot_ledgers.append(
                {
                    "bot_id": bot.id,
                    "bot_name": bot.name,
                    "bot_key": bot.bot_key,
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
                }
            )

        # Count of bots that still drain from the account pool — drives
        # whether the UI shows the "Account credits" card. When zero (a
        # paid-only account whose only bot has its own subscription) the
        # account pool is hidden entirely.
        account_pool_bot_count = sum(1 for bot in bot_rows if credit_service.resolve_bot_ledger_bot_id(bot) is None)

        costs = {
            "ai_chat": int(pricing.get("credit_cost.ai_chat", 1) or 0),
            "url_scan": int(pricing.get("credit_cost.url_scan", 3) or 0),
            "email_send": int(pricing.get("credit_cost.email_send", 1) or 0),
            "document_upload": int(pricing.get("credit_cost.document_upload", 3) or 0),
        }

        country = resolve_country(http_request)
        currency_code = "INR" if country == "IN" else "USD"
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


@credits_router.get("/history")
def get_credit_history(
    client: Client = Depends(get_current_client),
    page: int = 1,
    limit: int = 50,
):
    """Return paginated ledger entries for the client (most recent first)."""
    page = max(int(page or 1), 1)
    limit = max(min(int(limit or 50), 200), 1)
    with get_session() as session:
        rows = (
            session.execute(
                select(CreditLedger)
                .where(CreditLedger.client_id == client.id)
                .order_by(CreditLedger.created_at.desc())
                .limit(limit)
                .offset((page - 1) * limit)
            )
            .scalars()
            .all()
        )
        return [
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
        ]


class TopupRequest(BaseModel):
    """Top-up purchase request.

    ``amount`` is the rupee amount (or USD for Stripe), matching one of the
    configured packs in ``pricing_config.topup_packs``. ``pack_usd`` is kept
    as a backward-compat alias for older admin builds — at least one of the
    two must be provided.

    ``bot_id`` scopes the purchase to a specific per-bot ledger. Omit
    (or pass null) to top up the account-level client pool — that's the
    correct shape for Free / legacy-pooled bots whose usage drains
    shared credits. Per-bot subscriptions must always pass their bot_id
    so the credits land in the right isolated bucket.
    """

    amount: int | None = None  # rupees (Razorpay) or dollars (Stripe)
    pack_usd: int | None = None  # legacy alias
    provider: str | None = None  # "razorpay" | "stripe"
    bot_id: int | None = None


def _match_topup_pack(packs: list[dict], requested_amount: int) -> dict | None:
    """Find a pack whose configured amount matches ``requested_amount``.

    Top-up packs in the new (INR) schema use the ``amount`` key; legacy
    Stripe-era packs used ``usd``. We accept either so older admin clients
    continue to work during cutover.
    """
    for pack in packs:
        if int(pack.get("amount") or pack.get("usd") or 0) == requested_amount:
            return pack
    return None


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


def _resolve_referral_discount(session, client: Client) -> tuple[int, dict[str, str]]:
    """Return ``(discount_bps, audit_meta)`` for this client's active referral.

    Returns ``(0, {})`` when:
      * the client isn't attributed to any code
      * the attributed code carries no customer discount (commission-only)

    The discount is applied later, inside each provider service, against
    the minor unit (cents/paise) so we retain sub-currency precision —
    e.g. 10% off $19 yields $17.10, not $18 (which whole-unit flooring
    would produce).
    """
    from app.db.models import ReferralCode

    if not getattr(client, "referral_code_id", None):
        return 0, {}

    code_row = session.get(ReferralCode, client.referral_code_id)
    if code_row is None or not code_row.customer_discount_bps:
        return 0, {}

    bps = int(code_row.customer_discount_bps)
    return bps, {
        "referral_code_id": str(code_row.id),
        "referral_code": code_row.code,
        "discount_bps": str(bps),
    }


@credits_router.post("/topup")
def initiate_topup(request: TopupRequest, client: Client = Depends(get_current_client)):
    """Initiate a top-up purchase.

    Returns provider-specific checkout payload:
      * Razorpay (default): ``{provider, order_id, amount, currency, key_id, name, description, prefill, theme}``
        — frontend opens ``new Razorpay({order_id, ...}).open()``.
      * Stripe: ``{checkout_url, session_id}`` — frontend redirect.

    If the customer has a referral code applied (``client.referral_code_id``)
    with a non-zero ``customer_discount_bps``, the discount is applied to the
    pack amount before checkout — so the Stripe page shows the discounted
    price and the customer is actually charged less for the same credits.

    Credits are granted asynchronously via the provider's webhook on payment
    capture; the frontend should also call ``/credits/topup/verify`` for
    Razorpay flows so the success modal is signature-verified server-side
    before showing confetti (defence-in-depth against tampered callbacks).
    """
    requested_amount = request.amount or request.pack_usd
    if not requested_amount:
        raise HTTPException(status_code=400, detail="amount is required.")

    with get_session() as session:
        existing_sub = get_client_subscription(session, client.id)
        provider = _resolve_provider(
            request.provider,
            current_sub_provider=existing_sub.payment_provider if existing_sub else None,
        )

        pricing = credit_service.get_pricing(session)
        packs = pricing.get("topup_packs") or []
        pack = _match_topup_pack(packs, int(requested_amount))
        if not pack:
            raise HTTPException(status_code=400, detail="Invalid top-up pack.")

        # NOTE: referral discounts intentionally do NOT apply to top-ups.
        # The customer-facing discount fires only on plan checkout
        # (subscription_routes.create_checkout). This keeps the affiliate
        # incentive tied to recurring revenue rather than a one-off pack —
        # affiliates earn from the customer's subscription, so the discount
        # also lives there. Referral *attribution* still happens via
        # /affiliate/apply-referral (unchanged); we just don't honour the
        # discount on the top-up checkout amount.

        # Validate per-bot top-up target — the bot must belong to this
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

            try:
                result = razorpay_service.create_topup_order(session, client, pack, bot_id=target_bot_id)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except razorpay_service.RazorpayBillingError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            session.commit()
            return result

        from app.services.billing_service import create_topup_checkout_session

        result = create_topup_checkout_session(session, client, pack)
        result.setdefault("provider", "stripe")
        session.commit()
        return result


class TopupVerifyRequest(BaseModel):
    """Razorpay Checkout success callback verification.

    The frontend sends the trio Razorpay returns in its handler callback;
    we verify the HMAC server-side to make sure the success was genuinely
    signed by Razorpay (defence against tampered modal responses).

    The credit grant itself happens via webhook for both Razorpay and
    Stripe — this endpoint just confirms the modal closure to the user.
    """

    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str


@credits_router.post("/topup/verify")
def verify_topup_payment(
    body: TopupVerifyRequest,
    _: Client = Depends(get_current_client),
):
    """Verify a Razorpay Checkout success callback. Returns 204 on success."""
    from app.services import razorpay_service

    try:
        razorpay_service.verify_topup_signature(
            razorpay_order_id=body.razorpay_order_id,
            razorpay_payment_id=body.razorpay_payment_id,
            razorpay_signature=body.razorpay_signature,
        )
    except razorpay_service.SignatureMismatch as exc:
        raise HTTPException(status_code=400, detail="Signature verification failed.") from exc
    return {"status": "verified"}


class StripeVerifyRequest(BaseModel):
    """Stripe Checkout success self-redemption."""

    session_id: str


@credits_router.post("/topup/verify-stripe")
def verify_stripe_topup(
    body: StripeVerifyRequest,
    client: Client = Depends(get_current_client),
):
    """Fallback grant path for Stripe top-ups when the webhook hasn't fired.

    Stripe webhooks can't reach localhost during development, and even in
    production a customer might land on the success page before the webhook
    arrives. This endpoint takes the ``session_id`` from the success URL,
    pulls the session via the Stripe API (which is authoritative), confirms
    ``payment_status == "paid"`` and ``metadata.purpose == "topup"``, then
    grants the credits idempotently via the same dispatcher the webhook uses.

    Always returns 200. Returns ``{ granted: bool, balance: int }`` so the
    frontend can show the new balance the moment the grant succeeds — no
    poll-and-pray loop after the redirect.

    Security: the session.metadata.client_id MUST match the caller. Without
    that check, anyone could replay another customer's session_id to grant
    themselves credits they didn't buy.
    """
    if not STRIPE_ENABLED:
        raise HTTPException(status_code=503, detail="Stripe is not configured.")

    import stripe

    from app.config import STRIPE_SECRET_KEY
    from app.services.billing_service import _handle_payment_intent_succeeded

    stripe.api_key = STRIPE_SECRET_KEY

    try:
        sess = stripe.checkout.Session.retrieve(body.session_id)
    except Exception as exc:
        logger.warning("Stripe session retrieve failed for %s: %s", body.session_id, exc)
        raise HTTPException(status_code=404, detail="Checkout session not found.") from exc

    # Stripe's response object behaves like a dict for ``[]`` access but does
    # NOT implement ``.get()`` — every read goes through ``[]`` + ``in``.
    if sess["payment_status"] != "paid":
        return {"granted": False, "reason": f"Payment not captured (status={sess['payment_status']})"}

    metadata = dict(sess["metadata"]._data) if "metadata" in sess and sess["metadata"] else {}
    if metadata.get("purpose") != "topup":
        return {"granted": False, "reason": "Session is not a top-up"}

    sess_client_id = metadata.get("client_id")
    if str(sess_client_id) != str(client.id):
        # Don't leak whether the session exists for someone else — 404.
        raise HTTPException(status_code=404, detail="Checkout session not found.")

    # Stripe's StripeObject does not implement ``.get()`` — every read must
    # go through ``[]`` + ``in``. ruff's SIM401 would rewrite this to ``.get``
    # which would crash at runtime.
    pi_id = sess["payment_intent"] if "payment_intent" in sess else None  # noqa: SIM401
    if not pi_id:
        return {"granted": False, "reason": "No PaymentIntent on session"}

    pi = stripe.PaymentIntent.retrieve(pi_id)
    pi_metadata = dict(pi["metadata"]._data) if "metadata" in pi and pi["metadata"] else metadata
    pi_data = {
        "id": pi["id"],
        "metadata": pi_metadata,
        "amount": pi["amount"],
    }

    # Idempotency is enforced inside _record_or_skip_webhook keyed by event
    # id — but this self-redemption path doesn't go through that. Use a
    # synthetic event id derived from the PaymentIntent so repeat calls
    # short-circuit instead of double-granting.
    from app.services.billing_service import _record_or_skip_webhook

    with get_session() as session:
        synthetic_event_id = f"pi_self_verify_{pi_id}"
        if not _record_or_skip_webhook(session, synthetic_event_id, "stripe"):
            session.commit()
            balance = credit_service.get_balance(session, client.id)
            return {"granted": False, "reason": "Already granted", "balance": balance}

        _handle_payment_intent_succeeded(session, pi_data)
        session.commit()
        balance = credit_service.get_balance(session, client.id)

    return {"granted": True, "balance": balance}


@credits_router.get("/packs")
def list_topup_packs():
    """Public list of currently-offered top-up packs (no auth)."""
    with get_session() as session:
        pricing = credit_service.get_pricing(session)
        return pricing.get("topup_packs", [])
