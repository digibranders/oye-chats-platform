"""The answer prompt has one priority order and says each answer-quality rule once.

Review of the production prompt on 2026-09-17 (bots 4 and 5, 240 evaluated
conversations) found the defects these tests pin:

1. Five blocks each claimed to override everything else (SCOPE, RULE 0,
   SERVICES, the closure rule, RULE 5a), so the model ranked them by recency.
2. The SERVICES block said the company offers "exactly" the configured list, and
   a bot denied services its own website sells. "list soc centers" was answered
   with the services list.
3. Length rules pulled against each other, so "tell me more about the second
   one" got one sentence and a link.
4. The gap path fired on facts the reference material contained, and "that
   detail sits with our team" became the default answer.
5. Team offers were worded like a handoff that had already started.
6. Frustration got "Sorry to hear that." with nothing after it, and a Dockerfile
   question got generic debugging steps.
7. A turn that asked the price and something else had no instruction to leave
   the figure out, so the price guard threw the whole answer away.
"""

from __future__ import annotations

import re
from types import SimpleNamespace

import pytest

from app.services.intent_service import bot_offers_handoff
from app.services.qualification_service import get_framework_config
from app.services.rag_service import (
    _LEAKAGE_SENTINELS,
    _response_suggests_handoff,
    build_hybrid_prompt,
)

_CLIENT = SimpleNamespace(name="Acme")
_CONTEXT = "<<<DOCUMENT 1 | about.md>>>\nAcme builds analytics tooling.\n<<<END DOCUMENT 1>>>\n"
_MEDIA_CONTEXT = (
    _CONTEXT
    + "\nAVAILABLE MEDIA (pick the ONE whose title best matches):\n  - Downloadable file (guide.pdf): https://acme.com/guide.pdf"
)

_PAID = {
    "bant_enabled": True,
    "bant_config": get_framework_config(None),
    "live_chat_enabled": True,
    "support_enabled": True,
}
_OFFLINE = {**_PAID, "within_business_hours": False}
_ASYNC_ONLY = {**_PAID, "live_chat_enabled": False}
_FREE = {"bant_enabled": False, "live_chat_enabled": False, "support_enabled": False}
_PLANS = {"paid": _PAID, "offline": _OFFLINE, "async": _ASYNC_ONLY, "free": _FREE}

_EVERYTHING = {
    **_PAID,
    "meeting_booking_enabled": True,
    "services": [{"name": "Analytics", "url": "https://acme.com/analytics"}],
    "answer_links": [{"keyword": "pricing", "url": "https://acme.com/pricing"}],
    "company_description": "Acme is a company. They build analytics tooling.",
    "brand_tone": "Warm and direct.",
    "custom_system_prompt": "Mention the free trial when it fits.",
}


def _build(question: str = "what does the company do", context: str = _CONTEXT, history: str = "", **kwargs):
    return build_hybrid_prompt(_CLIENT, question, context, history, company_name="Acme", **kwargs)


def _system(**kwargs) -> str:
    return _build(**kwargs)[0]


def _user(**kwargs) -> str:
    return _build(**kwargs)[1]


def _section(prompt: str, start: str, end: str) -> str:
    begin = prompt.index(start)
    return prompt[begin : prompt.index(end, begin + len(start))]


def _flat(text: str) -> str:
    return " ".join(text.split())


