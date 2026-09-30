"""
Langfuse v4 client utilities for LLM observability.

Uses the @observe decorator and context manager APIs (OpenTelemetry-based).
Graceful no-op when LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY are not set.
"""

import contextlib
import logging
import math
import re
from typing import Literal

from app.config import LANGFUSE_ENABLED
from app.core.model_names import bare_model, provider_prefix, same_model

logger = logging.getLogger(__name__)

# AR-30: Langfuse is a third-party SaaS with zero PII scrubbing today, unlike
# Sentry (`send_default_pii=False` in main.py). Every prompt/output attached
# here is a chat/lead-capture conversation that routinely contains a
# visitor's name, email, or phone number verbatim. Once Langfuse is
# re-enabled in prod (currently blocked separately by AR-04), that data would
# be stored unredacted in a third-party service with no scrubbing pass.
# Patterns cover the common, high-confidence cases (email, phone numbers),
# not a general PII-detection system, matching the same pragmatic scope as
# the injection-pattern module.
_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
# Phone numbers: requires a leading "+" (international) or parens around the
# area code. Deliberately NOT a bare digit-dash sequence like "\d[\d-]{5,}",
# because this codebase's prompts are full of ISO dates ("2026-07-08") and
# those would otherwise collide with a plain digit/dash phone pattern and get
# silently mangled in every trace. This trades phone-number recall (misses
# bare "4155550100"/"415-555-0100" formats) for zero false positives on
# dates, an acceptable trade for a best-effort redaction pass.
_PHONE_RE = re.compile(r"(?<!\d)(\+\d[\d\-.\s()]{5,}\d|\(\d{2,4}\)[\d\-.\s]{5,}\d)(?!\d)")

# Secret-shaped tokens a visitor pastes from a log or a config. On the
# 2026-09-28 evaluation (w-secret-pasted-log) a CI log with AWS keys in it was
# stored in the transcript and quoted to the team. Well-known key prefixes are
# matched whole; a "name = value" shape keeps the name and loses the value.
# Every piece is bounded, so a long paste is scanned in linear time: the private
# key body is a run of non-dash characters, which cannot backtrack into the
# next header.
_SECRET_RE = re.compile(
    r"(?:"
    r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"  # AWS access key id
    r"|\bAIza[0-9A-Za-z_-]{35}\b"  # Google API key
    r"|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b"  # GitHub tokens
    r"|\bxox[abprs]-[A-Za-z0-9-]{10,}\b"  # Slack tokens
    r"|\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b"  # Stripe keys
    r"|\bsk-[A-Za-z0-9_-]{20,}\b"  # OpenAI-style keys
    r"|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"  # a JWT
    r"|-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[^-]{0,4000}(?:-----END [A-Z ]{0,30}PRIVATE KEY-----)?"
    # "password: hunter2", "AWS_SECRET_ACCESS_KEY=wJalr...", 'api_key = "sk_..."'.
    r"|(?i:\b[A-Z0-9_.-]{0,40}(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key"
    r"|auth[_-]?key|client[_-]?secret)[A-Z0-9_.-]{0,40}\s*[:=]\s*[\"']?)(?P<value>[^\s\"',;]{6,})"
    r")"
)
_REDACTED_SECRET = "[REDACTED_SECRET]"


def _redact_secret_match(match: re.Match[str]) -> str:
    """The name of a "name = value" secret stays; every other secret goes whole."""
    if match.group("value") is not None:
        return match.group(0)[: match.start("value") - match.start(0)] + _REDACTED_SECRET
    return _REDACTED_SECRET


def redact_secrets(text: str | None) -> str | None:
    """Scrub secret-shaped tokens (cloud keys, API tokens, "password = ..." values, private keys).

    Used on the visitor's message before it is stored and before the urgent
    alert quotes it, and by :func:`redact_pii` for traces. Never raises, for the
    reason :func:`redact_pii` gives.
    """
    if not text:
        return text
    try:
        return _SECRET_RE.sub(_redact_secret_match, text)
    except Exception:  # noqa: BLE001 - redaction must never break a turn
        return text


