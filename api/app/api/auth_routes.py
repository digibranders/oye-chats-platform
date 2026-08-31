import hmac
import logging
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select

from app.api.auth import (
    IMPERSONATION_REJECTED_DETAIL,
    find_active_impersonation_token,
    get_current_client_or_operator,
    get_current_client_strict,
    get_current_operator,
)
from app.core.dates import trial_days_remaining
from app.core.geo import resolve_country
from app.core.otp_guard import clear_attempts, register_failed_attempt
from app.core.rate_limit import (
    clear_failed_logins,
    limiter,
    login_attempts_exhausted,
    note_failed_login,
)
from app.core.security import get_password_hash, verify_password
from app.db.models import Bot, ChatSession, Client, Document, Operator
from app.db.session import get_session
from app.schemas.validators import (
    EmailAddress,
    OptionalName,
    Password,
    RequiredName,
    Token,
)
from app.services.audit_service import record_audit
from app.services.email_service import send_password_reset_email
from app.services.runtime_config import is_impersonation_enabled

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
    # Neither field is length-checked against the *stored* credential here.
    # This is the unauthenticated entry point, so the bound exists to keep an
    # arbitrary-size string out of the query parameter and the bcrypt call,
    # not to hint at what a valid password looks like. ``verify_password``
    # truncates to bcrypt's 72 bytes regardless.
    email: EmailAddress
    password: Password


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
    name: RequiredName
    email: EmailAddress
    password: Password
    company_name: OptionalName = None
    website: OptionalName = None
    # Billing country chosen at signup. Sets the account's display/charge
    # currency (IN -> INR, else USD) from the very first load. Optional; falls
    # back to IP geo when omitted.
    billing_country: str | None = Field(default=None, max_length=8)
    # Optional affiliate referral code captured from the ``?ref=`` cookie at
    # signup. Silent on invalid/self-referral. Registration must never fail
    # because of a referral problem. Bounded because it is looked up verbatim
    # and echoed into audit records.
    referral_code: str | None = Field(default=None, max_length=64)
    # Optional launch-promo code captured from the campaign link's ``?code=``.
    # Makes the offer link-exclusive (only link arrivals qualify). Silent on
    # unknown codes, a bad link must never fail signup.
    promo_code: str | None = Field(default=None, max_length=64)

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v):
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters.")
        return v

    @field_validator("billing_country")
    @classmethod
    def normalize_billing_country(cls, v):
        if not v:
            return None
        v = v.strip().upper()
        if not re.fullmatch(r"[A-Z]{2}", v):
            raise ValueError("billing_country must be a 2-letter ISO code")
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
    # The trial's length in days, from the plan row. The console divides the
    # days left by this to decide whether days or credits are the binding
    # constraint, and it used to hardcode 14 for the denominator while reading
    # ``credits_granted`` from here for the numerator. A super-admin retuning
    # ``plans.trial_days`` would have silently mis-classified every account.
    # Zero on the bought branch, whose plan is a purchased tier and not a trial.
    trial_days: int | None = None
    # Set when the customer has already BOUGHT during the trial. The mandate is
    # authorised and their entitlements are live, but the first debit waits for
    # the trial to run out, so the UI shows "Standard starts in N days" instead
    # of a countdown and an Upgrade button they have already pressed.
    paid_plan_starts_at: str | None = None  # ISO-8601, UTC
    paid_plan_name: str | None = None


class RegisterResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    client_id: int
    name: str
    is_superadmin: bool = False
    # True when the account is already verified at signup (local dev auto-verify).
    # Lets the client skip the OTP screen and go straight to the dashboard.
    is_verified: bool = False
    company_name: str | None = None
    website: str | None = None
    message: str = "Account created successfully."
    trial: TrialStatePayload | None = None


