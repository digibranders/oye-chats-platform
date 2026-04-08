"""Rate limiting via SlowAPI.

Backend storage is chosen at startup:
- If ``REDIS_URL`` env var is set, Redis is used for globally consistent limits
  across all uvicorn workers.
- Otherwise, falls back to in-memory counters.  With N workers the effective
  limit is ~N× the configured value; this is acceptable for single-server
  deployments where the primary goal is protecting LLM API costs.

Upgrade path: set ``REDIS_URL=redis://localhost:6379`` in production .env.
"""

import logging
import os

from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request

logger = logging.getLogger(__name__)

_REDIS_URL = os.getenv("REDIS_URL")

if _REDIS_URL:
    _storage_uri = _REDIS_URL
    logger.info(f"Rate limiter: Redis backend ({_REDIS_URL})")
else:
    _storage_uri = "memory://"
    import multiprocessing

    _workers = int(os.getenv("WEB_CONCURRENCY", multiprocessing.cpu_count()))
    if _workers > 1:
        logger.warning(
            f"Rate limiter: in-memory backend with {_workers} workers — "
            f"effective limits are ~{_workers}× configured values. "
            "Set REDIS_URL for global enforcement."
        )
    else:
        logger.info("Rate limiter: in-memory backend (single worker)")


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
