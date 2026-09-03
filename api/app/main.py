import asyncio
import hmac
import logging
import os
import sys
import threading
import time

# AR-43: this predates the Spider.cloud/Jina Reader crawl stack, it was
# originally needed for Playwright's subprocess-based browser automation on
# Windows (removed; the crawler is now pure HTTP against Spider/Jina, no
# local browser process). Harmless to leave in place for local Windows dev
# regardless, so not removed, just corrected here since the "Playwright"
# comment was stale.
if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from slowapi.errors import RateLimitExceeded
from sqlalchemy import inspect, select, text

from app.api.activation_routes import router as activation_router
from app.api.affiliate_routes import router as affiliate_router
from app.api.affiliate_routes import superadmin_router as affiliate_superadmin_router
from app.api.analytics_routes import router as analytics_router

# Route imports
from app.api.auth_routes import router as auth_router
from app.api.bot_routes import public_router as public_bot_router
from app.api.bot_routes import router as bot_router
from app.api.canned_response_routes import router as canned_response_router
from app.api.chat_routes import router as chat_router
from app.api.client_routes import router as client_router
from app.api.document_routes import router as document_router
from app.api.invite_routes import me_router as invite_me_router
from app.api.invite_routes import router as invite_router
from app.api.lead_routes import router as lead_router
from app.api.live_chat_audit_routes import router as live_chat_audit_router
from app.api.locale_routes import router as locale_router
from app.api.notification_routes import router as notification_router
from app.api.notification_routes import ws_router as notification_ws_router
from app.api.oauth_routes import router as oauth_router
from app.api.offline_message_routes import router as offline_message_router
from app.api.operator_routes import router as operator_router
from app.api.payment_method_routes import router as payment_method_router
from app.api.public_pricing_routes import router as public_pricing_router
from app.api.push_routes import router as push_router
from app.api.quotation_routes import router as quotation_router
from app.api.subscription_routes import credits_router
from app.api.subscription_routes import router as subscription_router
from app.api.superadmin_ops_routes import router as superadmin_ops_router
from app.api.superadmin_plan_routes import router as superadmin_plan_router
from app.api.superadmin_promotion_routes import router as superadmin_promotion_router
from app.api.superadmin_routes import router as superadmin_router
from app.api.superadmin_routes_v2 import router as superadmin_v2_router
from app.api.unsubscribe_routes import router as unsubscribe_router
from app.api.webhook_billing_routes import router as webhook_billing_router
from app.api.webhook_routes import router as webhook_router
from app.api.ws_routes import router as ws_router
from app.config import APP_ENV, DOCUMENTS_DIR
from app.core.body_limit import BodySizeLimitMiddleware
from app.core.chat_concurrency import chat_gate
from app.core.error_sanitizer import new_error_id
from app.core.exceptions import SessionOwnershipError
from app.core.middleware import (
    TimeoutMiddleware,
    generic_exception_handler,
    get_cors_origin_regex,
    get_cors_origins,
    intl_payments_disabled_handler,
    plan_not_checkoutable_handler,
    rate_limit_exceeded_handler,
    session_ownership_exception_handler,
    subscription_activation_conflict_handler,
    validation_exception_handler,
)
from app.core.rate_limit import limiter
from app.core.sentry_scrub import scrub_event
from app.db.models import Base, Bot
from app.db.models import ChatSession as CS
from app.db.session import engine, get_session
from app.services.razorpay_service import (
    IntlPaymentsDisabled,
    PlanNotCheckoutable,
    SubscriptionActivationConflict,
)

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# LiteLLM: silently drop params unsupported by the target provider.
# Without this, e.g. gpt-5 family rejects ``temperature=0`` (callers like the
# intent classifier set it for determinism) and the entire fallback chain
# fails with UnsupportedParamsError. Setting drop_params globally is the
# fix the error message itself recommends; the alternative is hardcoding
# per-model conditionals at every call site.
import litellm as _litellm  # noqa: E402

_litellm.drop_params = True

# LiteLLM's built-in "langfuse" callback targets the Langfuse v2/v3 SDK API
# (langfuse.version.__version__, Langfuse(sdk_integration=...), Langfuse.trace()).
# All three are absent in Langfuse v4 (pinned in pyproject.toml), causing
# non-blocking errors on every LLM call. The callback is intentionally not
# registered here (removed in 393a15d, 2026-06-29). RAG pipeline traces are
# emitted via the Langfuse v4 SDK directly. See app/core/langfuse_client.py
# (start_as_current_observation) and its call sites in llm_service.py /
# rag_service.py.


