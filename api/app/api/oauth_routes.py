"""Google OAuth 2.0 routes — one button, three personas.

Two endpoints:

* ``GET /auth/google/login``    — issues a signed state cookie and
  302-redirects to Google's consent screen.
* ``GET /auth/google/callback`` — Google's redirect target. Validates the
  state cookie, exchanges the auth code for a verified profile, then
  either signs in (existing account) or signs up (new account) and
  redirects to the admin app with the ``api_key`` in the URL fragment.

The flow is identical for the login and signup buttons — the backend
decides which action to take based on whether the (provider, subject) or
the email already exists. The ``mode`` carried in the state cookie is
telemetry only.

Why URL fragment instead of query string for the api_key: fragments are
never sent to the server in subsequent requests, never logged by access
logs, never leaked via Referer. The frontend reads ``location.hash`` on
arrival, persists the key in ``localStorage`` (matching the
password-login codepath), and rewrites the URL to scrub the fragment.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from app.config import (
    APP_ENV,
    GOOGLE_OAUTH_ENABLED,
    OAUTH_SUCCESS_REDIRECT_URL,
)
from app.core.rate_limit import limiter
from app.db.models import Client, OAuthAccount
from app.db.session import get_session
from app.services.oauth_service import (
    GoogleProfile,
    OAuthError,
    build_authorize_url,
    exchange_code_for_profile,
    issue_state_token,
    verify_state_token,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth/google", tags=["oauth"])

# Short-lived, HttpOnly cookie that carries the signed state token across the
# Google round-trip. The cookie is the second half of the CSRF pair — the
# attacker would need to control both the user's browser cookie jar AND the
# ``state`` URL parameter Google sends back to forge a callback.
STATE_COOKIE_NAME = "oyechats_oauth_state"
STATE_COOKIE_MAX_AGE = 600  # seconds; matches STATE_MAX_AGE_SECONDS

# Where to deposit ``error=…`` redirects when the OAuth dance fails before
# we can issue an api_key. We always land on the success URL so the
# frontend has a single place that parses both success and failure paths.
ERROR_REDIRECT_URL = OAUTH_SUCCESS_REDIRECT_URL


# ── helpers ─────────────────────────────────────────────────────────────


def _error_redirect(code: str, *, next_path: str | None = None) -> RedirectResponse:
    """Redirect back to the frontend with a machine-readable error code.

    ``code`` is a short string the frontend maps to a friendly message —
    keeping it server-coded means we can change the user-facing copy
    without redeploying the API.
    """
    params = {"error": code}
    if next_path:
        params["next"] = next_path
    target = f"{ERROR_REDIRECT_URL}?{urlencode(params)}"
    resp = RedirectResponse(target, status_code=status.HTTP_302_FOUND)
    resp.delete_cookie(STATE_COOKIE_NAME, path="/auth/google")
    return resp


def _success_redirect(api_key: str, *, next_path: str, is_new: bool, is_superadmin: bool) -> RedirectResponse:
    """Redirect to the frontend with the api_key in the URL fragment.

    Fragment-based delivery keeps the api_key out of server logs and
    Referer headers. The query string still carries non-sensitive flags
    (``new``, ``superadmin``) the frontend uses to pick the post-login
    destination and toast.
    """
    query = {
        "new": "1" if is_new else "0",
        "superadmin": "1" if is_superadmin else "0",
    }
    if next_path:
        query["next"] = next_path

    fragment = urlencode({"api_key": api_key})
    target = f"{OAUTH_SUCCESS_REDIRECT_URL}?{urlencode(query)}#{fragment}"
    resp = RedirectResponse(target, status_code=status.HTTP_302_FOUND)
    resp.delete_cookie(STATE_COOKIE_NAME, path="/auth/google")
    return resp


def _safe_next_path(raw: str | None) -> str:
    """Allow only same-origin relative paths to prevent open-redirects."""
    if not raw or not raw.startswith("/") or raw.startswith("//"):
        return "/"
    return raw


# ── routes ──────────────────────────────────────────────────────────────


@router.get("/login")
@limiter.limit("20/minute")
def google_login(request: Request, next: str | None = None, mode: str = "login"):
    """Kick off the Google OAuth flow.

    Issues the state cookie and 302-redirects to Google's consent screen.
    ``next`` is an optional relative path to land on after success (e.g.
    ``/billing``). ``mode`` is telemetry only — backend behaviour is the
    same for login and signup.
    """
    if not GOOGLE_OAUTH_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google sign-in is not configured on this server.",
        )

    next_path = _safe_next_path(next)
    if mode not in ("login", "register"):
        mode = "login"

    state_token = issue_state_token(next_path=next_path, mode=mode)

    try:
        authorize_url = build_authorize_url(state_token)
    except OAuthError as exc:
        logger.warning("google_oauth_authorize_url_failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google sign-in is unavailable. Please try again later.",
        ) from exc

    resp = RedirectResponse(authorize_url, status_code=status.HTTP_302_FOUND)
    # SameSite=Lax is correct here — Google's redirect back to us is a
    # top-level GET navigation, which Lax cookies travel on. Strict would
    # drop the cookie on Google's redirect and break the flow.
    resp.set_cookie(
        STATE_COOKIE_NAME,
        state_token,
        max_age=STATE_COOKIE_MAX_AGE,
        httponly=True,
        secure=APP_ENV == "production",
        samesite="lax",
        path="/auth/google",
    )
    return resp


@router.get("/callback")
@limiter.limit("30/minute")
def google_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    """Handle Google's redirect back into the app.

    Validates the CSRF state cookie, exchanges the code for a verified
    Google profile, then resolves the Client through three matching
    layers (see ``_resolve_client_for_profile``) and issues a 302 to the
    frontend with the api_key in the URL fragment.
    """
    if not GOOGLE_OAUTH_ENABLED:
        return _error_redirect("oauth_unavailable")

    # Google echoes any consent-screen error back via ``error=`` (e.g.
    # ``access_denied`` when the user clicked Cancel). Surface a clean
    # code instead of the raw provider string.
    if error:
        logger.info("google_oauth_callback_provider_error: %s", error)
        return _error_redirect("oauth_cancelled" if error == "access_denied" else "oauth_provider_error")

    if not code or not state:
        return _error_redirect("oauth_missing_params")

    cookie_state = request.cookies.get(STATE_COOKIE_NAME)
    if not cookie_state or cookie_state != state:
        logger.warning("google_oauth_state_cookie_mismatch")
        return _error_redirect("oauth_state_mismatch")

    try:
        state_payload = verify_state_token(state)
    except OAuthError as exc:
        logger.warning("google_oauth_state_invalid: %s", exc)
        return _error_redirect("oauth_state_invalid")

    next_path = _safe_next_path(state_payload.get("next"))

    try:
        profile = exchange_code_for_profile(code)
    except OAuthError as exc:
        logger.warning("google_oauth_exchange_failed: %s", exc)
        return _error_redirect("oauth_exchange_failed", next_path=next_path)

    # Email must be verified by Google before we'll trust it for the
    # email-based account-linking branch. Without this check a malicious
    # Workspace admin could forge an unverified email matching one of our
    # password customers and hijack the account.
    if not profile.email_verified:
        logger.info("google_oauth_email_unverified email=%s", profile.email)
        return _error_redirect("oauth_email_unverified", next_path=next_path)

    try:
        client, is_new = _resolve_client_for_profile(profile)
    except _DuplicatePasswordAccount:
        # An existing password account has the same email but the user
        # has never linked Google. We block auto-linking out of an
        # abundance of caution — they should sign in with their password
        # once and link from a dedicated UI surface later. (Future work.)
        # For now, send them to login with a code the UI can explain.
        return _error_redirect("oauth_email_has_password", next_path=next_path)
    except Exception as exc:  # pragma: no cover — defensive
        logger.exception("google_oauth_resolve_failed: %s", exc)
        return _error_redirect("oauth_internal_error", next_path=next_path)

    return _success_redirect(
        client.api_key,
        next_path=next_path,
        is_new=is_new,
        is_superadmin=bool(client.is_superadmin),
    )


# ── account resolution ─────────────────────────────────────────────────


class _DuplicatePasswordAccount(Exception):
    """Raised when an OAuth profile's email matches a password-only account."""


