"""Topical follow-up must not be refused as off-topic.

Bug report: the bot introduced "Clean Libraries" (with a document), and one
turn later refused "how would you implement clean libraries in any system"
with a flat "That's outside my lane." The CRAG relevance gate scored the
follow-up phrasing 0.0 and, because ``_question_looks_on_scope`` doesn't know
"clean libraries" is a product the bot just raised, it took the harsh refusal
path.

``_continues_prior_bot_topic`` detects that the question reuses a two-word
content phrase from the bot's most recent turn, which relaxes the gate so the
answer is generated from the chunks retrieval already returned — while genuine
off-topic questions (no shared phrase) are still refused.
"""

from app.services.rag_service import (
    _content_bigrams,
    _continues_prior_bot_topic,
    _refusal_or_browsing_ack,
)


def _history(*turns):
    """turns: (role, content) pairs, oldest first."""
    return [{"role": r, "content": c} for r, c in turns]


class TestBrowsingGetsWarmAckNotRefusal:
    """A browsing / time-pass visitor must not be hit with the off-topic
    refusal ("outside my lane") — that reads as hostile. It gets a warm,
    low-key acknowledgement; genuine off-topic questions still get refused."""

    def test_browsing_message_gets_warm_ack(self):
        for q in ["just looking around really", "nah im good, just browsing", "just killing time tbh"]:
            out = _refusal_or_browsing_ack(q, "CleanStart", [])
            assert "No rush" in out, q

    def test_genuine_off_topic_still_refused(self):
        for q in ["what's the capital of france", "who won the world cup"]:
            out = _refusal_or_browsing_ack(q, "CleanStart", [])
            assert "No rush" not in out, q


class TestContentBigrams:
    def test_extracts_adjacent_content_phrases(self):
        assert "clean libraries" in _content_bigrams("Clean Libraries governs dependencies")

    def test_drops_stopwords_and_short_tokens(self):
        # "how", "to", "in" are stopwords; single/edge tokens excluded.
        bigrams = _content_bigrams("how to work in a system")
        assert all("how" not in b for b in bigrams)


class TestContinuesPriorBotTopic:
    def test_followup_on_bot_introduced_topic(self):
        history = _history(
            ("user", "tell me about clean libraries"),
            ("bot", "Clean Libraries governs open-source dependencies with source verification."),
        )
        assert _continues_prior_bot_topic("how would u implement clean libraries in any system", history) is True

    def test_unrelated_question_is_not_continuation(self):
        history = _history(
            ("user", "tell me about clean libraries"),
            ("bot", "Clean Libraries governs open-source dependencies with source verification."),
        )
        assert _continues_prior_bot_topic("what's the capital of france", history) is False

    def test_incidental_single_word_overlap_does_not_count(self):
        # Shares only the single word "system" — not a two-word phrase.
        history = _history(("bot", "Our platform secures your build system end to end."))
        assert _continues_prior_bot_topic("how do neural networks learn on any system", history) is False

    def test_no_bot_turn_yet(self):
        assert _continues_prior_bot_topic("clean libraries details", _history(("user", "hi"))) is False

    def test_empty_question(self):
        history = _history(("bot", "Clean Libraries governs dependencies."))
        assert _continues_prior_bot_topic("", history) is False
