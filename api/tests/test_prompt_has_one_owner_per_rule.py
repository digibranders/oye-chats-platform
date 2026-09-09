"""Each formatting concern is stated once, by one owner.

The prompt is assembled from seven layers and they disagreed, because each was
added without deleting the one it replaced. Measured on 2026-09-09, the model
was told: answers are 1-3 sentences AND 40-80 words; bold three specific things
AND "the 2-3 most important facts"; ask a follow-up only when the question is
ambiguous AND whenever it is "genuinely valuable" AND once per turn for
qualification; say "that detail isn't in the documentation I can see" AND never
use the word "documentation". The style block sits last, so on a tie it won.

These tests do not judge the wording. They assert that exactly one layer speaks
for each concern, so the next person to add a rule has to delete the old one.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.services.qualification_service import get_framework_config
from app.services.rag_service import build_hybrid_prompt

_CLIENT = SimpleNamespace(name="Acme")
_CONTEXT = "<<<DOCUMENT 1 | about.md>>>\nAcme builds analytics tooling.\n<<<END DOCUMENT 1>>>\n"


def _prompt(context: str = _CONTEXT, **kwargs) -> str:
    system, _user = build_hybrid_prompt(
        _CLIENT,
        "what does the company do",
        context,
        "USER: hi\nBOT: hello",
        bant_enabled=True,
        bant_config=get_framework_config(None),
        live_chat_enabled=True,
        support_enabled=True,
        company_name="Acme",
        **kwargs,
    )
    return system


class TestOneOwnerPerConcern:
    def test_length_is_stated_once(self):
        prompt = _prompt()

        assert "1-3 sentences" in prompt
        assert "40-80 words" not in prompt, "the style block is restating the length rule RULE 1 owns"
        assert "100-200 words" not in prompt

    def test_bold_is_stated_once(self):
        prompt = _prompt()

        assert prompt.count("Bold only:") == 1
        assert "2-3 most important facts" not in prompt, "the style block is restating the bold rule RULE 3 owns"

    def test_the_follow_up_policy_has_one_home(self):
        """RULE 7 and the qualification block already decide this. The style
        block's own version told the model to ask whenever it seemed valuable,
        which is why bots probed on nearly every turn."""
        prompt = _prompt()

        assert "If a follow-up is genuinely valuable" not in prompt

    def test_unknown_information_phrasing_does_not_contradict_rule_9(self):
        """RULE 9 forbids saying "documents", "sources" or "knowledge base" to a
        visitor. The style block recommended two phrasings that use exactly
        those words."""
        prompt = _prompt()

        assert "documentation I can see" not in prompt
        assert "isn't covered in what I have access to" not in prompt

    def test_pricing_does_not_demand_an_invented_cadence(self):
        """Requiring a cadence on every pricing answer is an instruction to
        invent one when the source has none."""
        prompt = _prompt()

        assert "PRICING ANSWERS must always include" not in prompt
        assert "whichever of the price, the currency and the billing cadence" in prompt


class TestThePersonaIsNotHardCoded:
    """The platform sells to clinics, restaurants and agencies. The style block
    told every one of their bots it was selling B2B SaaS."""

    def test_no_vertical_is_assumed(self):
        prompt = _prompt(company_description="A family dental clinic in Pune.")

        assert "B2B SaaS" not in prompt
        assert "solutions engineer" not in prompt

    def test_the_company_description_still_reaches_the_model(self):
        prompt = _prompt(company_description="A family dental clinic in Pune.")

        assert "family dental clinic" in prompt


class TestTheMediaRulebookIsBounded:
    """It was 32,218 characters, roughly 8,000 tokens, and it doubled the
    prompt for any bot that owned a single file."""

    def test_the_block_is_small(self):
        catalog = _CONTEXT + "\nAVAILABLE MEDIA:\n  - Downloadable file (guide.pdf): https://acme.com/guide.pdf"
        with_media = _prompt(context=catalog)
        without = _prompt()

        assert len(with_media) - len(without) < 3000

    def test_it_still_carries_the_rules_that_matter(self):
        catalog = _CONTEXT + "\nAVAILABLE MEDIA:\n  - Downloadable file (guide.pdf): https://acme.com/guide.pdf"
        prompt = _prompt(context=catalog)

        assert "[YOUTUBE_CARD:" in prompt
        assert "[DOWNLOAD_CARD:" in prompt
        assert "verbatim" in prompt, "the model must be told never to invent an id"
        assert "more than one card" in prompt

    def test_it_no_longer_pushes_cards(self):
        """The old block told the model a card makes a visitor 5-10x more
        likely to convert and to emit one when on the fence."""
        catalog = _CONTEXT + "\nAVAILABLE MEDIA:\n  - Downloadable file (guide.pdf): https://acme.com/guide.pdf"
        prompt = _prompt(context=catalog)

        assert "5-10" not in prompt
        assert "on the fence" not in prompt
        assert "LEAN TOWARD emitting" not in prompt

    def test_a_bot_without_media_pays_nothing(self):
        assert "[YOUTUBE_CARD:" not in _prompt()
