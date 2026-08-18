"""Tests for BR-02: deterministic qualification-CTA pill scoring.

Before this, tapping a qualification CTA pill just resent the button's label
as an ordinary chat message (``ChatWindow.jsx``'s ``onSelect`` called
``handleSend(null, option)``), so it was scored (if at all) by the same
probabilistic free-text LLM extraction as anything a visitor typed. Two of
the five default BANT "budget" pill labels ("$1K-5K/mo" = 9 chars,
"$20K+/mo" = 8 chars) are shorter than ``_should_skip_bant_extraction``'s
10-character floor, so tapping either of those two exact buttons produced
*zero* signal at all, not a mis-scored one, none.

``_score_cta_answer`` resolves a CTA-tagged answer directly against the
framework's rubric with no LLM round-trip and no length floor, and the two
pipeline call sites bypass ``_should_skip_bant_extraction`` whenever it
successfully resolves.
"""

from copy import deepcopy

from app.services.qualification_service import get_framework_config
from app.services.rag_service import (
    _next_dimension_cta,
    _score_cta_answer,
    _should_skip_bant_extraction,
    _strip_trailing_question,
)


class TestStripTrailingQuestion:
    """Deterministic guard for suppressed-probe (qualified-lead card) turns:
    a trailing question the model appends despite the answer-only instruction
    must be removed before the answer reaches the visitor."""

    def test_drops_trailing_question_paragraph(self):
        text = "Five months is a reasonable target for a small rollout.\n\nWhat size fleet are you migrating?"
        assert _strip_trailing_question(text) == "Five months is a reasonable target for a small rollout."

    def test_drops_trailing_question_sentence_in_final_paragraph(self):
        text = "That fits the 4-6 month window. When do you want to start?"
        assert _strip_trailing_question(text) == "That fits the 4-6 month window."

    def test_leaves_statement_only_answer_untouched(self):
        text = "Four months is a workable timeline for a phased rollout."
        assert _strip_trailing_question(text) == text

    def test_never_returns_empty_when_answer_is_only_a_question(self):
        # Degenerate: nothing but a question. Keep it rather than send nothing.
        text = "What size fleet are you migrating?"
        assert _strip_trailing_question(text) == text

    def test_preserves_mid_answer_question_marks(self):
        text = 'A "what if" plan? We cover that in onboarding. It scales cleanly.'
        assert _strip_trailing_question(text) == text

    def test_handles_empty(self):
        assert _strip_trailing_question("") == ""


class TestNextDimensionCta:
    """The deferred follow-up carried by the qualified-lead card: when the
    visitor picks "Continue with AI", the widget surfaces the next unassessed
    dimension's probe + chips from this payload."""

    def test_returns_first_unassessed_dimension_prompt(self):
        config = get_framework_config(None)  # default BANT preset
        order = config.get("conversation_order") or ["need", "timeline", "authority", "budget"]

        cta = _next_dimension_cta(config, {})  # nothing assessed yet

        assert cta is not None
        assert cta["dimension"] == order[0]
        assert cta["prompt"], "the probe question must be populated"
        # Default preset has cta_enabled=False, so chips stay empty (free-text).
        assert cta["options"] == []

    def test_chips_populated_when_dimension_opts_into_quick_replies(self):
        config = deepcopy(get_framework_config(None))
        first = (config.get("conversation_order") or ["need"])[0]
        config[first]["cta_enabled"] = True

        cta = _next_dimension_cta(config, {})

        assert cta is not None
        assert cta["dimension"] == first
        assert cta["options"], "cta_enabled dimension must expose its chip labels"

    def test_skips_already_assessed_dimensions(self):
        config = get_framework_config(None)
        order = config.get("conversation_order") or ["need", "budget", "authority", "timeline"]
        first = order[0]
        # Assess the first dimension past its 60% threshold so it's skipped.
        first_max = max((int(o.get("score", 0)) for o in config[first].get("options", [])), default=25)

        cta = _next_dimension_cta(config, {f"{first}_score": first_max})

        assert cta is not None
        assert cta["dimension"] != first

    def test_returns_none_when_all_dimensions_assessed(self):
        config = get_framework_config(None)
        state = {}
        for dim in config.get("conversation_order") or ["need", "budget", "authority", "timeline"]:
            dim_max = max((int(o.get("score", 0)) for o in config[dim].get("options", [])), default=25)
            state[f"{dim}_score"] = dim_max

        assert _next_dimension_cta(config, state) is None

    def test_none_config_is_a_noop(self):
        assert _next_dimension_cta(None, {}) is None


class TestScoreCtaAnswer:
    def test_matches_short_budget_label_that_the_length_floor_would_drop(self):
        config = get_framework_config(None)  # default BANT preset

        # Both of these are shorter than the 10-char skip floor. Confirm
        # the free-text path would in fact have dropped them.
        assert _should_skip_bant_extraction("$1K-5K/mo", {}, config) is True
        assert _should_skip_bant_extraction("$20K+/mo", {}, config) is True

        signal = _score_cta_answer("budget", "$20K+/mo", config)

        assert signal is not None
        assert signal["dimension"] == "budget"
        assert signal["score"] == 25
        assert signal["confidence"] == "high"
        assert signal["extracted_value"] == "$20K+/mo"

    def test_matches_case_and_whitespace_insensitively(self):
        config = get_framework_config(None)

        signal = _score_cta_answer("budget", "  under $1k/mo  ", config)

        assert signal is not None
        assert signal["score"] == 10

    def test_unknown_dimension_returns_none(self):
        config = get_framework_config(None)

        assert _score_cta_answer("not_a_real_dimension", "$20K+/mo", config) is None

    def test_label_not_in_rubric_returns_none_and_falls_back(self):
        config = get_framework_config(None)

        assert _score_cta_answer("budget", "some free-text answer the visitor typed", config) is None

    def test_no_cta_dimension_is_a_noop(self):
        config = get_framework_config(None)

        assert _score_cta_answer(None, "$20K+/mo", config) is None

    def test_meddic_dimension_resolves_too(self):
        config = get_framework_config(None)
        config = {**config, "framework": "meddic"}
        from app.services.qualification_service import PRESET_FRAMEWORKS

        meddic_config = PRESET_FRAMEWORKS["meddic"]

        signal = _score_cta_answer("economic_buyer", "Budget owner known", meddic_config)

        assert signal is not None
        assert signal["score"] == 12
