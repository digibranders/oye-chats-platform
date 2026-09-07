"""Post-generation groundedness check for free-text (prose) answers.

AR-12: the only automated hallucination defense before this module was CRAG
relevance gating (``relevance_gate.py``), which screens retrieved chunks
*before* generation, nothing checked the generated answer itself for
fabricated claims. The one narrow exception was
``_drop_hallucinated_media_card`` (rag_service.py), scoped to media-card
sentinels, not prose. This module closes that gap for prose claims: an LLM
judge rates whether the generated answer's claims are supported by the
retrieved chunks it was generated from.

Deliberately observability-only, not blocking: it runs fire-and-forget after
the answer has already streamed to the visitor (mirroring
``_background_bant_extraction``'s pattern), logging a structured
``rag.metric`` line via the same safety-net-metric hook already used
elsewhere in this codebase. Blocking or rewriting a live answer on a
groundedness-gate verdict would trade a real (but bounded) hallucination risk
for a new one (a false-positive-triggered rewrite/refusal on a good answer)
without the retry/regeneration infrastructure to do that safely. Detection
first; correction is a separate, larger effort (see AI_ENGINEERING_REVIEW.md
Eval Gap Report).

Feature flag: ``GROUNDEDNESS_CHECK_ENABLED`` (default: true)
Sample rate:  ``GROUNDEDNESS_CHECK_SAMPLE_RATE`` (default: 1.0. Check every
              turn; lower to control gate-tier LLM cost at scale)
Model:        resolved per-call via ``runtime_config.get_gate_model()``,
              same cheap tier as the relevance gate
Threshold:    ``GROUNDEDNESS_THRESHOLD`` (default: 0.5)
Judge input:  ``GROUNDEDNESS_MAX_CHUNKS`` (default 5) chunks ×
              ``GROUNDEDNESS_CHUNK_PREVIEW_CHARS`` (default 500) characters each
"""

import logging
import os
import random

import litellm
from pydantic import BaseModel, ConfigDict, Field

from app.core.langfuse_client import langfuse_generation
from app.services import runtime_config

logger = logging.getLogger(__name__)


class _GroundednessScoreResult(BaseModel):
    """Strict structured output for the groundedness judge, the same shape as
    ``relevance_gate._RelevanceScoreResult`` (AR-33) for the same reason.

    The loose ``json_object`` format this replaced enforced no schema: a
    malformed or wrong-shaped verdict raised at parse time and fell through to
    the blanket ``except Exception`` as a fail-open, indistinguishable from a
    judge that scored the answer 1.0, and an out-of-range score was silently
    clamped into a "legitimate" boundary value. With a strict schema the
    provider guarantees valid, in-schema JSON or raises, so there is no
    parse-exception branch left that generated text can trigger, and an
    out-of-range value is a validation failure (fail-open, logged) rather than
    a metric point that looks like a real judgement.
    """

    # ``extra='forbid'`` → ``additionalProperties: false`` in the emitted JSON
    # schema, required by OpenAI/Gemini structured-output strict mode.
    model_config = ConfigDict(extra="forbid")

    score: float = Field(
        ge=0.0, le=1.0, description="Groundedness score from 0.0 (fabricated claims) to 1.0 (fully supported)"
    )


GROUNDEDNESS_CHECK_ENABLED: bool = os.getenv("GROUNDEDNESS_CHECK_ENABLED", "true").lower() in (
    "1",
    "true",
    "yes",
)
GROUNDEDNESS_CHECK_SAMPLE_RATE: float = float(os.getenv("GROUNDEDNESS_CHECK_SAMPLE_RATE", "1.0"))
GROUNDEDNESS_THRESHOLD: float = float(os.getenv("GROUNDEDNESS_THRESHOLD", "0.5"))

# How much of the retrieved context the judge sees, mirroring the relevance
# gate's ``GATE_MAX_CHUNKS`` / ``GATE_CHUNK_PREVIEW_CHARS``. Generation answers
# from the full top-k (15 chunks of up to CHUNK_SIZE=1000 characters); a judge
# shown only the top 3 cannot see a claim the generator drew from chunk 4 and
# has to call it fabricated, so the metric this module exists to produce
# over-reports hallucination on exactly the answers that used the wider
# context. ``or`` rather than a getenv default so an empty-but-present deploy
# value means the default, not a crash on import; floored at 1 so the judge
# always sees something.
GROUNDEDNESS_MAX_CHUNKS: int = max(1, int(os.getenv("GROUNDEDNESS_MAX_CHUNKS") or "5"))
GROUNDEDNESS_CHUNK_PREVIEW_CHARS: int = max(1, int(os.getenv("GROUNDEDNESS_CHUNK_PREVIEW_CHARS") or "500"))
_MAX_ANSWER_PREVIEW = 1500
_GROUNDEDNESS_LLM_TIMEOUT_S = float(os.getenv("GROUNDEDNESS_LLM_TIMEOUT_S", "3.0"))