class TestOnePriorityOrder:
    def test_the_order_is_stated_once_near_the_top(self):
        prompt = _system(**_EVERYTHING, context=_MEDIA_CONTEXT)

        assert prompt.count("PRIORITY ORDER (when two instructions conflict, the higher one wins)") == 1
        assert prompt.index("PRIORITY ORDER") < prompt.index("SCOPE:")

    def test_it_ranks_safety_closure_grounding_scope_answer_tokens_qualification_style(self):
        order = _section(_system(**_PAID), "PRIORITY ORDER", "\n\n")
        items = re.findall(r"^(\d)\. (\w[\w ]*?):", order, re.MULTILINE)

        assert [label for _n, label in items] == [
            "Safety",
            "Closure and small talk",
            "Grounding",
            "Scope",
            "Answer",
            "Tokens and offers",
            "Qualification",
            "Style",
        ]

    @pytest.mark.parametrize("plan", sorted(_PLANS))
    def test_no_other_block_claims_to_outrank_everything(self, plan):
        kwargs = {**_EVERYTHING, **_PLANS[plan]}
        system, user = _build(context=_MEDIA_CONTEXT, **kwargs)
        prompt = system + "\n" + user

        for claim in (
            "HIGHEST PRIORITY",
            "OVERRIDES the SCOPE",
            "Overrides everything",
            "wins over every other instruction",
            'overrides the "speak with confidence"',
            "READ THIS FIRST",
            "READ TWICE",
        ):
            assert claim not in prompt, (plan, claim)

    def test_an_echoed_general_article_tag_is_a_leak(self):
        from app.services.page_kind import GENERAL_ARTICLE_TAG
        from app.services.rag_service import contains_system_prompt_leak

        assert contains_system_prompt_leak(f"Per the guide ({GENERAL_ARTICLE_TAG}), the target is 10 min.")
        assert not contains_system_prompt_leak("Our general article on SOC terms is on the blog.")

    def test_the_leak_detector_still_recognises_the_system_prompt(self):
        """``contains_system_prompt_leak`` keys on headings that only this prompt
        contains. Renaming a heading must not leave the detector watching for
        text the prompt no longer has."""
        system = _system(**_PAID)

        platform_headings = [s for s in _LEAKAGE_SENTINELS if not s.startswith("<<<") and "REFERENCE" not in s]
        assert platform_headings
        for sentinel in platform_headings:
            assert sentinel in system, sentinel


class TestLengthAndDepth:
    def _rule(self, **kwargs) -> str:
        return _section(_system(**kwargs), "RULES:\n1. LENGTH AND DEPTH.", "\n2. ")

    def test_a_fact_question_stays_short(self):
        assert "A fact question (a price, hours, a yes or no, a name) gets 1 to 3 sentences." in self._rule()

    def test_a_follow_up_asking_for_more_gets_at_least_three_facts(self):
        rule = _flat(self._rule())

        assert '"Tell me more", "explain", "how does it work", or a question about one item you listed' in rule
        assert "at least three concrete facts" in rule

    def test_an_ordinal_is_resolved_from_the_history(self):
        rule = _flat(self._rule())

        assert '"The second one"' in rule
        assert "find the item in CONVERSATION HISTORY and name it in your first sentence" in rule

    def test_a_link_is_never_the_whole_answer(self):
        assert "Never answer with only a link." in self._rule()

    def test_lists_are_complete(self):
        rules = _section(_system(), "\n2. LISTS AND ROWS.", "\n3. ")

        assert "give the COMPLETE list" in rules
        assert "Limit lists to the most relevant items" not in _system()
        assert "fewest words possible" not in _system()


class TestTheGapRule:
    def _gap(self, **kwargs) -> str:
        return _flat(_section(_system(**kwargs), "(a) GAP.", "\n  (b) "))

    def test_it_is_only_for_an_absent_fact(self):
        gap = self._gap(**_PAID)

        assert (
            "Use this only when the specific fact asked for is absent from the REFERENCE INFORMATION "
            "and from your own earlier replies." in gap
        )
        assert "When it is present, state it." in gap

    @pytest.mark.parametrize("plan", sorted(_PLANS))
    def test_only_facts_the_bot_gave_count_as_present_not_the_visitors_claims(self, plan):
        """Review, 2026-09-17: "absent from the CONVERSATION HISTORY" let a
        visitor's own claim ("you guarantee 5 minute response, right?") count as
        a stated fact."""
        gap = self._gap(**_PLANS[plan])

        assert "What the visitor claims is never a fact you stated." in gap
        assert "CONVERSATION HISTORY" not in gap

    def test_the_team_phrase_is_retired(self):
        prompt = _system(**_EVERYTHING, context=_MEDIA_CONTEXT)

        assert "That detail sits with our" not in prompt
        assert "owns the latest on that" not in prompt
        assert 'never use "sits with our team"' in self._gap(**_PAID)

    def test_a_paid_plan_ends_a_gap_with_the_offer_and_free_does_not(self):
        assert "end with a team offer (TEAM OFFERS)" in self._gap(**_PAID)
        assert "team offer" not in self._gap(**_FREE)
        assert "TEAM OFFERS" not in _system(**_FREE)

    def test_the_old_ban_on_admitting_a_gap_is_gone(self):
        """VOICE told the model never to admit a gap while 5a gave it an honest
        gap sentence; the model resolved the conflict with euphemisms."""
        prompt = _system(**_PAID)

        assert "never expose internal limitations" not in prompt
        assert 'never say "I don\'t have that information"' not in prompt


