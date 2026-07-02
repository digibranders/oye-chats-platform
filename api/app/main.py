import asyncio
import logging
import os
import sys

# Fix for Playwright on Windows:
if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import inspect, select, text

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
from app.api.lead_routes import router as lead_router
from app.api.notification_routes import router as notification_router
from app.api.notification_routes import ws_router as notification_ws_router
from app.api.oauth_routes import router as oauth_router
from app.api.offline_message_routes import router as offline_message_router
from app.api.operator_routes import router as operator_router
from app.api.public_pricing_routes import router as public_pricing_router
from app.api.subscription_routes import credits_router
from app.api.subscription_routes import router as subscription_router
from app.api.superadmin_ops_routes import router as superadmin_ops_router
from app.api.superadmin_plan_routes import router as superadmin_plan_router
from app.api.superadmin_routes import router as superadmin_router
from app.api.superadmin_routes_v2 import router as superadmin_v2_router
from app.api.webhook_billing_routes import router as webhook_billing_router
from app.api.webhook_routes import router as webhook_router
from app.api.ws_routes import router as ws_router
from app.config import APP_ENV, DOCUMENTS_DIR, SENTRY_DSN, SENTRY_ENABLED
from app.core.exceptions import SessionOwnershipError
from app.core.middleware import (
    TimeoutMiddleware,
    generic_exception_handler,
    get_cors_origins,
    session_ownership_exception_handler,
    validation_exception_handler,
)
from app.core.rate_limit import limiter
from app.db.models import Base, Bot
from app.db.models import ChatSession as CS
from app.db.session import engine, get_session

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

# Register the lightweight Langfuse callback so every LiteLLM completion is
# logged as a `generation` observation with the model name, prompt/completion
# tokens, cost, and latency populated. Without this, the rag-pipeline trace
# wrapper in rag_service.py only emits a `chain` span — explaining the
# "model: unknown / 0 tokens / $0" gap surfaced on /observability.
#
# We use the plain "langfuse" callback (REST API) instead of "langfuse_otel"
# because the OTEL variant caused APIConnectionError under memory pressure on
# the production droplet — see CLAUDE.md and config.LANGFUSE_FORCE_DISABLE.

# LiteLLM's built-in "langfuse" callback targets the Langfuse v2/v3 SDK API
# (langfuse.version.__version__, Langfuse(sdk_integration=...), Langfuse.trace()).
# All three are absent in Langfuse v4, causing non-blocking errors on every
# LLM call. The callback is intentionally not registered here.
# RAG pipeline traces are emitted via the Langfuse v4 SDK directly in
# rag_service.py using start_as_current_observation / propagate_attributes.

# Initialize Sentry (must be before FastAPI app creation)
if SENTRY_ENABLED:
    import sentry_sdk

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        environment=APP_ENV,
        # Set by CI from ``${{ github.sha }}`` so error spikes can be
        # pinned to a specific deploy. Falls back to None (Sentry will
        # auto-derive from git if available) when running locally.
        release=os.getenv("SENTRY_RELEASE") or None,
        send_default_pii=False,
        enable_logs=True,
        traces_sample_rate=0.1,
        profile_session_sample_rate=0.1,
        profile_lifecycle="trace",
    )
    # Tag every event with the service name so API and worker can be
    # filtered apart in the Sentry UI (the worker uses the same DSN
    # but tags itself ``service: worker`` in app/worker/settings.py).
    sentry_sdk.set_tag("service", "api")
    logger.info(f"Sentry error tracking enabled | env={APP_ENV}")
else:
    logger.info("Sentry error tracking disabled (no DSN configured)")

# Initialize FastAPI
app = FastAPI(title="RAG Backend API", version="1.0.0")

# --- Rate Limiting ---
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# --- Routers ---
app.include_router(auth_router)
app.include_router(oauth_router)
app.include_router(superadmin_router)
app.include_router(public_bot_router)
app.include_router(bot_router)
app.include_router(chat_router)
app.include_router(document_router)
app.include_router(analytics_router)
app.include_router(lead_router)
app.include_router(operator_router)
app.include_router(offline_message_router)
app.include_router(canned_response_router)
app.include_router(notification_router)
app.include_router(notification_ws_router)
app.include_router(ws_router)
app.include_router(client_router)
app.include_router(webhook_router)
app.include_router(subscription_router)
app.include_router(credits_router)
app.include_router(public_pricing_router)
app.include_router(superadmin_plan_router)
app.include_router(superadmin_v2_router)
app.include_router(superadmin_ops_router)
app.include_router(webhook_billing_router)
# Affiliate program v1 — money-free referral codes + attribution.
# Two routers: public/affiliate self-serve, and super-admin management.
app.include_router(affiliate_router)
app.include_router(affiliate_superadmin_router)

# --- Exception Handlers ---
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(SessionOwnershipError, session_ownership_exception_handler)
app.add_exception_handler(Exception, generic_exception_handler)

# --- Database Initialization ---
# Required PostgreSQL extensions must exist BEFORE create_all reaches a table
# that uses them — ``referral_codes.code`` is CITEXT and ``documents.embedding``
# is pgvector ``vector``. Production runs alembic which already installs these
# (a1f9c3e6d4b2 for citext, the pgvector migration for vector). But CI + any
# test environment that imports ``app.main`` bypasses alembic and goes
# straight to ``create_all`` — that path previously crashed CI with
# ``type "citext" does not exist``. Idempotent on prod (IF NOT EXISTS).
try:
    with engine.connect() as _conn:
        _conn.execute(text("CREATE EXTENSION IF NOT EXISTS citext"))
        _conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        _conn.commit()
