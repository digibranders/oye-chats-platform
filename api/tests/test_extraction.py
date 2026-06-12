"""Tests for app.ingestion.extraction — PDF, DOCX, TXT extraction."""

from unittest.mock import MagicMock, mock_open, patch

import pytest

from app.ingestion.extraction import ExtractionError, load_docx, load_pdf, load_txt


class TestLoadPdf:
    def test_extracts_pages_with_metadata(self):
        page1 = MagicMock()
        page1.extract_text.return_value = "Page one text"
        page2 = MagicMock()
        page2.extract_text.return_value = "Page two text"
        reader = MagicMock()
        reader.pages = [page1, page2]

        with (
            patch("builtins.open", mock_open()),
            patch("app.ingestion.extraction.PdfReader", return_value=reader),
        ):
            result = load_pdf("test.pdf")

        assert len(result) == 2
        assert result[0]["text"] == "Page one text"
        assert result[0]["metadata"]["page"] == 1
        assert result[0]["metadata"]["total_pages"] == 2
        assert result[1]["metadata"]["page"] == 2

    def test_skips_pages_with_no_text(self):
        page1 = MagicMock()
        page1.extract_text.return_value = "Has text"
        page2 = MagicMock()
        page2.extract_text.return_value = None
        page3 = MagicMock()
        page3.extract_text.return_value = ""
        reader = MagicMock()
        reader.pages = [page1, page2, page3]

        with (
            patch("builtins.open", mock_open()),
            patch("app.ingestion.extraction.PdfReader", return_value=reader),
        ):
            result = load_pdf("test.pdf")

        assert len(result) == 1
        assert result[0]["text"] == "Has text"
        assert result[0]["metadata"]["total_pages"] == 3

    def test_empty_pdf_raises(self):
        """A PDF with no extractable text (e.g. scanned) must raise so the upload
        route can surface a clear message instead of silently storing zero chunks.
        """
        reader = MagicMock()
        reader.pages = []

        with (
            patch("builtins.open", mock_open()),
            patch("app.ingestion.extraction.PdfReader", return_value=reader),
            pytest.raises(ExtractionError, match="No extractable text"),
        ):
            load_pdf("empty.pdf")

    def test_scanned_pdf_raises(self):
        """All pages returning empty text (typical scanned PDF) must raise."""
        page1 = MagicMock()
        page1.extract_text.return_value = ""
        page2 = MagicMock()
        page2.extract_text.return_value = None
        reader = MagicMock()
        reader.pages = [page1, page2]

        with (
            patch("builtins.open", mock_open()),
            patch("app.ingestion.extraction.PdfReader", return_value=reader),
            pytest.raises(ExtractionError, match="scanned"),
        ):
            load_pdf("scanned.pdf")


class TestLoadDocx:
    def test_joins_paragraphs(self):
        doc = MagicMock()
        doc.paragraphs = [MagicMock(text="Para 1"), MagicMock(text="Para 2"), MagicMock(text="Para 3")]

        with patch("app.ingestion.extraction.docx.Document", return_value=doc):
            result = load_docx("test.docx")

        assert len(result) == 1
        assert result[0]["text"] == "Para 1\nPara 2\nPara 3"
        assert result[0]["metadata"]["page"] == 1
        assert result[0]["metadata"]["total_pages"] == 1

    def test_empty_paragraphs_raises(self):
        """A DOCX whose paragraphs all have empty text must raise rather than
        silently store a single-newline 'document'."""
        doc = MagicMock()
        doc.paragraphs = [MagicMock(text=""), MagicMock(text="")]

        with (
            patch("app.ingestion.extraction.docx.Document", return_value=doc),
            pytest.raises(ExtractionError, match="empty or image-only"),
        ):
            load_docx("empty.docx")

    def test_single_paragraph(self):
        doc = MagicMock()
        doc.paragraphs = [MagicMock(text="Only one paragraph")]

        with patch("app.ingestion.extraction.docx.Document", return_value=doc):
            result = load_docx("single.docx")

        assert result[0]["text"] == "Only one paragraph"


class TestLoadTxt:
    def test_reads_text_file(self):
        content = "Hello world\nLine two"
        m = mock_open(read_data=content)
        with patch("builtins.open", m):
            result = load_txt("test.txt")

        assert len(result) == 1
        assert result[0]["text"] == content
        assert result[0]["metadata"]["page"] == 1
        assert result[0]["metadata"]["total_pages"] == 1
        m.assert_called_once_with("test.txt", encoding="utf-8", errors="ignore")

    def test_empty_file_raises(self):
        """An empty TXT must raise so the caller can surface a clear error
        instead of silently storing a blank 'document'."""
        m = mock_open(read_data="")
        with patch("builtins.open", m), pytest.raises(ExtractionError, match="empty"):
            load_txt("empty.txt")

    def test_encoding_errors_ignored(self):
        m = mock_open(read_data="Valid text")
        with patch("builtins.open", m):
            result = load_txt("mixed.txt")

        m.assert_called_once_with("mixed.txt", encoding="utf-8", errors="ignore")
        assert result[0]["text"] == "Valid text"