class TestFirstPersonClaimsNeedTheCompanysOwnPages:
    def test_reports_and_locations_are_own_claims(self):
        rule = _flat(_section(_system(**_PAID), "OWN CREDENTIALS AND TERMS.", "\n  (a) GAP."))

        assert "an audit report (for example a SOC 2 report)" in rule
        assert "office, SOC or team locations" in rule

    def test_a_borrowed_figure_points_at_the_team_only_when_there_is_one(self):
        """Review, 2026-09-17: the Free plan has no team path, yet RULE 5a told
        the model to say our exact terms come from our team."""
        paid = _flat(_section(_system(**_PAID), "OWN CREDENTIALS AND TERMS.", "\n  (a) GAP."))
        free = _flat(_section(_system(**_FREE), "OWN CREDENTIALS AND TERMS.", "\n  (a) GAP."))

        assert "say our exact terms come from our team." in paid
        assert "come from our team" not in free
        assert "say we don't publish that figure here." in free

    def test_topic_pages_describe_the_topic_not_the_company(self):
        rule = _flat(_section(_system(**_PAID), "OWN CREDENTIALS AND TERMS.", "\n  (a) GAP."))

        assert "A general article, buyer checklist or industry guide describes the topic" in rule
        assert 'So do listicles, templates, comparison articles and "how to choose a provider" pages.' in rule


class TestTeamOffers:
    _EXAMPLES = re.compile(r'"((?:Want|Would)[^"]*\?)"')

    def _offers(self, **kwargs) -> str:
        return _section(_system(**kwargs), "TEAM OFFERS:", "\n\n")

    @pytest.mark.parametrize("plan", ["paid", "offline", "async"])
    def test_every_example_offer_is_read_as_an_offer_and_not_as_a_handoff(self, plan):
        """A "yes" after the offer opens the form only when
        ``bot_offers_handoff`` recognises the offer. The offer itself must not
        read as a handoff that already started, or the form opens unasked."""
        examples = self._EXAMPLES.findall(self._offers(**_PLANS[plan]))

        assert examples, plan
        for offer in examples:
            reply = f"We run a 24x7 SOC.\n\n{offer}"
            assert bot_offers_handoff(reply), offer
            assert not _response_suggests_handoff(reply), offer

    def test_the_offer_is_a_question_and_does_not_announce_a_form(self):
        offers = _flat(self._offers(**_PAID))

        assert "Make it a question the visitor can accept, alone in the last paragraph" in offers
        assert "Do not say a form is opening or that someone will contact them" in offers
        assert "unless the visitor asked for a person or said yes to your offer" in offers

    def test_a_plan_without_a_human_path_has_no_offer(self):
        assert "TEAM OFFERS" not in _system(**_FREE)

    def test_no_example_anywhere_reads_as_a_started_handoff(self):
        """The old meeting fallback and team-connect examples said "connect you
        with our team", which the handoff safety net treats as a started handoff."""
        for plan in _PLANS.values():
            system, user = _build(**{**_EVERYTHING, **plan, "meeting_booking_enabled": False})
            assert "connect you with our team" not in system + user
        _system_prompt, user = _build(**_PAID, team_connect_offer=True)
        assert "connect you with our team" not in user
        assert "Would you like to connect with our team?" in user


