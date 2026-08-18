import asyncio
import logging
import os
import time

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response

from app.core.error_sanitizer import (
    loggable_validation_errors,
    new_error_id,
    public_error_body,
    public_validation_errors,
)

logger = logging.getLogger(__name__)

# Paths exempt from the global request timeout (streaming / long-running).
_TIMEOUT_EXEMPT_PREFIXES = ("/crawl", "/chat/stream", "/ws")

# Default timeout for non-exempt endpoints (seconds).
_REQUEST_TIMEOUT_SECONDS = 60


class TimeoutMiddleware(BaseHTTPMiddleware):
    """Enforce a hard timeout on non-streaming endpoints.

    With only 2 uvicorn workers, a single stuck request can halve capacity.
    This middleware returns 504 instead of hanging indefinitely.  Streaming,
    WebSocket, and crawl endpoints are exempt.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        path = request.url.path
        if any(path.startswith(prefix) for prefix in _TIMEOUT_EXEMPT_PREFIXES):
            return await call_next(request)

        try:
            return await asyncio.wait_for(call_next(request), timeout=_REQUEST_TIMEOUT_SECONDS)
        except TimeoutError:
            error_id = new_error_id()
            logger.warning(
                "Request timed out after %ss: %s %s | error_id=%s",
                _REQUEST_TIMEOUT_SECONDS,
                request.method,
                path,
                error_id,
            )
            return JSONResponse(
                status_code=504,
                content=public_error_body("Request timed out. Please try again.", error_id=error_id),
            )


async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Return a 422 that names the bad fields without echoing what was sent.

    Two things changed here, and both were disclosures rather than bugs:

    1. The response body was ``exc.errors()`` verbatim, which in Pydantic v2
       carries ``url`` (the exact framework minor version) and ``input`` (the
       submitted value, credentials included). ``app.core.error_sanitizer``
       explains the shape in full; the client now gets ``type``/``loc``/``msg``,
       which is all the dashboard ever read.

    2. The log line was ``logger.error`` over those same raw values, so a
       mistyped login body wrote the password's neighbourhood into journalctl
       and, via the Sentry log integration, off the box entirely. It is now
       WARNING (a 422 is the caller's mistake, not an incident, and paging on it
       buried real 500s) over the redacted rendering, with the route attached so
       the line is still actionable.
    """
    logger.warning(
        "Validation rejected on %s %s: %s",
        request.method,
        request.url.path,
        loggable_validation_errors(exc.errors()),
    )
    return JSONResponse(
        status_code=422,
        content={
            "detail": public_validation_errors(exc.errors()),
            "message": "Invalid request body. Check types and required fields.",
        },
    )


async def session_ownership_exception_handler(request: Request, exc):
    """Handle ``SessionOwnershipError`` by returning a 404 ``session_not_found``.

    Logged at INFO (not ERROR): this is an expected outcome for stale legacy
    session_ids, not a bug. The widget retries with a fresh session_id.
    """
    logger.info(
        "Session ownership rejected on %s %s: session_id=%s expected_bot=%s actual_bot=%s",
        request.method,
        request.url.path,
        getattr(exc, "session_id", None),
        getattr(exc, "expected_bot_id", None),
        getattr(exc, "actual_bot_id", None),
    )
    return JSONResponse(
        status_code=404,
        content={"detail": "Session not found", "code": "session_not_found"},
    )


async def intl_payments_disabled_handler(request: Request, exc):
    """Map ``IntlPaymentsDisabled`` (service-layer USD kill switch, P1-2/F8) to
    the 409 ``intl_usd_pending`` contract the checkout quote already renders,
    so /change-plan, /resume and /seats surface the same contact-sales card
    instead of an opaque 5xx when a non-Indian account hits a paid action with
    international payments off. Logged at WARNING: it is a policy refusal the
    ops team may want to notice (a real customer wanted to pay), not a bug.
    """
    logger.warning("USD-rail request refused (INTL_PAYMENTS_ENABLED off): %s", exc)
    return JSONResponse(
        status_code=409,
        content={
            "detail": {
                "reason": "intl_usd_pending",
                "message": "USD billing for international customers is coming soon. Please contact sales.",
                "contact_sales": "developer@oyechats.com",
            }
        },
    )


