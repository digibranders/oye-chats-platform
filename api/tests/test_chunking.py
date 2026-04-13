"""Tests for app.ingestion.chunking — text splitting and metadata propagation."""

from unittest.mock import patch

from langchain_core.documents import Document as LCDocument

from app.ingestion.chunking import _propagate_section_headers, chunk_text


class TestPropagateHeaders:
    def test_header_propagated_to_orphan(self):
        chunks = [
            LCDocument(page_content="## Installation\nStep 1", metadata={}),
            LCDocument(page_content="Step 2 continues here", metadata={}),
        ]
        result = _propagate_section_headers(chunks)
        assert result[0].page_content.startswith("## Installation")
        assert result[1].page_content.startswith("[Section: Installation]")

    def test_no_header_no_propagation(self):
        chunks = [
            LCDocument(page_content="Just plain text", metadata={}),
            LCDocument(page_content="More plain text", metadata={}),
        ]
        result = _propagate_section_headers(chunks)
        assert not result[0].page_content.startswith("[Section:")
        assert not result[1].page_content.startswith("[Section:")

    def test_new_header_replaces_old(self):
        chunks = [
            LCDocument(page_content="## First\ncontent", metadata={}),
            LCDocument(page_content="orphan A", metadata={}),
            LCDocument(page_content="## Second\ncontent", metadata={}),
            LCDocument(page_content="orphan B", metadata={}),
        ]
        result = _propagate_section_headers(chunks)
        assert "[Section: First]" in result[1].page_content
        assert "[Section: Second]" in result[3].page_content

    def test_triple_hash_header(self):
        chunks = [
            LCDocument(page_content="### Sub-Section\ncontent", metadata={}),
            LCDocument(page_content="orphan text", metadata={}),
        ]
        result = _propagate_section_headers(chunks)
        assert "[Section: Sub-Section]" in result[1].page_content

    def test_empty_list(self):
        assert _propagate_section_headers([]) == []


class TestChunkText:
    def test_basic_chunking(self):
        pages_data = [{"text": "Hello world. " * 200, "metadata": {"page": 1}}]
        with patch("app.ingestion.chunking.CHUNK_SIZE", 100), patch("app.ingestion.chunking.CHUNK_OVERLAP", 20):
            chunks = chunk_text(pages_data)
        assert len(chunks) > 1
        assert all(c.metadata.get("chunk_index") is not None for c in chunks)

    def test_chunk_index_sequential(self):
        pages_data = [{"text": "Word " * 500, "metadata": {"page": 1}}]
        with patch("app.ingestion.chunking.CHUNK_SIZE", 100), patch("app.ingestion.chunking.CHUNK_OVERLAP", 20):
            chunks = chunk_text(pages_data)
        indices = [c.metadata["chunk_index"] for c in chunks]
        assert indices == list(range(len(chunks)))

    def test_document_name_prefix(self):
        pages_data = [{"text": "Some content here.", "metadata": {"page": 1}}]
        chunks = chunk_text(pages_data, document_name="guide.pdf")
        assert chunks[0].page_content.startswith("[Document: guide.pdf]")

    def test_no_document_name_no_prefix(self):
        pages_data = [{"text": "Some content here.", "metadata": {"page": 1}}]
        chunks = chunk_text(pages_data, document_name="")
        assert not chunks[0].page_content.startswith("[Document:")

    def test_title_metadata_prefix(self):
        pages_data = [{"text": "Some content.", "metadata": {"page": 1, "title": "Intro"}}]
        chunks = chunk_text(pages_data, document_name="doc.pdf")
        assert "[Title: Intro]" in chunks[0].page_content

    def test_page_metadata_prefix(self):
        pages_data = [{"text": "Some content.", "metadata": {"page": 3}}]
        chunks = chunk_text(pages_data, document_name="doc.pdf")
        assert "[Page: 3]" in chunks[0].page_content

    def test_empty_text_returns_empty(self):
        pages_data = [{"text": "", "metadata": {"page": 1}}]
        chunks = chunk_text(pages_data)
        assert chunks == []

    def test_multi_page_preserves_metadata(self):
        pages_data = [
            {"text": "Page one content. " * 50, "metadata": {"page": 1}},
            {"text": "Page two content. " * 50, "metadata": {"page": 2}},
        ]
        chunks = chunk_text(pages_data)
        pages_seen = {c.metadata.get("page") for c in chunks}
        assert 1 in pages_seen
        assert 2 in pages_seen
