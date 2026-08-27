"""Super admin plan and subscription management routes.

Full CRUD for pricing plans + subscription overrides.  Plans are the core
configuration entity. All prices, limits, and features are stored here
and can be modified at runtime without code changes.
"""

import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import AfterValidator, BaseModel, Field, StringConstraints
from sqlalchemy import func, select

from app.api.auth import get_superadmin
from app.api.superadmin_routes_v2 import _require_write
from app.config import DISPLAY_USD_TO_INR, EXTRA_SEAT_PRICE_USD_CENTS, RAZORPAY_SEAT_PLAN_PRICE_CENTS
from app.core.pricing import annual_saving_percent, display_price, emandate_warning
from app.db.models import Client, Invoice, Plan, Subscription
from app.db.session import get_session
from app.schemas.validators import (
    BoundedJsonObject,
    GatewayRef,
    MediumText,
    RequiredName,
    RowId,
    bounded_list,
)
from app.services import plan_entitlements_service
from app.services.plan_entitlements_service import UNLIMITED
from app.services.plan_service import get_pricing_content, plan_checkout_is_wired, set_pricing_content

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/superadmin", tags=["superadmin-plans"])


def _validate_included_seats(value: int) -> int:
    """Allow the UNLIMITED sentinel (``-1``) alongside any positive seat count.

    A plain ``ge=1`` bound made the seeded Enterprise row (unlimited seats)
    unable to round-trip through this editor, while a plain ``ge=-1`` would
    admit ``0``, a plan that includes no seats at all, which the seat add-on
    floor and MRR maths both treat as a misconfiguration. ``-1`` is therefore
    the ONLY meaningful non-positive value.
    """
    if value == UNLIMITED or value >= 1:
        return value
    raise ValueError(f"included_operator_seats must be a positive seat count or {UNLIMITED} for unlimited.")


IncludedOperatorSeats = Annotated[int, AfterValidator(_validate_included_seats)]


def _to_usd_cents(amount_minor: int | None, currency: str | None) -> int:
    """Normalise a stored minor-unit amount to USD cents.

    Mirrors the customer-app display rule (``core.pricing.display_price``):
    INR-stored amounts are converted at the fixed ``DISPLAY_USD_TO_INR`` rate,
    USD amounts pass through unchanged. The super-admin dashboard reports a
    single canonical currency (USD), matching what international customers see.
    """
    minor = int(amount_minor or 0)
    if (currency or "usd").lower() == "inr":
        usd_cents, _ = display_price(inr_paise=minor, usd_cents=None, country=None, rate=DISPLAY_USD_TO_INR)
        return usd_cents
    return minor


def _plan_monthly_usd_cents(plan: Plan, billing_cycle: str) -> int:
    """Monthly-equivalent USD cents for a plan on a given billing cycle.

    Prefers the plan's stored USD column (the exact gateway price) and falls
    back to converting the INR column only for legacy rows with no USD price.
    Identical precedence to ``PlanModal``'s ``PriceBlock`` on the frontend.
    """
    if billing_cycle == "annual" and (plan.annual_price_cents or plan.annual_price_usd_cents):
        annual_usd, _ = display_price(
            inr_paise=plan.annual_price_cents,
            usd_cents=plan.annual_price_usd_cents,
            country=None,
            rate=DISPLAY_USD_TO_INR,
        )
        return round(annual_usd / 12)  # round, not floor, so MRR isn't understated (M8)
    monthly_usd, _ = display_price(
        inr_paise=plan.monthly_price_cents,
        usd_cents=plan.monthly_price_usd_cents,
        country=None,
        rate=DISPLAY_USD_TO_INR,
    )
    return monthly_usd


# ── Request Models ──

# Rows in one pricing-content list.
_MAX_PRICING_ITEMS = 200

# The public plan identifier: appears in URLs, entitlement lookups and the
# gateway plan mapping, so it is a slug rather than free text.
PlanSlug = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9_\-]*$"),
]


