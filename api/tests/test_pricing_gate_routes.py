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


def test_the_write_and_read_contracts_expose_no_gate_toggle():
    """Inverted from the old "the response defaults the gate off" case.

    The gate is unconditional, so an enable flag reappearing on either model is
    an opt-out being reintroduced, whatever it ends up being called. Asserting
    the absence on both models is what makes that visible at review time.
    """
    for model in (UpdateBotRequest, BotResponse):
        toggles = [name for name in model.model_fields if "pricing" in name and name != "pricing_url"]
        assert toggles == [], f"{model.__name__} grew a pricing gate toggle: {toggles}"

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
    # And no companion toggle rode along: the cached bot carries the page and
    # nothing else, so there is no cached state that could switch the gate off.
    assert [k for k in payload if "pricing" in k] == ["pricing_url"]

    restored = _bot_from_cache_dict(json.loads(json.dumps(payload, default=str)))
    assert restored.pricing_url is None
