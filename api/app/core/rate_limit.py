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
        # config.py should have already raised — this is a defensive guard.
        logger.error("Rate limiter: in-memory backend in production — Redis should be required!")
    else:
        logger.info("Rate limiter: in-memory backend (dev mode)")


def key_from_bot_key(request: Request) -> str:
    """Rate-limit key derived from X-Bot-Key header (widget traffic)."""
    return request.headers.get("x-bot-key", get_remote_address(request))


def key_from_api_key(request: Request) -> str:
    """Rate-limit key derived from X-API-Key header (admin/client traffic)."""
    return request.headers.get("x-api-key", get_remote_address(request))


limiter = Limiter(
    key_func=get_remote_address,
    default_limits=[],
    storage_uri=_storage_uri,
)
