"""Probe continuity: human-feeling BANT follow-ups that never re-ask.

Regression tests for the "asked TIMELINE three times in a row" loop. The bot
used to pick ``missing_dims[0]`` every turn purely from stored scores, which
lag behind the async extractor — so a dimension the visitor already answered
kept getting re-asked (with only its wording rotated) until the score finally
landed. These pin the three mechanisms that fix it:

1. ``select_next_probe_dimension`` skips the dimension probed last turn.
2. The extractor is handed a "question frame" so a terse reply ("2 months")
   binds to the dimension actually asked instead of being dropped.
3. ``build_hybrid_prompt`` no longer forces a verbatim canned question and
   instructs a human reflection beat.
"""

from unittest.mock import MagicMock, patch

import app.services.rag_service as rag
from app.services.qualification_service import (
    get_framework_config,
    select_next_probe_dimension,
)
from app.services.rag_service import (
    _is_low_intent_message,
    _looks_like_answer,
    _probe_question_for,
    _should_probe_this_turn,
    _should_skip_bant_extraction,
    build_hybrid_prompt,
    extract_qualification_signals,
    resolve_name_flow,
)


def _hist(*turns):
    return [{"role": r, "content": c} for r, c in turns]


BANT = get_framework_config(None)  # default BANT preset
# BANT conversation order is need -> timeline -> authority -> budget.


class TestSelectNextProbeDimension:
    def test_first_open_dimension_when_nothing_scored(self):
        state = {"need_score": 0, "timeline_score": 0, "authority_score": 0, "budget_score": 0}
        nxt, missing = select_next_probe_dimension(state, BANT, recently_probed=[])
        assert nxt == "need"
        assert missing == ["need", "timeline", "authority", "budget"]

    def test_advances_past_a_scored_dimension(self):
        # need cleared (>=60% of 25 == 15) -> next open is timeline.
        state = {"need_score": 15, "timeline_score": 0, "authority_score": 0, "budget_score": 0}
        nxt, _ = select_next_probe_dimension(state, BANT, recently_probed=[])
        assert nxt == "timeline"

    def test_skips_dimension_probed_last_turn(self):
        """The core fix: timeline is still unscored (async extraction lagging),
        but we asked it last turn — do NOT re-ask it, move to authority."""
        state = {"need_score": 15, "timeline_score": 0, "authority_score": 0, "budget_score": 0}
        nxt, _ = select_next_probe_dimension(state, BANT, recently_probed=["timeline"])
        assert nxt == "authority"

    def test_returns_none_when_only_open_dim_was_just_probed(self):
        """Everything else is scored and the one open dimension is the one we
        just asked -> ask nothing this turn (circle back later) rather than
        hammer the same question."""
        state = {"need_score": 20, "timeline_score": 0, "authority_score": 20, "budget_score": 20}
        nxt, _ = select_next_probe_dimension(state, BANT, recently_probed=["timeline"])
        assert nxt is None

    def test_dimension_becomes_eligible_again_once_not_recent(self):
        """A beat later (last_probed cleared), the still-open dimension is
        eligible again — natural 'ask, breathe, revisit' rhythm."""
        state = {"need_score": 20, "timeline_score": 0, "authority_score": 20, "budget_score": 20}
        nxt, _ = select_next_probe_dimension(state, BANT, recently_probed=[])
        assert nxt == "timeline"

    def test_none_when_all_dimensions_assessed(self):
        state = {"need_score": 20, "timeline_score": 20, "authority_score": 20, "budget_score": 20}
        nxt, missing = select_next_probe_dimension(state, BANT, recently_probed=[])
        assert nxt is None
        assert missing == []

    def test_replays_the_reported_transcript_without_repeats(self):
        """Walk the actual screenshot flow. Even with the extractor lagging by a
        turn, timeline is asked at most once before we advance — the loop is
        structurally impossible now."""
        asked = []
        # Turn 1: visitor states pain; need not yet scored.
        state = {"need_score": 0, "timeline_score": 0, "authority_score": 0, "budget_score": 0}
        nxt, _ = select_next_probe_dimension(state, BANT, recently_probed=[a for a in asked[-1:]])
        asked.append(nxt)  # need
        # Turn 2: need landed; ask timeline.
        state["need_score"] = 15
        nxt, _ = select_next_probe_dimension(state, BANT, recently_probed=asked[-1:])
        asked.append(nxt)  # timeline
        # Turn 3: timeline score still lagging (0), but we asked it last turn.
        nxt, _ = select_next_probe_dimension(state, BANT, recently_probed=asked[-1:])
        asked.append(nxt)  # authority, NOT timeline again
        assert asked == ["need", "timeline", "authority"]
        assert asked.count("timeline") == 1

    def test_respects_disabled_dimension(self):
        cfg = get_framework_config(None)
        cfg["timeline"] = {**cfg["timeline"], "enabled": False}
        state = {"need_score": 15, "timeline_score": 0, "authority_score": 0, "budget_score": 0}
        nxt, missing = select_next_probe_dimension(state, cfg, recently_probed=[])
        assert "timeline" not in missing
        assert nxt == "authority"


