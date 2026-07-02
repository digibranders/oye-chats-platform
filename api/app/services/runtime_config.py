"""Runtime configuration resolver.

Wraps the ``PricingConfig`` key-value table with strongly-typed getters so
super-admin tunables (LLM models, RAG knobs, etc.) can be edited at runtime
without a code deploy or systemd restart.

Reads are cached in memory for ``_TTL_SECONDS`` so the hot path doesn't take
a DB hit on every chat request. Writes (super-admin PUTs) call
``invalidate_runtime_config_cache`` so the next read sees fresh values.

Falls back to ``app.config`` constants when a key isn't set in the DB —
i.e. the env-var defaults remain authoritative until an admin opts in.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from sqlalchemy import select

from app.config import (
    CHUNK_OVERLAP,
    CHUNK_SIZE,
    CRAWL_PROVIDER_PRIMARY,
    FALLBACK_MODEL,
    LLM_MODEL,
)
from app.db.models import PricingConfig
from app.db.session import get_session

logger = logging.getLogger(__name__)

# 60-second cache: long enough to keep the hot path off the DB, short enough
# that operators see their changes propagate without a restart.
_TTL_SECONDS = 60.0

_cache: dict[str, Any] = {}
_cache_loaded_at: float = 0.0
_cache_lock = threading.Lock()


def _load_cache() -> None:
    """Reload the entire pricing_config table into the in-memory cache."""
    global _cache, _cache_loaded_at
    try:
        with get_session() as session:
            rows = session.execute(select(PricingConfig)).scalars().all()
            _cache = {r.key: r.value for r in rows}
            _cache_loaded_at = time.time()
    except Exception:  # noqa: BLE001
        # If the DB is briefly unavailable we keep the previous cache. The
        # caller will fall back to env defaults via the ``default`` arg.
        logger.exception("runtime_config: failed to reload cache; keeping previous values")


def invalidate_runtime_config_cache() -> None:
    """Force the next ``get`` to reload from the DB. Call after every write."""
    global _cache_loaded_at
    with _cache_lock:
        _cache_loaded_at = 0.0


def _ensure_fresh() -> None:
    if time.time() - _cache_loaded_at > _TTL_SECONDS:
        with _cache_lock:
            if time.time() - _cache_loaded_at > _TTL_SECONDS:
                _load_cache()


def get(key: str, default: Any = None) -> Any:
    """Return the runtime value for ``key``, falling back to ``default``."""
    _ensure_fresh()
    return _cache.get(key, default)


# ── Strongly-typed accessors for the hot paths ──────────────────────────────


def get_primary_model() -> str:
    return str(get("model.primary", LLM_MODEL))


def get_fallback_model() -> str:
    return str(get("model.fallback", FALLBACK_MODEL))


def get_gate_model() -> str:
    """Relevance-gate / enrichment model (defaults to fallback to keep cost low)."""
    return str(get("model.gate", get("model.fallback", FALLBACK_MODEL)))


def get_chunk_size() -> int:
    try:
        return int(get("rag.chunk_size", CHUNK_SIZE))
    except (TypeError, ValueError):
        return CHUNK_SIZE


def get_chunk_overlap() -> int:
    try:
        return int(get("rag.chunk_overlap", CHUNK_OVERLAP))
    except (TypeError, ValueError):
        return CHUNK_OVERLAP


def get_rerank_top_n(default: int = 5) -> int:
    try:
        return int(get("rag.rerank_top_n", default))
    except (TypeError, ValueError):
        return default


def get_relevance_threshold(default: float = 0.5) -> float:
    try:
        return float(get("rag.relevance_threshold", default))
    except (TypeError, ValueError):
        return default


_CRAWL_PROVIDERS = ("spider", "jina")


def get_crawl_provider_primary() -> str:
    """Which scrape backend to try first ("spider" or "jina").

    The other provider becomes the fallback (see crawl_provider). Unknown
    values fall back to the env default so a bad DB row can never wedge
    crawling entirely.
    """
    value = str(get("crawl.provider_primary", CRAWL_PROVIDER_PRIMARY)).strip().lower()
    if value not in _CRAWL_PROVIDERS:
        return CRAWL_PROVIDER_PRIMARY if CRAWL_PROVIDER_PRIMARY in _CRAWL_PROVIDERS else "spider"
    return value


def snapshot() -> dict[str, Any]:
    """Return all runtime config keys + values for the super-admin UI."""
    _ensure_fresh()
    return dict(_cache)