def contains_secret(text: object) -> bool:
    """Whether the text carries a secret-shaped token :func:`redact_secrets` would scrub."""
    return isinstance(text, str) and bool(text) and _SECRET_RE.search(text) is not None


def redact_pii(text: str | None) -> str | None:
    """Best-effort scrub of emails, phone numbers and secrets before text reaches Langfuse.

    Exported rather than module-private because :func:`langfuse_generation` is
    not the only way spans get built: the ``rag-pipeline`` /
    ``rag-pipeline-stream`` chain spans in ``rag_service`` construct their
    payloads against the Langfuse SDK directly, and call this instead of
    carrying a second copy of the patterns above.

    Never raises, a redaction bug must not break tracing or, worse, an LLM
    call. Falls back to returning the original text unredacted on error
    (tracing already treats Langfuse failures as non-fatal; this keeps the
    same posture rather than dropping the trace entirely).
    """
    if not text:
        return text
    try:
        redacted = _EMAIL_RE.sub("[REDACTED_EMAIL]", text)
        redacted = _PHONE_RE.sub("[REDACTED_PHONE]", redacted)
        return redact_secrets(redacted)
    except Exception:  # noqa: BLE001 - redaction must never break tracing
        return text


def _redact_messages(messages: list) -> list:
    """Redact the ``content`` of every chat-message dict in ``messages``.

    Returns a new list with new dicts. ``messages`` is typically the very list
    about to be handed to LiteLLM, so mutating it in place would send the
    redacted text to the model instead of the visitor's actual words. Entries
    that are not message-shaped (no ``str`` content) pass through unchanged.
    """
    redacted = []
    for message in messages:
        if isinstance(message, dict) and isinstance(message.get("content"), str):
            redacted.append({**message, "content": redact_pii(message["content"])})
        else:
            redacted.append(message)
    return redacted


# Langfuse usage-type keys for the token details LiteLLM normalises from every
# provider (OpenAI ``prompt_tokens_details.cached_tokens`` /
# ``completion_tokens_details.reasoning_tokens``; Gemini's
# ``cachedContentTokenCount`` / ``thoughtsTokenCount`` land in the same two
# fields). They are the names Langfuse's own OpenAI mapping produces and its
# model prices are keyed on. Langfuse sums every usage type into the
# generation's cost, so ``input`` and ``output`` are sent EXCLUSIVE of these
# details (as that mapping does): ``input + input_cached_tokens`` is the
# prompt, ``output + output_reasoning_tokens`` the completion, and ``total``
# stays the provider's prompt + completion.
_USAGE_DETAIL_KEYS = (
    ("prompt_tokens_details", "cached_tokens", "input", "input_cached_tokens"),
    ("completion_tokens_details", "reasoning_tokens", "output", "output_reasoning_tokens"),
)

# Gemini's ``batchEmbedContents`` answers with vectors only. When it reports no
# token count, the embedding observation estimates one from Google's documented
# rule of thumb (about four characters per token) and says so in its metadata.
_CHARS_PER_TOKEN_ESTIMATE = 4


def _detail_count(usage, details_field: str, key: str) -> int:
    """One count from a LiteLLM usage-details object or dict, 0 when absent.

    Only a real ``int`` counts: a test double's auto-attribute (or any other
    non-integer) is treated as absent rather than coerced.
    """
    details = getattr(usage, details_field, None)
    value = details.get(key) if isinstance(details, dict) else getattr(details, key, None)
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def litellm_usage(response) -> dict[str, int] | None:
    """Langfuse ``usage_details`` from a LiteLLM response, or from the
    usage-bearing chunk of a stream.

    ``{"input", "output", "total"}``, plus ``input_cached_tokens`` and
    ``output_reasoning_tokens`` when the provider reports them (see
    ``_USAGE_DETAIL_KEYS`` for why ``input``/``output`` exclude them).

    ``None`` when the object carries no usage. The single extraction point for
    :meth:`_GenerationRecorder.record_litellm`, which both the non-streaming
    calls and the streaming path in ``llm_service`` (holding only the final
    ``stream_options={"include_usage": True}`` chunk) go through. Never raises:
    this runs in a ``finally`` on the streaming path, where an exception would
    mask the stream's own error.
    """
    try:
        usage = getattr(response, "usage", None)
        if usage is None:
            return None
        counts = {
            "input": int(getattr(usage, "prompt_tokens", 0) or 0),
            "output": int(getattr(usage, "completion_tokens", 0) or 0),
        }
        details: dict[str, int] = {"total": counts["input"] + counts["output"]}
        for details_field, key, base, usage_type in _USAGE_DETAIL_KEYS:
            count = min(_detail_count(usage, details_field, key), counts[base])
            if count:
                counts[base] -= count
                details[usage_type] = count
        return {**counts, **details}
    except Exception:  # noqa: BLE001 - tracing must never break an LLM path
        return None