class CreatePlanRequest(BaseModel):
    name: RequiredName
    # The public plan identifier used in URLs, entitlement lookups and the
    # gateway plan mapping.
    slug: PlanSlug
    description: MediumText | None = None
    pricing_model: Literal["per_operator", "flat", "usage"] = "per_operator"
    # Handler-enforced: ``create_plan``/``update_plan`` reject anything but
    # INR with a 400 explaining the INR-primary model. Bounded here so the
    # two do not become competing allow-lists.
    currency: str = Field(default="INR", max_length=8)
    monthly_price_cents: int = Field(0, ge=0)
    annual_price_cents: int = Field(0, ge=0)
    monthly_price_usd_cents: int | None = Field(None, ge=0)
    annual_price_usd_cents: int | None = Field(None, ge=0)
    extra_seat_price_usd_cents: int | None = Field(None, ge=0)
    # No default. This used to default to 30, so the single most likely way to
    # create a bespoke tier was to publish a 30% annual discount nobody had
    # checked and no price backed. It is now derived from the prices below; an
    # explicit value is accepted only when it already agrees with them
    # (:func:`_resolve_annual_discount`).
    annual_discount_percent: int | None = Field(None, ge=0, le=100)
    trial_days: int = Field(7, ge=0)
    # Plan config, stored as JSONB. The key sets are product-defined rather
    # than API contract, so they stay open-ended, but bounded, so the plan
    # table cannot be grown without limit.
    limits: BoundedJsonObject | None = None
    features: BoundedJsonObject | None = None
    marketing: BoundedJsonObject | None = None
    overage_rate_cents: int = Field(0, ge=0)
    credits_per_month: int = Field(0, ge=0)
    included_operator_seats: IncludedOperatorSeats = 1
    # Defaults to the canonical charged seat price so a plan created without an
    # explicit value stays consistent with what the seat add-on actually bills.
    extra_seat_price_cents: int = Field(RAZORPAY_SEAT_PLAN_PRICE_CENTS, ge=0)
    razorpay_plan_id_monthly: GatewayRef | None = None
    razorpay_plan_id_annual: GatewayRef | None = None
    razorpay_plan_id_monthly_usd: GatewayRef | None = None
    razorpay_plan_id_annual_usd: GatewayRef | None = None
    is_active: bool = True
    is_default: bool = False
    sort_order: int = 0


class UpdatePlanRequest(BaseModel):
    name: RequiredName | None = None
    description: MediumText | None = None
    pricing_model: Literal["per_operator", "flat", "usage"] | None = None
    currency: str | None = Field(default=None, max_length=8)
    monthly_price_cents: int | None = Field(None, ge=0)
    annual_price_cents: int | None = Field(None, ge=0)
    monthly_price_usd_cents: int | None = Field(None, ge=0)
    annual_price_usd_cents: int | None = Field(None, ge=0)
    extra_seat_price_usd_cents: int | None = Field(None, ge=0)
    annual_discount_percent: int | None = Field(None, ge=0, le=100)
    trial_days: int | None = Field(None, ge=0)
    # Plan config, stored as JSONB. The key sets are product-defined rather
    # than API contract, so they stay open-ended, but bounded, so the plan
    # table cannot be grown without limit.
    limits: BoundedJsonObject | None = None
    features: BoundedJsonObject | None = None
    marketing: BoundedJsonObject | None = None
    overage_rate_cents: int | None = Field(None, ge=0)
    credits_per_month: int | None = Field(None, ge=0)
    included_operator_seats: IncludedOperatorSeats | None = None
    extra_seat_price_cents: int | None = Field(None, ge=0)
    is_active: bool | None = None
    is_default: bool | None = None
    sort_order: int | None = None
    razorpay_plan_id_monthly: GatewayRef | None = None
    razorpay_plan_id_annual: GatewayRef | None = None
    razorpay_plan_id_monthly_usd: GatewayRef | None = None
    razorpay_plan_id_annual_usd: GatewayRef | None = None


class UpdateSubscriptionRequest(BaseModel):
    plan_id: RowId | None = None
    # Allow-listed in the handler against ``valid_statuses``, which answers 400 with the
    # permitted set. Bounded here rather than re-declared as a ``Literal``:
    # two copies of one allow-list drift, and moving the rejection into the
    # schema would silently change this endpoint's status code.
    status: str | None = Field(default=None, max_length=32)
    # Bounds (M8): a negative quantity yields negative MRR; a negative
    # extend_trial_days silently back-dates/shortens the trial.
    operator_quantity: int | None = Field(default=None, ge=0, le=1000)
    billing_cycle: Literal["monthly", "annual"] | None = None
    extend_trial_days: int | None = Field(default=None, ge=0, le=365)


class PricingContentRequest(BaseModel):
    # Marketing copy rendered on the public pricing page. Item shape is
    # content, not contract, so the lists stay untyped, but each is capped so
    # the public page cannot be handed an unbounded payload to render.
    faq: Annotated[list, bounded_list(_MAX_PRICING_ITEMS)] | None = None
    feature_matrix: Annotated[list, bounded_list(_MAX_PRICING_ITEMS)] | None = None
    topup_packs: Annotated[list, bounded_list(_MAX_PRICING_ITEMS)] | None = None
    credit_costs: Annotated[list, bounded_list(_MAX_PRICING_ITEMS)] | None = None


# ── Plan CRUD ──


