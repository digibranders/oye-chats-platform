import asyncio
import logging
import os
import re

import litellm

from app.config import FALLBACK_MODEL_KEY_SET, PRIMARY_MODEL_KEY_SET
from app.core.langfuse_client import langfuse_generation
from app.core.metrics import (
    forward_to_sentry_if_alertable,
    increment_metric_counter,
    increment_metric_counter_by,
)
from app.services import runtime_config
from app.services.brand_tone import BRAND_TONE_PRESETS, PRESET_KEYS

# Client-side timeout for non-streaming LLM calls (seconds). Without it a hung
# upstream socket blocks the /chat threadpool worker forever and never trips the
# LiteLLM fallback (audit F09). Env-tunable; 60s leaves headroom for a genuinely
# slow large-context completion while still bounding a hung socket (code-review
# RV9).
_LLM_TIMEOUT_S = float(os.getenv("LLM_TIMEOUT_S", "60"))

# AR-15: same-model retries for TRANSIENT errors (rate limit, timeout,
# connection blip) before litellm's fallback chain kicks in. Without this, a
# brief 429 burst permanently downgrades the turn to the (weaker) fallback
# model with no chance to recover on the primary within the same request.
_LLM_NUM_RETRIES = int(os.getenv("LLM_NUM_RETRIES", "2"))

# Exception classes that indicate a MISCONFIGURATION (bad/revoked key, malformed
# request) rather than a transient provider hiccup. Retrying these is pointless
# (they'll fail identically every time) and silently falling back masks an
# incident that needs a human. These get a distinct log tag + Sentry alert.
_LLM_CONFIG_ERROR_TYPES = (
    litellm.AuthenticationError,
    litellm.BadRequestError,
    litellm.PermissionDeniedError,
)
# Transient/retryable, same-model retry (via num_retries) already covers
# these; distinguished here only for metric/log-tag purposes so an on-call
# engineer can tell "quota exhaustion" apart from "someone revoked the key"
# apart from "unknown error" at a glance.
_LLM_TRANSIENT_ERROR_TYPES = (
    litellm.RateLimitError,
    litellm.Timeout,
    litellm.APIConnectionError,
    litellm.ServiceUnavailableError,
    litellm.InternalServerError,
)
# AR-20: captured at import time (like the tuples above), NOT looked up live
# as `litellm.ContextWindowExceededError` inside an `except` clause. Tests
# that mock the whole `litellm` module (patch("...llm_service.litellm"))
# would otherwise turn that live lookup into a Mock, and Python raises
# TypeError for an `except` clause that isn't a real exception class.
_LLM_CONTEXT_OVERFLOW_ERROR_TYPE = litellm.ContextWindowExceededError


def _classify_and_log_llm_error(exc: Exception, *, context: str) -> None:
    """Log + meter an LLM call failure under a distinct tag by error class,
    forwarding config-type errors to Sentry (AR-13's alerting channel) since
    those need a human, not a retry.

    AR-20: context-window overflow was previously indistinguishable from any
    other config/bad-request error, and unrecoverable, the SAME prompt that
    just overflowed reproduces the identical failure on a naive retry, so a
    visitor who retries after seeing "please try again" gets stuck in a
    deterministic loop with no differentiating log signal. Checked BEFORE
    the generic config-error branch since ``ContextWindowExceededError`` is
    itself a ``BadRequestError`` subclass in litellm.
    """
    if isinstance(exc, _LLM_CONTEXT_OVERFLOW_ERROR_TYPE):
        logger.error(f"LLM context overflow ({context}): {exc}")
        increment_metric_counter("llm_context_overflow")
    elif isinstance(exc, _LLM_CONFIG_ERROR_TYPES):
        logger.error(f"LLM config error ({context}, {type(exc).__name__}): {exc}", exc_info=True)
        increment_metric_counter("llm_config_error")
        forward_to_sentry_if_alertable("llm_config_error")
    elif isinstance(exc, _LLM_TRANSIENT_ERROR_TYPES):
        logger.warning(f"LLM transient error ({context}, {type(exc).__name__}): {exc}")
        increment_metric_counter("llm_transient_error")
    else:
        logger.error(f"LLM API Error ({context}, {type(exc).__name__}): {exc}", exc_info=True)
        increment_metric_counter("llm_unknown_error")