class TestBuildHybridPromptHumanProbe:
    def _build(self, state, recently_probed):
        system, user = build_hybrid_prompt(
            None,
            "when can we go live?",
            "context",
            "earlier conversation history",  # non-empty -> has_prior_turns branch
            bant_state=state,
            bant_enabled=True,
            bant_config=BANT,
            company_name="Acme",  # set so client.name is never dereferenced
            bot_name="Acme Bot",
            recently_probed=recently_probed,
        )
        return system + "\n" + user

    def test_probes_the_deduped_dimension(self):
        # timeline unscored but just probed -> prompt should target AUTHORITY.
        state = {"need_score": 15, "timeline_score": 0, "authority_score": 0, "budget_score": 0}
        prompt = self._build(state, recently_probed=["timeline"])
        assert "AUTHORITY" in prompt

    def test_drops_the_verbatim_mandate(self):
        state = {"need_score": 15, "timeline_score": 0, "authority_score": 0, "budget_score": 0}
        prompt = self._build(state, recently_probed=[])
        # The old robotic instruction is gone...
        assert "word for word" not in prompt
        assert "EXACTLY this question" not in prompt
        # ...replaced with human-reflection guidance.
        assert "reflect" in prompt.lower()

    def test_no_probe_instruction_when_deduped_to_nothing(self):
        state = {"need_score": 20, "timeline_score": 0, "authority_score": 20, "budget_score": 20}
        prompt = self._build(state, recently_probed=["timeline"])
        assert "Do NOT ask a qualifying question this turn" in prompt


class TestExtractorAnswerBinding:
    def _run_capture_prompt(self, last_probed_dimension):
        """Invoke the extractor with litellm mocked, return the prompt text sent."""
        with patch("app.services.rag_service.litellm") as mock_litellm:
            mock_response = MagicMock()
            mock_response.choices = [MagicMock()]
            mock_response.choices[0].message.content = '{"signals": []}'
            mock_litellm.completion.return_value = mock_response
            extract_qualification_signals(
                "history",
                "2 months",
                "When are you hoping to go live?",
                {"timeline_score": 0},
                BANT,
                last_probed_dimension=last_probed_dimension,
            )
            # The extraction prompt is the user message content.
            messages = mock_litellm.completion.call_args.kwargs["messages"]
            return messages[-1]["content"]

    def test_injects_question_frame_for_probed_dimension(self):
        prompt = self._run_capture_prompt("timeline")
        assert "QUESTION FRAME" in prompt
        assert "TIMELINE" in prompt

    def test_no_frame_when_nothing_was_probed(self):
        prompt = self._run_capture_prompt(None)
        assert "QUESTION FRAME" not in prompt


class TestSkipGateTerseProbeReplies:
    """A terse reply to a probe ("2 months", "5k") must reach the extractor.
    Without a probe in flight it is still dropped on length to save cost."""

    def test_short_message_skipped_when_not_a_probe_reply(self):
        assert _should_skip_bant_extraction("2 months", {}, BANT, is_probe_reply=False) is True

    def test_short_message_allowed_when_probe_reply(self):
        assert _should_skip_bant_extraction("2 months", {}, BANT, is_probe_reply=True) is False

    def test_one_char_still_skipped_even_as_probe_reply(self):
        assert _should_skip_bant_extraction("x", {}, BANT, is_probe_reply=True) is True

    def test_handoff_request_still_skipped_as_probe_reply(self):
        # Routing requests must never be mistaken for a qualification signal.
        assert _should_skip_bant_extraction("talk to a human", {}, BANT, is_probe_reply=True) is True


class TestNameGateRecoversDeferredQuestion:
    """First name capture phrased as "I'm Alex" used to hit the rename branch,
    which skipped deferred-question recovery — so the opening pain statement
    never reached BANT extraction. It must now replay the deferred question."""

    def _run(self, question, known_name, deferred):
        lead = None if known_name is None else type("L", (), {"name": known_name})()
        with (
            patch.object(rag, "get_lead_info_by_session", return_value=lead),
            patch.object(rag, "get_chat_history", return_value=["<name-ask>", "<pain>"]),
            patch.object(rag, "_extract_name_change", return_value="Alex"),
            patch.object(rag, "create_or_update_lead_info"),
            patch.object(rag, "_recover_deferred_question", return_value=deferred),
            patch.object(rag, "route_intent", return_value=None),
        ):
            return resolve_name_flow(MagicMock(), "sess-1", 1, 1, question, company_name="Acme")

    def test_first_capture_replays_deferred_pain(self):
        ask, deferred_q, name, just = self._run("I'm Alex", known_name=None, deferred="our team is drowning in leads")
        assert ask is None
        assert deferred_q == "our team is drowning in leads"  # replayed for answer + extraction
        assert name == "Alex"
        assert just is True

    def test_midchat_rename_does_not_replay(self):
        # A genuine rename (name already known) has nothing deferred to replay.
        ask, deferred_q, name, just = self._run("call me Alex", known_name="Bob", deferred="something old")
        assert deferred_q is None
        assert name == "Alex"
        assert just is True