def _resolve_client_for_profile(profile: GoogleProfile) -> tuple[Client, bool]:
    """Find or create the Client for a verified Google profile.

    Returns ``(client, is_new)``. The Client object is detached from the
    session so the caller can read its api_key after the session closes.

    Lookup order:

    1. ``oauth_accounts`` row matching ``(provider, provider_user_id)`` —
       the canonical "returning OAuth user" path. Always wins.
    2. ``clients`` row with the same email AND no password set — that's
       a Client that signed up via OAuth on a different provider (future
       providers) or had their password forcibly cleared. Safe to link.
    3. ``clients`` row with the same email AND a password — refuse to
       auto-link and raise ``_DuplicatePasswordAccount``. The user must
       sign in with their password first, then explicitly link Google
       from a future "Linked Accounts" UI.
    4. No match → create a new Client + OAuthAccount + default trial
       plan, fire the welcome email.
    """
    now = datetime.now(UTC)

    with get_session() as session:
        # ── (1) match on (provider, subject) ──
        stmt = select(OAuthAccount).where(
            OAuthAccount.provider == "google",
            OAuthAccount.provider_user_id == profile.subject,
        )
        link = session.execute(stmt).scalars().first()
        if link:
            client = session.execute(select(Client).where(Client.id == link.client_id)).scalars().first()
            if client:
                link.last_login_at = now
                # Refresh provider-side display info — users update their
                # Google avatar/name independently of our DB.
                link.email = profile.email
                link.picture_url = profile.picture
                session.commit()
                _ = client.id, client.name, client.email, client.api_key, client.is_superadmin
                session.expunge(client)
                logger.info("google_oauth_login_returning client_id=%s", client.id)
                return client, False
            # Orphan link row — the Client was deleted but the OAuth row
            # survived. Treat as new signup; this is rare enough that we
            # accept the wasted row.
            logger.warning("google_oauth_orphan_link link_id=%s", link.id)
            session.delete(link)
            session.commit()

        # ── (2) / (3) email-based fallback ──
        client = session.execute(select(Client).where(Client.email == profile.email)).scalars().first()
        if client:
            if client.hashed_password:
                # Has a password → require explicit linking (future UI).
                raise _DuplicatePasswordAccount()

            # Existing OAuth-only account with no link yet (e.g. seeded
            # row). Attach the Google identity.
            link = OAuthAccount(
                client_id=client.id,
                provider="google",
                provider_user_id=profile.subject,
                email=profile.email,
                picture_url=profile.picture,
                last_login_at=now,
            )
            session.add(link)
            session.commit()
            _ = client.id, client.name, client.email, client.api_key, client.is_superadmin
            session.expunge(client)
            logger.info("google_oauth_link_existing client_id=%s", client.id)
            return client, False

        # ── (4) new signup ──
        new_client = Client(
            name=profile.name or profile.email.split("@", 1)[0],
            email=profile.email,
            company_name=None,
            hashed_password=None,  # OAuth-only; no password set.
            api_key=uuid.uuid4().hex,
            website=None,
            is_superadmin=False,
            is_verified=True,  # Google has already verified the email.
        )
        session.add(new_client)
        session.flush()

        link = OAuthAccount(
            client_id=new_client.id,
            provider="google",
            provider_user_id=profile.subject,
            email=profile.email,
            picture_url=profile.picture,
            last_login_at=now,
        )
        session.add(link)

        # Assign the default plan (mirrors the password-signup path).
        # Failure here must not block signup — the client row is the
        # important part; the plan can be retried.
        subscription = None
        try:
            from app.services.plan_service import assign_default_plan_to_client

            subscription = assign_default_plan_to_client(session, new_client.id)
        except Exception as plan_err:  # pragma: no cover — best-effort
            logger.warning(
                "google_oauth_plan_assignment_failed client_id=%s err=%s",
                new_client.id,
                plan_err,
            )

        # Snapshot the trial fields BEFORE commit so the welcome email
        # below can fire after the session closes without re-querying.
        trial_end_at: datetime | None = None
        trial_credits: int | None = None
        trial_duration_days: int | None = None
        if subscription is not None and subscription.status == "trialing" and subscription.trial_end is not None:
            trial_end_at = subscription.trial_end
            if trial_end_at.tzinfo is None:
                trial_end_at = trial_end_at.replace(tzinfo=UTC)
            plan = subscription.plan
            trial_credits = int(plan.credits_per_month or 0) if plan else None
            trial_duration_days = int(plan.trial_days or 14) if plan else 14

        session.commit()
        session.refresh(new_client)
        _ = new_client.id, new_client.name, new_client.email, new_client.api_key, new_client.is_superadmin
        client_id = new_client.id
        client_name = new_client.name
        session.expunge(new_client)

    # Welcome email — fire outside the DB transaction so a mail outage
    # doesn't rollback the user. Only sent when the trial fields were
    # populated; otherwise we skip cleanly rather than send a half-filled
    # template.
    if trial_end_at is not None and trial_credits is not None and trial_duration_days is not None:
        try:
            from app.services.email_service import send_trial_welcome_email

            send_trial_welcome_email(
                profile.email,
                name=client_name,
                trial_end=trial_end_at,
                credits=trial_credits,
                duration_days=trial_duration_days,
            )
        except Exception as mail_err:  # pragma: no cover — best-effort
            logger.warning("google_oauth_welcome_email_failed client_id=%s err=%s", client_id, mail_err)

    logger.info("google_oauth_signup_new client_id=%s", client_id)
    return new_client, True


# ── feature-flag endpoint ───────────────────────────────────────────────


@router.get("/status")
def google_oauth_status():
    """Tell the frontend whether the Google button should render.

    Returning a single boolean keeps the frontend logic trivial — if the
    server hasn't been configured with credentials, the button hides
    itself rather than 503-ing on click.
    """
    return {"enabled": GOOGLE_OAUTH_ENABLED}
