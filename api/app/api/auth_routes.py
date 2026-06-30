import hmac
import logging
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select

from app.api.auth import get_current_client_or_operator, get_current_operator
from app.core.dates import trial_days_remaining
from app.core.rate_limit import limiter
from app.core.security import get_password_hash, verify_password
from app.db.models import Bot, ChatSession, Client, Document, Operator
from app.db.session import get_session
from app.services.email_service import send_password_reset_email

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


def _redact_email(email: str) -> str:
    """Mask an email address for safe logging (e.g. 'j***@example.com')."""
    if not email or "@" not in email:
        return "***"
    local, domain = email.rsplit("@", 1)
    return f"{local[0]}***@{domain}" if local else f"***@{domain}"


def _sanitize_for_log(value: str) -> str:
    """Strip CRLF sequences to prevent log injection attacks."""
    return value.replace("\r", "").replace("\n", "")


def _normalize_workspace_stats(
    client_ids: set[int], workspace_stats: dict[int, dict[str, int]] | None
) -> dict[int, dict[str, int]]:
    """Ensure every candidate client has a complete zero-filled stats record."""
    normalized = {
        client_id: {
            "bot_count": 0,
            "operator_count": 0,
            "website_bot_count": 0,
            "document_count": 0,
            "session_count": 0,
        }
        for client_id in client_ids
    }
    if not workspace_stats:
        return normalized

    for client_id, stats in workspace_stats.items():
        base = normalized.setdefault(
            client_id,
            {
                "bot_count": 0,
                "operator_count": 0,
                "website_bot_count": 0,
                "document_count": 0,
                "session_count": 0,
            },
        )
        base.update({key: int(value or 0) for key, value in stats.items()})

    return normalized


def _build_workspace_stats(session, client_ids: set[int]) -> dict[int, dict[str, int]]:
    """Collect signals that indicate which duplicate-email workspace is actually in use."""
    stats = _normalize_workspace_stats(client_ids, None)
    if not client_ids:
        return stats

    bot_rows = session.execute(
        select(Bot.id, Bot.client_id, Bot.website).where(Bot.client_id.in_(client_ids), Bot.is_active.is_(True))
    ).all()

    bot_client_lookup: dict[int, int] = {}
    for bot_id, client_id, website in bot_rows:
        bot_client_lookup[bot_id] = client_id
        stats[client_id]["bot_count"] += 1
        if website and website.strip():
            stats[client_id]["website_bot_count"] += 1

    operator_count_rows = session.execute(
        select(Operator.client_id, func.count(Operator.id))
        .where(Operator.client_id.in_(client_ids))
        .group_by(Operator.client_id)
    ).all()
    for client_id, count in operator_count_rows:
        stats[client_id]["operator_count"] = int(count or 0)

    if not bot_client_lookup:
        return stats

    bot_ids = list(bot_client_lookup.keys())

    document_count_rows = session.execute(
        select(Document.bot_id, func.count(Document.id)).where(Document.bot_id.in_(bot_ids)).group_by(Document.bot_id)
    ).all()
    for bot_id, count in document_count_rows:
        stats[bot_client_lookup[bot_id]]["document_count"] += int(count or 0)

    session_count_rows = session.execute(
        select(ChatSession.bot_id, func.count(ChatSession.id))
        .where(ChatSession.bot_id.in_(bot_ids))
        .group_by(ChatSession.bot_id)
    ).all()
    for bot_id, count in session_count_rows:
        stats[bot_client_lookup[bot_id]]["session_count"] += int(count or 0)

    return stats


def _workspace_connection_score(workspace_stats: dict[str, int]) -> tuple:
    """Rank workspaces by how likely they are to be the real connected customer workspace."""
    website_bot_count = workspace_stats.get("website_bot_count", 0)
    session_count = workspace_stats.get("session_count", 0)
    document_count = workspace_stats.get("document_count", 0)
    bot_count = workspace_stats.get("bot_count", 0)
    agent_count = workspace_stats.get("operator_count", 0)
    has_connected_bot = website_bot_count > 0 or session_count > 0 or document_count > 0

    return (
        has_connected_bot,
        website_bot_count > 0,
        session_count > 0,
        website_bot_count,
        session_count,
        document_count,
        bot_count,
        agent_count,
    )


