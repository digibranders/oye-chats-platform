"""Google Gemini embeddings via the batchEmbedContents REST API (httpx).

Uses the existing GOOGLE_API_KEY (the same key as the Gemini LLM fallback) — no
Google SDK dependency, no GCP/Vertex setup. Returns EMBED_DIMENSIONS-wide,
L2-normalized vectors matching the pgvector column.

At 768-dim the API returns Matryoshka-truncated but *un-normalized* vectors
(verified: raw L2 norm ~0.58), so cosine similarity requires client-side
normalization — we do it here.
"""

import contextlib
import logging
import math
import re
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx

from app.config import (
    EMBED_CONCURRENCY,
    EMBED_DIMENSIONS,
    GEMINI_EMBED_MODEL,
    GEMINI_EMBED_URL,
    GOOGLE_API_KEY,
)

logger = logging.getLogger(__name__)

_MAX_BATCH = 100  # batchEmbedContents hard limit: at most 100 requests per call
_RETRY_ATTEMPTS = 6
_RETRY_BASE = 1.0
_RETRY_MAX = 30.0  # cap for exponential backoff (network / 5xx)
# 429 = quota. Google returns the exact wait in the response BODY (no Retry-After
# header), e.g. "Please retry in 11.5s" / a RetryInfo detail. We honour it, with a
# ceiling a bit above a one-minute window so a per-minute quota can roll over.
_RETRY_MAX_429 = 65.0
_TIMEOUT = 60.0


def _l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec] if norm > 0 else vec


def _retry_delay_from_429(resp: httpx.Response) -> float | None:
    """Extract the server-specified retry delay (seconds) from a 429 body.

    Gemini does not send a ``Retry-After`` header; it puts the delay in the JSON
    body — a structured ``RetryInfo`` detail (``retryDelay: "11.5s"``) and/or the
    message text ("Please retry in 11.5s"). Returns None when neither is present.
    """
    try:
        error = resp.json().get("error", {})
    except ValueError:
        return None
    for detail in error.get("details", []):
        if str(detail.get("@type", "")).endswith("RetryInfo"):
            match = re.match(r"([\d.]+)s", str(detail.get("retryDelay", "")))
            if match:
                return float(match.group(1))
    match = re.search(r"retry in ([\d.]+)s", error.get("message", ""))
    return float(match.group(1)) if match else None


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
    last_err: str = "unknown error"
    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            resp = client.post(url, params={"key": GOOGLE_API_KEY}, json=body, timeout=_TIMEOUT)
        except httpx.HTTPError as exc:
            # Network-level failure — retry with exponential backoff.
            last_err = f"{type(exc).__name__}: {exc}"
            delay = min(_RETRY_BASE * (2 ** (attempt - 1)), _RETRY_MAX)
        else:
            if resp.status_code == 200:
                try:
                    embeddings = resp.json()["embeddings"]
                except (KeyError, ValueError) as exc:
                    raise RuntimeError(f"Gemini returned an unparseable body: {exc}") from exc
                if len(embeddings) != len(batch):
                    raise RuntimeError(f"Gemini returned {len(embeddings)} embeddings for {len(batch)} inputs")
                return [_l2_normalize(item["values"]) for item in embeddings]
            if resp.status_code == 429:
                # Quota — honour the server's own retry hint; fall back to backoff.
                server_delay = _retry_delay_from_429(resp)
                backoff = min(_RETRY_BASE * (2 ** (attempt - 1)), _RETRY_MAX)
                delay = min((server_delay if server_delay is not None else backoff) + 0.5, _RETRY_MAX_429)
                last_err = f"429 quota: {resp.text[:200]}"
            elif resp.status_code >= 500:
                last_err = f"{resp.status_code}: {resp.text[:200]}"
                delay = min(_RETRY_BASE * (2 ** (attempt - 1)), _RETRY_MAX)
            else:
                # 4xx other than 429 (bad request, auth) — not retryable.
                raise RuntimeError(f"Gemini embedding rejected ({resp.status_code}): {resp.text[:300]}")

        if attempt == _RETRY_ATTEMPTS:
            break
        logger.warning(
            "Gemini embed retryable error (%s) — retry %d/%d in %.1fs",
            last_err.split(":")[0],
            attempt,
            _RETRY_ATTEMPTS,
            delay,
        )
        time.sleep(delay)
    raise RuntimeError(f"Gemini embedding failed after {_RETRY_ATTEMPTS} attempts: {last_err}")


def embed_texts(
    texts: list[str],
    *,
    progress_cb: Callable[[int, int], None] | None = None,
    _client: httpx.Client | None = None,
) -> list[list[float]]:
    """Embed ``texts`` → EMBED_DIMENSIONS-wide, L2-normalized vectors.

    Batches of ``_MAX_BATCH`` are sent to Gemini **concurrently** (up to
    ``EMBED_CONCURRENCY``) since embedding is network-bound — this is the main
    lever on large-crawl wall-clock. Output order matches input order regardless
    of completion order. ``progress_cb(done, total)`` fires as batches finish.

    Raises RuntimeError on a missing key or persistent API failure. Callers rely
    on that: ingestion retries via ARQ; the query path degrades to full-text
    search (see rag_service). A single batch failure aborts the whole call.
    """
    if not texts:
        return []
    if not GOOGLE_API_KEY:
        raise RuntimeError("GOOGLE_API_KEY is not configured for embeddings")

    batches = [texts[i : i + _MAX_BATCH] for i in range(0, len(texts), _MAX_BATCH)]
    # httpx.Client is thread-safe (pooled); share one across the worker threads.
    owns_client = _client is None
    client = _client or httpx.Client(timeout=_TIMEOUT)
    results: list[list[list[float]]] = [[] for _ in batches]
    total = len(texts)
    done = 0
    workers = max(1, min(EMBED_CONCURRENCY, len(batches)))
    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            future_to_idx = {pool.submit(_embed_one_batch, client, b): i for i, b in enumerate(batches)}
            for future in as_completed(future_to_idx):
                idx = future_to_idx[future]
                results[idx] = future.result()  # propagates a batch's terminal failure
                if progress_cb is not None:
                    done += len(batches[idx])
                    with contextlib.suppress(Exception):
                        progress_cb(done, total)
    finally:
        if owns_client:
            client.close()

    out: list[list[float]] = []
    for r in results:
        out.extend(r)
    return out
