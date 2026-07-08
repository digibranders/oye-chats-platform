"""Tests for BR-02: deterministic qualification-CTA pill scoring.

Before this, tapping a qualification CTA pill just resent the button's label
as an ordinary chat message (``ChatWindow.jsx``'s ``onSelect`` called
``handleSend(null, option)``), so it was scored — if at all — by the same
probabilistic free-text LLM extraction as anything a visitor typed. Two of
the five default BANT "budget" pill labels ("$1K-5K/mo" = 9 chars,
"$20K+/mo" = 8 chars) are shorter than ``_should_skip_bant_extraction``'s
10-character floor, so tapping either of those two exact buttons produced
*zero* signal at all — not a mis-scored one, none.

``_score_cta_answer`` resolves a CTA-tagged answer directly against the
framework's rubric with no LLM round-trip and no length floor, and the two
pipeline call sites bypass ``_should_skip_bant_extraction`` whenever it
successfully resolves.
"""

from app.services.qualification_service import get_framework_config
from app.services.rag_service import _score_cta_answer, _should_skip_bant_extraction


class TestScoreCtaAnswer:
    def test_matches_short_budget_label_that_the_length_floor_would_drop(self):
        config = get_framework_config(None)  # default BANT preset

        # Both of these are shorter than the 10-char skip floor — confirm
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