@router.get("/plans")
def list_all_plans(superadmin: Client = Depends(get_superadmin)):
    """List all plans including inactive ones (for admin management)."""
    with get_session() as session:
        stmt = select(Plan).order_by(Plan.sort_order)
        plans = session.execute(stmt).scalars().all()

        # Count active subscriptions per plan
        sub_counts = dict(
            session.execute(
                select(Subscription.plan_id, func.count(Subscription.id))
                .where(Subscription.status.in_(("active", "trialing", "past_due")))
                .group_by(Subscription.plan_id)
            ).all()
        )

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
                # Derived, exactly as the customer-facing catalogs serve it, so
                # the editor shows the operator the number their customers read
                # rather than whatever int the row happens to carry. Writes below
                # store the same derived value, so the two converge on first save.
                "annual_discount_percent": annual_saving_percent(p.monthly_price_cents, p.annual_price_cents),
                "trial_days": p.trial_days,
                "limits": p.limits,
                "features": p.features,
                "overage_rate_cents": p.overage_rate_cents,
                "marketing": p.marketing,
                "credits_per_month": p.credits_per_month,
                "included_operator_seats": p.included_operator_seats,
                "extra_seat_price_cents": p.extra_seat_price_cents,
                "extra_seat_price_usd_cents": p.extra_seat_price_usd_cents,
                "is_active": p.is_active,
                "is_default": p.is_default,
                "sort_order": p.sort_order,
                "razorpay_plan_id_monthly": p.razorpay_plan_id_monthly,
                "razorpay_plan_id_annual": p.razorpay_plan_id_annual,
                "active_subscriptions": sub_counts.get(p.id, 0),
                "created_at": p.created_at.isoformat() if p.created_at else None,
                "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            }
            for p in plans
        ]


def _reject_seat_price_drift(data: dict) -> None:
    """Keep a plan's advertised seat price equal to what the seat add-on bills.

    Extra seats always bill the single global seat add-on at the canonical price
    (``RAZORPAY_SEAT_PLAN_PRICE_CENTS`` INR / ``EXTRA_SEAT_PRICE_USD_CENTS`` USD),
    so a plan row must never carry an INR/USD seat price it won't actually charge
    (finding H3). Allow ``0`` (the plan sells no extra seats) or the canonical
    value; reject anything else with a clear 422 rather than letting the catalog
    display a price the customer will never be billed. Only fields explicitly
    present in ``data`` are checked, so partial updates that omit seat pricing are
    untouched.
    """
    inr = data.get("extra_seat_price_cents")
    if inr is not None and int(inr) not in (0, RAZORPAY_SEAT_PLAN_PRICE_CENTS):
        raise HTTPException(
            status_code=422,
            detail=(
                f"Extra seats bill the global seat add-on at ₹{RAZORPAY_SEAT_PLAN_PRICE_CENTS // 100}/mo. Set "
                f"extra_seat_price_cents to {RAZORPAY_SEAT_PLAN_PRICE_CENTS} (₹{RAZORPAY_SEAT_PLAN_PRICE_CENTS // 100}) "
                "or 0 (no paid seats). To change the seat price, mint a new Razorpay seat plan and update the env."
            ),
        )
    usd = data.get("extra_seat_price_usd_cents")
    if usd is not None and int(usd) not in (0, EXTRA_SEAT_PRICE_USD_CENTS):
        raise HTTPException(
            status_code=422,
            detail=(
                f"International seat price is fixed at ${EXTRA_SEAT_PRICE_USD_CENTS // 100}/mo. Set "
                f"extra_seat_price_usd_cents to {EXTRA_SEAT_PRICE_USD_CENTS} or 0."
            ),
        )


def _resolve_annual_discount(*, monthly_minor: int | None, annual_minor: int | None, supplied: int | None) -> int:
    """The ``annual_discount_percent`` a write may store: always the derived one.

    Reads serve :func:`app.core.pricing.annual_saving_percent` regardless, so the
    stored column can no longer publish anything. This keeps it in sync anyway
    (one number in the row, in the payload and on every surface) rather than
    leaving a decorative int that quietly disagrees with the prices beside it and
    misleads the next person to query the table.

    A supplied value is VALIDATED, not silently dropped. Ignoring it would make
    the super-admin editor's field a no-op that still looks editable, which is a
    worse failure than the one being fixed; a 422 naming the derived figure tells
    the operator that the way to change the advertised discount is to move the
    annual price. Omitting the field is the normal path and always correct.
    """
    derived = annual_saving_percent(monthly_minor, annual_minor)
    if supplied is not None and int(supplied) != derived:
        raise HTTPException(
            status_code=422,
            detail=(
                f"annual_discount_percent is derived from the prices, not set: these amounts are a "
                f"{derived}% annual saving, not {int(supplied)}%. Omit the field, or send {derived}. "
                "To advertise a different discount, change annual_price_cents."
            ),
        )
    return derived