def _litellm_price(
    model: str | None,
    provider: str | None,
    *,
    prompt_tokens: int,
    completion_tokens: int = 0,
    usage_object=None,
    call_type: str = "completion",
) -> dict[str, float] | None:
    """Langfuse ``cost_details`` (USD) from LiteLLM's own price table.

    Sent with every generation so cost is right even for a model name Langfuse
    has no price for. ``usage_object`` lets LiteLLM price cached input at the
    cached rate. ``None`` when the model is unpriced or pricing fails: Langfuse
    then falls back to its own model prices, and the LLM call is unaffected.
    """
    if not model:
        return None
    try:
        import litellm

        prompt_cost, completion_cost = litellm.cost_per_token(
            model=model,
            custom_llm_provider=provider,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            usage_object=usage_object,
            call_type=call_type,
        )
        return {
            "input": float(prompt_cost),
            "output": float(completion_cost),
            "total": float(prompt_cost) + float(completion_cost),
        }
    except Exception as exc:  # noqa: BLE001 - pricing must never break an LLM path
        logger.debug("LiteLLM price unavailable for %s/%s (%s)", provider, model, exc)
        return None


def litellm_cost(response, *, model: str | None, provider: str | None) -> dict[str, float] | None:
    """Langfuse ``cost_details`` for a LiteLLM response or final stream chunk.

    One pricing call, ``litellm.cost_per_token`` with the response's usage
    object, for both paths: it returns the input/output split Langfuse shows,
    where ``litellm.completion_cost`` returns only a total, and it needs no
    full response, which a stream never has. ``None`` without usage.
    """
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    try:
        prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
    except Exception:  # noqa: BLE001 - tracing must never break an LLM path
        return None
    return _litellm_price(
        model,
        provider,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        usage_object=usage,
    )


def served_model(response, requested: str | None) -> tuple[str | None, str | None, str | None]:
    """``(model, provider, served_id)`` to record for a LiteLLM response.

    ``model`` is always the BARE id (``gpt-5.4-mini``, ``gemini-2.5-flash``):
    the form Langfuse's model definitions and LiteLLM's price table both match,
    and one name per model, where production traces showed both
    ``gemini-2.5-flash`` and ``gemini/gemini-2.5-flash``. When the provider
    served the requested model (a dated snapshot of it counts, see
    :func:`app.core.model_names.same_model`), the requested alias is kept so
    every call on one model groups under one name. When it served another one
    (LiteLLM's ``fallbacks``), that model is recorded, so a fallback is priced
    and counted as what actually ran. ``provider`` is LiteLLM's
    ``custom_llm_provider`` for the call, else the requested prefix.
    ``served_id`` is the provider's own id, for metadata, when it differs from
    ``model``. ``response`` may be ``None`` (a stream that never sent usage).
    """
    hidden = getattr(response, "_hidden_params", None) if response is not None else None
    hidden = hidden if isinstance(hidden, dict) else {}
    actual = getattr(response, "model", None) if response is not None else None
    if not isinstance(actual, str) or not actual:
        actual = hidden.get("model") if isinstance(hidden.get("model"), str) else None
    provider = hidden.get("custom_llm_provider")
    if not isinstance(provider, str) or not provider:
        provider = None

    if requested and (not actual or same_model(requested, actual)):
        model = bare_model(requested)
        provider = provider or provider_prefix(requested)
    elif actual:
        model = bare_model(actual)
    else:
        return None, None, None
    served_id = actual if actual and actual != model else None
    return model, provider, served_id


