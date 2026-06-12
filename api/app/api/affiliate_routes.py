"""Affiliate program v1 — FastAPI routes (money-free).

Three audiences live in this file:

* **Public** (no auth) — ``/affiliates/validate``, ``/affiliates/click``.
  Used by the marketing site to verify a code and record a click before
  the visitor signs up. Aggressively rate-limited.
* **Affiliate** (auth: ``get_current_affiliate``) — code CRUD + per-affiliate
  stats. Strict X-API-Key only; bot/operator keys cannot reach these.
* **Super admin** (auth: ``get_superadmin``) — invite, list, override,
  deactivate. Same auth gate as the existing super-admin v2 routes.

The route handlers are thin: they delegate every read/write to
``app.services.affiliate_service`` so the same logic is reusable from
workers, tests, and scripts.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator

from app.api.auth import (
    get_current_affiliate,
    get_current_client_strict,
    get_superadmin,
)
from app.api.auth import get_current_client_strict as get_current_client
from app.config import FRONTEND_URL
from app.core.rate_limit import limiter
from app.core.security import get_password_hash
from app.db.models import Affiliate, Client
from app.db.session import get_session
from app.services import affiliate_service
from app.services.affiliate_service import (
    INVITE_TTL_DAYS,
    AffiliateLimitReached,
    AffiliateProgramError,
    AlreadyAffiliate,
    ClientNotFound,
    CodeAlreadyExists,
    CodeLimitReached,
    CodeNotFound,
    CommissionSplitExceedsPool,
    InvalidCodeFormat,
    InviteAlreadyPending,
    InviteAlreadyUsed,
    InviteEmailMismatch,
    InviteExpired,
    InviteNotFound,
    NotAffiliate,
)
from app.services.email_service import (
    send_affiliate_invite_email,
    send_affiliate_welcome_email,
)

logger = logging.getLogger(__name__)


# ─── Routers ────────────────────────────────────────────────────────────
# Two routers in the same module so main.py can mount them with
# different prefixes / tags / dependency stacks.

# Public + affiliate self-service routes live under /affiliates and
# /affiliate. Some are unauthenticated (validate, click), others require
# an active Affiliate principal.
router = APIRouter(tags=["affiliate"])

# Super-admin routes live under /superadmin/affiliates, guarded by the
# same dependency the rest of /superadmin uses.
superadmin_router = APIRouter(
    prefix="/superadmin/affiliates",
    tags=["affiliate", "superadmin"],
    dependencies=[Depends(get_superadmin)],
)


# ─── Pydantic schemas ───────────────────────────────────────────────────


class ValidateCodeResponse(BaseModel):
    valid: bool
    label: str | None = None


class ClickRequest(BaseModel):
    code: str
    referrer: str | None = None


class CreateCodeRequest(BaseModel):
    code: str = Field(..., min_length=3, max_length=20)
    label: str | None = Field(default=None, max_length=120)
    # Per-code split — what the affiliate keeps + what the referred customer
    # gets. Both whole-percent (0–100). Their sum must not exceed the
    # affiliate's pool (enforced server-side). Both default to 0.
    affiliate_commission_pct: float | None = Field(default=None, ge=0, le=100)
    customer_discount_pct: float | None = Field(default=None, ge=0, le=100)

    @field_validator("code")
    @classmethod
    def normalize_code(cls, v: str) -> str:
        return (v or "").strip()


class UpdateCodeRequest(BaseModel):
    # ``code`` (rename) is optional. When present it goes through the same
    # format + uniqueness checks as create_code. Renaming breaks the old
    # ?ref= URL — frontend must warn before sending.
    code: str | None = Field(default=None, min_length=3, max_length=20)
    label: str | None = Field(default=None, max_length=120)
    active: bool | None = None
    affiliate_commission_pct: float | None = Field(default=None, ge=0, le=100)
    customer_discount_pct: float | None = Field(default=None, ge=0, le=100)

    @field_validator("code")
    @classmethod
    def normalize_code(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return v.strip()


class CodeRow(BaseModel):
    id: int
    code: str
    label: str | None
    active: bool
    affiliate_commission_pct: float
    customer_discount_pct: float
    affiliate_commission_bps: int
    customer_discount_bps: int
    clicks: int
    signups: int
    conversion_pct: float | None
    created_at: str | None
    deactivated_at: str | None


class AffiliateStats(BaseModel):
    total_clicks: int
    total_signups: int
    active_codes: int
    max_active_codes: int
    conversion_pct: float | None


class MeResponse(BaseModel):
    id: int
    max_active_codes: int
    # Pool set by the super-admin. Every code this affiliate creates must
    # split within this ceiling. ``commission_pct`` is the human-readable
    # form (basis points / 100).
    commission_pct: float
    commission_bps: int
    created_at: str | None


class InviteAffiliateRequest(BaseModel):
    email: str
    max_active_codes: int | None = Field(default=None, gt=0, le=100)
    # Whole-percent input (0–100). Backend stores as basis points internally.
    # 0 = no commission (the default for v1's money-free path).
    commission_pct: float | None = Field(default=None, ge=0, le=100)

    @field_validator("email")
    @classmethod
    def lower_email(cls, v: str) -> str:
        return (v or "").strip().lower()


class UpdateAffiliateRequest(BaseModel):
    max_active_codes: int | None = Field(default=None, gt=0, le=100)
    # Whole-percent input. None → don't touch the existing value.
    commission_pct: float | None = Field(default=None, ge=0, le=100)
    active: bool | None = None  # True → reactivate, False → deactivate


class AffiliateRow(BaseModel):
    id: int
    client_id: int
    client_email: str | None
    client_name: str | None
    max_active_codes: int
    # Commission shown to UI as a human percent (0–100). Backend stores
    # basis points internally; ``commission_pct`` is just bps/100.
    commission_pct: float
    commission_bps: int
    invited_by: int | None
    active: bool
    created_at: str | None
    deactivated_at: str | None
    total_clicks: int
    total_signups: int
    active_codes: int
    conversion_pct: float | None


class PendingInviteRow(BaseModel):
    id: int
    email: str
    max_active_codes: int
    invited_by: int | None
    expires_at: str | None
    created_at: str | None


class InviteResponse(BaseModel):
    """Discriminated response from POST /superadmin/affiliates.

    ``kind`` selects which of ``affiliate`` or ``invite`` carries the payload:
      * ``"instant"``         → ``affiliate`` is set; recipient was already a Client
      * ``"pending_invite"``  → ``invite`` is set; magic-link email sent
    """

    kind: str
    affiliate: AffiliateRow | None = None
    invite: PendingInviteRow | None = None


class AcceptInviteLookupResponse(BaseModel):
    email: str
    expires_at: str | None


class AcceptInviteRequest(BaseModel):
    token: str
    name: str
    password: str
    company_name: str | None = None
    website: str | None = None

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        v = (v or "").strip()
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters.")
        return v

    @field_validator("password")
    @classmethod
    def strong_password(cls, v: str) -> str:
        # Mirror /auth/register's policy so accept-invite isn't a backdoor
        # for weaker passwords.
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters.")
        if not any(c.isalpha() for c in v):
            raise ValueError("Password must contain at least one letter.")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one number.")
        return v


class AcceptInviteResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    client_id: int
    name: str
    is_affiliate: bool = True


# ─── Error mapper ───────────────────────────────────────────────────────


def _to_http(exc: AffiliateProgramError) -> HTTPException:
    """Map service-layer exceptions to clean HTTP responses."""
    if isinstance(exc, (InvalidCodeFormat, CodeAlreadyExists, CommissionSplitExceedsPool)):
        return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    if isinstance(
        exc,
        (AffiliateLimitReached, CodeLimitReached, AlreadyAffiliate, InviteAlreadyPending),
    ):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    if isinstance(exc, InviteAlreadyUsed):
        # 410 Gone is more accurate than 409 here — the invite resource
        # existed but its valid lifecycle window is over.
        return HTTPException(status_code=status.HTTP_410_GONE, detail=str(exc))
    if isinstance(exc, InviteExpired):
        return HTTPException(status_code=status.HTTP_410_GONE, detail=str(exc))
    if isinstance(exc, InviteEmailMismatch):
        # 403 — the principal is authenticated but not authorised for this
        # specific token. UI uses the distinct status to render targeted
        # "this invite is for X — sign in with that email" copy.
        return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    if isinstance(exc, (ClientNotFound, CodeNotFound, NotAffiliate, InviteNotFound)):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


def _client_ip(request: Request) -> str | None:
    """Best-effort client IP — respects X-Forwarded-For when behind nginx."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        # First entry is the original client; the rest are proxies.
        return fwd.split(",")[0].strip() or None
    if request.client:
        return request.client.host
    return None