def _meter_fallback_if_used(requested_model: str, response) -> None:
    """AR-16: detect and meter a silent primary->fallback degradation.

    When litellm's own ``fallbacks`` kwarg transparently recovers from a
    primary-model failure, the caller sees a normal successful response.
    There was previously no counter/log marker distinguishing "primary
    answered" from "primary was flaky and fallback quietly saved the turn".
    A primary provider degraded for an hour would recover silently on every
    request with zero visibility. Best-effort: compares the model litellm
    reports as having produced the completion (``response.model``) against
    the model actually requested.
    """
    try:
        actual_model = getattr(response, "model", None)
        if actual_model and actual_model != requested_model:
            logger.warning(f"llm_fallback_triggered | requested={requested_model} actual={actual_model}")
            increment_metric_counter("llm_fallback_triggered")
    except Exception as exc:  # noqa: BLE001 - metering must never break the caller
        logger.debug("Fallback metering failed (non-blocking): %s", exc)


def _meter_token_usage(response, metadata: dict | None) -> None:
    """AR-26: log real prompt/completion token counts per bot for FinOps
    visibility, independent of credit charging.

    The credit ledger charges a flat 1 credit per ``ai_chat`` reply regardless
    of actual token volume (a bot engineered for maximal context (verbose
    custom prompt, near-CAG-lite-threshold KB, chatty visitor history) costs
    several times more in real LLM spend than a minimal bot, charged
    identically). Whether to introduce a token-based cost tier is a pricing/
    product decision requiring business sign-off (it changes what every
    existing customer is billed), not something to change unilaterally in an
    engineering pass, so this only adds the measurement half of the fix:
    real per-bot token counts, queryable the same way as the AR-13 safety-net
    metrics, so FinOps can decide from data whether cross-subsidization is
    actually a problem worth a pricing change.
    """
    try:
        usage = getattr(response, "usage", None)
        if usage is None:
            return
        bot_id = (metadata or {}).get("bot_id")
        prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
        completion_tokens = getattr(usage, "completion_tokens", 0) or 0
        increment_metric_counter_by("llm_tokens_prompt", prompt_tokens, bot_id=bot_id)
        increment_metric_counter_by("llm_tokens_completion", completion_tokens, bot_id=bot_id)
    except Exception as exc:  # noqa: BLE001 - metering must never break the caller
        logger.debug("Token usage metering failed (non-blocking): %s", exc)


def _primary_model() -> str:
    """Resolve the primary LLM model at call time so super-admins can swap it
    via /superadmin/model-config without a restart."""
    return runtime_config.get_primary_model()


def _fallback_model() -> str:
    return runtime_config.get_fallback_model()


def _llm_fallbacks() -> list[dict[str, list[str]]] | None:
    """LiteLLM fallback chain for the current primary→fallback pair, or None
    when keys aren't configured for both models."""
    if PRIMARY_MODEL_KEY_SET and FALLBACK_MODEL_KEY_SET:
        return [{_primary_model(): [_fallback_model()]}]
    return None


logger = logging.getLogger(__name__)


