"""In-memory rate limiting via SlowAPI (no Redis required).

With 2 uvicorn workers the effective limit is ~2× the configured value
(each worker has its own counter).  This is acceptable for abuse prevention
on a 2 GB droplet — the primary goal is protecting LLM API costs and
preventing crawl abuse, not precise per-second enforcement.
"""

from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request


def key_from_bot_key(request: Request) -> str:
    """Rate-limit key derived from X-Bot-Key header (widget traffic)."""
    return request.headers.get("x-bot-key", get_remote_address(request))


def key_from_api_key(request: Request) -> str:
    """Rate-limit key derived from X-API-Key header (admin/client traffic)."""
    return request.headers.get("x-api-key", get_remote_address(request))


limiter = Limiter(
    key_func=get_remote_address,
    default_limits=[],
    storage_uri="memory://",
)