# ─── Public (no auth) ───────────────────────────────────────────────────


@router.get("/affiliates/validate", response_model=ValidateCodeResponse)
@limiter.limit("60/minute")
def validate_code(request: Request, code: str):
    """Check whether ``code`` is a valid + active referral code.

    Aggressively rate-limited (60/min/IP) so the endpoint cannot be used
    to enumerate the code namespace. Always returns 200 with
    ``{valid: bool}`` — using HTTP status to leak validity would defeat
    the rate-limit defense.
    """
    with get_session() as session:
        row = affiliate_service.validate_code(session, code)
        if row is None:
            return ValidateCodeResponse(valid=False)
        return ValidateCodeResponse(valid=True, label=row.label)


@router.post(
    "/affiliates/click",
    status_code=status.HTTP_204_NO_CONTENT,
)
@limiter.limit("120/minute")
def record_click(request: Request, body: ClickRequest):
    """Record a click on a referral link.

    Fire-and-forget from the client perspective — we always return 204,
    even for invalid codes, so the caller cannot time-attack to enumerate
    valid codes. The body's IP and User-Agent are extracted from the
    request headers (not the body) so callers cannot spoof them.
    """
    with get_session() as session:
        ip = _client_ip(request)
        ua = request.headers.get("user-agent")
        try:
            affiliate_service.record_click(
                session,
                body.code,
                ip=ip,
                user_agent=ua,
                referrer=body.referrer,
            )
            session.commit()
        except Exception as e:
            # Never propagate — click recording must not affect UX.
            logger.warning("affiliate_click_record_failed", extra={"error": str(e)})
    return None