# ── Canned generation-failure messages ──────────────────────────────────────
# ``generate_response`` never raises, on a config gap, an empty completion, or
# an LLM/API error (both primary and fallback exhausted) it returns one of these
# fixed strings so the widget always renders *something*. The credit-charged
# chat path detects failure structurally via ``generate_response_checked`` (the
# ``failed`` flag), NOT by matching these strings, so a bot cannot force a refund
# by echoing one of them.
LLM_CONFIG_ERROR_MESSAGE = "Configuration error: AI service is not configured. Please contact the administrator."
LLM_EMPTY_RESPONSE_MESSAGE = "I'm sorry, I couldn't generate a response. Please try again."
LLM_API_ERROR_MESSAGE = "I encountered an error generating the response. Please try again."
# AR-20: deliberately does NOT say "please try again", a context-window
# overflow is deterministic for the same conversation; a naive retry
# reproduces the identical failure, trapping the visitor in an unrecoverable
# loop with no differentiating signal that "try again" won't help this time.
LLM_CONTEXT_OVERFLOW_MESSAGE = (
    "This conversation has gotten quite long for me to process at once. "
    "Could you start a new conversation, or ask a shorter, more specific question?"
)


def _bare_model(model: str) -> str:
    """Strip a LiteLLM provider prefix (``openai/``, ``azure/`` …) from a model id."""
    return model.split("/", 1)[1] if "/" in model else model


def _apply_model_family_kwargs(kwargs: dict, model: str) -> None:
    """Inject family-specific parameters into a LiteLLM ``completion`` kwargs dict.

    gpt-5 family models default to ``reasoning_effort="medium"``, which spends
    most of the output-token budget on hidden reasoning tokens before any
    visible content is produced. With our typical RAG prompts (≈25k chars of
    context) this manifests as empty completions. Sentry: "LLM returned empty
    response". The two sub-families use different "no reasoning" sentinels:

    * gpt-5.4 family (gpt-5.4, gpt-5.4-mini, …): ``reasoning_effort="none"``
      (``"minimal"`` is rejected with ``Unsupported value`` from OpenAI;
      valid values are ``none|low|medium|high|xhigh``).
    * Older gpt-5 family (gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-codex):
      ``reasoning_effort="minimal"`` (``"none"`` is not supported there;
      valid values are ``minimal|low|medium|high``).

    ``litellm.drop_params=True`` (set in ``app/main.py`` and
    ``app/worker/settings.py``) silently strips this for non-OpenAI providers
    if the LiteLLM fallback path retries with Gemini.
    """
    bare = _bare_model(model)
    if bare.startswith("gpt-5.4"):
        kwargs.setdefault("reasoning_effort", "none")
    elif bare.startswith("gpt-5"):
        kwargs.setdefault("reasoning_effort", "minimal")