def _init_sentry_for_api() -> None:
    """Initialise Sentry in the API process. Must run before the FastAPI app is
    created, so that the ASGI integration wraps the finished app.

    A function rather than bare module-level statements so the wiring is
    reachable from a test. ``tests/test_sentry_no_visitor_pii.py`` asserts that both
    ``before_send`` and ``before_send_transaction`` point at the scrubber, which
    is the only thing standing between a visitor's IP address and Sentry. Mirrors
    ``app.worker.settings._init_sentry_for_worker``, which is the same call for
    the other process.
    """
    from app.config import APP_ENV, SENTRY_DSN, SENTRY_ENABLED

    if not SENTRY_ENABLED:
        reason = f"APP_ENV={APP_ENV}, production only" if SENTRY_DSN else "no DSN configured"
        logger.info(f"Sentry error tracking disabled ({reason})")
        return

    import sentry_sdk

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        environment=APP_ENV,
        # Set by CI from ``${{ github.sha }}`` so error spikes can be
        # pinned to a specific deploy. Falls back to None (Sentry will
        # auto-derive from git if available) when running locally.
        release=os.getenv("SENTRY_RELEASE") or None,
        send_default_pii=False,
        # Errors + a thin slice of tracing only. Continuous profiling and
        # structured logs are deliberately OFF: on the free plan profile hours
        # ran out and Sentry paused ingestion for the whole project, which takes
        # error reporting down with it. Do not re-enable without a paid plan.
        traces_sample_rate=0.1,
        # PRIVACY. ``send_default_pii=False`` is not enough on its own. It
        # suppresses ``user.ip_address`` and ``REMOTE_ADDR``, but the SDK still
        # attaches every request header, and its scrub list does not include
        # ``CF-Connecting-IP``, the one header that carries the real visitor
        # address behind Cloudflare, and the one ``chat_routes`` reads first.
        # Both hooks are required: Sentry routes transactions past
        # ``before_send`` entirely, and a transaction carries the same request
        # block. See ``app.core.sentry_scrub``.
        before_send=scrub_event,
        before_send_transaction=scrub_event,
    )
    # Tag every event with the service name so API and worker can be
    # filtered apart in the Sentry UI (the worker uses the same DSN
    # but tags itself ``service: worker`` in app/worker/settings.py).
    sentry_sdk.set_tag("service", "api")
    logger.info(f"Sentry error tracking enabled | env={APP_ENV}")


_init_sentry_for_api()


# Initialize FastAPI
def _docs_urls(app_env: str) -> dict[str, str | None]:
    """Docs/OpenAPI URLs. Disabled in production so the full API schema (every
    route, params, auth headers) isn't publicly served as attacker recon (F22)."""
    if app_env == "production":
        return {"docs_url": None, "redoc_url": None, "openapi_url": None}
    return {"docs_url": "/docs", "redoc_url": "/redoc", "openapi_url": "/openapi.json"}


app = FastAPI(title="RAG Backend API", version="1.0.0", **_docs_urls(APP_ENV))

# --- Rate Limiting ---
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

# --- Routers ---
app.include_router(auth_router)
app.include_router(oauth_router)
app.include_router(superadmin_router)
app.include_router(public_bot_router)
app.include_router(bot_router)
app.include_router(chat_router)
app.include_router(live_chat_audit_router)
app.include_router(quotation_router)
app.include_router(document_router)
app.include_router(analytics_router)
app.include_router(unsubscribe_router)
app.include_router(lead_router)
app.include_router(locale_router)
app.include_router(operator_router)
app.include_router(push_router)
app.include_router(activation_router)
app.include_router(invite_router)
app.include_router(invite_me_router)
app.include_router(offline_message_router)
app.include_router(canned_response_router)
app.include_router(notification_router)
app.include_router(notification_ws_router)
app.include_router(ws_router)
app.include_router(client_router)
app.include_router(webhook_router)
app.include_router(subscription_router)
app.include_router(credits_router)
app.include_router(payment_method_router)
app.include_router(public_pricing_router)
app.include_router(superadmin_plan_router)
app.include_router(superadmin_promotion_router)
app.include_router(superadmin_v2_router)
app.include_router(superadmin_ops_router)
app.include_router(webhook_billing_router)
# Affiliate program v1. Money-free referral codes + attribution.
# Two routers: public/affiliate self-serve, and super-admin management.
app.include_router(affiliate_router)
app.include_router(affiliate_superadmin_router)

