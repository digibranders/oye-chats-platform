"""Tests for app.ingestion.extraction — PDF, DOCX, TXT extraction."""

from unittest.mock import MagicMock, mock_open, patch

from app.ingestion.extraction import load_docx, load_pdf, load_txt


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

    def test_empty_pdf(self):
        reader = MagicMock()
        reader.pages = []

        with (
            patch("builtins.open", mock_open()),
            patch("app.ingestion.extraction.PdfReader", return_value=reader),
        ):
            result = load_pdf("empty.pdf")

        assert result == []


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

    def test_empty_paragraphs(self):
        doc = MagicMock()
        doc.paragraphs = [MagicMock(text=""), MagicMock(text="")]

        with patch("app.ingestion.extraction.docx.Document", return_value=doc):
            result = load_docx("empty.docx")

        assert len(result) == 1
        assert result[0]["text"] == "\n"

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

    def test_empty_file(self):
        m = mock_open(read_data="")
        with patch("builtins.open", m):
            result = load_txt("empty.txt")

        assert len(result) == 1
        assert result[0]["text"] == ""

    def test_encoding_errors_ignored(self):
        m = mock_open(read_data="Valid text")
        with patch("builtins.open", m):
            result = load_txt("mixed.txt")

        m.assert_called_once_with("mixed.txt", encoding="utf-8", errors="ignore")
        assert result[0]["text"] == "Valid text"
