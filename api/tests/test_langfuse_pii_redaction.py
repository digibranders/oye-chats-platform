"""The RAG chain spans must scrub visitor PII, exactly as the generations do.

``langfuse_client.redact_pii`` runs on every span built through
``langfuse_generation``, but the ``rag-pipeline`` / ``rag-pipeline-stream``
chain spans in ``rag_service`` construct their payloads against the Langfuse
SDK directly and used to bypass it entirely. A visitor who typed "my email is
jane@example.com" therefore had it stored verbatim on the parent trace while
the identical string was scrubbed on the generation span nested inside it.

Two layers, because the harness below stops both pipelines before any DB work
(the QA cache lookup lives *inside* ``get_session``, so no answer text can ever
exist at that point and ``output`` is empty):

* the content tests feed real PII through and assert the span ``input`` comes
  out scrubbed and the redundant ``metadata["question"]`` copy is gone;
* the routing tests swap in a marker redactor and assert both ``input`` and the
  ``update(output=…)`` in the streaming ``finally`` pass through it — which is
  what pins the output path that no answer text can reach from here.

The redaction patterns themselves are covered by ``TestRedactPii`` in
``test_langfuse_generation``; these tests are about the wiring.
"""

import asyncio
import sys
import types

import pytest

import app.services.rag_service as rs

# Reserved-for-documentation values (RFC 2606 ``example.com``, the 555-0100
# fiction block, RFC 5737 for the location stamp) so a grep for these never
# collides with a real contact someone pasted into a fixture.
EMAIL = "jane.doe@example.com"
PHONE = "+1 415-555-0100"
QUESTION = f"my email is {EMAIL} and you can call {PHONE}"
REDACTED_QUESTION = "my email is [REDACTED_EMAIL] and you can call [REDACTED_PHONE]"
LOCATION = "IP: 203.0.113.42"

# A stand-in redactor that marks anything it touches, so a test can prove a
# field was *routed* through ``redact_pii`` even when the real patterns would
# leave that field unchanged (an empty ``full_answer``, say).
MARKER = "<<redacted-by-helper>>"


class _StopBeforeDb(Exception):
    """Raised in place of ``get_session`` to end the pipeline once the Langfuse
    payload has been built, so neither test needs a database."""


class _Span:
    def __init__(self, updates):
        self._updates = updates

    def update(self, **kwargs):
        self._updates.append(kwargs)


class _CapturingCM:
    """Context-manager stand-in that records the kwargs it was built with."""

    def __init__(self, capture, kwargs):
        capture.payloads.append(kwargs)
        self._span = _Span(capture.updates)

    def __enter__(self):
        return self._span

    def __exit__(self, *_exc):
        return False


class _Capture:
    """Everything the pipelines hand to Langfuse.

    ``propagate_attributes`` kwargs and ``start_as_current_observation`` kwargs
    share ``payloads``, so unredacted text re-added to *either* call is caught;
    ``updates`` collects the ``span.update(...)`` calls.
    """

    def __init__(self):
        self.payloads: list[dict] = []
        self.updates: list[dict] = []


class _FakeLangfuse:
    def __init__(self, capture):
        self._capture = capture

    def start_as_current_observation(self, **kwargs):
        return _CapturingCM(self._capture, kwargs)

    def get_current_trace_id(self):
        return "trace-test"


class _Client:
    """Stands in for a Client row; ``isinstance(_, Bot)`` is False so no DB load."""

    id = 7


def _install_fakes(monkeypatch) -> _Capture:
    capture = _Capture()

    fake_module = types.ModuleType("langfuse")
    fake_module.propagate_attributes = lambda **kwargs: _CapturingCM(capture, kwargs)
    monkeypatch.setitem(sys.modules, "langfuse", fake_module)

    monkeypatch.setattr(rs, "get_langfuse", lambda: _FakeLangfuse(capture))

    def _no_db():
        raise _StopBeforeDb

    monkeypatch.setattr(rs, "get_session", _no_db)
    return capture


def _drive_sync(question: str) -> None:
    with pytest.raises(_StopBeforeDb):
        rs.rag_pipeline(
            _Client(),
            question,
            session_id="sess-abc",
            location=LOCATION,
            device="Chrome on Desktop",
            bot_id=3,
        )


def _drive_stream(question: str) -> None:
    async def _go():
        agen = rs.rag_pipeline_stream(
            _Client(),
            question,
            session_id="sess-abc",
            location=LOCATION,
            device="Chrome on Desktop",
            bot_id=3,
        )
        # The exception propagates out through the generator, so the ``finally``
        # that updates the chain span still runs.
        with pytest.raises(_StopBeforeDb):
            await agen.__anext__()

    asyncio.run(_go())


DRIVERS = [
    pytest.param(_drive_sync, id="rag_pipeline"),
    pytest.param(_drive_stream, id="rag_pipeline_stream"),
]


@pytest.mark.parametrize("drive", DRIVERS)
def test_chain_span_input_is_redacted(monkeypatch, drive):
    capture = _install_fakes(monkeypatch)

    drive(QUESTION)

    assert capture.payloads, "expected the pipeline to build a Langfuse payload"
    blob = repr(capture.payloads)
    assert EMAIL not in blob, f"visitor email reached Langfuse verbatim: {capture.payloads!r}"
    assert PHONE not in blob, f"visitor phone reached Langfuse verbatim: {capture.payloads!r}"

    inputs = [p["input"] for p in capture.payloads if "input" in p]
    assert inputs == [REDACTED_QUESTION]


@pytest.mark.parametrize("drive", DRIVERS)
def test_trace_metadata_no_longer_carries_the_question(monkeypatch, drive):
    capture = _install_fakes(monkeypatch)

    drive(QUESTION)

    metadata = [p["metadata"] for p in capture.payloads if "metadata" in p]
    assert metadata, "expected the pipeline to attach metadata"
    for m in metadata:
        assert "question" not in m, f"the unredacted 'question' copy is back in a payload: {m!r}"

    # The payload is still worth having — the non-PII fields survive.
    assert any("bot_id" in m for m in metadata), "the fix stripped more than question"
    assert any("device" in m for m in metadata), "the fix stripped more than question"


@pytest.mark.parametrize("drive", DRIVERS)
def test_chain_span_input_routes_through_the_shared_redactor(monkeypatch, drive):
    """Pins the call, not the patterns: drop ``redact_pii(...)`` at either call
    site and the raw question lands on the span instead of the marker."""
    capture = _install_fakes(monkeypatch)
    monkeypatch.setattr(rs, "redact_pii", lambda text: MARKER if text is not None else None)

    drive(QUESTION)

    inputs = [p["input"] for p in capture.payloads if "input" in p]
    assert inputs == [MARKER], "the chain span input bypassed redact_pii"


def test_stream_output_routes_through_the_shared_redactor(monkeypatch):
    """The streaming ``finally`` update is the one field no answer text can
    reach in this harness, so routing is all there is to assert here — the
    non-streaming ``trace.update`` never runs at all, because ``_run_pipeline``
    raises first."""
    capture = _install_fakes(monkeypatch)
    monkeypatch.setattr(rs, "redact_pii", lambda text: MARKER if text is not None else None)

    _drive_stream(QUESTION)

    outputs = [u["output"] for u in capture.updates if "output" in u]
    assert outputs == [MARKER], "the chain span output bypassed redact_pii"