class TestARequestForAPersonEndsWithAnOffer:
    """In English a request for a person gets the fixed handoff reply, so the
    model writes the support block's reply only when the handoff classifier said
    no. Model text never opens the form, so the reply must be a question the
    visitor can accept: a "yes" to it on the next turn is the consent."""

    _EXAMPLES = re.compile(r'"((?:Want|Would)[^"]*\?)"')

    def _support(self, plan: str) -> str:
        system = _system(**_PLANS[plan])
        start = "LIVE SUPPORT:" if "LIVE SUPPORT:" in system else "SUPPORT REQUESTS ("
        return _flat(_section(system, start, "LEAVE A MESSAGE"))

    @pytest.mark.parametrize("plan", ["paid", "offline"])
    def test_every_example_is_an_offer_and_not_a_started_handoff(self, plan):
        examples = self._EXAMPLES.findall(self._support(plan))

        assert examples, plan
        for offer in examples:
            assert bot_offers_handoff(offer), offer
            assert not _response_suggests_handoff(offer), offer

    def test_live_support_asks_instead_of_announcing(self):
        support = self._support("paid")

        assert '"Would you like to speak with our team now?"' in support
        assert "will be with them shortly" not in support
        assert "Do not say a team member is on the way" in support

    def test_the_offline_reply_ends_with_the_message_offer(self):
        support = self._support("offline")

        assert "our team will be notified and will get back to them" in support
        assert 'then ask "Want me to take a message for our team?"' in support


class TestFeaturedServices:
    def _services(self) -> str:
        return _flat(_section(_system(**_EVERYTHING), "FEATURED SERVICES", "\n\n"))

    def test_the_list_is_not_exhaustive(self):
        services = self._services()

        assert "this list is NOT everything we offer" in services
        assert "offers exactly the following services" not in _system(**_EVERYTHING)

    def test_other_offerings_in_the_reference_are_listed_too(self):
        assert (
            "When asked what we offer, list these first, then every other offering the REFERENCE INFORMATION names."
            in self._services()
        )

    def test_a_denial_needs_both_sources_silent(self):
        assert (
            "Say we do not offer something only when neither this list nor the REFERENCE INFORMATION mentions it"
            in self._services()
        )

    def test_a_locations_question_is_not_a_services_question(self):
        assert (
            "Questions about our locations, SOC centres, offices, teams or people are not services questions"
            in self._services()
        )

    def test_the_link_icon_still_uses_only_configured_urls(self):
        services = self._services()

        assert "https://acme.com/analytics" in services
        assert "[↗](url)" in services


class TestScope:
    def _scope(self, **kwargs) -> str:
        return _flat(_section(_system(**kwargs), "SCOPE:", "\nVOICE:"))

    def test_general_coding_help_is_out_of_scope(self):
        assert "general coding or debugging help that is not about Acme's own product" in self._scope(**_PAID)

    def test_small_talk_is_answered_without_banned_openers(self):
        scope = self._scope(**_PAID)

        assert "SMALL TALK" in scope
        for opener in ("Doing great", "Doing well, thanks", "Of course.", "Absolutely."):
            assert opener not in _system(**_EVERYTHING, context=_MEDIA_CONTEXT), opener

    def test_frustration_gets_an_acknowledgement_and_a_next_step(self):
        scope = self._scope(**_PAID)

        assert "FRUSTRATION" in scope
        assert "acknowledge it in one short clause, then give a concrete next step" in scope
        assert 'A bare apology such as "Sorry to hear that." is not a reply.' in scope
        assert "or the team offer" in scope

    def test_frustration_on_a_free_plan_does_not_offer_the_team(self):
        scope = self._scope(**_FREE)

        assert "FRUSTRATION" in scope
        assert "team offer" not in scope

    def test_a_short_follow_up_is_judged_with_the_conversation(self):
        assert "a short follow-up to your previous reply is on-scope" in self._scope(**_PAID)


