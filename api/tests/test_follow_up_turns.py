"""What counts as a follow-up, a company question, and a finished refusal.

Reported from production on 2026-09-11:

* "tell me moer about " after a company overview was refused. The follow-up
  signals were an exact word list, so "moer" matched nothing, the query was
  never rewritten against the conversation, and the judge scored the raw words.
* "paid or unpaid? and is remote ok" after an internships answer, and
  "d'accord, et c'est disponible en France ?" after a product answer, carry no
  pronoun at all. Both are short and name nothing of their own.
* "whats ur MTTD and MTTR sla" on a managed SOC's bot and "how r u better than
  crowdstrike" on two bots were refused before generation. Both are about the
  company, and the second is a sales question.
* One refusal variant read "Bit outside my wheelhouse. I'm built for X
  questions. services, team, pricing, or anything about working together?",
  which the answer prompt itself bans, with a lowercase fragment for a question.

The pipeline behaviour is pinned in ``test_conversational_turns_pipeline.py``.
"""

from __future__ import annotations

import re
from types import SimpleNamespace

import pytest

from app.services import rag_service as rs


class TestAFollowUpIsRecognised:
    @pytest.mark.parametrize(
        "question",
        [
            # Asking for more, with the typos visitors actually type.
            "tell me moer about ",
            "tell me mroe",
            "mor info",
            "more abt it",
            "tell me more",
            "more info",
            "elaborate",
            "can you elaborate?",
            "explain",
            "go on",
            "continue",
            "details?",
            "and?",
            "what else",
            # A message that stops on its preposition.
            "tell me about",
            "what can you tell me regarding",
            "more on",
            # Short and elliptical: no pronoun, and no subject of its own.
            "paid or unpaid? and is remote ok",
            "d'accord, et c'est disponible en France ?",
            "how long?",
            # The existing signals still count.
            "tell me more about it",
            "how about pricing?",
            "who is he?",
        ],
    )
    def test_context_dependent_messages(self, question):
        assert rs._looks_like_follow_up(question) is True

    @pytest.mark.parametrize(
        "question",
        [
            "What's your price?",
            "Do you offer SEO services?",
            "office hours",
            # Put to the business, so about the business: the QA cache keeps it.
            "when do you open",
            "",
            "Can you walk me through how onboarding works for a two hundred person company?",
            "आपकी सेवाएं क्या हैं",
        ],
    )
    def test_standalone_messages(self, question):
        assert rs._looks_like_follow_up(question) is False

    def test_a_short_follow_up_is_never_served_from_or_written_to_the_qa_cache(self):
        """The QA cache is keyed on the words alone, so "paid or unpaid?" answered
        about internships in one conversation would be replayed about plans in
        another. The write side reads the same definition as the read side."""
        base = {"answer": "Yes, they are paid.", "visitor_name": None, "opener": "", "probe_active": False}
        assert not rs._answer_is_cacheable(**base, question="paid or unpaid? and is remote ok", prior_turns=True)
        assert not rs._answer_is_cacheable(**base, question="tell me moer about ", prior_turns=True)
        assert rs._answer_is_cacheable(**base, question="paid or unpaid? and is remote ok", prior_turns=False)


class TestAskingForMoreOfTheLastReply:
    @pytest.mark.parametrize(
        "question",
        [
            "tell me moer about ",
            "tell me mroe",
            "mor pls",
            "moar",
            "tell me more",
            "more info",
            "more details please",
            "elaborate",
            "can u elaborate on that",
            "explain",
            "explian more",
            "go on",
            "keep going",
            "continue",
            "details?",
            "and?",
            "what else",
            "anything else?",
            "tell me about",
            "what can you tell me regarding",
            "i'd like to know more about",
            "Tell me more abt it!",
        ],
    )
    def test_asks_for_more(self, question):
        assert rs._asks_for_more(question) is True

    @pytest.mark.parametrize(
        "question",
        [
            "tell me more about cricket",
            "who won ipl last season",
            "explain quantum physics",
            "and what is the capital of france",
            "tell me a joke",
            "i want to continue my subscription",
            "give me details of the ipl final",
            "what is more expensive, gold or silver",
            "mode",
            "store",
            "ok",
            "yes",
            "",
        ],
    )
    def test_does_not(self, question):
        assert rs._asks_for_more(question) is False

    def test_long_input_is_matched_in_linear_time(self):
        import time

        started = time.perf_counter()
        rs._asks_for_more("more " * 20000 + "about")
        rs._looks_like_follow_up("a" * 50000 + " about")
        assert time.perf_counter() - started < 2.0