# ─── Customer-side: apply a referral code at checkout ───────────────────


class ApplyReferralRequest(BaseModel):
    code: str = Field(..., min_length=3, max_length=20)

    @field_validator("code")
    @classmethod
    def normalize_code(cls, v: str) -> str:
        return (v or "").strip().upper()


class ApplyReferralResponse(BaseModel):
    attributed: bool
    # Human-readable message surfaced directly in the UI toast.
    message: str
    # Normalized code (uppercased) — surfaced back so the UI can render an
    # "Applied: CODE" badge from a single source of truth.
    code: str | None = None
    # Customer-facing discount percentage (0–100). Present for both freshly-
    # attributed and previously-attributed valid codes so the modal can
    # render the strikethrough/new-price UX regardless of when attribution
    # happened.
    discount_pct: float = 0.0


@router.post("/affiliate/apply-referral", response_model=ApplyReferralResponse)
def apply_referral(
    body: ApplyReferralRequest,
    client: Client = Depends(get_current_client),
):
    """Apply a referral code for the currently-authenticated customer.

    Called from the checkout modal when the user enters a referral code before
    buying a plan or top-up. Delegates to ``attribute_signup`` which enforces
    first-touch wins and self-referral prevention — idempotent, never blocks.

    Returns ``{ attributed, code, discount_pct }``:
      * ``attributed=true`` — freshly attributed on this call.
      * ``attributed=false`` with non-null ``code`` and ``discount_pct`` — the
        account was already attributed to this same code; UX should still
        show the discount applied (idempotent re-entry by the same user).
      * ``attributed=false`` with ``code=None`` — invalid code OR account
        is already attributed to a *different* code (collision).
    Always returns 200 so checkout is never blocked.
    """
    with get_session() as session:
        attributed = affiliate_service.attribute_signup(session, client.id, body.code)
        if attributed:
            session.commit()

    with get_session() as session:
        code_row = affiliate_service.validate_code(session, body.code)

    if attributed and code_row is not None:
        return ApplyReferralResponse(
            attributed=True,
            message=f"Referral code {body.code} applied — thank you!",
            code=code_row.code,
            discount_pct=affiliate_service.bps_to_pct(code_row.customer_discount_bps),
        )

    if code_row is None:
        return ApplyReferralResponse(
            attributed=False,
            message=f"'{body.code}' is not a valid referral code.",
        )

    # Valid code but not attributed this call — either previously attributed
    # to the same code (idempotent — surface the discount), or attributed to
    # a different code (collision — withhold the discount).
    with get_session() as session:
        existing = session.query(Client.referral_code_id).filter(Client.id == client.id).first()
    if existing and existing[0] == code_row.id:
        return ApplyReferralResponse(
            attributed=False,
            message=f"Referral code {code_row.code} already applied — discount stays on.",
            code=code_row.code,
            discount_pct=affiliate_service.bps_to_pct(code_row.customer_discount_bps),
        )
    return ApplyReferralResponse(
        attributed=False,
        message="Your account already has a different referral code applied.",
    )


