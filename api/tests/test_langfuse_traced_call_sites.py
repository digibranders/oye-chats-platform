"""The model calls that used to reach a provider with no Langfuse observation.

Event extraction during a crawl, live-chat translation and every Gemini
embedding (the query embedding of each chat turn, and each batch of a crawl's
chunks) were billed but invisible in Langfuse. Each now records one
observation with usage and cost. Langfuse and the provider are faked here; no
network.
"""

from __future__ import annotations

import contextlib
import json
from datetime import date

import httpx
import pytest
from litellm.types.utils import ModelResponse, Usage

from app.core import langfuse_client
from app.ingestion import event_extractor
from app.services import gemini_embedding, translation_service


class _Span:
    def __init__(self):
        self.updates: list[dict] = []

    def update(self, **kw):
        self.updates.append(kw)


class _Langfuse:
    """Records every observation started, each with its own span."""

    def __init__(self):
        self.started: list[tuple[dict, _Span]] = []

    def start_as_current_observation(self, **kw):
        span = _Span()
        self.started.append((kw, span))

        @contextlib.contextmanager
        def _observation():
            yield span

        return _observation()


@pytest.fixture
def langfuse(monkeypatch) -> _Langfuse:
    fake = _Langfuse()
    monkeypatch.setattr(langfuse_client, "get_langfuse", lambda: fake)
    return fake


