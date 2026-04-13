"""Tests for app.ingestion.embedder — OpenAI embedding generation."""

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


class TestEmbedChunks:
    def test_empty_list_returns_empty(self):
        from app.ingestion.embedder import embed_chunks

        assert embed_chunks([]) == []

    def test_single_chunk(self):
        mock_client = MagicMock()
        data_obj = SimpleNamespace(index=0, embedding=[0.1, 0.2, 0.3])
        mock_response = SimpleNamespace(data=[data_obj])
        mock_client.embeddings.create.return_value = mock_response

        with patch("app.ingestion.embedder._get_client", return_value=mock_client):
            from app.ingestion.embedder import embed_chunks

            result = embed_chunks(["hello"])

        assert result == [[0.1, 0.2, 0.3]]
        mock_client.embeddings.create.assert_called_once()

    def test_batch_splitting(self):
        mock_client = MagicMock()
        batch1_data = [SimpleNamespace(index=i, embedding=[float(i)]) for i in range(512)]
        batch2_data = [SimpleNamespace(index=i, embedding=[float(i + 512)]) for i in range(10)]
        mock_client.embeddings.create.side_effect = [
            SimpleNamespace(data=batch1_data),
            SimpleNamespace(data=batch2_data),
        ]

        with patch("app.ingestion.embedder._get_client", return_value=mock_client):
            from app.ingestion.embedder import embed_chunks

            result = embed_chunks(["chunk"] * 522)

        assert mock_client.embeddings.create.call_count == 2
        assert len(result) == 522

    def test_response_sorted_by_index(self):
        mock_client = MagicMock()
        # Return out of order
        data_objs = [
            SimpleNamespace(index=2, embedding=[0.3]),
            SimpleNamespace(index=0, embedding=[0.1]),
            SimpleNamespace(index=1, embedding=[0.2]),
        ]
        mock_client.embeddings.create.return_value = SimpleNamespace(data=data_objs)

        with patch("app.ingestion.embedder._get_client", return_value=mock_client):
            from app.ingestion.embedder import embed_chunks

            result = embed_chunks(["a", "b", "c"])

        assert result == [[0.1], [0.2], [0.3]]

    def test_exact_batch_boundary(self):
        mock_client = MagicMock()
        batch_data = [SimpleNamespace(index=i, embedding=[float(i)]) for i in range(512)]
        mock_client.embeddings.create.return_value = SimpleNamespace(data=batch_data)

        with patch("app.ingestion.embedder._get_client", return_value=mock_client):
            from app.ingestion.embedder import embed_chunks

            result = embed_chunks(["chunk"] * 512)

        assert mock_client.embeddings.create.call_count == 1
        assert len(result) == 512

    def test_model_and_dimensions_passed(self):
        mock_client = MagicMock()
        mock_client.embeddings.create.return_value = SimpleNamespace(data=[SimpleNamespace(index=0, embedding=[0.1])])

        with (
            patch("app.ingestion.embedder._get_client", return_value=mock_client),
            patch("app.ingestion.embedder.EMBED_MODEL", "test-model"),
            patch("app.ingestion.embedder.EMBED_DIMENSIONS", 768),
        ):
            from app.ingestion.embedder import embed_chunks

            embed_chunks(["test"])

        call_kwargs = mock_client.embeddings.create.call_args.kwargs
        assert call_kwargs["model"] == "test-model"
        assert call_kwargs["dimensions"] == 768


class TestEmbedChunksAsync:
    def test_async_delegates_to_sync(self):
        mock_client = MagicMock()
        mock_client.embeddings.create.return_value = SimpleNamespace(data=[SimpleNamespace(index=0, embedding=[0.5])])

        with patch("app.ingestion.embedder._get_client", return_value=mock_client):
            from app.ingestion.embedder import embed_chunks_async

            result = asyncio.run(embed_chunks_async(["test"]))

        assert result == [[0.5]]


class TestGetClient:
    def test_lazy_initialization(self):
        import app.ingestion.embedder as mod

        mod._client = None

        mock_openai = MagicMock()
        with patch("app.ingestion.embedder.OpenAI", return_value=mock_openai):
            client = mod._get_client()

        assert client is mock_openai
        assert mod._client is mock_openai

    def test_returns_existing_client(self):
        import app.ingestion.embedder as mod

        existing = MagicMock()
        mod._client = existing

        client = mod._get_client()
        assert client is existing

        # Clean up
        mod._client = None