def _emandate_warnings(plan: Plan, rate_bps: int) -> list[str]:
    """Every amount this plan can debit in one transaction.

    The check itself is :func:`app.core.pricing.emandate_warning`. Shared with
    ``scripts/seed_plans.py``, which is the path every real price change has
    actually taken and which used to run no check at all (that is how both
    annual tiers crossed the ceiling unnoticed). Both writers now warn off the
    same constant, so neither can be re-priced past the ceiling silently.
    """
    return [
        w
        for w in (
            emandate_warning(plan.monthly_price_cents, plan.currency, rate_bps=rate_bps),
            emandate_warning(plan.annual_price_cents, plan.currency, rate_bps=rate_bps),
        )
        if w
    ]


def _checkout_wiring_warning(plan: Plan) -> str | None:
    """Warn when a LISTED paid tier has no INR gateway ids to charge against.

    Deliberately a warning and not a block, for the same reason
    :func:`emandate_warning` is: a listed tier with no plan id is a legitimate,
    supported state (it is how a contact-sales tier is published) and the
    platform degrades cleanly into it (the quote answers
    ``inr_plan_unconfigured`` with a sales address, and the charge path refuses
    in the same shape rather than 500ing).

    What it prevents is reaching that state UNKNOWINGLY. Nothing else on these
    routes mentions gateway wiring: ``CreatePlanRequest.is_active`` defaults to
    ``True`` with every ``razorpay_plan_id_*`` defaulting to ``None``, so the
    single most likely way to create a plan is to publish one no visitor can
    buy, and the super admin would have had no signal at all.

    Free tiers are exempt; there is nothing to charge.
    """
    if plan_checkout_is_wired(
        is_free=not plan.monthly_price_cents and not plan.annual_price_cents,
        razorpay_plan_id_monthly=plan.razorpay_plan_id_monthly,
        razorpay_plan_id_annual=plan.razorpay_plan_id_annual,
    ):
        return None
    if not plan.is_active:
        # Not listed, so no visitor can reach the dead checkout. Nothing to say.
        return None
    missing = [
        label
        for label, value in (("monthly", plan.razorpay_plan_id_monthly), ("annual", plan.razorpay_plan_id_annual))
        if not value
    ]
    return (
        f"Plan '{plan.name}' is listed but has no INR Razorpay plan id for {' and '.join(missing)} billing. "
        "It will appear on the pricing page and quote Contact sales instead of a checkout button. "
        "Set the id(s) to open self-serve checkout."
    )


def _plan_warnings(plan: Plan, session) -> list[str]:
    """Every non-blocking advisory the plan-CRUD routes return to the operator.

    One list so the two routes cannot drift on which checks they run. Takes the
    open session because the e-mandate check needs the GST rate: the RBI ceiling
    applies to the amount DEBITED, which is the stored base plus tax.
    """
    from app.services.seller_profile_service import charge_tax_rate_bps

    rate_bps = charge_tax_rate_bps(session)
    return _emandate_warnings(plan, rate_bps) + [w for w in (_checkout_wiring_warning(plan),) if w]


