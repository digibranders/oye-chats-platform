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

from app.db.models import ChatSession
from app.db.repository import add_chat_message
from app.services import rag_service as rs
from app.services.qualification_service import get_framework_config
from tests.test_rag_pipeline_defects import (
    _answer_text,
    _doc,
    _drive_stream,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)

BANT = get_framework_config(None)
_CARD = {"type": "download", "url": "https://acme.com/files/Cloud-Workloads.pdf", "name": "Cloud-Workloads.pdf"}
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
            # Review 2026-09-30: a fact about the past is not when they want to start.
            "we've been in business 10 years",
            "we signed up 3 months ago",
            "our team has 5 years of experience with SIEM tools",
            "we have used another vendor for the last 2 years",
            "our company is 12 years old",
            "we are on a 12 month contract with them",
            # A conditional or a hypothetical states nothing.
            "if we cancel after 6 months do we get any refund?",
            "suppose we start next month, is there a discount",
            "in case we need it live in 2 weeks, is that possible",
            "once we cross 12 months the price changes, right",
            "assuming we sign this quarter, who onboards us",
        ],
    )
    def test_a_past_fact_or_a_hypothetical_is_not_a_timeline(self, text):
        assert rs._current_turn_states_dimension(text, "timeline") is None

    def test_a_timeline_beside_a_past_fact_is_still_read(self):
        text = "we've been in business 10 years and want this live in 3 months"
        assert rs._current_turn_states_dimension(text, "timeline")

    @pytest.mark.parametrize(
        "text",
        [
            "i am looking for a SOC provider for my company",
            "I'm looking for a tool for our team",
            "i'm checking this for the website we run",
            "I am scoping a project for a bank",
        ],
    )
    def test_shopping_for_the_company_is_not_an_authority_statement(self, text):
        assert rs._current_turn_states_dimension(text, "authority") is None

    @pytest.mark.parametrize(
        "text",
        [
            "I'm just asking on behalf of our CTO",
            "I'm looking into this for a client",
            "I'm gathering options for someone else",
        ],
    )
    def test_researching_for_a_person_is_an_authority_statement(self, text):
        assert rs._current_turn_states_dimension(text, "authority")

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


class TestTheCallerAndThePromptShareOneState:
    """Review 2026-09-30: the prompt builder merged what the current message
    states into its own copy of the state, while the pipeline picked the
    dimension it persists from the untouched one. So the prompt asked about one
    dimension and the session recorded another as asked."""

    def test_the_merge_fills_only_open_dimensions(self):
        state = {**_NEED_KNOWN, "authority": "CTO", "authority_score": 20}
        merged, stated = rs._state_with_current_turn(state, "I'm the founder, we want to start in about 3 months", BANT)

        assert stated == {"timeline": "I'm the founder, we want to start in about 3 months"}
        assert merged["timeline"] == stated["timeline"]
        assert merged["authority"] == "CTO"
        assert state.get("timeline") is None, "the stored state is never written to"

    def test_nothing_stated_returns_the_state_as_it_was(self):
        state = dict(_NEED_KNOWN)
        merged, stated = rs._state_with_current_turn(state, "do you cover AWS workloads too?", BANT)

        assert stated == {}
        assert merged == state

    def test_the_prompt_asks_the_dimension_the_selector_picks_from_the_merged_state(self):
        merged, stated = rs._state_with_current_turn(dict(_NEED_KNOWN), "about 3 months", BANT)
        picked, _missing = rs.select_next_probe_dimension(merged, BANT)
        prompt = _prompt("about 3 months", merged, stated_now=stated)

        assert picked == "authority"
        assert _asks_about(prompt, "authority")
        assert "Timeline: about 3 months (stated in the visitor's latest message; not yet scored)" in prompt

    def test_a_prompt_built_without_the_merge_still_reads_the_current_message(self):
        prompt = _prompt("about 3 months", dict(_NEED_KNOWN))

        assert "Timeline: about 3 months (stated in the visitor's latest message; not yet scored)" in prompt
        assert _asks_about(prompt, "authority")


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