# --- Exception Handlers ---
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(SessionOwnershipError, session_ownership_exception_handler)
app.add_exception_handler(IntlPaymentsDisabled, intl_payments_disabled_handler)
app.add_exception_handler(PlanNotCheckoutable, plan_not_checkoutable_handler)
app.add_exception_handler(SubscriptionActivationConflict, subscription_activation_conflict_handler)
app.add_exception_handler(Exception, generic_exception_handler)

# --- Database Initialization ---
# Required PostgreSQL extensions must exist BEFORE create_all reaches a table
# that uses them. ``referral_codes.code`` is CITEXT and ``documents.embedding``
# is pgvector ``vector``. Production runs alembic which already installs these
# (a1f9c3e6d4b2 for citext, the pgvector migration for vector). But CI + any
# test environment that imports ``app.main`` bypasses alembic and goes
# straight to ``create_all``. That path previously crashed CI with
# ``type "citext" does not exist``. Idempotent on prod (IF NOT EXISTS).
try:
    with engine.connect() as _conn:
        _conn.execute(text("CREATE EXTENSION IF NOT EXISTS citext"))
        _conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        _conn.commit()
except Exception as _ext_err:
    # Not Postgres / insufficient privileges. Skip silently; create_all will
    # surface a clearer error if a required type is missing downstream.
    logger.warning("Could not ensure pg extensions (%s). Continuing", _ext_err)

Base.metadata.create_all(bind=engine)

try:
    inspector = inspect(engine)
    if "bots" in inspector.get_table_names():
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE bots ALTER COLUMN name SET DEFAULT 'AI Assistant'"))
            conn.execute(text("ALTER TABLE bots ALTER COLUMN launcher_name SET DEFAULT 'Have Questions?'"))
            conn.execute(text("ALTER TABLE bots ALTER COLUMN primary_color SET DEFAULT '#a21caf'"))
            conn.execute(text("ALTER TABLE bots ALTER COLUMN background_color SET DEFAULT '#ffffff'"))
            conn.execute(text("ALTER TABLE bots ALTER COLUMN header_color SET DEFAULT '#3A0CA3'"))
            conn.execute(text("ALTER TABLE bots ALTER COLUMN is_active SET DEFAULT true"))
            conn.commit()
        logger.info("Bots table column defaults verified/applied")
except Exception as e:
    logger.warning(f"Could not apply bots column defaults (non-fatal): {e}")

# --- CORS ---
# Note: allow_credentials=True is incompatible with allow_origins=["*"] per the
# CORS spec. Browsers silently reject the response. When using wildcard origins
# (e.g. for an embeddable widget), credentials must be disabled.
_cors_origins = get_cors_origins()
_cors_origin_regex = get_cors_origin_regex()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=_cors_origin_regex,
    allow_credentials="*" not in _cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    # The dashboard is served from a different origin than this API, so a
    # response header is invisible to its JavaScript unless it is explicitly
    # exposed. Content-Disposition is not on the CORS-safelist. File exports
    # (the per-agent report CSV) name themselves server-side, including the
    # reporting window; without this the browser reads no filename at all and
    # the download lands as an opaque blob.
    # ``X-Error-Id`` joins it for the same reason: the correlation token on a
    # 500 is useless if the dashboard's JavaScript cannot read it off the
    # response to show the user something to quote at support.
    expose_headers=["Content-Disposition", "X-Error-Id"],
)

# --- Request Timeout (60s for non-streaming endpoints) ---
app.add_middleware(TimeoutMiddleware)

# --- Request body ceiling ---
# Registered LAST so it runs FIRST: Starlette applies middleware in reverse
# registration order, and an oversized body has to be refused before CORS,
# the timeout wrapper, or any route handler allocates against it. In
# particular this has to sit in front of /webhooks/razorpay, which reads the
# raw body before it can verify the HMAC.
app.add_middleware(BodySizeLimitMiddleware)

# Ensure directories exist
os.makedirs(DOCUMENTS_DIR, exist_ok=True)


# --- Health Check ---