class CurrentUserResponse(BaseModel):
    """Profile payload for the authenticated principal (TopBar profile dropdown).

    Works for both clients (admins) and operators. The ``kind`` discriminator
    tells the UI which fields are meaningful. Operators don't own bots
    directly, so ``bot_count`` reflects the bots in their workspace (the
    client they belong to). For clients ``role`` is None; for operators
    ``role`` is one of ``owner | admin | operator``.

    Exposes only the small set of profile fields the admin app needs to
    render the user menu, never sensitive data (no api_key, no password
    hash).
    """

    id: int
    kind: str  # "client" | "operator"
    name: str
    email: str
    # Provider avatar (e.g. the Google profile picture) for accounts that
    # signed in / up via OAuth; None for password-only accounts. Rendered in
    # the TopBar avatar, with initials as the fallback.
    avatar_url: str | None = None
    # Set only for clients with an unconfirmed /client/change-email/request
    # in flight; None otherwise (always None for operators, who don't own
    # this flow). Lets the Settings UI resume the "verify your new email"
    # step across page reloads.
    pending_email: str | None = None
    company_name: str | None = None
    website: str | None = None
    created_at: str
    bot_count: int
    is_superadmin: bool = False
    is_online: bool = False
    # Email-verification + onboarding-wizard state. For clients these mirror
    # the columns on their own account; for operators they reflect the
    # workspace owner's account (the client they belong to), since operators
    # don't have their own verification/onboarding lifecycle.
    is_verified: bool = False
    onboarding_complete: bool = False
    role: str | None = None  # operator role; None for clients
    # Affiliate-program membership. Derived from the affiliates table.
    # ``True`` only when an active (non-deactivated) row exists for the
    # current client; always ``False`` for operators (they're a different
    # principal type and can't be affiliates themselves).
    is_affiliate: bool = False
    affiliate_id: int | None = None
    # ``True`` for affiliates who are NOT also customers. I.e. they came
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
    they belong to. That's the workspace they're acting in, not their
    own (operators don't have personal subscriptions).

    Response shape mirrors ``PlanEntitlements.to_json_dict()`` plus a small
    set of derived booleans the UI uses heavily.
    """
    from app.services.plan_entitlements_service import get_entitlements

    client_id = auth["client_id"]
    with get_session() as session:
        entitlements = get_entitlements(client_id, session, include_usage=True)

    payload = entitlements.to_json_dict()
    # Derived helpers. Saves the frontend a handful of conditionals.
    payload["is_free"] = entitlements.plan_slug == "free"
    payload["topup_allowed"] = entitlements.has_feature("topup_allowed")
    return payload


@router.get("/me", response_model=CurrentUserResponse)
def get_current_user_endpoint(auth: dict = Depends(get_current_client_or_operator)):
    """Return the authenticated principal's profile + workspace bot count.

    Used by the admin TopBar to populate the user-menu dropdown (email,
    joining date, bots). Accepts BOTH ``X-API-Key`` (clients) and
    ``X-Operator-Key`` (operators) so the dropdown works regardless of how
    the user logged in. For an operator, ``bot_count`` is the count of bots
    in their workspace (the client they belong to). That's what the user
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
                avatar_url=operator.avatar_url,
                company_name=owner_client.company_name if owner_client else None,
                website=owner_client.website if owner_client else None,
                created_at=operator.created_at.isoformat() if operator.created_at else "",
                bot_count=int(bot_count or 0),
                is_superadmin=False,
                is_online=bool(operator.is_online),
                # Reflect the workspace owner's account state. Operators act
                # inside a client's workspace and share its verification /
                # onboarding status rather than owning their own.
                is_verified=bool(owner_client.is_verified) if owner_client else False,
                onboarding_complete=bool(owner_client.onboarding_complete) if owner_client else False,
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

        # Google (OAuth) profile picture, when this account is linked to a
        # provider. Informational only. Used for the TopBar avatar; falls back
        # to initials in the UI when None (password-only accounts).
        from app.db.models import OAuthAccount

        oauth_row = session.execute(
            select(OAuthAccount).where(OAuthAccount.client_id == client.id, OAuthAccount.provider == "google").limit(1)
        ).scalar_one_or_none()
        avatar_url = oauth_row.picture_url if oauth_row else None

        # Resolve the trial snapshot in the same transaction. ``None`` for
        # paid customers and seeded superadmins; the dashboard treats that
        # as "no trial UI".
        trial_payload = _build_trial_payload(session, client.id)

        return CurrentUserResponse(
            id=client.id,
            kind="client",
            name=client.name,
            email=client.email,
            avatar_url=avatar_url,
            pending_email=client.pending_email,
            company_name=client.company_name,
            website=client.website,
            created_at=client.created_at.isoformat() if client.created_at else "",
            bot_count=int(bot_count or 0),
            is_superadmin=bool(client.is_superadmin),
            is_online=bool(is_online),
            is_verified=bool(client.is_verified),
            onboarding_complete=bool(client.onboarding_complete),
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


def grant_default_plan_and_welcome(session, client) -> "TrialStatePayload | None":
    """Open the client's first subscription, grant its credits, welcome them.

    Called when we know the email address belongs to the person using it: from
    ``verify_email`` once the OTP checks out, and from ``register`` only for an
    account that arrives already verified (``DEV_AUTO_VERIFY_EMAIL`` locally,
    OAuth in production, neither of which ever calls ``/verify-email``).

    It used to run inline in ``register``, before any code was entered. That
    funded a workspace for anyone who typed a stranger's address, and mailed
    that stranger "your 14-day free trial is live" for an account they had
    never opened.

    Idempotent on the SUBSCRIPTION, not on the OTP being single-use: the
    credits are real money, so a second call must find the existing row and do
    nothing rather than grant again.

    Never raises. A signup is not rolled back because the mail layer is down;
    the day-1 cron follows up.
    """
    from datetime import UTC

    from app.db.models import Subscription

    existing = (
        session.execute(select(Subscription).where(Subscription.client_id == client.id).limit(1)).scalars().first()
    )
    if existing is not None:
        # Already granted. Report the current state without touching anything.
        return _build_trial_payload(session, client.id)

    subscription = None
    try:
        from app.services.plan_service import assign_default_plan_to_client

        subscription = assign_default_plan_to_client(session, client.id)
    except Exception as plan_err:
        logger.warning("Could not assign default plan to client %s: %s", client.id, plan_err)
        return None

    if subscription is None or subscription.status != "trialing" or subscription.trial_end is None:
        return None

    trial_end = subscription.trial_end
    if trial_end.tzinfo is None:
        trial_end = trial_end.replace(tzinfo=UTC)
    plan_row = subscription.plan
    # ``None``, not 0, when the row cannot answer. The field is ``int | None``
    # precisely so "unknown" is expressible; a zero would tell the dashboard
    # nothing was granted while the credits sit in the ledger.
    credits_granted = int(plan_row.credits_per_month or 0) if plan_row else None
    trial_length_days = int(plan_row.trial_days or 0) if plan_row else 0

    payload = TrialStatePayload(
        status=subscription.status,
        trial_end_at=trial_end.isoformat(),
        days_remaining=trial_days_remaining(trial_end),
        credits_granted=credits_granted,
    )

    # Guarded on the NUMBERS, not on the row. The template writes "your {N}-day
    # free trial is live, you've got {C} credits", so either figure arriving as
    # zero puts a claim in front of a customer that contradicts the
    # subscription they just got. No numbers means no email; the payload above
    # still tells the app.
    if credits_granted and trial_length_days:
        try:
            from app.services.email_service import send_trial_welcome_email

            send_trial_welcome_email(
                client.email,
                name=client.name,
                trial_end=trial_end,
                credits=credits_granted,
                duration_days=trial_length_days,
            )
        except Exception as mail_err:
            # send_trial_welcome_email is already defensive. This is the
            # belt-and-braces guard for any import-time error.
            logger.warning("trial_welcome_dispatch_failed for client %s: %s", client.id, mail_err)
    else:
        logger.warning(
            "trial_welcome_skipped for client %s: subscription %s is trialing but resolves to "
            "credits=%s duration_days=%s, so the welcome copy would contradict it",
            client.id,
            subscription.id,
            credits_granted,
            trial_length_days,
        )

    return payload


def _build_trial_payload(session, client_id: int) -> "TrialStatePayload | None":
    """Resolve the dashboard's trial snapshot for a client.

    Returns ``None`` when the client has no current subscription or the
    subscription has never been in a trial state. The dashboard uses
    ``None`` as "hide the trial banner entirely".

    ``trial_expired`` is still selected below, and no shell surface renders it:
    both the rail card and the banner return null for that status. It stays in
    the filter because legacy rows written by the OLD expiry path still exist
    until they are settled (see the rollout runbook's step 0), and an inert
    payload is cheaper than a query that has to know about them. Nothing here
    prompts for reactivation; an earlier comment claimed it did and was wrong.
    """
    from datetime import UTC

    from app.db.models import Subscription

    # A mid-trial purchase first. Its activation RETIRES the trial row (one
    # account-level row per client may sit in the active set), so by the time
    # the mandate is authorised there is no trialing row left to find and the
    # lookup below would answer None: no trial UI at all for the one customer
    # who has just paid. The card needs "Standard starts in N days" here.
    bought = (
        session.execute(
            select(Subscription)
            .where(
                Subscription.client_id == client_id,
                Subscription.bot_id.is_(None),
                Subscription.status == "active",
            )
            .order_by(Subscription.created_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if (
        bought is not None
        and (bought.trial_emails_sent or {}).get("trial_conversion_granted")
        # Only BEFORE the first charge. The marker is written once and never
        # cleared, and ``last_granted_period_end`` rolls forward on every
        # renewal, so those two alone stay true forever: a customer who bought
        # mid-trial in September would still be told in March that their plan
        # "starts in 29 days", with the Upgrade action suppressed. Razorpay
        # writes ``current_period_start`` at the first debit, so its absence is
        # exactly the window this state describes.
        and bought.current_period_start is None
    ):
        # The marker's value IS the deferred start, the moment the customer is
        # first charged. Not ``last_granted_period_end``, which is that moment
        # plus one billing interval.
        raw_start = (bought.trial_emails_sent or {}).get("trial_conversion_granted")
        try:
            starts = datetime.fromisoformat(raw_start) if isinstance(raw_start, str) else None
        except ValueError:
            starts = None
        if starts is not None and starts.tzinfo is None:
            starts = starts.replace(tzinfo=UTC)
        if starts is not None and starts > datetime.now(UTC):
            plan_row = bought.plan
            return TrialStatePayload(
                status=bought.status,
                trial_end_at=starts.isoformat(),
                days_remaining=trial_days_remaining(starts),
                credits_granted=int(plan_row.credits_per_month or 0) if plan_row else None,
                trial_days=int(plan_row.trial_days or 0) if plan_row else None,
                paid_plan_starts_at=starts.isoformat(),
                paid_plan_name=plan_row.name if plan_row else None,
            )

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
        trial_days=int(plan.trial_days or 0) if plan else None,
    )


# ── Endpoints ──


# ── Email Verification ──


class VerifyEmailRequest(BaseModel):
    email: EmailAddress
    # Server-issued 6-digit code. Pinned to exactly that shape so the
    # constant-time compare below is fed a fixed-size candidate and a caller
    # cannot probe with a 1 MB string.
    otp: str = Field(..., pattern=r"^\d{6}$")


class ResendVerificationRequest(BaseModel):
    email: EmailAddress


@router.post("/onboarding/complete")
def complete_onboarding(client: Client = Depends(get_current_client_strict)):
    """Mark the account's guided onboarding (Build Studio) as complete.

    Called when the user finishes the Studio's Go-live milestone. Idempotent.
    Safe to call more than once.
    """
    with get_session() as session:
        row = session.get(Client, client.id)
        if row is None:
            raise HTTPException(status_code=404, detail="Account not found.")
        row.onboarding_complete = True
        session.commit()
    return {"onboarding_complete": True}


@router.post("/verify-email")
@limiter.limit("10/minute")
def verify_email(request: Request, body: VerifyEmailRequest):
    """Verify a client's email using the 6-digit OTP sent at registration.

    Wrong guesses are counted per ACCOUNT (see :mod:`app.core.otp_guard`), not
    just per IP: the ``@limiter.limit`` below keys on the caller's address, so
    on its own it does nothing against a prober rotating through a proxy pool
    with a 6-digit keyspace to cover. Once the per-account budget is spent the
    code is burned and the user has to request a fresh one, which is the
    behaviour the other OTP flows in this module already have.
    """
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
                exhausted = register_failed_attempt("verify_email", body.email)
                if exhausted:
                    client.email_otp = None
                    client.email_otp_expires_at = None
                    session.commit()
                    logger.warning("email_otp_attempts_exhausted client_id=%s. Code invalidated", client.id)
                    raise HTTPException(
                        status_code=400,
                        detail="Too many incorrect codes. Please request a new one.",
                    )
                raise HTTPException(status_code=400, detail="Incorrect code. Please try again.")

            client.is_verified = True
            client.email_otp = None
            client.email_otp_expires_at = None
            session.commit()

            # The address is proved, so the workspace becomes real: the trial
            # opens, its credits are granted, and the welcome goes out. All of
            # this used to happen at registration, before the code was entered.
            # Idempotent on the subscription, so a repeat verification finds the
            # existing row and grants nothing twice.
            trial_payload = grant_default_plan_and_welcome(session, client)
            session.commit()

            clear_attempts("verify_email", body.email)
            logger.info("Email verified for client %s", client.id)
            return {"message": "Email verified successfully.", "trial": trial_payload}
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

            # Dev convenience. See the register handler. Never logs in production.
            from app.config import APP_ENV

            if APP_ENV != "production":
                logger.info("[DEV] resent verification OTP for %s: %s", client.email, otp)

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
    email: EmailAddress


class ResetPasswordRequest(BaseModel):
    email: EmailAddress
    otp: str = Field(..., pattern=r"^\d{6}$")
    new_password: Password

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
    """Authenticate a Client and return their permanent API key.

    Two independent ceilings apply. ``@limiter.limit`` bounds one SOURCE
    address; :func:`note_failed_login` bounds attempts against one TARGET
    account, which is what password-spraying from a proxy pool defeats when
    only the per-IP limit exists. The account ceiling is checked before the
    password comparison so a throttled account costs an attacker a 429 rather
    than a bcrypt verification.
    """
    email = body.email.strip().lower()
    try:
        if login_attempts_exhausted(email):
            logger.warning("Login throttled: too many failed attempts for %s", _redact_email(_sanitize_for_log(email)))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many failed sign-in attempts. Please wait a few minutes and try again.",
                headers={"Retry-After": "900"},
            )

        with get_session() as session:
            stmt = select(Client).where(Client.email == email).limit(1)
            client = session.execute(stmt).scalars().first()

            if not client:
                note_failed_login(email)
                logger.warning("Login failed: unknown email %s", _redact_email(_sanitize_for_log(body.email)))
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password.")

            if not verify_password(body.password, client.hashed_password):
                note_failed_login(email)
                logger.warning("Login failed: incorrect password for %s", _redact_email(_sanitize_for_log(body.email)))
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password.")

            # Standing checks, a suspended or hard-deleted account must not
            # get past the password check, or the customer lands on a working
            # session that any subsequent API call immediately rejects.
            # Superadmins are exempt (platform staff, never customers).
            if not client.is_superadmin:
                if client.suspended_at is not None:
                    logger.warning("Login failed: suspended client %s", client.id)
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Your account has been suspended. Please contact support.",
                    )
                if client.deactivated_at is not None:
                    logger.warning("Login failed: deactivated client %s", client.id)
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=(
                            "Your account was deleted after the post-trial retention window. "
                            "Please contact support to restore it or sign up again."
                        ),
                    )

            clear_failed_logins(email)
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


@router.get("/detect-country")
@limiter.limit("30/minute")
def detect_country(request: Request):
    """Resolve the caller's country from edge headers, for the signup form.

    Public (no auth), the register page calls this on load to preselect the
    visitor's country in the billing-country field. Returns the ISO 3166-1
    alpha-2 code, or ``null`` when no edge signal is present (local dev, direct
    origin hit) so the form can fall back to an unselected placeholder.
    """
    return {"country": resolve_country(request)}


@router.post("/register", response_model=RegisterResponse)
@limiter.limit("5/minute")
def register(request: Request, body: RegisterRequest):
    """
    Self-service client registration.
    Creates a new client account and returns an API key for immediate login.
    """
    try:
        with get_session() as session:
            # Check for duplicate email. Three states matter here: an
            # active row is a normal duplicate-signup collision; a
            # suspended row is a superadmin-imposed lockout that only
            # support can lift; a deactivated row is the post-trial
            # hard-delete tombstone (workspace data purged, Client row
            # kept for audit). Each surface its own message so the user
            # knows exactly what to do next instead of guessing why
            # signup failed.
            stmt = select(Client).where(Client.email == body.email).limit(1)
            existing = session.execute(stmt).scalars().first()
            if existing is not None:
                if getattr(existing, "deactivated_at", None) is not None:
                    logger.info(
                        "register_blocked_deactivated client_id=%s email=%s",
                        existing.id,
                        _redact_email(_sanitize_for_log(body.email)),
                    )
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail={
                            "error": "account_deleted",
                            "message": (
                                "This email belongs to an account that was deleted after its "
                                "post-trial retention window. Please contact support to restore it, "
                                "or sign up with a different email address."
                            ),
                            "support_email": "developer@oyechats.com",
                        },
                    )
                if getattr(existing, "suspended_at", None) is not None:
                    logger.info(
                        "register_blocked_suspended client_id=%s email=%s",
                        existing.id,
                        _redact_email(_sanitize_for_log(body.email)),
                    )
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail={
                            "error": "account_suspended",
                            "message": (
                                "This email belongs to a suspended account. Please contact support "
                                "to resolve the suspension before creating a new account."
                            ),
                            "support_email": "developer@oyechats.com",
                        },
                    )
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
                # Explicit choice from the form wins; otherwise stamp the
                # IP-detected country so the account has the right currency from
                # first load (editable later in Billing details).
                billing_country=body.billing_country or resolve_country(request),
                is_superadmin=False,
            )

            session.add(new_client)
            session.flush()  # Get the client ID
            logger.info("Client INSERT flushed: id=%s", new_client.id)

            # The trial is NOT opened here. It is opened when the address is
            # verified (``verify_email`` below), because until the six-digit
            # code comes back we do not know the address belongs to the person
            # using it. Granting at this point funded a workspace for anyone who
            # typed a stranger's address, and mailed that stranger "your 14-day
            # free trial is live" for an account they had never opened.
            #
            # The exception is an account that arrives ALREADY verified:
            # ``DEV_AUTO_VERIFY_EMAIL`` locally, and OAuth, where the provider
            # has done the proving. Neither ever calls ``/verify-email``, so
            # deferring unconditionally would leave them with no subscription.
            session.commit()
            logger.info(f"Transaction committed successfully for client {new_client.id}")

            session.refresh(new_client)

            trial_payload: TrialStatePayload | None = None
            if new_client.is_verified:
                trial_payload = grant_default_plan_and_welcome(session, new_client)
                session.commit()

            # Affiliate first-touch attribution. Best-effort. Invalid /
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

            # Launch-promo first-touch attribution from the campaign link's
            # ``?code=``. Best-effort, an unknown code silently no-ops so a bad
            # link never blocks a signup; a valid one stamps the account so the
            # link-exclusive offer resolves at checkout.
            if body.promo_code:
                try:
                    from app.services.promotion_service import attribute_signup_code

                    attribute_signup_code(session, new_client.id, body.promo_code)
                    session.commit()
                except Exception as promo_err:
                    logger.warning(
                        "promo_attribution_failed for client %s: %s",
                        new_client.id,
                        promo_err,
                    )
                    session.rollback()

            # Generate and persist the email OTP (15-minute window).
            otp = str(secrets.randbelow(900000) + 100000)
            new_client.email_otp = otp
            new_client.email_otp_expires_at = datetime.now(UTC) + timedelta(minutes=15)
            from app.config import APP_ENV, DEV_AUTO_VERIFY_EMAIL

            # Auto-verify ONLY when the double-gated DEV_AUTO_VERIFY_EMAIL flag is
            # on (explicit opt-in AND non-production). Production always leaves this
            # False, so accounts still require a real OTP exactly as before.
            new_client.is_verified = DEV_AUTO_VERIFY_EMAIL
            session.commit()

            if DEV_AUTO_VERIFY_EMAIL:
                logger.info("[DEV] auto-verified %s (local email delivery is gated)", new_client.email)
            elif APP_ENV != "production":
                # Non-dev local envs still get the OTP in the log (never in production).
                logger.info("[DEV] email verification OTP for %s: %s", new_client.email, otp)

            # Fire verification email after commit. Failure must not roll back the account.
            try:
                from app.services.email_service import send_verification_otp_email

                send_verification_otp_email(new_client.email, new_client.name, otp)
            except Exception as mail_err:
                logger.warning("verification_otp_email_failed for client %s: %s", new_client.id, mail_err)

            logger.info(
                "New client registered: id=%s (%s). Verification OTP dispatched", new_client.id, new_client.name
            )

            return {
                "access_token": new_client.api_key,
                "token_type": "bearer",
                "client_id": new_client.id,
                "name": new_client.name,
                "is_superadmin": False,
                "is_verified": bool(new_client.is_verified),
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

            # Standing checks, a deactivated or suspended account must
            # not receive a reset OTP. The login endpoint already returns
            # a specific reason for these states so there's no further
            # enumeration signal being leaked here; matching the login
            # copy keeps the customer-facing story consistent instead of
            # sending them into a "why isn't my reset email arriving?"
            # dead end.
            if not client.is_superadmin:
                if client.deactivated_at is not None:
                    logger.info("password_reset_blocked_deactivated client_id=%s", client.id)
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=(
                            "Your account was deleted after the post-trial retention window. "
                            "Please contact support to restore it or sign up again."
                        ),
                    )
                if client.suspended_at is not None:
                    logger.info("password_reset_blocked_suspended client_id=%s", client.id)
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Your account has been suspended. Please contact support.",
                    )

            otp = str(secrets.randbelow(900000) + 100000)
            client.reset_otp = otp
            client.reset_otp_expires_at = datetime.now(UTC) + timedelta(minutes=15)
            session.commit()

            send_password_reset_email(client.email, otp)
            return {"message": "If an account exists, a reset link has been sent."}
    except HTTPException:
        # Standing-check rejections must propagate as-is; the catch-all
        # below would otherwise mask a 403 as a generic 500.
        raise
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

            # Defence-in-depth: even if the OTP was minted before the
            # account was deactivated / suspended (e.g. a support action
            # ran between the two calls), don't let the reset land, the
            # customer would set a password only to be blocked at login.
            if not client.is_superadmin:
                if client.deactivated_at is not None:
                    logger.info("password_reset_confirm_blocked_deactivated client_id=%s", client.id)
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=(
                            "Your account was deleted after the post-trial retention window. "
                            "Please contact support to restore it or sign up again."
                        ),
                    )
                if client.suspended_at is not None:
                    logger.info("password_reset_confirm_blocked_suspended client_id=%s", client.id)
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Your account has been suspended. Please contact support.",
                    )

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
            # Rotate the session credential. ``api_key`` is a permanent bearer
            # token with no expiry and no server-side session table, so a reset
            # that leaves it in place revokes nothing, the whole point of a
            # password reset ("someone else may have my account") is defeated if
            # the attacker's copy of the key keeps working. The new key is NOT
            # returned: a reset is unauthenticated, so handing a credential back
            # to whoever posted the OTP would be worse than the problem. The
            # user signs in again, which is the flow the frontend already runs.
            client.api_key = str(uuid.uuid4().hex)
            session.commit()

            logger.info("password_reset_completed_api_key_rotated client_id=%s", client.id)
            return {"message": "Password successfully reset."}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Failed to reset password for %s: %s", _redact_email(_sanitize_for_log(body.email)), type(e).__name__
        )
        raise HTTPException(status_code=500, detail="An error occurred.") from e