def _generate_response(
    prompt: str,
    *,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    metadata: dict | None = None,
    model: str | None = None,
) -> tuple[str, bool]:
    """Core non-streaming LLM call. Returns ``(text, failed)``.

    ``failed`` is True when no real answer was produced. Missing key, empty
    completion, or an API error with both primary and fallback exhausted. This
    is a **structural** signal derived from the call outcome, NOT from matching
    the returned text, so a caller that refunds a per-answer credit cannot be
    tricked by a bot whose system prompt is crafted to echo a canned failure
    string.

    ``system_prompt``: when set, sent as a separate ``role: system`` message
    ahead of ``prompt`` (``role: user``) instead of folding everything into
    one message (AR-27). Lets a provider's prefix-based prompt cache match
    the stable system message turn over turn even as ``prompt`` (per-turn
    state/context/history/question) changes.

    ``model``: override the resolved primary model for this call only (e.g.
    ``runtime_config.get_gate_model()`` for non-generative classification/
    rewrite tasks. AR-10: these don't need the expensive customer-facing
    model tier, and routing them to the same cheap tier already proven
    adequate by the relevance gate cuts primary-model call volume with no
    quality loss). When set, no cross-provider fallback chain is attempted
    (matching the gate's own single-model-no-fallback contract). Callers
    needing fallback protection should leave this unset.
    """
    resolved_model = model or _primary_model()
    generation_name = (metadata or {}).get("generation_name", "llm-generation")
    if model is None and not PRIMARY_MODEL_KEY_SET:
        logger.error(f"Cannot generate response: API key for primary model '{resolved_model}' is not set.")
        return LLM_CONFIG_ERROR_MESSAGE, True
    try:
        logger.info(f"Generating LLM response | model={resolved_model} | prompt_length={len(prompt)}")
        messages = (
            [{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}]
            if system_prompt
            else [{"role": "user", "content": prompt}]
        )
        kwargs: dict = {
            "model": resolved_model,
            "messages": messages,
        }
        # Only include optional kwargs when they're set. LiteLLM's
        # fallback path internally iterates over ``metadata`` and crashes
        # with ``argument of type 'NoneType' is not iterable`` if we pass
        # ``metadata=None`` while ``fallbacks`` is also configured.
        if metadata is not None:
            kwargs["metadata"] = metadata
        if model is None:
            fallbacks = _llm_fallbacks()
            if fallbacks:
                kwargs["fallbacks"] = fallbacks
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if temperature is not None:
            kwargs["temperature"] = temperature
        _apply_model_family_kwargs(kwargs, resolved_model)

        with langfuse_generation(generation_name, model=resolved_model, prompt=prompt) as gen:
            kwargs.setdefault("timeout", _LLM_TIMEOUT_S)
            kwargs.setdefault("num_retries", _LLM_NUM_RETRIES)
            response = litellm.completion(**kwargs)
            content = response.choices[0].message.content
            gen.record_litellm(response, output=content)

        _meter_fallback_if_used(resolved_model, response)
        _meter_token_usage(response, metadata)

        if content:
            logger.info(f"LLM response received | length={len(content)}")
            return content, False
        else:
            logger.warning("LLM returned empty response.")
            return LLM_EMPTY_RESPONSE_MESSAGE, True
    except _LLM_CONTEXT_OVERFLOW_ERROR_TYPE as e:
        _classify_and_log_llm_error(e, context=generation_name)
        return LLM_CONTEXT_OVERFLOW_MESSAGE, True
    except Exception as e:
        _classify_and_log_llm_error(e, context=generation_name)
        return LLM_API_ERROR_MESSAGE, True


def generate_response(
    prompt: str,
    *,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    metadata: dict | None = None,
    model: str | None = None,
) -> str:
    """Generate a non-streaming response via LiteLLM (text only).

    ``system_prompt``: see :func:`_generate_response` (AR-27).

    ``model``: see :func:`_generate_response`. Override for non-generative
    (classification/rewrite) callers that should use a cheaper tier.
    """
    return _generate_response(
        prompt,
        system_prompt=system_prompt,
        max_tokens=max_tokens,
        temperature=temperature,
        metadata=metadata,
        model=model,
    )[0]


def generate_response_checked(
    prompt: str,
    *,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    metadata: dict | None = None,
    model: str | None = None,
) -> tuple[str, bool]:
    """Like :func:`generate_response` but also returns a structural ``failed``
    flag (True when generation produced only a canned error, i.e. no real
    answer). Use this on the credit-charged chat path so a failed reply can be
    refunded without relying on forgeable answer-text matching."""
    return _generate_response(
        prompt,
        system_prompt=system_prompt,
        max_tokens=max_tokens,
        temperature=temperature,
        metadata=metadata,
        model=model,
    )