def _llm_ready() -> bool:
    """Cheap LLM-path import check. Catches a hollow-namespace litellm install.

    The 2026-07-01 outage was a partial ``uv sync`` that left litellm as a
    hollow namespace package (missing ``__init__.py``): ``import litellm``
    succeeded, so the app booted, but ``litellm.completion`` was absent. Every
    chat 500'd while ``/health`` stayed green because it never touched the LLM
    path. This verifies the already-imported litellm module still exposes its
    public completion API. It is a local attribute check (**not** a network or
    paid LLM call) so it is safe to run on every health hit without caching.

    This alone does **not** detect a live provider outage (revoked key, billing
    block, provider downtime). See :func:`_llm_probe` for that.
    """
    return hasattr(_litellm, "completion")


# TTL-cached real LLM completion probe. A cheap import check (``_llm_ready``)
# cannot detect a revoked API key, a provider billing block, or a provider
# outage, the 2026-07-07 ~4h production incident (OpenAI `insufficient_quota`)
# ran the whole time with `/health/full` reporting healthy, because the only
# check was the import-attribute probe above. This makes one real, tiny,
# same-model completion call and caches the result so polling health endpoints
# (BetterStack/UptimeRobot hit both every ~60s) doesn't multiply into a burst
# of paid LLM calls.
_LLM_PROBE_TTL_SECONDS = float(os.getenv("HEALTH_LLM_PROBE_TTL_SECONDS", "30"))
_LLM_PROBE_TIMEOUT_SECONDS = float(os.getenv("HEALTH_LLM_PROBE_TIMEOUT_SECONDS", "3"))
# 1 is too low for some reasoning-capable models (e.g. gpt-5.4-mini), which
# spend part of the completion-token budget on internal reasoning tokens and
# raise BadRequestError before emitting visible output, a false-negative
# "unhealthy" for a perfectly healthy model. 16 leaves headroom for that.
_LLM_PROBE_MAX_TOKENS = int(os.getenv("HEALTH_LLM_PROBE_MAX_TOKENS", "16"))
_llm_probe_lock = threading.Lock()
_llm_probe_cache: dict = {"ts": 0.0, "ok": True, "detail": None}


def _llm_probe() -> tuple[bool, str | None]:
    """Real, TTL-cached LLM readiness probe, a live completion call, not an import check.

    Returns ``(ok, detail)``. ``detail`` is ``None`` on success, or a short
    error string (exception type + message, truncated) on failure. Skips the
    network call entirely if the cheap import check already failed, since a
    hollow litellm install can't make a completion call anyway.
    """
    if not _llm_ready():
        return False, "litellm.completion missing. Partial/namespace install"

    now = time.monotonic()
    with _llm_probe_lock:
        if now - _llm_probe_cache["ts"] < _LLM_PROBE_TTL_SECONDS:
            return _llm_probe_cache["ok"], _llm_probe_cache["detail"]

    from app.services import runtime_config

    ok = True
    detail: str | None = None
    try:
        model = runtime_config.get_primary_model()
        _litellm.completion(
            model=model,
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=_LLM_PROBE_MAX_TOKENS,
            timeout=_LLM_PROBE_TIMEOUT_SECONDS,
        )
    except Exception as e:  # noqa: BLE001 - any failure means the LLM path is down
        ok = False
        detail = f"{type(e).__name__}: {e}"[:200]

    with _llm_probe_lock:
        _llm_probe_cache["ts"] = time.monotonic()
        _llm_probe_cache["ok"] = ok
        _llm_probe_cache["detail"] = detail

    return ok, detail


def _fallback_count_1h() -> int | None:
    """Rolling count of primary->fallback LLM degradations in the last hour
    (AR-16). Surfaced here so a flaky primary provider recovering silently
    via fallback on every request is visible in `/health/full` instead of
    only discoverable by manually inspecting logs or the safety-net-metrics
    endpoint. Returns None (not 0) if the counter can't be read, so callers
    can distinguish "confirmed zero" from "unknown".
    """
    try:
        from app.core.metrics import get_metric_counts

        return sum(get_metric_counts("llm_fallback_triggered", hours=1).values())
    except Exception:  # noqa: BLE001 - health checks must never fail on this
        return None