def _response_text(response) -> str | None:
    """``choices[0].message.content`` of a LiteLLM response, ``None`` if unreadable."""
    try:
        return response.choices[0].message.content
    except Exception:  # noqa: BLE001 - tracing must never break an LLM path
        return None


def get_langfuse():
    """
    Return the Langfuse client singleton, or None if disabled.

    In v4, use `langfuse.get_client()` which reads env vars automatically.
    We only return it if LANGFUSE_ENABLED is True.
    """
    if not LANGFUSE_ENABLED:
        return None

    try:
        from langfuse import get_client

        return get_client()
    except ImportError:
        logger.warning("langfuse package not installed. Observability disabled.")
        return None
    except Exception as e:
        logger.error(f"Failed to get Langfuse client: {type(e).__name__}: {e}")
        return None


class _GenerationRecorder:
    """Handle yielded by :func:`langfuse_generation` to record the result.

    All methods are safe no-ops when Langfuse is disabled (``span is None``) or
    the underlying SDK call raises. Tracing must never break an LLM path.

    Langfuse v4's ``update`` takes ``usage_details`` / ``cost_details`` and
    silently drops any other keyword into ``**kwargs``. An earlier revision
    sent ``usage=``, so no call ever recorded tokens: OpenAI generations only
    showed counts because Langfuse tokenises OpenAI text itself, and every
    Gemini generation showed zero tokens and zero cost.
    """

    def __init__(self, span, model: str | None):
        self._span = span
        self._model = model

    def update(
        self,
        *,
        output=None,
        usage_details: dict[str, int] | None = None,
        cost_details: dict[str, float] | None = None,
        model: str | None = None,
        metadata: dict | None = None,
    ) -> None:
        if self._span is None:
            return
        with contextlib.suppress(Exception):
            kwargs: dict = {"model": model or (bare_model(self._model) if self._model else None)}
            if output is not None:
                kwargs["output"] = redact_pii(output) if isinstance(output, str) else output
            if usage_details is not None:
                kwargs["usage_details"] = usage_details
            if cost_details is not None:
                kwargs["cost_details"] = cost_details
            if metadata:
                kwargs["metadata"] = metadata
            self._span.update(**kwargs)

    def record_litellm(self, response, *, output: str | None = None) -> None:
        """Record output, token usage, cost and the served model from a LiteLLM
        response, or from the final usage-bearing chunk of a stream.

        ``response`` may be ``None``: a stream closed before the provider sent
        its usage chunk. The text is still recorded, and the metadata says the
        usage went unreported instead of inventing a count.
        """
        if self._span is None:
            return
        with contextlib.suppress(Exception):
            if output is None and response is not None:
                output = _response_text(response)
            model, provider, served_id = served_model(response, self._model)
            usage_details = litellm_usage(response)
            cost_details = litellm_cost(response, model=model, provider=provider) if usage_details else None
            metadata: dict = {"usage_reported": usage_details is not None}
            if provider:
                metadata["provider"] = provider
            if served_id:
                metadata["served_model"] = served_id
            self.update(
                output=output or "",
                model=model,
                usage_details=usage_details,
                cost_details=cost_details,
                metadata=metadata,
            )

    def record_embedding(self, *, texts: int, characters: int, reported_input_tokens: int | None) -> None:
        """Record one embedding batch: counts and sizes only, never the text.

        ``reported_input_tokens`` is the provider's count when its response
        carries one; otherwise the input tokens are estimated from
        ``characters`` and the metadata says which it is.
        """
        if self._span is None:
            return
        with contextlib.suppress(Exception):
            if reported_input_tokens is not None:
                input_tokens = reported_input_tokens
                usage_source = "reported"
            else:
                input_tokens = math.ceil(characters / _CHARS_PER_TOKEN_ESTIMATE)
                usage_source = f"estimate: characters / {_CHARS_PER_TOKEN_ESTIMATE}"
            model = bare_model(self._model) if self._model else None
            self.update(
                output={"embeddings": texts},
                model=model,
                usage_details={"input": input_tokens, "total": input_tokens},
                cost_details=_litellm_price(
                    model,
                    provider_prefix(self._model),
                    prompt_tokens=input_tokens,
                    call_type="embedding",
                ),
                metadata={"texts": texts, "characters": characters, "usage_source": usage_source},
            )


