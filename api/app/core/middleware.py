import asyncio
import logging
import os

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response

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
            logger.warning(f"Request timed out after {_REQUEST_TIMEOUT_SECONDS}s: {request.method} {path}")
            return JSONResponse(
                status_code=504,
                content={"detail": "Request timed out. Please try again."},
            )


# Longest rejected value echoed back in a 422. The caller sent it, so it is
# not a disclosure — but reflecting a megabyte of input turns every rejected
# oversized request into an amplified response.
_MAX_ECHOED_INPUT_CHARS = 200


def _serializable_error(error: dict) -> dict:
    """Make one Pydantic error entry safe to place in a JSON response.

    Two problems with returning ``exc.errors()`` verbatim, both reachable from
    any client:

    * ``input`` holds the value that failed. If that value is ``NaN`` or
      ``±Infinity`` — which ``json.loads`` accepts, so a client really can
      send one — ``json.dumps`` raises ``ValueError: Out of range float values
      are not JSON compliant`` while rendering the 422. The exception escapes
      the handler and the caller gets a 500, which reports a *server* fault
      for what is squarely a bad request.
    * ``input`` is echoed at full length, so rejecting a 10 MB string meant
      writing that string back out again.

    ``ctx`` has the same exposure: it can carry the original ``ValueError``
    instance for a custom validator, which is not JSON-serializable either.
    """
    safe = {k: v for k, v in error.items() if k not in ("input", "ctx", "url")}
    if "input" in error:
        rendered = repr(error["input"])
        if len(rendered) > _MAX_ECHOED_INPUT_CHARS:
            rendered = rendered[:_MAX_ECHOED_INPUT_CHARS] + "…"
        safe["input"] = rendered
    ctx = error.get("ctx")
    if isinstance(ctx, dict):
        # Keep the constraint metadata (``max_length``, ``ge`` …) that tells
        # the caller what the limit actually is; stringify anything else.
        safe["ctx"] = {k: (v if isinstance(v, int | float | str | bool | None) else str(v)) for k, v in ctx.items()}
    return safe


async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Global handler for Pydantic validation errors.

    Logged at WARNING, not ERROR: a rejected request is the validation layer
    working. At ERROR every scanner probe and every mistyped field paged
    whoever watches the error stream, which is how real errors get tuned out.
    """
    errors = [_serializable_error(e) for e in exc.errors()]
    logger.warning("Validation error on %s %s: %s", request.method, request.url.path, errors)
    return JSONResponse(
        status_code=422,
        content={
            "detail": errors,
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
    the 409 ``intl_usd_pending`` contract the checkout quote already renders —
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
    policy refusal, not a bug — but a real buyer reached a tier this environment
    cannot charge, which is a wiring gap someone has to close. The operator
    instruction itself is logged once, at ERROR, by the service layer.
    """
    logger.warning("Checkout refused — plan not wired for the gateway: %s", exc)
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

    The customer has PAID by the time this fires — only the local switch-over
    could not complete — so the response says so explicitly (``payment_captured``)
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
    """Catch-all handler for unhandled exceptions. Tags Sentry events with request context."""
    logger.error(f"Unhandled error on {request.method} {request.url.path}: {type(exc).__name__}: {exc}", exc_info=True)

    # Enrich Sentry event with request context
    try:
        from app.config import SENTRY_ENABLED

        if SENTRY_ENABLED:
            import sentry_sdk

            sentry_sdk.set_tag("endpoint", request.url.path)
            sentry_sdk.set_tag("method", request.method)
    except Exception:
        pass  # Never let Sentry tagging break the error response

    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


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

    # Dev origins — kept permissive for the local widget-on-test-site flow.
    # The widget inherits the host page's origin, so the API has to accept
    # whichever port the test page is being served from. Covers: Vite preview
    # (4173), VSCode Live Server (5500), http-server / serve / python -m
    # http.server (8080, 8000, 3000), Next.js (3000), CRA (3000), and the
    # 127.0.0.1 aliases (browsers treat 127.0.0.1 and localhost as DIFFERENT
    # origins for CORS — both must be allowlisted).
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
    origin), so this stays ``None`` — we never quietly widen an explicit
    production allowlist to arbitrary subdomains.
    """
    env = os.getenv("APP_ENV", "development")
    if env == "production":
        return None
    return (
        r"^https?://([a-z0-9-]+\.)*(localhost|lvh\.me|localtest\.me)(:\d+)?$"
        r"|^https?://127\.0\.0\.1(:\d+)?$"
    )