def classify_brand_tone(
    content_sample: str,
    *,
    metadata: dict | None = None,
    timeout: float | None = None,
    num_retries: int | None = None,
) -> str | None:
    """Classify scraped website content into the closest brand-tone preset key.

    Returns a key from :data:`brand_tone.PRESET_KEYS` (e.g. ``"professional"``)
    or ``None`` when the content is empty, extraction fails, or the model returns
    something off-menu. Callers leave the bot's tone untouched on ``None``.

    Uses the gate-tier model (AR-10): a constrained single-label classification,
    the same cheap-tier judging shape as the relevance gate. No cross-provider
    fallback, the try/except below fails safe (returns None) on any error.

    ``timeout``/``num_retries`` override the default LLM budget. Interactive
    request-path callers (the "detect tone" endpoint, where a user is waiting)
    pass a tight bound so a slow model can't pin a worker thread for the full
    ~180s worst case; background callers keep the generous default.
    """
    if not content_sample.strip():
        return None
    try:
        _model = runtime_config.get_gate_model()
        menu = "\n".join(f"- {p['key']}: {p['label']}" for p in BRAND_TONE_PRESETS)
        prompt = f"""Classify the brand's communication tone from this website content \
into exactly ONE of these presets. Consider formality, personality, vocabulary, and energy.

Presets (return the key on the left):
{menu}

Website content:
{content_sample[:3000]}

Return ONLY the single preset key (e.g. "professional"), nothing else."""

        kwargs: dict = {
            "model": _model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 10,
            "metadata": metadata or {"generation_name": "brand-tone-classification"},
        }
        _apply_model_family_kwargs(kwargs, _model)
        with langfuse_generation("brand-tone-classification", model=_model, prompt=prompt) as gen:
            kwargs.setdefault("timeout", timeout if timeout is not None else _LLM_TIMEOUT_S)
            kwargs.setdefault("num_retries", num_retries if num_retries is not None else _LLM_NUM_RETRIES)
            response = litellm.completion(**kwargs)
            raw = (response.choices[0].message.content or "").strip()
            gen.record_litellm(response, output=raw)
        # Normalize: strip quotes/punctuation/whitespace, lowercase; accept only a known key.
        key = raw.strip().strip("\"'`.").lower()
        if key in PRESET_KEYS:
            logger.info("Brand tone classified: %s", key)
            return key
        logger.warning("Brand tone classification returned off-menu value: %r", raw)
        return None
    except Exception as e:
        logger.warning(f"Brand tone classification failed (non-blocking): {e}")
        return None


def generate_seed_questions(
    company_name: str | None,
    company_description: str | None,
    *,
    count: int = 5,
    metadata: dict | None = None,
) -> list[str]:
    """Propose candidate onboarding "test" questions a real visitor would ask.

    Returns up to ``count`` short, natural questions derived from the company's
    auto-extracted name + description. These are only *candidates*, the caller
    (``seed_questions_service``) verifies each is actually answerable from the
    bot's indexed content before surfacing any, so a hallucinated or off-base
    question never reaches the user. Returns ``[]`` on any failure (non-blocking).

    Uses the gate-tier model (AR-10), matching :func:`extract_company_context`.
    """
    desc = (company_description or "").strip()
    name = (company_name or "").strip()
    if not desc and not name:
        return []
    try:
        _model = runtime_config.get_gate_model()
        prompt = f"""You are helping a business owner test their new website support chatbot.

Company name: {name or "(unknown)"}
What they do: {desc or "(no description available)"}

Write {count} short, natural questions that a real visitor to this company's
website would ask its support chatbot, the kind that should be answerable from
the company's own website content (services, pricing, hours, contact, how it
works, etc.). Keep each question under 12 words, specific to THIS company (not
generic filler), and phrased the way a customer actually types.

Return ONLY the questions, one per line, no numbering, no quotes, no extra text."""

        kwargs: dict = {
            "model": _model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 200,
            "metadata": metadata or {"generation_name": "seed-questions"},
        }
        _apply_model_family_kwargs(kwargs, _model)
        with langfuse_generation("seed-questions", model=_model, prompt=prompt) as gen:
            kwargs.setdefault("timeout", _LLM_TIMEOUT_S)
            kwargs.setdefault("num_retries", _LLM_NUM_RETRIES)
            response = litellm.completion(**kwargs)
            text = (response.choices[0].message.content or "").strip()
            gen.record_litellm(response, output=text)
        if not text:
            return []

        questions: list[str] = []
        for raw in text.splitlines():
            # Strip leading list markers / numbering / quotes the model may add.
            line = raw.strip().lstrip("-*•").strip()
            line = re.sub(r"^\d+[.)]\s*", "", line).strip().strip('"').strip()
            if 5 <= len(line) <= 140 and line.endswith("?"):
                questions.append(line)
        # De-dupe (case-insensitive) preserving order.
        seen: set[str] = set()
        deduped: list[str] = []
        for q in questions:
            key = q.lower()
            if key not in seen:
                seen.add(key)
                deduped.append(q)
        return deduped[:count]
    except Exception as e:
        logger.warning(f"Seed-question generation failed (non-blocking): {e}")
        return []


