"""The answer prompt keeps the company's own claims, capabilities and comparisons honest.

Production, 2026-09-11:

1. Eventus was asked "iso 27001 certified or not? and cert-in empanelled?" and
   answered "Yes. **Eventus Security** is ISO 27001 certified and CERT-In
   empanelled." The knowledge base supports the empanelment; ISO 27001 appears
   only as a compliance service Eventus sells. Other answers presented a
   knowledge-hub listicle, a CISO buyer checklist and a general CERT-In guide as
   the company's own contract terms, promised USD invoicing, and agreed to an
   in-person meeting with nothing behind any of it. RULE 5a only covered a claim
   "NOT present in the reference material", and the model read a standard named
   anywhere in the material as present.
2. CleanStart, a software supply chain security company, was asked during an
   AWS root-account compromise "do you guys even handle this kind of thing?" and
   gave the "sits with the team" gap line, as did a follow-up that changed the
   visitor's industry ("sorry not hospital, we are a bank. what changes"). Both
   are answerable from what the company does.
3. "how r u better than crowdstrike" was refused, because SCOPE listed "opinions
   on third parties or competitors" as out of scope.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.services.qualification_service import get_framework_config
from app.services.rag_service import build_hybrid_prompt

_CLIENT = SimpleNamespace(name="Acme")
_CONTEXT = "<<<DOCUMENT 1 | about.md>>>\nAcme builds analytics tooling.\n<<<END DOCUMENT 1>>>\n"

_PAID = {
    "bant_enabled": True,
    "bant_config": get_framework_config(None),
    "live_chat_enabled": True,
    "support_enabled": True,
}
_FREE = {"bant_enabled": False, "live_chat_enabled": False, "support_enabled": False}


def _prompt(**kwargs) -> str:
    system, _user = build_hybrid_prompt(
        _CLIENT, "are you iso 27001 certified", _CONTEXT, "", company_name="Acme", **kwargs
    )
    return system


def _section(prompt: str, start: str, end: str) -> str:
    begin = prompt.index(start)
    return prompt[begin : prompt.index(end, begin)]


def _rule_5a(prompt: str) -> str:
    return _section(prompt, "5a. VERIFIABLE-CLAIM GROUND RULE", "\n5c. ")


def _rule_5c(prompt: str) -> str:
    return _section(prompt, "5c. ", "\n5d. ")


def _rule_5d(prompt: str) -> str:
    return _section(prompt, "5d. ", "\n6. ")


def _scope(prompt: str) -> str:
    return _section(prompt, "SCOPE (HIGHEST PRIORITY", "\nVOICE:")


class TestACredentialOrTermIsTheCompanysOnlyWhenTheSourceSaysSo:
    def test_the_clause_lives_in_the_verifiable_claim_rule(self):
        """RULE 5a is the rule the model applied and got wrong, so the
        attribution test sits inside it rather than in a block weighed against it."""
        rule = _rule_5a(_prompt(**_PAID))

        assert "OWN CREDENTIALS AND TERMS." in rule
        assert "counts as present only when the reference material says Acme itself holds or offers it" in rule

    def test_a_standard_sold_as_a_service_is_not_the_companys_certification(self):
        rule = _rule_5a(_prompt(**_PAID))

        assert "A standard named as a service Acme provides to its customers is not Acme's own certification." in rule

    def test_it_names_every_credential_kind(self):
        rule = _rule_5a(_prompt(**_PAID))

        assert "A certification, accreditation, empanelment or compliance status" in rule

    def test_it_names_the_commercial_terms_that_were_promised_without_a_basis(self):
        rule = _rule_5a(_prompt(**_PAID))

        for term in (
            "payment terms",
            "invoicing currency",
            "refunds",
            "NDAs",
            "SLAs",
            "onboarding timelines",
            "in-person meetings",
        ):
            assert term in rule, term

    def test_generic_material_is_not_the_companys_own_terms_or_process(self):
        rule = _rule_5a(_prompt(**_PAID))

        assert (
            "A general article, buyer checklist or industry guide describes the topic, not Acme's own terms or process."
            in rule
        )

    def test_an_unsupported_claim_takes_the_short_gap_path(self):
        rule = _rule_5a(_prompt(**_PAID))

        assert "Otherwise take path (a), in two sentences at most." in rule

    def test_a_question_about_several_credentials_is_answered_one_by_one(self):
        """The production question asked two at once, and one supported
        credential carried the unsupported one into a single "Yes"."""
        rule = _rule_5a(_prompt(**_PAID))

        assert "When the visitor asks about several credentials, answer each one on its own evidence." in rule


class TestTheGapLineIsOnlyForAMissingFact:
    def test_the_gap_clause_is_reserved_for_an_absent_fact(self):
        rule = _rule_5c(_prompt(**_PAID))

        assert "The 5a gap clause is only for a specific fact the reference material lacks." in rule

    def test_a_do_you_handle_question_is_answered_from_what_the_company_does(self):
        rule = _rule_5c(_prompt(**_PAID))

        assert 'Answer "do you handle, offer or work with X?" from what Acme does' in rule
        assert "if its offerings in the reference material clearly do not include X" in rule
        assert "say plainly that Acme does not offer X and what it does do" in rule
        assert "only when that is unclear, use the gap clause" in rule

    def test_a_change_of_the_visitors_context_is_answered_again(self):
        rule = _rule_5c(_prompt(**_PAID))

        assert (
            "When a follow-up changes the visitor's own context (industry, company size, region), "
            "answer the question again from the reference material for the new context." in rule
        )

    def test_the_team_is_offered_only_on_a_plan_with_a_human_path(self):
        """The NO HUMAN HANDOFF section forbids offering the team on a Free plan;
        a new rule must not tell the model the opposite in the same prompt."""
        assert "then offer the team" in _rule_5c(_prompt(**_PAID))
        assert "offer the team" not in _rule_5c(_prompt(**_FREE))


class TestACompetitorComparisonIsAnswered:
    def test_scope_no_longer_refuses_competitors(self):
        prompt = _prompt(**_PAID)

        assert "opinions on third parties or competitors" not in prompt
        assert "opinions on unrelated third parties" in _scope(prompt)

    def test_scope_sends_a_comparison_to_its_rule(self):
        assert "A comparison with a competitor is on-scope: answer it under RULE 5d." in _scope(_prompt(**_PAID))

    def test_the_comparison_rule_uses_only_what_the_source_states(self):
        rule = _rule_5d(_prompt(**_PAID))

        assert "Answer with Acme's own strengths as the reference material states them." in rule
        assert "Say nothing about the competitor that the reference material does not state" in rule
        assert "never disparage them" in rule

    def test_a_comparison_with_no_basis_still_gets_an_answer(self):
        assert "If the reference material gives no basis for a comparison, say what Acme does" in _rule_5d(
            _prompt(**_PAID)
        )


class TestAServicesListDoesNotRefuseAnUnofferedService:
    """With a SERVICES list configured, "do you offer X?" for an unlisted X was
    sent to the scope refusal, which contradicts RULE 5c on every such bot."""

    def test_an_unlisted_service_is_answered_under_rule_5c(self):
        prompt = _prompt(**_PAID, services=[{"name": "Analytics", "url": "https://acme.com/analytics"}])
        services = _section(prompt, "SERVICES (HIGHEST PRIORITY", "\n\n")

        assert "treat it as\n  out-of-scope" not in services
        assert "answer under RULE 5c and say plainly that we do not offer it" in services
        assert "A question unrelated to the company still gets the scope refusal." in services


class TestEachNewClauseIsStatedOnce:
    def test_on_every_plan(self):
        for kwargs in (_PAID, _FREE):
            prompt = _prompt(**kwargs)
            for marker in (
                "OWN CREDENTIALS AND TERMS.",
                "\n5c. ",
                "\n5d. ",
                "A comparison with a competitor is on-scope",
            ):
                assert prompt.count(marker) == 1, (marker, kwargs)
