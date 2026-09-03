"""Tests for app.ingestion.pipeline. Document ingestion pipeline."""

import contextlib
import hashlib
import re
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.ingestion.pipeline import (
    _MAX_CRAWLED_PAGE_CHARS,
    _cap_crawled_page_content,
    _extract_title_from_markdown,
    batch_web_ingestion,
    calculate_hash,
    move_to_archive,
    run_folder_ingestion,
    run_web_ingestion,
)


@contextmanager
def _session_ctx(session):
    yield session


def _fake_embed_with_progress(chunk_content_list, *, progress_cb=None):
    """Stand-in for embed_chunks that drives progress like the real (concurrent) one."""
    if progress_cb is not None:
        progress_cb(len(chunk_content_list), len(chunk_content_list))
    return [[0.1] for _ in chunk_content_list]


# ── Title extraction ─────────────────────────────────────────────────────────


class TestExtractTitle:
    def test_extracts_h1(self):
        assert _extract_title_from_markdown("# Getting Started\nSome content") == "Getting Started"

    def test_falls_back_to_h2_when_no_h1(self):
        """Many pages put the H1 in their site header and use ## for the page
        title. Fall back to H2 so those pages still carry a title."""
        assert _extract_title_from_markdown("## Pricing Plans\nContent here") == "Pricing Plans"

    def test_prefers_h1_over_h2(self):
        """When both exist, H1 wins, it's the canonical page title."""
        text = "# Real Title\n## Section Heading\nContent"
        assert _extract_title_from_markdown(text) == "Real Title"

    def test_rejects_too_short(self):
        assert _extract_title_from_markdown("# Hi") is None

    def test_rejects_too_long(self):
        long_title = "# " + "A" * 125
        assert _extract_title_from_markdown(long_title) is None

    def test_none_for_no_heading(self):
        assert _extract_title_from_markdown("Just plain text content") is None

    def test_searches_first_500_chars_only(self):
        text = "A" * 501 + "\n# Late Title"
        assert _extract_title_from_markdown(text) is None

    def test_strips_whitespace(self):
        assert _extract_title_from_markdown("#   Spaced Title   \n") == "Spaced Title"


# ── Hash calculation ─────────────────────────────────────────────────────────


class TestCalculateHash:
    def test_deterministic(self):
        assert calculate_hash("hello") == calculate_hash("hello")

    def test_returns_sha256(self):
        expected = hashlib.sha256(b"hello").hexdigest()
        assert calculate_hash("hello") == expected

    def test_different_inputs_different_hashes(self):
        assert calculate_hash("a") != calculate_hash("b")


# ── _ingest_document ─────────────────────────────────────────────────────────


