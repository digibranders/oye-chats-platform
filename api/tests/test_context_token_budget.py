"""Tests for the context token-budget enforcement in _build_reference_context (AR-19).

Before this, there was no total-token/char budget anywhere in context
assembly — only a per-chunk 5000-char cap. Up to 15-20 retrieved chunks
meant 75k-100k chars of context alone before system prompt/history, with
nothing to stop a bot near CAG_LITE_THRESHOLD with large chunks from
approaching or exceeding the model's context window; the code just called
litellm.completion and let it fail unpredictably.
"""

from unittest.mock import patch

from app.services.rag_service import _build_reference_context, _count_tokens


class _FakeDoc:
    def __init__(self, doc_id, document_name, content):
        self.id = doc_id
        self.document_name = document_name
        self.content = content


class TestCountTokens:
    def test_returns_a_positive_count_for_real_text(self):
        assert _count_tokens("hello world, this is a test sentence.") > 0

    def test_empty_string_is_zero_tokens(self):
        assert _count_tokens("") == 0

    def test_falls_back_to_char_heuristic_when_tiktoken_unavailable(self):
        import app.services.rag_service as rag

        rag._token_encoding = None
        with patch("tiktoken.get_encoding", side_effect=RuntimeError("no tiktoken")):
            count = _count_tokens("a" * 40)
        assert count == 10  # 40 // 4
        rag._token_encoding = None  # don't leak a broken cached state to other tests


class TestBuildReferenceContextTokenBudget:
    def _reset_encoding_cache(self):
        import app.services.rag_service as rag

        rag._token_encoding = None

    def test_all_chunks_included_when_under_budget(self):
        self._reset_encoding_cache()
        chunks = [_FakeDoc(i, f"doc{i}.txt", f"short content {i}") for i in range(3)]
        with patch("app.services.rag_service._MAX_CONTEXT_TOKENS", 12000):
            context = _build_reference_context(chunks, company_name=None)
        for i in range(3):
            assert f"doc{i}.txt" in context

    def test_lowest_relevance_chunks_dropped_when_over_budget(self):
        """final_results is ordered best-first — chunks are dropped from the
        END (lowest relevance), never from the start."""
        self._reset_encoding_cache()
        # Each chunk is large enough that only ~2 fit in a small budget.
        chunks = [_FakeDoc(i, f"doc{i}.txt", "word " * 200) for i in range(5)]
        with patch("app.services.rag_service._MAX_CONTEXT_TOKENS", 250):
            context = _build_reference_context(chunks, company_name=None)

        assert "doc0.txt" in context  # top-ranked chunk always survives
        assert "doc4.txt" not in context  # lowest-ranked chunk dropped

    def test_always_includes_at_least_the_top_chunk(self):
        """Even a single oversized top chunk must not result in empty
        context — an empty-context refusal for a legitimate on-topic
        question is worse than one oversized chunk."""
        self._reset_encoding_cache()
        huge_chunk = [_FakeDoc(1, "huge.txt", "word " * 5000)]
        with patch("app.services.rag_service._MAX_CONTEXT_TOKENS", 10):
            context = _build_reference_context(huge_chunk, company_name=None)
        assert "huge.txt" in context

    def test_company_identity_header_counted_against_budget(self):
        self._reset_encoding_cache()
        chunks = [_FakeDoc(1, "doc.txt", "word " * 200)]
        with patch("app.services.rag_service._MAX_CONTEXT_TOKENS", 12000):
            context = _build_reference_context(chunks, company_name="Acme Corp")
        assert "Acme Corp" in context
        assert "doc.txt" in context

    def test_budget_configurable_via_env(self, monkeypatch):
        import importlib

        monkeypatch.setenv("MAX_CONTEXT_TOKENS", "500")
        import app.services.rag_service as rag

        importlib.reload(rag)
        try:
            assert rag._MAX_CONTEXT_TOKENS == 500
        finally:
            monkeypatch.delenv("MAX_CONTEXT_TOKENS", raising=False)
            importlib.reload(rag)