def _response(content: str, *, model: str, provider: str, prompt_tokens: int, completion_tokens: int):
    response = ModelResponse(
        model=model,
        choices=[{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        usage=Usage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
        ),
    )
    response._hidden_params = {"custom_llm_provider": provider}
    return response


def test_event_extraction_records_one_generation_with_usage(langfuse, monkeypatch):
    monkeypatch.setattr(event_extractor, "_extraction_model", lambda: "gemini/gemini-2.5-flash")
    payload = json.dumps(
        {
            "events": [
                {
                    "title": "Security summit",
                    "starts_at": "2026-11-02T10:00:00",
                    "ends_at": "",
                    "url": "",
                    "location": "",
                }
            ]
        }
    )
    monkeypatch.setattr(
        event_extractor.litellm,
        "completion",
        lambda **_kw: _response(
            payload, model="gemini-2.5-flash", provider="gemini", prompt_tokens=2400, completion_tokens=60
        ),
    )

    events = event_extractor.extract_events(
        "Security summit on 2 November 2026. Write to events@example.com",
        source_url="https://example.com/events",
        today=date(2026, 9, 28),
    )

    assert [e["title"] for e in events] == ["Security summit"]
    assert len(langfuse.started) == 1
    started, span = langfuse.started[0]
    assert started["name"] == "event-extractor"
    assert started["model"] == "gemini-2.5-flash"
    # AR-30: the page text is redacted like every other traced prompt.
    assert "events@example.com" not in started["input"][0]["content"]
    assert span.updates[-1]["usage_details"] == {"input": 2400, "output": 60, "total": 2460}
    assert span.updates[-1]["cost_details"]["total"] > 0


@pytest.mark.asyncio
async def test_translation_records_one_generation_with_usage(langfuse, monkeypatch):
    async def _acompletion(**_kw):
        return _response(
            "Hola, ¿en qué puedo ayudarte?",
            model="gemini-2.5-flash",
            provider="gemini",
            prompt_tokens=180,
            completion_tokens=12,
        )

    monkeypatch.setattr(translation_service.litellm, "acompletion", _acompletion)
    provider = translation_service.LiteLLMTranslationProvider(model="gemini/gemini-2.5-flash")

    result = await provider.translate("Hi, call me on +1 415-555-0100", "en", "es")

    assert result.content == "Hola, ¿en qué puedo ayudarte?"
    assert len(langfuse.started) == 1
    started, span = langfuse.started[0]
    assert started["name"] == "live-chat-translation"
    # The visitor's text is redacted per message before it leaves for Langfuse.
    assert started["input"][-1]["content"] == "Hi, call me on [REDACTED_PHONE]"
    assert span.updates[-1]["usage_details"] == {"input": 180, "output": 12, "total": 192}
    assert span.updates[-1]["output"] == "Hola, ¿en qué puedo ayudarte?"


@pytest.mark.asyncio
async def test_a_failed_translation_still_raises_translation_unavailable(langfuse, monkeypatch):
    async def _acompletion(**_kw):
        raise RuntimeError("provider down")

    monkeypatch.setattr(translation_service.litellm, "acompletion", _acompletion)

    with pytest.raises(translation_service.TranslationUnavailable):
        await translation_service.LiteLLMTranslationProvider().translate("hi", "en", "es")
    assert len(langfuse.started) == 1


class TestEmbeddingObservations:
    @pytest.fixture(autouse=True)
    def _hermetic(self, monkeypatch):
        monkeypatch.setattr(gemini_embedding.embed_rate_limiter, "acquire", lambda cost, **kw: None)
        monkeypatch.setattr(gemini_embedding, "GOOGLE_API_KEY", "k")
        monkeypatch.setattr(gemini_embedding, "EMBED_DIMENSIONS", 2)
        monkeypatch.setattr(gemini_embedding, "GEMINI_EMBED_MODEL", "gemini-embedding-001")

    @staticmethod
    def _client(extra: dict | None = None) -> httpx.Client:
        def handler(request):
            body = json.loads(request.content)
            return httpx.Response(
                200,
                json={"embeddings": [{"values": [1.0, 0.0]} for _ in body["requests"]], **(extra or {})},
            )

        return httpx.Client(transport=httpx.MockTransport(handler))

    def test_one_observation_per_batch_with_counts_and_no_text(self, langfuse, monkeypatch):
        monkeypatch.setattr(gemini_embedding, "_MAX_BATCH", 2)
        texts = ["reach me at jane@example.com", "second chunk", "third chunk of text"]

        gemini_embedding.embed_texts(texts, task_type="RETRIEVAL_DOCUMENT", _client=self._client())

        assert len(langfuse.started) == 2
        for started, span in langfuse.started:
            assert started["as_type"] == "embedding"
            assert started["name"] == "gemini-embedding"
            assert started["model"] == "gemini-embedding-001"
            sent = span.updates[-1]
            assert sent["metadata"]["usage_source"] == "estimate: characters / 4"
            assert sent["usage_details"]["input"] == -(-sent["metadata"]["characters"] // 4)
            assert sent["cost_details"]["total"] > 0
            # Counts and sizes only: no text anywhere in what was sent.
            recorded = json.dumps([started["input"], sent], default=str)
            for text in texts:
                assert text not in recorded
        batches = sorted(
            (s.updates[-1]["metadata"]["texts"], s.updates[-1]["metadata"]["characters"]) for _, s in langfuse.started
        )
        assert batches == sorted([(2, len(texts[0]) + len(texts[1])), (1, len(texts[2]))])

    def test_a_reported_token_count_is_used(self, langfuse):
        gemini_embedding.embed_texts(["hello"], _client=self._client({"usageMetadata": {"promptTokenCount": 3}}))

        (_, span) = langfuse.started[0]
        assert span.updates[-1]["usage_details"] == {"input": 3, "total": 3}
        assert span.updates[-1]["metadata"]["usage_source"] == "reported"

    def test_batches_nest_under_the_callers_context(self, langfuse):
        """The worker threads run in a copy of the caller's context, which is
        what OpenTelemetry (and so Langfuse) reads the current span from."""
        import contextvars

        marker: contextvars.ContextVar[str | None] = contextvars.ContextVar("marker", default=None)
        seen: list[str | None] = []
        original = langfuse.start_as_current_observation

        def _start(**kw):
            seen.append(marker.get())
            return original(**kw)

        langfuse.start_as_current_observation = _start
        token = marker.set("chat-turn")
        try:
            gemini_embedding.embed_texts(["a"], _client=self._client())
        finally:
            marker.reset(token)

        assert seen == ["chat-turn"]


def test_embedding_observation_is_inert_when_langfuse_is_off(monkeypatch):
    monkeypatch.setattr(langfuse_client, "get_langfuse", lambda: None)
    monkeypatch.setattr(gemini_embedding.embed_rate_limiter, "acquire", lambda cost, **kw: None)
    monkeypatch.setattr(gemini_embedding, "GOOGLE_API_KEY", "k")
    monkeypatch.setattr(gemini_embedding, "EMBED_DIMENSIONS", 2)
    client = httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"embeddings": [{"values": [3.0, 4.0]}]}))
    )

    assert gemini_embedding.embed_texts(["a"], _client=client) == [pytest.approx([0.6, 0.8])]