class TestThePromptAndTheSessionAgree:
    """What the prompt asks about is what the session records as asked."""

    async def _turn(
        self, db, monkeypatch, session_id: str, question: str, *, card: dict | None = None, **session_kwargs
    ):
        client = _make_client(db)
        bot = _make_bot(db, client, bant_enabled=True)
        _make_session(db, bot, client, session_id, bant_need="SOC monitoring", bant_need_score=20, **session_kwargs)
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
            retrieved=(_doc("Acme covers cloud workloads on AWS and Azure. Cancel any time."),),
            chunks=("Yes, we cover that.",),
        )
        monkeypatch.setattr(rs, "_topical_media_card", lambda *_a, **_k: card)
        if card:
            catalog = [{"files": [{"url": card["url"], "name": card["name"]}]}]
            monkeypatch.setattr(rs, "get_bot_media_urls", lambda *_a, **_k: catalog)
        frames = await _drive_stream(bot, question, session_id)
        assert len(cap["prompts"]) == 1
        db.expire_all()
        chat_session = db.query(ChatSession).filter(ChatSession.id == session_id).one()
        return cap["prompts"][0][1], chat_session, _answer_text(frames)

    @staticmethod
    def _asked(chat_session) -> set[str]:
        prefix = rs._PROBE_ASKED_PREFIX
        return {key[len(prefix) :] for key in (chat_session.inline_cards_shown or {}) if key.startswith(prefix)}

    @pytest.mark.asyncio
    async def test_a_hypothetical_duration_leaves_both_on_the_timeline(self, db, monkeypatch):
        """The reviewed input: the prompt asked AUTHORITY, the session recorded timeline."""
        prompt, chat_session, _answer = await self._turn(
            db, monkeypatch, "sess-agree-refund", "if we cancel after 6 months do we get any refund?"
        )

        assert _asks_about(prompt, "timeline")
        assert not _asks_about(prompt, "authority")
        assert "Timeline: Not yet identified" in prompt
        assert chat_session.last_probed_dimension == "timeline"
        assert self._asked(chat_session) == {"timeline"}

    @pytest.mark.asyncio
    async def test_a_stated_timeline_moves_both_to_the_next_dimension(self, db, monkeypatch):
        prompt, chat_session, _answer = await self._turn(
            db, monkeypatch, "sess-agree-stated", "we want this live in about 3 months on our AWS workloads"
        )

        assert "(stated in the visitor's latest message; not yet scored)" in prompt
        assert _asks_about(prompt, "authority")
        assert not _asks_about(prompt, "timeline")
        assert chat_session.last_probed_dimension == "authority"
        assert self._asked(chat_session) == {"authority"}

    @pytest.mark.asyncio
    async def test_an_urgent_session_records_nothing_as_asked(self, db, monkeypatch):
        prompt, chat_session, _answer = await self._turn(
            db,
            monkeypatch,
            "sess-agree-urgent",
            "do you also cover cloud workloads?",
            inline_cards_shown={"urgent_notified": True},
        )

        assert "Do NOT ask a qualifying question this turn" in prompt
        assert chat_session.last_probed_dimension is None
        assert self._asked(chat_session) == set()

    @pytest.mark.asyncio
    async def test_a_recap_turn_records_nothing_as_asked(self, db, monkeypatch):
        prompt, chat_session, _answer = await self._turn(
            db, monkeypatch, "sess-agree-recap", "summarise this for my boss"
        )

        assert "Do NOT ask a qualifying question this turn" in prompt
        assert chat_session.last_probed_dimension is None
        assert self._asked(chat_session) == set()

    @pytest.mark.asyncio
    async def test_a_media_card_turn_still_gets_its_follow_up_question(self, db, monkeypatch):
        _prompt_text, chat_session, answer = await self._turn(
            db, monkeypatch, "sess-agree-card", "do you also cover cloud workloads?", card=dict(_CARD)
        )

        assert answer.rstrip().endswith("?"), answer
        assert chat_session.last_probed_dimension == "timeline"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("question", "session_kwargs"),
        [
            ("do you also cover cloud workloads?", {"inline_cards_shown": {"urgent_notified": True}}),
            ("summarise this for my boss", {}),
        ],
        ids=["urgent", "recap"],
    )
    async def test_a_media_card_turn_appends_no_question_on_an_urgent_or_recap_turn(
        self, db, monkeypatch, question, session_kwargs
    ):
        _prompt_text, chat_session, answer = await self._turn(
            db, monkeypatch, "sess-agree-card-hold", question, card=dict(_CARD), **session_kwargs
        )

        assert "?" not in answer, answer
        assert chat_session.last_probed_dimension is None