class TestIngestDocument:
    def _patch_all(self):
        return {
            "clean": patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            "is_processed": patch("app.ingestion.pipeline.is_document_processed", return_value=False),
            "chunk": patch(
                "app.ingestion.pipeline.chunk_text",
                return_value=[MagicMock(page_content="chunk1", metadata={"page": 1})],
            ),
            "embed": patch("app.ingestion.pipeline.embed_chunks", return_value=[[0.1, 0.2]]),
            "insert": patch("app.ingestion.pipeline.insert_documents"),
            "session": patch("app.ingestion.pipeline.get_session"),
            "cache": patch("app.ingestion.pipeline.cache_delete_prefix"),
            "enrichment": patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
        }

    def test_skips_already_processed(self):
        from app.ingestion.pipeline import _ingest_document

        session = MagicMock()

        with (
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=True),
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.chunk_text") as mock_chunk,
        ):
            result = _ingest_document(1, "doc.pdf", "text", [{"text": "text", "metadata": {}}])

        assert result == 0
        mock_chunk.assert_not_called()

    def test_processes_new_document(self):
        from app.ingestion.pipeline import _ingest_document

        session = MagicMock()
        mock_chunk = MagicMock(page_content="chunk1", metadata={"page": 1})

        with (
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=False),
            patch("app.ingestion.pipeline.chunk_text", return_value=[mock_chunk]),
            patch("app.ingestion.pipeline.embed_chunks", return_value=[[0.1, 0.2]]),
            patch("app.ingestion.pipeline.insert_documents") as mock_insert,
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.cache_delete_prefix"),
        ):
            result = _ingest_document(1, "doc.pdf", "full text", [{"text": "full text", "metadata": {}}])

        assert result == 1
        mock_insert.assert_called_once()
        session.commit.assert_called_once()

    def test_returns_zero_for_empty_content(self):
        from app.ingestion.pipeline import _ingest_document

        session = MagicMock()

        with (
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=False),
            patch("app.ingestion.pipeline.chunk_text", return_value=[]),
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
        ):
            result = _ingest_document(1, "empty.pdf", "", [{"text": "", "metadata": {}}])

        assert result == 0

    def test_invalidates_cache_on_success(self):
        """Successful ingestion invalidates BOTH the QA cache and the
        relevance-gate cache for the bot. Stale gate judgments from before
        the upload must die immediately, not haunt for an hour."""
        from app.ingestion.pipeline import _ingest_document

        session = MagicMock()
        mock_chunk = MagicMock(page_content="chunk1", metadata={"page": 1})

        with (
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=False),
            patch("app.ingestion.pipeline.chunk_text", return_value=[mock_chunk]),
            patch("app.ingestion.pipeline.embed_chunks", return_value=[[0.1]]),
            patch("app.ingestion.pipeline.insert_documents"),
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.cache_delete_prefix") as mock_cache,
            patch("app.ingestion.pipeline.qa_prefix_for_bot", return_value="qa:5:") as mock_qa_prefix,
            patch("app.ingestion.pipeline.gate_prefix_for_bot", return_value="gate:b5:") as mock_gate_prefix,
        ):
            _ingest_document(1, "doc.pdf", "text", [{"text": "text", "metadata": {}}], bot_id=5)

        # Both prefixes built and invalidated
        mock_qa_prefix.assert_called_once_with(5)
        mock_gate_prefix.assert_called_once_with(5)
        assert mock_cache.call_count == 2
        invalidated_prefixes = {call.args[0] for call in mock_cache.call_args_list}
        assert invalidated_prefixes == {"qa:5:", "gate:b5:"}

    def test_rollback_on_insert_error(self):
        from app.ingestion.pipeline import _ingest_document

        session = MagicMock()
        mock_chunk = MagicMock(page_content="chunk1", metadata={"page": 1})

        with (
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=False),
            patch("app.ingestion.pipeline.chunk_text", return_value=[mock_chunk]),
            patch("app.ingestion.pipeline.embed_chunks", return_value=[[0.1]]),
            patch("app.ingestion.pipeline.insert_documents", side_effect=RuntimeError("db error")),
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.cache_delete_prefix"),
            contextlib.suppress(RuntimeError),
        ):
            _ingest_document(1, "doc.pdf", "text", [{"text": "text", "metadata": {}}])

        session.rollback.assert_called_once()


