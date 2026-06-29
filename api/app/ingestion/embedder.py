"""Embedding via FastEmbed (primary) with OpenAI as fallback.

FastEmbed runs BAAI/bge-base-en-v1.5 locally via ONNX Runtime — no network
call, no per-token cost, ~10-30ms per query. The model (~420 MB RAM) is
lazy-loaded on first use and stays resident for the process lifetime.

OpenAI text-embedding-3-small is used when:
  - EMBED_PROVIDER=openai is set explicitly in the environment
  - FastEmbed fails to load or raises during inference (automatic fallback)
"""

import asyncio
import logging
import time

from openai import (
    APIConnectionError,
    APITimeoutError,
    InternalServerError,
    OpenAI,
    RateLimitError,
)

from app.config import (
    EMBED_DIMENSIONS,
    EMBED_MODEL,
    EMBED_PROVIDER,
    FASTEMBED_MODEL,
    OPENAI_API_KEY,
)

logger = logging.getLogger(__name__)


# ── FastEmbed (primary) ────────────────────────────────────────────────────────

_fastembed_model = None


def _get_fastembed_model():
    global _fastembed_model  # noqa: PLW0603
    if _fastembed_model is None:
        from fastembed import TextEmbedding

        logger.info("Loading FastEmbed model: %s", FASTEMBED_MODEL)
        _fastembed_model = TextEmbedding(model_name=FASTEMBED_MODEL)
        logger.info("FastEmbed model ready")
    return _fastembed_model


def _fastembed_embed(texts: list[str]) -> list[list[float]]:
    model = _get_fastembed_model()
    return [e.tolist() for e in model.embed(texts)]


# ── OpenAI (fallback) ──────────────────────────────────────────────────────────

_openai_client: OpenAI | None = None

# OpenAI supports up to 2048 inputs per request; cap lower to keep payloads manageable.
_MAX_BATCH = 512

_RETRYABLE_EXCEPTIONS = (RateLimitError, APITimeoutError, APIConnectionError, InternalServerError)
_RETRY_ATTEMPTS = 5
_RETRY_BASE_DELAY = 1.0
_RETRY_MAX_DELAY = 30.0


def _get_openai_client() -> OpenAI:
    global _openai_client  # noqa: PLW0603
    if _openai_client is None:
        _openai_client = OpenAI(api_key=OPENAI_API_KEY)
    return _openai_client


def _openai_embed_batch_with_retry(client: OpenAI, batch: list[str]) -> list[list[float]]:
    last_exc: Exception | None = None
    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            response = client.embeddings.create(
                input=batch,
                model=EMBED_MODEL,
                dimensions=EMBED_DIMENSIONS,
            )
            sorted_data = sorted(response.data, key=lambda d: d.index)
            return [d.embedding for d in sorted_data]
        except _RETRYABLE_EXCEPTIONS as exc:
            last_exc = exc
            if attempt == _RETRY_ATTEMPTS:
                break
            delay = min(_RETRY_BASE_DELAY * (2 ** (attempt - 1)), _RETRY_MAX_DELAY)
            logger.warning(
                "OpenAI embeddings transient error (%s) — retrying in %.1fs (attempt %d/%d)",
                type(exc).__name__,
                delay,
                attempt,
                _RETRY_ATTEMPTS,
            )
            time.sleep(delay)
    assert last_exc is not None
    raise last_exc


def _openai_embed(texts: list[str]) -> list[list[float]]:
    client = _get_openai_client()
    result: list[list[float]] = []
    for i in range(0, len(texts), _MAX_BATCH):
        result.extend(_openai_embed_batch_with_retry(client, texts[i : i + _MAX_BATCH]))
    return result


# ── Public interface ───────────────────────────────────────────────────────────


def embed_chunks(chunk_content_list: list[str]) -> list[list[float]]:
    """Embed a list of text chunks, returning one float vector per chunk.

    Uses FastEmbed (local ONNX) by default; falls back to OpenAI on any
    FastEmbed failure. Set EMBED_PROVIDER=openai to skip FastEmbed entirely.
    """
    if not chunk_content_list:
        return []

    if EMBED_PROVIDER == "openai":
        return _openai_embed(chunk_content_list)

    try:
        return _fastembed_embed(chunk_content_list)
    except Exception as exc:
        logger.warning(
            "FastEmbed failed (%s: %s) — falling back to OpenAI embeddings",
            type(exc).__name__,
            exc,
        )
        return _openai_embed(chunk_content_list)


async def embed_chunks_async(chunk_content_list: list[str]) -> list[list[float]]:
    """Async wrapper — runs embed_chunks in a thread to keep the event loop free."""
    return await asyncio.to_thread(embed_chunks, chunk_content_list)
