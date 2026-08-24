"""Rate limiting via SlowAPI.

Backend storage is chosen at startup:
- If ``REDIS_URL`` env var is set, Redis is used for globally consistent limits
  across all uvicorn workers.
- Otherwise, falls back to in-memory counters (development only).

Redis is **required** in production (enforced by ``config.py``).  The in-memory
fallback exists solely for local development convenience.
"""

import logging
import os

from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request

logger = logging.getLogger(__name__)

_REDIS_URL = os.getenv("REDIS_URL")
_APP_ENV = os.getenv("APP_ENV", "development")

if _REDIS_URL:
    _storage_uri = _REDIS_URL
    logger.info("Rate limiter: Redis backend")
else:
    _storage_uri = "memory://"
    if _APP_ENV == "production":
        # config.py should have already raised. This is a defensive guard.
        logger.error("Rate limiter: in-memory backend in production. Redis should be required!")
    else:
        logger.info("Rate limiter: in-memory backend (dev mode)")


def key_from_bot_key(request: Request) -> str:
    """Rate-limit key for widget traffic. Composite ``<bot-key>:<client-ip>``.

    The X-Bot-Key is public (embedded in every embed script), so keying the
    limit on it *alone* puts every visitor of a bot into one shared bucket:
    anyone who copies the key can exhaust that bucket and starve the legitimate
    widget (and, since each chat request deducts the owner's credits, help drain
    the balance). Folding the caller's IP in gives each source its own bucket, so
    a single abusive origin can no longer monopolise the limit or lock out other
    visitors. Falls back to IP-only when the header is absent.

    Note: this bounds abuse per source IP; a distributed (many-IP) credit drain
    still needs a per-bot daily budget ceiling. Tracked as a §0.3 follow-up.
    """
    ip = get_remote_address(request)
    bot_key = request.headers.get("x-bot-key")
    return f"{bot_key}:{ip}" if bot_key else ip


def key_from_api_key(request: Request) -> str:
    """Rate-limit key derived from X-API-Key header (admin/client traffic)."""
    return request.headers.get("x-api-key", get_remote_address(request))


def key_from_operator_credential(request: Request) -> str:
    """Rate-limit key for routes that accept EITHER operator or client auth.

    The inbox is reachable two ways: a team member presents ``X-Operator-Key``,
    a workspace owner presents ``X-API-Key`` (see
    ``get_current_client_or_operator``). ``key_from_api_key`` reads only the
    latter, so every operator-key caller would fall through to its default and
    share one bucket keyed on IP, letting one operator throttle their whole
    team from behind a shared office NAT. Prefer the operator key, fall back to
    the client key, then the address.
    """
    return (
        request.headers.get("x-operator-key")
        or request.headers.get("x-agent-key")
        or request.headers.get("x-api-key")
        or get_remote_address(request)
    )


limiter = Limiter(
    key_func=get_remote_address,
    default_limits=[],
    storage_uri=_storage_uri,
)


# Failed sign-ins tolerated per account before that account is throttled,
# independent of where the attempts come from. The per-IP `@limiter.limit`
# on the login routes bounds one source; this bounds one TARGET, which is the
# dimension password-spraying from a proxy pool attacks. Deliberately a
# throttle and not a lockout: a permanent lock would hand any attacker a
# denial-of-service against any account whose e-mail they know.
_FAILED_LOGIN_LIMIT = "10/15 minutes"


def login_attempts_exhausted(identity: str) -> bool:
    """``True`` when ``identity`` has spent its failed-sign-in budget.

    ``identity`` is the submitted e-mail address (lowercased by the caller),
    the only account handle an unauthenticated request carries. A pure read:
    it does not consume budget, so calling it on every attempt (including the
    successful ones) is free. Rides the same ``limits`` storage as every other
    limit in this module, so the count is shared across Gunicorn workers rather
    than being a per-process guess.

    Fail-OPEN on a storage error, the opposite of :mod:`app.core.otp_guard`:
    a broken counter here would lock every customer out of their own account,
    and the per-IP limit on the route is still in force underneath.
    """
    from limits import parse

    try:
        return not limiter.limiter.test(parse(_FAILED_LOGIN_LIMIT), "login", identity)
    except Exception:  # noqa: BLE001 - never let a counter outage become an outage
        logger.warning("failed_login_counter_unavailable. Allowing the attempt", exc_info=True)
        return False


def note_failed_login(identity: str) -> None:
    """Record one failed sign-in against ``identity``."""
    from limits import parse

    try:
        limiter.limiter.hit(parse(_FAILED_LOGIN_LIMIT), "login", identity)
    except Exception:  # noqa: BLE001 - see login_attempts_exhausted
        logger.warning("failed_login_counter_unavailable. Attempt not counted", exc_info=True)


def clear_failed_logins(identity: str) -> None:
    """Reset an account's failed-sign-in count after a successful login."""
    from limits import parse

    try:
        limiter.limiter.clear(parse(_FAILED_LOGIN_LIMIT), "login", identity)
    except Exception:  # noqa: BLE001 - cosmetic cleanup
        logger.debug("failed_login_counter_clear_failed", exc_info=True)


def money_route_limit(scope: str, *limit_strings: str):
    """Per-client rate-limit DEPENDENCY for the money routes (M7, Wave 3.2).

    The ``@limiter.limit`` decorator resolves the request by finding a
    parameter literally NAMED ``request``, and on the billing routes that
    name belongs to the Pydantic body, so decorating them would hand the body
    model to the key function. A FastAPI dependency gets the real ``Request``
    unambiguously, and hits the SAME shared storage (Redis in prod) through
    slowapi's underlying ``limits`` strategy.

    Keys on the client's API key (falling back to IP pre-auth), so the ceiling
    is per account, not per office NAT. ``scope`` names the route family so
    each route gets its OWN bucket, without it, equal limit strings across
    /checkout and /topup share one storage key and ten failed checkout
    attempts would 429 an unrelated top-up. Limits are deliberately generous,
    an abuse ceiling that real customers can never feel.
    """
    from fastapi import HTTPException
    from limits import parse

    parsed = [parse(item) for item in limit_strings]

    def _dep(request: Request) -> None:
        key = key_from_api_key(request)
        for item in parsed:
            if not limiter.limiter.hit(item, "money", scope, key):
                # Retry-After mirrors slowapi's own handler: the window reset
                # tells a well-behaved client exactly how long to back off.
                reset_at, _remaining = limiter.limiter.get_window_stats(item, "money", scope, key)
                import time as _time

                retry_after = max(1, int(reset_at - _time.time()))
                raise HTTPException(
                    status_code=429,
                    detail="Too many billing requests. Please wait a moment and try again.",
                    headers={"Retry-After": str(retry_after)},
                )

    return _dep