class TestIngestDocumentReplacesAndSerializes:
    """I2/I3/I4: a re-upload replaces the old version, a concurrent sweep cannot
    double-insert, and nothing expensive runs inside the row lock."""

    def _chunk(self):
        return MagicMock(page_content="chunk1", metadata={"page": 1})

    def test_deletes_the_previous_version_of_the_same_source(self):
        """A changed pricing.pdf hashes differently and passes dedup. Its old
        chunks must go, and their chars must come off the account counter."""
        from app.ingestion.pipeline import _ingest_document

        session = MagicMock()
        with (
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=False),
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.chunk_text", return_value=[self._chunk()]),
            patch("app.ingestion.pipeline.embed_chunks", return_value=[[0.1]]),
            patch("app.ingestion.pipeline.insert_documents"),
            patch("app.ingestion.pipeline.chars_used_by_source", return_value=900) as mock_chars,
            patch("app.ingestion.pipeline.delete_chunks_for_url", return_value=4) as mock_delete,
            patch("app.ingestion.pipeline.check_kb_quota"),
            patch("app.ingestion.pipeline.increment_kb_usage") as mock_increment,
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.cache_delete_prefix"),
        ):
            result = _ingest_document(1, "pricing.pdf", "new text", [{"text": "new text", "metadata": {}}], bot_id=5)

        assert result == 1
        mock_chars.assert_called_once_with(session, client_id=1, document_name="pricing.pdf", bot_id=5)
        mock_delete.assert_called_once_with(session, "pricing.pdf", bot_id=5, client_id=1)
        # The old source's chars are handed back before the new ones are added.
        deltas = [call.args[2] for call in mock_increment.call_args_list]
        assert deltas == [-900, len("new text")]

    def test_skips_when_a_concurrent_sweep_won_the_race(self):
        """The hash check is re-run under the client row lock: the loser of two
        concurrent sweeps must not insert a second copy."""
        from app.ingestion.pipeline import _ingest_document

        session = MagicMock()
        with (
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            # False on the pre-embed read, True once the lock is held.
            patch("app.ingestion.pipeline.is_document_processed", side_effect=[False, True]),
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.chunk_text", return_value=[self._chunk()]),
            patch("app.ingestion.pipeline.embed_chunks", return_value=[[0.1]]),
            patch("app.ingestion.pipeline.insert_documents") as mock_insert,
            patch("app.ingestion.pipeline.chars_used_by_source", return_value=0),
            patch("app.ingestion.pipeline.delete_chunks_for_url", return_value=0),
            patch("app.ingestion.pipeline.check_kb_quota"),
            patch("app.ingestion.pipeline.increment_kb_usage"),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.cache_delete_prefix"),
        ):
            result = _ingest_document(1, "doc.pdf", "text", [{"text": "text", "metadata": {}}], bot_id=5)

        assert result == 0
        mock_insert.assert_not_called()
        session.rollback.assert_called_once()

    def test_embeds_before_the_quota_lock_is_taken(self):
        """The client row lock must not be held across the embedding call."""
        from app.ingestion.pipeline import _ingest_document

        session = MagicMock()
        order: list[str] = []
        with (
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=False),
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.chunk_text", return_value=[self._chunk()]),
            patch(
                "app.ingestion.pipeline.embed_chunks",
                side_effect=lambda **kw: order.append("embed") or [[0.1]],
            ),
            patch("app.ingestion.pipeline.insert_documents"),
            patch("app.ingestion.pipeline.chars_used_by_source", return_value=0),
            patch("app.ingestion.pipeline.delete_chunks_for_url", return_value=0),
            patch(
                "app.ingestion.pipeline.check_kb_quota",
                side_effect=lambda *a, **kw: order.append("lock"),
            ),
            patch("app.ingestion.pipeline.increment_kb_usage"),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.cache_delete_prefix"),
        ):
            _ingest_document(1, "doc.pdf", "text", [{"text": "text", "metadata": {}}])

        assert order == ["embed", "lock"]


# ── Quarantine refund (I5) ───────────────────────────────────────────────────


