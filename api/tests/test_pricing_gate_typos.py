"""The pricing gate must not change its mind over a typo.

A tester on 2026-09-10 asked a live bot for SOC pricing from three devices and
got two different behaviours. Two sessions were handed to the team; one was
answered with rate figures. It looked like a device problem. It was spelling:
"iwant to know the soc pricng ?" does not contain the word "pricing", the gate
decides from the wording of the question, so it did not fire and the turn fell
through to the general knowledge base.

These are the exact messages from those sessions.
"""

from __future__ import annotations

import pytest

from app.services.pricing_gate import _within_one_edit, is_pricing_question

#: Verbatim from the three sessions in the report.
REPORTED = [
    "give me pricing for SOC",
    "give me the pricing",
    "i want to know about soc pricing?",
    "i want to know pricing fro soc?",
    "iwant to know the soc pricng ?",
]


class TestTheSameIntentGetsTheSameBehaviour:
    def test_every_reported_message_is_recognised(self):
        assert [is_pricing_question(q) for q in REPORTED] == [True] * len(REPORTED)

    @pytest.mark.parametrize(
        "question",
        [
            "what is the soc pricng",
            "soc prcing please",
            "pricin for mssp",
            "whats the priceing",
            "share your pricign",
            "can you send a quotaton",
            "do you have a pricelst",
        ],
    )
    def test_a_single_typo_in_a_long_price_word_still_fires(self, question):
        assert is_pricing_question(question) is True


class TestTypoToleranceDoesNotInventPricingQuestions:
    """The reason tolerance stops at six letters. One edit from "price" are
    "pride", "prime" and "prize"; one edit from "cost" is "cast". Firing the
    gate on those would hand a real question to the team with a pricing
    apology, which is the failure this whole gate was already fixed for once."""

    @pytest.mark.parametrize(
        "question",
        [
            "what is your prime service",
            "we take pride in our SOC",
            "did you win a prize",
            "what is the cast of the webinar",
            "tell me about SOC as a Service",
            "explain penetration testing",
            "who is the VP of sales",
        ],
    )
    def test_it_does_not_fire(self, question):
        # Known and accepted: "pricking" is one insertion from "pricing" and
        # would fire. Nobody asks a security vendor's chatbot about pricking,
        # so it is documented here rather than engineered around.
        assert is_pricing_question(question) is False

    def test_the_existing_idiom_exclusions_still_win(self):
        assert is_pricing_question("how much time does onboarding take") is False
        assert is_pricing_question("we will support you at all costs") is False


class TestTheEditDistanceItself:
    @pytest.mark.parametrize(
        ("a", "b", "expected"),
        [
            ("pricing", "pricing", True),
            ("pricng", "pricing", True),  # deletion
            ("priceing", "pricing", True),  # insertion
            ("pricong", "pricing", True),  # substitution
            ("pricign", "pricing", True),  # adjacent swap
            ("prcign", "pricing", False),  # two edits
            ("pri", "pricing", False),
            ("", "pricing", False),
        ],
    )
    def test_within_one_edit(self, a, b, expected):
        assert _within_one_edit(a, b) is expected
