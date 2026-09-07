"""Embedding via Google Gemini (sole provider, off-box).

Produces 768-dim L2-normalized vectors matching the pgvector column, using the
existing GOOGLE_API_KEY. There is no local model and no cross-model fallback.
Mixing embedding models corrupts vector search. On persistent failure
``embed_chunks`` raises: ingestion retries via ARQ, and the query path degrades
to full-text search (see rag_service).

How a vector is made is a property of the embedding profile
(``app/core/embedding_profiles.py``): callers pass the profile's task type
(``document_task_type`` for chunks being stored, ``query_task_type`` for a
question being searched) so a query is always embedded the way the chunks it
is compared against were.
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
    task_type: str | None = None,
    progress_cb: Callable[[int, int], None] | None = None,
    max_wait_s: float | None = None,
) -> list[list[float]]:
    """Embed a list of text chunks, returning one 768-dim vector per chunk.

    ``task_type`` is the Gemini ``taskType`` the embedding profile prescribes
    (``None`` for the legacy symmetric profile). ``progress_cb(done, total)``
    (if given) fires as embed batches complete (batches run concurrently under
    the hood; see gemini_embedding.embed_texts). ``max_wait_s`` bounds queueing
    behind the shared embed rate limiter; the query path passes a small
    ceiling so chat never waits on bulk-crawl debt.
    """
    if not chunk_content_list:
        return []
    if EMBED_PROVIDER != "google":
        raise RuntimeError(f"Unsupported EMBED_PROVIDER={EMBED_PROVIDER!r} (only 'google' is supported)")
    return _google_embed(chunk_content_list, task_type=task_type, progress_cb=progress_cb, max_wait_s=max_wait_s)


async def embed_chunks_async(
    chunk_content_list: list[str],
    *,
    task_type: str | None = None,
    max_wait_s: float | None = None,
) -> list[list[float]]:
    """Async wrapper. Runs the sync (httpx) embed call off the event loop."""
    return await asyncio.to_thread(lambda: embed_chunks(chunk_content_list, task_type=task_type, max_wait_s=max_wait_s))
