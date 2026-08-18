"""The Langfuse trace for a chat request must not carry the visitor's IP.

``ChatSession.location`` embeds the visitor's address in every shape
``chat_routes`` writes ("IP: <addr>" on the request path, "<City>, <Country> |
<addr>" once the background geo lookup rewrites the stored column). Both RAG
entry points used to hand that value straight to ``propagate_attributes`` as
trace metadata, shipping a visitor IP to a third-party processor on every
message. Personal data under GDPR and under India's DPDP Act, where this
product's basis is consent-only.

The field is dropped rather than redacted (a redacted "IP: …" stamp collapses
to a constant "Unknown"), so these tests pin the *absence*: they drive both
pipelines far enough to build the Langfuse payload, stop them before any DB
work, and assert nothing that reached Langfuse contains the address. They fail
if someone re-adds ``location`` while debugging a trace.
"""

import asyncio
import sys
import types

import pytest

import app.services.rag_service as rs

# Documentation ranges (RFC 5737 / RFC 3849) so a grep for these never collides
# with a real address someone pasted into a fixture.
IPV4 = "203.0.113.42"
IPV6 = "2001:db8::dead:beef"

# The three shapes ``chat_routes`` actually stores, plus the IPv6 variant of the
# pre-resolution stamp. See ``app.core.visitor_privacy``.
LOCATION_SHAPES = [
    f"IP: {IPV4}",
    f"Mumbai, India | {IPV4}",
    f"India | {IPV4}",
    f"IP: {IPV6}",
]


class _StopBeforeDb(Exception):
    """Raised in place of ``get_session`` to end the pipeline once the Langfuse
    payload has been built, so neither test needs a database."""


class _Span:
    def __init__(self):
        self.updates = []

    def update(self, **kwargs):
        self.updates.append(kwargs)


class _CapturingCM:
    """Context manager stand-in that records the kwargs it was built with."""

    def __init__(self, sink, kwargs):
        sink.append(kwargs)
        self.span = _Span()

    def __enter__(self):
        return self.span

    def __exit__(self, *_exc):
        return False


class _FakeLangfuse:
    def __init__(self, sink):
        self._sink = sink

    def start_as_current_observation(self, **kwargs):
        return _CapturingCM(self._sink, kwargs)

    def get_current_trace_id(self):
        return "trace-test"


def _install_fakes(monkeypatch):
    """Patch out Langfuse and the DB; return the list every payload lands in.

    Both ``propagate_attributes`` kwargs and ``start_as_current_observation``
    kwargs go into the same sink, so a ``location`` re-added to *either* call
    is caught.
    """
    payloads: list[dict] = []

    fake_module = types.ModuleType("langfuse")
    fake_module.propagate_attributes = lambda **kwargs: _CapturingCM(payloads, kwargs)
    monkeypatch.setitem(sys.modules, "langfuse", fake_module)

    monkeypatch.setattr(rs, "get_langfuse", lambda: _FakeLangfuse(payloads))

    def _no_db():
        raise _StopBeforeDb

    monkeypatch.setattr(rs, "get_session", _no_db)
    return payloads


def _assert_clean(payloads: list[dict], location: str) -> None:
    assert payloads, "expected the pipeline to build a Langfuse payload"
    for payload in payloads:
        metadata = payload.get("metadata") or {}
        assert "location" not in metadata, f"'location' is back in a Langfuse payload: {metadata!r}"
        # Belt and braces: the address must not have re-entered under any other
        # key either (a "visitor_ip" tag, the raw stamp folded into session_id…).
        blob = repr(payload)
        assert IPV4 not in blob, f"visitor IP leaked to Langfuse: {payload!r}"
        assert IPV6 not in blob, f"visitor IP leaked to Langfuse: {payload!r}"
        assert location not in blob, f"stored location leaked to Langfuse: {payload!r}"

    # The payload is still worth having. Bot_id/question/device survive.
    trace_metadata = [p["metadata"] for p in payloads if "metadata" in p]
    assert any("bot_id" in m for m in trace_metadata), "the fix stripped more than location"


class _Client:
    """Stands in for a Client row; ``isinstance(_, Bot)`` is False so no DB load."""

    id = 7


@pytest.mark.parametrize("location", LOCATION_SHAPES)
def test_rag_pipeline_trace_carries_no_visitor_ip(monkeypatch, location):
    payloads = _install_fakes(monkeypatch)

    with pytest.raises(_StopBeforeDb):
        rs.rag_pipeline(
            _Client(),
            "What are your opening hours?",
            session_id="sess-abc",
            location=location,
            device="Chrome on Desktop",
            bot_id=3,
        )

    _assert_clean(payloads, location)


@pytest.mark.parametrize("location", LOCATION_SHAPES)
def test_rag_pipeline_stream_trace_carries_no_visitor_ip(monkeypatch, location):
    payloads = _install_fakes(monkeypatch)

    async def _drive():
        agen = rs.rag_pipeline_stream(
            _Client(),
            "What are your opening hours?",
            session_id="sess-abc",
            location=location,
            device="Chrome on Desktop",
            bot_id=3,
        )
        with pytest.raises(_StopBeforeDb):
            await agen.__anext__()

    asyncio.run(_drive())

    _assert_clean(payloads, location)
