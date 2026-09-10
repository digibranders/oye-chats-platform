"""Two failure modes seen in a real-model run against a live bot on 2026-09-09.

Both are the model narrating the conversation instead of answering it:

* it opened a reply with "Doing well, Eva." when nobody had asked how it was;
* it opened the services answer with "You already mentioned them, but here's
  the full list again", crediting the visitor with a list the bot itself had
  given a turn earlier.

The first slipped through because OPENING banned a list of phrases and the
model read the list as exhaustive. The second was taught by the prompt: the
continuity example was literally "Since you mentioned...", so the model reached
for that phrasing for anything already in the transcript, its own words
included.
"""

from __future__ import annotations

from app.services.response_style import RESPONSE_STYLE_BLOCK


class TestTheOpeningRuleIsAPrincipleNotABlocklist:
    def test_it_forbids_answering_an_unasked_question(self):
        assert "never open by answering a" in RESPONSE_STYLE_BLOCK
        assert "question the visitor did not ask" in RESPONSE_STYLE_BLOCK

    def test_it_says_the_banned_list_is_illustrative(self):
        assert "illustrative, not exhaustive" in RESPONSE_STYLE_BLOCK

    def test_it_names_the_social_filler_that_got_through(self):
        assert '"Doing well"' in RESPONSE_STYLE_BLOCK


class TestContinuityAttributesCorrectly:
    def test_you_mentioned_is_reserved_for_the_visitor(self):
        assert '"You mentioned" and' in RESPONSE_STYLE_BLOCK
        assert "refer ONLY to the visitor's own words" in RESPONSE_STYLE_BLOCK

    def test_the_bots_own_words_stay_the_bots(self):
        assert "Anything" in RESPONSE_STYLE_BLOCK
        assert "you told them earlier is yours, never theirs." in RESPONSE_STYLE_BLOCK

    def test_a_repeat_is_answered_not_narrated(self):
        assert "Do not narrate that it is a" in RESPONSE_STYLE_BLOCK


class TestTheProbeReflectionIsOptional:
    """The actual source of both artifacts.

    `build_hybrid_prompt` tells the model to open a probing reply by reflecting
    back something concrete the visitor said. In the branch used once the
    conversation is underway that instruction read as unconditional, so when
    the visitor's last message carried nothing to reflect (their name, in the
    observed case) the model invented one. Making the reflection explicitly
    skippable is the fix; without it the response-style rules above are
    outvoted by a more specific instruction further down the prompt.
    """

    @staticmethod
    def _probe_rules() -> str:
        from pathlib import Path

        from app.services import rag_service

        return Path(rag_service.__file__).read_text(encoding="utf-8")

    def test_the_reflection_can_be_skipped(self):
        assert "THE REFLECTION IS OPTIONAL AND USUALLY WRONG" in self._probe_rules()

    def test_a_name_is_not_something_to_reflect(self):
        source = self._probe_rules()
        assert source.count("their name, or their contact details, there is NOTHING to reflect") == 1
        assert "their name or their contact details are NOT such a fact" in source

    def test_both_probe_branches_forbid_reflecting_the_bots_own_words(self):
        assert self._probe_rules().count("NEVER reflect something YOU said.") == 2


class TestCannedCopyPunctuatesItsQuestions:
    """Two shipped lines asked a question and ended it with a full stop:
    "What brings you here today." in the off-topic refusals, and "What would
    you like to know." in the name acknowledgement. Visitors read that as the
    bot trailing off. It also teaches the model the pattern, which then showed
    up in generated replies during a real-model run.
    """

    _OPENERS = ("what", "who", "when", "where", "why", "which", "how", "would", "are", "do", "can")

    @classmethod
    def _sentences(cls, text: str) -> list[str]:
        import re

        return [part.strip() for part in re.split(r"(?<=[.?!])\s+", text) if part.strip()]

    def _assert_questions_end_in_a_question_mark(self, text: str) -> None:
        for sentence in self._sentences(text):
            first = sentence.split(" ", 1)[0].strip("*_").lower()
            if first in self._OPENERS:
                assert sentence.endswith("?"), f"asks a question but ends with {sentence[-1]!r}: {sentence}"

    def test_every_off_topic_refusal_variant(self):
        from app.services.rag_service import OFF_TOPIC_REFUSAL_VARIANTS

        for variant in OFF_TOPIC_REFUSAL_VARIANTS:
            self._assert_questions_end_in_a_question_mark(variant.format(company_name="Acme"))

    def test_the_name_acknowledgement(self):
        from app.services.rag_service import _name_ack_message

        self._assert_questions_end_in_a_question_mark(_name_ack_message("Eva", "Acme"))
        self._assert_questions_end_in_a_question_mark(_name_ack_message("Eva", None))


class TestComparisonsAreBulletsNotTables:
    """The widget renders markdown through react-markdown with no remark-gfm,
    so a table the prompt asked for reaches the visitor as pipe-separated
    text. The comparison rule asks for bullets instead."""

    def test_no_instruction_mentions_a_table(self):
        import re

        assert not re.search(r"\btables?\b", RESPONSE_STYLE_BLOCK, re.IGNORECASE)

    def test_the_comparison_rule_asks_for_one_bullet_per_option(self):
        assert "one bullet per option" in RESPONSE_STYLE_BLOCK
        assert "bold the option name" in RESPONSE_STYLE_BLOCK
