import asyncio
import logging
import os
import re

import litellm

from app.config import FALLBACK_MODEL_KEY_SET, PRIMARY_MODEL_KEY_SET
from app.core.langfuse_client import langfuse_generation, litellm_usage
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


def _same_model(requested_model: str, actual_model: str) -> bool:
    """Whether ``actual_model`` (as LiteLLM reports it) is the model we asked for.

    Provider prefixes are stripped from both sides and the comparison is
    case-insensitive. A dated snapshot suffix counts as the same model in
    either direction: ``gpt-5.4-mini`` requested and ``gpt-5.4-mini-2026-03-01``
    served is the primary answering under its resolved snapshot, and a pinned
    snapshot request served under the bare alias is the same thing the other
    way round. Two genuinely different ids (``gpt-5.4-mini`` vs
    ``gemini-2.5-flash``) share no prefix and never match.
    """
    requested = _bare_model(requested_model).strip().lower()
    actual = _bare_model(actual_model).strip().lower()
    if not requested or not actual:
        return False
    return requested == actual or actual.startswith(requested) or requested.startswith(actual)


def _meter_fallback_if_used(requested_model: str, response) -> None:
    """AR-16: detect and meter a silent primary->fallback degradation.

    When litellm's own ``fallbacks`` kwarg transparently recovers from a
    primary-model failure, the caller sees a normal successful response.
    There was previously no counter/log marker distinguishing "primary
    answered" from "primary was flaky and fallback quietly saved the turn".
    A primary provider degraded for an hour would recover silently on every
    request with zero visibility.

    LiteLLM reports the model under the PROVIDER's name: for a request of
    ``openai/gpt-5.4-mini``, ``response.model`` comes back as the bare, usually
    snapshot-dated ``gpt-5.4-mini-2026-03-01``. An earlier version compared
    that string to the prefixed request id verbatim, so this counter fired on
    every successful primary call and ``/health/full``'s ``fallback_count_1h``
    was pure noise. Two signals are used instead, either of which marks a
    fallback:

    * the provider-stripped names genuinely differ (:func:`_same_model`);
    * LiteLLM's ``response._hidden_params["custom_llm_provider"]`` (stamped on
      every completion) names a provider other than the requested prefix.
      This catches a same-name-different-route fallback the name check cannot.

    Best-effort: a response without either signal (a test double, an exotic
    provider) is left alone rather than guessed at.
    """
    try:
        hidden = getattr(response, "_hidden_params", None)
        hidden = hidden if isinstance(hidden, dict) else {}
        actual_model = getattr(response, "model", None)
        if not isinstance(actual_model, str) or not actual_model:
            actual_model = hidden.get("model")
        actual_provider = hidden.get("custom_llm_provider")
        requested_provider = requested_model.split("/", 1)[0] if "/" in requested_model else None

        provider_differs = (
            isinstance(actual_provider, str)
            and bool(actual_provider)
            and requested_provider is not None
            and actual_provider.lower() != requested_provider.lower()
        )
        model_differs = (
            isinstance(actual_model, str) and bool(actual_model) and not _same_model(requested_model, actual_model)
        )
        if provider_differs or model_differs:
            logger.warning(
                f"llm_fallback_triggered | requested={requested_model} actual={actual_model} "
                f"provider={actual_provider or 'unknown'}"
            )
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

    * gemini-2.5 family: ``reasoning_effort="disable"``, which LiteLLM maps to
      Gemini's ``thinkingBudget: 0``. Gemini 2.5 reasons by default and has
      exactly the same failure: measured live at ``max_tokens=10``, the model
      spent 7 tokens thinking, hit ``finishReason: MAX_TOKENS`` and returned
      ``''`` -- for an answer that is one token long. That is what broke
      "Detect from my site": ``classify_brand_tone`` caps at 10, saw the empty
      string, and the route reported "Couldn't detect a tone" while the key,
      the credits and the content were all fine.

      The sentinel differs per family and they reject each other's values, so
      this cannot be one shared constant. ``"disable"`` is Gemini's;
      ``thinking={"type": "disabled"}`` is NOT honoured on this path (verified
      against litellm 1.89.4 -- it still returns '').

      Older Gemini (2.0, 1.5) does not reason and is deliberately left alone.

    ``litellm.drop_params=True`` (set in ``app/main.py`` and
    ``app/worker/settings.py``) silently strips this for providers that do not
    understand it if the LiteLLM fallback path retries elsewhere.
    """
    bare = _bare_model(model)
    if bare.startswith("gpt-5.4"):
        kwargs.setdefault("reasoning_effort", "none")
    elif bare.startswith("gpt-5"):
        kwargs.setdefault("reasoning_effort", "minimal")
    elif bare.startswith("gemini-2.5"):
        kwargs.setdefault("reasoning_effort", "disable")


def _build_messages(prompt: str, system_prompt: str | None) -> list[dict[str, str]]:
    """The chat ``messages`` list for one call (AR-27 system/user split).

    ``system_prompt`` set → a separate ``role: system`` message ahead of the
    ``role: user`` prompt, so a provider's prefix-based prompt cache can match
    the stable half turn over turn. Unset → the single user message every
    non-hybrid-prompt caller (BANT extraction, query rewrite, …) has always sent.
    The same list is handed to LiteLLM and to the Langfuse generation.
    """
    if system_prompt:
        return [{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}]
    return [{"role": "user", "content": prompt}]


def _generate_response(
    prompt: str,
    *,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    metadata: dict | None = None,
    model: str | None = None,
    timeout: float | None = None,
    num_retries: int | None = None,
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
    state/context/history/question) changes. The Langfuse generation traces
    the same two messages, so a regression in the stable half is visible on
    the trace instead of hidden behind the user turn.

    ``model``: override the resolved primary model for this call only (e.g.
    ``runtime_config.get_gate_model()`` for non-generative classification/
    rewrite tasks. AR-10: these don't need the expensive customer-facing
    model tier, and routing them to the same cheap tier already proven
    adequate by the relevance gate cuts primary-model call volume with no
    quality loss). When set, no cross-provider fallback chain is attempted
    (matching the gate's own single-model-no-fallback contract). Callers
    needing fallback protection should leave this unset.

    ``timeout`` / ``num_retries``: per-call override of the module defaults
    (``LLM_TIMEOUT_S`` per attempt × ``LLM_NUM_RETRIES`` retries, ≈180s worst
    case). A classifier on the visitor's critical path (the handoff-intent
    check runs every turn and is awaited before retrieval) needs a bound of a
    few seconds and no retries; a background caller keeps the generous
    default. ``None`` keeps the default, so existing callers are unchanged.
    Same contract as :func:`classify_brand_tone` / :func:`extract_company_context`.
    """
    resolved_model = model or _primary_model()
    generation_name = (metadata or {}).get("generation_name", "llm-generation")
    if model is None and not PRIMARY_MODEL_KEY_SET:
        logger.error(f"Cannot generate response: API key for primary model '{resolved_model}' is not set.")
        return LLM_CONFIG_ERROR_MESSAGE, True
    try:
        logger.info(f"Generating LLM response | model={resolved_model} | prompt_length={len(prompt)}")
        messages = _build_messages(prompt, system_prompt)
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

        with langfuse_generation(generation_name, model=resolved_model, input=messages) as gen:
            kwargs.setdefault("timeout", timeout if timeout is not None else _LLM_TIMEOUT_S)
            kwargs.setdefault("num_retries", num_retries if num_retries is not None else _LLM_NUM_RETRIES)
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
    timeout: float | None = None,
    num_retries: int | None = None,
) -> str:
    """Generate a non-streaming response via LiteLLM (text only).

    ``system_prompt``: see :func:`_generate_response` (AR-27).

    ``model``: see :func:`_generate_response`. Override for non-generative
    (classification/rewrite) callers that should use a cheaper tier.

    ``timeout`` / ``num_retries``: see :func:`_generate_response`. Per-call
    budget for callers on a latency-critical path; ``None`` keeps the defaults.
    """
    return _generate_response(
        prompt,
        system_prompt=system_prompt,
        max_tokens=max_tokens,
        temperature=temperature,
        metadata=metadata,
        model=model,
        timeout=timeout,
        num_retries=num_retries,
    )[0]