# ── Impersonation ──


class ImpersonationRedeemRequest(BaseModel):
    # Unauthenticated endpoint whose whole job is to validate a secret, so the
    # secret itself is bounded before any lookup or comparison runs.
    token: Token


class ImpersonationRedeemResponse(BaseModel):
    """Everything the customer app needs to render an impersonation session.

    Deliberately does NOT carry the Account's ``api_key`` (or any other
    credential): that key is permanent and unrevocable, so returning it would
    hand the super-admin something that outlives the 30-minute window and
    ignores ``revoked_at``. The raw impersonation token the caller already holds
    stays the only credential for the session.
    """

    client_id: int
    name: str
    email: str
    expires_at: str
    # Who is watching. Rendered in the customer-side banner.
    actor_email: str
    is_impersonation: bool = True


@router.post("/impersonation/redeem", response_model=ImpersonationRedeemResponse)
@limiter.limit("10/minute")
def redeem_impersonation_token(request: Request, body: ImpersonationRedeemRequest):
    """Exchange a raw impersonation token for the session's display profile.

    Unauthenticated by design, the token *is* the authentication. Rate-limited
    per IP because this is an unauthenticated endpoint that validates a secret.

    The call does **not** burn the token: the impersonated tab may reload, and
    the token remains a bearer credential for its remaining life (validity is
    re-checked on every subsequent request anyway, so revoking still ends the
    session immediately).

    Returns 401 for an expired, revoked, unknown, empty or malformed token,
    one message for all of them, so a prober learns nothing from the response.

    Returns 403 when impersonation is disabled outright (design §14). This is
    deliberately a *different* status from the 401 above: the customer app
    renders the server's message for a 403 ("temporarily disabled") but shows
    "expired or revoked" for a 401, and an operator debugging a flipped kill
    switch should not be told the link expired.
    """
    if not is_impersonation_enabled():
        logger.warning("impersonation_redeem_rejected: impersonation is disabled")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Impersonation is temporarily disabled.",
        )

    with get_session() as session:
        record = find_active_impersonation_token(session, body.token)
        if record is None:
            logger.warning("impersonation_redeem_rejected: expired, revoked, unknown, or malformed token")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=IMPERSONATION_REJECTED_DETAIL,
            )

        target = session.get(Client, record.target_id)
        actor = session.get(Client, record.actor_id)
        if target is None or actor is None:
            logger.warning(
                "impersonation_redeem_rejected: token %s references a missing account (actor=%s target=%s)",
                record.id,
                record.actor_id,
                record.target_id,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=IMPERSONATION_REJECTED_DETAIL,
            )

        payload = ImpersonationRedeemResponse(
            client_id=target.id,
            name=target.name,
            email=target.email,
            expires_at=record.expires_at.isoformat(),
            actor_email=actor.email,
        )

        record_audit(
            session,
            actor=actor,
            action="client.impersonate_redeem",
            target_type="client",
            target_id=target.id,
            after={"token_id": record.id, "expires_at": record.expires_at.isoformat()},
            request=request,
        )
        session.commit()

        logger.info("impersonation_redeemed token_id=%s actor=%s target=%s", record.id, actor.id, target.id)
        return payload


