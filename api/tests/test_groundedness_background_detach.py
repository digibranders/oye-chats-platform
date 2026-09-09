"""The groundedness worker must not touch the request's DB session.

``final_results`` holds ORM ``Document`` rows bound to the session opened in
``_run_pipeline``. Handing them to a fire-and-forget thread let the worker
lazy-load on that session while the request thread was closing it. SQLAlchemy
raises "This session is provisioning a new connection; concurrent operations
are not permitted"; whichever thread loses the race raises, and when that is
the request thread the visitor gets an HTTP 500.

Measured in production on 2026-09-08: the race fired 9 times in a morning
while only ever landing on the background thread (logged as the non-blocking
groundedness warning), then twice on the request path during a 35-turn eval,
returning 500 both times.
"""

import inspect

from app.services import rag_service as rs


class _FakeORMDocument:
    """Stands in for a session-bound row: attribute access is a lazy load."""

    def __init__(self, content: str) -> None:
        self._content = content
        self.loads = 0

    @property
    def content(self) -> str:
        self.loads += 1
        return self._content


def test_detach_reads_the_content_once_on_the_calling_thread():
    docs = [_FakeORMDocument("alpha"), _FakeORMDocument("beta")]

    detached = rs._detach_chunks(docs)

    assert [d.loads for d in docs] == [1, 1], "content must be read exactly once, here, not in the worker"
    assert [c.content for c in detached] == ["alpha", "beta"]


def test_detached_chunks_carry_no_reference_back_to_the_row():
    doc = _FakeORMDocument("alpha")

    (chunk,) = rs._detach_chunks([doc])
    doc.loads = 0
    _ = chunk.content

    assert doc.loads == 0, "the worker must not be able to reach the ORM row"
    assert not hasattr(chunk, "__dict__"), "__slots__ keeps a stray ORM reference from being attached later"


def test_a_row_missing_content_degrades_to_empty_text():
    (chunk,) = rs._detach_chunks([object()])

    assert chunk.content == ""


def test_the_gates_can_read_a_detached_chunk():
    """Both judges read chunks via ``getattr(doc, "content", "")``."""
    from app.services.groundedness_gate import _build_groundedness_prompt
    from app.services.relevance_gate import _build_gate_prompt

    chunks = rs._detach_chunks([_FakeORMDocument("we charge $49 per month")])

    assert "we charge $49 per month" in _build_gate_prompt("q", chunks)
    assert "we charge $49 per month" in _build_groundedness_prompt("q", "a", chunks)


class TestBothPipelinesDetachBeforeHandingOff:
    """Source-level, because the bug is a race that a unit test cannot provoke.

    Passing ``final_results`` straight through is the defect, and it looks
    completely reasonable at the call site.
    """

    def test_neither_pipeline_hands_the_worker_orm_rows(self):
        for fn in (rs.rag_pipeline_stream,):
            src = inspect.getsource(fn)
            call = src.index("_background_groundedness_check,")
            args = src[call : call + 400]
            assert "_detach_chunks(final_results)" in args, (
                f"{fn.__name__} must snapshot chunk text before the background hand-off, "
                "or the worker lazy-loads on the request's session"
            )
