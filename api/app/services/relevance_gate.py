"""CRAG-style relevance gate for RAG responses.

Prevents hallucination when a visitor asks something completely outside the
knowledge base (e.g., "What's the weather?").  An LLM judge rates each
retrieved chunk's relevance to the question on a 0–1 scale. If ALL chunks
score below the threshold, the gate fires and the pipeline returns a
"can't help" response without generating an answer from irrelevant context.

Feature flag: ``RELEVANCE_GATE_ENABLED`` (default: true — scope-enforcement on by default)
Model:        ``GATE_MODEL`` (default: gemini/gemini-2.5-flash — cheap & fast)
Threshold:    ``RELEVANCE_THRESHOLD`` (default: 0.55 — tunable per-bot via ``Bot.relevance_threshold``)

Gate results are cached in Redis to avoid redundant LLM calls for repeated
questions against the same knowledge base state.

Key: ``oyechats:gate:{bot_id}:{question_hash}`` (TTL: 3600s)
"""

import hashlib
import json
import logging
import os

import litellm

from app.core.cache import cache_get, cache_set
from app.core.langfuse_client import langfuse_generation

logger = logging.getLogger(__name__)

RELEVANCE_GATE_ENABLED: bool = os.getenv("RELEVANCE_GATE_ENABLED", "true").lower() in (
    "1",
    "true",
    "yes",
)
GATE_MODEL: str = os.getenv("GATE_MODEL", "gemini/gemini-2.5-flash")
RELEVANCE_THRESHOLD: float = float(os.getenv("RELEVANCE_THRESHOLD", "0.55"))

_GATE_TTL = 3600  # 1 hour — safe: same question + same bot KB = same result
_MAX_CHUNKS_TO_JUDGE = 3  # Only judge top-3 chunks (cost control)
_MAX_CHUNK_PREVIEW = 300  # Characters per chunk shown to the judge
# Hard cap on the gate LLM call. Without this, a stalled Gemini blocks the
# entire SSE stream for ~30s before the first token reaches the visitor.
# The existing `except Exception` below fails open on timeout, so a slow
# gate degrades to "treat as relevant" rather than dead-air.
_GATE_LLM_TIMEOUT_S = float(os.getenv("GATE_LLM_TIMEOUT_S", "2.0"))


def _gate_cache_key(bot_id: int | None, client_id: int | None, question: str) -> str:
    scope = f"b{bot_id}" if bot_id else f"c{client_id}"
    q_hash = hashlib.sha256(question.lower().strip().encode()).hexdigest()[:16]
    return f"oyechats:gate:{scope}:{q_hash}"


def _build_gate_prompt(question: str, chunks: list) -> str:
    chunk_previews = []
    for i, doc in enumerate(chunks[:_MAX_CHUNKS_TO_JUDGE], 1):
        content = getattr(doc, "content", "") or ""
        preview = content[:_MAX_CHUNK_PREVIEW].replace("\n", " ")
        chunk_previews.append(f"Chunk {i}: {preview}")

    chunks_text = "\n".join(chunk_previews)
    return f"""You are a relevance judge. Given a user question and retrieved document chunks, rate how relevant the chunks are to answering the question.

User question: {question}

Retrieved chunks:
{chunks_text}

Rate the overall relevance of these chunks to the question on a scale from 0.0 to 1.0.
- 1.0: chunks directly answer the question
- 0.5: chunks are somewhat related and could help answer the question
- 0.0: chunks are completely unrelated to the question

Respond with ONLY a JSON object in this exact format: {{"score": 0.7}}
No explanation, no other text."""


def _resolve_threshold(bot_threshold: float | None) -> float:
    """Pick the active threshold for this call.

    Per-bot override (``Bot.relevance_threshold``) wins; falls back to the
    env default. Out-of-range values are clamped to [0.0, 1.0] so a bad
    DB value can never disable the gate or make it impossible to pass.
    """
    if bot_threshold is None:
        return RELEVANCE_THRESHOLD
    return max(0.0, min(1.0, float(bot_threshold)))


def check_relevance(
    question: str,
    chunks: list,
    bot_id: int | None = None,
    client_id: int | None = None,
    threshold: float | None = None,
) -> tuple[bool, float]:
    """Determine whether retrieved chunks are relevant enough to answer the question.

    Parameters
    ----------
    threshold
        Optional per-bot override (typically ``Bot.relevance_threshold``).
        ``None`` falls back to the ``RELEVANCE_THRESHOLD`` env default.

    Returns
    -------
    tuple[bool, float]
        (is_relevant, score) — is_relevant=False means the gate fires and
        the caller should return a "can't help" response instead of generating.

    Caches gate results in Redis to avoid repeated LLM calls for the same
    question against the same bot.  Falls back to is_relevant=True on any
    error so the pipeline is never blocked by gate failures.
    """
    if not RELEVANCE_GATE_ENABLED or not chunks:
        return True, 1.0

    active_threshold = _resolve_threshold(threshold)

    # Check Redis cache first
    cache_key = _gate_cache_key(bot_id, client_id, question)
    cached = cache_get(cache_key)
    if cached is not None and isinstance(cached, dict) and "score" in cached:
        score = float(cached["score"])
        is_relevant = score >= active_threshold
        logger.debug("Gate cache hit | score=%.2f relevant=%s", score, is_relevant)
        return is_relevant, score

    prompt = _build_gate_prompt(question, chunks)
    try:
        with langfuse_generation("relevance-gate", model=GATE_MODEL, prompt=prompt) as gen:
            response = litellm.completion(
                model=GATE_MODEL,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=20,
                response_format={"type": "json_object"},
                timeout=_GATE_LLM_TIMEOUT_S,
                metadata={"generation_name": "relevance-gate"},
            )
            raw = (response.choices[0].message.content or "").strip()
            gen.record_litellm(response, output=raw)
        data = json.loads(raw)
        score = float(data.get("score", 1.0))
        score = max(0.0, min(1.0, score))  # clamp to [0, 1]
    except Exception as exc:
        # Timeout, rate limit, JSON parse error, network — all fail open.
        # Visitor gets a possibly-irrelevant answer instead of 30s of silence.
        logger.warning("Relevance gate failed (non-blocking, fail-open): %s", exc)
        return True, 1.0

    is_relevant = score >= active_threshold
    logger.info("Relevance gate | score=%.2f threshold=%.2f relevant=%s", score, active_threshold, is_relevant)

    # Cache result — same question against same bot returns same judgment
    cache_set(cache_key, {"score": score}, _GATE_TTL)

    return is_relevant, score