@router.post("/plans")
def create_plan(request: CreatePlanRequest, superadmin: Client = Depends(get_superadmin)):
    """Create a new pricing plan."""
    _require_write(superadmin)
    _reject_seat_price_drift(request.model_dump())
    annual_discount_percent = _resolve_annual_discount(
        monthly_minor=request.monthly_price_cents,
        annual_minor=request.annual_price_cents,
        supplied=request.annual_discount_percent,
    )
    # F7: dual-rail model. INR in *_cents, USD in *_usd_cents. A non-INR plan
    # currency has no supported meaning anywhere in the platform.
    if str(request.currency or "INR").upper() != "INR":
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unsupported plan currency {request.currency!r}. Plans are INR-primary; "
                "international pricing lives in the *_usd_cents columns."
            ),
        )
    with get_session() as session:
        # Check slug uniqueness
        existing = session.execute(select(Plan).where(Plan.slug == request.slug)).scalars().first()
        if existing:
            raise HTTPException(status_code=400, detail=f"A plan with slug '{request.slug}' already exists.")

        # If this plan is marked as default, unset current default
        if request.is_default:
            for p in session.execute(select(Plan).where(Plan.is_default.is_(True))).scalars().all():
                p.is_default = False

        plan = Plan(
            name=request.name,
            slug=request.slug,
            description=request.description,
            pricing_model=request.pricing_model,
            currency=request.currency,
            monthly_price_cents=request.monthly_price_cents,
            annual_price_cents=request.annual_price_cents,
            monthly_price_usd_cents=request.monthly_price_usd_cents,
            annual_price_usd_cents=request.annual_price_usd_cents,
            extra_seat_price_usd_cents=request.extra_seat_price_usd_cents,
            annual_discount_percent=annual_discount_percent,
            trial_days=request.trial_days,
            # Explicit literals (N5): reaching into the SQLAlchemy Column.default
            # internals (``Plan.limits.default.arg``) breaks if the default is a
            # callable or server_default. ``or {}`` is correct and safe.
            limits=request.limits or {},
            features=request.features or {},
            marketing=request.marketing or {},
            overage_rate_cents=request.overage_rate_cents,
            credits_per_month=request.credits_per_month,
            included_operator_seats=request.included_operator_seats,
            extra_seat_price_cents=request.extra_seat_price_cents,
            razorpay_plan_id_monthly=request.razorpay_plan_id_monthly,
            razorpay_plan_id_annual=request.razorpay_plan_id_annual,
            razorpay_plan_id_monthly_usd=request.razorpay_plan_id_monthly_usd,
            razorpay_plan_id_annual_usd=request.razorpay_plan_id_annual_usd,
            is_active=request.is_active,
            is_default=request.is_default,
            sort_order=request.sort_order,
        )
        session.add(plan)
        session.commit()
        session.refresh(plan)

        logger.info(f"Superadmin {superadmin.id} created plan '{plan.name}' (id={plan.id})")

        return {
            "message": f"Plan '{plan.name}' created successfully.",
            "plan_id": plan.id,
            "warnings": _plan_warnings(plan, session),
        }