def generate_tone_sample(brand_tone: str, question: str, *, metadata: dict | None = None) -> str | None:
    """Generate a 1-2 sentence sample bot reply written in ``brand_tone``.

    Powers the admin "Preview voice" button so the customer can hear how the bot
    will sound before saving. Returns the sample string, or ``None`` on empty
    input / any error (caller maps ``None`` to a 503). Gate-tier model.
    """
    if not brand_tone.strip() or not question.strip():
        return None
    try:
        _model = runtime_config.get_gate_model()
        prompt = f"""You are a website support chatbot. Reply to the visitor's message in 1-2 short \
sentences, strictly matching this brand voice:

BRAND VOICE: {brand_tone[:500]}

Visitor: {question[:200]}

Return ONLY the reply text, no quotes or preamble."""

        kwargs: dict = {
            "model": _model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 80,
            "metadata": metadata or {"generation_name": "brand-tone-preview"},
        }
        _apply_model_family_kwargs(kwargs, _model)
        with langfuse_generation("brand-tone-preview", model=_model, prompt=prompt) as gen:
            kwargs.setdefault("timeout", _LLM_TIMEOUT_S)
            kwargs.setdefault("num_retries", _LLM_NUM_RETRIES)
            response = litellm.completion(**kwargs)
            sample = (response.choices[0].message.content or "").strip().strip('"')
            gen.record_litellm(response, output=sample)
        return sample[:400] if sample else None
    except Exception as e:
        logger.warning(f"Brand tone preview failed (non-blocking): {e}")
        return None


def extract_company_context(
    content_sample: str,
    *,
    metadata: dict | None = None,
    timeout: float | None = None,
    num_retries: int | None = None,
    strict: bool = False,
) -> dict | None:
    """Analyze scraped website content and extract the company name and description.

    Returns ``{"name": "Acme Corp", "description": "Acme Corp is a ..."}``
    or *None* if extraction fails.

    Uses the gate-tier model (AR-10). See :func:`classify_brand_tone` for the
    rationale; identical shape of task, identical fix.

    ``timeout`` / ``num_retries`` override the module defaults (60s × 3
    attempts ≈ 180s worst case). A caller on a small shared thread pool needs a
    tighter bound than a caller on the request path.

    ``strict=True`` re-raises provider errors instead of returning ``None``.
    Without it the caller cannot tell "this page describes no company" from
    "the model was unreachable", and a caller that PERSISTS the former would
    otherwise record a provider outage as a permanent fact about the content.
    """
    if not content_sample.strip():
        return None
    try:
        _model = runtime_config.get_gate_model()
        prompt = f"""Analyze this website content and extract two things:

1. COMPANY NAME: The exact official company/brand name (e.g., "Fynix Digital", "Acme Corp").
2. COMPANY DESCRIPTION: A 2-3 sentence factual description of what the company does, its core services/products, and industry. Write in third person.

Respond in EXACTLY this format (two lines, no extra text):
NAME: <company name>
DESCRIPTION: <company description>

Example:
NAME: Fynix Digital
DESCRIPTION: Fynix Digital is a branding and marketing agency based in India. They specialize in brand strategy, UI/UX design, website development, SEO, and paid advertising for businesses of all sizes.

Website content:
{content_sample[:4000]}"""

        kwargs: dict = {
            "model": _model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 250,
            "metadata": metadata or {"generation_name": "company-context-extraction"},
        }
        _apply_model_family_kwargs(kwargs, _model)
        with langfuse_generation("company-context-extraction", model=_model, prompt=prompt) as gen:
            kwargs.setdefault("timeout", timeout if timeout is not None else _LLM_TIMEOUT_S)
            kwargs.setdefault("num_retries", num_retries if num_retries is not None else _LLM_NUM_RETRIES)
            response = litellm.completion(**kwargs)
            text = (response.choices[0].message.content or "").strip()
            gen.record_litellm(response, output=text)
        if not text:
            return None

        # Parse structured response
        name = None
        description = None
        for line in text.splitlines():
            line = line.strip()
            if line.upper().startswith("NAME:"):
                name = line[5:].strip().strip('"')
            elif line.upper().startswith("DESCRIPTION:"):
                description = line[12:].strip().strip('"')

        if not name and not description and len(text) < 1000:
            # Fallback: treat entire response as description
            description = text

        result = {}
        if name and 2 <= len(name) <= 100:
            result["name"] = name
        if description and len(description) < 1000:
            result["description"] = description

        if result:
            logger.info(
                f"Company context extracted: name={result.get('name')}, desc={result.get('description', '')[:60]}..."
            )
            return result
        return None
    except Exception as e:
        logger.warning(f"Company context extraction failed (non-blocking): {e}")
        if strict:
            raise
        return None


