"""Embedding via OpenAI text-embedding-3-small API.

Zero local memory footprint — all inference happens server-side.
"""

import asyncio
import logging

from openai import OpenAI

from app.config import EMBED_DIMENSIONS, EMBED_MODEL, OPENAI_API_KEY

logger = logging.getLogger(__name__)

_client: OpenAI | None = None

# OpenAI supports up to 2048 inputs per request, but we cap lower
# to keep individual request payloads reasonable.
_MAX_BATCH = 512


def _get_client() -> OpenAI:
    """Return a reusable OpenAI client (lazy-initialised)."""
    global _client  # noqa: PLW0603
    if _client is None:
        _client = OpenAI(api_key=OPENAI_API_KEY)
    return _client


def embed_chunks(chunk_content_list: list[str]) -> list[list[float]]:
    """Embed text chunks via the OpenAI embeddings API.

    Automatically batches large lists to stay within API limits.
    """
    if not chunk_content_list:
        return []

    client = _get_client()
    all_embeddings: list[list[float]] = []

    for i in range(0, len(chunk_content_list), _MAX_BATCH):
        batch = chunk_content_list[i : i + _MAX_BATCH]
        response = client.embeddings.create(
            input=batch,
            model=EMBED_MODEL,
            dimensions=EMBED_DIMENSIONS,
        )
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
