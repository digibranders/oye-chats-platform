"""Google OAuth 2.0 routes, one button, three personas.

Two endpoints:

* ``GET /auth/google/login``   . Issues a signed state cookie and
  302-redirects to Google's consent screen.
* ``GET /auth/google/callback``. Google's redirect target. Validates the
  state cookie, exchanges the auth code for a verified profile, then
  either signs in (existing account) or signs up (new account) and
  redirects to the admin app with the ``api_key`` in the URL fragment.

The flow is identical for the login and signup buttons, the backend
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
from typing import Literal
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.config import (
    APP_ENV,
    GOOGLE_OAUTH_ENABLED,
    OAUTH_SUCCESS_REDIRECT_URL,
)
from app.core.geo import resolve_country
from app.core.rate_limit import limiter
from app.db.models import Client, OAuthAccount
from app.db.session import get_session
from app.schemas.validators import MAX_TOKEN, MAX_URL
from app.services.oauth_service import (
    GoogleProfile,
    OAuthError,
    build_authorize_url,
    exchange_code_for_profile,
    issue_state_token,
    verify_id_token,
    verify_state_token,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth/google", tags=["oauth"])

# Short-lived, HttpOnly cookie that carries the signed state token across the
# Google round-trip. The cookie is the second half of the CSRF pair, the
# attacker would need to control both the user's browser cookie jar AND the
# ``state`` URL parameter Google sends back to forge a callback.
STATE_COOKIE_NAME = "oyechats_oauth_state"
STATE_COOKIE_MAX_AGE = 600  # seconds; matches STATE_MAX_AGE_SECONDS

# Where to deposit ``error=…`` redirects when the OAuth dance fails before
# we can issue an api_key. We always land on the success URL so the
# frontend has a single place that parses both success and failure paths.
ERROR_REDIRECT_URL = OAUTH_SUCCESS_REDIRECT_URL

# Custom URL scheme the mobile app registers (see mobile-app/app.json
# "scheme": "oyechats"). Mirrors ERROR_REDIRECT_URL / OAUTH_SUCCESS_REDIRECT_URL
# but for the mobile client. Chosen via the ``cl`` field on the signed state
# token (set by ``/login?client=mobile``) since Google's round trip carries no
# other signal of which surface started the flow.
MOBILE_REDIRECT_URL = "oyechats://auth/callback"


# ── helpers ─────────────────────────────────────────────────────────────


def _error_redirect(code: str, *, next_path: str | None = None, client_target: str = "web") -> RedirectResponse:
    """Redirect back to the frontend with a machine-readable error code.

    ``code`` is a short string the frontend maps to a friendly message.
    Keeping it server-coded means we can change the user-facing copy
    without redeploying the API.
    """
    params = {"error": code}
    if next_path:
        params["next"] = next_path
    base = MOBILE_REDIRECT_URL if client_target == "mobile" else ERROR_REDIRECT_URL
    target = f"{base}?{urlencode(params)}"
    resp = RedirectResponse(target, status_code=status.HTTP_302_FOUND)
    resp.delete_cookie(STATE_COOKIE_NAME, path="/auth/google")
    return resp


def _success_redirect(
    api_key: str, *, next_path: str, is_new: bool, is_superadmin: bool, client_target: str = "web"
) -> RedirectResponse:
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
    base = MOBILE_REDIRECT_URL if client_target == "mobile" else OAUTH_SUCCESS_REDIRECT_URL
    target = f"{base}?{urlencode(query)}#{fragment}"
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
def google_login(
    request: Request,
    next: str | None = Query(default=None, max_length=MAX_URL),
    mode: Literal["login", "register"] = "login",
    promo_code: str | None = Query(default=None, max_length=64),
    referral_code: str | None = Query(default=None, max_length=64),
    client: Literal["web", "mobile"] = "web",
):
    """Kick off the Google OAuth flow.

    Issues the state cookie and 302-redirects to Google's consent screen.
    ``next`` is an optional relative path to land on after success (e.g.
    ``/billing``). ``mode`` is telemetry only. Backend behaviour is the
    same for login and signup. ``client`` is ``"web"`` (default) or
    ``"mobile"``, the mobile app passes ``client=mobile`` so the callback
    redirects into the app's ``oyechats://`` scheme instead of the admin
    web app once Google sends the user back.
    """
    if not GOOGLE_OAUTH_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google sign-in is not configured on this server.",
        )

    next_path = _safe_next_path(next)
    # ``mode`` and ``client`` are allow-listed by the signature. Anything
    # else is a 422 rather than being silently coerced to the default, so a
    # caller never gets a flow different from the one they asked for.
    client_target = client

    # Campaign/affiliate codes from the register page ride the SIGNED state,
    # the full-page Google round trip would otherwise lose them, which is
    # exactly how a promo-link signup via "Continue with Google" ended up
    # with no promotion attributed.
    state_token = issue_state_token(
        next_path=next_path,
        mode=mode,
        promo_code=promo_code,
        referral_code=referral_code,
        client_target=client_target,
    )

    try:
        authorize_url = build_authorize_url(state_token)
    except OAuthError as exc:
        logger.warning("google_oauth_authorize_url_failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google sign-in is unavailable. Please try again later.",
        ) from exc

    resp = RedirectResponse(authorize_url, status_code=status.HTTP_302_FOUND)
    # SameSite=Lax is correct here. Google's redirect back to us is a
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
    # All three are provider-supplied but reach us through the user's browser,
    # so they are attacker-controllable in the general case. ``code`` and
    # ``state`` are opaque secrets bounded before any compare or exchange;
    # ``error`` is a short provider slug that ends up in a log line, so it is
    # held to a charset that cannot carry a CRLF log-injection payload.
    code: str | None = Query(default=None, max_length=MAX_TOKEN),
    state: str | None = Query(default=None, max_length=MAX_TOKEN),
    error: str | None = Query(default=None, max_length=64, pattern=r"^[A-Za-z0-9_.\-]*$"),
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
    client_target = "mobile" if state_payload.get("cl") == "mobile" else "web"

    try:
        profile = exchange_code_for_profile(code)
    except OAuthError as exc:
        logger.warning("google_oauth_exchange_failed: %s", exc)
        return _error_redirect("oauth_exchange_failed", next_path=next_path, client_target=client_target)

    # Email must be verified by Google before we'll trust it for the
    # email-based account-linking branch. Without this check a malicious
    # Workspace admin could forge an unverified email matching one of our
    # password customers and hijack the account.
    if not profile.email_verified:
        logger.info("google_oauth_email_unverified email=%s", profile.email)
        return _error_redirect("oauth_email_unverified", next_path=next_path, client_target=client_target)

    try:
        client, is_new = _resolve_client_for_profile(profile, resolve_country(request))
    except _DuplicatePasswordAccount:
        # An existing password account has the same email but the user
        # has never linked Google. We block auto-linking out of an
        # abundance of caution. They should sign in with their password
        # once and link from a dedicated UI surface later. (Future work.)
        # For now, send them to login with a code the UI can explain.
        return _error_redirect("oauth_email_has_password", next_path=next_path, client_target=client_target)
    except Exception as exc:  # pragma: no cover. Defensive
        logger.exception("google_oauth_resolve_failed: %s", exc)
        return _error_redirect("oauth_internal_error", next_path=next_path, client_target=client_target)

    # First-touch attribution for accounts CREATED by this OAuth flow. The
    # register page's password path does the same two stamps; without this,
    # a campaign-link signup that chose "Continue with Google" silently lost
    # its promotion/referral. Existing accounts are never re-attributed
    # (first-touch), and both stamps are best-effort. Attribution must
    # never break a successful sign-in.
    if is_new:
        promo_code = (state_payload.get("promo") or "").strip()
        referral_code = (state_payload.get("ref") or "").strip()
        if promo_code or referral_code:
            try:
                from app.db.session import get_session

                with get_session() as session:
                    if referral_code:
                        from app.services.affiliate_service import attribute_signup

                        attribute_signup(session, client.id, referral_code)
                    if promo_code:
                        from app.services.promotion_service import attribute_signup_code

                        attribute_signup_code(session, client.id, promo_code)
                    session.commit()
            except Exception as attr_err:  # noqa: BLE001  never block the sign-in
                logger.warning("google_oauth_attribution_failed client=%s: %s", client.id, attr_err)

    return _success_redirect(
        client.api_key,
        next_path=next_path,
        is_new=is_new,
        is_superadmin=bool(client.is_superadmin),
        client_target=client_target,
    )


class IdTokenRequest(BaseModel):
    # A Google-issued JWT. Bounded before signature verification so an
    # unauthenticated caller cannot hand the crypto path an arbitrary-size
    # string; 4 KB is comfortably above any real id_token.
    id_token: str = Field(..., min_length=1, max_length=4096)


@router.post("/id-token")
@limiter.limit("30/minute")
def google_id_token_login(request: Request, payload: IdTokenRequest):
    """Handle native mobile Google Sign-In using an id_token directly.

    The mobile app uses the native Google Sign-In SDK to fetch an id_token
    and POSTs it here. We verify the token signature and exchange it for a
    profile, then create or return the API key in a JSON response.
    """
    if not GOOGLE_OAUTH_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google sign-in is not configured on this server.",
        )

    try:
        profile = verify_id_token(payload.id_token)
    except OAuthError as exc:
        logger.warning("google_oauth_id_token_verification_failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    if not profile.email_verified:
        logger.info("google_oauth_email_unverified email=%s", profile.email)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Your Google email address is unverified.",
        )

    try:
        client, is_new = _resolve_client_for_profile(profile, resolve_country(request))
    except _DuplicatePasswordAccount as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An account with this email already exists and uses a password. Please sign in with your password.",
        ) from exc
    except Exception as exc:  # pragma: no cover. Defensive
        logger.exception("google_oauth_resolve_failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error.") from exc

    return {"api_key": client.api_key, "is_new": is_new, "is_superadmin": bool(client.is_superadmin)}


# ── account resolution ─────────────────────────────────────────────────


class _DuplicatePasswordAccount(Exception):
    """Raised when an OAuth profile's email matches a password-only account."""


