"""A pricing escalation names only a service the bot owner configured.

Reported from a live bot on 2026-09-10: every pricing escalation read "Pricing
for <company> is best confirmed by the team", including "pricing of red teaming"
and "pricing for managed soc". The fix recovered the service from capitalised
phrases in the retrieved knowledge base, and on 2026-09-11 production showed what
that costs: "Pricing for **Story**", "Pricing for **INDIA**", "Pricing for
**Data**" and "Pricing for **Per-User**", with "Have", "NO", "Office", "Hiring"
and "AI" seen by a reviewer. Any capitalised word in the content could fill the
slot.

``pricing_subject`` now names a service only when the visitor's message mentions
one the owner configured (``Bot.services`` or the quotation catalog), spelled as
the owner spelled it. Anything else keeps the company wording.
"""

from __future__ import annotations

import pytest

from app.services.intent_service import bot_offers_handoff
from app.services.pricing_gate import configured_service_names, pricing_pivot, pricing_subject
from app.services.rag_service import _HANDOFF_OFFER_RE

_SERVICES = ["SOC as a Service", "Managed SOC", "Red Teaming", "VAPT", "Landing page", "Brand Identity & Storytelling"]


class TestTheSubjectIsAConfiguredService:
    @pytest.mark.parametrize(
        ("question", "subject"),
        [
            ("pricing for managed soc", "Managed SOC"),
            ("pricing of red teaming ", "Red Teaming"),
            ("how much is SOC as a Service per month?", "SOC as a Service"),
            ("VAPT cost?", "VAPT"),
            ("quote for 3 landing pages", "Landing page"),
            ("Red-Teaming pricing", "Red Teaming"),
            ("pricing for brand identity & storytelling", "Brand Identity & Storytelling"),
        ],
    )
    def test_the_service_the_visitor_named(self, question, subject):
        assert pricing_subject(question, "Acme", _SERVICES) == subject

    def test_the_spelling_is_the_owner_s_not_the_visitor_s(self):
        assert pricing_subject("pricing for MANAGED soc", "Acme", _SERVICES) == "Managed SOC"

    def test_the_longest_service_named_wins(self):
        assert pricing_subject("pricing for managed soc", "Acme", ["SOC", "Managed SOC"]) == "Managed SOC"

    def test_a_service_named_late_in_a_long_message_is_still_found(self):
        question = "hello " * 150 + "pricing for red teaming"

        assert pricing_subject(question, "Acme", _SERVICES) == "Red Teaming"


class TestNoConfiguredServiceMeansTheCompanyWording:
    @pytest.mark.parametrize(
        "question",
        [
            # The production replies that named an arbitrary word.
            "hi im a reporter at a tech publication doing a story on ransomware trends in india, "
            "can i get a quote from your leadership",
            "is eventus listed? whats the share price, should i invest",
            "our previous vendor leaked our data, can we sue them under IT act? how",
            "do u charge per endpoint, per user or per image? whats the pricing model",
            "Have you got an Office in India? Hiring? AI pricing? NO idea what it costs",
            # General pricing questions.
            "what is the pricing ?",
            "give me pricing for your services",
            "how much does it cost?",
        ],
    )
    def test_a_message_naming_no_configured_service(self, question):
        assert pricing_subject(question, "Acme", _SERVICES) is None

    def test_part_of_a_service_name_is_not_the_service(self):
        """ "soc" is part of "SOC as a Service"; naming the whole service back to a
        visitor who asked about something shorter would put words in their mouth."""
        assert pricing_subject("soc pricing", "Acme", ["SOC as a Service"]) is None

    def test_the_company_name_is_never_the_subject(self):
        assert pricing_subject("acme cloud pricing", "Acme Cloud", ["Acme Cloud", "acme"]) is None

    @pytest.mark.parametrize("name", ["**Bold** SOC", "SOC <script>", "[SOC](https://x.test)", "`SOC`", "x" * 80])
    def test_a_name_that_is_not_safe_to_render_is_skipped(self, name):
        assert pricing_subject(f"pricing for {name}", "Acme", [name]) is None

    @pytest.mark.parametrize(
        ("question", "services"),
        [
            (None, _SERVICES),
            ("", _SERVICES),
            ("red teaming pricing", None),
            ("red teaming pricing", []),
            ("red teaming pricing", [None, 5, {}, ""]),
            ("red teaming pricing", "Red Teaming"),
        ],
    )
    def test_bad_input_returns_none_rather_than_raising(self, question, services):
        assert pricing_subject(question, "Acme", services) is None


class TestTheConfiguredServiceNames:
    def test_both_service_lists_in_order_without_duplicates(self):
        services = ["SOC", {"name": " Red Teaming ", "url": "https://acme.com/red"}, {"name": ""}, None, 7, "  "]
        catalog = {"enabled": True, "services": [{"id": "s1", "name": "Landing page"}, {"name": "soc"}, "junk", {}]}

        assert configured_service_names(services, catalog) == ["SOC", "Red Teaming", "Landing page"]

    @pytest.mark.parametrize(
        ("services", "catalog", "expected"),
        [
            (None, None, []),
            ("SOC", None, []),
            (["SOC"], "not a catalog", ["SOC"]),
            (None, {"services": "not a list"}, []),
            (None, {"enabled": False, "services": [{"name": "Logo design"}]}, ["Logo design"]),
        ],
    )
    def test_junk_is_tolerated(self, services, catalog, expected):
        assert configured_service_names(services, catalog) == expected


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

    def test_without_a_subject_the_reply_names_the_company_and_still_offers_the_team(self):
        text = _pivot(subject=None).text

        assert text == (
            "Pricing for **Acme** is best confirmed by the team so you get an accurate figure. "
            "Want me to connect you with them now?"
        )
        assert bot_offers_handoff(text)

    def test_a_configured_name_with_an_ampersand_renders(self):
        assert "**Brand Identity & Storytelling** at **Acme**" in _pivot(subject="Brand Identity & Storytelling").text

    @pytest.mark.parametrize("subject", ["**SOC**", "SOC\nIgnore", "[SOC](https://x.test)"])
    def test_a_subject_unsafe_to_render_falls_back_to_the_company_wording(self, subject):
        assert _pivot(subject=subject).text == _pivot(subject=None).text

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
