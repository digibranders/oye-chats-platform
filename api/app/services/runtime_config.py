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
    IMPERSONATION_ENABLED,
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
    """Chunk overlap, clamped to always be strictly less than ``get_chunk_size()``.

    Defense-in-depth backstop (AR-07): the super-admin PUT endpoint validates
    chunk_size/chunk_overlap cross-field at write time, but this getter is the
    last line of defense against any invalid combo already stored (e.g. a
    direct DB edit, or a value written before the write-time check existed).
    ``RecursiveCharacterTextSplitter`` raises an uncaught ``ValueError`` on
    ``overlap >= size``, which would otherwise crash every ingestion (upload
    and crawl) platform-wide.
    """
    try:
        overlap = int(get("rag.chunk_overlap", CHUNK_OVERLAP))
    except (TypeError, ValueError):
        overlap = CHUNK_OVERLAP
    size = get_chunk_size()
    return min(overlap, size - 1) if size > 0 else 0


# Embed-batch parallelism bounds: 1 keeps embedding functional, 64 is a safe
# ceiling — even one text per batchEmbedContents request stays well under the
# Gemini per-project embedding RPM quota at this fan-out.
_EMBED_CONCURRENCY_MIN = 1
_EMBED_CONCURRENCY_MAX = 64


def get_embed_concurrency() -> int:
    """How many embed batches are POSTed to the provider concurrently.

    Runtime-tunable from the super-admin Models & RAG card
    (pricing_config: ``embed.concurrency``); falls back to the
    ``EMBED_CONCURRENCY`` env default. Clamped so a bad DB value can never
    stall embedding (0) or fan out past the provider rate limit. This is the
    main live lever on large-crawl embed wall-clock.
    """
    from app.config import EMBED_CONCURRENCY

    try:
        value = int(get("embed.concurrency", EMBED_CONCURRENCY))
    except (TypeError, ValueError):
        return EMBED_CONCURRENCY
    return max(_EMBED_CONCURRENCY_MIN, min(_EMBED_CONCURRENCY_MAX, value))


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
# Hard bounds for the per-provider fetch parallelism knobs: 1 keeps crawls
# functional, 50 stays a safe margin under provider rate limits (Jina keyed
# tier = 500 RPM; Spider handles render load server-side).
_FETCH_CONCURRENCY_MIN = 1
_FETCH_CONCURRENCY_MAX = 50


def _fetch_concurrency(key: str, default: int) -> int:
    try:
        value = int(get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(_FETCH_CONCURRENCY_MIN, min(_FETCH_CONCURRENCY_MAX, value))


def get_jina_fetch_concurrency() -> int:
    """How many Jina Reader page fetches run in parallel per crawl.

    Runtime-tunable from the super-admin Crawler card; falls back to the
    JINA_FETCH_CONCURRENCY env default. Clamped so a bad DB value can never
    stall a crawl (0) or blow the Jina rate limit.
    """
    from app.config import JINA_FETCH_CONCURRENCY

    return _fetch_concurrency("crawl.jina_fetch_concurrency", JINA_FETCH_CONCURRENCY)


def get_spider_fetch_concurrency() -> int:
    """How many Spider /scrape calls run in parallel per crawl (sitemap-seeded
    and ordered fetches; the recursive crawl's concurrency is plan-driven).

    Runtime-tunable from the super-admin Crawler card; falls back to the
    SPIDER_FETCH_CONCURRENCY env default.
    """
    from app.config import SPIDER_FETCH_CONCURRENCY

    return _fetch_concurrency("crawl.spider_fetch_concurrency", SPIDER_FETCH_CONCURRENCY)


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


_TRUTHY = ("1", "true", "yes", "on")
_FALSY = ("0", "false", "no", "off")


def is_impersonation_enabled() -> bool:
    """Whether super-admin impersonation may be used at all (design §14).

    Two layers, deliberately asymmetric:

    * ``IMPERSONATION_ENABLED`` (env) is the **floor**. False here means off,
      full stop — the DB is not consulted. It survives a DB outage and a rogue
      ``pricing_config`` edit.
    * ``impersonation.enabled`` (pricing_config row) is the **fast lever**:
      flip it from the super-admin UI and it takes effect on the next request,
      no deploy or restart, because the super-admin write path calls
      ``invalidate_runtime_config_cache``.

    Because validity is re-checked on every request, turning this off also
    ends every session already in flight — which is the point of a kill
    switch. Revocation of individual tokens keeps working while it is off.

    An unparseable DB value resolves to enabled (matching the env default)
    rather than silently disabling the feature; the env var is the mechanism
    for a hard, unambiguous off.
    """
    if not IMPERSONATION_ENABLED:
        return False

    raw = get("impersonation.enabled", True)
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    if isinstance(raw, str):
        value = raw.strip().lower()
        if value in _FALSY:
            return False
        if value in _TRUTHY:
            return True
    return True


def snapshot() -> dict[str, Any]:
    """Return all runtime config keys + values for the super-admin UI."""
    _ensure_fresh()
    return dict(_cache)
