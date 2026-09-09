"""Four predicates that change what a visitor sees, and had no test at all.

Found while auditing the proposal to replace the routing predicates with an
LLM classifier. That proposal is rejected, but the audit turned up twelve
predicates with no coverage, and these four are the ones whose output the
visitor reads:

* ``_response_suggests_handoff`` flips ``suggest_handoff``, so the widget
  renders the handoff form. It is the safety net for when the intent
  classifier times out and the model produces handoff language anyway.
* ``_is_pure_budget_disclosure`` EMPTIES the retrieval context. Get it wrong in
  one direction and a visitor stating their budget is quoted the business's own
  price list back at them; wrong in the other and a genuine question loses its
  context and is answered from nothing.
* ``_mentions_team_offer`` decides which refusal a Free-plan visitor sees, on a
  plan whose prompt forbids offering a human at all.
* ``_is_known_refusal`` drives refusal escalation, so consecutive refusals do
  not read identically.
"""

from __future__ import annotations

import pytest

from app.services.rag_service import (
    OFF_TOPIC_ESCALATION_VARIANTS,
    OFF_TOPIC_REFUSAL_VARIANTS,
    _is_known_refusal,
    _is_pure_budget_disclosure,
    _mentions_team_offer,
    _response_suggests_handoff,
    _states_budget_amount,
)


class TestTheAnswerAskedForAHuman:
    @pytest.mark.parametrize(
        "answer",
        [
            "Let me connect you with our team.",
            "I'll connect you with someone who can help.",
            "Our team will be with you shortly.",
            "A team member will reach out today.",
            "Transferring you to an operator now.",
            "Someone will be with you in a moment.",
        ],
    )
    def test_handoff_language_is_caught(self, answer):
        assert _response_suggests_handoff(answer) is True

    @pytest.mark.parametrize(
        "answer",
        [
            "We offer six services, starting with UI/UX.",
            "Pricing starts at 449 a month, billed annually.",
            "Our office is open nine to five on weekdays.",
            "I connect the two systems using a webhook.",
        ],
    )
    def test_an_ordinary_answer_does_not_trip_it(self, answer):
        """A false positive here shows the visitor a handoff form nobody
        offered them, on a turn that answered their question."""
        assert _response_suggests_handoff(answer) is False


class TestABudgetStatementIsNotAQuestion:
    @pytest.mark.parametrize(
        "message",
        [
            "our budget is EUR 2000 per month",
            "we have $5,000 a month for this",
            "£1,500 per month is what we can do",
            "50,000 rupees per month",
        ],
    )
    def test_a_bare_budget_empties_the_context(self, message):
        """Currency-independent on purpose. Live, "$5,000 per month" was
        answered sensibly and "EUR 2000 per month" was refused, on the same
        bot, because the decision depended on whether that currency happened to
        appear in the knowledge base."""
        assert _states_budget_amount(message) is True
        assert _is_pure_budget_disclosure(message) is True

    @pytest.mark.parametrize(
        "message",
        [
            "our budget is EUR 2000, what do you support at that level?",
            "we have $5,000 a month, is that enough for the Professional plan?",
        ],
    )
    def test_a_budget_plus_a_question_keeps_its_context(self, message):
        """The question half is a real knowledge-base query. Emptying the
        context would answer it from nothing."""
        assert _states_budget_amount(message) is True
        assert _is_pure_budget_disclosure(message) is False

    @pytest.mark.parametrize(
        "message",
        ["what do you charge", "tell me about your services", "how many seats are included"],
    )
    def test_a_message_with_no_money_in_it_is_untouched(self, message):
        assert _is_pure_budget_disclosure(message) is False


class TestARefusalMustNotDangleAHuman:
    @pytest.mark.parametrize(
        "text",
        [
            "Want me to connect you with the team?",
            "I can put you in touch with someone.",
            "Happy to hand you off to a colleague.",
            "You can talk to someone on the team about that.",
        ],
    )
    def test_an_offer_is_recognised(self, text):
        assert _mentions_team_offer(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            "That is outside what I can help with.",
            "I cover questions about Acme only.",
            "Want to know about our services or pricing?",
        ],
    )
    def test_a_refusal_with_no_offer_is_left_alone(self, text):
        assert _mentions_team_offer(text) is False


class TestRefusalEscalationKnowsItsOwnCopy:
    @pytest.mark.parametrize("template", OFF_TOPIC_REFUSAL_VARIANTS + OFF_TOPIC_ESCALATION_VARIANTS)
    def test_every_shipped_variant_is_recognised(self, template):
        """The escalation counter reads back the bot's own previous messages.
        A variant it cannot recognise resets the count, and the visitor gets
        the same refusal twice in a row, which is the reported symptom this
        machinery exists to prevent."""
        assert _is_known_refusal(template.format(company_name="Acme"), "Acme") is True

    def test_a_real_answer_is_not_mistaken_for_a_refusal(self):
        assert _is_known_refusal("We offer six services, starting with UI/UX.", "Acme") is False

    def test_empty_input_is_safe(self):
        assert _is_known_refusal("", "Acme") is False
        assert _is_known_refusal("   ", "Acme") is False

    def test_it_matches_on_the_first_forty_characters_only(self):
        """Worth writing down, because it is not what the name suggests.

        The comparison is `text[:40] == rendered_template[:40]`, so a variant
        whose company name falls beyond character 40 is recognised whatever
        name it was rendered with. That is harmless in practice: the function
        is only ever handed this bot's own history alongside this bot's own
        company name. It would stop being harmless if it were ever reused to
        classify text from somewhere else.
        """
        rendered = OFF_TOPIC_REFUSAL_VARIANTS[0].format(company_name="Acme")
        assert rendered.index("Acme") > 40
        assert _is_known_refusal(rendered, "Fynix Digital") is True

        # A variant that names the company early does discriminate.
        early = next(
            (v for v in OFF_TOPIC_REFUSAL_VARIANTS if v.format(company_name="Acme").index("Acme") < 40),
            None,
        )
        assert early is not None, "no variant names the company inside the compared prefix"
        assert _is_known_refusal(early.format(company_name="Acme"), "Fynix Digital") is False
