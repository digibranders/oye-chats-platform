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
Threshold:    per-bot ``Bot.relevance_threshold`` → super-admin runtime knob
              ``rag.relevance_threshold`` → ``RELEVANCE_THRESHOLD`` env default (0.55)
Judge input:  ``GATE_MAX_CHUNKS`` (default 5) chunks × ``GATE_CHUNK_PREVIEW_CHARS``
              (default 500) characters each. A caller whose chunk list is NOT
              ranked passes ``max_chunks`` to widen that window; see
              :func:`_build_gate_prompt`.

Gate results are cached in Redis to avoid redundant LLM calls for repeated
questions against the same knowledge base state.

Key: ``oyechats:gate:v{prompt_version}:{bot_id}:{question_hash}`` (TTL: 3600s)
"""

import hashlib
import logging
import math
import os

import litellm
from pydantic import BaseModel, ConfigDict, Field

from app.core.cache import cache_get, cache_set
from app.core.langfuse_client import langfuse_generation
from app.core.metrics import increment_metric_counter
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


# ``or "true"`` rather than a getenv default: the deploy writes this key
# unconditionally (deploy-api.yml), so an unset repo variable produces an
# empty-but-present ``RELEVANCE_GATE_ENABLED=`` line. systemd's
# EnvironmentFile then sets it to "", which getenv returns instead of the
# default, silently disabling scope enforcement in production.
RELEVANCE_GATE_ENABLED: bool = (os.getenv("RELEVANCE_GATE_ENABLED") or "true").lower() in (
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

# Bump whenever the judge prompt or its scoring scale changes. The cache key
# is (bot, question), so without this a prompt fix keeps serving verdicts the
# OLD prompt produced for up to an hour after deploy -- and any before/after
# measurement of a prompt change silently reads its own baseline back.
_GATE_PROMPT_VERSION = 2

# How much of the retrieved context the judge sees. This was hardcoded to the
# top 3 chunks at 300 characters each while generation received the full
# top-k (15 chunks of up to CHUNK_SIZE=1000 characters): the judge scored a
# ~900-character keyhole view of the context the generator would answer from,
# so a question whose answer sat in chunk 4, or past character 300 of chunk 1,
# could be refused as off-topic when generation would have answered it fine.
# 5 × 500 covers the first half of every default-size chunk for the top five,
# at a cost of a few hundred extra gate-tier input tokens per uncached
# question. ``or`` rather than a getenv default for the same reason as
# ``RELEVANCE_GATE_ENABLED`` above (an empty-but-present value must mean the
# default, not a crash on import); floored at 1 so the judge always sees
# something.
GATE_MAX_CHUNKS: int = max(1, int(os.getenv("GATE_MAX_CHUNKS") or "5"))
GATE_CHUNK_PREVIEW_CHARS: int = max(1, int(os.getenv("GATE_CHUNK_PREVIEW_CHARS") or "500"))
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
    return f"oyechats:gate:v{_GATE_PROMPT_VERSION}:{scope}:{q_hash}"


def _build_gate_prompt(question: str, chunks: list, max_chunks: int | None = None) -> str:
    # ``max_chunks`` overrides the cap for a caller that knows the list is not
    # ranked. Under CAG-lite there is no retrieval at all: ``rag_service``
    # injects the WHOLE knowledge base, ordered by ``(document_name, id)``,
    # i.e. alphabetically. Taking the first five of that is taking five
    # arbitrary chunks and asking whether they answer the question, and on a
    # 14-chunk bot it meant `pricing.md`, `services.md` and `team.md` were
    # never shown to this judge for ANY question, so every question they
    # answered was refused as off-topic. On the retrieval path the cap is
    # right: there the first five ARE the five most relevant.
    limit = max_chunks if max_chunks and max_chunks > 0 else GATE_MAX_CHUNKS
    chunk_previews = []
    for i, doc in enumerate(chunks[:limit], 1):
        content = getattr(doc, "content", "") or ""
        preview = content[:GATE_CHUNK_PREVIEW_CHARS].replace("\n", " ")
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
    return f"""You are a relevance judge. Given a user question and retrieved document chunks, decide whether the chunks contain the information needed to answer it.