def _resolve_client_for_profile(profile: GoogleProfile, billing_country: str | None = None) -> tuple[Client, bool]:
    """Find or create the Client for a verified Google profile.

    Returns ``(client, is_new)``. The Client object is detached from the
    session so the caller can read its api_key after the session closes.

    Lookup order:

    1. ``oauth_accounts`` row matching ``(provider, provider_user_id)``,
       the canonical "returning OAuth user" path. Always wins.
    2. ``clients`` row with the same email AND no password set. That's
       a Client that signed up via OAuth on a different provider (future
       providers) or had their password forcibly cleared. Safe to link.
    3. ``clients`` row with the same email AND a password. Refuse to
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
                # Refresh provider-side display info. Users update their
                # Google avatar/name independently of our DB.
                link.email = profile.email
                link.picture_url = profile.picture
                session.commit()
                _ = client.id, client.name, client.email, client.api_key, client.is_superadmin
                session.expunge(client)
                logger.info("google_oauth_login_returning client_id=%s", client.id)
                return client, False
            # Orphan link row, the Client was deleted but the OAuth row
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
            billing_country=billing_country,  # IP-detected at signup; editable in Billing details
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
        # Failure here must not block signup, the client row is the
        # important part; the plan can be retried.
        subscription = None
        try:
            from app.services.plan_service import assign_default_plan_to_client

            subscription = assign_default_plan_to_client(session, new_client.id)
        except Exception as plan_err:  # pragma: no cover. Best-effort
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
            # Both read the row or stay None, and the send below is guarded on
            # None. ``or 7`` here reported the retired offer's length even for a
            # row that says 0, and the missing-plan fallback named a trial shape
            # nothing granted. Matches the register path.
            plan = subscription.plan
            trial_credits = int(plan.credits_per_month or 0) if plan else None
            trial_duration_days = int(plan.trial_days or 0) if plan else None

        session.commit()
        session.refresh(new_client)
        _ = new_client.id, new_client.name, new_client.email, new_client.api_key, new_client.is_superadmin
        client_id = new_client.id
        client_name = new_client.name
        session.expunge(new_client)

    # Welcome email. Fire outside the DB transaction so a mail outage
    # doesn't rollback the user. Only sent when the trial fields were
    # populated; otherwise we skip cleanly rather than send a half-filled
    # template.
    # Guarded on the NUMBERS, matching the register path: the template asserts
    # both, so a zero in either would contradict the trialing subscription the
    # signup just created.
    if trial_end_at is not None and trial_credits and trial_duration_days:
        try:
            from app.services.email_service import send_trial_welcome_email

            send_trial_welcome_email(
                profile.email,
                name=client_name,
                trial_end=trial_end_at,
                credits=trial_credits,
                duration_days=trial_duration_days,
            )
        except Exception as mail_err:  # pragma: no cover. Best-effort
            logger.warning("google_oauth_welcome_email_failed client_id=%s err=%s", client_id, mail_err)
    else:
        # Skipping used to be silent, so a signup that never got its welcome
        # email left no trace to find it by.
        logger.warning(
            "google_oauth_welcome_skipped client_id=%s trial_end=%s credits=%s duration_days=%s",
            client_id,
            trial_end_at,
            trial_credits,
            trial_duration_days,
        )

    logger.info("google_oauth_signup_new client_id=%s", client_id)
    return new_client, True


# ── feature-flag endpoint ───────────────────────────────────────────────


@router.get("/status")
def google_oauth_status():
    """Tell the frontend whether the Google button should render.

    Returning a single boolean keeps the frontend logic trivial. If the
    server hasn't been configured with credentials, the button hides
    itself rather than 503-ing on click.
    """
    return {"enabled": GOOGLE_OAUTH_ENABLED}
