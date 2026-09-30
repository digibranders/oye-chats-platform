"""The qualification block reads the current message and stays out of urgent
and recap turns.

Production, 2026-09-28:

* y-e22-timeline-reply (CleanStart): the visitor said "about 3 months" and the
  prompt for that very turn still showed "Timeline: Not yet identified" and
  asked for a timeline, because the extractor runs on the ARQ worker after the
  reply. The block now checks the current message for the dimension it is
  about to ask, deterministically, and marks it in the state instead.
* x-urgent-do-you-handle (both bots): after an incident report the bot still
  appended "How urgent is this right now?", because the session's
  ``urgent_notified`` flag never reached the prompt.
* w-recap-for-boss (CleanStart): "summarise this for my boss" got a qualifying
  question. An incident or a recap is not a sales moment.
"""

import time
from types import SimpleNamespace

import pytest

from app.db.repository import add_chat_message
from app.services import rag_service as rs
from app.services.qualification_service import get_framework_config
from tests.test_rag_pipeline_defects import (
    _doc,
    _drive_stream,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)

BANT = get_framework_config(None)
_HISTORY = "user: we run a 40 person fintech and need SOC monitoring\nbot: We can cover that. When are you looking to get started?"
_NEED_KNOWN = {"need": "SOC monitoring", "need_score": 20}


def _prompt(question: str, state: dict, **kwargs) -> str:
    _system, user = rs.build_hybrid_prompt(
        SimpleNamespace(name="Acme"),
        question,
        "<<<DOCUMENT 1 | about.md>>>\nAcme runs a 24x7 SOC.\n<<<END DOCUMENT 1>>>\n",
        _HISTORY,
        bant_state=state,
        bant_enabled=True,
        bant_config=BANT,
        company_name="Acme",
        bot_name="Acme Bot",
        **kwargs,
    )
    return user


def _asks_about(prompt: str, dimension: str) -> bool:
    return f"**{dimension.upper()}**" in prompt


class TestCurrentMessageAnswersTheDimension:
    def test_a_stated_timeline_is_not_asked_and_shows_in_the_state(self):
        prompt = _prompt("about 3 months", dict(_NEED_KNOWN))

        assert not _asks_about(prompt, "timeline")
        assert "Timeline: Not yet identified" not in prompt
        assert "Timeline: about 3 months" in prompt

    def test_a_stated_budget_is_not_asked(self):
        state = {**_NEED_KNOWN, "timeline": "3 months", "timeline_score": 20, "authority": "CTO", "authority_score": 20}
        prompt = _prompt("we have around $5,000 per month for this", state)

        assert not _asks_about(prompt, "budget")
        assert "Budget: we have around $5,000 per month for this" in prompt

    def test_a_stated_role_is_not_asked(self):
        state = {**_NEED_KNOWN, "timeline": "3 months", "timeline_score": 20}
        prompt = _prompt("I'm the CTO and I make the call on this", state)

        assert not _asks_about(prompt, "authority")
        assert "Authority: I'm the CTO and I make the call on this" in prompt

    def test_the_stored_value_wins_over_the_current_message(self):
        state = {**_NEED_KNOWN, "timeline": "this month", "timeline_score": 25}
        prompt = _prompt("about 3 months", state)

        assert "Timeline: this month" in prompt

    def test_already_told_outranks_the_named_dimension(self):
        prompt = _prompt("about 3 months", dict(_NEED_KNOWN))
        rules = prompt.split("UNIVERSAL RULES:", 1)[1]

        assert rules.lstrip().startswith("- Never ask about something the visitor already told you")
        assert "outranks" in rules

    def test_a_normal_turn_still_probes(self):
        prompt = _prompt("do you cover AWS workloads too?", dict(_NEED_KNOWN))

        assert _asks_about(prompt, "timeline")
        assert "Timeline: Not yet identified" in prompt