User question: {question}

Retrieved chunks:
{chunks_text}

Score by the BEST-MATCHING chunk, not by how many of them are on topic. The
chunks are a bundle handed to you by a retriever, not a claim that all of them
are relevant: one chunk that answers the question scores 1.0 even when every
other chunk is about something else entirely. Averaging over the bundle is what
this judge must not do -- it turns "one document answers this" into "somewhat
related" and refuses a question the knowledge base can answer.

Rate from 0.0 to 1.0:
- 1.0: at least one chunk directly answers the question
- 0.5: no chunk answers it outright, but at least one is related enough to help
- 0.0: no chunk bears on the question at all

IMPORTANT: the question and the chunks may be written in DIFFERENT languages.
That is normal and expected. Judge only whether the chunks contain the
information needed to answer the question, translating in your head as needed.
A language difference is NEVER a reason to lower the score.

Respond with ONLY a JSON object in this exact format: {{"score": 0.7}}
No explanation, no other text."""


def _resolve_threshold(bot_threshold: float | None) -> float:
    """Pick the active threshold for this call.

    Resolution order: per-bot override (``Bot.relevance_threshold``) → the
    super-admin runtime knob (``rag.relevance_threshold`` in pricing_config,
    read through ``runtime_config`` so a dashboard edit is live within its
    cache TTL) → the ``RELEVANCE_THRESHOLD`` env default. The runtime knob was
    previously never consulted here: the dashboard control saved a value
    nothing read, so an admin loosening the gate during an incident saw a
    successful save and no change in behaviour, the same decorative-control
    shape as the AR-05 gate-model bug.

    Out-of-range values are clamped to [0.0, 1.0] and a non-numeric or NaN
    value falls back to the env default, so a bad DB value can never disable
    the gate or make it impossible to pass.
    """
    raw = bot_threshold if bot_threshold is not None else runtime_config.get_relevance_threshold(RELEVANCE_THRESHOLD)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = RELEVANCE_THRESHOLD
    if math.isnan(value):
        value = RELEVANCE_THRESHOLD
    return max(0.0, min(1.0, value))


def check_relevance(
    question: str,
    chunks: list,
    bot_id: int | None = None,
    client_id: int | None = None,
    threshold: float | None = None,
    max_chunks: int | None = None,
) -> tuple[bool, float]:
    """Determine whether retrieved chunks are relevant enough to answer the question.

    Parameters
    ----------
    threshold
        Optional per-bot override (typically ``Bot.relevance_threshold``).
        ``None`` falls back to the super-admin runtime knob, then the
        ``RELEVANCE_THRESHOLD`` env default (see :func:`_resolve_threshold`).
    max_chunks
        How many chunks the judge may see. ``None`` uses ``GATE_MAX_CHUNKS``,
        which is correct whenever ``chunks`` is RANKED. A caller passing an
        unranked list -- CAG-lite hands over the whole knowledge base in
        alphabetical order -- must pass its length, or the judge sees an
        arbitrary slice. See :func:`_build_gate_prompt`.

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

    prompt = _build_gate_prompt(question, chunks, max_chunks)
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
        # AR-13 shape: this branch was a WARNING and nothing else, which is how
        # the reasoning-budget outage (see the ``max_tokens`` comment above) ran
        # to 41 consecutive fail-opens unnoticed. Every fail-open means the
        # scope guarantee was NOT enforced for that answer; the hourly counter
        # makes a sustained run of them visible on the safety-net metrics
        # endpoint instead of only in logs nobody is reading.
        increment_metric_counter("gate_failed_open")
        return True, 1.0

    is_relevant = score >= active_threshold
    logger.info("Relevance gate | score=%.2f threshold=%.2f relevant=%s", score, active_threshold, is_relevant)

    # Cache result, same question against same bot returns same judgment
    cache_set(cache_key, {"score": score}, _GATE_TTL)

    return is_relevant, score
