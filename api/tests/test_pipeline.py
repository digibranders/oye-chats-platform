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

    def test_ignores_h2(self):
        assert _extract_title_from_markdown("## Not a title\nContent") is None

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
        ):
            _ingest_document(1, "doc.pdf", "text", [{"text": "text", "metadata": {}}], bot_id=5)

        mock_cache.assert_called_once()

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
        assert batch_web_ingestion(1, []) == 0

    def test_skips_already_processed(self):
        session = MagicMock()

        with (
            patch("app.ingestion.pipeline.get_session", return_value=_session_ctx(session)),
            patch("app.ingestion.pipeline.clean_text", side_effect=lambda x: x),
            patch("app.ingestion.pipeline.is_document_processed", return_value=True),
        ):
            result = batch_web_ingestion(1, [{"url": "https://a.com", "content": "text"}])

        assert result == 0

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

        assert result == 1
        session.commit.assert_called()

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
        assert result == 1


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