# Invoicing v2's flags default ON, so the SELLER PROFILE is the real activation
# gate (``invoice_service.finalize_invoice``). An unset profile silently turns
# every charge into an un-numbered legacy row with no tax document. Invisible
# until a customer or a CA asks for an invoice. Surfaced here so it is
# monitorable. Deliberately NOT folded into ``fully_ok``: it is a configuration
# gap, not an outage, and must not page oncall as "API down".
_BILLING_PROBE_TTL_SECONDS = float(os.getenv("HEALTH_BILLING_PROBE_TTL_SECONDS", "300"))
_billing_probe_lock = threading.Lock()
_billing_probe_cache: dict = {"ts": 0.0, "value": None}


def _billing_readiness(session) -> dict:  # noqa: ANN001 - any Session-like works
    """Is invoicing actually issuing documents?"""
    from app.services.seller_profile_service import get_seller_profile

    try:
        if get_seller_profile(session).configured:
            return {"invoicing_active": True, "reason": None}
        return {"invoicing_active": False, "reason": "seller profile not configured"}
    except Exception as exc:  # noqa: BLE001 - health checks must never fail on this
        return {"invoicing_active": False, "reason": f"probe failed: {type(exc).__name__}"}


def _cached_billing_readiness() -> dict:
    """TTL-cached wrapper around :func:`_billing_readiness`.

    Cheap, but polled ~2880x/day across both external monitors; the underlying
    answer changes about once ever. 5 minutes is fast enough to catch a
    just-configured profile during a deploy and slow enough to cost nothing.
    Mirrors the caching already used for the LLM probe above.
    """
    now = time.monotonic()
    with _billing_probe_lock:
        cached = _billing_probe_cache
        if cached["value"] is not None and now - cached["ts"] < _BILLING_PROBE_TTL_SECONDS:
            return cached["value"]

    from app.db.session import get_session

    with get_session() as session:
        value = _billing_readiness(session)

    with _billing_probe_lock:
        _billing_probe_cache["ts"] = now
        _billing_probe_cache["value"] = value
    return value


def _gather_health() -> tuple[dict, bool, bool]:
    """Collect subsystem health.

    Returns ``(payload, ready_to_serve, fully_ok)``:
      - ``ready_to_serve``. DB + Redis reachable; the API can serve chats.
        Deliberately excludes the LLM signal so ``/health`` (the LB / deploy
        readiness gate) keeps its DB+Redis-only response-code semantics.
      - ``fully_ok``. ``ready_to_serve`` **and** worker alive (or intentionally
        disabled via ``WORKER_ENABLED=false``) **and** the litellm completion
        API is importable. A hollow-litellm install (see :func:`_llm_ready`)
        flips ``fully_ok`` to False so ``/health/full`` 503s and pages oncall,
        which the 2026-07-01 outage did not.
    """
    from datetime import UTC, datetime

    from app.core.cache import get_redis
    from app.worker.enqueue import WORKER_ENABLED
    from app.worker.tasks import WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL

    # -- Database check --
    db_ok = False
    pool_stats: dict = {}
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
            db_ok = True
        pool = engine.pool
        pool_stats = {
            "pool_size": pool.size(),
            "checked_out": pool.checkedout(),
            "overflow": pool.overflow(),
            "checked_in": pool.checkedin(),
        }
    except Exception:
        pass

    # -- Redis check --
    redis_ok = False
    redis_client = None
    try:
        redis_client = get_redis()
        if redis_client is not None:
            redis_client.ping()
            redis_ok = True
    except Exception:
        pass

    # -- Worker heartbeat check --
    # Worker writes WORKER_HEARTBEAT_KEY every 30s via cron. Key present =
    # alive within the last WORKER_HEARTBEAT_TTL seconds; key missing = worker
    # is dead, never started, or has been down longer than the TTL.
    worker_last_seen: str | None = None
    worker_age_s: float | None = None
    if not WORKER_ENABLED:
        worker_status = "disabled"
    else:
        worker_status = "missing"
        if redis_ok and redis_client is not None:
            try:
                raw = redis_client.get(WORKER_HEARTBEAT_KEY)
                if raw is not None:
                    worker_last_seen = raw
                    last_seen = datetime.fromisoformat(raw)
                    worker_age_s = (datetime.now(UTC) - last_seen).total_seconds()
                    worker_status = "alive"
            except Exception:
                pass

    # -- LLM readiness check --
    # Real, TTL-cached completion call. See _llm_probe docstring. Falls back
    # to the cheap import check's failure mode/message when the probe itself
    # short-circuits on a hollow litellm install.
    llm_ok, llm_detail = _llm_probe()

    ready_to_serve = db_ok and redis_ok
    worker_required_ok = worker_status in ("alive", "disabled")
    fully_ok = ready_to_serve and worker_required_ok and llm_ok

    if fully_ok:
        status_label = "healthy"
    elif ready_to_serve:
        status_label = "degraded"
    else:
        status_label = "unhealthy"

    payload = {
        "status": status_label,
        "database": "connected" if db_ok else "unreachable",
        "redis": "connected" if redis_ok else "unreachable",
        "worker": {
            "status": worker_status,
            "last_seen": worker_last_seen,
            "age_seconds": round(worker_age_s, 1) if worker_age_s is not None else None,
            "heartbeat_ttl_seconds": WORKER_HEARTBEAT_TTL,
        },
        "llm": {
            "status": "ready" if llm_ok else "unavailable",
            "import_ok": _llm_ready(),
            "probe_ok": llm_ok,
            "detail": llm_detail,
            "fallback_count_1h": _fallback_count_1h(),
        },
        "pool": pool_stats,
        # Chat concurrency gate (backpressure), in-flight vs the configured
        # ceiling, plus how many requests have queued/been shed. Observability
        # signal, not an outage signal. Excluded from fully_ok.
        "chat_gate": chat_gate.stats(),
        # Configuration signal, not an outage signal. Excluded from fully_ok.
        "billing": (_cached_billing_readiness() if db_ok else {"invoicing_active": False, "reason": "db unreachable"}),
        "version": "1.0.0",
    }
    return payload, ready_to_serve, fully_ok


