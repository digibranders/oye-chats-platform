"""Redis cache utilities (Upstash-compatible).

All operations are **best-effort**: if Redis is unavailable or not configured,
every function degrades gracefully (returns ``None`` / ``False`` / ``0``)
so the application works identically without Redis.

Key prefix ``oyechats:`` namespaces all keys in shared Upstash instances.
"""

import json
import logging
from typing import Any

from app.config import REDIS_URL

logger = logging.getLogger(__name__)

# ── Lazy singleton ──────────────────────────────────────────────────────────
_redis_client = None
_redis_unavailable = False  # latch: stop retrying after first connection failure

PREFIX = "oyechats:"

# TTL constants (seconds)
BOT_CONFIG_TTL = 600  # 10 minutes
QA_RESPONSE_TTL = 3600  # 1 hour


def get_redis():
    """Return a Redis client (lazy singleton) or ``None`` if not configured."""
    global _redis_client, _redis_unavailable

    if _redis_unavailable or not REDIS_URL:
        return None

    if _redis_client is not None:
        return _redis_client

    try:
        import redis

        _redis_client = redis.from_url(
            REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=3,
            retry_on_timeout=True,
        )
        # Verify the connection
        _redis_client.ping()
        logger.info("Redis connection established")
        return _redis_client
    except Exception:
        logger.warning("Redis connection failed — caching disabled for this process", exc_info=True)
        _redis_unavailable = True
        _redis_client = None
        return None


# ── Core operations ─────────────────────────────────────────────────────────


def cache_get(key: str) -> dict | list | str | None:
    """GET a JSON-deserialized value by full key. Returns ``None`` on miss or error."""
    client = get_redis()
    if client is None:
        return None
    try:
        raw = client.get(key)
        if raw is None:
            return None
        return json.loads(raw)
    except Exception:
        logger.debug("cache_get failed for key=%s", key, exc_info=True)
        return None


def cache_set(key: str, value: Any, ttl: int) -> bool:
    """SET a JSON-serialized value with TTL (seconds). Returns success flag."""
    client = get_redis()
    if client is None:
        return False
    try:
        client.set(key, json.dumps(value, default=str), ex=ttl)
        return True
    except Exception:
        logger.debug("cache_set failed for key=%s", key, exc_info=True)
        return False


def cache_delete(key: str) -> bool:
    """Delete a single key. Returns ``True`` if the key was removed."""
    client = get_redis()
    if client is None:
        return False
    try:
        return bool(client.delete(key))
    except Exception:
        logger.debug("cache_delete failed for key=%s", key, exc_info=True)
        return False


def cache_delete_prefix(prefix: str) -> int:
    """Delete all keys matching ``prefix*`` via SCAN (non-blocking).

    Upstash supports SCAN natively.  Returns the count of deleted keys.
    """
    client = get_redis()
    if client is None:
        return 0
    try:
        deleted = 0
        cursor = 0
        while True:
            cursor, keys = client.scan(cursor=cursor, match=f"{prefix}*", count=100)
            if keys:
                deleted += client.delete(*keys)
            if cursor == 0:
                break
        if deleted:
            logger.info("cache_delete_prefix(%s*) removed %d keys", prefix, deleted)
        return deleted
    except Exception:
        logger.debug("cache_delete_prefix failed for prefix=%s", prefix, exc_info=True)
        return 0


# ── Convenience key builders ────────────────────────────────────────────────


def bot_config_key(bot_key: str) -> str:
    """Cache key for a bot's configuration, looked up by its public bot_key."""
    return f"{PREFIX}bot:{bot_key}"


def qa_response_key(bot_id: int, question_hash: str) -> str:
    """Cache key for a cached QA response."""
    return f"{PREFIX}qa:{bot_id}:{question_hash}"


def qa_prefix_for_bot(bot_id: int) -> str:
    """Key prefix for all QA cache entries of a specific bot (for bulk invalidation)."""
    return f"{PREFIX}qa:{bot_id}:"