class TestUrgentAndRecapTurnsAskNothing:
    def test_an_urgent_session_gets_no_qualifying_question(self):
        prompt = _prompt("do you handle ransomware recovery?", dict(_NEED_KNOWN), urgent_session=True)

        assert not any(_asks_about(prompt, d) for d in ("need", "timeline", "authority", "budget"))
        assert "Do NOT ask a qualifying question this turn" in prompt
        assert "urgent" in prompt.split("LEAD QUALIFICATION (this turn):", 1)[1].split("UNIVERSAL RULES:", 1)[0]
        assert "CTA MARKER" not in prompt

    def test_a_recap_turn_gets_no_qualifying_question(self):
        prompt = _prompt("summarise this for my boss", dict(_NEED_KNOWN), recap_turn=True)

        assert not any(_asks_about(prompt, d) for d in ("need", "timeline", "authority", "budget"))
        assert "Do NOT ask a qualifying question this turn" in prompt
        assert "CTA MARKER" not in prompt

    def test_a_normal_turn_is_unchanged_by_the_flags_at_their_defaults(self):
        prompt = _prompt("do you cover AWS workloads too?", dict(_NEED_KNOWN))
        assert _asks_about(prompt, "timeline")


class TestRecapTurnDetection:
    @pytest.mark.parametrize(
        "text",
        [
            "summarise this for my boss",
            "Can you summarize what we discussed so far?",
            "give me a quick recap of this conversation",
            "tl;dr",
            "sum it all up in a few lines I can forward to my manager",
        ],
    )
    def test_recap_requests(self, text):
        assert rs._is_recap_turn(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            "do you have a summary of your services?",
            "what does your SOC service include?",
            "about 3 months",
            "can you recap the pricing tiers on your website?",
        ],
    )
    def test_ordinary_questions(self, text):
        assert rs._is_recap_turn(text) is False


class TestStatedDimensionDetection:
    @pytest.mark.parametrize(
        "text",
        [
            "about 3 months",
            "within 2 weeks",
            "we want to start this quarter",
            "by March ideally",
            "next month",
            "asap",
            "no fixed timeline yet",
            "6 to 12 months",
            "we need this live in 3 months, can you do it?",
        ],
    )
    def test_timeline_statements(self, text):
        assert rs._current_turn_states_dimension(text, "timeline")

    @pytest.mark.parametrize(
        "text",
        [
            "do you offer 12 months of support?",
            "how long does onboarding take?",
            "what services do you offer",
        ],
    )
    def test_timeline_questions_do_not_count(self, text):
        assert rs._current_turn_states_dimension(text, "timeline") is None

    @pytest.mark.parametrize(
        "text",
        [
            "I'm the CTO",
            "I am the founder and I decide",
            "my boss makes the final call",
            "I'm researching for my manager",
        ],
    )
    def test_authority_statements(self, text):
        assert rs._current_turn_states_dimension(text, "authority")

    @pytest.mark.parametrize("text", ["who is your CEO?", "do I need a manager account?"])
    def test_authority_questions_do_not_count(self, text):
        assert rs._current_turn_states_dimension(text, "authority") is None

    @pytest.mark.parametrize("text", ["around $5,000 per month", "no budget yet", "our budget is EUR 2000 a month"])
    def test_budget_statements(self, text):
        assert rs._current_turn_states_dimension(text, "budget")

    def test_need_has_no_deterministic_detector(self):
        assert rs._current_turn_states_dimension("we need SOC monitoring", "need") is None

    def test_other_frameworks_map_by_dimension_kind(self):
        assert rs._current_turn_states_dimension("by March", "timing")
        assert rs._current_turn_states_dimension("I'm the CFO", "economic_buyer")
        assert rs._current_turn_states_dimension("around $5,000 per month", "money")


