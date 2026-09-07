"""
Langfuse v4 client utilities for LLM observability.

Uses the @observe decorator and context manager APIs (OpenTelemetry-based).
Graceful no-op when LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY are not set.
"""

import contextlib
import logging
import re

from app.config import LANGFUSE_ENABLED

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


def redact_pii(text: str | None) -> str | None:
    """Best-effort scrub of emails/phone numbers before text reaches Langfuse.

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
        return redacted
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


def litellm_usage(response) -> dict[str, int] | None:
    """Langfuse ``usage`` payload (``{"input": …, "output": …}``) from a LiteLLM
    response, or from the usage-bearing chunk of a stream.

    ``None`` when the object carries no usage, so a caller can pass the result
    straight to :meth:`_GenerationRecorder.update`, which ignores ``usage=None``.

    Shared by :meth:`_GenerationRecorder.record_litellm` (non-streaming) and the
    streaming path in ``llm_service``, which has no response object to hand
    over, only the final ``stream_options={"include_usage": True}`` chunk, so
    the extraction shape lives in exactly one place. Never raises: this runs in
    a ``finally`` on the streaming path, where an exception would mask the
    stream's own error.
    """
    try:
        usage = getattr(response, "usage", None)
        if usage is None:
            return None
        return {
            "input": int(getattr(usage, "prompt_tokens", 0) or 0),
            "output": int(getattr(usage, "completion_tokens", 0) or 0),
        }
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
    """

    def __init__(self, span, model: str | None):
        self._span = span
        self._model = model

    def update(self, *, output=None, usage=None, model=None) -> None:
        if self._span is None:
            return
        with contextlib.suppress(Exception):
            kwargs: dict = {"model": model or self._model}
            if output is not None:
                kwargs["output"] = redact_pii(output) if isinstance(output, str) else output
            if usage is not None:
                kwargs["usage"] = usage
            self._span.update(**kwargs)

    def record_litellm(self, response, *, output: str | None = None) -> None:
        """Pull output text + token usage from a LiteLLM response object."""
        if self._span is None:
            return
        with contextlib.suppress(Exception):
            if output is None:
                output = response.choices[0].message.content
            self.update(
                output=output or "",
                model=getattr(response, "model", None) or self._model,
                usage=litellm_usage(response),
            )


@contextlib.contextmanager
def langfuse_generation(name: str, *, model: str | None = None, prompt: str | None = None, input=None):
    """Wrap an LLM call as a Langfuse ``generation`` observation.

    The single place LLM tracing is defined. LiteLLM's auto-callback is disabled
    (v2/v3-only, incompatible with our v4 SDK), so every traced LLM call goes
    through this. No-op context (yields an inert recorder) when Langfuse is
    disabled or the SDK is unavailable, so call sites need no conditionals.

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
        mgr = lf.start_as_current_observation(name=name, as_type="generation", model=model, input=resolved_input)
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
