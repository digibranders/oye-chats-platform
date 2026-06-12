"""Tests for app.ingestion.pipeline — document ingestion pipeline."""

import contextlib
import hashlib
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

from app.ingestion.pipeline import (
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


# ── Title extraction ─────────────────────────────────────────────────────────


class TestExtractTitle:
    def test_extracts_h1(self):
        assert _extract_title_from_markdown("# Getting Started\nSome content") == "Getting Started"

    def test_falls_back_to_h2_when_no_h1(self):
        """Many pages put the H1 in their site header and use ## for the page
        title. Fall back to H2 so those pages still carry a title."""
        assert _extract_title_from_markdown("## Pricing Plans\nContent here") == "Pricing Plans"

    def test_prefers_h1_over_h2(self):
        """When both exist, H1 wins — it's the canonical page title."""
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
            patch("app.ingestion.pipeline.get_session", return_value=_session_ctx(session)),
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
            patch("app.ingestion.pipeline.get_session", return_value=_session_ctx(session)),
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
            patch("app.ingestion.pipeline.get_session", return_value=_session_ctx(session)),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
        ):
            result = _ingest_document(1, "empty.pdf", "", [{"text": "", "metadata": {}}])

        assert result == 0

    def test_invalidates_cache_on_success(self):
        """Successful ingestion invalidates BOTH the QA cache and the
        relevance-gate cache for the bot — stale gate judgments from before
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
            patch("app.ingestion.pipeline.get_session", return_value=_session_ctx(session)),
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
            patch("app.ingestion.pipeline.get_session", return_value=_session_ctx(session)),
            patch("app.ingestion.pipeline.CHUNK_ENRICHMENT_ENABLED", False),
            patch("app.ingestion.pipeline.cache_delete_prefix"),
            contextlib.suppress(RuntimeError),
        ):
            _ingest_document(1, "doc.pdf", "text", [{"text": "text", "metadata": {}}])

        session.rollback.assert_called_once()


# ── run_folder_ingestion ─────────────────────────────────────────────────────


class TestRunFolderIngestion:
    def test_processes_supported_extensions(self):
        with (
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
            patch("os.listdir", return_value=["image.png", "data.csv"]),
        ):
            result = run_folder_ingestion(1, "/tmp/docs")

        assert result == 0

    def test_handles_extraction_error(self):
        with (
            patch("os.listdir", return_value=["bad.pdf"]),
            patch("app.ingestion.pipeline.load_pdf", side_effect=RuntimeError("corrupt")),
        ):
            result = run_folder_ingestion(1, "/tmp/docs")

        assert result == 0

    def test_archives_after_processing(self):
        with (
            patch("os.listdir", return_value=["doc.txt"]),
            patch("app.ingestion.pipeline.load_txt", return_value=[{"text": "text", "metadata": {"page": 1}}]),
            patch("app.ingestion.pipeline._ingest_document", return_value=3),
            patch("app.ingestion.pipeline.move_to_archive") as mock_archive,
        ):
            run_folder_ingestion(1, "/tmp/docs")

        mock_archive.assert_called_once()


# ── run_web_ingestion ────────────────────────────────────────────────────────


class TestRunWebIngestion:
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
        assert result == {"chunks": 0, "pages_charged": 0, "credits_deducted": 0}

    def test_skips_already_processed(self):
        session = MagicMock()

        with (
            patch("app.ingestion.pipeline.get_session", return_value=_session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=True),
        ):
            result = batch_web_ingestion(1, [{"url": "https://a.com", "content": "text"}])

        assert result["chunks"] == 0
        assert result["pages_charged"] == 0
        assert result["credits_deducted"] == 0

    def test_processes_new_pages(self):
        session = MagicMock()
        mock_chunk = MagicMock(page_content="chunk", metadata={"page": 1})

        with (
            patch("app.ingestion.pipeline.get_session", return_value=_session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=False),
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

    def test_atomic_per_page_credit_deduction(self):
        session = MagicMock()
        mock_chunk = MagicMock(page_content="chunk", metadata={"page": 1})

        with (
            patch("app.ingestion.pipeline.get_session", return_value=_session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=False),
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

        assert result == {"chunks": 2, "pages_charged": 2, "credits_deducted": 6}
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
            patch("app.ingestion.pipeline.get_session", return_value=_session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=False),
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
            patch("app.ingestion.pipeline.get_session", return_value=_session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=False),
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
            patch("app.ingestion.pipeline.get_session", return_value=_session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=False),
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
    def test_moves_file(self):
        with (
            patch("os.path.exists", return_value=False),
            patch("shutil.move") as mock_move,
            patch("app.ingestion.pipeline.ARCHIVE_DIR", "/archive"),
        ):
            move_to_archive("/tmp/doc.pdf", "doc.pdf")

        mock_move.assert_called_once_with("/tmp/doc.pdf", "/archive/doc.pdf")

    def test_collision_adds_timestamp(self):
        with (
            patch("os.path.exists", return_value=True),
            patch("shutil.move") as mock_move,
            patch("app.ingestion.pipeline.ARCHIVE_DIR", "/archive"),
        ):
            move_to_archive("/tmp/doc.pdf", "doc.pdf")

        dest = mock_move.call_args[0][1]
        assert dest.startswith("/archive/doc_")
        assert dest.endswith(".pdf")

    def test_handles_move_error(self):
        with (
            patch("os.path.exists", return_value=False),
            patch("shutil.move", side_effect=OSError("permission denied")),
            patch("app.ingestion.pipeline.ARCHIVE_DIR", "/archive"),
        ):
            # Should not raise
            move_to_archive("/tmp/doc.pdf", "doc.pdf")
