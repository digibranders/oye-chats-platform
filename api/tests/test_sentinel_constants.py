"""Round-trip tests for shared sentinel-token constants (AR-34).

Before this, each sentinel token ([CTA:dim], [YOUTUBE_CARD:id],
[LEAVE_MESSAGE_CARD], etc.) was typed as a literal string independently in
the prompt prose AND in its extraction regex, 1000+ lines apart. A prompt
reword of a sentinel prefix (even a stray space) would desync silently from
its extractor regex — the LLM keeps faithfully emitting the (now-wrong)
token, but the stripper never fires, leaking the raw sentinel to the
visitor. These tests pin two properties for each sentinel: (1) the shared
constant is what the extraction regex is built from (a synthetic answer
built from the constant actually extracts), and (2) the constant's literal
text actually appears in the real assembled system prompt.
"""

from types import SimpleNamespace
from unittest.mock import patch

from app.services.rag_service import (
    _CTA_PATTERN,
    _CTA_Q_PATTERN,
    CTA_Q_SENTINEL_PREFIX,
    CTA_SENTINEL_PREFIX,
    DOWNLOAD_CARD_SENTINEL_PREFIX,
    LEAVE_MESSAGE_CARD_SENTINEL,
    MEETING_CARD_SENTINEL,
    YOUTUBE_CARD_SENTINEL_PREFIX,
    _download_card_re,
    _leave_message_card_re,
    _meeting_card_re,
    _youtube_card_re,
    build_hybrid_prompt,
)


class TestRegexRoundTripsWithSharedConstant:
    def test_cta_prefix_extracts_dimension(self):
        answer = f"Some answer text.\n{CTA_SENTINEL_PREFIX}timeline]"
        match = _CTA_PATTERN.search(answer)
        assert match and match.group(1) == "timeline"

    def test_cta_q_prefix_extracts_question(self):
        answer = f"Some answer.\n{CTA_Q_SENTINEL_PREFIX}Does that work for you?]"
        match = _CTA_Q_PATTERN.search(answer)
        assert match and match.group(1) == "Does that work for you?"

    def test_meeting_card_sentinel_matches(self):
        assert _meeting_card_re.search(f"Sure, let's schedule that.\n{MEETING_CARD_SENTINEL}")

    def test_leave_message_card_sentinel_matches(self):
        assert _leave_message_card_re.search(f"I'll open the form.\n{LEAVE_MESSAGE_CARD_SENTINEL}")

    def test_youtube_card_prefix_extracts_video_id(self):
        answer = f"Here's the video.\n{YOUTUBE_CARD_SENTINEL_PREFIX}IB7GGzCNy-U]"
        match = _youtube_card_re.search(answer)
        assert match and match.group(1) == "IB7GGzCNy-U"

    def test_download_card_prefix_extracts_url_and_filename(self):
        answer = f"Here's the brochure.\n{DOWNLOAD_CARD_SENTINEL_PREFIX}https://x.test/b.pdf|brochure.pdf]"
        match = _download_card_re.search(answer)
        assert match and match.group(1) == "https://x.test/b.pdf" and match.group(2) == "brochure.pdf"


class TestConstantsAppearInAssembledPrompt:
    """Proves the prompt prose actually USES the shared constant (not just a
    coincidentally-matching literal) — the whole point of AR-34."""

    def test_meeting_leave_message_and_media_constants_appear_in_system_prompt(self):
        """These sections (handoff/meeting/media-cards) are per-bot-config,
        stable across turns, and stay in system_prompt per AR-27."""
        client = SimpleNamespace(name="TestCo")
        with patch("app.services.rag_service.get_framework_config", return_value={}):
            system, _user = build_hybrid_prompt(
                client,
                "Q",
                "ctx",
                "",
                live_chat_enabled=True,
                meeting_booking_enabled=True,
            )

        for constant in (
            MEETING_CARD_SENTINEL,
            LEAVE_MESSAGE_CARD_SENTINEL,
            YOUTUBE_CARD_SENTINEL_PREFIX,
            DOWNLOAD_CARD_SENTINEL_PREFIX,
        ):
            assert constant in system, f"{constant!r} not found in assembled system prompt"

    def test_cta_constants_appear_in_user_prompt(self):
        """CTA/CTA_Q instructions live inside qualification_section, which is
        per-turn BANT state — moved to user_prompt by AR-27."""
        client = SimpleNamespace(name="TestCo")
        config = {
            "conversation_order": ["budget"],
            "budget": {
                "label": "Budget",
                "cta_enabled": True,
                "options": [{"label": "High", "score": 25}],
            },
        }
        with patch("app.services.rag_service.get_framework_config", return_value=config):
            _system, user = build_hybrid_prompt(client, "Q", "ctx", "", bant_state={})

        assert CTA_SENTINEL_PREFIX in user
        assert CTA_Q_SENTINEL_PREFIX in user