_STREAM_CHUNK_TIMEOUT_S = 60


async def _stream_from_model(
    model: str,
    prompt: str,
    max_tokens: int | None,
    metadata: dict | None,
    temperature: float | None = None,
    system_prompt: str | None = None,
):
    """Async inner generator: stream chunks from ``model``, enforcing per-chunk timeout.

    Uses ``litellm.acompletion`` so the event loop is never blocked waiting for
    the next chunk. Each chunk read is wrapped in ``asyncio.wait_for`` so a
    stalled upstream connection (TCP open but no bytes flowing) raises
    ``TimeoutError`` within ``_STREAM_CHUNK_TIMEOUT_S`` seconds.

    Raises on connection / API error so the caller can fall back to another model.

    The underlying LiteLLM stream wrapper holds an httpx ``AsyncClient`` stream;
    if the SSE consumer disconnects mid-response the generator is closed via
    ``GeneratorExit`` and the httpx task leaks (Sentry: "Task was destroyed but
    it is pending!"). The ``finally`` block below explicitly aborts the wrapper.
    """
    generation_name = (metadata or {}).get("generation_name", "llm-stream")
    _output = ""
    with langfuse_generation(generation_name, model=model, prompt=prompt) as gen:
        try:
            messages = (
                [{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}]
                if system_prompt
                else [{"role": "user", "content": prompt}]
            )
            kwargs: dict = {
                "model": model,
                "messages": messages,
                "stream": True,
                # AR-26: ask the provider for a final usage-only chunk (empty
                # ``choices``, populated ``usage``) so streamed replies can be
                # token-metered the same as non-streaming ones, without this,
                # a streaming response never reports token counts at all.
                "stream_options": {"include_usage": True},
                "metadata": metadata,
            }
            if max_tokens is not None:
                kwargs["max_tokens"] = max_tokens
            if temperature is not None:
                kwargs["temperature"] = temperature
            kwargs.setdefault("num_retries", _LLM_NUM_RETRIES)
            _apply_model_family_kwargs(kwargs, model)
            response = await litellm.acompletion(**kwargs)
            try:
                response_iter = response.__aiter__()
                while True:
                    try:
                        chunk = await asyncio.wait_for(
                            response_iter.__anext__(),
                            timeout=_STREAM_CHUNK_TIMEOUT_S,
                        )
                    except StopAsyncIteration:
                        break
                    except TimeoutError as exc:
                        raise TimeoutError(
                            f"LLM chunk timeout after {_STREAM_CHUNK_TIMEOUT_S}s. Upstream stalled"
                        ) from exc
                    usage = getattr(chunk, "usage", None)
                    if usage is not None:
                        _meter_token_usage(chunk, metadata)
                    if not chunk.choices:
                        continue
                    content = chunk.choices[0].delta.content
                    if content:
                        _output += content
                        yield content
            finally:
                aclose = getattr(response, "aclose", None)
                if aclose is not None:
                    try:
                        await aclose()
                    except Exception as close_err:
                        logger.debug(f"LiteLLM stream aclose() raised on cleanup: {close_err}")
        finally:
            gen.update(output=_output, model=model)


