"""
Langfuse v4 client utilities for LLM observability.

Uses the @observe decorator and context manager APIs (OpenTelemetry-based).
Graceful no-op when LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY are not set.
"""

import contextlib
import logging

from app.config import LANGFUSE_ENABLED

logger = logging.getLogger(__name__)


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
    the underlying SDK call raises — tracing must never break an LLM path.
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
                kwargs["output"] = output
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
            usage = getattr(response, "usage", None)
            self.update(
                output=output or "",
                model=getattr(response, "model", None) or self._model,
                usage=({"input": usage.prompt_tokens, "output": usage.completion_tokens} if usage else None),
            )


@contextlib.contextmanager
def langfuse_generation(name: str, *, model: str | None = None, prompt: str | None = None, input=None):
    """Wrap an LLM call as a Langfuse ``generation`` observation.

    The single place LLM tracing is defined — LiteLLM's auto-callback is disabled
    (v2/v3-only, incompatible with our v4 SDK), so every traced LLM call goes
    through this. No-op context (yields an inert recorder) when Langfuse is
    disabled or the SDK is unavailable, so call sites need no conditionals.

    Usage::

        with langfuse_generation("brand-tone", model=m, prompt=p) as gen:
            resp = litellm.completion(...)
            gen.record_litellm(resp)
    """
    lf = get_langfuse()
    if lf is None:
        yield _GenerationRecorder(None, model)
        return

    resolved_input = input if input is not None else ([{"role": "user", "content": prompt}] if prompt else None)
    mgr = None
    span = None
    try:
        mgr = lf.start_as_current_observation(name=name, as_type="generation", model=model, input=resolved_input)
        span = mgr.__enter__()
    except Exception as exc:  # never let tracing setup break the LLM call
        logger.debug("langfuse_generation start failed (%s) — continuing untraced", exc)
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
