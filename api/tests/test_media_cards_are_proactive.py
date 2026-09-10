"""A media card is offered on topic, not only on request.

The original media rulebook was 32,218 characters and said this at length:
"The visitor doesn't have to explicitly ask 'do you have a video?'. If they
surface a topic and the catalog has an asset on that exact topic, that IS the
moment to emit the card. Do NOT hold back waiting for a more explicit ask."

Shrinking that rulebook to 1,539 characters compressed all of it into one
clause and, worse, left a NEVER beside it that forbade a card on "a plain
factual answer". A model reading both suppressed the card for "tell me about
SOC as a Service" on a bot whose knowledge base holds a SOC as a Service
datasheet. Verified against production: three topical questions, three
matching PDFs, no card on any of them.

Compression is still right; the rulebook did not need 32k characters to say
this. Losing the instruction was not. These assertions are what makes the
difference visible next time someone trims it.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.qualification_service import get_framework_config
from app.services.rag_service import build_hybrid_prompt

_CLIENT = SimpleNamespace(name="Acme")
_CONTEXT = (
    "<<<DOCUMENT 1 | soc.md>>>\nSOC as a Service is a managed detection offering.\n<<<END DOCUMENT 1>>>\n"
    "\nAVAILABLE MEDIA (pick the ONE whose title best matches):\n"
    "  - Downloadable file (soc-datasheet.pdf): https://acme.com/soc-datasheet.pdf"
)


@pytest.fixture(scope="module")
def prompt() -> str:
    system, _user = build_hybrid_prompt(
        _CLIENT,
        "tell me about SOC as a Service",
        _CONTEXT,
        "USER: hi\nBOT: hello",
        bant_enabled=True,
        bant_config=get_framework_config(None),
        live_chat_enabled=True,
        support_enabled=True,
        company_name="Acme",
    )
    return system


class TestTheRuleSaysTopicIsEnough:
    def test_a_topical_question_is_named_as_a_trigger(self, prompt):
        assert "A topical question counts" in prompt

    def test_it_says_not_to_wait_for_an_explicit_ask(self, prompt):
        assert "Do NOT hold back waiting for a more explicit ask" in prompt

    def test_it_says_not_to_hold_out_for_a_perfect_title(self, prompt):
        assert "word-perfect title match" in prompt
        assert "Lean toward emitting" in prompt


class TestTheExclusionDoesNotSwallowTheRule:
    """The NEVER clause and the WHEN clause were in direct conflict, and the
    NEVER won. It has to name the narrow case it means."""

    def test_it_excludes_one_line_lookups_not_topical_questions(self, prompt):
        assert "one-line factual lookup" in prompt
        assert "NOT about topical questions" in prompt

    def test_the_over_broad_wording_is_gone(self, prompt):
        assert "a plain factual answer (hours, price," not in prompt

    def test_mismatch_is_the_bar_not_uncertainty(self, prompt):
        assert "topical mismatch, not general uncertainty" in prompt


class TestTheGuardsThatMustSurvive:
    """Widening when a card fires must not widen where its URL may come from."""

    def test_the_url_must_come_from_the_catalog(self, prompt):
        assert "MUST appear verbatim in that catalog" in prompt
        assert "Never recall one" in prompt

    def test_still_at_most_one_card(self, prompt):
        assert "more than one card in a reply" in prompt