def generate_response_checked(
    prompt: str,
    *,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    metadata: dict | None = None,
    model: str | None = None,
    timeout: float | None = None,
    num_retries: int | None = None,
) -> tuple[str, bool]:
    """Like :func:`generate_response` but also returns a structural ``failed``
    flag (True when generation produced only a canned error, i.e. no real
    answer). Use this on the credit-charged chat path so a failed reply can be
    refunded without relying on forgeable answer-text matching.

    ``timeout`` / ``num_retries``: see :func:`_generate_response`."""
    return _generate_response(
        prompt,
        system_prompt=system_prompt,
        max_tokens=max_tokens,
        temperature=temperature,
        metadata=metadata,
        model=model,
        timeout=timeout,
        num_retries=num_retries,
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


# Per-chunk read bound on the streaming path: once the first chunk has arrived,
# a gap this long between chunks means the upstream socket stalled (TCP open,
# no bytes flowing) and the stream is abandoned rather than held open.
_STREAM_CHUNK_TIMEOUT_S = 60

# One deadline for "request + first chunk" on the streaming path. Before this
# existed the stream bounded only the gaps BETWEEN chunks: the per-chunk
# ``wait_for`` could not start until ``litellm.acompletion`` returned, and that
# call carried no ``timeout`` at all, so a primary that accepted the connection
# and then stalled before emitting anything held the visitor for LiteLLM's
# default request timeout (``DEFAULT_REQUEST_TIMEOUT_SECONDS`` = 6000s). Nothing
# raised, so the fallback model was never tried. Ten seconds is far above a
# healthy time-to-first-token (~1-2s) and far below what a visitor will wait on
# a blank widget. Env-tunable. The budget deliberately also covers LiteLLM's own
# same-model retries: a primary that needs several retries to produce a token
# forfeits the turn to the fallback instead of stretching the wait.
_LLM_FIRST_TOKEN_TIMEOUT_S = float(os.getenv("LLM_FIRST_TOKEN_TIMEOUT_S", "10.0"))


async def _stream_from_model(
    model: str,
    prompt: str,
    max_tokens: int | None,
    metadata: dict | None,
    temperature: float | None = None,
    system_prompt: str | None = None,
):
    """Async inner generator: stream chunks from ``model`` under two deadlines.

    Uses ``litellm.acompletion`` so the event loop is never blocked waiting for
    the next chunk. Two bounds apply:

    * **First chunk**: a single ``_LLM_FIRST_TOKEN_TIMEOUT_S`` deadline covers
      the request itself (connect, TLS, LiteLLM's same-model retries) AND the
      wait for the first chunk. A primary that accepts the connection and
      stalls before emitting anything raises ``TimeoutError`` here, before the
      visitor has seen any text, so :func:`generate_response_stream` takes the
      fallback model instead of showing a timeout message.
    * **Per chunk**: every later read gets a fresh ``_STREAM_CHUNK_TIMEOUT_S``
      deadline, so a connection that stalls mid-answer (TCP open, no bytes)
      raises ``TimeoutError`` instead of hanging.

    ``timeout=_LLM_TIMEOUT_S`` is also passed to LiteLLM so the provider
    client's own connect/read timeouts are bounded rather than left at the
    LiteLLM default; for a stream that is a per-read bound, not a cap on the
    whole answer.

    Raises on connection / API error so the caller can fall back to another model.

    Token usage is metered ONCE, from the last usage-bearing chunk, after the
    stream ends (AR-26). OpenAI sends usage on a single final chunk, but a
    provider that attaches cumulative usage to every chunk would otherwise have
    been summed once per chunk. The same usage lands on the Langfuse
    generation, which previously recorded streamed replies with no usage at all.

    The underlying LiteLLM stream wrapper holds an httpx ``AsyncClient`` stream;
    if the SSE consumer disconnects mid-response the generator is closed via
    ``GeneratorExit`` and the httpx task leaks (Sentry: "Task was destroyed but
    it is pending!"). The ``finally`` block below explicitly aborts the wrapper,
    on the first-chunk deadline path too, where the wrapper exists only if the
    request itself had already returned.
    """
    generation_name = (metadata or {}).get("generation_name", "llm-stream")
    messages = _build_messages(prompt, system_prompt)
    _output = ""
    last_usage_chunk = None
    with langfuse_generation(generation_name, model=model, input=messages) as gen:
        try:
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
            kwargs.setdefault("timeout", _LLM_TIMEOUT_S)
            kwargs.setdefault("num_retries", _LLM_NUM_RETRIES)
            _apply_model_family_kwargs(kwargs, model)

            first_token_timeout_s = _LLM_FIRST_TOKEN_TIMEOUT_S
            loop = asyncio.get_running_loop()
            first_token_deadline = loop.time() + first_token_timeout_s
            response = None
            try:
                try:
                    async with asyncio.timeout_at(first_token_deadline):
                        response = await litellm.acompletion(**kwargs)
                except TimeoutError as exc:
                    raise TimeoutError(
                        f"LLM first token timeout after {first_token_timeout_s:g}s. No response to the request"
                    ) from exc
                response_iter = response.__aiter__()
                # The first read spends whatever the request left of the same
                # deadline; every later read gets its own per-chunk window.
                chunk_deadline = first_token_deadline
                received_any = False
                while True:
                    try:
                        async with asyncio.timeout_at(chunk_deadline):
                            chunk = await response_iter.__anext__()
                    except StopAsyncIteration:
                        break
                    except TimeoutError as exc:
                        if not received_any:
                            raise TimeoutError(
                                f"LLM first token timeout after {first_token_timeout_s:g}s. "
                                "Request accepted but no chunk arrived"
                            ) from exc
                        raise TimeoutError(
                            f"LLM chunk timeout after {_STREAM_CHUNK_TIMEOUT_S}s. Upstream stalled"
                        ) from exc
                    received_any = True
                    chunk_deadline = loop.time() + _STREAM_CHUNK_TIMEOUT_S
                    if getattr(chunk, "usage", None) is not None:
                        last_usage_chunk = chunk
                    if not chunk.choices:
                        continue
                    content = chunk.choices[0].delta.content
                    if content:
                        _output += content
                        yield content
            finally:
                if last_usage_chunk is not None:
                    _meter_token_usage(last_usage_chunk, metadata)
                aclose = getattr(response, "aclose", None) if response is not None else None
                if aclose is not None:
                    try:
                        await aclose()
                    except Exception as close_err:
                        logger.debug(f"LiteLLM stream aclose() raised on cleanup: {close_err}")
        finally:
            gen.update(output=_output, model=model, usage=litellm_usage(last_usage_chunk))


async def generate_response_stream(
    prompt: str,
    *,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    metadata: dict | None = None,
    status: dict | None = None,
):
    """Async generator: stream text chunks via LiteLLM.

    ``system_prompt``: see :func:`_generate_response` (AR-27). Sent as a
    separate ``role: system`` message on both the primary and fallback calls.

    ``status``: optional caller-owned dict this generator writes the call
    OUTCOME into, mirroring the ``(text, failed)`` tuple :func:`_generate_response`
    returns. Every failure branch below yields a human-readable error *string*
    so the visitor sees something, which makes the failure indistinguishable
    from a real answer to a caller that only counts yielded chunks. Callers
    that bill, cache or persist the result need a structural signal instead:

    * ``status["error"]`` — True when any failure branch ran (so the caller
      must not cache the text it just received).
    * ``status["failed"]`` — True only when NO real answer tokens reached the
      caller (so the caller may refund the turn). False on a mid-stream
      failure that already delivered partial content.

    Untouched on a clean stream, so a caller that pre-seeds neither key can
    treat "absent" as success.

    Fallback chain:
    1. Primary model (``LLM_MODEL``. Default: OpenAI gpt-5.4-mini)
    2. Fallback model (``FALLBACK_MODEL``. Default: Gemini 2.5 Flash) if primary raises
    3. Generic error message if both fail

    Timeouts (see :func:`_stream_from_model`): the primary gets
    ``_LLM_FIRST_TOKEN_TIMEOUT_S`` to return its first chunk, request included;
    a stall before that raises ``TimeoutError`` with nothing yielded and is
    handled below exactly like any other pre-first-token failure, i.e. the
    fallback model is tried. Once text is flowing, a gap of
    ``_STREAM_CHUNK_TIMEOUT_S`` between chunks ends the stream instead of
    blocking the event loop forever.
    """

    def _mark(failed: bool) -> None:
        """Record a failure branch in the caller's ``status`` dict (see docstring)."""
        if status is not None:
            status["error"] = True
            status["failed"] = failed

    if not PRIMARY_MODEL_KEY_SET:
        logger.error(f"Cannot stream response: API key for primary model '{_primary_model()}' is not set.")
        _mark(True)
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
        if primary_chunks_yielded > 0:
            # Partial primary text already reached the visitor, so a fallback
            # answer would be stitched onto a half-finished one (see below).
            logger.error(str(e))
            _mark(False)
            yield " [Response timed out. Please try again.]"
            return
        # Nothing was yielded yet, so a stall is indistinguishable from any
        # other pre-first-token failure: take the fallback model rather than
        # handing the visitor a timeout message the fallback could have avoided.
        logger.warning(
            f"Primary LLM stream timed out before yielding any chunks: {e}. Attempting fallback to {_fallback_model()}"
        )
    except Exception as primary_err:
        _classify_and_log_llm_error(primary_err, context="stream-primary")
        if primary_chunks_yielded > 0:
            logger.warning(
                f"Primary LLM stream failed mid-response after {primary_chunks_yielded} chunks "
                f"({type(primary_err).__name__}): {primary_err}. Suppressing fallback to avoid "
                "concatenating two answers on the same SSE stream."
            )
            # Partial content already reached the visitor, so this is an error
            # (don't cache it) but not a total failure (don't refund it).
            _mark(False)
            yield " [Response interrupted. Please try again.]"
            return
        logger.warning(
            f"Primary LLM stream failed before yielding any chunks ({type(primary_err).__name__}): "
            f"{primary_err}. Attempting fallback to {_fallback_model()}"
        )

    # Fallback to secondary model
    if not FALLBACK_MODEL_KEY_SET:
        logger.error(f"Fallback model unavailable: API key for '{_fallback_model()}' is not set.")
        _mark(True)
        yield " [I encountered an error. Please try again.]"
        return

    fallback_chunks_yielded = 0
    try:
        logger.info(f"LLM stream fallback | model={_fallback_model()}")
        increment_metric_counter("llm_fallback_triggered")
        async for chunk in _stream_from_model(
            _fallback_model(), prompt, max_tokens, metadata, temperature, system_prompt
        ):
            fallback_chunks_yielded += 1
            yield chunk
    except TimeoutError as e:
        logger.error(f"Fallback stream timed out: {e}")
        _mark(fallback_chunks_yielded == 0)
        yield " [Response timed out. Please try again.]"
    except _LLM_CONTEXT_OVERFLOW_ERROR_TYPE as fallback_err:
        # AR-20: both primary and fallback overflowed, same conversation
        # reproduces this deterministically, so don't tell the visitor to
        # "try again" (see LLM_CONTEXT_OVERFLOW_MESSAGE for why).
        _classify_and_log_llm_error(fallback_err, context="stream-fallback")
        _mark(fallback_chunks_yielded == 0)
        yield f" [{LLM_CONTEXT_OVERFLOW_MESSAGE}]"
    except Exception as fallback_err:
        _classify_and_log_llm_error(fallback_err, context="stream-fallback")
        _mark(fallback_chunks_yielded == 0)
        yield " [I encountered an error. Please try again.]"
