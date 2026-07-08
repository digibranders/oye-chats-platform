"""Tests for the system/user message split in llm_service (AR-27).

Previously the entire assembled prompt (identity/rules AND per-turn
question/context/history/BANT-state) was sent as one ``role: user`` message.
When ``system_prompt`` is supplied, it must be sent as its own ``role:
system`` message ahead of the ``role: user`` prompt — this is what lets a
provider's prefix-based prompt cache actually match the stable half turn
over turn. When omitted, callers that don't build a hybrid prompt (BANT
extraction, query rewrite, relevance gate, ...) must see no behavior change
at all: still a single ``role: user`` message.
"""

import contextlib
from types import SimpleNamespace

import pytest

from app.services import llm_service


def _fake_response(text: str):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])


@contextlib.contextmanager
def _noop_gen(*args, **kwargs):
    yield SimpleNamespace(record_litellm=lambda *a, **k: None, update=lambda *a, **k: None)


class TestNonStreamingSystemPromptSplit:
    def test_sends_separate_system_and_user_messages_when_system_prompt_set(self, monkeypatch):
        captured: dict = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return _fake_response("hi")

        monkeypatch.setattr(llm_service.litellm, "completion", fake_completion)
        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "langfuse_generation", _noop_gen)

        llm_service._generate_response("the user turn", system_prompt="the stable rules")

        assert captured["messages"] == [
            {"role": "system", "content": "the stable rules"},
            {"role": "user", "content": "the user turn"},
        ]

    def test_sends_single_user_message_when_system_prompt_omitted(self, monkeypatch):
        """Backward compatibility: BANT extraction, query rewrite, relevance
        gate, and every other non-hybrid-prompt caller must see zero change."""
        captured: dict = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return _fake_response("hi")

        monkeypatch.setattr(llm_service.litellm, "completion", fake_completion)
        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "langfuse_generation", _noop_gen)

        llm_service._generate_response("just a prompt")

        assert captured["messages"] == [{"role": "user", "content": "just a prompt"}]


class TestStreamingSystemPromptSplit:
    @pytest.mark.asyncio
    async def test_sends_separate_system_and_user_messages_when_system_prompt_set(self, monkeypatch):
        captured: dict = {}

        async def fake_acompletion(**kwargs):
            captured.update(kwargs)

            async def _empty_aiter():
                return
                yield  # pragma: no cover - unreachable, makes this an async generator

            mock_stream = SimpleNamespace(__aiter__=lambda: _empty_aiter())
            return mock_stream

        monkeypatch.setattr(llm_service.litellm, "acompletion", fake_acompletion)
        monkeypatch.setattr(llm_service, "langfuse_generation", _noop_gen)

        async for _ in llm_service._stream_from_model(
            "openai/gpt-5.4-mini", "the user turn", None, None, system_prompt="the stable rules"
        ):
            pass

        assert captured["messages"] == [
            {"role": "system", "content": "the stable rules"},
            {"role": "user", "content": "the user turn"},
        ]

    @pytest.mark.asyncio
    async def test_sends_single_user_message_when_system_prompt_omitted(self, monkeypatch):
        captured: dict = {}

        async def fake_acompletion(**kwargs):
            captured.update(kwargs)

            async def _empty_aiter():
                return
                yield  # pragma: no cover - unreachable, makes this an async generator

            mock_stream = SimpleNamespace(__aiter__=lambda: _empty_aiter())
            return mock_stream

        monkeypatch.setattr(llm_service.litellm, "acompletion", fake_acompletion)
        monkeypatch.setattr(llm_service, "langfuse_generation", _noop_gen)

        async for _ in llm_service._stream_from_model("openai/gpt-5.4-mini", "just a prompt", None, None):
            pass

        assert captured["messages"] == [{"role": "user", "content": "just a prompt"}]
