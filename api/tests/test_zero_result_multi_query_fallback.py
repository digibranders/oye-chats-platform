"""Tests for the zero-result multi-query fallback (AR-40).

Before this, query transformation was limited to a single conditional LLM
rewrite, a vaguely-worded question with poor lexical/semantic overlap to
source phrasing got exactly one embedding shot, and a miss on the cosine
cutoff fell straight to the empty-retrieval refusal even though a
differently-phrased retrieval attempt might have found the chunk. This adds
a bounded (only fires on zero results) multi-query fan-out: a couple of
paraphrases, each embedded and searched, merged by keeping each document's
best distance across attempts.
"""

from unittest.mock import patch

from app.services.rag_service import (
    _generate_query_paraphrases,
    _zero_result_multi_query_fallback,
)


class _FakeDoc:
    def __init__(self, doc_id):
        self.id = doc_id


class TestGenerateQueryParaphrases:
    def test_parses_one_paraphrase_per_line(self):
        with patch(
            "app.services.rag_service.generate_response", return_value="How much is the plan?\nWhat's the cost?"
        ):
            result = _generate_query_paraphrases("What's the price?", n=2)
        assert result == ["How much is the plan?", "What's the cost?"]

    def test_truncates_to_requested_count(self):
        with patch(
            "app.services.rag_service.generate_response",
            return_value="line one\nline two\nline three\nline four",
        ):
            result = _generate_query_paraphrases("Q", n=2)
        assert result == ["line one", "line two"]

    def test_strips_blank_lines(self):
        with patch("app.services.rag_service.generate_response", return_value="line one\n\n   \nline two"):
            result = _generate_query_paraphrases("Q", n=2)
        assert result == ["line one", "line two"]

    def test_returns_empty_list_on_llm_error(self):
        with patch("app.services.rag_service.generate_response", side_effect=RuntimeError("boom")):
            result = _generate_query_paraphrases("Q")
        assert result == []

    def test_returns_empty_list_for_empty_response(self):
        with patch("app.services.rag_service.generate_response", return_value=""):
            result = _generate_query_paraphrases("Q")
        assert result == []


class TestZeroResultMultiQueryFallback:
    def test_returns_empty_when_no_paraphrases_generated(self):
        with patch("app.services.rag_service._generate_query_paraphrases", return_value=[]):
            result = _zero_result_multi_query_fallback("Q", cid=1, bid=None, retrieval_k=5)
        assert result == []

    def test_merges_and_dedupes_across_paraphrases_keeping_best_distance(self):
        doc_a, doc_b, doc_c = _FakeDoc(1), _FakeDoc(2), _FakeDoc(3)

        def fake_vector_search(cid, bid, embedding, k):
            # First paraphrase finds doc_a (far) and doc_b (farther still).
            # Deliberately in the OPPOSITE of final sorted order, so a test
            # that passed merely by accidental dict-insertion order would
            # fail here. Second paraphrase finds doc_b again (much closer
            # this time) and doc_c (closest of all).
            if embedding == "emb-1":
                return [(doc_a, 0.5), (doc_b, 0.9)]
            return [(doc_b, 0.3), (doc_c, 0.1)]

        with (
            patch("app.services.rag_service._generate_query_paraphrases", return_value=["p1", "p2"]),
            patch("app.services.rag_service._embed_query_cached", side_effect=["emb-1", "emb-2"]),
            patch("app.services.rag_service._vector_search", side_effect=fake_vector_search),
            patch("app.services.rag_service._safety_net_metric"),
        ):
            result = _zero_result_multi_query_fallback("Q", cid=1, bid=None, retrieval_k=5)

        # doc_c (0.1), doc_b (best of 0.9/0.3 -> 0.3), doc_a (0.5) -> ordered
        # by distance ascending, NOT by first-discovery/insertion order.
        assert [d.id for d in result] == [3, 2, 1]

    def test_respects_retrieval_k_cap(self):
        docs = [_FakeDoc(i) for i in range(10)]

        def fake_vector_search(cid, bid, embedding, k):
            return [(d, i * 0.01) for i, d in enumerate(docs)]

        with (
            patch("app.services.rag_service._generate_query_paraphrases", return_value=["p1"]),
            patch("app.services.rag_service._embed_query_cached", return_value="emb"),
            patch("app.services.rag_service._vector_search", side_effect=fake_vector_search),
            patch("app.services.rag_service._safety_net_metric"),
        ):
            result = _zero_result_multi_query_fallback("Q", cid=1, bid=None, retrieval_k=3)

        assert len(result) == 3

    def test_skips_paraphrase_when_embedding_fails(self):
        doc_a = _FakeDoc(1)

        def fake_vector_search(cid, bid, embedding, k):
            return [(doc_a, 0.1)]

        with (
            patch("app.services.rag_service._generate_query_paraphrases", return_value=["p1", "p2"]),
            patch("app.services.rag_service._embed_query_cached", side_effect=[None, "emb-2"]),
            patch("app.services.rag_service._vector_search", side_effect=fake_vector_search),
            patch("app.services.rag_service._safety_net_metric"),
        ):
            result = _zero_result_multi_query_fallback("Q", cid=1, bid=None, retrieval_k=5)

        assert [d.id for d in result] == [1]

    def test_emits_metric_when_recovery_succeeds(self):
        doc_a = _FakeDoc(1)
        with (
            patch("app.services.rag_service._generate_query_paraphrases", return_value=["p1"]),
            patch("app.services.rag_service._embed_query_cached", return_value="emb"),
            patch("app.services.rag_service._vector_search", return_value=[(doc_a, 0.1)]),
            patch("app.services.rag_service._safety_net_metric") as mock_metric,
        ):
            _zero_result_multi_query_fallback("Q", cid=1, bid=7, retrieval_k=5)

        mock_metric.assert_called_once_with("multi_query_fallback_recovered", bot_id=7, count=1)

    def test_returns_empty_when_still_zero_results_after_fanout(self):
        with (
            patch("app.services.rag_service._generate_query_paraphrases", return_value=["p1"]),
            patch("app.services.rag_service._embed_query_cached", return_value="emb"),
            patch("app.services.rag_service._vector_search", return_value=[]),
            patch("app.services.rag_service._safety_net_metric") as mock_metric,
        ):
            result = _zero_result_multi_query_fallback("Q", cid=1, bid=None, retrieval_k=5)

        assert result == []
        mock_metric.assert_not_called()

    def test_never_raises_on_unexpected_error(self):
        with patch("app.services.rag_service._generate_query_paraphrases", side_effect=RuntimeError("boom")):
            result = _zero_result_multi_query_fallback("Q", cid=1, bid=None, retrieval_k=5)
        assert result == []