async def generate_response_stream(
    prompt: str,
    *,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    metadata: dict | None = None,
):
    """Async generator: stream text chunks via LiteLLM.

    ``system_prompt``: see :func:`_generate_response` (AR-27). Sent as a
    separate ``role: system`` message on both the primary and fallback calls.

    Fallback chain:
    1. Primary model (``LLM_MODEL``. Default: OpenAI gpt-5.4-mini)
    2. Fallback model (``FALLBACK_MODEL``. Default: Gemini 2.5 Flash) if primary raises
    3. Generic error message if both fail

    Each chunk read uses ``asyncio.wait_for`` so a stalled upstream TCP connection
    raises ``TimeoutError`` within ``_STREAM_CHUNK_TIMEOUT_S`` seconds instead of
    blocking the event loop forever.
    """
    if not PRIMARY_MODEL_KEY_SET:
        logger.error(f"Cannot stream response: API key for primary model '{_primary_model()}' is not set.")
        yield "Configuration error: AI service is not configured. Please contact the administrator."
        return

    logger.info(f"Starting LLM stream | model={_primary_model()} | prompt_length={len(prompt)}")
    # Track whether the visitor has already received any text from the primary
    # model. If they have, falling back mid-stream would concatenate a brand-new
    # complete answer from the fallback onto a half-finished primary answer,
    # the SSE consumer cannot rewind, so the user sees two stitched-together
    # responses. In that case we end gracefully instead of falling back.
    primary_chunks_yielded = 0
    try:
        async for chunk in _stream_from_model(
            _primary_model(), prompt, max_tokens, metadata, temperature, system_prompt
        ):
            primary_chunks_yielded += 1
            yield chunk
        return
    except TimeoutError as e:
        logger.error(str(e))
        yield " [Response timed out. Please try again.]"
        return
    except Exception as primary_err:
        _classify_and_log_llm_error(primary_err, context="stream-primary")
        if primary_chunks_yielded > 0:
            logger.warning(
                f"Primary LLM stream failed mid-response after {primary_chunks_yielded} chunks "
                f"({type(primary_err).__name__}): {primary_err}. Suppressing fallback to avoid "
                "concatenating two answers on the same SSE stream."
            )
            yield " [Response interrupted. Please try again.]"
            return
        logger.warning(
            f"Primary LLM stream failed before yielding any chunks ({type(primary_err).__name__}): "
            f"{primary_err}. Attempting fallback to {_fallback_model()}"
        )

    # Fallback to secondary model
    if not FALLBACK_MODEL_KEY_SET:
        logger.error(f"Fallback model unavailable: API key for '{_fallback_model()}' is not set.")
        yield " [I encountered an error. Please try again.]"
        return

    try:
        logger.info(f"LLM stream fallback | model={_fallback_model()}")
        increment_metric_counter("llm_fallback_triggered")
        async for chunk in _stream_from_model(
            _fallback_model(), prompt, max_tokens, metadata, temperature, system_prompt
        ):
            yield chunk
    except TimeoutError as e:
        logger.error(f"Fallback stream timed out: {e}")
        yield " [Response timed out. Please try again.]"
    except _LLM_CONTEXT_OVERFLOW_ERROR_TYPE as fallback_err:
        # AR-20: both primary and fallback overflowed, same conversation
        # reproduces this deterministically, so don't tell the visitor to
        # "try again" (see LLM_CONTEXT_OVERFLOW_MESSAGE for why).
        _classify_and_log_llm_error(fallback_err, context="stream-fallback")
        yield f" [{LLM_CONTEXT_OVERFLOW_MESSAGE}]"
    except Exception as fallback_err:
        _classify_and_log_llm_error(fallback_err, context="stream-fallback")
        yield " [I encountered an error. Please try again.]"
