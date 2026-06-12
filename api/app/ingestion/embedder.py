"""Embedding via OpenAI text-embedding-3-small API.

Zero local memory footprint — all inference happens server-side.
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

from app.config import EMBED_DIMENSIONS, EMBED_MODEL, OPENAI_API_KEY

logger = logging.getLogger(__name__)

_client: OpenAI | None = None

# OpenAI supports up to 2048 inputs per request, but we cap lower
# to keep individual request payloads reasonable.
_MAX_BATCH = 512

# Retry policy for transient OpenAI failures (429, 5xx, timeouts, network).
# A single 429 mid-ingestion previously aborted the whole transaction and
# wasted every embedding paid for so far in the same crawl.
_RETRYABLE_EXCEPTIONS = (RateLimitError, APITimeoutError, APIConnectionError, InternalServerError)
_RETRY_ATTEMPTS = 5
_RETRY_BASE_DELAY = 1.0  # seconds
_RETRY_MAX_DELAY = 30.0  # seconds


def _get_client() -> OpenAI:
    """Return a reusable OpenAI client (lazy-initialised)."""
    global _client  # noqa: PLW0603
    if _client is None:
        _client = OpenAI(api_key=OPENAI_API_KEY)
    return _client


def _embed_batch_with_retry(client: OpenAI, batch: list[str]):
    """Call the embeddings API with exponential backoff on transient errors."""
    last_exc: Exception | None = None
    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            return client.embeddings.create(
                input=batch,
                model=EMBED_MODEL,
                dimensions=EMBED_DIMENSIONS,
            )
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
    # Exhausted retries — re-raise so the caller can roll back.
    assert last_exc is not None
    raise last_exc


def embed_chunks(chunk_content_list: list[str]) -> list[list[float]]:
    """Embed text chunks via the OpenAI embeddings API.

    Automatically batches large lists to stay within API limits and retries
    transient failures (429 / 5xx / timeout / network) with exponential
    backoff so a single API hiccup doesn't roll back an entire ingestion.
    """
    if not chunk_content_list:
        return []

    client = _get_client()
    all_embeddings: list[list[float]] = []

    for i in range(0, len(chunk_content_list), _MAX_BATCH):
        batch = chunk_content_list[i : i + _MAX_BATCH]
        response = _embed_batch_with_retry(client, batch)
        # Response objects are sorted by index, but sort explicitly to be safe
        sorted_data = sorted(response.data, key=lambda d: d.index)
        all_embeddings.extend([d.embedding for d in sorted_data])

    return all_embeddings


async def embed_chunks_async(chunk_content_list: list[str]) -> list[list[float]]:
    """Async wrapper that runs the API call in a thread.

    Keeps the event loop free for WebSocket heartbeats, SSE keepalives,
    and concurrent requests while the HTTP round-trip completes.
    """
    return await asyncio.to_thread(embed_chunks, chunk_content_list)
