"""The judge must see the whole knowledge base when the caller had no ranking.

The relevance gate caps the chunks it shows its judge at ``GATE_MAX_CHUNKS``
(5). That cap assumes position means relevance, which holds on the retrieval
path and nowhere else. Under CAG-lite ``rag_service`` skips retrieval entirely
and hands over every chunk the bot owns, ordered alphabetically by filename, so
the cap was slicing five arbitrary documents and asking whether they answered
the question.

Measured on the eval bot (14 chunks): ``pricing.md``, ``services.md`` and
``team.md`` sort after position 5 and were therefore never shown to the judge
for ANY question, which is exactly the shape of the eval's category scores
(events 3/3, pricing 0/4, team 0/3).
"""

from app.services.relevance_gate import GATE_MAX_CHUNKS, _build_gate_prompt


class _Chunk:
    def __init__(self, content: str) -> None:
        self.content = content


def _chunks(n: int) -> list[_Chunk]:
    return [_Chunk(f"content-of-chunk-{i}") for i in range(n)]


def test_default_still_caps_at_gate_max_chunks():
    """The retrieval path is unchanged: there the first five ARE the best five."""
    prompt = _build_gate_prompt("q", _chunks(20))

    assert "content-of-chunk-4" in prompt
    assert "content-of-chunk-5" not in prompt
    assert prompt.count("Chunk ") == GATE_MAX_CHUNKS


def test_max_chunks_widens_the_window():
    prompt = _build_gate_prompt("q", _chunks(14), max_chunks=14)

    assert "content-of-chunk-13" in prompt
    assert prompt.count("Chunk ") == 14


def test_max_chunks_none_falls_back_to_the_cap():
    assert _build_gate_prompt("q", _chunks(20), max_chunks=None).count("Chunk ") == GATE_MAX_CHUNKS


def test_max_chunks_zero_falls_back_to_the_cap():
    """``len(final_results)`` on an empty bundle must not blank the prompt."""
    assert _build_gate_prompt("q", _chunks(20), max_chunks=0).count("Chunk ") == GATE_MAX_CHUNKS


def test_prompt_asks_for_the_best_chunk_not_the_average():
    """Dilution, the second half of the bug.

    Even when the answering chunk was inside the window, the old prompt asked
    for the *overall* relevance of the set, so one relevant chunk among four
    unrelated ones scored 0.50 against a 0.55 threshold and the question was
    refused. The observed distribution had a distinct 0.50 cluster.
    """
    prompt = _build_gate_prompt("q", _chunks(3))

    assert "BEST-MATCHING" in prompt
    assert "at least one chunk directly answers the question" in prompt
    assert "overall relevance" not in prompt


class TestBothPipelinesWidenTheWindow:
    """The prompt-builder tests above cannot see whether anyone CALLS it that way.

    The fix is two lines in a ~10,000-line module, one per pipeline, and the
    streaming path passes its arguments positionally through
    ``asyncio.to_thread``. Reverting either one restores the bug while every
    unit test above still passes, so pin the wiring at the source level.
    """

    def test_each_gate_call_passes_the_cag_lite_bundle_size(self):
        import inspect

        from app.services import rag_service as rs

        for fn in (rs.rag_pipeline, rs.rag_pipeline_stream):
            src = inspect.getsource(fn)
            call = src.index("check_relevance,") if "check_relevance," in src else src.index("check_relevance(")
            # The argument list, not the whole function: a stray mention of the
            # flag elsewhere in the pipeline must not satisfy this.
            args = src[call : call + 800]
            assert "len(final_results) if _use_cag_lite else None" in args, (
                f"{fn.__name__} must let the judge see the whole knowledge base under CAG-lite, "
                "where the chunk list is alphabetical rather than ranked"
            )
