"""A phrase is never stored as the visitor's name, and a correction replaces it.

Production, 2026-09-11:
- "ok then take a message, i need someone to call me back about hardened
  container images" was captured through the "call me" intro and the bot
  replied "Thanks, Back About!" on two bots.
- "actually my name is not eva, its priya. typo earlier" renamed the lead to
  "Not Eva" instead of "Priya".

The intro patterns capture up to two words after the anchor, so a word that
can never be part of a name (a preposition, a negation, a time word) has to
reject the candidate. A correction names both the wrong and the right name,
so it is explicit enough to overwrite a stored one.
"""

import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services import rag_service
from app.services.rag_service import (
    _clean_visitor_name,
    _extract_explicit_rename,
    _extract_name_change,
    _extract_visitor_name,
)

_ASKED = [
    {"role": "user", "content": "is anyone there right now"},
    {"role": "bot", "content": rag_service._NAME_REQUEST_MESSAGE},
]

_NOT_A_NAME = [
    "ok then take a message, i need someone to call me back about hardened container images",
    "call me back",
    "call me later",
    "call me tomorrow",
    "call me asap",
    "call me on this number",
    "call me at 5pm",
    "please call me back regarding the quote",
    "can someone call me when you are free",
    "call me again",
    "call me now",
    "call me soon please",
    "call me tonight",
    "call me urgently",
    "call me if you can",
    "my name is not eva",
    "i'm not eva",
    "its not eva",
    "it's not Eva",
    "i am not the owner",
    "im looking for a quote",
    "i'm interested in your plans",
    "this is regarding my order",
    "i'm here",
    "it's about my invoice",
    "i'm just browsing",
    "this is for my team",
    "i'm with the finance team",
]


class TestPhrasesAreNotNames:
    @pytest.mark.parametrize("question", _NOT_A_NAME)
    def test_a_first_capture_takes_no_name(self, question):
        assert _extract_name_change(question) is None
        assert _extract_visitor_name(question, []) is None
        assert _extract_visitor_name(question, _ASKED) is None

    @pytest.mark.parametrize("question", _NOT_A_NAME)
    def test_a_stored_name_is_not_replaced(self, question):
        assert _extract_explicit_rename(question, "Eva") is None

    @pytest.mark.parametrize(
        "reply",
        [
            "not now",
            "call me later",
            "later please",
            "back soon",
            "on my way",
            "i'm fine",
            "it's me",
            "hmm",
            "hmmmm",
            "lol",
        ],
    )
    def test_a_bare_reply_to_the_name_question_takes_no_name(self, reply):
        assert _extract_visitor_name(reply, _ASKED) is None

    @pytest.mark.parametrize("raw", ["Back About", "Not Eva", "Priya Not", "Call Later", "About Pricing"])
    def test_a_candidate_with_a_non_name_word_is_rejected(self, raw):
        assert _clean_visitor_name(raw) is None


class TestRealNamesStillWork:
    @pytest.mark.parametrize(
        ("question", "expected"),
        [
            ("call me Priya", "Priya"),
            ("i'm Sarah Khan", "Sarah Khan"),
            ("my name is Noor", "Noor"),
            ("My name's Priya", "Priya"),
            ("you can call me Max", "Max"),
            ("this is Priya", "Priya"),
            ("i am alex", "Alex"),
            ("call me Sam please", "Sam"),
            ("my name is priya and i need pricing", "Priya"),
            ("Hi, this is Priya from Acme", "Priya"),
            ("I'm Arjun, calling about pricing", "Arjun"),
            # Given names that are also English words stay out of the list.
            ("i'm Will", "Will"),
            ("my name is May", "May"),
            ("call me Hope", "Hope"),
            ("this is Grace", "Grace"),
            ("i'm Don", "Don"),
            ("this is Sam from the legal team", "Sam"),
            # A name outside ASCII is kept whole, not cut at its first accent
            # ("José" used to be stored as "Jos").
            ("my name is José", "José"),
            ("i'm Zoë", "Zoë"),
            ("call me Chloé please", "Chloé"),
            ("my name is Müller", "Müller"),
            ("my name is प्रिया", "प्रिया"),
        ],
    )
    def test_an_intro_captures_the_name(self, question, expected):
        assert _extract_visitor_name(question, []) == expected
        assert _extract_name_change(question) == expected

    @pytest.mark.parametrize(
        ("reply", "expected"),
        [("Priya", "Priya"), ("sarah khan", "Sarah Khan"), ("Rahul!", "Rahul"), ("José", "José"), ("zoë", "Zoë")],
    )
    def test_a_bare_reply_to_the_name_question_is_captured(self, reply, expected):
        assert _extract_visitor_name(reply, _ASKED) == expected

    def test_a_lowercase_copula_intro_does_not_keep_a_word_before_a_function_word(self):
        # "looking" is not a name; only a capitalised first word or an explicit
        # "my name is" / "call me" earns the benefit of the doubt.
        assert _extract_visitor_name("im looking for pricing", []) is None