@router.put("/plans/{plan_id}")
def update_plan(plan_id: int, request: UpdatePlanRequest, superadmin: Client = Depends(get_superadmin)):
    """Update an existing plan. Only provided fields are modified."""
    _require_write(superadmin)
    with get_session() as session:
        plan = session.execute(select(Plan).where(Plan.id == plan_id)).scalars().first()
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found.")

        update_data = request.model_dump(exclude_unset=True)
        _reject_seat_price_drift(update_data)

        # Recomputed on EVERY update, against the prices this edit leaves behind
        # (a partial update may move neither, one, or both). That makes any save
        # self-heal a row whose stored int predates this rule (seeded
        # Professional's 22 becomes the true 21) and makes it impossible to edit
        # a price without the advertised discount following it. Resolved BEFORE
        # the Razorpay mint below so a rejected value cannot orphan a gateway plan.
        update_data["annual_discount_percent"] = _resolve_annual_discount(
            monthly_minor=update_data.get("monthly_price_cents", plan.monthly_price_cents),
            annual_minor=update_data.get("annual_price_cents", plan.annual_price_cents),
            supplied=update_data.get("annual_discount_percent"),
        )

        # If setting this as default, unset current default
        if update_data.get("is_default"):
            for p in session.execute(select(Plan).where(Plan.is_default.is_(True), Plan.id != plan_id)).scalars().all():
                p.is_default = False

        # F7 guard: the dual-rail model stores INR minor units in *_cents and
        # USD minor units in *_usd_cents, a Plan row whose own ``currency`` is
        # anything but INR would make the mint below mislabel foreign minor
        # units as paise (and nothing else in the platform supports it). Refuse
        # the edit rather than mint a mandate at the wrong magnitude.
        requested_currency = update_data.get("currency")
        if requested_currency is not None and str(requested_currency).upper() != "INR":
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Unsupported plan currency {requested_currency!r}. Plans are INR-primary; "
                    "international pricing lives in the *_usd_cents columns."
                ),
            )

        # Finding B: Razorpay plans are immutable, so a price edit that leaves
        # razorpay_plan_id_* pointing at the old plan makes "displayed != charged"
        # , the catalog quotes the new price while every new mandate keeps
        # debiting the old one. When a price field changes and the caller didn't
        # also supply a matching new plan id, mint a fresh Razorpay plan and swap
        # the id in the SAME update so the two never diverge. (The discounted-plan
        # cache self-heals separately via resolve_discounted_plan.) Covers BOTH
        # rails (P1-2/F2): a USD price edit previously minted nothing, so the
        # quote showed the new dollar amount while every new USD mandate kept
        # debiting the old Razorpay plan.
        _PRICE_TO_PLAN_ID = {
            "monthly_price_cents": ("razorpay_plan_id_monthly", "monthly", "INR"),
            "annual_price_cents": ("razorpay_plan_id_annual", "yearly", "INR"),
            "monthly_price_usd_cents": ("razorpay_plan_id_monthly_usd", "monthly", "USD"),
            "annual_price_usd_cents": ("razorpay_plan_id_annual_usd", "yearly", "USD"),
        }
        # Mint the fresh Razorpay plan(s) FIRST, before mutating anything, so a
        # failure on the second cycle can't leave the row half-updated. Collect
        # the minted ids and only apply them once BOTH succeed. On any gateway
        # failure, map to a 502 (matching every other RazorpayBillingError site)
        # and log the orphaned plan ids so they can be reconciled, never leak a
        # generic 500.
        from app.services import razorpay_service
        from app.services.seller_profile_service import charge_tax_rate_bps

        # Read once for the whole mint loop, off the session already open here,
        # so the rate cannot shift between the monthly and annual mints of the
        # same edit and leave the two rails taxed differently.
        seller_rate_bps = charge_tax_rate_bps(session)

        minted_ids: dict[str, str | None] = {}
        for price_field, (id_field, period, rail_currency) in _PRICE_TO_PLAN_ID.items():
            new_price = update_data.get(price_field)
            if (
                new_price is not None
                and int(new_price) != int(getattr(plan, price_field) or 0)
                and id_field not in update_data
            ):
                # A zero (free) price has no recurring Razorpay plan to mint.
                # Create_plan_for_price rejects a non-positive amount with a
                # ValueError that would escape as a 500. Clear the gateway id
                # instead so "make this tier free" is a clean, supported edit.
                if int(new_price) <= 0:
                    minted_ids[id_field] = None
                    logger.info(
                        "Plan %s %s (%s) price set to 0 (free). Clearing Razorpay plan id",
                        plan.id,
                        period,
                        rail_currency,
                    )
                    continue
                try:
                    new_rzp_id = razorpay_service.create_plan_for_price(
                        name=f"{plan.name} ({period}{', USD' if rail_currency == 'USD' else ''})",
                        # The BASE price the admin typed. ``create_plan_for_price``
                        # adds GST itself on the domestic rail, so this must stay
                        # the base: uplifting here too would mint at base × 1.18².
                        amount_paise=int(new_price),
                        period=period,
                        # Each rail mints in its own fixed currency: paise for the
                        # *_cents fields, cents for *_usd_cents. Never cross-label.
                        currency=rail_currency,
                        rate_bps=seller_rate_bps,
                    )
                except razorpay_service.RazorpayBillingError as exc:
                    if minted_ids:
                        logger.error(
                            "Plan %s price edit aborted after minting %s; those Razorpay plans are "
                            "now orphaned (unreferenced) and need reconciliation.",
                            plan.id,
                            minted_ids,
                        )
                    raise HTTPException(status_code=502, detail=str(exc)) from exc
                minted_ids[id_field] = new_rzp_id
                logger.info(
                    "Plan %s %s price %s→%s; minted Razorpay plan %s",
                    plan.id,
                    period,
                    getattr(plan, price_field),
                    new_price,
                    new_rzp_id,
                )
        update_data.update(minted_ids)

        # JSONB dict fields MERGE instead of replace. The admin editor sends
        # only the keys its typed UI knows about; assigning that payload
        # wholesale silently deletes every backend-only key, which is exactly
        # what wiped Starter's max_crawl_* limits and topup_allowed feature in
        # prod (entitlements fail closed, so missing keys read as 0/False and
        # paid customers degrade to Free-tier gates). Merging means the editor
        # can update or add keys but can never destroy ones it doesn't know.
        _MERGE_JSON_FIELDS = ("limits", "features", "marketing")
        for field, value in update_data.items():
            if field in _MERGE_JSON_FIELDS and isinstance(value, dict):
                setattr(plan, field, {**(getattr(plan, field) or {}), **value})
            else:
                setattr(plan, field, value)

        session.commit()

        logger.info(f"Superadmin {superadmin.id} updated plan {plan_id} ({plan.name})")

        return {
            "message": f"Plan '{plan.name}' updated successfully.",
            "warnings": _plan_warnings(plan, session),
        }


@router.delete("/plans/{plan_id}")
def delete_plan(plan_id: int, superadmin: Client = Depends(get_superadmin)):
    """Soft-delete a plan (set is_active=False). Cannot delete plans with active subscriptions.

    The deactivation sticks across a reseed: ``scripts/seed_plans.py`` writes
    ``is_active`` only on rows it INSERTS, never on rows it updates, so a plan
    soft-deleted here is not resurrected the next time the catalogue is seeded.
    """
    _require_write(superadmin)
    with get_session() as session:
        plan = session.execute(select(Plan).where(Plan.id == plan_id)).scalars().first()
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found.")

        # Check for active subscriptions
        active_subs = session.execute(
            select(func.count(Subscription.id)).where(
                Subscription.plan_id == plan_id,
                Subscription.status.in_(("active", "trialing", "past_due")),
            )
        ).scalar()

        if active_subs and active_subs > 0:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot delete plan with {active_subs} active subscription(s). "
                "Move subscribers to another plan first.",
            )

        plan.is_active = False
        # Clear the default flag on soft-delete: a deactivated-but-still-default
        # plan would otherwise be handed to new signups (finding). get_default_plan
        # also filters is_active as defence-in-depth, but a deactivated plan should
        # never remain the marked default in the first place.
        plan.is_default = False
        session.commit()

        logger.info(f"Superadmin {superadmin.id} deactivated plan {plan_id} ({plan.name})")

        return {"message": f"Plan '{plan.name}' deactivated successfully."}