# ── Operator Authentication ──


class OperatorLoginRequest(BaseModel):
    email: EmailAddress
    password: Password


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
    current_password: Password
    new_password: Password

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
    email = body.email.strip().lower()
    try:
        # Same per-account ceiling as the client login above, an operator key
        # is a full workspace credential, so this door needs the same lock.
        if login_attempts_exhausted(f"operator:{email}"):
            logger.warning(
                "Operator login throttled: too many failed attempts for %s",
                _redact_email(_sanitize_for_log(email)),
            )
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many failed sign-in attempts. Please wait a few minutes and try again.",
                headers={"Retry-After": "900"},
            )

        with get_session() as session:
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
                note_failed_login(f"operator:{email}")
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

            clear_failed_logins(f"operator:{email}")
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
            # Same rationale as the client flows: ``operator_api_key`` is the
            # operator's permanent session credential, so a password change that
            # left it alone would revoke nothing. Returned as ``access_token``
            # (matching the login response's field name) so the caller's own tab
            # can swap it in instead of being logged out.
            new_key = uuid.uuid4().hex
            db_operator.operator_api_key = new_key
            session.commit()

            logger.info("operator_password_changed_api_key_rotated operator_id=%s", operator.id)
            return {"message": "Password changed successfully.", "access_token": new_key}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Operator password change failed for operator {operator.id}: {e}")
        raise HTTPException(status_code=500, detail="An error occurred.") from e
