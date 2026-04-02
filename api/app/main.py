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

from app.api.analytics_routes import router as analytics_router

# Route imports
from app.api.auth_routes import router as auth_router
from app.api.bot_routes import router as bot_router
from app.api.canned_response_routes import router as canned_response_router
from app.api.chat_routes import router as chat_router
from app.api.client_routes import router as client_router
from app.api.document_routes import router as document_router
from app.api.lead_routes import router as lead_router
from app.api.offline_message_routes import router as offline_message_router
from app.api.operator_routes import router as operator_router
from app.api.superadmin_routes import router as superadmin_router
from app.api.ws_routes import router as ws_router
from app.config import APP_ENV, DOCUMENTS_DIR, SENTRY_DSN, SENTRY_ENABLED
from app.core.middleware import (
    TimeoutMiddleware,
    generic_exception_handler,
    get_cors_origins,
    validation_exception_handler,
)
from app.core.rate_limit import limiter
from app.db.models import Base, Bot
from app.db.models import ChatSession as CS
from app.db.session import engine, get_session

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize Sentry (must be before FastAPI app creation)
if SENTRY_ENABLED:
    import sentry_sdk

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        environment=APP_ENV,
        send_default_pii=False,
        enable_logs=True,
        traces_sample_rate=0.1,
        profile_session_sample_rate=0.1,
        profile_lifecycle="trace",
    )
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
app.include_router(superadmin_router)
app.include_router(bot_router)
app.include_router(chat_router)
app.include_router(document_router)
app.include_router(analytics_router)
app.include_router(lead_router)
app.include_router(operator_router)
app.include_router(offline_message_router)
app.include_router(canned_response_router)
app.include_router(ws_router)
app.include_router(client_router)

# --- Exception Handlers ---
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(Exception, generic_exception_handler)

# --- Database Initialization ---
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


@app.get("/health", tags=["system"])
def health_check():
    """Server health check with DB connectivity status. Used by deploy scripts and monitoring."""
    db_ok = False
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
            db_ok = True
    except Exception:
        pass

    status_code = 200 if db_ok else 503
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=status_code,
        content={
            "status": "healthy" if db_ok else "degraded",
            "database": "connected" if db_ok else "unreachable",
            "version": "1.0.0",
        },
    )


# --- Lifecycle Events ---


@app.on_event("shutdown")
async def shutdown_services():
    """BUG-18: Broadcast server restart to all WS clients, then flush services."""
    from app.services.live_chat_service import manager

    await manager.shutdown()

    from app.core.langfuse_client import flush_langfuse
    from app.core.thread_pool import shutdown_pool

    flush_langfuse()
    shutdown_pool()


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


# --- Root & File Serving ---


@app.get("/")
def read_root():
    return {"message": "RAG Backend is running", "docs_url": "/docs"}


@app.get("/files/{file_path:path}")
def serve_b2_file(file_path: str):
    """Serve a file from private B2 by proxying the content."""
    if ".." in file_path or file_path.startswith("/"):
        raise HTTPException(status_code=400, detail="Invalid file path")
    from botocore.exceptions import ClientError
    from fastapi.responses import StreamingResponse

    from app.services.b2_service import get_object

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

    headers = {
        "Cache-Control": "public, max-age=86400, immutable",
        "Content-Disposition": "inline",
    }

    return StreamingResponse(content=body, media_type=content_type, headers=headers)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
