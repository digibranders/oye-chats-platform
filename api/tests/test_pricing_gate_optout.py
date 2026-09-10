"""An owner may tell the bot to answer pricing from its own documents.

The gate had no opt-out at all: a bot with no ``pricing_url`` escalated every
pricing question to the team even when the uploaded documents state the price.
Live on the CleanStart bot, "what is your pricing" came back as "best confirmed
by the team" with zero sources.

The setting defaults OFF, so a bot that never touches it is gated exactly as
before, and that default is what these tests pin hardest: the opt-out is a
deliberate owner decision, never something a caller can trip into.
"""

from app.api.auth import _bot_from_cache_dict, _bot_to_cache_dict
from app.api.bot_routes import BotResponse, UpdateBotRequest
from app.db.models import Bot
from app.services.pricing_gate import evaluate_pricing_gate


class _Chunk:
    def __init__(self, document_name: str, content: str) -> None:
        self.document_name = document_name
        self.content = content


_KB = _Chunk("http://acme.com/about", "Our Pro plan costs $49 per month.")
_PRICED = _Chunk("http://acme.com/pricing", "Pro is $49 per month.")


def test_default_is_gated_exactly_as_before():
    decision = evaluate_pricing_gate(question="how much is pro?", quote_active=False, pricing_url=None, chunks=[_KB])

    assert decision.fired is True
    assert decision.outcome == "escalate_no_url"
    assert decision.chunks == []


def test_opted_out_bot_answers_from_the_knowledge_base():
    decision = evaluate_pricing_gate(
        question="how much is pro?",
        quote_active=False,
        pricing_url=None,
        chunks=[_KB],
        answer_from_knowledge_base=True,
    )

    assert decision.fired is False
    assert decision.outcome == "owner_optout"
    assert decision.chunks == [_KB]


def test_opting_out_also_widens_a_bot_that_has_a_pricing_page():
    """The setting means "trust my documents", not "trust my pricing page
    less": an owner who has both gets both, rather than the gate narrowing the
    answer to the one page."""
    decision = evaluate_pricing_gate(
        question="how much is pro?",
        quote_active=False,
        pricing_url="http://acme.com/pricing",
        chunks=[_KB, _PRICED],
        answer_from_knowledge_base=True,
    )

    assert decision.outcome == "owner_optout"
    assert decision.chunks == [_KB, _PRICED]


def test_an_active_quote_still_wins():
    """A quotation in flight is the better pricing answer either way, and it is
    checked first so the opt-out cannot pull a visitor out of that flow."""
    decision = evaluate_pricing_gate(
        question="how much is pro?",
        quote_active=True,
        pricing_url=None,
        chunks=[_KB],
        answer_from_knowledge_base=True,
    )

    assert decision.outcome == "quote_standdown"


def test_a_non_pricing_question_is_unaffected():
    decision = evaluate_pricing_gate(
        question="where are you based?",
        quote_active=False,
        pricing_url=None,
        chunks=[_KB],
        answer_from_knowledge_base=True,
    )

    assert decision.outcome == "not_pricing"


def test_the_flag_defaults_off_on_both_api_contracts():
    assert UpdateBotRequest.model_fields["pricing_from_knowledge_base"].default is None
    assert BotResponse.model_fields["pricing_from_knowledge_base"].default is False
    assert UpdateBotRequest().pricing_from_knowledge_base is None


def test_the_setting_survives_the_bot_cache():
    """A cache hit that dropped this flag would put an opted-out bot back on the
    gated behaviour until the entry expired, which is invisible from the write
    path."""
    bot = Bot(id=1, client_id=1, bot_key="bot-optout", name="Opt Out", pricing_from_knowledge_base=True)

    assert _bot_from_cache_dict(_bot_to_cache_dict(bot)).pricing_from_knowledge_base is True


def test_a_bot_that_never_set_it_reads_as_gated_from_the_cache():
    bot = Bot(id=2, client_id=1, bot_key="bot-default", name="Default")

    assert bool(_bot_from_cache_dict(_bot_to_cache_dict(bot)).pricing_from_knowledge_base) is False
