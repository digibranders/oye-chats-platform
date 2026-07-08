"""Tests for the FlashRank cross-encoder reranker (AR-39).

Zero test coverage existed for this module before this file. Investigating
whether to A/B-enable ``RERANK_ENABLED`` surfaced a more fundamental bug
first: the model name previously requested, ``ms-marco-MiniLM-L-2-v2``, is
not a real FlashRank model — it isn't in flashrank's own ``model_file_map``,
and the HuggingFace zip for it 404s. The reranker had been silently
non-functional in every environment since it was added; `_get_ranker()`'s
own well-designed transient-failure handling made this invisible (fails
open to unchanged RRF order every call). These tests pin the correct model
name so this can't silently regress, plus the fail-open/sticky-disable
contract that made the original bug invisible in the first place.
"""

from unittest.mock import MagicMock, patch

from app.services import reranker


class FakeDoc:
    def __init__(self, doc_id, content):
        self.id = doc_id
        self.content = content


class TestGetRankerRequestsCorrectModel:
    def test_requests_a_model_name_that_actually_exists_in_flashrank(self, monkeypatch):
        """AR-39: the exact regression this test exists to catch — the
        previous model name ('ms-marco-MiniLM-L-2-v2') doesn't exist in
        flashrank's model_file_map and always 404s. Any future edit to this
        model name must stay inside the real supported set."""
        monkeypatch.setattr(reranker, "_ranker", None)
        monkeypatch.setattr(reranker, "_ranker_unavailable", False)

        from flashrank.Config import model_file_map

        mock_ranker_cls = MagicMock()
        with patch("flashrank.Ranker", mock_ranker_cls):
            reranker._get_ranker()

        requested_model = mock_ranker_cls.call_args.kwargs["model_name"]
        assert requested_model in model_file_map, (
            f"{requested_model!r} is not a real FlashRank model — this is exactly the AR-39 bug"
        )

    def test_ranker_singleton_is_reused_across_calls(self, monkeypatch):
        monkeypatch.setattr(reranker, "_ranker", None)
        monkeypatch.setattr(reranker, "_ranker_unavailable", False)

        mock_ranker_cls = MagicMock()
        with patch("flashrank.Ranker", mock_ranker_cls):
            first = reranker._get_ranker()
            second = reranker._get_ranker()

        assert first is second
        mock_ranker_cls.assert_called_once()


class TestGetRankerFailureHandling:
    def test_import_error_sticky_disables(self, monkeypatch):
        monkeypatch.setattr(reranker, "_ranker", None)
        monkeypatch.setattr(reranker, "_ranker_unavailable", False)

        with patch.dict("sys.modules", {"flashrank": None}):
            result = reranker._get_ranker()

        assert result is None
        assert reranker._ranker_unavailable is True

    def test_non_import_error_does_not_sticky_disable(self, monkeypatch):
        """A transient failure (model file missing, OOM, /tmp wipe) must NOT
        permanently disable reranking for the process lifetime — the next
        call should retry the load."""
        monkeypatch.setattr(reranker, "_ranker", None)
        monkeypatch.setattr(reranker, "_ranker_unavailable", False)

        mock_ranker_cls = MagicMock(side_effect=RuntimeError("model file missing"))
        with patch("flashrank.Ranker", mock_ranker_cls):
            result = reranker._get_ranker()

        assert result is None
        assert reranker._ranker_unavailable is False


class TestRerank:
    def test_returns_original_order_truncated_when_disabled(self, monkeypatch):
        monkeypatch.setattr(reranker, "RERANK_ENABLED", False)
        docs = [FakeDoc(i, f"doc {i}") for i in range(10)]

        result = reranker.rerank("query", docs, top_n=3)

        assert result == docs[:3]

    def test_returns_empty_list_for_empty_documents(self, monkeypatch):
        monkeypatch.setattr(reranker, "RERANK_ENABLED", True)
        assert reranker.rerank("query", []) == []

    def test_reorders_documents_by_mocked_score(self, monkeypatch):
        monkeypatch.setattr(reranker, "RERANK_ENABLED", True)
        docs = [FakeDoc(0, "irrelevant"), FakeDoc(1, "relevant"), FakeDoc(2, "somewhat relevant")]

        mock_ranker = MagicMock()
        # FlashRank returns results sorted by score descending, referencing
        # the passage "id" (positional index) passed into RerankRequest.
        mock_ranker.rerank.return_value = [
            {"id": 1, "score": 0.9},
            {"id": 2, "score": 0.5},
            {"id": 0, "score": 0.1},
        ]
        monkeypatch.setattr(reranker, "_get_ranker", lambda: mock_ranker)

        result = reranker.rerank("query", docs, top_n=3)

        assert [d.id for d in result] == [1, 2, 0]

    def test_falls_back_to_original_order_on_rerank_failure(self, monkeypatch):
        monkeypatch.setattr(reranker, "RERANK_ENABLED", True)
        docs = [FakeDoc(i, f"doc {i}") for i in range(5)]

        mock_ranker = MagicMock()
        mock_ranker.rerank.side_effect = RuntimeError("inference failed")
        monkeypatch.setattr(reranker, "_get_ranker", lambda: mock_ranker)

        result = reranker.rerank("query", docs, top_n=3)

        assert result == docs[:3]

    def test_falls_back_to_rrf_order_when_ranker_unavailable(self, monkeypatch):
        monkeypatch.setattr(reranker, "RERANK_ENABLED", True)
        monkeypatch.setattr(reranker, "_get_ranker", lambda: None)
        docs = [FakeDoc(i, f"doc {i}") for i in range(5)]

        result = reranker.rerank("query", docs, top_n=3)

        assert result == docs[:3]

    def test_respects_default_top_n_env_constant_when_not_passed(self, monkeypatch):
        monkeypatch.setattr(reranker, "RERANK_ENABLED", False)
        monkeypatch.setattr(reranker, "RERANK_TOP_N", 2)
        docs = [FakeDoc(i, f"doc {i}") for i in range(5)]

        assert reranker.rerank("query", docs) == docs[:2]