class TestTheCompanyDescription:
    def test_it_is_marked_as_a_third_person_summary_below_the_reference(self):
        prompt = _flat(_system(**_EVERYTHING))

        assert 'ABOUT Acme (a summary written from the website. It may be in the third person: speak as "we".' in prompt
        assert "Where it differs from the REFERENCE INFORMATION, the REFERENCE INFORMATION wins" in prompt
        assert "COMPANY CONTEXT" not in prompt


class TestMixedPricingTurn:
    _LINE = "THIS TURN, PRICING:"

    def test_the_line_appears_only_on_a_mixed_pricing_turn(self):
        assert self._LINE not in _user(**_PAID)
        assert self._LINE in _user(**_PAID, pricing_mixed=True)

    def test_it_keeps_the_other_parts_and_drops_every_figure(self):
        line = _flat(_section(_user(**_PAID, pricing_mixed=True), self._LINE, "\n\n"))

        assert "Answer every other part fully." in line
        assert "Do not state any price, fee, rate or plan amount, even one in the REFERENCE INFORMATION." in line
        assert "our team confirms pricing" in line

    def test_a_plan_without_a_human_path_does_not_promise_the_team(self):
        line = _flat(_section(_user(**_FREE, pricing_mixed=True), self._LINE, "\n\n"))

        assert "team" not in line

    def test_the_system_prompt_is_unchanged_by_it(self):
        """The flag is per turn, so it must not break the cached system prefix."""
        assert _system(**_PAID) == _system(**_PAID, pricing_mixed=True)

    def test_the_stream_pipeline_passes_the_deferred_outcome(self):
        import inspect

        from app.services import rag_service as rs

        source = inspect.getsource(rs.rag_pipeline_stream)
        assert 'pricing_mixed=_pricing_decision.outcome == "escalate_deferred"' in source


class TestNoDashesOutsideThePinnedRule:
    """The prompt bans the em dash and used to model it. The style rule and its
    cross-marked example keep the literal character (test_em_dash_prompt_rules)."""

    @pytest.mark.parametrize("plan", sorted(_PLANS))
    def test_only_the_pinned_rule_carries_an_em_dash(self, plan):
        system, user = _build(
            context=_MEDIA_CONTEXT,
            history="USER: hi\nBOT: hello",
            bant_state={"need": "x", "need_score": 20},
            **{**_EVERYTHING, **_PLANS[plan]},
        )
        lines = [line for line in (system + "\n" + user).splitlines() if "—" in line or "–" in line]

        assert all("—" in line and "–" not in line for line in lines), lines
        assert len(lines) == 2, lines
        assert any("em-dash character (—)" in line for line in lines)
        assert any(line.strip().startswith("✗") for line in lines)

    @pytest.mark.parametrize("flags", [{"quote_imminent": True}, {"probe_ok": False}, {}])
    def test_the_qualification_text_has_no_dash(self, flags):
        user = _user(**_PAID, history="USER: hi\nBOT: hello", **flags)

        assert "—" not in user
        assert "–" not in user


class TestNoInventedRoles:
    def test_the_role_acknowledgement_invents_nothing(self):
        system, user = _build(**_PAID, history="USER: hi\nBOT: hello")
        prompt = (system + "\n" + user).lower()

        for invented in ("solutions engineer", "enterprise csm", "ciso", "primary buyer"):
            assert invented not in prompt, invented
        assert "do not invent team roles, programmes or processes" in prompt


class TestRoleAcknowledgment:
    """Post-deploy evaluation, 2026-09-17: the rule's example sentence, "Good to know
    you're the one signing off", was copied onto an MSP, a head of IT and a visitor
    filling in a form, none of whom said they approve the purchase."""

    def test_the_rule_has_no_quotable_example_and_does_not_assume_a_decision_maker(self):
        system, user = _build(history="USER: hi\nBOT: hello", **_PAID)
        prompt = _flat(system + "\n" + user)
        rule = prompt[prompt.index("ROLE ACKNOWLEDGMENT:") :].split(" - ", 1)[0]
        assert '"' not in rule
        assert "signing off" not in prompt.lower()
        assert "Never say they approve or sign off unless they said so" in rule
