"""Phase 6: the platform-wide multilingual switch.

``feature.multilingual_chat_enabled`` is the coarse lever for Phases 2/3, the
counterpart to ``feature.translation_enabled`` for Phase 4. Before it existed
the only way to stop visitor language resolution across the platform was to
edit every bot's ``language_config`` row.

The contract these tests hold:

- OFF makes an enabled bot behave EXACTLY like a bot whose owner never turned
  multilingual on. Not "mostly like": the RAG pipeline decides between two
  byte-identical-to-2025 paths on this one signal, so a partial disable would
  give a bot the legacy cache key and a language directive at the same time.
- The customer's stored configuration is never mutated. Flipping the switch
  back restores what they configured, without a write.
- It never touches translation-side or dashboard-side locale behaviour.
"""

from __future__ import annotations

import pytest

from app.services import credit_service
from app.services.language_service import MULTILINGUAL_FEATURE, is_multilingual_enabled


class _Bot:
    def __init__(self, cfg, bot_id: int = 1):
        self.id = bot_id
        self.language_config = cfg


ENABLED = {"enabled": True, "default_locale": "en-IN", "supported_locales": ["en-IN", "hi-IN"]}
DISABLED = {"enabled": False, "default_locale": "en-IN", "supported_locales": ["en-IN"]}


@pytest.fixture(autouse=True)
def _clear_pricing_cache():
    credit_service.invalidate_pricing_cache()
    yield
    credit_service.invalidate_pricing_cache()


def _set_switch(monkeypatch, value: bool) -> list[str]:
    """Force the platform switch and record which feature was asked about."""
    asked: list[str] = []

    def fake(session, feature):
        asked.append(feature)
        return value if feature == MULTILINGUAL_FEATURE else True

    monkeypatch.setattr(credit_service, "is_feature_enabled", fake)
    return asked


def test_on_by_default_so_shipping_the_switch_changes_nothing(monkeypatch):
    # A platform lever that arrives switched off would disable a live feature
    # on deploy. The default must be a no-op.
    assert credit_service._DEFAULT_PRICING["feature.multilingual_chat_enabled"] is True


def test_enabled_bot_stays_enabled_when_the_switch_is_on(monkeypatch):
    _set_switch(monkeypatch, True)
    assert is_multilingual_enabled(_Bot(ENABLED)) is True


def test_enabled_bot_is_disabled_when_the_switch_is_off(monkeypatch):
    _set_switch(monkeypatch, False)
    assert is_multilingual_enabled(_Bot(ENABLED)) is False


def test_a_disabled_bot_never_consults_the_switch(monkeypatch):
    """The disabled fast path must not gain a database round trip.

    Bots with multilingual off are the overwhelming majority and this runs on
    every chat turn. Checking the platform switch first would put a session
    open on the hot path of every bot that does not use the feature.
    """
    asked = _set_switch(monkeypatch, False)
    assert is_multilingual_enabled(_Bot(DISABLED)) is False
    assert asked == [], "the platform switch was consulted for a bot that has multilingual off"


def test_missing_and_malformed_config_are_treated_as_off(monkeypatch):
    asked = _set_switch(monkeypatch, True)
    for cfg in (None, {}, {"enabled": False}, {"supported_locales": ["hi-IN"]}):
        assert is_multilingual_enabled(_Bot(cfg)) is False
    assert asked == []


def test_the_switch_does_not_mutate_stored_configuration(monkeypatch):
    _set_switch(monkeypatch, False)
    bot = _Bot(dict(ENABLED))
    is_multilingual_enabled(bot)
    assert bot.language_config == ENABLED, "the customer's configuration was rewritten"


def test_it_fails_open_when_the_lookup_raises(monkeypatch):
    """A database blip must not change the language a live chat is held in.

    Silently switching a Hindi conversation to English because pricing config
    could not be read is worse than briefly ignoring an operator's kill switch,
    which they can re-apply. Matches ``is_feature_enabled``'s own stance.
    """

    def boom(session, feature):
        raise RuntimeError("pricing table unreachable")

    monkeypatch.setattr(credit_service, "is_feature_enabled", boom)
    assert is_multilingual_enabled(_Bot(ENABLED)) is True


def test_it_reads_the_multilingual_key_not_the_translation_one(monkeypatch):
    # The two switches must be independently operable: withdrawing operator
    # translation should not stop the AI answering in the visitor's language.
    asked = _set_switch(monkeypatch, True)
    is_multilingual_enabled(_Bot(ENABLED))
    assert asked == [MULTILINGUAL_FEATURE]
    assert MULTILINGUAL_FEATURE != "translation"


def test_the_pricing_key_spells_out_as_documented():
    # `is_feature_enabled` builds `feature.<name>_enabled`. If the constant and
    # the seeded key ever disagree the switch reads a key nobody can set, which
    # is precisely the bug the `_enabled` suffix comment in credit_service
    # records having shipped once already.
    assert f"feature.{MULTILINGUAL_FEATURE}_enabled" in credit_service._DEFAULT_PRICING