class TestCompanyQuestionsAreOnScope:
    @pytest.mark.parametrize(
        "question",
        [
            "how r u better than crowdstrike",
            "why pick you over sentinelone",
            "crowdstrike vs you",
            "you vs crowdstrike?",
            "alternative to crowdstrike",
            "what makes you different from arctic wolf",
            "why should i choose you",
            "how do you compare to crowdstrike",
            "whats ur MTTD and MTTR sla",
            "are you gdpr compliant",
            "are u soc 2 certified",
            "what is your sla",
            "is your clinic better than apollo",
            "is your coffee better than starbucks",
            "do you comply with gdpr",
            "is your platform hipaa compliant",
            "are you licensed",
        ],
    )
    def test_on_scope(self, question):
        assert rs._question_is_clearly_on_scope(question, "Eventus Security") is True

    @pytest.mark.parametrize(
        "question",
        [
            "who won ipl last season",
            "can you compare python and java",
            "is crowdstrike better than sentinelone",
            "when was crowdstrike founded",
            "write me a python function to reverse a string",
            "what is the capital of france",
            "can you help me with my math homework",
            "what dose of paracetamol should i take",
            "can i sue my landlord for keeping my deposit",
            "is it legal to scrape linkedin under gdpr",
            "can you pick a movie for me",
            "can you explain what gdpr is",
            "who is the prime minister of india",
            "translate hello to french",
        ],
    )
    def test_still_off_scope(self, question):
        assert rs._question_is_clearly_on_scope(question, "Eventus Security") is False


_BANNED_REFUSAL_PHRASES = ("wheelhouse", "built for", "outside my lane")


class TestTheRefusalCopy:
    @pytest.mark.parametrize("template", rs.OFF_TOPIC_REFUSAL_VARIANTS + rs.OFF_TOPIC_ESCALATION_VARIANTS)
    def test_no_variant_uses_a_phrase_the_answer_prompt_bans(self, template):
        lowered = template.lower()
        assert not [phrase for phrase in _BANNED_REFUSAL_PHRASES if phrase in lowered], template

    @pytest.mark.parametrize("template", rs.OFF_TOPIC_REFUSAL_VARIANTS + rs.OFF_TOPIC_ESCALATION_VARIANTS)
    def test_every_sentence_starts_with_a_capital(self, template):
        rendered = template.format(company_name="Acme")
        for sentence in re.split(r"(?<=[.?!])\s+", rendered):
            assert sentence[:1].isupper(), f"{sentence!r} in {rendered!r}"

    @pytest.mark.parametrize("template", rs.OFF_TOPIC_REFUSAL_VARIANTS + rs.OFF_TOPIC_ESCALATION_VARIANTS)
    def test_no_dashes(self, template):
        assert "\u2014" not in template and "\u2013" not in template

    def test_the_broken_variant_is_a_complete_sentence(self):
        rendered = [template.format(company_name="Acme") for template in rs.OFF_TOPIC_REFUSAL_VARIANTS]
        assert (
            "That's beyond what I can help with here, but I know Acme well. "
            "Would you like to hear about our services, our team, pricing, or working together?"
        ) in rendered

    def test_the_pool_still_rotates(self):
        """Eight distinct openings, so two refusals in a row never read the same."""
        heads = {template.format(company_name="Acme")[:40] for template in rs.OFF_TOPIC_REFUSAL_VARIANTS}
        assert len(heads) == len(rs.OFF_TOPIC_REFUSAL_VARIANTS) == 8


class TestTheRewrite:
    def _history(self):
        return [
            SimpleNamespace(role="user", content="tell me about your company"),
            SimpleNamespace(role="bot", content="Eventus Security runs a 24x7 managed SOC."),
            SimpleNamespace(role="user", content="tell me moer about "),
        ]

    def test_a_typo_follow_up_is_rewritten_against_the_conversation(self, monkeypatch):
        prompts: list[str] = []
        monkeypatch.setattr(
            rs, "generate_response", lambda prompt, **_k: (prompts.append(prompt), "Eventus Security company")[1]
        )

        assert rs.rewrite_query("s", "tell me moer about ", self._history()) == "Eventus Security company"
        assert "Eventus Security runs a 24x7 managed SOC." in prompts[0]
        assert "unchanged" in prompts[0], "an unrelated new question must come back as it was asked"

    def test_a_standalone_question_costs_no_rewrite(self, monkeypatch):
        def boom(*_a, **_k):
            raise AssertionError("no rewrite for a standalone question")

        monkeypatch.setattr(rs, "generate_response", boom)
        question = "Can you walk me through how onboarding works for a two hundred person company?"
        assert rs.rewrite_query("s", question, self._history()) == question
