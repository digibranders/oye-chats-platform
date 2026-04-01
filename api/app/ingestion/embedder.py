# Embedding of the chunking text
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
