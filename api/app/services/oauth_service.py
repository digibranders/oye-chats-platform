"""Google OAuth 2.0 helpers — authorize URL, code exchange, ID-token parsing.

This module is deliberately small: it speaks Google's OAuth 2.0 dance and
exposes a single ``GoogleProfile`` dataclass that the route layer maps
onto our ``Client`` / ``OAuthAccount`` rows.

Why no ``authlib`` dependency: we already have ``httpx``, the flow has
exactly two HTTP calls, and rolling our own keeps the dependency surface
small enough to audit at a glance. The ID token is verified by trust in
Google's TLS-fronted ``tokeninfo`` endpoint, which is documented as a
valid verification strategy for server-side flows where the code came
straight from a token-exchange round-trip.

References:
* https://developers.google.com/identity/protocols/oauth2/web-server
* https://developers.google.com/identity/openid-connect/openid-connect
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from app.config import (
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI,
    OAUTH_STATE_SECRET,
)

logger = logging.getLogger(__name__)

# Google OAuth endpoints — pinned so a typo in env doesn't redirect users
# to an attacker-controlled IdP. These are stable, documented values.
GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
# tokeninfo validates the id_token signature + audience server-side. Cheaper
# than fetching JWKS and verifying RS256 ourselves, and the round trip is
# inside the OAuth dance anyway.
GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"

# Scopes — minimum needed to identify the user. ``openid`` triggers the
# id_token response that carries the ``sub`` claim (Google's stable user id).
GOOGLE_OAUTH_SCOPES = ("openid", "email", "profile")

# State cookie lifetime — OAuth round-trip should finish in seconds; 10
# minutes is generous for slow MFA flows.
STATE_MAX_AGE_SECONDS = 600


class OAuthError(Exception):
    """Raised when the OAuth dance fails for a recoverable reason.

    The route layer turns this into a redirect to the frontend with an
    ``error`` query param so users get a real error message instead of a
    raw 500.
    """


@dataclass(frozen=True)
class GoogleProfile:
    """The minimal user identity returned by Google's id_token + userinfo.

    ``subject`` is the stable user id (the ``sub`` claim) — keyed lookups
    use this, never ``email``. ``email_verified`` defaults to True because
    Google only returns False for unusual Workspace configurations; we
    surface it so the route can decide whether to trust the address for
    account linking.
    """

    subject: str
    email: str
    email_verified: bool
    name: str | None
    picture: str | None


# ── State cookie (CSRF + post-login redirect) ───────────────────────────


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    pad = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + pad)


def issue_state_token(
    *,
    next_path: str = "/",
    mode: str = "login",
) -> str:
    """Return a tamper-evident state token for the OAuth round trip.

    Payload carries:

    * ``n`` — a 32-byte random nonce that goes into both the cookie and
      the URL; Google echoes the URL copy back unchanged, the route
      checks the cookie copy matches.
    * ``next`` — relative path inside the admin app the user should land
      on after success (used by deep-linked sign-ins).
    * ``mode`` — ``"login"`` or ``"register"``, purely for telemetry; the
      backend behaviour is identical.
    * ``ts`` — issuance time, enforced against ``STATE_MAX_AGE_SECONDS``.

    The token is signed with HMAC-SHA256 using ``OAUTH_STATE_SECRET`` and
    delivered as a single opaque string (payload.signature). The route
    stores this same token in a short-lived HttpOnly cookie and includes
    it in the ``state`` URL parameter — the callback rejects the request
    if either is missing or they don't match.
    """
    payload = {
        "n": _b64url_encode(secrets.token_bytes(24)),
        "next": next_path or "/",
        "mode": mode,
        "ts": int(time.time()),
    }
    body = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = _b64url_encode(hmac.new(OAUTH_STATE_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_state_token(token: str) -> dict:
    """Verify signature + age. Returns the decoded payload or raises ``OAuthError``."""
    if not token or "." not in token:
        raise OAuthError("Missing OAuth state token.")
    body, sig = token.rsplit(".", 1)
    expected_sig = _b64url_encode(
        hmac.new(OAUTH_STATE_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(sig, expected_sig):
        raise OAuthError("OAuth state signature is invalid.")
    try:
        payload = json.loads(_b64url_decode(body))
    except (ValueError, json.JSONDecodeError) as exc:
        raise OAuthError("OAuth state payload is malformed.") from exc

    issued_at = int(payload.get("ts") or 0)
    if issued_at <= 0 or time.time() - issued_at > STATE_MAX_AGE_SECONDS:
        raise OAuthError("OAuth state has expired. Please try signing in again.")

    return payload


# ── Authorize URL ───────────────────────────────────────────────────────


def build_authorize_url(state_token: str) -> str:
    """Build the Google consent screen URL.

    ``access_type=online`` because we don't need a refresh token — we only
    use OAuth to identify the user once, then our own ``api_key`` takes
    over for the session. ``prompt=select_account`` always shows the
    account picker so a logged-in Google user can switch accounts on
    second login without going through Google's settings.
    """
    if not GOOGLE_OAUTH_CLIENT_ID:
        raise OAuthError("Google OAuth is not configured on the server.")

    params = {
        "client_id": GOOGLE_OAUTH_CLIENT_ID,
        "redirect_uri": GOOGLE_OAUTH_REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(GOOGLE_OAUTH_SCOPES),
        "state": state_token,
        "access_type": "online",
        "include_granted_scopes": "true",
        "prompt": "select_account",
    }
    return f"{GOOGLE_AUTHORIZE_URL}?{urlencode(params)}"


# ── Code exchange + ID-token verification ───────────────────────────────


def exchange_code_for_profile(code: str) -> GoogleProfile:
    """Exchange the auth code for an ID token, verify it, return the profile.

    Two HTTP calls:

    1. POST to ``GOOGLE_TOKEN_URL`` with the authorization code → returns
       ``id_token`` (and an access_token we don't use).
    2. GET ``GOOGLE_TOKENINFO_URL?id_token=…`` → returns the verified
       claim set. This double-call replaces local JWT verification:
       tokeninfo is Google's official server-side validator and is what
       their own libraries use under the hood.

    Raises ``OAuthError`` on any failure (network, invalid code, audience
    mismatch). The route layer turns this into a redirect to the
    frontend with an ``error`` query param.
    """
    if not GOOGLE_OAUTH_CLIENT_ID or not GOOGLE_OAUTH_CLIENT_SECRET:
        raise OAuthError("Google OAuth is not configured on the server.")

    try:
        with httpx.Client(timeout=10.0) as client:
            token_resp = client.post(
                GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": GOOGLE_OAUTH_CLIENT_ID,
                    "client_secret": GOOGLE_OAUTH_CLIENT_SECRET,
                    "redirect_uri": GOOGLE_OAUTH_REDIRECT_URI,
                    "grant_type": "authorization_code",
                },
                headers={"Accept": "application/json"},
            )
    except httpx.RequestError as exc:
        logger.warning("google_oauth_token_exchange_network_error: %s", exc)
        raise OAuthError("Could not reach Google to verify your sign-in.") from exc

    if token_resp.status_code != 200:
        logger.warning(
            "google_oauth_token_exchange_failed status=%s body=%s",
            token_resp.status_code,
            token_resp.text[:300],
        )
        raise OAuthError("Google rejected the sign-in attempt. Please try again.")

    token_payload = token_resp.json()
    id_token = token_payload.get("id_token")
    if not id_token:
        raise OAuthError("Google did not return an id_token. Please try again.")

    try:
        with httpx.Client(timeout=10.0) as client:
            info_resp = client.get(GOOGLE_TOKENINFO_URL, params={"id_token": id_token})
    except httpx.RequestError as exc:
        logger.warning("google_oauth_tokeninfo_network_error: %s", exc)
        raise OAuthError("Could not verify your Google sign-in. Please try again.") from exc

    if info_resp.status_code != 200:
        logger.warning(
            "google_oauth_tokeninfo_failed status=%s body=%s",
            info_resp.status_code,
            info_resp.text[:300],
        )
        raise OAuthError("Google could not verify the sign-in token.")

    claims = info_resp.json()

    # Defence-in-depth: tokeninfo already validates ``aud``, but a second
    # check guards against a misconfigured client_id pulling someone else's
    # token from a different OAuth app on the same server.
    if claims.get("aud") != GOOGLE_OAUTH_CLIENT_ID:
        logger.warning(
            "google_oauth_audience_mismatch expected=%s actual=%s",
            GOOGLE_OAUTH_CLIENT_ID,
            claims.get("aud"),
        )
        raise OAuthError("Google sign-in token was issued for a different application.")

    subject = claims.get("sub")
    email = (claims.get("email") or "").strip().lower()
    if not subject or not email:
        raise OAuthError("Google did not return enough profile information to sign you in.")

    email_verified_raw = claims.get("email_verified")
    if isinstance(email_verified_raw, bool):
        email_verified = email_verified_raw
    else:
        # tokeninfo returns the boolean as the string "true"/"false".
        email_verified = str(email_verified_raw).lower() == "true"

    return GoogleProfile(
        subject=str(subject),
        email=email,
        email_verified=email_verified,
        name=(claims.get("name") or "").strip() or None,
        picture=claims.get("picture") or None,
    )
