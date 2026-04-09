"""CRAG-style relevance gate for RAG responses.

Prevents hallucination when a visitor asks something completely outside the
knowledge base (e.g., "What's the weather?").  An LLM judge rates each
retrieved chunk's relevance to the question on a 0–1 scale. If ALL chunks
score below the threshold, the gate fires and the pipeline returns a
"can't help" response without generating an answer from irrelevant context.

Feature flag: ``RELEVANCE_GATE_ENABLED`` (default: false)
Model:        ``GATE_MODEL`` (default: gemini/gemini-2.5-flash — cheap & fast)
Threshold:    ``RELEVANCE_THRESHOLD`` (default: 0.5)

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

logger = logging.getLogger(__name__)

RELEVANCE_GATE_ENABLED: bool = os.getenv("RELEVANCE_GATE_ENABLED", "false").lower() in (
    "1",
    "true",
    "yes",
)
GATE_MODEL: str = os.getenv("GATE_MODEL", "gemini/gemini-2.5-flash")
RELEVANCE_THRESHOLD: float = float(os.getenv("RELEVANCE_THRESHOLD", "0.5"))

_GATE_TTL = 3600  # 1 hour — safe: same question + same bot KB = same result
_MAX_CHUNKS_TO_JUDGE = 3  # Only judge top-3 chunks (cost control)
_MAX_CHUNK_PREVIEW = 300  # Characters per chunk shown to the judge


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


def check_relevance(
    question: str,
    chunks: list,
    bot_id: int | None = None,
    client_id: int | None = None,
) -> tuple[bool, float]:
    """Determine whether retrieved chunks are relevant enough to answer the question.

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

    # Check Redis cache first
    cache_key = _gate_cache_key(bot_id, client_id, question)
    cached = cache_get(cache_key)
    if cached is not None and isinstance(cached, dict) and "score" in cached:
        score = float(cached["score"])
        is_relevant = score >= RELEVANCE_THRESHOLD
        logger.debug("Gate cache hit | score=%.2f relevant=%s", score, is_relevant)
        return is_relevant, score

    prompt = _build_gate_prompt(question, chunks)
    try:
        response = litellm.completion(
            model=GATE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=20,
            response_format={"type": "json_object"},
        )
        raw = (response.choices[0].message.content or "").strip()
        data = json.loads(raw)
        score = float(data.get("score", 1.0))
        score = max(0.0, min(1.0, score))  # clamp to [0, 1]
    except Exception as exc:
        logger.warning("Relevance gate failed (non-blocking): %s", exc)
        return True, 1.0

    is_relevant = score >= RELEVANCE_THRESHOLD
    logger.info("Relevance gate | score=%.2f threshold=%.2f relevant=%s", score, RELEVANCE_THRESHOLD, is_relevant)

    # Cache result — same question against same bot returns same judgment
    cache_set(cache_key, {"score": score}, _GATE_TTL)

    return is_relevant, score
