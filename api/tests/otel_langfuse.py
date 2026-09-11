"""A Langfuse stand-in whose observations are real OpenTelemetry spans.

``Langfuse.start_as_current_observation`` is ``tracer.start_as_current_span``
underneath: it attaches the span to the current context on enter, then detaches
and ends it on exit. This stand-in keeps that part real, so a test sees what
production logs when the detach runs in the wrong context (``Failed to detach
context``) and whether every observation ended.
"""

import contextlib
import logging
from collections.abc import Iterator

from opentelemetry.sdk.trace import TracerProvider

from app.core import langfuse_client

DETACH_FAILURE = "Failed to detach context"
OTEL_CONTEXT_LOGGER = "opentelemetry.context"


class _Observation:
    """The ``update`` surface ``langfuse_generation`` records into."""

    def __init__(self) -> None:
        self.updates: list[dict] = []

    def update(self, **kwargs) -> None:
        self.updates.append(kwargs)


class OtelLangfuse:
    """Stand-in for the Langfuse client: each observation is a live OpenTelemetry span."""

    def __init__(self) -> None:
        self.tracer = TracerProvider().get_tracer(__name__)
        self.spans: list = []

    @contextlib.contextmanager
    def start_as_current_observation(self, *, name: str, **_kwargs) -> Iterator[_Observation]:
        with self.tracer.start_as_current_span(name) as span:
            self.spans.append(span)
            yield _Observation()

    def unended(self) -> list[str]:
        """Names of the observations that were started and never ended."""
        return [span.name for span in self.spans if span.end_time is None]


def install_otel_langfuse(monkeypatch, caplog) -> OtelLangfuse:
    """Route ``langfuse_generation`` to an :class:`OtelLangfuse` and capture OpenTelemetry's context errors."""
    fake = OtelLangfuse()
    monkeypatch.setattr(langfuse_client, "get_langfuse", lambda: fake)
    caplog.set_level(logging.ERROR, logger=OTEL_CONTEXT_LOGGER)
    return fake


def detach_failures(caplog) -> list[str]:
    """Every ``Failed to detach context`` OpenTelemetry logged during the test."""
    return [
        record.getMessage()
        for record in caplog.records
        if record.name == OTEL_CONTEXT_LOGGER and DETACH_FAILURE in record.getMessage()
    ]