def _operator_login_score(
    operator: Operator, workspace_stats: dict[int, dict[str, int]] | None = None, **legacy_stats
) -> tuple:
    """Prefer the workspace with the strongest evidence of a real linked bot setup."""
    client_ids = {operator.client_id}
    if workspace_stats is None:
        workspace_stats = _normalize_workspace_stats(client_ids, legacy_stats)
    else:
        workspace_stats = _normalize_workspace_stats(client_ids, workspace_stats)

    connection_score = _workspace_connection_score(workspace_stats.get(operator.client_id, {}))
    created_at = operator.created_at or datetime.min.replace(tzinfo=UTC)
    return (*connection_score, created_at, operator.id)


def _choose_best_operator_candidate(
    candidates: list[Operator], workspace_stats: dict[int, dict[str, int]] | None = None, **legacy_stats
) -> Operator:
    client_ids = {operator.client_id for operator in candidates}
    if workspace_stats is None:
        workspace_stats = _normalize_workspace_stats(client_ids, legacy_stats)
    else:
        workspace_stats = _normalize_workspace_stats(client_ids, workspace_stats)

    return max(candidates, key=lambda operator: _operator_login_score(operator, workspace_stats))


def _choose_default_workspace_bot(bots: list[Bot], bot_activity: dict[int, dict[str, int]] | None = None) -> Bot | None:
    """Choose the bot that best represents the workspace's existing linked setup."""
    if not bots:
        return None

    bot_activity = bot_activity or {}

    def score(bot: Bot) -> tuple:
        activity = bot_activity.get(bot.id, {})
        website_present = bool(bot.website and bot.website.strip())
        session_count = int(activity.get("session_count", 0) or 0)
        document_count = int(activity.get("document_count", 0) or 0)
        created_at = bot.created_at or datetime.min.replace(tzinfo=UTC)
        return (
            website_present,
            session_count > 0,
            document_count > 0,
            session_count,
            document_count,
            created_at,
            bot.id,
        )

    return max(bots, key=score)


def _get_default_workspace_bot(session, client_id: int) -> Bot | None:
    """Fetch the best default bot to hydrate immediately after operator login."""
    bots = (
        session.execute(
            select(Bot)
            .where(Bot.client_id == client_id, Bot.is_active.is_(True))
            .order_by(Bot.created_at.asc(), Bot.id.asc())
        )
        .scalars()
        .all()
    )
    if not bots:
        return None

    bot_ids = [bot.id for bot in bots]
    bot_activity: dict[int, dict[str, int]] = {bot.id: {"document_count": 0, "session_count": 0} for bot in bots}

    document_rows = session.execute(
        select(Document.bot_id, func.count(Document.id)).where(Document.bot_id.in_(bot_ids)).group_by(Document.bot_id)
    ).all()
    for bot_id, count in document_rows:
        bot_activity[bot_id]["document_count"] = int(count or 0)

    session_rows = session.execute(
        select(ChatSession.bot_id, func.count(ChatSession.id))
        .where(ChatSession.bot_id.in_(bot_ids))
        .group_by(ChatSession.bot_id)
    ).all()
    for bot_id, count in session_rows:
        bot_activity[bot_id]["session_count"] = int(count or 0)

    return _choose_default_workspace_bot(bots, bot_activity)


# ── Request / Response Models ──


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    client_id: int
    name: str
    is_superadmin: bool
    is_verified: bool = True
    company_name: str | None = None
    website: str | None = None


