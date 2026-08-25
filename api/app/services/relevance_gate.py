"""CRAG-style relevance gate for RAG responses.

Prevents hallucination when a visitor asks something completely outside the
knowledge base (e.g., "What's the weather?").  An LLM judge rates each
retrieved chunk's relevance to the question on a 0 to 1 scale. If ALL chunks
score below the threshold, the gate fires and the pipeline returns a
"can't help" response without generating an answer from irrelevant context.

Feature flag: ``RELEVANCE_GATE_ENABLED`` (default: true. Scope-enforcement on by default)
Model:        resolved per-call via ``runtime_config.get_gate_model()`` (DB-backed,
              super-admin tunable via the ``gate_model`` setting); falls back to
              ``GATE_MODEL`` env default (gemini/gemini-2.5-flash. Cheap & fast)
Threshold:    ``RELEVANCE_THRESHOLD`` (default: 0.55. Tunable per-bot via ``Bot.relevance_threshold``)

Gate results are cached in Redis to avoid redundant LLM calls for repeated
questions against the same knowledge base state.

Key: ``oyechats:gate:{bot_id}:{question_hash}`` (TTL: 3600s)
"""

import hashlib
import logging
import os

import litellm
from pydantic import BaseModel, ConfigDict, Field

from app.core.cache import cache_get, cache_set
from app.core.langfuse_client import langfuse_generation
from app.services import runtime_config

logger = logging.getLogger(__name__)


class _RelevanceScoreResult(BaseModel):
    """AR-33: strict structured output for the gate judge, mirroring the BANT
    extraction pattern (rag_service.QualificationExtractionResult).

    Before this, the gate used the loose ``json_object`` format with no
    schema enforcement. Any parse exception (malformed JSON, wrong shape,
    non-numeric score) fell through to the blanket ``except Exception`` and
    failed open, identically to a chunk that successfully manipulated the
    score to 1.0. Combined with AR-18's chunk-content injection gap, a chunk
    engineered to break JSON parsing bypassed the gate exactly like one that
    manipulated the score directly. A schema-enforced response makes that a
    provider-level guarantee instead of something this code has to defend
    against after the fact.
    """

    # ``extra='forbid'`` → ``additionalProperties: false`` in the emitted
    # JSON schema. Required by OpenAI/Gemini structured-output strict mode
    # (see QualificationSignalExtraction's identical comment in rag_service.py).
    model_config = ConfigDict(extra="forbid")

    score: float = Field(ge=0.0, le=1.0, description="Relevance score from 0.0 (unrelated) to 1.0 (directly answers)")


RELEVANCE_GATE_ENABLED: bool = os.getenv("RELEVANCE_GATE_ENABLED", "true").lower() in (
    "1",
    "true",
    "yes",
)

# Deployed in production via deploy-api.yml, and documented in
# docs/system-design/docs/06-rag/pipeline.md. Kept for reference/back-compat,
# but the effective model is resolved at call time by `_gate_model()` below.
# `runtime_config.get_gate_model()`'s own fallback chain resolves to
# `model.fallback`/`FALLBACK_MODEL`, not this constant, if `model.gate` isn't
# set in the DB. Read `_gate_model()`'s docstring before assuming this env
# var is authoritative.
GATE_MODEL: str = os.getenv("GATE_MODEL", "gemini/gemini-2.5-flash")
RELEVANCE_THRESHOLD: float = float(os.getenv("RELEVANCE_THRESHOLD", "0.55"))

_GATE_TTL = 3600  # 1 hour. Safe: same question + same bot KB = same result
_MAX_CHUNKS_TO_JUDGE = 3  # Only judge top-3 chunks (cost control)
_MAX_CHUNK_PREVIEW = 300  # Characters per chunk shown to the judge
# Hard cap on the gate LLM call. Without this, a stalled Gemini blocks the
# entire SSE stream for ~30s before the first token reaches the visitor.
# The existing `except Exception` below fails open on timeout, so a slow
# gate degrades to "treat as relevant" rather than dead-air.
_GATE_LLM_TIMEOUT_S = float(os.getenv("GATE_LLM_TIMEOUT_S", "2.0"))


