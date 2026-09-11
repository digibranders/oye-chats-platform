"""A question about a role that several people hold names all of them.

On 2026-09-11 two live bots answered "who is the founder" and "founder" with
one or two of their co-founders ("Sunil Sapra is a Co-Founder." on a site that
names two), while "who are the founders" named everyone. Replaying retrieval on
production ruled the chunks out: the top-ranked chunks named every co-founder,
one of them all three in a single sentence.

The prompt did it. RULE 1 said to answer only what was asked, and to mention
only the CEO when asked about the CEO; RULE 6, the complete-list rule, only
covered questions phrased as lists. A singular role question fell under RULE 1
and the model trimmed the answer to one holder.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.services.qualification_service import get_framework_config
from app.services.rag_service import build_hybrid_prompt

_CLIENT = SimpleNamespace(name="Acme")
_CONTEXT = "<<<DOCUMENT 1 | team.md>>>\nAcme was founded by Priya Raman and Daniel Okafor.\n<<<END DOCUMENT 1>>>\n"


def _prompt(**kwargs) -> str:
    system, _user = build_hybrid_prompt(_CLIENT, "who is the founder", _CONTEXT, "", company_name="Acme", **kwargs)
    return system


def _rule_one(prompt: str) -> str:
    start = prompt.index("RULES:\n1. ")
    return prompt[start : prompt.index("\n2. ", start)]


class TestRuleOneNamesEveryHolderOfASharedRole:
    def test_the_role_clause_lives_in_rule_one(self):
        """RULE 1 is the rule that trimmed the answer, so the exception sits
        beside it rather than in a block the model weighs against it."""
        rule = _rule_one(_prompt())

        assert "names several holders of the asked role" in rule
        assert "name every one of them" in rule

    def test_it_names_the_roles_that_are_commonly_shared(self):
        rule = _rule_one(_prompt())

        for role in ("founders and co-founders", "owners", "partners", "directors"):
            assert role in rule, role

    def test_a_singular_question_is_covered(self):
        """The production questions were singular. A rule that only fired on
        "who are the founders" would change nothing."""
        rule = _rule_one(_prompt())

        assert '"who is the founder"' in rule
        assert '"who owns the company"' in rule

    def test_a_single_holder_role_still_gets_only_that_person(self):
        rule = _rule_one(_prompt())

        assert "If asked about the CEO, mention only the CEO, not the entire team." in rule

    def test_the_clause_is_stated_once_on_every_plan(self):
        for kwargs in (
            {"bant_enabled": False, "live_chat_enabled": False, "support_enabled": False},
            {
                "bant_enabled": True,
                "bant_config": get_framework_config(None),
                "live_chat_enabled": True,
                "support_enabled": True,
            },
        ):
            assert _prompt(**kwargs).count("names several holders of the asked role") == 1, kwargs
