# Embedding of the chunking text
from fastembed import TextEmbedding

from app.config import EMBED_MODEL

model = TextEmbedding(model_name=EMBED_MODEL)


def embed_chunks(chunk_content_list):
    return list(model.embed(chunk_content_list))