# ─── Affiliate self-service ─────────────────────────────────────────────


@router.get("/affiliate/me", response_model=MeResponse)
def get_me(affiliate: Affiliate = Depends(get_current_affiliate)):
    return MeResponse(
        id=affiliate.id,
        max_active_codes=affiliate.max_active_codes,
        commission_bps=affiliate.commission_bps or 0,
        commission_pct=affiliate_service.bps_to_pct(affiliate.commission_bps or 0),
        created_at=affiliate.created_at.isoformat() if affiliate.created_at else None,
    )


@router.get("/affiliate/codes", response_model=list[CodeRow])
def list_my_codes(affiliate: Affiliate = Depends(get_current_affiliate)):
    with get_session() as session:
        return affiliate_service.list_codes_with_stats(session, affiliate.id)


class ReferralPricing(BaseModel):
    """Dollar-amount split for a single referred customer's monthly bill.

    Cents are the minor unit of ``currency``. Values are 0 when the customer
    has no paid subscription yet (Free tier, never converted, or paused).
    """

    plan_slug: str
    currency: str
    full_price_cents: int
    paid_cents: int  # what the customer actually pays after discount
    affiliate_earns_cents: int  # what the affiliate gets per month
    customer_saved_cents: int  # the discount amount
    # Super-admin only — what stays with the platform after both shares.
    platform_cents: int | None = None


class ReferralRow(BaseModel):
    client_id: int
    name: str | None
    email: str  # masked for affiliate, full for super admin
    attributed_at: str | None
    pricing: ReferralPricing


class CommissionBreakdown(BaseModel):
    pool_pct: float | None
    affiliate_pct: float | None
    customer_discount_pct: float | None
    code_unused_pool_pct: float | None
    # Only populated for the super-admin route — the affiliate must never see
    # the platform's revenue cut.
    platform_pct: float | None = None


class PricingDistribution(BaseModel):
    """Aggregate monthly $ rolled up across every paying referral.

    Lets the affiliate see "your code is pulling ~$X/mo from N customers"
    at a glance without summing the per-row cards by eye.
    """

    currency: str | None
    paying_referrals: int
    monthly_total_cents: int  # total customer payments before discount
    monthly_affiliate_cents: int  # affiliate's total monthly earnings
    monthly_customer_saved_cents: int  # total discount paid out to customers
    # Super-admin only.
    monthly_platform_cents: int | None = None


class CodeReferralsResponse(BaseModel):
    code: str
    breakdown: CommissionBreakdown
    distribution: PricingDistribution
    referrals: list[ReferralRow]


@router.get("/affiliate/codes/{code_id}/referrals", response_model=CodeReferralsResponse)
def list_my_code_referrals(
    code_id: int,
    affiliate: Affiliate = Depends(get_current_affiliate),
):
    """List the customers who signed up via one of this affiliate's codes.

    Authorisation: the code must belong to the calling affiliate. We return
    404 (not 403) when the code exists but is owned by someone else so an
    affiliate can't probe the global code namespace.
    """
    with get_session() as session:
        pair = affiliate_service.get_code_with_owner(session, code_id)
        if pair is None or pair[0].affiliate_id != affiliate.id:
            raise HTTPException(status_code=404, detail="Code not found.")
        return affiliate_service.list_code_referrals(session, code_id, include_platform=False)


@router.post(
    "/affiliate/codes",
    response_model=CodeRow,
    status_code=status.HTTP_201_CREATED,
)
def create_my_code(
    body: CreateCodeRequest,
    affiliate: Affiliate = Depends(get_current_affiliate),
):
    with get_session() as session:
        try:
            row = affiliate_service.create_code(
                session,
                affiliate,
                body.code,
                body.label,
                affiliate_commission_bps=affiliate_service.pct_to_bps(body.affiliate_commission_pct) or 0,
                customer_discount_bps=affiliate_service.pct_to_bps(body.customer_discount_pct) or 0,
            )
            session.commit()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        except AffiliateProgramError as e:
            raise _to_http(e) from e
        # Return a stats row for consistency with the list endpoint.
        return {
            "id": row.id,
            "code": str(row.code),
            "label": row.label,
            "active": row.active,
            "affiliate_commission_bps": row.affiliate_commission_bps,
            "customer_discount_bps": row.customer_discount_bps,
            "affiliate_commission_pct": affiliate_service.bps_to_pct(row.affiliate_commission_bps),
            "customer_discount_pct": affiliate_service.bps_to_pct(row.customer_discount_bps),
            "clicks": 0,
            "signups": 0,
            "conversion_pct": None,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "deactivated_at": None,
        }