# The detailed health payload is attacker recon when served anonymously: it
# leaks the stack (Postgres + Redis + ARQ worker), the app version (for CVE
# matching), the DB pool internals, the chat-gate concurrency ceiling (useful
# for planning a DoS), and business state (invoicing_active). External uptime
# monitors, the Nginx upstream check, and deploy gates only ever consume the
# HTTP status *code*, never the body, so the public response is reduced to the
# bare status label. The full payload is disclosed only to a caller presenting
# HEALTH_DETAIL_TOKEN via the X-Health-Token header (e.g. an internal ops curl).
# When the env var is unset the endpoints are minimal for everyone — secure by
# default, so a missing token can never silently re-expose the detail.
HEALTH_DETAIL_TOKEN = os.getenv("HEALTH_DETAIL_TOKEN") or None


def _health_detail_authorized(request: Request) -> bool:
    """True only when a valid X-Health-Token is presented (constant-time)."""
    if not HEALTH_DETAIL_TOKEN:
        return False
    supplied = request.headers.get("X-Health-Token")
    if not supplied:
        return False
    return hmac.compare_digest(supplied, HEALTH_DETAIL_TOKEN)


def _public_health_body(payload: dict, request: Request) -> dict:
    """Full detail for an authorized caller; otherwise just the status label."""
    if _health_detail_authorized(request):
        return payload
    return {"status": payload["status"]}


@app.head("/health", tags=["system"], include_in_schema=False)
def health_check_head():
    from fastapi.responses import Response

    _, ready_to_serve, _ = _gather_health()
    return Response(status_code=200 if ready_to_serve else 503)


@app.get("/health", tags=["system"])
def health_check(request: Request):
    """Readiness check for user-facing traffic.

    Returns **200** when the API can serve user requests (DB + Redis
    reachable). Returns **503** only when one of those is down. Worker
    status is reported in the body for ops visibility but does **not**
    gate the response code: a degraded worker means BANT extraction and
    async email pause, while chats themselves still work. Failing the
    deploy gate or load-balancer probe in that case would cause
    user-visible downtime that wasn't there.

    Used by deploy scripts, Nginx upstream checks, and external uptime
    monitors. The body is the bare status label unless the caller presents
    a valid ``X-Health-Token`` (see :data:`HEALTH_DETAIL_TOKEN`), which
    unlocks the full subsystem payload. For comprehensive checks (worker
    included), use ``/health/full``.
    """
    from fastapi.responses import JSONResponse

    payload, ready_to_serve, _ = _gather_health()
    return JSONResponse(
        status_code=200 if ready_to_serve else 503,
        content=_public_health_body(payload, request),
    )


@app.head("/health/full", tags=["system"], include_in_schema=False)
def health_check_full_head():
    from fastapi.responses import Response

    _, _, fully_ok = _gather_health()
    return Response(status_code=200 if fully_ok else 503)