def _gate_model() -> str:
    """Resolve the gate model at call time via ``runtime_config``, same
    cheap tier the relevance gate uses, not the expensive primary model."""
    return runtime_config.get_gate_model()


def should_sample() -> bool:
    """Whether this turn should run the groundedness check, per
    ``GROUNDEDNESS_CHECK_SAMPLE_RATE``. Split out so callers can decide to
    skip the check (and its background-thread cost) before even calling
    ``check_groundedness``."""
    if GROUNDEDNESS_CHECK_SAMPLE_RATE >= 1.0:
        return True
    if GROUNDEDNESS_CHECK_SAMPLE_RATE <= 0.0:
        return False
    return random.random() < GROUNDEDNESS_CHECK_SAMPLE_RATE  # noqa: S311 - sampling, not security


def _build_groundedness_prompt(question: str, answer: str, chunks: list) -> str:
    chunk_previews = []
    for i, doc in enumerate(chunks[:GROUNDEDNESS_MAX_CHUNKS], 1):
        content = getattr(doc, "content", "") or ""
        preview = content[:GROUNDEDNESS_CHUNK_PREVIEW_CHARS].replace("\n", " ")
        chunk_previews.append(f"Chunk {i}: {preview}")
    chunks_text = "\n".join(chunk_previews) if chunk_previews else "(no chunks were retrieved for this turn)"

    answer_preview = (answer or "")[:_MAX_ANSWER_PREVIEW]

    return f"""You are a groundedness judge for an AI customer-support assistant. Given a user question, the assistant's answer, and the source document chunks the answer was supposed to be based on, rate how well the answer's factual claims are supported by the chunks.

User question: {question}

Source chunks:
{chunks_text}

Assistant's answer:
{answer_preview}

Rate groundedness on a scale from 0.0 to 1.0:
- 1.0: every specific factual claim in the answer (names, numbers, dates, prices, features) is directly supported by the source chunks
- 0.5: the answer is mostly supported but includes at least one detail not found in the chunks
- 0.0: the answer contains specific factual claims (e.g. a name, price, or statistic) that are NOT in the source chunks at all. Fabricated

General positioning statements, brand voice, or vague reassurances are not factual claims. Only judge specific, checkable claims (names, numbers, dates, prices, certifications, features).

Respond with ONLY a JSON object in this exact format: {{"score": 0.7}}
No explanation, no other text."""


def check_groundedness(
    question: str,
    answer: str,
    chunks: list,
    bot_id: int | None = None,
    client_id: int | None = None,
) -> tuple[bool, float]:
    """Judge whether ``answer``'s factual claims are supported by ``chunks``.

    Returns
    -------
    tuple[bool, float]
        (is_grounded, score). Fails open (is_grounded=True, score=1.0) on any
        error, a slow/flaky judge call must never be mistaken for a real
        hallucination, and this check is observability-only regardless (see
        module docstring), so failing open costs nothing but a missed metric
        point, never a broken user-facing response.
    """
    if not GROUNDEDNESS_CHECK_ENABLED or not answer or not answer.strip():
        return True, 1.0

    prompt = _build_groundedness_prompt(question, answer, chunks)
    model = _gate_model()
    try:
        with langfuse_generation("groundedness-gate", model=model, prompt=prompt) as gen:
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
                        "name": "GroundednessScoreResult",
                        "strict": True,
                        "schema": _GroundednessScoreResult.model_json_schema(),
                    },
                },
                timeout=_GROUNDEDNESS_LLM_TIMEOUT_S,
                metadata={"generation_name": "groundedness-gate"},
            )
            raw = (response.choices[0].message.content or "").strip()
            gen.record_litellm(response, output=raw)
        # Validated against the same schema the provider was held to: an
        # out-of-range or wrong-shaped verdict is a failure to log, not a value
        # to clamp (see ``_GroundednessScoreResult``).
        score = _GroundednessScoreResult.model_validate_json(raw).score
    except Exception as exc:
        # Timeout, rate limit, schema/parse failure, network. All fail open.
        logger.warning("Groundedness gate failed (non-blocking, fail-open): %s", exc)
        return True, 1.0

    is_grounded = score >= GROUNDEDNESS_THRESHOLD
    logger.info(
        "Groundedness gate | bot_id=%s client_id=%s score=%.2f threshold=%.2f grounded=%s",
        bot_id,
        client_id,
        score,
        GROUNDEDNESS_THRESHOLD,
        is_grounded,
    )
    return is_grounded, score
