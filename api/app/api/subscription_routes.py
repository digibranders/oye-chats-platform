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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.api.auth import get_current_client_strict as get_current_client
from app.config import BILLING_PROVIDER, RAZORPAY_ENABLED, STRIPE_ENABLED
from app.core.dates import add_months
from app.db.models import Client, CreditLedger, Invoice, Subscription
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


@router.get("/current")
def get_current_subscription(client: Client = Depends(get_current_client)):
    """Return the client's current subscription details + plan info."""
    with get_session() as session:
        sub = get_client_subscription(session, client.id)
        plan = get_client_plan(session, client.id)

        sub_data = None
        if sub:
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


@router.post("/checkout")
def create_checkout(request: CheckoutRequest, client: Client = Depends(get_current_client)):
    """Create a checkout session for a paid plan.

    Returns provider-specific payload:
      * Razorpay → ``{provider, subscription_id, key_id, name, description, prefill, theme}``
        — frontend opens ``new Razorpay({subscription_id, ...}).open()``.
      * Stripe   → ``{checkout_url, session_id}`` — frontend ``window.location.href`` redirect.
    """
    if request.billing_cycle not in ("monthly", "annual"):
        raise HTTPException(status_code=400, detail="billing_cycle must be 'monthly' or 'annual'.")

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
        provider = _resolve_provider(
            request.provider,
            current_sub_provider=existing_sub.payment_provider if existing_sub else None,
        )

        if provider == "razorpay":
            from app.services import razorpay_service

            try:
                result = razorpay_service.create_subscription(session, client, plan, request.billing_cycle)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except razorpay_service.RazorpayBillingError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            session.commit()
            return result

        # Stripe (international fallback)
        from app.services.billing_service import create_checkout_session

        result = create_checkout_session(session, client, plan, request.billing_cycle)
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
def change_plan(request: ChangePlanRequest, client: Client = Depends(get_current_client)):
    """Upgrade or downgrade the client's subscription to a different plan."""
    with get_session() as session:
        from app.services.plan_service import get_client_subscription, get_plan_by_id

        sub = get_client_subscription(session, client.id)
        if not sub:
            raise HTTPException(status_code=404, detail="No active subscription found. Please subscribe first.")

        new_plan = get_plan_by_id(session, request.plan_id)
        if not new_plan or not new_plan.is_active:
            raise HTTPException(status_code=404, detail="Target plan not found or inactive.")

        if sub.plan_id == request.plan_id:
            raise HTTPException(status_code=400, detail="You are already on this plan.")

        billing_cycle = request.billing_cycle or sub.billing_cycle

        if sub.stripe_subscription_id:
            from app.services.billing_service import change_stripe_plan

            change_stripe_plan(sub, new_plan, billing_cycle)

        sub.plan_id = new_plan.id
        sub.billing_cycle = billing_cycle
        session.commit()

        logger.info(f"Client {client.id} changed plan to {new_plan.slug} ({billing_cycle})")
        return {"message": f"Plan changed to {new_plan.name} successfully."}


# ── Cancellation ──


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
def get_credit_balance(client: Client = Depends(get_current_client)):
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

    from app.db.models import CreditLedger

    with get_session() as session:
        breakdown = credit_service.get_balance_breakdown(session, client.id)
        sub = get_client_subscription(session, client.id)
        plan = get_client_plan(session, client.id)
        pricing = credit_service.get_pricing(session)

        # Find the most recent positive plan_grant to anchor "this period".
        # Falls back to the client's first ledger entry if none.
        period_start_row = (
            session.execute(
                select(CreditLedger.created_at)
                .where(
                    CreditLedger.client_id == client.id,
                    CreditLedger.reason == "plan_grant",
                    CreditLedger.delta > 0,
                )
                .order_by(CreditLedger.created_at.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )
        period_start = period_start_row

        # Sum negative deltas (consumption) per reason since period_start.
        usage_q = select(
            CreditLedger.reason,
            func.coalesce(func.sum(-CreditLedger.delta), 0).label("credits_used"),
            func.count(CreditLedger.id).label("event_count"),
        ).where(
            CreditLedger.client_id == client.id,
            CreditLedger.delta < 0,
            CreditLedger.reason.in_(("ai_chat", "url_scan", "email_send")),
        )
        if period_start is not None:
            usage_q = usage_q.where(CreditLedger.created_at >= period_start)
        usage_q = usage_q.group_by(CreditLedger.reason)
        usage_rows = session.execute(usage_q).all()
        usage_by_reason = {
            row.reason: {"credits_used": int(row.credits_used), "event_count": int(row.event_count)}
            for row in usage_rows
        }

        costs = {
            "ai_chat": int(pricing.get("credit_cost.ai_chat", 1) or 0),
            "url_scan": int(pricing.get("credit_cost.url_scan", 3) or 0),
            "email_send": int(pricing.get("credit_cost.email_send", 1) or 0),
        }

        currency_code = (plan.currency if plan else None) or pricing.get("billing.currency", "INR")
        currency_symbol = (
            pricing.get("billing.currency_symbol", "₹")
            if currency_code == "INR"
            else ("$" if currency_code == "USD" else currency_code + " ")
        )

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
            "usage": {
                "ai_chat": usage_by_reason.get("ai_chat", {"credits_used": 0, "event_count": 0}),
                "url_scan": usage_by_reason.get("url_scan", {"credits_used": 0, "event_count": 0}),
                "email_send": usage_by_reason.get("email_send", {"credits_used": 0, "event_count": 0}),
            },
            "currency": currency_code,
            "currency_symbol": currency_symbol,
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
    """

    amount: int | None = None  # rupees (Razorpay) or dollars (Stripe)
    pack_usd: int | None = None  # legacy alias
    provider: str | None = None  # "razorpay" | "stripe"


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

        # Resolve the customer-facing referral discount (if any). The bps is
        # passed straight through to the provider service which applies it
        # in the minor unit, preserving sub-currency precision.
        discount_bps, discount_meta = _resolve_referral_discount(session, client)

        if provider == "razorpay":
            from app.services import razorpay_service

            try:
                result = razorpay_service.create_topup_order(
                    session,
                    client,
                    pack,
                    discount_bps=discount_bps,
                    extra_notes=discount_meta or None,
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except razorpay_service.RazorpayBillingError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            session.commit()
            return result

        from app.services.billing_service import create_topup_checkout_session

        result = create_topup_checkout_session(
            session,
            client,
            pack,
            discount_bps=discount_bps,
            extra_metadata=discount_meta or None,
        )
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