# ── Pricing Content ──


@router.get("/pricing-content")
def read_pricing_content(superadmin: Client = Depends(get_superadmin)):
    """Editable website pricing copy (FAQ, comparison matrix, top-ups, costs)."""
    with get_session() as session:
        return get_pricing_content(session)


@router.put("/pricing-content")
def write_pricing_content(request: PricingContentRequest, superadmin: Client = Depends(get_superadmin)):
    """Upsert any subset of the website pricing-content blobs."""
    _require_write(superadmin)
    with get_session() as session:
        set_pricing_content(session, request.model_dump(exclude_none=True))
        logger.info(f"Superadmin {superadmin.id} updated pricing content")
        return {"message": "Pricing content updated successfully."}


# ── Subscription Management ──


@router.get("/subscriptions")
def list_subscriptions(
    status: str | None = None,
    plan_id: int | None = None,
    superadmin: Client = Depends(get_superadmin),
):
    """List all subscriptions with optional status/plan filters."""
    with get_session() as session:
        stmt = select(Subscription).order_by(Subscription.created_at.desc())
        if status:
            stmt = stmt.where(Subscription.status == status)
        if plan_id:
            stmt = stmt.where(Subscription.plan_id == plan_id)

        subs = session.execute(stmt.limit(200)).scalars().all()

        # Batch-load client names and plan names
        client_ids = {s.client_id for s in subs}
        plan_ids = {s.plan_id for s in subs}

        client_rows = (
            session.execute(select(Client).where(Client.id.in_(client_ids))).scalars().all() if client_ids else []
        )
        clients = {c.id: {"name": c.name, "email": c.email} for c in client_rows}

        plans = (
            {p.id: p.name for p in session.execute(select(Plan).where(Plan.id.in_(plan_ids))).scalars().all()}
            if plan_ids
            else {}
        )

        return [
            {
                "id": s.id,
                "client_id": s.client_id,
                "client_name": clients.get(s.client_id, {}).get("name", "Unknown"),
                "client_email": clients.get(s.client_id, {}).get("email"),
                "plan_id": s.plan_id,
                "plan_name": plans.get(s.plan_id, "Unknown"),
                "status": s.status,
                "billing_cycle": s.billing_cycle,
                "operator_quantity": s.operator_quantity,
                "payment_provider": s.payment_provider,
                "current_period_start": s.current_period_start.isoformat() if s.current_period_start else None,
                "current_period_end": s.current_period_end.isoformat() if s.current_period_end else None,
                "trial_end": s.trial_end.isoformat() if s.trial_end else None,
                "canceled_at": s.canceled_at.isoformat() if s.canceled_at else None,
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
            for s in subs
        ]


@router.put("/subscriptions/{subscription_id}")
def update_subscription(
    subscription_id: int,
    request: UpdateSubscriptionRequest,
    superadmin: Client = Depends(get_superadmin),
):
    """Manual override: change plan, status, extend trial, etc."""
    _require_write(superadmin)
    with get_session() as session:
        sub = session.execute(select(Subscription).where(Subscription.id == subscription_id)).scalars().first()
        if not sub:
            raise HTTPException(status_code=404, detail="Subscription not found.")

        if request.plan_id is not None:
            plan = session.execute(select(Plan).where(Plan.id == request.plan_id)).scalars().first()
            if not plan:
                raise HTTPException(status_code=400, detail="Target plan not found.")
            # A plan whose ``limits.bots`` is the UNLIMITED sentinel sells ONE
            # credit balance pooled across every agent, so it is only coherent on
            # an ACCOUNT-scoped subscription (``bot_id IS NULL``). Stamped onto a
            # bot-scoped row its credits are granted into that bot's isolated
            # ledger while every other agent it entitles drains the unfunded
            # shared pool.
            #
            # REJECTED rather than silently forced to ``bot_id=None``: this is a
            # manual plan override, and re-scoping the subscription as a side
            # effect would move the customer's credit ledger without anyone
            # asking, and could collide with the client's existing account row on
            # the ``ix_subscriptions_client_bot_active`` partial unique index.
            # Failing at COMMIT, after the audit log says it succeeded. An admin
            # who genuinely wants the move should make the scope change
            # deliberately.
            if sub.bot_id is not None and plan_entitlements_service.plan_grants_unlimited_bots(plan):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Subscription {sub.id} is scoped to agent {sub.bot_id}, and the {plan.name} plan "
                        "includes unlimited AI agents, it sells one pooled credit balance and can only be "
                        "billed at account level (bot_id NULL). Move the subscription to account scope first."
                    ),
                )
            sub.plan_id = request.plan_id

        if request.status is not None:
            valid_statuses = {"active", "trialing", "past_due", "canceled", "paused", "expired"}
            if request.status not in valid_statuses:
                raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {valid_statuses}")
            sub.status = request.status

        if request.operator_quantity is not None:
            sub.operator_quantity = request.operator_quantity

        if request.billing_cycle is not None:
            sub.billing_cycle = request.billing_cycle

        if request.extend_trial_days is not None and sub.trial_end:
            from datetime import timedelta

            sub.trial_end = sub.trial_end + timedelta(days=request.extend_trial_days)

        session.commit()

        logger.info(f"Superadmin {superadmin.id} updated subscription {subscription_id}")

        return {"message": "Subscription updated successfully."}


