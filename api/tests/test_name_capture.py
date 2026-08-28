"""Visitor name capture must store a REAL name or nothing.

Bug report: the leads list filled with "Urgent", "Good", "Monthly" — words the
visitor typed instead of a name, captured by the bare-reply-to-name-ask path.
Policy: capture an actual name when given; otherwise leave it blank and let the
lead-capture form collect it. These pin that common non-name words are rejected
while real names (including ones paired with a common word) survive.
"""

from app.services.rag_service import _clean_visitor_name, _extract_visitor_name

_NAME_ASK = "Hi there! Before I help you out, may I know your name so I can address you properly?"


def _history_with_name_ask():
    return [{"role": "user", "content": "hi"}, {"role": "bot", "content": _NAME_ASK}]


class TestCleanVisitorName:
    def test_rejects_common_non_name_words(self):
        for w in ["urgent", "Urgent", "good", "Good", "monthly", "pricing", "critical", "asap", "busy", "demo"]:
            assert _clean_visitor_name(w) is None, w

    def test_rejects_role_words(self):
        assert _clean_visitor_name("manager") is None
        assert _clean_visitor_name("the owner") is None

    def test_accepts_real_names(self):
        assert _clean_visitor_name("jason") == "Jason"
        assert _clean_visitor_name("sam") == "Sam"
        assert _clean_visitor_name("priya") == "Priya"

    def test_real_name_paired_with_common_word_survives(self):
        # Only rejected when EVERY meaningful token is a non-name word.
        assert _clean_visitor_name("John Good") == "John Good"


class TestExtractVisitorNameBareReply:
    def test_garbage_reply_to_name_ask_is_not_captured(self):
        # Visitor ignores the name ask and types a status word — must stay blank.
        assert _extract_visitor_name("urgent", _history_with_name_ask()) is None
        assert _extract_visitor_name("good", _history_with_name_ask()) is None

    def test_real_name_reply_is_captured(self):
        assert _extract_visitor_name("jason", _history_with_name_ask()) == "Jason"

    def test_explicit_intro_still_works(self):
        assert _extract_visitor_name("my name is Priya", []) == "Priya"


class TestCleanVisitorNameVerbPhraseFragments:
    """Bug report: leads list filled with "Launching My", "Blocking Our",
    "Becoming A" — the first two words of a sentence the visitor typed instead
    of a name, not an actual name. A real two-word name never ends with a
    possessive pronoun or article, so <word> + <possessive/article> must be
    rejected the same way role words already are."""

    def test_rejects_gerund_plus_pronoun(self):
        for w in ["Launching My", "Blocking Our", "Becoming A", "Testing Your", "Building Their"]:
            assert _clean_visitor_name(w) is None, w

    def test_real_two_word_name_still_survives(self):
        assert _clean_visitor_name("Sarah Khan") == "Sarah Khan"


class TestExtractVisitorNameIntroPatternSentenceFragments:
    """The generic intro anchors ("i'm", "it's", "this is") must not mistake the
    next two words of an ordinary sentence for a self-introduction."""

    def test_gerund_plus_pronoun_after_intro_anchor_not_captured(self):
        assert _extract_visitor_name("im launching my new startup, can you help?", []) is None
        assert _extract_visitor_name("it's blocking our workflow", []) is None
        assert _extract_visitor_name("this is becoming a headache", []) is None

    def test_genuine_intro_still_works(self):
        assert _extract_visitor_name("this is Priya", []) == "Priya"
        assert _extract_visitor_name("i'm Sarah Khan", []) == "Sarah Khan"