async def plan_not_checkoutable_handler(request: Request, exc):
    """Map ``PlanNotCheckoutable`` (no gateway plan id for the resolved rail) to
    the same contact-sales 409 ``/subscriptions/checkout/quote`` returns for the
    same plan.

    A tier with no Razorpay plan id stays LISTED and degrades to contact-sales
    rather than disappearing from the pricing catalog, so the quote and the
    charge have to agree: before this, the quote answered
    ``inr_plan_unconfigured`` with a sales address while ``POST /checkout`` 400'd
    with the raw operator instruction ("Create the plan in the Razorpay dashboard
    …") as the customer-facing message. ``exc.reason`` carries the quote's own
    code, so the frontend branches on one vocabulary across both surfaces.

    Logged at WARNING, matching ``intl_payments_disabled_handler``: it is a
    policy refusal, not a bug, but a real buyer reached a tier this environment
    cannot charge, which is a wiring gap someone has to close. The operator
    instruction itself is logged once, at ERROR, by the service layer.
    """
    logger.warning("Checkout refused. Plan not wired for the gateway: %s", exc)
    return JSONResponse(
        status_code=409,
        content={
            "detail": {
                "reason": getattr(exc, "reason", "inr_plan_unconfigured"),
                "message": str(exc),
                "contact_sales": "developer@oyechats.com",
            }
        },
    )


async def subscription_activation_conflict_handler(request: Request, exc):
    """Map ``SubscriptionActivationConflict`` to a structured 409 instead of the
    raw 500 the underlying ``IntegrityError`` used to produce mid-checkout.

    The customer has PAID by the time this fires (only the local switch-over
    could not complete) so the response says so explicitly (``payment_captured``)
    and the message never mentions the constraint. The operator instruction lives
    in ``exc.ops_detail`` and is logged here, at ERROR: unlike the two policy
    refusals above this is not "working as designed", it means a client holds two
    subscriptions in one scope and somebody has to decide which one to refund.
    """
    logger.error(
        "Subscription activation conflict on %s %s: %s",
        request.method,
        request.url.path,
        getattr(exc, "ops_detail", exc),
    )
    return JSONResponse(
        status_code=409,
        content={
            "detail": {
                "reason": getattr(exc, "reason", "subscription_activation_conflict"),
                "message": str(exc),
                "payment_captured": True,
                "support": "developer@oyechats.com",
            }
        },
    )


async def generic_exception_handler(request: Request, exc: Exception):
    """Catch-all for unhandled exceptions: generic body out, full traceback in the log.

    The body carries an ``error_id`` (an opaque per-occurrence token, also set
    as the ``X-Error-Id`` response header) that appears verbatim on the log
    line and on the Sentry event. That handle is the reason this response can
    afford to say nothing else: support can resolve "it broke, here's the code"
    to an exact traceback without the traceback ever leaving the box, which is
    the pressure that talks teams into re-enabling verbose errors.

    Outside production the body additionally carries ``debug`` (exception type
    and message). ``error_sanitizer.debug_hint`` fails closed on an unset or
    unrecognised ``APP_ENV``, so this is the one deliberate prod/dev divergence
    and it defaults to the production side.
    """
    error_id = new_error_id()
    logger.error(
        "Unhandled error on %s %s | error_id=%s | %s: %s",
        request.method,
        request.url.path,
        error_id,
        type(exc).__name__,
        exc,
        exc_info=True,
    )

    # Enrich Sentry event with request context
    try:
        from app.config import SENTRY_ENABLED

        if SENTRY_ENABLED:
            import sentry_sdk

            sentry_sdk.set_tag("endpoint", request.url.path)
            sentry_sdk.set_tag("method", request.method)
            # The same token the caller was handed, so a support ticket quoting
            # it lands on the Sentry issue without a timestamp-and-hope search.
            sentry_sdk.set_tag("error_id", error_id)
    except Exception:
        pass  # Never let Sentry tagging break the error response

    return JSONResponse(
        status_code=500,
        content=public_error_body("Internal server error", error_id=error_id, exc=exc),
        headers={"X-Error-Id": error_id},
    )


def _retry_after_seconds(request: Request) -> int | None:
    """Seconds until the caller's window resets, or ``None`` if unknowable.

     Read straight from the limiter's storage rather than by calling SlowAPI's
     ``_inject_headers``, which is gated behind ``Limiter(headers_enabled=True)``
    , and turning that on would add a storage round-trip to *every* response on
     a chat API, to serve a header that only matters on the rare 429. This runs
     on the 429 path alone.
    """
    view_limit = getattr(request.state, "view_rate_limit", None)
    limiter = getattr(request.app.state, "limiter", None)
    if not view_limit or limiter is None:
        return None
    try:
        reset_at, _remaining = limiter.limiter.get_window_stats(view_limit[0], *view_limit[1])
        return max(1, int(reset_at - time.time()))
    except Exception:  # noqa: BLE001 - a dead storage backend must not turn a 429 into a 500
        logger.debug("Could not compute Retry-After for rate-limited request", exc_info=True)
        return None


