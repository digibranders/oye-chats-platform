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


# ── PII redaction (AR-30) ────────────────────────────────────────────────────


class TestRedactPii:
    def test_redacts_email(self):
        assert lc.redact_pii("contact me at jane.doe@example.com please") == "contact me at [REDACTED_EMAIL] please"

    def test_redacts_international_phone_with_plus(self):
        assert lc.redact_pii("call +1 415-555-0100 now") == "call [REDACTED_PHONE] now"

    def test_redacts_phone_with_parens(self):
        assert lc.redact_pii("call (415) 555-0100 now") == "call [REDACTED_PHONE] now"

    def test_does_not_redact_iso_dates(self):
        """The whole point of requiring +/parens: a bare digit-dash phone
        pattern would otherwise collide with ISO dates like the AR-27
        DATE ANALYSIS block's "2026-07-08", corrupting dates in every trace."""
        text = "TODAY'S DATE: 2026-07-08. Event on 2025-03-15 already passed."
        assert lc.redact_pii(text) == text

    def test_does_not_redact_prices_or_short_numbers(self):
        assert lc.redact_pii("Our plan costs $49 per month, 5 seats included") == (
            "Our plan costs $49 per month, 5 seats included"
        )

    def test_handles_none_and_empty_string(self):
        assert lc.redact_pii(None) is None
        assert lc.redact_pii("") == ""

    def test_never_raises_on_redaction_error(self, monkeypatch):
        monkeypatch.setattr(lc, "_EMAIL_RE", None)  # .sub() on None blows up
        assert lc.redact_pii("still returns original text") == "still returns original text"


def test_generation_prompt_is_redacted_before_being_sent_as_input(monkeypatch):
    fake = _FakeLF(_FakeSpan())
    monkeypatch.setattr(lc, "get_langfuse", lambda: fake)

    with lc.langfuse_generation("gen", model="m", prompt="my email is jane@example.com"):
        pass

    assert fake.kw["input"] == [{"role": "user", "content": "my email is [REDACTED_EMAIL]"}]


def test_generation_output_is_redacted_via_update(monkeypatch):
    span = _FakeSpan()
    fake = _FakeLF(span)
    monkeypatch.setattr(lc, "get_langfuse", lambda: fake)

    with lc.langfuse_generation("gen", model="m", prompt="hi") as gen:
        gen.update(output="reach me at jane@example.com")

    assert span.updates[-1]["output"] == "reach me at [REDACTED_EMAIL]"


def test_generation_setup_failure_is_safe(monkeypatch):
    class _BoomLF:
        def start_as_current_observation(self, **kw):
            raise RuntimeError("otel exploded")

    monkeypatch.setattr(lc, "get_langfuse", lambda: _BoomLF())
    # A tracing-setup failure must not break the LLM path.
    with lc.langfuse_generation("gen", model="m", prompt="hi") as gen:
        gen.record_litellm(_Resp())


def test_generation_setup_failure_logs_at_warning_not_debug(monkeypatch, caplog):
    """AR-29: a start-failure was previously logged at debug. Invisible at
    the info/warning level an operator actually scans, so an intermittent
    Langfuse connectivity blip silently dropped tracing with zero visible
    signal. Must be loud enough to notice without digging through debug logs."""
    import logging

    class _BoomLF:
        def start_as_current_observation(self, **kw):
            raise RuntimeError("otel exploded")

    monkeypatch.setattr(lc, "get_langfuse", lambda: _BoomLF())
    with (
        caplog.at_level(logging.WARNING, logger="app.core.langfuse_client"),
        lc.langfuse_generation("gen", model="m", prompt="hi") as gen,
    ):
        gen.record_litellm(_Resp())

    assert any("langfuse_generation start failed" in r.message for r in caplog.records)
    assert all(r.levelno >= logging.WARNING for r in caplog.records)
