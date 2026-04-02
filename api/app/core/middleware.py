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


async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Global handler for Pydantic validation errors."""
    logger.error(f"Validation Error: {exc.errors()}")
    return JSONResponse(
        status_code=422,
        content={
            "detail": exc.errors(),
            "message": "Invalid request body. Check types and required fields.",
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

    return [
        "http://localhost",
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:8000",
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
    ]