def _gate_model() -> str:
    """Resolve the gate model at call time via ``runtime_config`` (DB-backed,
    super-admin tunable), falling back to the ``GATE_MODEL`` env constant.

    Mirrors ``llm_service._primary_model()``/``_fallback_model()``. Reading
    the module-level ``GATE_MODEL`` constant directly would freeze it at
    import time, an admin swapping the gate model via the dashboard during
    an incident would see the change "save" successfully while the gate kept
    calling the old (possibly broken) model indefinitely.
    """
    return runtime_config.get_gate_model()


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
    # The cross-lingual instruction below is guidance, NOT a fix, and the
    # difference matters to anyone reading this later. A knowledge base is
    # almost always written in one language while a multilingual bot is asked
    # questions in many, so this judge routinely compares a Hindi question
    # against English chunks. It handles that badly: measured on a real bot
    # with an identical chunk set, "what kind of organization is this" scored
    # 0.70 four times out of four while the SAME question in Hindi scored 0.00
    # four times out of four. Adding this instruction did NOT move that score.
    #
    # The actual fix is upstream: ``rag_service`` bypasses the gate entirely for
    # a non-English conversation, alongside ``route_intent`` and the FlashRank
    # reranker. This wording stays because it is correct guidance and may help a
    # future judge model, but do not rely on it to make cross-lingual gating
    # safe on its own.
    return f"""You are a relevance judge. Given a user question and retrieved document chunks, rate how relevant the chunks are to answering the question.

User question: {question}

Retrieved chunks:
{chunks_text}

Rate the overall relevance of these chunks to the question on a scale from 0.0 to 1.0.
- 1.0: chunks directly answer the question
- 0.5: chunks are somewhat related and could help answer the question
- 0.0: chunks are completely unrelated to the question

IMPORTANT: the question and the chunks may be written in DIFFERENT languages.
That is normal and expected. Judge only whether the chunks contain the
information needed to answer the question, translating in your head as needed.
A language difference is NEVER a reason to lower the score.

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
        (is_relevant, score). Is_relevant=False means the gate fires and
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
    model = _gate_model()
    try:
        with langfuse_generation("relevance-gate", model=model, prompt=prompt) as gen:
            response = litellm.completion(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                # Thinking DISABLED, and a budget that fits the answer.
                #
                # `gemini-2.5-flash` (the default GATE_MODEL) is a reasoning
                # model: it spends output tokens thinking before it emits any
                # text. At `max_tokens=20` the entire budget went to reasoning
                # and the content came back EMPTY. Measured against the live
                # API: 17 completion tokens, `reasoning_tokens=17`,
                # `text_tokens=0`. The call SUCCEEDS, so nothing raised; the
                # empty string then failed JSON parsing and this gate fell
                # through to its fail-open path on every single request. In
                # production that was 41 consecutive failures, both gates, and
                # the only trace was a WARNING nobody was reading.
                #
                # A gate is a cheap classification and wants no reasoning at
                # all. Disabling it returns `{"score":1}` in FIVE tokens
                # against 116 for the thinking path. Correct AND ~23x cheaper
                # than the version that was silently returning nothing.
                # `litellm.drop_params = True` (main.py) drops this param for a
                # GATE_MODEL that does not support it, so retuning the model
                # cannot resurrect the bug.
                reasoning_effort="disable",
                max_tokens=64,
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "RelevanceScoreResult",
                        "strict": True,
                        "schema": _RelevanceScoreResult.model_json_schema(),
                    },
                },
                timeout=_GATE_LLM_TIMEOUT_S,
                metadata={"generation_name": "relevance-gate"},
            )
            raw = (response.choices[0].message.content or "").strip()
            gen.record_litellm(response, output=raw)
        score = _RelevanceScoreResult.model_validate_json(raw).score
    except Exception as exc:
        # AR-33: still fails open on timeout/rate-limit/network errors, a
        # blanket switch to fail-closed was considered and deliberately NOT
        # made, because those failure modes are common, transient, and not
        # attacker-controlled; failing closed there would turn an ordinary
        # provider blip into "refuses every question" for every bot, a much
        # worse and more frequent outage than an occasional irrelevant
        # answer. What strict-schema output DOES close is the actual
        # exploitable path this finding flagged: a chunk engineered to break
        # JSON parsing (or the schema shape) no longer differs from any
        # other malformed-response case, the provider guarantees valid,
        # in-schema JSON or raises, so there is no longer a parse-exception
        # branch a chunk's content can deliberately trigger to force
        # fail-open the same way a successfully-manipulated score would.
        logger.warning("Relevance gate failed (non-blocking, fail-open): %s", exc)
        return True, 1.0

    is_relevant = score >= active_threshold
    logger.info("Relevance gate | score=%.2f threshold=%.2f relevant=%s", score, active_threshold, is_relevant)

    # Cache result, same question against same bot returns same judgment
    cache_set(cache_key, {"score": score}, _GATE_TTL)

    return is_relevant, score
