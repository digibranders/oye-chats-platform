"""Negative-path security tests for the Google OAuth ``state`` token.

``tests/test_oauth_promo_attribution.py`` covers the happy path (issue → verify
round-trips, and the promo/referral payload survives). It does not cover any way
the token can be *attacked*, which is what the token exists for: ``state`` is
the CSRF defence on the OAuth callback, and it also carries promo/affiliate
attribution that a user must not be able to self-grant.

Every check below fails if the corresponding guard is removed — swapping
``hmac.compare_digest`` for ``==`` still passes the existing round-trip test,
but forging a signature here would then succeed.
"""

from __future__ import annotations

import base64
import json
import time

import pytest

from app.services.oauth_service import (
    OAuthError,
    issue_state_token,
    verify_state_token,
)


def _split(token: str) -> tuple[str, str]:
    body, sig = token.rsplit(".", 1)
    return body, sig


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _reseal_body(payload: dict) -> str:
    """Re-encode a payload WITHOUT a valid signature (attacker capability)."""
    return _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))


# ── Baseline: the token round-trips ──────────────────────────────────────────


def test_issued_token_verifies_and_carries_its_payload():
    token = issue_state_token(next_path="/billing", mode="register", promo_code="SAVE10", referral_code="AFF9")
    payload = verify_state_token(token)
    assert payload["next"] == "/billing"
    assert payload["mode"] == "register"
    assert payload["promo"] == "SAVE10"
    assert payload["ref"] == "AFF9"
    assert payload["n"]  # nonce present — the cookie/URL pair is built on it


def test_each_token_carries_a_fresh_nonce():
    """The nonce is what binds the cookie copy to the URL copy; reusing one
    across flows would make the CSRF check meaningless."""
    a = verify_state_token(issue_state_token())
    b = verify_state_token(issue_state_token())
    assert a["n"] != b["n"]


# ── Tampering ────────────────────────────────────────────────────────────────


def test_tampered_payload_is_rejected():
    """The attack that matters: rewrite the payload (here, self-granting a promo
    code the page never had) and keep the original signature."""
    token = issue_state_token(next_path="/", mode="register")
    body, sig = _split(token)
    payload = json.loads(_b64url_decode(body))
    payload["promo"] = "FREE100"  # never issued by the server
    forged = f"{_reseal_body(payload)}.{sig}"

    with pytest.raises(OAuthError):
        verify_state_token(forged)


def test_redirect_target_cannot_be_rewritten():
    """``next`` drives a post-login redirect — an open-redirect vector if it
    could be swapped without invalidating the signature."""
    token = issue_state_token(next_path="/billing")
    body, sig = _split(token)
    payload = json.loads(_b64url_decode(body))
    payload["next"] = "https://evil.example/steal"
    with pytest.raises(OAuthError):
        verify_state_token(f"{_reseal_body(payload)}.{sig}")


def test_forged_signature_is_rejected():
    token = issue_state_token()
    body, _sig = _split(token)
    with pytest.raises(OAuthError):
        verify_state_token(f"{body}.{_b64url_encode(b'not-the-real-signature')}")


def test_signature_from_a_different_token_is_rejected():
    """Signature substitution: both halves are individually valid, but they do
    not belong together."""
    body_a, _ = _split(issue_state_token(next_path="/a"))
    _, sig_b = _split(issue_state_token(next_path="/b"))
    with pytest.raises(OAuthError):
        verify_state_token(f"{body_a}.{sig_b}")


def test_unsigned_payload_is_rejected():
    """A caller cannot simply drop the signature and present a bare payload."""
    payload = {"n": "x", "next": "/", "mode": "login", "ts": int(time.time()), "cl": "web"}
    with pytest.raises(OAuthError):
        verify_state_token(_reseal_body(payload))  # no ".sig" at all


# ── Malformed input ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("bad", ["", None, "no-dot-separator", ".", "..."])
def test_missing_or_structurally_invalid_tokens_are_rejected(bad):
    with pytest.raises(OAuthError):
        verify_state_token(bad)


def test_non_json_payload_is_rejected_without_leaking_an_internal_error():
    """A signature-valid body that isn't JSON must surface as OAuthError, not a
    raw JSONDecodeError escaping to the callback route."""
    import hashlib
    import hmac as _hmac

    from app.services.oauth_service import OAUTH_STATE_SECRET

    body = _b64url_encode(b"this is not json")
    sig = _b64url_encode(_hmac.new(OAUTH_STATE_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    with pytest.raises(OAuthError):
        verify_state_token(f"{body}.{sig}")


# ── Expiry ───────────────────────────────────────────────────────────────────


def test_expired_token_is_rejected():
    """A correctly-signed but stale state token must not be replayable — this is
    the window an intercepted callback URL would be reused in."""
    from app.services import oauth_service

    token = issue_state_token()
    # Travel past the max age rather than sleeping.
    real_time = time.time
    try:
        oauth_service.time.time = lambda: real_time() + oauth_service.STATE_MAX_AGE_SECONDS + 60
        with pytest.raises(OAuthError):
            verify_state_token(token)
    finally:
        oauth_service.time.time = real_time


def test_token_with_missing_or_zero_timestamp_is_rejected():
    """``ts`` absent/0 must fail closed, not be treated as 'issued at epoch and
    therefore fine'."""
    import hashlib
    import hmac as _hmac

    from app.services.oauth_service import OAUTH_STATE_SECRET

    for ts in (0, None):
        payload = {"n": "x", "next": "/", "mode": "login", "cl": "web"}
        if ts is not None:
            payload["ts"] = ts
        body = _reseal_body(payload)
        sig = _b64url_encode(
            _hmac.new(OAUTH_STATE_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
        )
        with pytest.raises(OAuthError):
            verify_state_token(f"{body}.{sig}")


def test_a_token_just_inside_the_window_still_verifies():
    """Boundary in the other direction — the expiry check must not reject a
    token that is still legitimately fresh."""
    from app.services import oauth_service

    token = issue_state_token()
    real_time = time.time
    try:
        oauth_service.time.time = lambda: real_time() + oauth_service.STATE_MAX_AGE_SECONDS - 5
        assert verify_state_token(token)["next"] == "/"
    finally:
        oauth_service.time.time = real_time