class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str
    company_name: str | None = None
    website: str | None = None
    # Optional affiliate referral code captured from the ``?ref=`` cookie at
    # signup. Silent on invalid/self-referral — registration must never fail
    # because of a referral problem.
    referral_code: str | None = None

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v):
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters.")
        return v

    @field_validator("email")
    @classmethod
    def valid_email(cls, v):
        v = v.strip().lower()
        pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
        if not re.match(pattern, v):
            raise ValueError("Please enter a valid email address.")
        return v

    @field_validator("password")
    @classmethod
    def strong_password(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters.")
        if not re.search(r"[A-Za-z]", v):
            raise ValueError("Password must contain at least one letter.")
        if not re.search(r"[0-9]", v):
            raise ValueError("Password must contain at least one number.")
        return v


class TrialStatePayload(BaseModel):
    """Subset of subscription state the dashboard needs to render the trial banner.

    Always populated for clients that landed on a trialing subscription at
    signup; ``None`` for accounts created without a trial (super-admin
    seeded, legacy free-tier, etc). The admin app treats ``None`` as
    "no trial UI" rather than zero-day urgency.
    """

    status: str  # "trialing" | "trial_expired" | "active" | ...
    trial_end_at: str | None = None  # ISO-8601, UTC
    days_remaining: int | None = None  # ceil((trial_end - now) / 1 day), 0 once lapsed
    credits_granted: int | None = None


class RegisterResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    client_id: int
    name: str
    is_superadmin: bool = False
    company_name: str | None = None
    website: str | None = None
    message: str = "Account created successfully."
    trial: TrialStatePayload | None = None


class CurrentUserResponse(BaseModel):
    """Profile payload for the authenticated principal (TopBar profile dropdown).

    Works for both clients (admins) and operators. The ``kind`` discriminator
    tells the UI which fields are meaningful — operators don't own bots
    directly, so ``bot_count`` reflects the bots in their workspace (the
    client they belong to). For clients ``role`` is None; for operators
    ``role`` is one of ``owner | admin | operator``.

    Exposes only the small set of profile fields the admin app needs to
    render the user menu — never sensitive data (no api_key, no password
    hash).
    """

    id: int
    kind: str  # "client" | "operator"
    name: str
    email: str
    company_name: str | None = None
    website: str | None = None
    created_at: str
    bot_count: int
    is_superadmin: bool = False
    is_online: bool = False
    role: str | None = None  # operator role; None for clients
    # Affiliate-program membership — derived from the affiliates table.
    # ``True`` only when an active (non-deactivated) row exists for the
    # current client; always ``False`` for operators (they're a different
    # principal type and can't be affiliates themselves).
    is_affiliate: bool = False
    affiliate_id: int | None = None
    # ``True`` for affiliates who are NOT also customers — i.e. they came
    # in via the magic-link onboarding and never created a bot. The admin
    # app uses this to render the dedicated AffiliateLayout instead of the
    # full customer dashboard. ``False`` for customer-affiliates so they
    # still get the customer UI with an "Affiliate" entry point.
    is_affiliate_only: bool = False
    # Trial snapshot for the dashboard's persistent banner. ``None`` for
    # operators (the trial belongs to the workspace owner) and for clients
    # whose subscription has never been in a trial state.
    trial: TrialStatePayload | None = None


@router.get("/me/entitlements")
def get_my_entitlements(auth: dict = Depends(get_current_client_or_operator)):
    """Return the resolved plan entitlements for the authenticated workspace.

    Used by the admin app's ``useEntitlements`` hook to drive every feature
    gate, limit display, and upgrade prompt without each component
    re-fetching the plan. Operators see the entitlements of the client
    they belong to — that's the workspace they're acting in, not their
    own (operators don't have personal subscriptions).

    Response shape mirrors ``PlanEntitlements.to_json_dict()`` plus a small
    set of derived booleans the UI uses heavily.
    """
    from app.services.plan_entitlements_service import get_entitlements

    client_id = auth["client_id"]
    with get_session() as session:
        entitlements = get_entitlements(client_id, session, include_usage=True)

    payload = entitlements.to_json_dict()
    # Derived helpers — saves the frontend a handful of conditionals.
    payload["is_free"] = entitlements.plan_slug == "free"
    payload["is_enterprise"] = entitlements.plan_slug == "enterprise"
    payload["topup_allowed"] = entitlements.has_feature("topup_allowed")
    return payload


@router.get("/me", response_model=CurrentUserResponse)
def get_current_user_endpoint(auth: dict = Depends(get_current_client_or_operator)):
    """Return the authenticated principal's profile + workspace bot count.

    Used by the admin TopBar to populate the user-menu dropdown (email,
    joining date, bots). Accepts BOTH ``X-API-Key`` (clients) and
    ``X-Operator-Key`` (operators) so the dropdown works regardless of how
    the user logged in. For an operator, ``bot_count`` is the count of bots
    in their workspace (the client they belong to) — that's what the user
    expects to see for the "X bots" line, not zero.
    """
    with get_session() as session:
        client_id = auth["client_id"]
        bot_count = session.execute(select(func.count(Bot.id)).where(Bot.client_id == client_id)).scalar_one()

        if auth["type"] == "operator":
            operator: Operator = auth["entity"]
            # Pull the operator's workspace owner (the client they belong to)
            # so we can surface company_name / website if the UI wants them.
            owner_client = session.get(Client, client_id)
            return CurrentUserResponse(
                id=operator.id,
                kind="operator",
                name=operator.name,
                email=operator.email,
                company_name=owner_client.company_name if owner_client else None,
                website=owner_client.website if owner_client else None,
                created_at=operator.created_at.isoformat() if operator.created_at else "",
                bot_count=int(bot_count or 0),
                is_superadmin=False,
                is_online=bool(operator.is_online),
                role=operator.role,
            )

        client: Client = auth["entity"]
        # Look up an active affiliate row for this client. Single query, no
        # join needed thanks to the unique index on affiliates.client_id.
        from app.db.models import Affiliate

        affiliate_row = (
            session.execute(
                select(Affiliate).where(
                    Affiliate.client_id == client.id,
                    Affiliate.deactivated_at.is_(None),
                )
            )
            .scalars()
            .first()
        )

        # Look up owner operator record to get online status
        operator_row = session.execute(
            select(Operator).where(Operator.client_id == client.id, Operator.role == "owner").limit(1)
        ).scalar_one_or_none()
        is_online = operator_row.is_online if operator_row else False

        # Resolve the trial snapshot in the same transaction. ``None`` for
        # paid customers and seeded superadmins; the dashboard treats that
        # as "no trial UI". For ``trial_expired`` we still return the
        # payload so the banner can prompt for reactivation.
        trial_payload = _build_trial_payload(session, client.id)

        return CurrentUserResponse(
            id=client.id,
            kind="client",
            name=client.name,
            email=client.email,
            company_name=client.company_name,
            website=client.website,
            created_at=client.created_at.isoformat() if client.created_at else "",
            bot_count=int(bot_count or 0),
            is_superadmin=bool(client.is_superadmin),
            is_online=bool(is_online),
            role=None,
            is_affiliate=affiliate_row is not None,
            affiliate_id=affiliate_row.id if affiliate_row else None,
            # Affiliate-only = active affiliate with zero bots and not a
            # superadmin. The moment they create their first bot, they
            # graduate to the full customer experience automatically.
            is_affiliate_only=(
                affiliate_row is not None and int(bot_count or 0) == 0 and not bool(client.is_superadmin)
            ),
            trial=trial_payload,
        )


def _build_trial_payload(session, client_id: int) -> "TrialStatePayload | None":
    """Resolve the dashboard's trial snapshot for a client.

    Returns ``None`` when the client has no current subscription or the
    subscription has never been in a trial state. The dashboard uses
    ``None`` as "hide the trial banner entirely". For ``trialing`` and
    ``trial_expired`` we always return a payload so the UI can render the
    countdown or the reactivation prompt respectively.
    """
    from datetime import UTC

    from app.db.models import Subscription

    sub = (
        session.execute(
            select(Subscription)
            .where(
                Subscription.client_id == client_id,
                Subscription.status.in_(("trialing", "trial_expired")),
            )
            .order_by(Subscription.created_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if sub is None:
        return None

    trial_end = sub.trial_end
    days_remaining: int | None = None
    end_iso: str | None = None
    if trial_end is not None:
        if trial_end.tzinfo is None:
            trial_end = trial_end.replace(tzinfo=UTC)
        end_iso = trial_end.isoformat()
        days_remaining = trial_days_remaining(trial_end) if sub.status == "trialing" else 0

    plan = sub.plan
    credits_granted = int(plan.credits_per_month or 0) if plan else None

    return TrialStatePayload(
        status=sub.status,
        trial_end_at=end_iso,
        days_remaining=days_remaining,
        credits_granted=credits_granted,
    )


# ── Endpoints ──


# ── Email Verification ──


class VerifyEmailRequest(BaseModel):
    email: str
    otp: str

    @field_validator("email")
    @classmethod
    def normalise_email(cls, v):
        return v.strip().lower()


class ResendVerificationRequest(BaseModel):
    email: str

    @field_validator("email")
    @classmethod
    def normalise_email(cls, v):
        return v.strip().lower()


@router.post("/verify-email")
@limiter.limit("10/minute")
def verify_email(request: Request, body: VerifyEmailRequest):
    """Verify a client's email using the 6-digit OTP sent at registration."""
    try:
        with get_session() as session:
            stmt = select(Client).where(Client.email == body.email).limit(1)
            client = session.execute(stmt).scalars().first()

            if not client or not client.email_otp or not client.email_otp_expires_at:
                raise HTTPException(status_code=400, detail="Invalid or expired code. Please request a new one.")

            if datetime.now(UTC) > client.email_otp_expires_at:
                client.email_otp = None
                client.email_otp_expires_at = None
                session.commit()
                raise HTTPException(status_code=400, detail="Code has expired. Please request a new one.")

            if not hmac.compare_digest(client.email_otp, body.otp.strip()):
                raise HTTPException(status_code=400, detail="Incorrect code. Please try again.")

            client.is_verified = True
            client.email_otp = None
            client.email_otp_expires_at = None
            session.commit()

            logger.info("Email verified for client %s", client.id)
            return {"message": "Email verified successfully."}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("verify_email failed: %s", type(e).__name__)
        raise HTTPException(status_code=500, detail="Verification failed. Please try again.") from e


@router.post("/resend-verification")
@limiter.limit("2/minute")
def resend_verification(request: Request, body: ResendVerificationRequest):
    """Re-send a fresh 6-digit verification OTP. Safe to call on unknown emails."""
    try:
        with get_session() as session:
            stmt = select(Client).where(Client.email == body.email).limit(1)
            client = session.execute(stmt).scalars().first()

            # Always return success to prevent email enumeration.
            if not client or client.is_verified:
                return {"message": "If an unverified account exists, a new code has been sent."}

            otp = str(secrets.randbelow(900000) + 100000)
            client.email_otp = otp
            client.email_otp_expires_at = datetime.now(UTC) + timedelta(minutes=15)
            session.commit()

            try:
                from app.services.email_service import send_verification_otp_email

                send_verification_otp_email(client.email, client.name, otp)
            except Exception as mail_err:
                logger.warning("resend_verification_otp_failed for client %s: %s", client.id, mail_err)

            return {"message": "If an unverified account exists, a new code has been sent."}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("resend_verification failed: %s", type(e).__name__)
        raise HTTPException(status_code=500, detail="An error occurred.") from e


# ── Password Reset ──


class RequestPasswordResetRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    email: str
    otp: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def strong_password(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters.")
        if not re.search(r"[A-Za-z]", v):
            raise ValueError("Password must contain at least one letter.")
        if not re.search(r"[0-9]", v):
            raise ValueError("Password must contain at least one number.")
        return v


@router.post("/login", response_model=LoginResponse)
@limiter.limit("10/minute")
def login(request: Request, body: LoginRequest):
    """Authenticate a Client and return their permanent API key."""
    try:
        with get_session() as session:
            stmt = select(Client).where(Client.email == body.email.strip().lower()).limit(1)
            client = session.execute(stmt).scalars().first()

            if not client:
                logger.warning("Login failed: unknown email %s", _redact_email(_sanitize_for_log(body.email)))
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password.")

            if not verify_password(body.password, client.hashed_password):
                logger.warning("Login failed: incorrect password for %s", _redact_email(_sanitize_for_log(body.email)))
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password.")

            logger.info("Successful dashboard login for client %s (%s)", client.id, client.name)

            return {
                "access_token": client.api_key,
                "token_type": "bearer",
                "client_id": client.id,
                "name": client.name,
                "is_superadmin": bool(client.is_superadmin),
                "is_verified": bool(client.is_verified),
                "company_name": client.company_name,
                "website": client.website,
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("LOGIN FAILED for %s: %s", _redact_email(_sanitize_for_log(body.email)), type(e).__name__)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Login failed. Please try again."
        ) from e


@router.post("/register", response_model=RegisterResponse)
@limiter.limit("5/minute")
def register(request: Request, body: RegisterRequest):
    """
    Self-service client registration.
    Creates a new client account and returns an API key for immediate login.
    """
    try:
        with get_session() as session:
            # Check for duplicate email
            stmt = select(Client).where(Client.email == body.email).limit(1)
            existing = session.execute(stmt).scalars().first()
            if existing:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="An account with this email already exists. Please sign in instead.",
                )

            # Create the client
            new_client = Client(
                name=body.name.strip(),
                email=body.email,  # already lowercased by validator
                company_name=body.company_name.strip() if body.company_name else None,
                hashed_password=get_password_hash(body.password),
                api_key=str(uuid.uuid4().hex),
                website=body.website.strip() if body.website else None,
                is_superadmin=False,
            )

            session.add(new_client)
            session.flush()  # Get the client ID
            logger.info("Client INSERT flushed: id=%s", new_client.id)

            # Auto-assign the default plan (currently the 14-day trial). The
            # subscription row is bound locally so we can build the trial
            # payload + welcome email without re-querying after commit.
            subscription = None
            try:
                from app.services.plan_service import assign_default_plan_to_client

                subscription = assign_default_plan_to_client(session, new_client.id)
            except Exception as plan_err:
                logger.warning(f"Could not assign default plan to client {new_client.id}: {plan_err}")

            session.commit()
            logger.info(f"Transaction committed successfully for client {new_client.id}")

            session.refresh(new_client)

            # Build the trial payload + fire the welcome email AFTER commit.
            # If the email layer crashes, we don't want to roll back the
            # client row — they're already a customer, the day-1 cron will
            # follow up.
            trial_payload: TrialStatePayload | None = None
            if subscription is not None and subscription.status == "trialing" and subscription.trial_end is not None:
                from app.config import TRIAL_CREDITS
                from app.services.email_service import send_trial_welcome_email

                trial_end = subscription.trial_end
                if trial_end.tzinfo is None:
                    trial_end = trial_end.replace(tzinfo=UTC)
                days_remaining = trial_days_remaining(trial_end)
                credits_granted = int(subscription.plan.credits_per_month or 0) if subscription.plan else TRIAL_CREDITS

                trial_payload = TrialStatePayload(
                    status=subscription.status,
                    trial_end_at=trial_end.isoformat(),
                    days_remaining=days_remaining,
                    credits_granted=credits_granted,
                )

                try:
                    send_trial_welcome_email(
                        new_client.email,
                        name=new_client.name,
                        trial_end=trial_end,
                        credits=credits_granted,
                        duration_days=int(subscription.plan.trial_days or 14) if subscription.plan else 14,
                    )
                except Exception as mail_err:
                    # send_trial_welcome_email is already defensive — this is
                    # the belt-and-braces guard for any import-time error.
                    logger.warning(
                        "trial_welcome_dispatch_failed for client %s: %s",
                        new_client.id,
                        mail_err,
                    )

            # Affiliate first-touch attribution. Best-effort — invalid /
            # self-referral / inactive code all silently no-op so the
            # signup response stays fast and successful.
            if body.referral_code:
                try:
                    from app.services.affiliate_service import attribute_signup

                    attribute_signup(session, new_client.id, body.referral_code)
                    session.commit()
                except Exception as ref_err:
                    logger.warning(
                        "referral_attribution_failed for client %s: %s",
                        new_client.id,
                        ref_err,
                    )
                    session.rollback()

            # Generate and persist the email OTP (15-minute window).
            otp = str(secrets.randbelow(900000) + 100000)
            new_client.email_otp = otp
            new_client.email_otp_expires_at = datetime.now(UTC) + timedelta(minutes=15)
            new_client.is_verified = False
            session.commit()

            # Fire verification email after commit — failure must not roll back the account.
            try:
                from app.services.email_service import send_verification_otp_email

                send_verification_otp_email(new_client.email, new_client.name, otp)
            except Exception as mail_err:
                logger.warning("verification_otp_email_failed for client %s: %s", new_client.id, mail_err)

            logger.info(
                "New client registered: id=%s (%s) — verification OTP dispatched", new_client.id, new_client.name
            )

            return {
                "access_token": new_client.api_key,
                "token_type": "bearer",
                "client_id": new_client.id,
                "name": new_client.name,
                "is_superadmin": False,
                "is_verified": False,
                "company_name": new_client.company_name,
                "website": new_client.website,
                "message": "Account created successfully.",
                "trial": trial_payload,
            }
    except HTTPException:
        raise  # Re-raise 409 (duplicate email) and other HTTP errors as-is
    except Exception as e:
        logger.error("REGISTRATION FAILED for %s: %s", _redact_email(_sanitize_for_log(body.email)), type(e).__name__)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Registration failed. Please try again.",
        ) from e


@router.post("/request-password-reset")
@limiter.limit("3/minute")
def request_password_reset(request: Request, body: RequestPasswordResetRequest):
    """Generates an OTP and sends it via email."""
    try:
        with get_session() as session:
            stmt = select(Client).where(Client.email == body.email.strip().lower()).limit(1)
            client = session.execute(stmt).scalars().first()
            if not client:
                # Return success anyway to avoid email enumeration
                return {"message": "If an account exists, a reset link has been sent."}

            otp = str(secrets.randbelow(900000) + 100000)
            client.reset_otp = otp
            client.reset_otp_expires_at = datetime.now(UTC) + timedelta(minutes=15)
            session.commit()

            send_password_reset_email(client.email, otp)
            return {"message": "If an account exists, a reset link has been sent."}
    except Exception as e:
        logger.error(
            "Failed to request password reset for %s: %s",
            _redact_email(_sanitize_for_log(body.email)),
            type(e).__name__,
        )
        raise HTTPException(status_code=500, detail="An error occurred.") from e


@router.post("/reset-password")
@limiter.limit("5/minute")
def reset_password(request: Request, body: ResetPasswordRequest):
    """Verifies OTP and resets the password."""
    try:
        with get_session() as session:
            stmt = select(Client).where(Client.email == body.email.strip().lower()).limit(1)
            client = session.execute(stmt).scalars().first()

            if not client or not client.reset_otp or not client.reset_otp_expires_at:
                raise HTTPException(status_code=400, detail="Invalid or expired reset code.")

            if datetime.now(UTC) > client.reset_otp_expires_at:
                client.reset_otp = None
                client.reset_otp_expires_at = None
                session.commit()
                raise HTTPException(status_code=400, detail="Reset code has expired.")

            if not hmac.compare_digest(client.reset_otp, body.otp.strip()):
                # Invalidate OTP after wrong guess to prevent brute-force
                client.reset_otp = None
                client.reset_otp_expires_at = None
                session.commit()
                raise HTTPException(status_code=400, detail="Invalid reset code. Please request a new code.")

            client.hashed_password = get_password_hash(body.new_password)
            client.reset_otp = None
            client.reset_otp_expires_at = None
            session.commit()

            return {"message": "Password successfully reset."}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Failed to reset password for %s: %s", _redact_email(_sanitize_for_log(body.email)), type(e).__name__
        )
        raise HTTPException(status_code=500, detail="An error occurred.") from e


# ── Operator Authentication ──


class OperatorLoginRequest(BaseModel):
    email: str
    password: str


class OperatorLoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    operator_id: int
    client_id: int
    default_bot_id: int | None = None
    name: str
    role: str
    department_id: int | None = None
    company_name: str | None = None
    website: str | None = None


class OperatorChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def strong_password(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters.")
        if not re.search(r"[A-Za-z]", v):
            raise ValueError("Password must contain at least one letter.")
        if not re.search(r"[0-9]", v):
            raise ValueError("Password must contain at least one number.")
        return v


@router.post("/operator-login", response_model=OperatorLoginResponse)
@limiter.limit("10/minute")
def operator_login(request: Request, body: OperatorLoginRequest):
    """
    Authenticate an Operator via email and password.
    Returns the Operator's API Key for subsequent requests via X-Operator-Key header.
    """
    try:
        with get_session() as session:
            email = body.email.strip().lower()
            operators = (
                session.execute(
                    select(Operator)
                    .where(Operator.email == email)
                    .order_by(Operator.created_at.desc(), Operator.id.desc())
                )
                .scalars()
                .all()
            )

            valid_operators = [
                op for op in operators if op.hashed_password and verify_password(body.password, op.hashed_password)
            ]

            if not valid_operators:
                logger.warning(
                    "Operator login failed: unknown email or no password set for %s",
                    _redact_email(_sanitize_for_log(body.email)),
                )
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Incorrect email or password",
                )

            if len(valid_operators) == 1:
                operator = valid_operators[0]
            else:
                client_ids = {op.client_id for op in valid_operators}
                workspace_stats = _build_workspace_stats(session, client_ids)
                operator = _choose_best_operator_candidate(valid_operators, workspace_stats)

                logger.warning(
                    "Duplicate operator email resolved during login | email=%s | chosen_operator_id=%s | chosen_client_id=%s | candidates=%s | workspace_stats=%s",
                    email,
                    operator.id,
                    operator.client_id,
                    [(candidate.id, candidate.client_id) for candidate in valid_operators],
                    workspace_stats,
                )

            # Backfill missing API keys for older operator records so subsequent
            # authenticated requests don't immediately fail with 401.
            if not operator.operator_api_key:
                operator.operator_api_key = uuid.uuid4().hex
                session.commit()
                session.refresh(operator)

            default_bot = _get_default_workspace_bot(session, operator.client_id)

            workspace = session.execute(select(Client).where(Client.id == operator.client_id)).scalars().first()

            logger.info(f"Successful operator login for operator {operator.id} ({operator.name})")

            return {
                "access_token": operator.operator_api_key,
                "token_type": "bearer",
                "operator_id": operator.id,
                "client_id": operator.client_id,
                "default_bot_id": default_bot.id if default_bot else None,
                "name": operator.name,
                "role": operator.role,
                "department_id": operator.department_id,
                "company_name": getattr(workspace, "company_name", None) if workspace else None,
                "website": getattr(workspace, "website", None) if workspace else None,
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("OPERATOR LOGIN FAILED for %s: %s", _redact_email(_sanitize_for_log(body.email)), type(e).__name__)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Login failed. Please try again.",
        ) from e


@router.post("/operator-change-password")
def operator_change_password(
    request: OperatorChangePasswordRequest,
    operator: Operator = Depends(get_current_operator),
):
    """Operator changes their own password."""
    try:
        with get_session() as session:
            db_operator = session.execute(select(Operator).where(Operator.id == operator.id)).scalar_one_or_none()
            if not db_operator or not db_operator.hashed_password:
                raise HTTPException(status_code=400, detail="Operator account not properly configured.")

            if not verify_password(request.current_password, db_operator.hashed_password):
                raise HTTPException(status_code=400, detail="Current password is incorrect.")

            db_operator.hashed_password = get_password_hash(request.new_password)
            session.commit()

            return {"message": "Password changed successfully."}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Operator password change failed for operator {operator.id}: {e}")
        raise HTTPException(status_code=500, detail="An error occurred.") from e
