"""Per-bot daily quota for owner-preview chat requests.

Preview chats (Build Studio ``?preview=true``. See ``app/api/auth.py`` and
``chat_routes.py``) skip ``ai_chat`` credit deduction entirely so a bot owner
can freely test their own bot from the dashboard. Left unbounded, an
owner-authenticated caller could proxy real visitor traffic through preview
and run unlimited free LLM completions with no cap and no cost. That's the
bug this module closes: preview stays free, but bounded.

Redis-unavailable degradation mirrors ``crawler_service``'s locks/progress
helpers (see ``app/services/crawler_service.py``):
  - If Redis was never configured / never connected (``get_redis()`` returns
    ``None``, the normal case for single-worker local dev), fall back to an
    in-process counter dict. This still enforces the real cap locally; it
    just doesn't share state across processes, which matches every other
    Redis-backed helper in this codebase.
  - If a *configured* Redis raises mid-call (a transient outage in
    production), this fails OPEN, the request is allowed through uncapped
    for that call. This matches the existing precedent in
    ``crawler_service.acquire_crawl_lock``: a rare, bounded abuse window
    during a genuine Redis blip is preferable to a hard wall that breaks
    every customer's preview testing until Redis recovers.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from app.config import PREVIEW_DAILY_LIMIT
from app.core.cache import PREFIX, get_redis

logger = logging.getLogger(__name__)

_KEY_PREFIX = f"{PREFIX}preview:"
# Self-expiring TTL slightly over 24h so a key created just before midnight
# UTC still comfortably outlives that UTC day before Redis reaps it, the
# per-day key (below) is what actually resets the count, not this TTL.
_TTL_SECONDS = 90000  # 25h

# In-process fallback for single-worker dev (no Redis). Mirrors
# crawler_service._local_locks / _local_progress. Keyed by "{bot_id}:{YYYYMMDD}"
# -> count. Production always runs Redis (required by config.py), so this
# dict is never populated there.
_local_counts: dict[str, int] = {}


def _day_bucket(bot_id: int) -> str:
    """Return the ``"{bot_id}:{YYYYMMDD}"`` bucket key for "today" (UTC)."""
    today = datetime.now(UTC).strftime("%Y%m%d")
    return f"{int(bot_id)}:{today}"


def check_and_increment_preview(bot_id: int) -> bool:
    """Atomically increment today's preview-chat counter for ``bot_id``.

    Returns ``True`` while the post-increment count is at or under
    ``PREVIEW_DAILY_LIMIT`` (this call may proceed). Returns ``False`` once
    the count exceeds the limit, the caller must reject the request
    (HTTP 429) *before* generating an LLM reply, not after.

    Call this exactly once per preview chat request, before generation.
    """
    bucket = _day_bucket(bot_id)
    client = get_redis()
    if client is None:
        count = _local_counts.get(bucket, 0) + 1
        _local_counts[bucket] = count
        return count <= PREVIEW_DAILY_LIMIT

    redis_key = f"{_KEY_PREFIX}{bucket}"
    try:
        count = client.incr(redis_key)
        if count == 1:
            # Only the first writer of a fresh day's key sets the TTL.
            # Avoids resetting the expiry (and thus the effective window)
            # on every single request.
            client.expire(redis_key, _TTL_SECONDS)
        return count <= PREVIEW_DAILY_LIMIT
    except Exception:
        logger.warning(
            "check_and_increment_preview: Redis error for bot_id=%s. Failing open (request allowed)",
            bot_id,
            exc_info=True,
        )
        return True
