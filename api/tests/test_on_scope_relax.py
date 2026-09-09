"""A question about the company that retrieved chunks is answered, not pivoted.

Live on the CleanStart bot: "what does cleanstart do" retrieved fifteen chunks
and was still answered with "I don't have that specific detail on hand", three
times out of three, while "tell me more about the company" answered five out of
five against the same knowledge base.

The judge grades how well a bundle answers a phrasing, and on a broad company
question it lands at its own "related" anchor. When the question already looks
on-scope and retrieval returned something, the right move is to generate and
let RULE 5a phrase any real gap honestly. The canned pivot is for the case
where retrieval returned nothing at all, which the empty-context branch below
the gate already handles.
"""

import inspect

from app.services import rag_service as rs


def _relax_block(src: str) -> str:
    start = src.index("_relax_on_scope = (")
    return src[start : start + 700]


class TestBothPipelinesRelaxForOnScopeQuestions:
    def test_the_guard_exists_in_both_pipelines(self):
        for fn in (rs.rag_pipeline, rs.rag_pipeline_stream):
            assert "_relax_on_scope = (" in inspect.getsource(fn), fn.__name__

    def test_it_needs_both_retrieved_chunks_and_an_on_scope_question(self):
        for fn in (rs.rag_pipeline, rs.rag_pipeline_stream):
            block = _relax_block(inspect.getsource(fn))
            assert "bool(final_results)" in block, fn.__name__
            assert "_question_looks_on_scope(question, _company_name)" in block, fn.__name__

    def test_the_refusal_branch_consults_it(self):
        """Without this the flag is computed and ignored, which is exactly how
        a relaxation lands green in review and does nothing in production."""
        for fn in (rs.rag_pipeline, rs.rag_pipeline_stream):
            assert "and not _relax_on_scope" in inspect.getsource(fn), fn.__name__

    def test_it_is_counted(self):
        for fn in (rs.rag_pipeline, rs.rag_pipeline_stream):
            assert "gate_relaxed_on_scope" in inspect.getsource(fn), fn.__name__


class TestTheEmptyContextPivotIsUntouched:
    """The pivot still owns the retrieval-returned-nothing case: relaxing that
    would send the model to generate with no context at all, which is where
    hallucination comes from."""

    def test_the_empty_context_branch_still_exists_in_both_pipelines(self):
        for fn in (rs.rag_pipeline, rs.rag_pipeline_stream):
            src = inspect.getsource(fn)
            assert "not final_results" in src, fn.__name__
            assert "_no_info_pivot(" in src, fn.__name__