def rate_limit_exceeded_handler(request: Request, exc):
    """429 handler that speaks the same JSON dialect as every other error here.

    SlowAPI's stock handler answers ``{"error": "Rate limit exceeded: 5 per 1
    minute"}``. Two problems, one cosmetic and one substantive:

    - It is the only error in the app with no ``detail`` key, which is why
      ``app/src/services/api.js`` carries a special case for it. ``detail`` is
      added; ``error`` is kept verbatim so nothing reading it today breaks.

    - It publishes the exact configured ceiling and window, which is the one
      number a credential-stuffing or credit-drain run wants, it says precisely
      how slowly to grind to stay under the limit. The body no longer states it.

    Withholding it costs a legitimate client nothing, because the timing they
    actually need now arrives as ``Retry-After``, which SlowAPI was not sending
    at all (``headers_enabled`` defaults off), leaving every 429 on this service
    with no machine-readable backoff signal. A 429 without ``Retry-After`` is an
    incomplete answer under RFC 6585 §4, and the widget had nothing to pace
    itself with.
    """
    retry_after = _retry_after_seconds(request)
    logger.warning(
        "Rate limit hit on %s %s (limit=%s, retry_after=%s)",
        request.method,
        request.url.path,
        getattr(exc, "detail", "unknown"),
        retry_after,
    )

    body: dict = {
        "detail": "Too many requests. Please slow down and try again shortly.",
        "error": "Rate limit exceeded",
    }
    headers: dict[str, str] = {}
    if retry_after is not None:
        body["retry_after_seconds"] = retry_after
        headers["Retry-After"] = str(retry_after)
    return JSONResponse(status_code=429, content=body, headers=headers)


def get_cors_origins() -> list[str]:
    """Return CORS origins based on environment.

    In production, reads from CORS_ORIGINS env var (comma-separated).
    If set to "*", returns ["*"] for wildcard (credentials will be disabled
    in main.py since browsers reject wildcard + credentials).
    In development, allows common localhost ports.
    """
    env = os.getenv("APP_ENV", "development")
    if env == "production":
        origins_str = os.getenv("CORS_ORIGINS", "")
        if origins_str.strip() == "*":
            return ["*"]
        if origins_str:
            return [o.strip() for o in origins_str.split(",") if o.strip()]
        return []

    # Dev origins. Kept permissive for the local widget-on-test-site flow.
    # The widget inherits the host page's origin, so the API has to accept
    # whichever port the test page is being served from. Covers: Vite preview
    # (4173), VSCode Live Server (5500), http-server / serve / python -m
    # http.server (8080, 8000, 3000), Next.js (3000), CRA (3000), and the
    # 127.0.0.1 aliases (browsers treat 127.0.0.1 and localhost as DIFFERENT
    # origins for CORS, both must be allowlisted).
    _dev_ports = [
        "3000",
        "3001",
        "4173",
        "5173",
        "5174",
        "5175",
        "5184",
        "5500",
        "5501",
        "8000",
        "8080",
        "8081",
        "8888",
    ]
    origins: list[str] = ["http://localhost", "http://127.0.0.1"]
    for port in _dev_ports:
        origins.append(f"http://localhost:{port}")
        origins.append(f"http://127.0.0.1:{port}")
    return origins


def get_cors_origin_regex() -> str | None:
    """Regex of additional allowed origins, or ``None`` to disable.

    The explicit dev allowlist above can't enumerate subdomains (``test.localhost``,
    ``community.localhost``, ``test.lvh.me`` …), and the cross-subdomain session
    feature is specifically exercised on such hosts. In development we therefore
    match any subdomain of ``localhost`` / ``lvh.me`` / ``localtest.me`` (the
    loopback dev domains) on any port, over http or https.

    In production the embeddable widget relies on ``CORS_ORIGINS='*'`` (any
    origin), so this stays ``None``. We never quietly widen an explicit
    production allowlist to arbitrary subdomains.
    """
    env = os.getenv("APP_ENV", "development")
    if env == "production":
        return None
    return (
        r"^https?://([a-z0-9-]+\.)*(localhost|lvh\.me|localtest\.me)(:\d+)?$"
        r"|^https?://127\.0\.0\.1(:\d+)?$"
    )
