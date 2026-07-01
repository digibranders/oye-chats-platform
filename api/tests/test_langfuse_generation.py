"""The shared langfuse_generation helper: no-op when disabled, records when on."""

import app.core.langfuse_client as lc


def test_generation_noop_when_disabled(monkeypatch):
    monkeypatch.setattr(lc, "get_langfuse", lambda: None)
    # Must not raise and must yield an inert recorder.
    with lc.langfuse_generation("t", model="m", prompt="p") as gen:
        gen.update(output="x")
        gen.record_litellm(object())  # would blow up if it tried to touch a real span


class _FakeSpan:
    def __init__(self):
        self.updates = []

    def update(self, **kw):
        self.updates.append(kw)


class _FakeMgr:
    def __init__(self, span):
        self.span = span

    def __enter__(self):
        return self.span

    def __exit__(self, *a):
        return False


class _FakeLF:
    def __init__(self, span):
        self.span = span
        self.kw = None

    def start_as_current_observation(self, **kw):
        self.kw = kw
        return _FakeMgr(self.span)


class _Resp:
    class _Ch:
        class _M:
            content = "out"

        message = _M()

    choices = [_Ch()]
    model = "resolved-model"

    class _U:
        prompt_tokens = 10
        completion_tokens = 5

    usage = _U()


def test_generation_records_when_enabled(monkeypatch):
    span = _FakeSpan()
    fake = _FakeLF(span)
    monkeypatch.setattr(lc, "get_langfuse", lambda: fake)

    with lc.langfuse_generation("gen", model="m", prompt="hi") as gen:
        gen.record_litellm(_Resp())

    # Started as a generation observation with the given name.
    assert fake.kw["name"] == "gen"
    assert fake.kw["as_type"] == "generation"
    # Recorded output + token usage pulled from the LiteLLM response.
    assert span.updates[-1]["output"] == "out"
    assert span.updates[-1]["model"] == "resolved-model"
    assert span.updates[-1]["usage"] == {"input": 10, "output": 5}


def test_generation_setup_failure_is_safe(monkeypatch):
    class _BoomLF:
        def start_as_current_observation(self, **kw):
            raise RuntimeError("otel exploded")

    monkeypatch.setattr(lc, "get_langfuse", lambda: _BoomLF())
    # A tracing-setup failure must not break the LLM path.
    with lc.langfuse_generation("gen", model="m", prompt="hi") as gen:
        gen.record_litellm(_Resp())