class TestTheDetectorsAreLinear:
    """The detectors run on the event loop on every qualifying turn. Review
    2026-09-30: 5,000 digits (the longest message the API accepts) held the
    timeline pattern for 0.30 s, a digit and a run of spaces for longer, and
    "i am looking" repeated held the authority pattern for a second."""

    @pytest.mark.parametrize(
        "text",
        [
            pytest.param("9" * 5000, id="digits"),
            pytest.param("1 " * 2500, id="spaced-digits"),
            pytest.param("3" + " " * 4998 + "x", id="digit-then-spaces"),
            pytest.param("3 to " * 1000, id="ranges"),
            pytest.param("a few " * 800, id="a-few"),
            pytest.param("by early " * 550, id="by-early"),
            pytest.param("no fixed " * 550, id="no-fixed"),
            pytest.param("i am looking " * 380, id="i-am-looking"),
            pytest.param("i'm researching for " * 250, id="researching-for"),
            pytest.param("my boss " * 600, id="my-boss"),
            pytest.param("the board makes the " * 250, id="the-board"),
            pytest.param("i'm the " * 600, id="im-the"),
            pytest.param("no budget is " * 380, id="no-budget"),
            pytest.param("budget " * 700, id="budget"),
            pytest.param("summarise " * 500, id="summarise"),
            pytest.param("sum it " * 700, id="sum-it"),
            pytest.param("everything we have " * 260, id="everything-we-have"),
        ],
    )
    @pytest.mark.parametrize("dimension", ["timeline", "authority", "budget"])
    def test_a_long_message_is_read_in_linear_time(self, text, dimension):
        started = time.perf_counter()
        rs._current_turn_states_dimension(text, dimension)
        rs._is_recap_turn(text)
        assert time.perf_counter() - started < 0.1

    def test_a_statement_at_the_start_of_a_long_message_is_still_read(self):
        assert rs._current_turn_states_dimension("about 3 months. " + "We run a fintech. " * 200, "timeline")

    @pytest.mark.parametrize(
        "text",
        [
            "within 18 months",
            "in 2 - 3 weeks",
            "6 to 12 months",
            "90 days",
            "3+ months",
            "two or three weeks",
            "a couple of months",
        ],
    )
    def test_bounded_numbers_still_read_as_a_timeline(self, text):
        assert rs._current_turn_states_dimension(text, "timeline")

    def test_a_long_number_is_not_a_timeline(self):
        assert rs._current_turn_states_dimension("order 20260930 days", "timeline") is None


class TestPipelinePassesTheSessionFlags:
    async def _prompt_for(self, db, monkeypatch, session_id: str, question: str, **session_kwargs) -> str:
        client = _make_client(db)
        bot = _make_bot(db, client, bant_enabled=True)
        _make_session(db, bot, client, session_id, **session_kwargs)
        # One real prior exchange, so the build-up gate lets the probe through.
        add_chat_message(
            db, session_id, client_id=client.id, role="user", content="what does your SOC cover", bot_id=bot.id
        )
        add_chat_message(
            db, session_id, client_id=client.id, role="bot", content="24x7 monitoring and response.", bot_id=bot.id
        )
        db.commit()
        cap = _stub_pipeline(
            monkeypatch,
            bant_enabled=True,
            support=True,
            retrieved=(_doc("Acme covers cloud workloads on AWS and Azure."),),
            chunks=("Yes, we cover cloud workloads.",),
        )
        await _drive_stream(bot, question, session_id)
        assert len(cap["prompts"]) == 1
        return cap["prompts"][0][1]

    @pytest.mark.asyncio
    async def test_an_urgent_session_reaches_the_prompt(self, db, monkeypatch):
        prompt = await self._prompt_for(
            db,
            monkeypatch,
            "sess-f22-urgent",
            "do you also cover cloud workloads?",
            inline_cards_shown={"urgent_notified": True},
        )
        assert "Do NOT ask a qualifying question this turn" in prompt
        assert not any(_asks_about(prompt, d) for d in ("need", "timeline", "authority", "budget"))

    @pytest.mark.asyncio
    async def test_a_recap_turn_reaches_the_prompt(self, db, monkeypatch):
        prompt = await self._prompt_for(db, monkeypatch, "sess-f22-recap", "summarise this for my boss")
        assert "Do NOT ask a qualifying question this turn" in prompt

    @pytest.mark.asyncio
    async def test_a_normal_turn_still_probes(self, db, monkeypatch):
        prompt = await self._prompt_for(db, monkeypatch, "sess-f22-normal", "do you also cover cloud workloads?")
        assert "Do NOT ask a qualifying question this turn" not in prompt
        assert any(_asks_about(prompt, d) for d in ("need", "timeline", "authority", "budget"))
