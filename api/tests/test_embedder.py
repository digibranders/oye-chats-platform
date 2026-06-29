"""Tests for app.ingestion.embedder — FastEmbed primary, OpenAI fallback."""

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


class TestEmbedChunksEmpty:
    def test_empty_list_returns_empty(self):
        from app.ingestion.embedder import embed_chunks

        assert embed_chunks([]) == []


class TestEmbedChunksFastEmbedPrimary:
    def test_uses_fastembed_when_provider_is_fastembed(self):
        mock_embeddings = [[0.1, 0.2, 0.3]]

        with (
            patch("app.ingestion.embedder.EMBED_PROVIDER", "fastembed"),
            patch("app.ingestion.embedder._fastembed_embed", return_value=mock_embeddings) as mock_fe,
        ):
            from app.ingestion.embedder import embed_chunks

            result = embed_chunks(["hello"])

        mock_fe.assert_called_once_with(["hello"])
        assert result == mock_embeddings

    def test_falls_back_to_openai_when_fastembed_raises(self):
        openai_result = [[0.9, 0.8]]

        with (
            patch("app.ingestion.embedder.EMBED_PROVIDER", "fastembed"),
            patch("app.ingestion.embedder._fastembed_embed", side_effect=RuntimeError("model load failed")),
            patch("app.ingestion.embedder._openai_embed", return_value=openai_result) as mock_oai,
        ):
            from app.ingestion.embedder import embed_chunks

            result = embed_chunks(["hello"])

        mock_oai.assert_called_once_with(["hello"])
        assert result == openai_result

    def test_skips_fastembed_when_provider_is_openai(self):
        openai_result = [[0.5]]

        with (
            patch("app.ingestion.embedder.EMBED_PROVIDER", "openai"),
            patch("app.ingestion.embedder._fastembed_embed") as mock_fe,
            patch("app.ingestion.embedder._openai_embed", return_value=openai_result),
        ):
            from app.ingestion.embedder import embed_chunks

            result = embed_chunks(["hello"])

        mock_fe.assert_not_called()
        assert result == openai_result


class TestOpenAIEmbedFallback:
    def test_single_chunk(self):
        mock_client = MagicMock()
        data_obj = SimpleNamespace(index=0, embedding=[0.1, 0.2, 0.3])
        mock_client.embeddings.create.return_value = SimpleNamespace(data=[data_obj])

        with (
            patch("app.ingestion.embedder.EMBED_PROVIDER", "openai"),
            patch("app.ingestion.embedder._get_openai_client", return_value=mock_client),
        ):
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

        with (
            patch("app.ingestion.embedder.EMBED_PROVIDER", "openai"),
            patch("app.ingestion.embedder._get_openai_client", return_value=mock_client),
        ):
            from app.ingestion.embedder import embed_chunks

            result = embed_chunks(["chunk"] * 522)

        assert mock_client.embeddings.create.call_count == 2
        assert len(result) == 522

    def test_response_sorted_by_index(self):
        mock_client = MagicMock()
        data_objs = [
            SimpleNamespace(index=2, embedding=[0.3]),
            SimpleNamespace(index=0, embedding=[0.1]),
            SimpleNamespace(index=1, embedding=[0.2]),
        ]
        mock_client.embeddings.create.return_value = SimpleNamespace(data=data_objs)

        with (
            patch("app.ingestion.embedder.EMBED_PROVIDER", "openai"),
            patch("app.ingestion.embedder._get_openai_client", return_value=mock_client),
        ):
            from app.ingestion.embedder import embed_chunks

            result = embed_chunks(["a", "b", "c"])

        assert result == [[0.1], [0.2], [0.3]]

    def test_model_and_dimensions_passed(self):
        mock_client = MagicMock()
        mock_client.embeddings.create.return_value = SimpleNamespace(data=[SimpleNamespace(index=0, embedding=[0.1])])

        with (
            patch("app.ingestion.embedder.EMBED_PROVIDER", "openai"),
            patch("app.ingestion.embedder._get_openai_client", return_value=mock_client),
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
        with (
            patch("app.ingestion.embedder.EMBED_PROVIDER", "openai"),
            patch(
                "app.ingestion.embedder._openai_embed",
                return_value=[[0.5]],
            ),
        ):
            from app.ingestion.embedder import embed_chunks_async

            result = asyncio.run(embed_chunks_async(["test"]))

        assert result == [[0.5]]


class TestFastEmbedClient:
    def test_lazy_initialization(self):
        import app.ingestion.embedder as mod

        mod._fastembed_model = None
        mock_model = MagicMock()
        mock_model_cls = MagicMock(return_value=mock_model)

        with patch.dict("sys.modules", {"fastembed": MagicMock(TextEmbedding=mock_model_cls)}):
            model = mod._get_fastembed_model()

        assert model is mock_model
        mod._fastembed_model = None  # clean up

    def test_returns_existing_model(self):
        import app.ingestion.embedder as mod

        existing = MagicMock()
        mod._fastembed_model = existing

        model = mod._get_fastembed_model()
        assert model is existing

        mod._fastembed_model = None  # clean up


class TestOpenAIClient:
    def test_lazy_initialization(self):
        import app.ingestion.embedder as mod

        mod._openai_client = None
        mock_openai = MagicMock()

        with patch("app.ingestion.embedder.OpenAI", return_value=mock_openai):
            client = mod._get_openai_client()

        assert client is mock_openai
        mod._openai_client = None  # clean up

    def test_returns_existing_client(self):
        import app.ingestion.embedder as mod

        existing = MagicMock()
        mod._openai_client = existing

        client = mod._get_openai_client()
        assert client is existing

        mod._openai_client = None  # clean up