class TestRefundQuarantinedUpload:
    def test_quarantined_file_is_refunded_and_the_customer_is_told(self):
        from app.ingestion.pipeline import run_folder_ingestion

        with (
            patch("os.path.isdir", return_value=True),
            patch("os.listdir", return_value=["doc.txt"]),
            patch("app.ingestion.pipeline.load_txt", return_value=[{"text": "text", "metadata": {"page": 1}}]),
            patch("app.ingestion.pipeline._ingest_document", side_effect=RuntimeError("embedding outage")),
            patch("app.ingestion.pipeline.move_to_quarantine"),
            patch("app.ingestion.pipeline._refund_quarantined_upload") as mock_refund,
        ):
            run_folder_ingestion(1, "/tmp/docs", bot_id=5)

        mock_refund.assert_called_once_with(1, 5, "doc.txt", "text", "error")

    def test_quota_failure_carries_its_own_reason(self):
        from app.ingestion.pipeline import KnowledgeQuotaExceeded, run_folder_ingestion

        exc = KnowledgeQuotaExceeded(current=10, attempted=5, limit=12, plan_slug="free")
        with (
            patch("os.path.isdir", return_value=True),
            patch("os.listdir", return_value=["doc.txt"]),
            patch("app.ingestion.pipeline.load_txt", return_value=[{"text": "text", "metadata": {"page": 1}}]),
            patch("app.ingestion.pipeline._ingest_document", side_effect=exc),
            patch("app.ingestion.pipeline.move_to_quarantine"),
            patch("app.ingestion.pipeline._refund_quarantined_upload") as mock_refund,
        ):
            run_folder_ingestion(1, "/tmp/docs", bot_id=5)

        assert mock_refund.call_args[0][4] == "knowledge_quota"

    def test_refund_is_written_once_and_notifies(self):
        from app.ingestion.pipeline import _refund_quarantined_upload

        session = MagicMock()
        charge = SimpleNamespace(id=77, delta=-8, bot_id=None, attributed_bot_id=5)
        # 1st execute: the deduction row. 2nd: the "already refunded?" probe.
        session.execute.side_effect = [
            MagicMock(scalars=lambda: MagicMock(first=lambda: charge)),
            MagicMock(first=lambda: None),
        ]
        with (
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.services.credit_service.count_words", return_value=500),
            patch("app.services.credit_service.get_document_upload_cost_for_size", return_value=8),
            patch("app.services.credit_service.refund") as mock_refund,
            patch("app.services.notification_service.create_notification") as mock_notify,
        ):
            _refund_quarantined_upload(1, 5, "doc.txt", "text", "knowledge_quota")

        mock_refund.assert_called_once()
        assert mock_refund.call_args[0][2] == 8
        assert mock_refund.call_args[1]["note"] == "Upload failed: doc.txt (charge #77)"
        assert mock_notify.call_args[1]["data"]["credits_refunded"] == 8

    def test_refund_is_skipped_when_one_already_exists(self):
        from app.ingestion.pipeline import _refund_quarantined_upload

        session = MagicMock()
        charge = SimpleNamespace(id=77, delta=-8, bot_id=None, attributed_bot_id=5)
        session.execute.side_effect = [
            MagicMock(scalars=lambda: MagicMock(first=lambda: charge)),
            MagicMock(first=lambda: (1,)),  # a refund with this note is on file
        ]
        with (
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.services.credit_service.count_words", return_value=500),
            patch("app.services.credit_service.get_document_upload_cost_for_size", return_value=8),
            patch("app.services.credit_service.refund") as mock_refund,
            patch("app.services.notification_service.create_notification") as mock_notify,
        ):
            _refund_quarantined_upload(1, 5, "doc.txt", "text", "error")

        mock_refund.assert_not_called()
        # The customer is still told what happened to the file.
        mock_notify.assert_called_once()


# ── run_folder_ingestion ─────────────────────────────────────────────────────


