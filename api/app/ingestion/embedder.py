"""Embedding via Google Gemini (sole provider, off-box).

Produces 768-dim L2-normalized vectors matching the pgvector column, using the
existing GOOGLE_API_KEY. There is no local model and no cross-model fallback —
mixing embedding models corrupts vector search. On persistent failure
``embed_chunks`` raises: ingestion retries via ARQ, and the query path degrades
to full-text search (see rag_service).
"""

import asyncio
import logging
from collections.abc import Callable

from app.config import EMBED_PROVIDER
from app.services.gemini_embedding import embed_texts as _google_embed

logger = logging.getLogger(__name__)


def embed_chunks(
    chunk_content_list: list[str],
    *,
    progress_cb: Callable[[int, int], None] | None = None,
) -> list[list[float]]:
    """Embed a list of text chunks, returning one 768-dim vector per chunk.

    ``progress_cb(done, total)`` — if given — fires as embed batches complete
    (batches run concurrently under the hood; see gemini_embedding.embed_texts).
    """
    if not chunk_content_list:
        return []
    if EMBED_PROVIDER != "google":
        raise RuntimeError(f"Unsupported EMBED_PROVIDER={EMBED_PROVIDER!r} (only 'google' is supported)")
    return _google_embed(chunk_content_list, progress_cb=progress_cb)


async def embed_chunks_async(chunk_content_list: list[str]) -> list[list[float]]:
    """Async wrapper — runs the sync (httpx) embed call off the event loop."""
    return await asyncio.to_thread(embed_chunks, chunk_content_list)
