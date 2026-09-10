"""A pricing escalation names what the visitor asked about.

Reported from a live bot on 2026-09-10. Every pricing escalation there in the
previous two weeks read "Pricing for Eventus Security is best confirmed by the
team", including "pricing of red teaming", "pricing for managed soc" and "soc
pricng". The visitor asked about one service and was answered about the whole
company, because ``pricing_pivot`` only ever received the company name.

``pricing_subject`` recovers the service from the question, but only a phrase
the bot's own retrieved content spells as a name. Nothing the visitor typed is
echoed back unless the knowledge base already says it, and a question with no
such phrase keeps the company wording it has today.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.pricing_gate import pricing_pivot, pricing_subject
from app.services.rag_service import _HANDOFF_OFFER_RE


def _chunk(content, document_name="https://acme.com/services/"):
    return SimpleNamespace(content=content, document_name=document_name)


_KB = [
    _chunk("Our SOC team watches your estate around the clock. SOC as a Service includes threat hunting."),
    _chunk(
        "Red Teaming engagements simulate a real adversary. Every Red Teaming exercise is scoped with you.",
        "https://acme.com/services/red-teaming/",
    ),
    _chunk("Managed SOC gives a growing team a 24/7 SOC without hiring. Each startup we work with is different."),
    _chunk("Read more at https://acme.com/cloud-hardening/pricing/ before you start."),
]


class TestTheSubjectComesFromTheQuestion:
    @pytest.mark.parametrize(
        ("question", "subject"),
        [
            ("iwant to know the soc pricng ?", "SOC"),
            ("pricing for managed soc", "Managed SOC"),
            ("pricing of red teaming ", "Red Teaming"),
            ("how much does SOC as a Service cost?", "SOC as a Service"),
            ("Price of soc ?", "SOC"),
        ],
    )
    def test_the_service_asked_about(self, question, subject):
        assert pricing_subject(question, "Acme", _KB) == subject

    def test_the_spelling_is_the_knowledge_base_s_not_the_visitor_s(self):
        assert pricing_subject("pricing for MANAGED soc", "Acme", _KB) == "Managed SOC"


class TestNoSubjectMeansTheWordingStaysAsItIs:
    @pytest.mark.parametrize(
        "question",
        [
            "what is the pricing ?",
            "can i get the quotation ?",
            "give me pricing for your services",
            "how much does it cost?",
            "what does Acme charge",
        ],
    )
    def test_a_general_pricing_question(self, question):
        assert pricing_subject(question, "Acme", _KB) is None

    def test_a_word_the_knowledge_base_never_names_is_not_echoed(self):
        """ "kubernetes hardening" appears nowhere, so it is never repeated to
        the visitor as if it were something we sell."""
        assert pricing_subject("pricing for kubernetes hardening", "Acme", _KB) is None

    def test_an_ordinary_word_is_not_mistaken_for_a_service(self):
        """ "startup" is in the content, but only as a common noun. A reply of
        "Pricing for startup" would be worse than naming the company."""
        assert pricing_subject("pricing for my startup", "Acme", _KB) is None

    def test_one_stray_capital_does_not_make_a_name(self):
        """Measured on Eventus content: "stages of a Startup in emerging
        markets" once, "startup" once. A tie is not a name."""
        kb = [_chunk("the Business Development stages of a Startup in emerging markets. Any startup can apply.")]
        assert pricing_subject("pricing for my startup", "Acme", kb) is None

    def test_a_single_leading_capital_needs_repeating(self):
        assert pricing_subject("pricing for onboarding", "Acme", [_chunk("Onboarding takes a week.")]) is None
        kb = [_chunk("Onboarding takes a week. Onboarding includes training.")]
        assert pricing_subject("pricing for onboarding", "Acme", kb) == "Onboarding"

    def test_a_word_that_only_appears_inside_a_url_does_not_count(self):
        assert pricing_subject("cloud hardening pricing", "Acme", _KB) is None

    def test_the_company_name_is_never_the_subject(self):
        kb = [_chunk("Acme Cloud runs SOC operations. Acme Cloud is our brand.")]
        assert pricing_subject("Acme Cloud SOC pricing", "Acme Cloud", kb) == "SOC"
        assert pricing_subject("acme cloud pricing", "Acme Cloud", kb) is None