class TestRunFolderIngestion:
    def test_processes_supported_extensions(self):
        with (
            patch("os.path.isdir", return_value=True),
            patch("os.listdir", return_value=["doc.pdf", "note.txt", "data.csv"]),
            patch("app.ingestion.pipeline.load_pdf", return_value=[{"text": "pdf text", "metadata": {"page": 1}}]),
            patch("app.ingestion.pipeline.load_txt", return_value=[{"text": "txt text", "metadata": {"page": 1}}]),
            patch("app.ingestion.pipeline._ingest_document", return_value=5),
            patch("app.ingestion.pipeline.move_to_archive"),
        ):
            result = run_folder_ingestion(1, "/tmp/docs")

        assert result == 2  # pdf + txt, not csv

    def test_skips_unsupported_extensions(self):
        with (
            patch("os.path.isdir", return_value=True),
            patch("os.listdir", return_value=["image.png", "data.csv"]),
        ):
            result = run_folder_ingestion(1, "/tmp/docs")

        assert result == 0

    def test_handles_extraction_error(self):
        with (
            patch("os.path.isdir", return_value=True),
            patch("os.listdir", return_value=["bad.pdf"]),
            patch("app.ingestion.pipeline.load_pdf", side_effect=RuntimeError("corrupt")),
        ):
            result = run_folder_ingestion(1, "/tmp/docs")

        assert result == 0

    def test_archives_after_processing(self):
        with (
            patch("os.path.isdir", return_value=True),
            patch("os.listdir", return_value=["doc.txt"]),
            patch("app.ingestion.pipeline.load_txt", return_value=[{"text": "text", "metadata": {"page": 1}}]),
            patch("app.ingestion.pipeline._ingest_document", return_value=3),
            patch("app.ingestion.pipeline.move_to_archive") as mock_archive,
        ):
            run_folder_ingestion(1, "/tmp/docs")

        mock_archive.assert_called_once()


# ── run_web_ingestion ────────────────────────────────────────────────────────


# ── Crawled page content cap (AR-41) ─────────────────────────────────────────


class TestCapCrawledPageContent:
    def test_short_content_is_unchanged(self):
        content = "a" * 100
        assert _cap_crawled_page_content(content, "https://a.test") == content

    def test_oversized_content_is_truncated_to_the_cap(self):
        content = "a" * (_MAX_CRAWLED_PAGE_CHARS + 1000)
        result = _cap_crawled_page_content(content, "https://a.test")
        assert len(result) == _MAX_CRAWLED_PAGE_CHARS

    def test_content_exactly_at_the_cap_is_unchanged(self):
        content = "a" * _MAX_CRAWLED_PAGE_CHARS
        assert _cap_crawled_page_content(content, "https://a.test") == content


class TestRunWebIngestion:
    def test_oversized_content_is_capped_before_ingestion(self):
        oversized = "a" * (_MAX_CRAWLED_PAGE_CHARS + 1000)
        with patch("app.ingestion.pipeline._ingest_document", return_value=1) as mock_ingest:
            run_web_ingestion(1, "https://example.com", oversized)

        # arg 2 is `full_text`, arg 3 is `pages_data`, both must see the
        # capped content, not the original oversized string.
        args = mock_ingest.call_args[0]
        assert len(args[2]) == _MAX_CRAWLED_PAGE_CHARS
        assert len(args[3][0]["text"]) == _MAX_CRAWLED_PAGE_CHARS

    def test_ingests_url_content(self):
        with patch("app.ingestion.pipeline._ingest_document", return_value=10) as mock_ingest:
            result = run_web_ingestion(1, "https://example.com/page", "# Title\nContent here", bot_id=5)

        assert result == 10
        args = mock_ingest.call_args
        assert args[0][1] == "https://example.com/page"  # source_name

    def test_extracts_title_into_metadata(self):
        with patch("app.ingestion.pipeline._ingest_document", return_value=1) as mock_ingest:
            run_web_ingestion(1, "https://example.com", "# My Page Title\nContent")

        pages_data = mock_ingest.call_args[0][3]
        assert pages_data[0]["metadata"]["title"] == "My Page Title"

    def test_no_title_when_absent(self):
        with patch("app.ingestion.pipeline._ingest_document", return_value=1) as mock_ingest:
            run_web_ingestion(1, "https://example.com", "No heading content")

        pages_data = mock_ingest.call_args[0][3]
        assert "title" not in pages_data[0]["metadata"]


# ── batch_web_ingestion ──────────────────────────────────────────────────────