@app.get("/health/full", tags=["system"])
def health_check_full(request: Request):
    """Comprehensive health check including the worker.

    Returns **200** only when DB + Redis + worker are all green. Returns
    **503** if any subsystem is degraded, including a missing worker
    heartbeat. Use this for alerting that should page on partial
    degradation; use ``/health`` for deploy gates and load-balancer
    probes that must not flap on transient worker hiccups.

    As with ``/health``, the detailed body is gated behind a valid
    ``X-Health-Token``; anonymous callers get only the status label while
    the response *code* still reflects full subsystem health.
    """
    from fastapi.responses import JSONResponse

    payload, _, fully_ok = _gather_health()
    return JSONResponse(
        status_code=200 if fully_ok else 503,
        content=_public_health_body(payload, request),
    )


@app.head("/health/live", tags=["system"], include_in_schema=False)
def liveness_probe_head():
    from fastapi.responses import Response

    return Response(status_code=200)


@app.get("/health/live", tags=["system"])
def liveness_probe():
    """Ultra-lightweight liveness probe. No DB/Redis calls.

    Returns 200 if the process is alive. Used by external uptime monitors
    (BetterStack, UptimeRobot) where low-latency checks are preferred.
    """
    return {"alive": True}


# --- Lifecycle Events ---


@app.on_event("shutdown")
async def shutdown_services():
    """Broadcast server restart to all WS clients, then flush services."""
    from app.services.live_chat_service import manager

    await manager.shutdown()

    from app.worker.enqueue import WORKER_ENABLED as _WORKER_ON

    if not _WORKER_ON:
        try:
            from app.services.webhook_service import stop_retry_worker

            stop_retry_worker()
        except Exception as e:
            logger.warning(f"Webhook retry worker shutdown skipped: {e}")

    from app.core.langfuse_client import flush_langfuse
    from app.core.thread_pool import shutdown_pool

    flush_langfuse()
    shutdown_pool()


@app.on_event("startup")
async def _bind_notification_broadcaster_loop():
    """Capture the FastAPI event loop for thread-safe notification fan-out.

    ``create_notification`` is invoked from both async routes (offline
    message, handoff) and sync routes (bot create, billing webhooks). The
    sync ones run in Starlette's threadpool, where ``asyncio.get_running_loop``
    raises. By binding the main loop here, the broadcaster can use
    ``run_coroutine_threadsafe`` from any context to deliver the WS event
    in real time.
    """
    import asyncio as _asyncio

    from app.services.notification_broadcaster import broadcaster as _br

    try:
        _br.bind_loop(_asyncio.get_running_loop())
        logger.info("Notification broadcaster bound to FastAPI event loop")
    except Exception:
        logger.exception("Failed to bind notification broadcaster loop")

    # Cross-process live-chat delivery. No-op unless WS_BACKPLANE_ENABLED. See
    # app/services/ws_backplane.py for why this exists and why it is off by
    # default. Started here rather than at import so it binds to the running loop.
    try:
        from app.services.live_chat_service import manager as _manager
        from app.services.ws_backplane import start as _ws_backplane_start

        # Same reason as the broadcaster above: background BANT extraction runs
        # on the shared thread pool and needs to hand its operator-console
        # broadcast back to the loop that owns the sockets and the Redis
        # publisher, instead of running it on a throwaway loop.
        _manager.bind_loop(_asyncio.get_running_loop())
        await _ws_backplane_start(_manager)
    except Exception:
        # Delivery degrades to local-only, which is exactly today's behaviour.
        logger.exception("Failed to start the live-chat WS backplane")

    # Belt-and-braces: make sure the ``notifications`` table actually exists.
    # On a fresh local DB or a deploy where alembic was skipped, the REST
    # endpoints would 500 every call and the bell would look "broken" with
    # no obvious cause. Calling ``Base.metadata.create_all`` for just this
    # one table is idempotent (``checkfirst=True`` by default) and noop on
    # any environment that already ran the migration.
    try:
        from app.db.models import Notification as _Notif

        _Notif.__table__.create(bind=engine, checkfirst=True)
        logger.info("Notifications table ready")
    except Exception:
        logger.exception("Failed to ensure notifications table exists")