@router.patch("/affiliate/codes/{code_id}", response_model=CodeRow)
def update_my_code(
    code_id: int,
    body: UpdateCodeRequest,
    affiliate: Affiliate = Depends(get_current_affiliate),
):
    with get_session() as session:
        try:
            affiliate_service.update_code(
                session,
                affiliate,
                code_id,
                code=body.code,
                label=body.label,
                active=body.active,
                affiliate_commission_bps=(
                    affiliate_service.pct_to_bps(body.affiliate_commission_pct)
                    if body.affiliate_commission_pct is not None
                    else None
                ),
                customer_discount_bps=(
                    affiliate_service.pct_to_bps(body.customer_discount_pct)
                    if body.customer_discount_pct is not None
                    else None
                ),
            )
            session.commit()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        except AffiliateProgramError as e:
            raise _to_http(e) from e
        # Re-fetch with stats so the UI gets a fresh, accurate row.
        codes = affiliate_service.list_codes_with_stats(session, affiliate.id)
        match = next((c for c in codes if c["id"] == code_id), None)
        if match is None:
            raise HTTPException(status_code=404, detail="Code not found after update.")
        return match


@router.get("/affiliate/stats", response_model=AffiliateStats)
def get_my_stats(affiliate: Affiliate = Depends(get_current_affiliate)):
    with get_session() as session:
        return affiliate_service.get_affiliate_stats(session, affiliate.id)


# ─── Super-admin ────────────────────────────────────────────────────────


@superadmin_router.get("", response_model=list[AffiliateRow])
def list_all_affiliates():
    with get_session() as session:
        return affiliate_service.list_affiliates(session)


@superadmin_router.post(
    "",
    response_model=InviteResponse,
    status_code=status.HTTP_201_CREATED,
)
def invite(
    body: InviteAffiliateRequest,
    admin: Client = Depends(get_current_client_strict),
):
    """Invite anyone to the affiliate program — existing customer or stranger.

    Two paths, selected automatically by the service:

    * **Existing customer**: creates the ``Affiliate`` row immediately and
      fires a welcome email pointing at ``/affiliate``. Response
      ``kind == "instant"``.
    * **Stranger**: creates an ``AffiliateInvite`` row + raw token, and
      fires a magic-link email pointing at ``/affiliate-invite?token=...``.
      Response ``kind == "pending_invite"``. The raw token is never
      returned to the caller (super admin) — only embedded in the email,
      so a compromised admin session can't replay invites.

    The 5-seat cap is enforced at invite time AND again at accept time —
    a long-running pending invite can't sneak past the cap.
    """
    with get_session() as session:
        try:
            # Whole-percent input → basis points for the service layer.
            commission_bps = affiliate_service.pct_to_bps(body.commission_pct) or 0
            result = affiliate_service.invite_affiliate(
                session,
                email=body.email,
                invited_by_client_id=admin.id,
                max_active_codes=body.max_active_codes or affiliate_service.DEFAULT_MAX_ACTIVE_CODES,
                commission_bps=commission_bps,
            )
            session.commit()
        except ValueError as e:
            # pct_to_bps rejects out-of-range inputs (Pydantic also gates,
            # so this is belt-and-suspenders).
            raise HTTPException(status_code=400, detail=str(e)) from e
        except AffiliateProgramError as e:
            raise _to_http(e) from e

        if result["kind"] == "instant":
            aff = result["affiliate"]
            # Fire the welcome email after commit — never block the response
            # on Brevo. send_email_async is itself non-blocking but the
            # commit MUST land first so the affiliate row exists by the time
            # the recipient clicks through.
            client = session.get(Client, aff.client_id)
            try:
                send_affiliate_welcome_email(client.email, client.name if client else None)
            except Exception as e:
                logger.warning("affiliate_welcome_email_failed: %s", e)
            return InviteResponse(kind="instant", affiliate=_affiliate_row(session, aff.id))

        # pending_invite — magic-link path
        invite_row = result["invite"]
        raw_token = result["raw_token"]
        # New URL — landing page handles both sign-in and sign-up branches
        # based on whether the recipient already has an account. The old
        # ``/affiliate-accept`` path is kept as a redirect for any email
        # delivered before the cut-over.
        accept_url = f"{FRONTEND_URL.rstrip('/')}/affiliate-invite?token={raw_token}"
        try:
            send_affiliate_invite_email(
                invite_row.email,
                accept_url,
                expires_in_days=INVITE_TTL_DAYS,
            )
        except Exception as e:
            logger.warning("affiliate_invite_email_failed: %s", e)
        return InviteResponse(
            kind="pending_invite",
            invite=PendingInviteRow(
                id=invite_row.id,
                email=invite_row.email,
                max_active_codes=invite_row.max_active_codes,
                invited_by=invite_row.invited_by,
                expires_at=invite_row.expires_at.isoformat() if invite_row.expires_at else None,
                created_at=invite_row.created_at.isoformat() if invite_row.created_at else None,
            ),
        )


