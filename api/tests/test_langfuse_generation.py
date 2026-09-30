"""The shared langfuse_generation helper: no-op when disabled, records when on."""

import time

import pytest

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
    # Recorded output + token usage pulled from the LiteLLM response, under the
    # keyword Langfuse v4 actually reads (it drops an unknown ``usage=``).
    assert span.updates[-1]["output"] == "out"
    assert span.updates[-1]["model"] == "resolved-model"
    assert span.updates[-1]["usage_details"] == {"input": 10, "output": 5, "total": 15}
    assert "usage" not in span.updates[-1]


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


class TestRedactSecrets:
    """Evaluation 2026-09-28 (w-secret-pasted-log): a visitor pasted a CI log with
    AWS keys in it, and the keys were stored in the transcript and quoted to the
    team. Secret-shaped tokens are scrubbed wherever the message is kept."""

    AWS_LOG = (
        "our github actions log was public for 2 days and it had this:\n"
        "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n"
        "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n"
        "can u check if someone used it? what do we do now"
    )

    def test_the_pasted_aws_log_keeps_its_words_and_loses_its_keys(self):
        redacted = lc.redact_secrets(self.AWS_LOG)
        assert "AKIAIOSFODNN7EXAMPLE" not in redacted
        assert "wJalrXUtnFEMI" not in redacted
        assert redacted.startswith("our github actions log was public for 2 days and it had this:\n")
        assert "AWS_ACCESS_KEY_ID=[REDACTED_SECRET]" in redacted
        assert "AWS_SECRET_ACCESS_KEY=[REDACTED_SECRET]" in redacted
        assert redacted.endswith("can u check if someone used it? what do we do now")

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("the key is AKIAIOSFODNN7EXAMPLE ok", "the key is [REDACTED_SECRET] ok"),
            ("temp creds ASIAIOSFODNN7EXAMPLE expired", "temp creds [REDACTED_SECRET] expired"),
            ("password: hunter2hunter2", "password: [REDACTED_SECRET]"),
            ("our admin password: Tr0ub4dor&3 was leaked", "our admin password: [REDACTED_SECRET] was leaked"),
            ("DB_PASSWORD=correctHorseBattery", "DB_PASSWORD=[REDACTED_SECRET]"),
            ("client_secret: 9f8e7d6c5b4a", "client_secret: [REDACTED_SECRET]"),
            ("api-key-2=abcd1234efgh", "api-key-2=[REDACTED_SECRET]"),
            ("pwd=S3cr3t!pass", "pwd=[REDACTED_SECRET]"),
            ('api_key = "sk_' + 'live_4eC39HqLyjWDarjtT1zdp7dc"', 'api_key = "[REDACTED_SECRET]"'),
            ("token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12", "token=[REDACTED_SECRET]"),
            ("slack xoxb-123456789012-abcdefghij", "slack [REDACTED_SECRET]"),
            ("google AIzaSyA1234567890abcdefghijklmnopqrstuv", "google [REDACTED_SECRET]"),
            (
                "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
                "jwt [REDACTED_SECRET]",
            ),
            (
                "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nplease help",
                "[REDACTED_SECRET]\nplease help",
            ),
        ],
    )
    def test_secret_shapes_are_replaced(self, text, expected):
        assert lc.redact_secrets(text) == expected
        assert lc.contains_secret(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            "what is your password policy",
            "the secret to good security is training",
            "our token budget is 5000 per month",
            "we need a new api key for the integration",
            "password = abc",
            "meet at 2026-07-08, token: yes",
            "AKIA is the prefix aws uses",
            "",
            # Review 2026-09-30: a word that only starts with the keyword is not
            # a name, and a plain word after the colon is not a secret.
            "question about tokens: pricing per 1000 tokens?",
            "passwordless: supported?",
            "forgot my password: cannot login",
            "our admin password: changed by attacker",
            "passwords: rotated yesterday",
            "secrets: handled by vault",
            "is the api key: required for webhooks",
            "password: Required",
            "secretary=margaret-jones",
            "password: ********",
        ],
    )
    def test_ordinary_text_is_left_alone(self, text):
        assert lc.redact_secrets(text) == text
        assert lc.contains_secret(text) is False

    def test_none_and_non_text(self):
        assert lc.redact_secrets(None) is None
        assert lc.contains_secret(None) is False
        assert lc.contains_secret(42) is False

    def test_redact_pii_scrubs_secrets_too(self):
        assert lc.redact_pii("mail jane@example.com key AKIAIOSFODNN7EXAMPLE") == (
            "mail [REDACTED_EMAIL] key [REDACTED_SECRET]"
        )

    @pytest.mark.parametrize(
        "text",
        [
            "password=" * 5000,
            "-----BEGIN PRIVATE KEY-----" * 2000,
            "AKIA" + "A" * 50000,
            "secret " * 10000 + "= " + "x" * 10000,
            "a" * 30000 + "=" + "b" * 30000,
            "password: " + "b" * 50000,
            "tokens: " * 6000,
            "secret.secret-" * 4000,
        ],
    )
    def test_redaction_is_linear_on_long_input(self, text):
        started = time.perf_counter()
        lc.redact_secrets(text)
        lc.contains_secret(text)
        assert time.perf_counter() - started < 0.5