class TestSentenceBreaks:
    def test_a_full_stop_after_the_name_ends_it(self):
        assert _clean_visitor_name("priya. typo") == "Priya"

    @pytest.mark.parametrize("raw", ["J.R. Smith", "J. Smith", "Dr. Mehta"])
    def test_initials_and_titles_keep_their_full_stop(self, raw):
        assert _clean_visitor_name(raw) == raw


_CORRECTIONS = [
    "actually my name is not eva, its priya. typo earlier",
    "my name is not Eva, it's Priya",
    "my name isn't Eva, it's Priya",
    "not eva, i'm priya",
    "no not Eva, I'm Priya",
    "actually it's Priya",
    "actually its priya",
    "sorry my name is Priya not Eva",
    "it's Priya, not Eva",
    "call me Priya, not Eva",
]


class TestCorrections:
    @pytest.mark.parametrize("question", [*_CORRECTIONS, "i'm priya not eva"])
    def test_a_correction_replaces_the_stored_name(self, question):
        assert _extract_explicit_rename(question, "Eva") == "Priya"

    @pytest.mark.parametrize("question", _CORRECTIONS)
    def test_a_correction_names_a_visitor_with_no_stored_name(self, question):
        assert _extract_name_change(question) == "Priya"

    def test_a_bare_contrast_names_no_one_without_a_stored_name(self):
        # With no name on file, "i'm priya not eva" has the shape of "i'm happy
        # not sad" and nothing to correct, so neither is taken as a name.
        assert _extract_name_change("i'm happy not sad") is None
        assert _extract_name_change("i'm priya not eva") is None

    @pytest.mark.parametrize(
        "question",
        [
            "I'm the engineering manager and I own this decision",
            "it's not the price, it's the setup",
            "it's not working, it's broken",
            "not really, i'm just looking",
            "its cheap not expensive",
            "it's not a bug, it's cloudflare",
            "i'm not eva",
            "not eva",
            "no, it's fine",
            "i'm Priya",
        ],
    )
    def test_anything_else_leaves_a_stored_name_alone(self, question):
        assert _extract_explicit_rename(question, "Eva") is None

    def test_the_flow_stores_the_corrected_name(self):
        lead = SimpleNamespace(name="Eva")
        with (
            patch.object(rag_service, "get_lead_info_by_session", return_value=lead),
            patch.object(rag_service, "get_chat_history", return_value=[]),
            patch.object(rag_service, "create_or_update_lead_info") as save,
        ):
            ask, deferred, name, just_named = rag_service.resolve_name_flow(
                MagicMock(), "s1", 3, 9, "actually my name is not eva, its priya. typo earlier", company_name="Acme"
            )
        assert (ask, deferred, name, just_named) == (None, None, "Priya", True)
        assert save.call_args.kwargs["name"] == "Priya"

    def test_the_flow_keeps_the_name_on_a_callback_request(self):
        lead = SimpleNamespace(name="Eva")
        with (
            patch.object(rag_service, "get_lead_info_by_session", return_value=lead),
            patch.object(rag_service, "get_chat_history", return_value=[]),
            patch.object(rag_service, "create_or_update_lead_info") as save,
        ):
            result = rag_service.resolve_name_flow(MagicMock(), "s1", 3, 9, _NOT_A_NAME[0], company_name="Acme")
        assert result == (None, None, "Eva", False)
        save.assert_not_called()

    def test_the_flow_captures_nothing_from_a_callback_request_after_the_name_question(self):
        with (
            patch.object(rag_service, "get_lead_info_by_session", return_value=None),
            patch.object(rag_service, "get_chat_history", return_value=_ASKED),
            patch.object(rag_service, "create_or_update_lead_info") as save,
        ):
            ask, _deferred, name, just_named = rag_service.resolve_name_flow(
                MagicMock(), "s1", 3, 9, _NOT_A_NAME[0], company_name="Acme"
            )
        assert ask is None and name is None and just_named is False
        save.assert_not_called()


@pytest.mark.parametrize(
    "question",
    [
        "actually" + " " * 20000 + "x",
        "fix" + " " * 20000 + "x",
        "rename" + "!" * 20000 + "x",
        "not eva" + " " * 20000 + "x",
        "my name is not " * 1400,
        "i'm " + "a" * 20000,
        "call me " * 2500,
        "not " * 5000,
        "sorry my name is priya not " * 700,
        "not " + "प्रिया" * 3000 + "!",
        "my name is " + "é" * 20000,
        "i'm " + "á" * 10000 + "1",
    ],
)
def test_extraction_stays_linear_on_long_input(question):
    started = time.perf_counter()
    _extract_name_change(question)
    _extract_explicit_rename(question, "Eva")
    _extract_visitor_name(question, _ASKED)
    assert time.perf_counter() - started < 0.5
