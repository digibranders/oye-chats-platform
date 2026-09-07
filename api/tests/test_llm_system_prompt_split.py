"""Tests for the system/user message split in llm_service (AR-27).

Previously the entire assembled prompt (identity/rules AND per-turn
question/context/history/BANT-state) was sent as one ``role: user`` message.
When ``system_prompt`` is supplied, it must be sent as its own ``role:
system`` message ahead of the ``role: user`` prompt. This is what lets a
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


# ── The Langfuse generation must trace the split too ─────────────────────────
#
# Both paths used to trace ``prompt=`` only, so a regression in the stable
# system half (the bot's identity/rules) was invisible on the trace: the
# generation showed a lone user turn. The generation now receives the exact
# ``messages`` list sent to LiteLLM; redaction of each role's content is the
# helper's job and is pinned in test_langfuse_generation.


def _capturing_gen(captured: dict):
    @contextlib.contextmanager
    def _gen(name, **kwargs):
        captured["name"] = name
        captured.update(kwargs)
        yield SimpleNamespace(record_litellm=lambda *a, **k: None, update=lambda *a, **k: None)

    return _gen


def _fake_stream(**kwargs):
    async def _empty_aiter():
        return
        yield  # pragma: no cover - unreachable, makes this an async generator

    return SimpleNamespace(__aiter__=lambda: _empty_aiter())


class TestLangfuseGenerationTracesTheSplit:
    def test_non_streaming_generation_receives_both_messages(self, monkeypatch):
        captured: dict = {}
        monkeypatch.setattr(llm_service.litellm, "completion", lambda **kwargs: _fake_response("hi"))
        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "langfuse_generation", _capturing_gen(captured))

        llm_service._generate_response("the user turn", system_prompt="the stable rules")

        assert captured["input"] == [
            {"role": "system", "content": "the stable rules"},
            {"role": "user", "content": "the user turn"},
        ]
        assert "prompt" not in captured, "the messages list is the single source of truth for the trace"

    def test_non_streaming_generation_without_system_prompt_traces_the_single_user_message(self, monkeypatch):
        captured: dict = {}
        monkeypatch.setattr(llm_service.litellm, "completion", lambda **kwargs: _fake_response("hi"))
        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "langfuse_generation", _capturing_gen(captured))

        llm_service._generate_response("just a prompt")

        assert captured["input"] == [{"role": "user", "content": "just a prompt"}]

    @pytest.mark.asyncio
    async def test_streaming_generation_receives_both_messages(self, monkeypatch):
        captured: dict = {}

        async def fake_acompletion(**kwargs):
            return _fake_stream()

        monkeypatch.setattr(llm_service.litellm, "acompletion", fake_acompletion)
        monkeypatch.setattr(llm_service, "langfuse_generation", _capturing_gen(captured))

        async for _ in llm_service._stream_from_model(
            "openai/gpt-5.4-mini", "the user turn", None, None, system_prompt="the stable rules"
        ):
            pass

        assert captured["name"] == "llm-stream"
        assert captured["model"] == "openai/gpt-5.4-mini"
        assert captured["input"] == [
            {"role": "system", "content": "the stable rules"},
            {"role": "user", "content": "the user turn"},
        ]

    def test_pii_in_either_role_is_redacted_on_the_real_helper(self, monkeypatch):
        """End to end through the real ``langfuse_generation`` against a fake
        Langfuse client: what reaches the SDK is scrubbed per role, and what
        reaches LiteLLM is not."""
        import app.core.langfuse_client as lc

        class _FakeLF:
            kw: dict | None = None

            def start_as_current_observation(self, **kw):
                self.kw = kw
                return contextlib.nullcontext(SimpleNamespace(update=lambda **k: None))

        fake = _FakeLF()
        monkeypatch.setattr(lc, "get_langfuse", lambda: fake)
        sent: dict = {}

        def fake_completion(**kwargs):
            sent.update(kwargs)
            return _fake_response("hi")

        monkeypatch.setattr(llm_service.litellm, "completion", fake_completion)
        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)

        llm_service._generate_response("my email is jane@example.com", system_prompt="Escalate to ops@example.com")

        assert fake.kw["input"] == [
            {"role": "system", "content": "Escalate to [REDACTED_EMAIL]"},
            {"role": "user", "content": "my email is [REDACTED_EMAIL]"},
        ]
        assert sent["messages"] == [
            {"role": "system", "content": "Escalate to ops@example.com"},
            {"role": "user", "content": "my email is jane@example.com"},
        ]
