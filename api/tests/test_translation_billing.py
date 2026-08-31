"""What a translation costs, and when.

Credits were reserved BEFORE the cache lookup and never given back:

* the cache is keyed on ``(source, target, text)`` and shared across tenants,
  so a hit that made no provider call still debited a workspace;
* on ``TranslationUnavailable`` the reservation stayed spent. The visitor read
  the untranslated original and the credit bought nothing, so a provider
  degraded for a minute billed ten credits for ten messages nobody translated.
"""

import asyncio
from types import SimpleNamespace

import pytest

from app.services import translation_service as ts


class _StubProvider:
    provider_name = "stub"
    model = "stub-model"

    def __init__(self, result: str = "TRANSLATED", exc: Exception | None = None):
        self.calls: list[tuple[str, str, str]] = []
        self._result = result
        self._exc = exc

    async def translate(self, text, source_language, target_language, timeout=None):
        self.calls.append((text, source_language, target_language))
        if self._exc is not None:
            raise self._exc
        return ts.TranslationResult(content=self._result, provider=self.provider_name, model=self.model, cached=False)


def _run(coro):
    return asyncio.run(coro)


def _bot():
    return SimpleNamespace(
        id=1,
        client_id=1,
        language_config={"enabled": True, "operator_translation_enabled": True},
    )


@pytest.fixture
def ledger(monkeypatch):
    """Records charges and refunds instead of touching the credit ledger."""
    book = {"charges": [], "refunds": []}
    monkeypatch.setattr(
        ts, "charge_for_translation", lambda bot, mid, lang: book["charges"].append((mid, lang)) or True
    )
    monkeypatch.setattr(ts, "refund_translation_charge", lambda bot, mid, lang: book["refunds"].append((mid, lang)))
    monkeypatch.setattr(ts, "store_translation", lambda *a, **k: True)
    return book


@pytest.fixture
def cold_cache(monkeypatch):
    monkeypatch.setattr(ts, "cache_get", lambda key: None)
    monkeypatch.setattr(ts, "cache_set", lambda key, value, ttl: True)


@pytest.fixture
def warm_cache(monkeypatch):
    """Every lookup is a hit, so no provider call is ever needed."""
    monkeypatch.setattr(ts, "cache_get", lambda key: "पहले से अनुवादित")
    monkeypatch.setattr(ts, "cache_set", lambda key, value, ttl: True)


# ── Outgoing (operator -> visitor) ───────────────────────────────────────────


class TestOutgoingBilling:
    def test_a_cache_hit_is_not_billed(self, monkeypatch, ledger, warm_cache):
        provider = _StubProvider()
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=provider))

        delivered, translated_from = _run(ts.translate_outgoing("s1", 5, "Hello", _bot(), "en", "hi"))

        assert delivered == "पहले से अनुवादित"
        assert translated_from == "en"
        assert provider.calls == []  # nothing was bought...
        assert ledger["charges"] == []  # ...so nothing is charged.

    def test_a_cache_miss_is_billed_exactly_once(self, monkeypatch, ledger, cold_cache):
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=_StubProvider("नमस्ते")))

        delivered, _ = _run(ts.translate_outgoing("s1", 5, "Hello", _bot(), "en", "hi"))

        assert delivered == "नमस्ते"
        assert ledger["charges"] == [(5, "hi")]
        assert ledger["refunds"] == []

    def test_a_provider_failure_is_refunded(self, monkeypatch, ledger, cold_cache):
        monkeypatch.setattr(
            ts,
            "translation_service",
            ts.TranslationService(provider=_StubProvider(exc=ts.TranslationUnavailable("down"))),
        )

        delivered, translated_from = _run(ts.translate_outgoing("s1", 5, "Hello", _bot(), "en", "hi"))

        # The visitor still gets the operator's words...
        assert delivered == "Hello"
        assert translated_from is None
        # ...and does not pay for the words they did not get.
        assert ledger["charges"] == [(5, "hi")]
        assert ledger["refunds"] == [(5, "hi")]

    def test_a_workspace_out_of_credits_still_makes_no_provider_call(self, monkeypatch, cold_cache):
        """The charge is what gates the vendor call, so it must precede it."""
        monkeypatch.setattr(ts, "charge_for_translation", lambda *a, **k: False)
        refunds = []
        monkeypatch.setattr(ts, "refund_translation_charge", lambda *a, **k: refunds.append(a))
        provider = _StubProvider()
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=provider))

        delivered, _ = _run(ts.translate_outgoing("s1", 5, "Hello", _bot(), "en", "hi"))

        assert delivered == "Hello"
        assert provider.calls == []
        # Nothing was reserved, so nothing may be handed back.
        assert refunds == []


# ── Incoming (visitor -> operator) ───────────────────────────────────────────


class TestIncomingBilling:
    @pytest.fixture(autouse=True)
    def _resolved_target(self, monkeypatch):
        monkeypatch.setattr(ts, "resolve_incoming_target", lambda session_id: ("en", _bot(), "hi"))

        class _Manager:
            def __init__(self):
                self.sent = []

            async def send_translation_to_operator(self, session_id, payload):
                self.sent.append(payload)

        manager = _Manager()
        monkeypatch.setattr("app.services.live_chat_service.manager", manager)
        return manager

    def test_a_cache_hit_is_not_billed(self, monkeypatch, ledger, warm_cache):
        provider = _StubProvider()
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=provider))

        _run(ts._translate_incoming("s1", 7, "मुझे pricing चाहिए"))

        assert provider.calls == []
        assert ledger["charges"] == []

    def test_a_provider_failure_is_refunded(self, monkeypatch, ledger, cold_cache):
        monkeypatch.setattr(
            ts,
            "translation_service",
            ts.TranslationService(provider=_StubProvider(exc=ts.TranslationUnavailable("down"))),
        )

        _run(ts._translate_incoming("s1", 7, "मुझे pricing चाहिए"))

        assert ledger["charges"] == [(7, "en")]
        assert ledger["refunds"] == [(7, "en")]


# ── The probe itself ─────────────────────────────────────────────────────────


class TestCacheProbe:
    def test_is_cached_reports_a_hit_without_calling_the_provider(self, monkeypatch, warm_cache):
        provider = _StubProvider()
        service = ts.TranslationService(provider=provider)

        assert service.is_cached("Hello", "en", "hi") is True
        assert provider.calls == []

    def test_is_cached_is_false_for_a_miss(self, cold_cache):
        assert ts.TranslationService(provider=_StubProvider()).is_cached("Hello", "en", "hi") is False

    def test_is_cached_is_false_for_same_language(self, warm_cache):
        """Same-language never reaches a provider, so it is not a billable
        event either way and must not be reported as a paid-for cache hit."""
        assert ts.TranslationService(provider=_StubProvider()).is_cached("Hello", "en-IN", "en-US") is False

    def test_an_unreadable_cache_falls_back_to_charging(self, monkeypatch):
        def _boom(key):
            raise RuntimeError("redis is gone")

        monkeypatch.setattr(ts, "cache_get", _boom)
        assert ts.translation_is_free(_bot(), "Hello", "en", "hi") is False