# ── Revenue Metrics ──


@router.get("/revenue")
def get_revenue_metrics(superadmin: Client = Depends(get_superadmin)):
    """Calculate MRR, total revenue, and subscription counts.

    All monetary figures are reported in **USD cents** (the dashboard's
    canonical currency). Plan prices and invoices stored in INR are converted
    via the same fixed-rate rule the customer app uses for non-Indian visitors.
    """
    with get_session() as session:
        # Active subscriptions breakdown
        active_subs = (
            session.execute(select(Subscription).where(Subscription.status.in_(("active", "trialing")))).scalars().all()
        )

        plan_cache: dict[int, Plan] = {}
        mrr_cents = 0
        for sub in active_subs:
            if sub.plan_id not in plan_cache:
                plan = session.execute(select(Plan).where(Plan.id == sub.plan_id)).scalars().first()
                if plan:
                    plan_cache[sub.plan_id] = plan

            plan = plan_cache.get(sub.plan_id)
            if plan:
                # MRR = main plan (its Razorpay quantity is ALWAYS 1) + the
                # SEPARATE flat seat add-on (extra_seats × per-seat price).
                # operator_quantity holds the TOTAL seat count, so the old
                # `plan_monthly × operator_quantity` double/triple-counted seat
                # revenue, a 3-seat Standard reported ~$144 instead of ~$58
                # (finding K).
                # UNLIMITED (-1) included seats: the plan price already covers
                # every seat, so there is never a billable seat add-on.
                # Subtracting -1 would instead invent one phantom paid seat per
                # subscription (and more once operator_quantity moves).
                included = int(plan.included_operator_seats or 1)
                extra_seats = 0 if included < 0 else max(int(sub.operator_quantity or included) - included, 0)
                mrr_cents += _plan_monthly_usd_cents(plan, sub.billing_cycle)
                if extra_seats:
                    # Finding H3: seats bill the global seat add-on at the canonical
                    # charged price (config.RAZORPAY_SEAT_PLAN_PRICE_CENTS, INR), NOT
                    # a plan's own extra_seat_price_cents. Using the column would
                    # overstate/understate MRR whenever the two drift. Report the
                    # amount actually invoiced.
                    mrr_cents += _to_usd_cents(extra_seats * int(RAZORPAY_SEAT_PLAN_PRICE_CENTS or 0), "INR")

        # Total paid invoices, normalised to USD cents.
        paid_invoices = session.execute(
            select(Invoice.amount_cents, Invoice.currency).where(Invoice.status == "paid")
        ).all()
        total_revenue_cents = sum(_to_usd_cents(amount, currency) for amount, currency in paid_invoices)

        # Subscription status counts
        status_counts = dict(
            session.execute(
                select(Subscription.status, func.count(Subscription.id)).group_by(Subscription.status)
            ).all()
        )

        return {
            "currency": "USD",
            "mrr_cents": mrr_cents,
            "arr_cents": mrr_cents * 12,
            "total_revenue_cents": total_revenue_cents,
            "subscription_counts": {
                "active": status_counts.get("active", 0),
                "trialing": status_counts.get("trialing", 0),
                "past_due": status_counts.get("past_due", 0),
                "canceled": status_counts.get("canceled", 0),
                "paused": status_counts.get("paused", 0),
                "expired": status_counts.get("expired", 0),
            },
            "total_paying_customers": sum(status_counts.get(s, 0) for s in ("active", "past_due")),
        }
