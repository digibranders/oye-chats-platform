"""Redis cache utilities.

All operations are **best-effort**: if Redis is unavailable or not configured,
every function degrades gracefully (returns ``None`` / ``False`` / ``0``)
so the application works identically without Redis.

Key prefix ``oyechats:`` namespaces all keys so the same Redis instance can be
shared with other services without collisions.
"""

import hashlib
import json
import logging
from typing import Any

from app.config import APP_ENV, REDIS_URL

logger = logging.getLogger(__name__)

# ── Lazy singleton ──────────────────────────────────────────────────────────
_redis_client = None
_redis_unavailable = False  # latch: stop retrying after first connection failure

PREFIX = "oyechats:"

# TTL constants (seconds)
BOT_CONFIG_TTL = 600  # 10 minutes
QA_RESPONSE_TTL = 3600  # 1 hour
# Bump whenever the system prompt or the response style changes. The QA cache
# stores finished answers for ``QA_RESPONSE_TTL``; without this segment in the
# key, every answer written under the previous prompt kept being served for up
# to an hour after a prompt deploy. Keys written before the segment existed are
# the implicit version 1, so 2 is the first value that invalidates them.
#: Bump whenever the assembled prompt changes, so a deploy retires the answers the
#: old prompt wrote instead of serving them for the rest of ``QA_RESPONSE_TTL``.
#: 3: the media-card rule was restored in 159fc1e2 and shipped without a bump, so
#: on 2026-09-10 two of three topical questions on a live bot were answered from
#: an hour-old cache written under the previous rule. ``tests/test_qa_cache_prompt_version.py``
#: fingerprints the prompt so the next change cannot ship without one.
QA_PROMPT_VERSION = 3
TRANSLATION_TTL = 86400  # 24 hours (Phase 4 operator translation)


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
    except Exception as exc:
        if APP_ENV == "production":
            logger.error("Redis connection failed in production. This is a critical dependency", exc_info=True)
            raise RuntimeError(
                "Redis connection failed in production. Check REDIS_URL and ensure Redis is reachable."
            ) from exc
        logger.warning("Redis connection failed. Caching disabled for this process", exc_info=True)
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

    Returns the count of deleted keys.
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


def qa_response_key(bot_id: int, question_hash: str, lang: str | None = None) -> str:
    """Cache key for a cached QA response.

    ``lang`` partitions the cache by conversation language for multilingual bots
    so a Hindi question can never be served an English cached answer that hashed
    to the same question bucket. It is passed ONLY when multilingual is enabled
    for the bot; when it is ``None`` (every bot with the feature off) the key
    carries no language segment.

    The ``v{QA_PROMPT_VERSION}`` segment sits right after the bot id so that
    ``qa_prefix_for_bot`` still reaches every key, and so that a prompt deploy
    (which bumps the constant) retires the old answers at once instead of
    serving them until the TTL runs out.
    """
    if lang:
        return f"{PREFIX}qa:{bot_id}:v{QA_PROMPT_VERSION}:{lang}:{question_hash}"
    return f"{PREFIX}qa:{bot_id}:v{QA_PROMPT_VERSION}:{question_hash}"


def translation_key(source_language: str, target_language: str, text: str) -> str:
    """Cache key for one translation (Phase 4).

    HASH-ONLY BY DESIGN. The message text never appears in the key, so a Redis
    keyspace dump (``SCAN``, ``--bigkeys``, a slowlog entry) discloses nothing
    about what visitors and operators said. For the same reason the key must
    never be logged next to the text it was derived from, which would make the
    hash reversible from the log.

    DELIBERATELY CROSS-TENANT. The value is a pure function of
    (source, target, text), so two workspaces sending byte-identical text share
    one entry. A hit reveals nothing the caller could not obtain by making the
    call themselves, and the key is a preimage-resistant hash of content the
    caller already holds. Recorded here as a decision, not an accident: if a
    customer segment ever needs strict isolation, prefix with ``client_id`` and
    nothing else changes.

    The ``v1`` segment lets a prompt/model change invalidate every entry at
    once without a keyspace sweep.
    """
    digest = hashlib.sha256(f"{source_language}|{target_language}|{text}".encode()).hexdigest()
    return f"{PREFIX}translation:v1:{digest}"


def qa_prefix_for_bot(bot_id: int) -> str:
    """Key prefix for all QA cache entries of a specific bot (for bulk invalidation)."""
    return f"{PREFIX}qa:{bot_id}:"


def gate_prefix_for_bot(bot_id: int) -> str:
    """Key prefix for all relevance-gate cache entries of a specific bot.

    Used to bulk-invalidate stale gate judgments after a knowledge-base change:
    without this, an "off-topic" judgment cached before the upload would
    survive for an hour even after fresh docs make the question answerable.
    Must match the layout in ``relevance_gate._gate_cache_key``, which is
    ``gate:v{prompt_version}:b{bot_id}:{kb_version}:{hash}``. It did not: the
    version segment was added to the key and not to this prefix, so every
    caller of ``cache_delete_prefix(gate_prefix_for_bot(...))`` deleted nothing
    for as long as the mismatch stood, and the two existing tests that cover
    those callers patch this function with a fabricated prefix, so the mock is
    what hid it. Imported lazily because ``relevance_gate`` imports this
    module.
    """
    from app.services.relevance_gate import _GATE_PROMPT_VERSION

    return f"{PREFIX}gate:v{_GATE_PROMPT_VERSION}:b{bot_id}:"