except Exception as _ext_err:
    # Not Postgres / insufficient privileges. Skip silently; create_all will
    # surface a clearer error if a required type is missing downstream.
    logger.warning("Could not ensure pg extensions (%s) — continuing", _ext_err)

Base.metadata.create_all(bind=engine)

try:
    inspector = inspect(engine)
    if "bots" in inspector.get_table_names():
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE bots ALTER COLUMN name SET DEFAULT 'AI Assistant'"))
            conn.execute(text("ALTER TABLE bots ALTER COLUMN launcher_name SET DEFAULT 'Have Questions?'"))
            conn.execute(text("ALTER TABLE bots ALTER COLUMN primary_color SET DEFAULT '#ba68c8'"))
            conn.execute(text("ALTER TABLE bots ALTER COLUMN background_color SET DEFAULT '#ffffff'"))
            conn.execute(text("ALTER TABLE bots ALTER COLUMN header_color SET DEFAULT '#3A0CA3'"))
            conn.execute(text("ALTER TABLE bots ALTER COLUMN is_active SET DEFAULT true"))
            conn.commit()
        logger.info("Bots table column defaults verified/applied")
except Exception as e:
    logger.warning(f"Could not apply bots column defaults (non-fatal): {e}")

# --- CORS ---
# Note: allow_credentials=True is incompatible with allow_origins=["*"] per the
# CORS spec — browsers silently reject the response. When using wildcard origins
# (e.g. for an embeddable widget), credentials must be disabled.
_cors_origins = get_cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials="*" not in _cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Request Timeout (60s for non-streaming endpoints) ---
app.add_middleware(TimeoutMiddleware)

# Ensure directories exist
os.makedirs(DOCUMENTS_DIR, exist_ok=True)


# --- Health Check ---


def _llm_ready() -> bool:
    """Cheap LLM-path readiness signal for ``/health/full``.

    The 2026-07-01 outage was a partial ``uv sync`` that left litellm as a
    hollow namespace package (missing ``__init__.py``): ``import litellm``
    succeeded, so the app booted, but ``litellm.completion`` was absent — every
    chat 500'd while ``/health`` stayed green because it never touched the LLM
    path. This verifies the already-imported litellm module still exposes its
    public completion API. It is a local attribute check — **not** a network or
    paid LLM call — so it is safe to run on every health hit without caching.
    """
    return hasattr(_litellm, "completion")


def _gather_health() -> tuple[dict, bool, bool]:
    """Collect subsystem health.

    Returns ``(payload, ready_to_serve, fully_ok)``:
      - ``ready_to_serve`` — DB + Redis reachable; the API can serve chats.
        Deliberately excludes the LLM signal so ``/health`` (the LB / deploy
        readiness gate) keeps its DB+Redis-only response-code semantics.
      - ``fully_ok`` — ``ready_to_serve`` **and** worker alive (or intentionally
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
    # Local attribute probe, not a paid/network call — see _llm_ready docstring.
    llm_ok = _llm_ready()

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
            "import_ok": llm_ok,
            "detail": None if llm_ok else "litellm.completion missing — partial/namespace install",
        },
        "pool": pool_stats,
        "version": "1.0.0",
    }
    return payload, ready_to_serve, fully_ok


@app.head("/health", tags=["system"], include_in_schema=False)
def health_check_head():
    from fastapi.responses import Response

    _, ready_to_serve, _ = _gather_health()
    return Response(status_code=200 if ready_to_serve else 503)


@app.get("/health", tags=["system"])
def health_check():
    """Readiness check for user-facing traffic.

    Returns **200** when the API can serve user requests (DB + Redis
    reachable). Returns **503** only when one of those is down. Worker
    status is reported in the body for ops visibility but does **not**
    gate the response code: a degraded worker means BANT extraction and
    async email pause, while chats themselves still work — failing the
    deploy gate or load-balancer probe in that case would cause
    user-visible downtime that wasn't there.

    Used by deploy scripts, Nginx upstream checks, and external uptime
    monitors. For comprehensive checks (worker included), use
    ``/health/full``.
    """
    from fastapi.responses import JSONResponse

    payload, ready_to_serve, _ = _gather_health()
    return JSONResponse(status_code=200 if ready_to_serve else 503, content=payload)


@app.head("/health/full", tags=["system"], include_in_schema=False)
def health_check_full_head():
    from fastapi.responses import Response

    _, _, fully_ok = _gather_health()
    return Response(status_code=200 if fully_ok else 503)


@app.get("/health/full", tags=["system"])
def health_check_full():
    """Comprehensive health check including the worker.

    Returns **200** only when DB + Redis + worker are all green. Returns
    **503** if any subsystem is degraded — including a missing worker
    heartbeat. Use this for alerting that should page on partial
    degradation; use ``/health`` for deploy gates and load-balancer
    probes that must not flap on transient worker hiccups.
    """
    from fastapi.responses import JSONResponse

    payload, _, fully_ok = _gather_health()
    return JSONResponse(status_code=200 if fully_ok else 503, content=payload)


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
    return {"message": "RAG Backend is running", "docs_url": "/docs"}


_ALLOWED_FILE_PREFIXES = ("logos/", "chat-files/")

# MIME types safe to serve inline (browsers won't execute these as code).
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
            raise HTTPException(status_code=404, detail=f"File not found: {file_path}") from e
        logger.error(f"B2 error fetching {file_path}: {e}")
        raise HTTPException(status_code=502, detail="Storage backend error") from e
    except Exception as e:
        logger.error(f"Unexpected error serving {file_path}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error") from e

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
