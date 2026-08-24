"""The visitor-name capture gate must speak the conversation's language.

WHY THIS EXISTS
---------------
`_NAME_REQUEST_MESSAGE` and `_NAME_ASK_TEXT` bypass the LLM completely: they are
returned verbatim, so the Phase 3 CONVERSATION LANGUAGE directive has no say in
them. A Hindi visitor's very first turn was therefore answered in English.

The dangerous half of the fix is DETECTION. `rag_service` carries an explicit
warning above `_NAME_ASK_SIGNATURES`: the turn-2 logic keys off "did a prior bot
turn ask for the name", and if the phrase it looks for is not the phrase we
actually sent, the whole flow silently no-ops - the visitor is asked their name
forever and their real question is never answered. Localizing the message
without localizing the signatures would reintroduce exactly that bug, in Hindi
only, where nobody would notice.

So the round-trip (`ask in language X` -> `detect that ask`) is pinned for every
language the bot can ask in.
"""

import pytest

from app.schemas.language import LanguageContext
from app.services import rag_service as rs


def _ctx(language: str, locale: str) -> LanguageContext:
    return LanguageContext(
        language=language,
        locale=locale,
        source="explicit",
        confidence=1.0,
        direction="ltr",
        locked=True,
    )


HINDI = _ctx("hi", "hi-IN")
ENGLISH = _ctx("en", "en-IN")
# An enabled language we have no translation for: must fall back, not break.
FRENCH = _ctx("fr", "fr-FR")


class TestWordingSelection:
    def test_hindi_conversation_gets_hindi_wordings(self):
        request = rs._name_request_message(HINDI)
        ask = rs._name_ask_text(HINDI)
        assert request != rs._NAME_REQUEST_MESSAGE
        assert ask != rs._NAME_ASK_TEXT
        # Devanagari, and no English leaking through.
        assert any("ऀ" <= ch <= "ॿ" for ch in request)
        assert "may I know your name" not in request
        assert "What name should I use" not in ask

    @pytest.mark.parametrize("language", [None, ENGLISH, FRENCH])
    def test_everything_else_keeps_the_english_wordings(self, language):
        # Disabled bot (None), English, and an untranslated language all keep
        # the exact pre-existing strings, so no existing behaviour shifts.
        assert rs._name_request_message(language) == rs._NAME_REQUEST_MESSAGE
        assert rs._name_ask_text(language) == rs._NAME_ASK_TEXT


class TestDetectionRoundTrip:
    """Whatever we ask with, we must be able to recognise afterwards."""

    @pytest.mark.parametrize("language", [None, ENGLISH, FRENCH, HINDI])
    def test_full_request_is_detected(self, language):
        assert rs._is_name_ask_message(rs._name_request_message(language)) is True

    @pytest.mark.parametrize("language", [None, ENGLISH, FRENCH, HINDI])
    def test_short_ask_is_detected(self, language):
        assert rs._is_name_ask_message(rs._name_ask_text(language)) is True

    @pytest.mark.parametrize("language", [None, ENGLISH, FRENCH, HINDI])
    def test_detected_when_appended_to_a_longer_answer(self, language):
        # The short ask ships appended to a real answer, not on its own.
        combined = f"हमारे प्लान ₹999/माह से शुरू होते हैं।\n\n{rs._name_ask_text(language)}"
        assert rs._is_name_ask_message(combined) is True

    def test_detection_is_language_agnostic(self):
        # A session whose language changed mid-chat still has the OLD-language
        # request sitting in history; it must still be recognised, or the gate
        # re-asks forever after a language switch.
        assert rs._is_name_ask_message(rs._name_request_message(HINDI)) is True
        assert rs._is_name_ask_message(rs._name_request_message(ENGLISH)) is True

    def test_ordinary_messages_are_not_mistaken_for_the_ask(self):
        for text in (
            "",
            "नमस्ते",
            "आपके प्लान की कीमत क्या है?",
            "What is your pricing?",
            "My name is Priya",
            "मेरा नाम प्रिया है",
        ):
            assert rs._is_name_ask_message(text) is False, text


class TestSignaturesStayInStepWithWordings:
    """The failure mode the module comment warns about, pinned structurally.

    If someone edits a translated wording and forgets its signature, this fails
    immediately rather than silently breaking the gate in that language only.
    """

    def test_every_translated_wording_contains_one_of_its_signatures(self):
        for lang_code, table in rs._CANNED_I18N.items():
            for kind in ("name_request", "name_ask"):
                if kind not in table:
                    continue
                wording = table[kind].format(cn="Acme")
                assert any(sig in wording for sig in rs._NAME_ASK_SIGNATURES_I18N), (
                    f"{lang_code}/{kind} matches no signature in _NAME_ASK_SIGNATURES_I18N; "
                    "the name-capture gate will silently no-op for this language"
                )

    def test_no_signature_is_dead_weight(self):
        # Every signature must be reachable from some real wording, so the list
        # cannot rot into stale fragments that match nothing.
        wordings = [
            table[kind].format(cn="Acme")
            for table in rs._CANNED_I18N.values()
            for kind in ("name_request", "name_ask")
            if kind in table
        ]
        for sig in rs._NAME_ASK_SIGNATURES_I18N:
            assert any(sig in w for w in wordings), f"signature {sig!r} matches no wording"


class TestPipelineWiring:
    def test_both_name_helpers_accept_a_language(self):
        import inspect

        assert "language" in inspect.signature(rs.resolve_name_flow).parameters
        assert "language" in inspect.signature(rs._maybe_append_name_ask).parameters