def test_generation_prompt_is_redacted_before_being_sent_as_input(monkeypatch):
    fake = _FakeLF(_FakeSpan())
    monkeypatch.setattr(lc, "get_langfuse", lambda: fake)

    with lc.langfuse_generation("gen", model="m", prompt="my email is jane@example.com"):
        pass

    assert fake.kw["input"] == [{"role": "user", "content": "my email is [REDACTED_EMAIL]"}]


def test_message_shaped_input_is_redacted_per_message(monkeypatch):
    """``llm_service`` traces the exact ``messages`` list it sends to LiteLLM so
    a system/user split is diagnosable per role. Both roles routinely carry
    PII (the system prompt embeds the business's contact details, the user
    turn the visitor's), so every ``content`` is scrubbed, and the caller's
    list, which is what actually goes to the model, is left untouched."""
    fake = _FakeLF(_FakeSpan())
    monkeypatch.setattr(lc, "get_langfuse", lambda: fake)
    messages = [
        {"role": "system", "content": "Escalate billing to ops@example.com"},
        {"role": "user", "content": "call me on +1 415-555-0100"},
    ]

    with lc.langfuse_generation("gen", model="m", input=messages):
        pass

    assert fake.kw["input"] == [
        {"role": "system", "content": "Escalate billing to [REDACTED_EMAIL]"},
        {"role": "user", "content": "call me on [REDACTED_PHONE]"},
    ]
    assert messages[0]["content"] == "Escalate billing to ops@example.com"
    assert messages[1]["content"] == "call me on +1 415-555-0100"


def test_message_input_takes_precedence_over_prompt(monkeypatch):
    fake = _FakeLF(_FakeSpan())
    monkeypatch.setattr(lc, "get_langfuse", lambda: fake)

    with lc.langfuse_generation("gen", model="m", prompt="ignored", input=[{"role": "user", "content": "used"}]):
        pass

    assert fake.kw["input"] == [{"role": "user", "content": "used"}]


def test_non_message_input_shapes_pass_through_unchanged(monkeypatch):
    """The documented escape hatch: anything that is not a messages list is
    the caller's responsibility to redact."""
    fake = _FakeLF(_FakeSpan())
    monkeypatch.setattr(lc, "get_langfuse", lambda: fake)
    raw = {"query": "jane@example.com"}

    with lc.langfuse_generation("gen", model="m", input=raw):
        pass

    assert fake.kw["input"] == raw

    entries = ["plain jane@example.com", {"role": "user", "content": None}, {"role": "user", "content": "x@y.io"}]
    with lc.langfuse_generation("gen", model="m", input=entries):
        pass

    assert fake.kw["input"] == [
        "plain jane@example.com",
        {"role": "user", "content": None},
        {"role": "user", "content": "[REDACTED_EMAIL]"},
    ]


class TestLitellmUsage:
    """One extraction shape for both the non-streaming ``record_litellm`` path
    and the streaming path in ``llm_service``, which only ever holds the final
    usage-bearing chunk."""

    def test_extracts_the_langfuse_usage_shape(self):
        assert lc.litellm_usage(_Resp()) == {"input": 10, "output": 5, "total": 15}

    def test_none_when_the_object_carries_no_usage(self):
        assert lc.litellm_usage(object()) is None

        class _NoUsage:
            usage = None

        assert lc.litellm_usage(_NoUsage()) is None

    def test_missing_counts_default_to_zero(self):
        class _Partial:
            class usage:  # noqa: N801 - mirrors the LiteLLM attribute name
                prompt_tokens = None
                completion_tokens = 7

        assert lc.litellm_usage(_Partial()) == {"input": 0, "output": 7, "total": 7}

    def test_never_raises(self):
        class _Garbage:
            class usage:  # noqa: N801 - mirrors the LiteLLM attribute name
                prompt_tokens = "not a number"
                completion_tokens = 5

        assert lc.litellm_usage(_Garbage()) is None


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