# ─── Super-admin: pending invites management ────────────────────────────


@superadmin_router.get("/invites", response_model=list[PendingInviteRow])
def list_invites():
    """List pending (un-accepted, un-revoked, un-expired) magic-link invites."""
    with get_session() as session:
        return affiliate_service.list_pending_invites(session)


@superadmin_router.delete(
    "/invites/{invite_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def revoke(invite_id: int):
    """Revoke a pending invite — its token can no longer be used to onboard."""
    with get_session() as session:
        try:
            affiliate_service.revoke_invite(session, invite_id)
            session.commit()
        except AffiliateProgramError as e:
            raise _to_http(e) from e
    return None


# ─── Public — magic-link acceptance ─────────────────────────────────────


@router.get("/affiliate-invites/lookup", response_model=AcceptInviteLookupResponse)
@limiter.limit("30/minute")
def lookup_invite(request: Request, token: str):
    """Resolve a magic-link token to its target email + expiry.

    Called by the ``/affiliate-invite`` landing page before deciding which
    branch to render — the recipient sees their invited email + expiry
    deadline, and (when logged in) the page auto-fires accept-existing.
    Rate-limited to slow token enumeration. Returns 404/410 for invalid /
    used / expired tokens.
    """
    with get_session() as session:
        try:
            invite = affiliate_service.lookup_invite_by_token(session, token)
        except AffiliateProgramError as e:
            raise _to_http(e) from e
        return AcceptInviteLookupResponse(
            email=invite.email,
            expires_at=invite.expires_at.isoformat() if invite.expires_at else None,
        )


@router.post("/affiliate-invites/accept", response_model=AcceptInviteResponse)
@limiter.limit("10/minute")
def accept_invite(request: Request, body: AcceptInviteRequest):
    """Accept a magic-link invite — atomically create Client + Affiliate.

    Rate-limited (10/min/IP) on top of the token's natural one-shot
    constraint. On success, returns the same shape as /auth/register so
    the admin app can store the api_key and route the user straight to
    /affiliate without a separate login round-trip.
    """
    import uuid

    with get_session() as session:
        try:
            client, _affiliate = affiliate_service.accept_invite(
                session,
                body.token,
                name=body.name,
                password_hash=get_password_hash(body.password),
                api_key=uuid.uuid4().hex,
                company_name=body.company_name,
                website=body.website,
            )
            session.commit()
        except AffiliateProgramError as e:
            raise _to_http(e) from e

        # Best-effort welcome email — same content as the existing-customer
        # path, so newly-accepted invitees get the "open my dashboard" CTA
        # right after onboarding.
        try:
            send_affiliate_welcome_email(client.email, client.name)
        except Exception as e:
            logger.warning("affiliate_welcome_email_failed_after_accept: %s", e)

        return AcceptInviteResponse(
            access_token=client.api_key,
            client_id=client.id,
            name=client.name,
            is_affiliate=True,
        )


class AcceptInviteForExistingRequest(BaseModel):
    token: str


class AcceptInviteForExistingResponse(BaseModel):
    is_affiliate: bool = True
    message: str


@router.post(
    "/affiliate-invites/accept-existing",
    response_model=AcceptInviteForExistingResponse,
)
@limiter.limit("10/minute")
def accept_invite_existing(
    request: Request,
    body: AcceptInviteForExistingRequest,
    client: Client = Depends(get_current_client),
):
    """Accept an invite while already signed in as an OyeChats client.

    The other accept endpoint creates a brand-new Client+Affiliate pair —
    this one wires an Affiliate row to the client who's already
    authenticated. Used by the unified `/affiliate-invite` landing page
    when the recipient already has an account.

    Status codes:
      * 200 — affiliate row created, fire the welcome email
      * 403 — token's email doesn't match the logged-in client
      * 404 — token doesn't exist
      * 409 — client is already an active affiliate
      * 410 — token expired or already used
    """
    with get_session() as session:
        try:
            # Re-load client into this session — the Depends gives us a
            # detached row from the auth check.
            db_client = session.get(Client, client.id)
            if db_client is None:
                raise HTTPException(status_code=404, detail="Client not found.")
            affiliate_service.accept_invite_for_existing_client(session, body.token, db_client)
            session.commit()
        except AffiliateProgramError as e:
            raise _to_http(e) from e

        try:
            send_affiliate_welcome_email(client.email, client.name)
        except Exception as e:
            logger.warning("affiliate_welcome_email_failed_after_accept_existing: %s", e)

        return AcceptInviteForExistingResponse(
            message=f"Welcome to OyeChats Partners, {client.name or 'friend'}!",
        )


@superadmin_router.get("/{affiliate_id}")
def get_affiliate_detail(affiliate_id: int):
    """Detail bundle: affiliate meta + their codes + aggregate stats."""
    with get_session() as session:
        try:
            return affiliate_service.get_affiliate_detail(session, affiliate_id)
        except AffiliateProgramError as e:
            raise _to_http(e) from e


@superadmin_router.get(
    "/{affiliate_id}/codes/{code_id}/referrals",
    response_model=CodeReferralsResponse,
)
def list_code_referrals_super(affiliate_id: int, code_id: int):
    """Same shape as the affiliate-scoped route, but with PII unmasked and
    the platform commission slice populated. Auth gate is the router-level
    ``get_superadmin`` dependency.

    Returns 404 when ``code_id`` doesn't exist OR isn't owned by
    ``affiliate_id`` — the latter is a 404 (not 403) so the global code
    namespace isn't probeable by URL-walking.
    """
    with get_session() as session:
        pair = affiliate_service.get_code_with_owner(session, code_id)
        if pair is None or pair[0].affiliate_id != affiliate_id:
            raise HTTPException(status_code=404, detail="Code not found.")
        return affiliate_service.list_code_referrals(session, code_id, include_platform=True)


@superadmin_router.patch("/{affiliate_id}", response_model=AffiliateRow)
def update_affiliate_route(affiliate_id: int, body: UpdateAffiliateRequest):
    """Override caps or toggle the affiliate's active status."""
    deactivate = None
    if body.active is True:
        deactivate = False  # reactivate
    elif body.active is False:
        deactivate = True

    with get_session() as session:
        try:
            commission_bps = affiliate_service.pct_to_bps(body.commission_pct)
            affiliate_service.update_affiliate(
                session,
                affiliate_id,
                max_active_codes=body.max_active_codes,
                commission_bps=commission_bps,
                deactivate=deactivate,
            )
            session.commit()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        except AffiliateProgramError as e:
            raise _to_http(e) from e
        return _affiliate_row(session, affiliate_id)


@superadmin_router.delete(
    "/{affiliate_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_affiliate_route(affiliate_id: int):
    """Hard-delete an affiliate, all their codes, and the click history.

    Referred clients survive — their ``referral_code_id`` becomes NULL via
    the FK's ``ON DELETE SET NULL``. Historical attribution is irreversibly
    lost from those client rows. This is a destructive operation by design
    — the super-admin UI requires an explicit two-step confirm before it
    fires.
    """
    with get_session() as session:
        try:
            affiliate_service.delete_affiliate(session, affiliate_id)
            session.commit()
        except AffiliateProgramError as e:
            raise _to_http(e) from e
    return None


# ─── helpers ────────────────────────────────────────────────────────────


def _affiliate_row(session, affiliate_id: int) -> dict:
    """Return the same shape as ``list_affiliates`` for a single affiliate."""
    rows = affiliate_service.list_affiliates(session)
    match = next((r for r in rows if r["id"] == affiliate_id), None)
    if match is None:
        raise HTTPException(status_code=404, detail="Affiliate not found.")
    return match