class TestTheSubjectIsSafeToRender:
    def test_markdown_around_the_name_is_not_carried_into_the_reply(self):
        kb = [_chunk("Our **SOC** is staffed 24/7, and the _SOC_ desk escalates in minutes.")]
        assert pricing_subject("soc pricing", "Acme", kb) == "SOC"

    def test_a_long_phrase_is_capped(self):
        kb = [_chunk("The Advanced Cloud Native Threat Detection And Response Suite is new.")]
        subject = pricing_subject("pricing for advanced cloud native threat detection and response suite", "Acme", kb)
        assert subject is None or len(subject.split()) <= 5

    @pytest.mark.parametrize(
        ("question", "chunks"),
        [
            (None, _KB),
            ("", _KB),
            ("soc pricing", None),
            ("soc pricing", []),
            ("soc pricing", [SimpleNamespace(content=None, document_name=None), SimpleNamespace()]),
        ],
    )
    def test_bad_input_returns_none_rather_than_raising(self, question, chunks):
        assert pricing_subject(question, "Acme", chunks) is None


def _pivot(**overrides):
    kwargs = dict(
        company_name="Acme",
        pricing_url=None,
        support_enabled=True,
        live_chat_enabled=True,
        contact_url=None,
        repeat=False,
        subject="SOC",
    )
    kwargs.update(overrides)
    return pricing_pivot(**kwargs)


_BRANCHES = [
    ("paid_live_chat", dict(support_enabled=True, live_chat_enabled=True)),
    ("paid_message_card", dict(support_enabled=True, live_chat_enabled=False)),
    (
        "free_with_pricing_page",
        dict(support_enabled=False, live_chat_enabled=False, pricing_url="https://acme.com/pricing"),
    ),
    (
        "free_with_contact_page",
        dict(support_enabled=False, live_chat_enabled=False, contact_url="https://acme.com/contact"),
    ),
    ("free_with_nothing", dict(support_enabled=False, live_chat_enabled=False)),
]


class TestThePivotNamesTheSubject:
    def test_the_reported_reply(self):
        assert _pivot().text == (
            "Pricing for **SOC** at **Acme** is best confirmed by the team so you get an accurate figure. "
            "Want me to connect you with them now?"
        )

    @pytest.mark.parametrize("repeat", [False, True])
    @pytest.mark.parametrize(("branch", "flags"), _BRANCHES, ids=[b[0] for b in _BRANCHES])
    def test_every_branch_names_it(self, branch, flags, repeat):
        assert "**SOC**" in _pivot(repeat=repeat, **flags).text, branch

    @pytest.mark.parametrize("repeat", [False, True])
    @pytest.mark.parametrize(("branch", "flags"), _BRANCHES, ids=[b[0] for b in _BRANCHES])
    def test_no_subject_is_byte_identical_to_before(self, branch, flags, repeat):
        without = _pivot(repeat=repeat, subject=None, **flags)
        legacy = pricing_pivot(
            company_name="Acme",
            pricing_url=flags.get("pricing_url"),
            support_enabled=flags["support_enabled"],
            live_chat_enabled=flags["live_chat_enabled"],
            contact_url=flags.get("contact_url"),
            repeat=repeat,
        )
        assert without == legacy, branch

    def test_without_a_company_name_it_still_reads_naturally(self):
        text = _pivot(company_name=None).text
        assert text.startswith("Pricing for **SOC** is best confirmed by the team")
        assert "**None**" not in text
        assert " at us" not in text

    @pytest.mark.parametrize("live", [True, False])
    def test_the_paid_repeat_is_still_an_offer_a_yes_can_accept(self, live):
        again = _pivot(repeat=True, live_chat_enabled=live)
        assert _HANDOFF_OFFER_RE.search(again.text), again.text
        assert again.text != _pivot(repeat=False, live_chat_enabled=live).text

    @pytest.mark.parametrize(("branch", "flags"), _BRANCHES[2:], ids=[b[0] for b in _BRANCHES[2:]])
    def test_free_still_names_no_team_and_offers_no_channel(self, branch, flags):
        for repeat in (False, True):
            pivot = _pivot(repeat=repeat, **flags)
            assert "team" not in pivot.text.lower(), branch
            assert "connect" not in pivot.text.lower(), branch
            assert pivot.suggest_handoff is False
            assert pivot.needs_message_card is False

    def test_the_flags_do_not_depend_on_the_subject(self):
        for _branch, flags in _BRANCHES:
            for repeat in (False, True):
                a = _pivot(repeat=repeat, **flags)
                b = _pivot(repeat=repeat, subject=None, **flags)
                assert (a.suggest_handoff, a.needs_message_card) == (b.suggest_handoff, b.needs_message_card)
