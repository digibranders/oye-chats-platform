"""Signed unsubscribe tokens. HMAC-SHA256, mirrors the state-token pattern
in ``oauth_service.py``.

Without a signature, ``/leads/unsubscribe`` would take a bare
``bot_id`` + ``email`` and suppress it. Anyone could hit the endpoint
with an arbitrary address and silently block a competitor's leads from
ever receiving a follow-up. Signing the pair closes that off.
"""

import base64
import hashlib
import hmac

from app.config import UNSUBSCRIBE_SECRET


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def make_unsubscribe_token(bot_id: int, email: str) -> str:
    """Build a signed `body.sig` token embedding bot_id + email."""
    body = _b64url_encode(f"{bot_id}:{email.strip().lower()}".encode())
    sig = _b64url_encode(hmac.new(UNSUBSCRIBE_SECRET.encode(), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_unsubscribe_token(token: str) -> tuple[int, str] | None:
    """Verify signature and return (bot_id, email), or None if invalid."""
    if not token or "." not in token:
        return None

    body, sig = token.rsplit(".", 1)
    expected_sig = _b64url_encode(hmac.new(UNSUBSCRIBE_SECRET.encode(), body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected_sig):
        return None

    try:
        bot_id_str, email = _b64url_decode(body).decode("utf-8").split(":", 1)
        return int(bot_id_str), email
    except (ValueError, UnicodeDecodeError):
        return None
