"""A bot with multilingual off replies in English, whatever language the visitor writes in.

Production, 2026-09-11: CleanStart has multilingual OFF and answered an Arabic
question in Arabic and a Hindi question in Hindi. ``_language_directive``
returned an empty string when multilingual was off, so the only language
instruction the model saw was the style block's "Mirror the visitor's language".
"""

from __future__ import annotations

from types import SimpleNamespace

from app.schemas.language import LanguageContext
from app.services import rag_service as rs

_CLIENT = SimpleNamespace(name="Acme")
_CONTEXT = "<<<DOCUMENT 1 | about.md>>>\nAcme builds analytics tooling.\n<<<END DOCUMENT 1>>>\n"
_HINDI = LanguageContext(language="hi", locale="hi-IN", source="explicit", confidence=1.0, direction="ltr", locked=True)


def _prompt(language) -> str:
    system, _user = rs.build_hybrid_prompt(
        _CLIENT, "आप क्या करते हैं?", _CONTEXT, "", company_name="Acme", language=language
    )
    return system


class TestTheDirectiveForABotWithMultilingualOff:
    def test_it_names_english(self):
        directive = rs._language_directive(None)

        assert "CONVERSATION LANGUAGE" in directive
        assert "Language: English" in directive

    def test_it_holds_when_the_visitor_writes_in_another_language(self):
        directive = rs._language_directive(None)

        assert (
            "Write your ENTIRE reply in English, even when the visitor writes in another language "
            "or asks you to switch." in directive
        )

    def test_a_question_in_another_language_is_still_answered(self):
        directive = rs._language_directive(None)

        assert "Never refuse it or treat it as off-topic because of its language." in directive

    def test_it_supersedes_mirroring(self):
        assert "This OVERRIDES any instruction to mirror the visitor's message language." in rs._language_directive(
            None
        )


class TestItReachesThePrompt:
    def test_the_directive_sits_immediately_before_the_style_block(self):
        prompt = _prompt(None)

        # The header line, not the phrase: the style block now names the block.
        assert prompt.count("\nCONVERSATION LANGUAGE\n") == 1
        assert prompt.index("CONVERSATION LANGUAGE") < prompt.index("RESPONSE STYLE")
        between = prompt[prompt.index("CONVERSATION LANGUAGE") : prompt.index("RESPONSE STYLE")]
        assert "Language: English" in between
        assert "PRICING & CURRENCY" not in between

    def test_the_style_block_no_longer_tells_the_model_to_mirror(self):
        """One owner per rule: the directive is now on every prompt, so a style
        block that still says to mirror would contradict it on every turn."""
        for language in (None, _HINDI):
            prompt = _prompt(language)

            assert "Mirror the visitor's language." not in prompt
            assert "reply in that\n    same language" not in prompt
            assert "Did I match the visitor's language?" not in prompt
            assert "Reply in the language the CONVERSATION LANGUAGE block names." in prompt


class TestABotWithMultilingualOnIsUnchanged:
    def test_it_keeps_its_conversation_language(self):
        prompt = _prompt(_HINDI)

        assert prompt.count("\nCONVERSATION LANGUAGE\n") == 1
        assert "Write your ENTIRE reply in Hindi (India)." in prompt
        assert "Language: English" not in prompt