@contextlib.contextmanager
def langfuse_generation(
    name: str,
    *,
    model: str | None = None,
    prompt: str | None = None,
    input=None,
    as_type: Literal["generation", "embedding"] = "generation",
):
    """Wrap an LLM call as a Langfuse ``generation`` observation.

    The single place LLM tracing is defined. LiteLLM's auto-callback is disabled
    (v2/v3-only, incompatible with our v4 SDK), so every traced LLM call goes
    through this. No-op context (yields an inert recorder) when Langfuse is
    disabled or the SDK is unavailable, so call sites need no conditionals.
    ``tests/test_llm_calls_are_traced.py`` fails CI for a LiteLLM or embedding
    call under ``app/`` that is not inside one of these blocks.

    ``model`` is the LiteLLM id the call requests. The observation records its
    bare form, and :meth:`_GenerationRecorder.record_litellm` replaces it with
    the model the provider actually served (see :func:`served_model`).
    ``as_type="embedding"`` records an embedding observation instead; its
    caller passes counts as ``input``, never the embedded text.

    AR-30: ``prompt`` is redacted (emails, phone numbers) before being sent as
    a single ``role: user`` message. ``input`` given as a chat ``messages``
    list (the same list handed to LiteLLM, which is how ``llm_service`` traces
    a system/user split so a prompt regression is diagnosable per role) is
    redacted per message ``content`` in the same pass, so a call site cannot
    forget it. Any other ``input`` shape is passed through untouched and that
    caller owns its redaction.

    It does not, however, cover observations built against the SDK directly.
    The ``rag-pipeline`` / ``rag-pipeline-stream`` chain spans in
    ``rag_service`` never pass through here, so they call :func:`redact_pii`
    themselves, an earlier revision of this docstring claimed the coverage was
    total, which left a visitor's typed email verbatim on the parent trace
    while the identical string was scrubbed on the generation nested inside it.
    Any new observation built straight from the SDK owes the same call.

    Usage::

        with langfuse_generation("brand-tone", model=m, prompt=p) as gen:
            resp = litellm.completion(...)
            gen.record_litellm(resp)
    """
    lf = get_langfuse()
    if lf is None:
        yield _GenerationRecorder(None, model)
        return

    if input is not None:
        resolved_input = _redact_messages(input) if isinstance(input, list) else input
    elif prompt:
        resolved_input = [{"role": "user", "content": redact_pii(prompt)}]
    else:
        resolved_input = None
    mgr = None
    span = None
    try:
        mgr = lf.start_as_current_observation(
            name=name,
            as_type=as_type,
            model=bare_model(model) if model else None,
            input=resolved_input,
        )
        span = mgr.__enter__()
    except Exception as exc:  # never let tracing setup break the LLM call
        # AR-29: was logged at debug, invisible at the normal info/warning
        # level an operator actually scans, a Langfuse connectivity blip
        # silently dropped tracing for that call with zero visible signal.
        logger.warning("langfuse_generation start failed (%s). Continuing untraced", exc)
        yield _GenerationRecorder(None, model)
        return

    try:
        yield _GenerationRecorder(span, model)
    finally:
        with contextlib.suppress(Exception):
            mgr.__exit__(None, None, None)


def flush_langfuse() -> None:
    """Flush any buffered Langfuse events. Call on app shutdown."""
    lf = get_langfuse()
    if lf is not None:
        try:
            lf.flush()
            logger.info("Langfuse events flushed successfully")
        except Exception as e:
            logger.warning(f"Langfuse flush failed: {e}")
