"""A visitor saying goodbye is answered with goodbye on every plan.

The one-owner pass deleted the style block's closure rule and kept the copy
inside the qualification section. That section is emitted only when
qualification is on, so a Free or Starter bot lost its only instruction to
stop, and "perfect, thanks" was answered with a follow-up question again.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.services.qualification_service import get_framework_config
from app.services.rag_service import build_hybrid_prompt

_CLIENT = SimpleNamespace(name="Acme")
_CONTEXT = "<<<DOCUMENT 1 | about.md>>>\nAcme builds analytics tooling.\n<<<END DOCUMENT 1>>>\n"


def _full_prompt(**kwargs) -> str:
    system, user = build_hybrid_prompt(_CLIENT, "perfect, thanks", _CONTEXT, "USER: hi\nBOT: hello", **kwargs)
    return system + "\n" + user


class TestClosureIsOwnedOnce:
    def test_a_bot_without_qualification_still_has_the_rule(self):
        prompt = _full_prompt(bant_enabled=False, company_name="Acme")
        assert prompt.count("CLOSURE OVERRIDE") == 1

    def test_a_bot_with_qualification_has_it_exactly_once(self):
        prompt = _full_prompt(bant_enabled=True, bant_config=get_framework_config(None), company_name="Acme")
        assert prompt.count("CLOSURE OVERRIDE") == 1

    def test_the_qualification_rules_still_defer_to_it(self):
        prompt = _full_prompt(bant_enabled=True, bant_config=get_framework_config(None), company_name="Acme")
        assert "CLOSURE OVERRIDE" in prompt
        assert prompt.index("CLOSURE OVERRIDE") < prompt.index("UNIVERSAL RULES")
