"""Naming the company is an on-scope signal. Naming its first word is not.

``_question_is_clearly_on_scope`` decides whether a turn the relevance judge
rejected still reaches the model. It matched the first word of the company
name, so a bot called "The Coding School" treated every question containing
"the" as on scope and the gate was switched off for it.
"""

from __future__ import annotations

import pytest

from app.services.rag_service import _question_is_clearly_on_scope


class TestAStopwordInTheCompanyNameIsNotASignal:
    @pytest.mark.parametrize(
        ("company", "question"),
        [
            ("The Coding School", "what is the capital of france"),
            ("My Fitness Lab", "what is my horoscope for today"),
            ("A Plus Tutors", "write a poem about the sea"),
            ("Go Digital", "where should i go on holiday"),
            ("One Stop Shop", "which one is bigger, the sun or the moon"),
        ],
    )
    def test_an_off_topic_question_stays_off_scope(self, company, question):
        assert _question_is_clearly_on_scope(question, company) is False


class TestNamingTheCompanyStillCounts:
    @pytest.mark.parametrize(
        ("company", "question"),
        [
            ("The Coding School", "does the coding school teach python"),
            ("The Coding School", "what does Coding School offer"),
            ("Acme", "what does acme do"),
            ("My Fitness Lab", "is fitness lab open on sundays"),
            ("CleanStart Pvt Ltd", "what is cleanstart"),
        ],
    )
    def test_a_distinctive_word_of_the_name_is_enough(self, company, question):
        assert _question_is_clearly_on_scope(question, company) is True

    def test_a_business_suffix_alone_is_not_enough(self):
        assert _question_is_clearly_on_scope("is that ltd or plc", "CleanStart Pvt Ltd") is False