class TestProbeQuestionFor:
    """Deterministic follow-up appended on media-card turns, where the model
    reliably drops the qualification question."""

    def test_returns_a_question_for_a_dimension(self):
        q = _probe_question_for("timeline", BANT, seed_text="anything", avoid_text="")
        assert q and q.strip().endswith("?")

    def test_none_without_dimension(self):
        assert _probe_question_for(None, BANT) is None

    def test_none_without_config(self):
        assert _probe_question_for("timeline", None) is None

    def test_avoids_the_wording_already_shown(self):
        # Given every other variant in the avoid-set, it must not return one of them.
        variants = [
            "When are you looking to get started?",
            "What's your timeline looking like?",
            "How soon are you hoping to move on this?",
        ]
        q = _probe_question_for("timeline", BANT, seed_text="x", avoid_text=" ".join(variants))
        assert q not in variants


class TestAnswerBindingGuardrail:
    """The extractor only binds a terse message to the probed dimension when it
    reads like an ANSWER. A product question must NOT be force-fit into a
    dimension (bug: "how would you implement clean libraries" scored
    Need="Just browsing"). This pins the ``_looks_like_answer`` gate the binding
    hint now depends on."""

    def test_product_question_is_not_an_answer(self):
        assert _looks_like_answer("how would u implement clean libraries in any system") is False

    def test_bare_interrogative_is_not_an_answer(self):
        assert _looks_like_answer("what is clean libraries") is False

    def test_trailing_question_mark_is_not_an_answer(self):
        assert _looks_like_answer("clean libraries?") is False

    def test_terse_real_answer_still_binds(self):
        assert _looks_like_answer("around 2 months") is True
        assert _looks_like_answer("i make the call for my team") is True


class TestBuildUpGate:
    """BANT must build up, not be fired at every visitor. Never qualify a
    browsing visitor, and never lead with a probe — hold it until the bot has
    given at least one real answer."""

    def test_low_intent_phrases_detected(self):
        for m in ["just killing time tbh", "just looking around really", "nah im good, just browsing"]:
            assert _is_low_intent_message(m) is True

    def test_genuine_message_not_low_intent(self):
        # "not sure" alone must not trip it — it's often part of a real question.
        assert _is_low_intent_message("not sure if you support SSO") is False
        assert _is_low_intent_message("our images keep going stale") is False

    def test_browsing_visitor_is_never_probed(self):
        history = _hist(
            ("user", "hi"),
            ("bot", "name?"),
            ("user", "steve"),
            ("bot", "hi steve"),
            ("user", "what is this"),
            ("bot", "..."),
            ("user", "just looking around"),
        )
        assert _should_probe_this_turn("just looking around", history) is False

    def test_no_probe_on_first_substantive_turn(self):
        # Lead with value: the opening real message is answered, not interrogated.
        history = _hist(
            ("user", "hi"),
            ("bot", "name?"),
            ("user", "jason"),
            ("bot", "hi jason"),
            ("user", "our production keeps shipping outdated container images"),
        )
        assert _should_probe_this_turn("our production keeps shipping outdated container images", history) is False

    def test_probe_from_second_substantive_turn(self):
        history = _hist(
            ("user", "hi"),
            ("bot", "name?"),
            ("user", "jason"),
            ("bot", "hi jason"),
            ("user", "our production keeps shipping outdated container images"),
            ("bot", "..."),
            ("user", "we need this live this month"),
        )
        assert _should_probe_this_turn("we need this live this month", history) is True

    def test_prompt_suppresses_probe_when_gate_off(self):
        state = {"need_score": 0, "timeline_score": 0, "authority_score": 0, "budget_score": 0}
        system, user = build_hybrid_prompt(
            None,
            "just looking around",
            "context",
            "some history",
            bant_state=state,
            bant_enabled=True,
            bant_config=BANT,
            company_name="Acme",
            bot_name="Acme Bot",
            probe_ok=False,
        )
        assert "Do NOT ask a qualifying question this turn" in (system + user)
