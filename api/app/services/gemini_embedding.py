"""Google Gemini embeddings via the batchEmbedContents REST API (httpx).

Uses the existing GOOGLE_API_KEY (the same key as the Gemini LLM fallback) — no
Google SDK dependency, no GCP/Vertex setup. Returns EMBED_DIMENSIONS-wide,
L2-normalized vectors matching the pgvector column.

At 768-dim the API returns Matryoshka-truncated but *un-normalized* vectors
(verified: raw L2 norm ~0.58), so cosine similarity requires client-side
normalization — we do it here.
"""

import logging
import math
import time

import httpx

from app.config import EMBED_DIMENSIONS, GEMINI_EMBED_MODEL, GEMINI_EMBED_URL, GOOGLE_API_KEY

logger = logging.getLogger(__name__)

_MAX_BATCH = 100
_RETRY_ATTEMPTS = 5
_RETRY_BASE = 1.0
_RETRY_MAX = 30.0
_TIMEOUT = 60.0


def _l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec] if norm > 0 else vec


def _embed_one_batch(client: httpx.Client, batch: list[str]) -> list[list[float]]:
    url = f"{GEMINI_EMBED_URL}/models/{GEMINI_EMBED_MODEL}:batchEmbedContents"
    body = {
        "requests": [
            {
                "model": f"models/{GEMINI_EMBED_MODEL}",
                "content": {"parts": [{"text": text}]},
                "outputDimensionality": EMBED_DIMENSIONS,
            }
            for text in batch
        ]
    }
    last_exc: Exception | None = None
    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            resp = client.post(url, params={"key": GOOGLE_API_KEY}, json=body, timeout=_TIMEOUT)
            if resp.status_code == 429 or resp.status_code >= 500:
                raise httpx.HTTPStatusError(
                    f"retryable {resp.status_code}", request=resp.request, response=resp
                )
            resp.raise_for_status()
            embeddings = resp.json()["embeddings"]
            if len(embeddings) != len(batch):
                raise RuntimeError(
                    f"Gemini returned {len(embeddings)} embeddings for {len(batch)} inputs"
                )
            return [_l2_normalize(item["values"]) for item in embeddings]
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            last_exc = exc
            if attempt == _RETRY_ATTEMPTS:
                break
            delay = min(_RETRY_BASE * (2 ** (attempt - 1)), _RETRY_MAX)
            logger.warning(
                "Gemini embed transient error (%s) — retry %d/%d in %.1fs",
                type(exc).__name__,
                attempt,
                _RETRY_ATTEMPTS,
                delay,
            )
            time.sleep(delay)
    raise RuntimeError(f"Gemini embedding failed after {_RETRY_ATTEMPTS} attempts: {last_exc}")


def embed_texts(texts: list[str], *, _client: httpx.Client | None = None) -> list[list[float]]:
    """Embed ``texts`` → EMBED_DIMENSIONS-wide, L2-normalized vectors.

    Raises RuntimeError on a missing key or persistent API failure. Callers rely
    on that: ingestion retries via ARQ; the query path degrades to full-text
    search (see rag_service).
    """
    if not texts:
        return []
    if not GOOGLE_API_KEY:
        raise RuntimeError("GOOGLE_API_KEY is not configured for embeddings")

    owns_client = _client is None
    client = _client or httpx.Client(timeout=_TIMEOUT)
    try:
        out: list[list[float]] = []
        for i in range(0, len(texts), _MAX_BATCH):
            out.extend(_embed_one_batch(client, texts[i : i + _MAX_BATCH]))
        return out
    finally:
        if owns_client:
            client.close()
