# Embedding of the chunking text
import asyncio

from fastembed import TextEmbedding

from app.config import EMBED_MODEL

_model: TextEmbedding | None = None


def _get_model() -> TextEmbedding:
    """Return the embedding model, loading it lazily on first call.

    This avoids eagerly consuming ~300 MB at import time; the model is only
    loaded when ``embed_chunks`` is actually invoked.
    """
    global _model  # noqa: PLW0603
    if _model is None:
        _model = TextEmbedding(model_name=EMBED_MODEL, batch_size=128)
    return _model


def embed_chunks(chunk_content_list: list[str]) -> list[list[float]]:
    return list(_get_model().embed(chunk_content_list))


async def embed_chunks_async(chunk_content_list: list[str]) -> list[list[float]]:
    """Async wrapper that runs CPU-bound embedding in a thread.

    This prevents blocking the event loop during the 50-500ms inference,
    keeping WebSocket heartbeats, SSE keepalives, and concurrent requests
    responsive.
    """
    return await asyncio.to_thread(embed_chunks, chunk_content_list)