# ── Usage, cost and model name reach Langfuse (production: every Gemini
# generation showed 0 tokens and $0, because ``usage=`` was dropped) ─────────


def _litellm_response(
    *,
    model: str,
    provider: str | None,
    prompt_tokens: int,
    completion_tokens: int,
    cached_tokens: int | None = None,
    reasoning_tokens: int | None = None,
    content: str = "out",
):
    """A real ``litellm.ModelResponse``, so pricing runs against LiteLLM's own table."""
    from litellm.types.utils import ModelResponse, Usage

    usage_kwargs: dict = {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
    }
    if cached_tokens is not None:
        usage_kwargs["prompt_tokens_details"] = {"cached_tokens": cached_tokens}
    if reasoning_tokens is not None:
        usage_kwargs["completion_tokens_details"] = {"reasoning_tokens": reasoning_tokens}
    response = ModelResponse(
        model=model,
        choices=[{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        usage=Usage(**usage_kwargs),
    )
    if provider is not None:
        response._hidden_params = {"custom_llm_provider": provider}
    return response


def _record(monkeypatch, requested_model: str, response, **record_kwargs) -> dict:
    span = _FakeSpan()
    monkeypatch.setattr(lc, "get_langfuse", lambda: _FakeLF(span))
    with lc.langfuse_generation("gen", model=requested_model, prompt="hi") as gen:
        gen.record_litellm(response, **record_kwargs)
    return span.updates[-1]


class TestRecordLitellmSendsUsageAndCost:
    def test_openai_response_without_details(self, monkeypatch):
        response = _litellm_response(
            model="gpt-5.4-mini-2026-03-17", provider="openai", prompt_tokens=1000, completion_tokens=200
        )

        sent = _record(monkeypatch, "openai/gpt-5.4-mini", response)

        assert sent["usage_details"] == {"input": 1000, "output": 200, "total": 1200}
        # LiteLLM's own gpt-5.4-mini price: $0.75/M input, $4.50/M output.
        assert sent["cost_details"]["input"] == pytest.approx(1000 * 0.75e-6)
        assert sent["cost_details"]["output"] == pytest.approx(200 * 4.5e-6)
        assert sent["cost_details"]["total"] == pytest.approx(1000 * 0.75e-6 + 200 * 4.5e-6)
        # The served snapshot is the requested model: recorded under the bare
        # alias, the snapshot kept in metadata.
        assert sent["model"] == "gpt-5.4-mini"
        assert sent["metadata"]["served_model"] == "gpt-5.4-mini-2026-03-17"
        assert sent["metadata"]["provider"] == "openai"
        assert sent["metadata"]["usage_reported"] is True
        assert "usage" not in sent

    def test_cached_and_reasoning_tokens_use_langfuse_usage_types(self, monkeypatch):
        response = _litellm_response(
            model="gpt-5.4-mini",
            provider="openai",
            prompt_tokens=1000,
            completion_tokens=200,
            cached_tokens=800,
            reasoning_tokens=50,
        )

        sent = _record(monkeypatch, "openai/gpt-5.4-mini", response)

        # input/output exclude the detail types, so the parts sum to the
        # provider's prompt and completion counts.
        assert sent["usage_details"] == {
            "input": 200,
            "input_cached_tokens": 800,
            "output": 150,
            "output_reasoning_tokens": 50,
            "total": 1200,
        }
        # Cached input is priced at LiteLLM's cached rate ($0.075/M).
        assert sent["cost_details"]["input"] == pytest.approx(200 * 0.75e-6 + 800 * 0.075e-6)
        assert sent["cost_details"]["output"] == pytest.approx(200 * 4.5e-6)

    def test_gemini_response_records_tokens_and_cost(self, monkeypatch):
        response = _litellm_response(
            model="gemini-2.5-flash", provider="gemini", prompt_tokens=1234, completion_tokens=6
        )

        sent = _record(monkeypatch, "gemini/gemini-2.5-flash", response, output="yes")

        assert sent["usage_details"] == {"input": 1234, "output": 6, "total": 1240}
        # $0.30/M input, $2.50/M output.
        assert sent["cost_details"]["total"] == pytest.approx(1234 * 0.3e-6 + 6 * 2.5e-6)
        assert sent["model"] == "gemini-2.5-flash"
        assert "served_model" not in sent["metadata"]
        assert sent["output"] == "yes"

    def test_a_fallback_is_recorded_and_priced_as_the_model_that_served(self, monkeypatch):
        response = _litellm_response(
            model="gemini-2.5-flash", provider="gemini", prompt_tokens=100, completion_tokens=10
        )

        sent = _record(monkeypatch, "openai/gpt-5.4-mini", response)

        assert sent["model"] == "gemini-2.5-flash"
        assert sent["metadata"]["provider"] == "gemini"
        assert sent["cost_details"]["total"] == pytest.approx(100 * 0.3e-6 + 10 * 2.5e-6)

    def test_a_pricing_failure_is_swallowed_and_usage_still_recorded(self, monkeypatch):
        import litellm

        def _boom(**_kwargs):
            raise RuntimeError("price table exploded")

        monkeypatch.setattr(litellm, "cost_per_token", _boom)
        response = _litellm_response(model="gemini-2.5-flash", provider="gemini", prompt_tokens=10, completion_tokens=2)

        sent = _record(monkeypatch, "gemini/gemini-2.5-flash", response)

        assert sent["usage_details"] == {"input": 10, "output": 2, "total": 12}
        assert "cost_details" not in sent

    def test_an_unpriced_model_records_usage_without_cost(self, monkeypatch):
        response = _litellm_response(model="house-model-x", provider="openai", prompt_tokens=10, completion_tokens=2)

        sent = _record(monkeypatch, "openai/house-model-x", response)

        assert sent["usage_details"]["total"] == 12
        assert "cost_details" not in sent

    def test_a_stream_without_a_usage_chunk_records_text_and_flags_it(self, monkeypatch):
        sent = _record(monkeypatch, "openai/gpt-5.4-mini", None, output="partial answer")

        assert sent["output"] == "partial answer"
        assert sent["model"] == "gpt-5.4-mini"
        assert sent["metadata"] == {"usage_reported": False, "provider": "openai"}
        assert "usage_details" not in sent
        assert "cost_details" not in sent

    def test_the_observation_starts_under_the_bare_model_name(self, monkeypatch):
        fake = _FakeLF(_FakeSpan())
        monkeypatch.setattr(lc, "get_langfuse", lambda: fake)

        with lc.langfuse_generation("gen", model="gemini/gemini-2.5-flash", prompt="hi"):
            pass

        assert fake.kw["model"] == "gemini-2.5-flash"
        assert fake.kw["as_type"] == "generation"


class TestRecordEmbedding:
    def test_records_counts_estimated_tokens_and_cost_without_text(self, monkeypatch):
        span = _FakeSpan()
        fake = _FakeLF(span)
        monkeypatch.setattr(lc, "get_langfuse", lambda: fake)

        with lc.langfuse_generation(
            "gemini-embedding",
            model="gemini/gemini-embedding-001",
            input={"texts": 3, "characters": 401},
            as_type="embedding",
        ) as obs:
            obs.record_embedding(texts=3, characters=401, reported_input_tokens=None)

        assert fake.kw["as_type"] == "embedding"
        sent = span.updates[-1]
        assert sent["model"] == "gemini-embedding-001"
        assert sent["usage_details"] == {"input": 101, "total": 101}
        # LiteLLM's gemini-embedding-001 price: $0.15/M input tokens.
        assert sent["cost_details"]["total"] == pytest.approx(101 * 0.15e-6)
        assert sent["metadata"] == {"texts": 3, "characters": 401, "usage_source": "estimate: characters / 4"}

    def test_a_reported_token_count_replaces_the_estimate(self, monkeypatch):
        span = _FakeSpan()
        monkeypatch.setattr(lc, "get_langfuse", lambda: _FakeLF(span))

        with lc.langfuse_generation("e", model="gemini/gemini-embedding-001", as_type="embedding") as obs:
            obs.record_embedding(texts=2, characters=400, reported_input_tokens=77)

        assert span.updates[-1]["usage_details"] == {"input": 77, "total": 77}
        assert span.updates[-1]["metadata"]["usage_source"] == "reported"

    def test_noop_when_disabled(self, monkeypatch):
        monkeypatch.setattr(lc, "get_langfuse", lambda: None)
        with lc.langfuse_generation("e", model="gemini/gemini-embedding-001", as_type="embedding") as obs:
            obs.record_embedding(texts=1, characters=1, reported_input_tokens=None)
