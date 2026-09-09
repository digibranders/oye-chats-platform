"""The pricing-gate fields on the bot create/update/read contract.

The gate is an unconditional answering restriction, so ``pricing_url`` is the
only knob and an unusable value must be a visible 422 at write time rather than
a bot that silently escalates every pricing question. There is deliberately no
enable flag on any of these models: leaving the URL unset is not "gate off", it
is "route every pricing question to the team".
"""

import json

import pytest
from pydantic import ValidationError

from app.api.auth import _bot_from_cache_dict, _bot_to_cache_dict
from app.api.bot_routes import BotResponse, UpdateBotRequest
from app.db.models import Bot


def test_update_accepts_a_valid_pricing_url():
    assert UpdateBotRequest(pricing_url="https://acme.com/pricing").pricing_url == "https://acme.com/pricing"


def test_update_rejects_a_non_http_pricing_url():
    with pytest.raises(ValidationError):
        UpdateBotRequest(pricing_url="javascript:alert(1)")


def test_update_accepts_an_empty_string_to_clear_the_url():
    assert UpdateBotRequest(pricing_url="").pricing_url == ""


def test_the_write_and_read_contracts_expose_exactly_one_gate_toggle():
    """The gate has one opt-out and it defaults off on both contracts.

    A SECOND pricing field appearing on either model is a new way to disable the
    gate arriving under a different name, which is what this pins; the behaviour
    of the one that exists is covered in ``tests/test_pricing_gate_optout.py``.
    """
    for model in (UpdateBotRequest, BotResponse):
        toggles = [name for name in model.model_fields if "pricing" in name and name != "pricing_url"]
        assert toggles == ["pricing_from_knowledge_base"], f"{model.__name__} pricing fields: {toggles}"

    assert BotResponse.model_fields["pricing_from_knowledge_base"].default is False
    assert UpdateBotRequest.model_fields["pricing_from_knowledge_base"].default is None
    assert BotResponse.model_fields["pricing_url"].default is None
    assert UpdateBotRequest.model_fields["pricing_url"].default is None


def test_bot_cache_payload_carries_the_pricing_url():
    """A cached bot load must still know which page it may price from.

    Driven through the real serializer and deserializer: the gate itself is
    unconditional and so cannot be lost, but a cache hit that dropped this URL
    would make an otherwise correctly configured bot escalate every pricing
    question until the entry expired, and that is invisible from the write path.
    """
    bot = Bot(
        id=7,
        client_id=3,
        bot_key="bot-cachetest",
        name="Cache Bot",
        pricing_url="https://acme.com/pricing",
    )

    payload = _bot_to_cache_dict(bot)
    assert payload["pricing_url"] == "https://acme.com/pricing"

    # The payload crosses Redis as JSON, so round-trip through it rather than
    # handing the dict straight back to the deserializer.
    restored = _bot_from_cache_dict(json.loads(json.dumps(payload, default=str)))
    assert restored.pricing_url == "https://acme.com/pricing"


def test_bot_cache_payload_round_trips_an_unconfigured_bot_as_no_url():
    """Inverted from the old "the off state must survive the round trip" case.

    There is no off state left. What must survive is the NULL, and it now means
    the opposite of what it used to: a bot with no pricing page escalates every
    pricing question, so a cached ``None`` coming back as a truthy default would
    silently point the gate at a page that does not exist.
    """
    payload = _bot_to_cache_dict(Bot(id=8, client_id=3, bot_key="bot-cachenourl", name="No URL Bot"))
    assert payload["pricing_url"] is None
    # The cached bot carries the page and the owner's opt-out, and nothing else:
    # a third pricing key appearing is cached state that could switch the gate
    # off behind the API contract's back.
    assert sorted(k for k in payload if "pricing" in k) == ["pricing_from_knowledge_base", "pricing_url"]
    # An unconfigured bot caches as gated, never as opted out.
    assert payload["pricing_from_knowledge_base"] is False

    restored = _bot_from_cache_dict(json.loads(json.dumps(payload, default=str)))
    assert restored.pricing_url is None