class TestBatchWebIngestion:
    def test_empty_pages_returns_zero(self):
        result = batch_web_ingestion(1, [])
        assert result == {
            "chunks": 0,
            "pages_changed": 0,
            "pages_unchanged": 0,
            "pages_charged": 0,
            "pages_failed": 0,
            "credits_deducted": 0,
            "aborted": False,
            "abort_reason": None,
        }

    def test_oversized_page_content_is_capped_before_cleaning(self):
        session = MagicMock()
        oversized = "a" * (_MAX_CRAWLED_PAGE_CHARS + 1000)
        captured = {}

        def capture_clean_text(text):
            captured["len"] = len(text)
            return text

        with (
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=capture_clean_text),
            patch("app.ingestion.pipeline._crawl_page_unchanged", return_value=True),
        ):
            batch_web_ingestion(1, [{"url": "https://a.com", "content": oversized}])

        assert captured["len"] == _MAX_CRAWLED_PAGE_CHARS

    def test_skips_already_processed(self):
        session = MagicMock()

        with (
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline._crawl_page_unchanged", return_value=True),
        ):
            result = batch_web_ingestion(1, [{"url": "https://a.com", "content": "text"}])

        assert result["chunks"] == 0
        assert result["pages_charged"] == 0
        assert result["credits_deducted"] == 0

    def test_processes_new_pages(self):
        session = MagicMock()
        mock_chunk = MagicMock(page_content="chunk", metadata={"page": 1})

        with (
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline._crawl_page_unchanged", return_value=False),
            patch("app.ingestion.pipeline.chunk_text", return_value=[mock_chunk]),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.embed_chunks", return_value=[[0.1]]),
            patch("app.ingestion.pipeline.insert_documents"),
            patch("app.ingestion.pipeline.delete_chunks_for_url"),
            patch("app.ingestion.pipeline.cache_delete_prefix"),
        ):
            result = batch_web_ingestion(1, [{"url": "https://a.com", "content": "text"}], bot_id=5)

        assert result["chunks"] == 1
        # No cost_per_page passed → no charge.
        assert result["pages_charged"] == 0
        assert result["credits_deducted"] == 0
        session.commit.assert_called()

    def test_stamps_crawl_started_at_in_chunk_metadata(self):
        # crawl_started_at flows page_meta -> chunk metadata -> insert_documents,
        # so total-time-taken can be read back as max(created_at) - crawl_started_at.
        session = MagicMock()
        captured = {}

        def echo_chunk_text(pages_data, document_name=None):
            meta = dict(pages_data[0]["metadata"])
            return [MagicMock(page_content="chunk", metadata=meta)]

        def capture_insert(_s, _cid, _url, _hash, _chunks, _embs, metas, **kw):
            captured["metas"] = metas

        with (
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline._crawl_page_unchanged", return_value=False),
            patch("app.ingestion.pipeline.chunk_text", side_effect=echo_chunk_text),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.embed_chunks", side_effect=_fake_embed_with_progress),
            patch("app.ingestion.pipeline.insert_documents", side_effect=capture_insert),
            patch("app.ingestion.pipeline.delete_chunks_for_url"),
            patch("app.ingestion.pipeline.cache_delete_prefix"),
        ):
            batch_web_ingestion(1, [{"url": "https://a.com", "content": "text"}], bot_id=5, crawl_started_at=1234.5)

        assert captured["metas"][0]["crawl_started_at"] == 1234.5

    def test_reports_embed_progress(self):
        session = MagicMock()
        mock_chunk = MagicMock(page_content="chunk", metadata={"page": 1})
        calls = []

        with (
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline._crawl_page_unchanged", return_value=False),
            patch("app.ingestion.pipeline.chunk_text", return_value=[mock_chunk]),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.embed_chunks", side_effect=_fake_embed_with_progress),
            patch("app.ingestion.pipeline.insert_documents"),
            patch("app.ingestion.pipeline.delete_chunks_for_url"),
            patch("app.ingestion.pipeline.cache_delete_prefix"),
        ):
            batch_web_ingestion(
                1,
                [{"url": "https://a.com", "content": "text"}],
                bot_id=5,
                embed_progress_cb=lambda done, total: calls.append((done, total)),
            )

        # embed_chunks (now concurrent internally) drives progress; pipeline
        # forwards the callback. One chunk → one (done, total) tick.
        assert calls == [(1, 1)]

    def test_atomic_per_page_credit_deduction(self):
        session = MagicMock()
        mock_chunk = MagicMock(page_content="chunk", metadata={"page": 1})

        with (
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline._crawl_page_unchanged", return_value=False),
            patch("app.ingestion.pipeline.chunk_text", return_value=[mock_chunk]),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.embed_chunks", return_value=[[0.1], [0.2]]),
            patch("app.ingestion.pipeline.insert_documents"),
            patch("app.ingestion.pipeline.delete_chunks_for_url"),
            patch("app.ingestion.pipeline.cache_delete_prefix"),
            patch("app.services.credit_service.check_and_deduct") as mock_deduct,
        ):
            result = batch_web_ingestion(
                1,
                [
                    {"url": "https://a.com", "content": "text1"},
                    {"url": "https://b.com", "content": "text2"},
                ],
                bot_id=5,
                cost_per_page=3,
                deduct_reference_id=5,
            )

        assert result == {
            "chunks": 2,
            "pages_changed": 2,
            "pages_unchanged": 0,
            "pages_charged": 2,
            "pages_free": 0,
            "pages_failed": 0,
            "credits_deducted": 6,
            "aborted": False,
            # Named, so the orchestrator can tell "you ran out" from "we could
            # not read your site". None on a clean run.
            "abort_reason": None,
        }
        # One deduction per page, in the same session as the chunk insert.
        assert mock_deduct.call_count == 2
        for call in mock_deduct.call_args_list:
            assert call.args[0] is session
            assert call.args[1] == 1
            assert call.args[2] == 3
            assert call.kwargs["reason"] == "url_scan"
            assert call.kwargs["reference_id"] == 5

    def test_stops_on_insufficient_credits_mid_batch(self):
        session = MagicMock()
        mock_chunk = MagicMock(page_content="chunk", metadata={"page": 1})

        from app.services.credit_service import InsufficientCredits

        deduct_calls = {"n": 0}

        def fake_deduct(*args, **kwargs):
            deduct_calls["n"] += 1
            if deduct_calls["n"] == 2:
                raise InsufficientCredits(required=3, available=0)
            return 100

        with (
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline._crawl_page_unchanged", return_value=False),
            patch("app.ingestion.pipeline.chunk_text", return_value=[mock_chunk]),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.embed_chunks", return_value=[[0.1], [0.2], [0.3]]),
            patch("app.ingestion.pipeline.insert_documents"),
            patch("app.ingestion.pipeline.delete_chunks_for_url"),
            patch("app.ingestion.pipeline.cache_delete_prefix"),
            patch("app.services.credit_service.check_and_deduct", side_effect=fake_deduct),
        ):
            result = batch_web_ingestion(
                1,
                [
                    {"url": "https://a.com", "content": "x"},
                    {"url": "https://b.com", "content": "y"},
                    {"url": "https://c.com", "content": "z"},
                ],
                bot_id=5,
                cost_per_page=3,
            )

        # Only the first page lands; the second triggers InsufficientCredits
        # which rolls back its chunks and aborts the rest of the batch.
        assert result["chunks"] == 1
        assert result["pages_charged"] == 1
        assert result["credits_deducted"] == 3
        # Second page's chunk insert was rolled back, so we expect a rollback call.
        session.rollback.assert_called()

    def test_deletes_stale_chunks_before_insert(self):
        session = MagicMock()
        mock_chunk = MagicMock(page_content="chunk", metadata={"page": 1})

        with (
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline._crawl_page_unchanged", return_value=False),
            patch("app.ingestion.pipeline.chunk_text", return_value=[mock_chunk]),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.embed_chunks", return_value=[[0.1]]),
            patch("app.ingestion.pipeline.insert_documents"),
            patch("app.ingestion.pipeline.delete_chunks_for_url") as mock_delete,
            patch("app.ingestion.pipeline.cache_delete_prefix"),
        ):
            batch_web_ingestion(1, [{"url": "https://a.com", "content": "text"}], bot_id=5)

        mock_delete.assert_called_once()

    def test_continues_on_per_page_failure(self):
        session = MagicMock()
        mock_chunk = MagicMock(page_content="chunk", metadata={"page": 1})

        insert_call_count = 0

        def failing_insert(*args, **kwargs):
            nonlocal insert_call_count
            insert_call_count += 1
            if insert_call_count == 1:
                raise RuntimeError("db error")

        with (
            patch("app.ingestion.pipeline.get_session", side_effect=lambda: _session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline._crawl_page_unchanged", return_value=False),
            patch("app.ingestion.pipeline.chunk_text", return_value=[mock_chunk]),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.embed_chunks", return_value=[[0.1], [0.2]]),
            patch("app.ingestion.pipeline.insert_documents", side_effect=failing_insert),
            patch("app.ingestion.pipeline.delete_chunks_for_url"),
            patch("app.ingestion.pipeline.cache_delete_prefix"),
        ):
            result = batch_web_ingestion(
                1,
                [
                    {"url": "https://a.com", "content": "text1"},
                    {"url": "https://b.com", "content": "text2"},
                ],
                bot_id=5,
            )

        # Second page should succeed even if first fails
        assert result["chunks"] == 1


# ── move_to_archive ──────────────────────────────────────────────────────────


class TestMoveToArchive:
    def test_moves_file_into_tenant_dir(self, tmp_path, monkeypatch):
        # Archive is namespaced per tenant: {ARCHIVE_DIR}/{client_id}/{bot_id}/.
        monkeypatch.setattr("app.ingestion.pipeline.ARCHIVE_DIR", str(tmp_path))
        src = tmp_path / "doc.pdf"
        src.write_bytes(b"data")

        move_to_archive(str(src), "doc.pdf", client_id=1, bot_id=10)

        assert (tmp_path / "1" / "10" / "doc.pdf").is_file()
        assert not src.exists()

    def test_account_level_upload_uses_none_segment(self, tmp_path, monkeypatch):
        # bot_id=None (account-level upload) lands in a reserved "_none" segment
        # so it can never collide with a real bot id.
        monkeypatch.setattr("app.ingestion.pipeline.ARCHIVE_DIR", str(tmp_path))
        src = tmp_path / "doc.pdf"
        src.write_bytes(b"data")

        move_to_archive(str(src), "doc.pdf", client_id=7, bot_id=None)

        assert (tmp_path / "7" / "_none" / "doc.pdf").is_file()

    def test_collision_adds_timestamp(self, tmp_path, monkeypatch):
        monkeypatch.setattr("app.ingestion.pipeline.ARCHIVE_DIR", str(tmp_path))
        dest_dir = tmp_path / "1" / "10"
        dest_dir.mkdir(parents=True)
        (dest_dir / "doc.pdf").write_bytes(b"old")
        src = tmp_path / "doc.pdf"
        src.write_bytes(b"new")

        move_to_archive(str(src), "doc.pdf", client_id=1, bot_id=10)

        names = sorted(p.name for p in dest_dir.iterdir())
        assert "doc.pdf" in names
        assert any(re.fullmatch(r"doc_\d{8}_\d{6}\.pdf", n) for n in names)

    def test_handles_move_error(self, tmp_path, monkeypatch):
        monkeypatch.setattr("app.ingestion.pipeline.ARCHIVE_DIR", str(tmp_path))
        with patch("shutil.move", side_effect=OSError("permission denied")):
            # Should not raise
            move_to_archive(str(tmp_path / "doc.pdf"), "doc.pdf", client_id=1, bot_id=10)
