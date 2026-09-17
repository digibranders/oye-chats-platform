"""A bare "yes" to an offer with options continues with the first option.

On the 2026-09-17 eval a "yes" to the greeting's "Want to hear about our
services, see recent work, or chat with the team at Acme?" got "Got it." The
visitor agreed to the first thing offered, so the turn is answered as that
question.
"""

from __future__ import annotations

import pytest

from app.services.intent_router import _greeting, offered_option_question
from app.services.intent_service import is_bare_affirmation
from app.services.rag_service import OFF_TOPIC_REFUSAL_VARIANTS, _name_ack_message

SERVICES = "what services do you offer"


class TestTheBotsOwnOffers:
    @pytest.mark.parametrize("company", ["Acme", None])
    def test_the_greeting_continues_with_the_services_overview(self, company):
        assert offered_option_question(_greeting(company).answer) == SERVICES

    def test_the_name_welcome_continues_with_the_services_overview(self):
        assert offered_option_question(_name_ack_message("Eva", "Acme Security")) == SERVICES

    @pytest.mark.parametrize("template", OFF_TOPIC_REFUSAL_VARIANTS)
    def test_every_refusal_that_lists_options_leads_with_services(self, template):
        question = offered_option_question(template.format(company_name="**Acme**"))
        assert question in (SERVICES, None), question


class TestModelWrittenOffers:
    @pytest.mark.parametrize(
        ("message", "expected"),
        [
            (
                "Acme runs SOC in Pune.\n\nWould you like to know about pricing or see a case study?",
                "tell me about your pricing",
            ),
            ("Do you want to see our recent work, or hear about our process?", "tell me about your recent work"),
            ("Interested in how to get started or our pricing?", "how do i get started"),
            ("Are you looking at our services, pricing, or something else?", SERVICES),
        ],
    )
    def test_the_first_option_becomes_the_question(self, message, expected):
        assert offered_option_question(message) == expected


class TestNoOptionToContinue:
    @pytest.mark.parametrize(
        "message",
        [
            # The team first: the handoff affirmation decides.
            "Want me to connect you with our team, or send you the brochure?",
            "Want to chat with the team at **Acme**, or see recent work?",
            # One option only.
            "That detail sits with our sales team. Want me to connect you with them?",
            "Would you like to know more about Clean Images?",
            # An ordinary answer, a statement, a plain question.
            "Acme offers managed SOC and incident response.",
            "Glad that helped. Anything else you want to know about **Acme**?",
            "What's your timeline for this project?",
            "Want to hear about our services, see recent work, or chat with the team?\n\nWhat is your role?",
            "",
            None,
        ],
    )
    def test_no_question(self, message):
        assert offered_option_question(message) is None

    def test_a_long_message_is_read_in_linear_time(self):
        message = "Want to hear about " + "services, " * 5000 + "or pricing?"
        assert offered_option_question(message) == SERVICES


class TestBareAffirmation:
    @pytest.mark.parametrize("reply", ["yes", "Yeah", "sure", "ok", "okay!", "yes please", "y"])
    def test_agrees(self, reply):
        assert is_bare_affirmation(reply)

    @pytest.mark.parametrize("reply", ["connect me", "thanks", "yes what is the price", "no", "", None])
    def test_does_not_agree(self, reply):
        assert not is_bare_affirmation(reply)