@app.on_event("startup")
def backfill_session_client_ids():
    """One-time backfill: set client_id from bot_id for sessions where client_id is NULL."""
    try:
        with get_session() as session:
            null_sessions = (
                session.execute(select(CS).where(CS.client_id.is_(None), CS.bot_id.isnot(None))).scalars().all()
            )
            if null_sessions:
                for cs in null_sessions:
                    bot = session.execute(select(Bot).where(Bot.id == cs.bot_id)).scalar_one_or_none()
                    if bot:
                        cs.client_id = bot.client_id
                session.commit()
                logger.info(f"Backfilled client_id for {len(null_sessions)} chat sessions.")
    except Exception as e:
        logger.warning(f"Session client_id backfill skipped: {e}")

    # Start the in-process webhook retry poller only when the ARQ worker is
    # NOT enabled. When WORKER_ENABLED=true, ARQ cron handles retries.
    from app.worker.enqueue import WORKER_ENABLED as _WORKER_ON

    if not _WORKER_ON:
        try:
            from app.services.webhook_service import start_retry_worker

            start_retry_worker()
        except Exception as e:
            logger.warning(f"Webhook retry worker startup skipped: {e}")
    else:
        logger.info("Webhook retries handled by ARQ worker (skipping in-process poller)")


# --- Root & File Serving ---


@app.get("/")
def read_root():
    """Liveness banner for the API root.

    ``docs_url`` is reported only where the docs are actually mounted.
    ``_docs_urls`` switches them off in production specifically so the schema
    is not free recon (F22); pointing at ``/docs`` anyway told a prober the
    route exists and was merely withheld, which is the half of that decision
    worth keeping quiet.
    """
    body = {"message": "RAG Backend is running"}
    docs_url = _docs_urls(APP_ENV)["docs_url"]
    if docs_url:
        body["docs_url"] = docs_url
    return body


_ALLOWED_FILE_PREFIXES = ("logos/", "chat-files/")

# MIME types safe to serve inline (browsers won't execute these as code).
# Scriptable types (image/svg+xml, text/html, application/xhtml+xml, any
# */javascript or */xml) must NEVER be listed here: served inline from the app
# origin they enable stored XSS. Everything not listed is sent as an attachment
# with nosniff below (defense in depth alongside r2_service content-type
# neutralization. NB-1).
_INLINE_SAFE_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/heic",
        "image/heif",
        "image/avif",
        "application/pdf",
    }
)


@app.get("/files/{file_path:path}")
def serve_b2_file(file_path: str):
    """Serve a file from private B2 by proxying the content."""
    if ".." in file_path or file_path.startswith("/"):
        raise HTTPException(status_code=400, detail="Invalid file path")
    if not file_path.startswith(_ALLOWED_FILE_PREFIXES):
        raise HTTPException(status_code=403, detail="Access denied")
    from botocore.exceptions import ClientError
    from fastapi.responses import StreamingResponse

    from app.services.r2_service import get_object

    try:
        body, content_type = get_object(file_path)
    except ClientError as e:
        error_code = e.response["Error"]["Code"]
        if error_code in ("NoSuchKey", "404", "NotFound"):
            # The requested key is deliberately NOT echoed back. This path is
            # unauthenticated and the key is fully caller-controlled, so
            # reflecting it turns the 404 into a free oracle for probing the
            # bucket's namespace one guess at a time (and reflects arbitrary
            # attacker text into a response body). The key is logged instead.
            logger.info("File not found in storage: %r", file_path)
            raise HTTPException(status_code=404, detail="File not found.") from e
        error_id = new_error_id()
        logger.error("Storage error fetching %r | error_id=%s | code=%s: %s", file_path, error_id, error_code, e)
        raise HTTPException(status_code=502, detail=f"Storage backend error (ref: {error_id})") from e
    except Exception as e:
        error_id = new_error_id()
        logger.exception("Unexpected error serving %r | error_id=%s", file_path, error_id)
        raise HTTPException(status_code=500, detail=f"Internal server error (ref: {error_id})") from e

    # Force download for non-image/non-PDF types to prevent stored XSS.
    # A text/plain file with HTML content could be MIME-sniffed and executed
    # by the browser if served inline without nosniff.
    disposition = "inline" if content_type in _INLINE_SAFE_TYPES else "attachment"

    headers = {
        "Cache-Control": "public, max-age=86400, immutable",
        "Content-Disposition": disposition,
        "X-Content-Type-Options": "nosniff",
    }

    return StreamingResponse(content=body, media_type=content_type, headers=headers)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
