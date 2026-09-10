"""A second pricing ask must not get the first answer again.

Reported from a live bot on 2026-09-10. One visitor asked for pricing, was told
"Pricing for Eventus Security is best confirmed by the team so you get an
accurate figure. Want me to connect you with them now?" and was shown the
"Talk to a human" form. Four minutes later they asked again and received the
identical sentence and the form a second time. Every branch of ``pricing_pivot``
returned one fixed string, so it could not have done anything else.

These tests hold the pivot's side of the fix. The pipeline's side, that the
second ask in a session is the one marked as a repeat, is in
``test_pricing_gate_e2e.py``.
"""

from __future__ import annotations

import pytest

from app.services.pricing_gate import pricing_pivot
from app.services.rag_service import _HANDOFF_OFFER_RE

_BRANCHES = [
    # (id, support_enabled, live_chat_enabled, pricing_url, contact_url)
    ("free_with_pricing_page", False, False, "https://acme.com/pricing", None),
    ("free_with_contact_page", False, False, None, "https://acme.com/contact"),
    ("free_with_nothing", False, False, None, None),
    ("paid_live_chat", True, True, None, None),
    ("paid_message_card", True, False, None, None),
]


def _pivot(support, live, pricing_url, contact_url, *, repeat):
    return pricing_pivot(
        company_name="Acme",
        pricing_url=pricing_url,
        support_enabled=support,
        live_chat_enabled=live,
        contact_url=contact_url,
        repeat=repeat,
    )


class TestEveryBranchSaysSomethingNew:
    @pytest.mark.parametrize(("branch", "support", "live", "url", "contact"), _BRANCHES, ids=[b[0] for b in _BRANCHES])
    def test_the_repeat_is_worded_differently(self, branch, support, live, url, contact):
        first = _pivot(support, live, url, contact, repeat=False)
        again = _pivot(support, live, url, contact, repeat=True)
        assert again.text != first.text, branch
        assert again.text.strip(), branch

    @pytest.mark.parametrize(("branch", "support", "live", "url", "contact"), _BRANCHES, ids=[b[0] for b in _BRANCHES])
    def test_the_first_ask_is_unchanged(self, branch, support, live, url, contact):
        """``repeat`` defaults to False and the first-time copy is byte-identical,
        so nothing that already depended on it moves."""
        assert (
            _pivot(support, live, url, contact, repeat=False).text
            == pricing_pivot(
                company_name="Acme",
                pricing_url=url,
                support_enabled=support,
                live_chat_enabled=live,
                contact_url=contact,
            ).text
        )


class TestTheFormIsNotOfferedTwice:
    """Re-opening the form was half of what made the repeat read as a loop."""

    def test_a_live_chat_repeat_does_not_reopen_the_handoff_form(self):
        assert _pivot(True, True, None, None, repeat=False).suggest_handoff is True
        assert _pivot(True, True, None, None, repeat=True).suggest_handoff is False

    def test_a_message_card_repeat_does_not_reopen_the_card(self):
        assert _pivot(True, False, None, None, repeat=False).needs_message_card is True
        assert _pivot(True, False, None, None, repeat=True).needs_message_card is False


class TestAPlainYesStillReachesTheTeam:
    """With the form not re-opened, the offer has to live in the words, and the
    pipeline only treats "yes" as a handoff request when the previous bot
    message matches ``_HANDOFF_OFFER_RE``. A repeat that did not match would
    leave a visitor who says yes with nowhere to go."""

    @pytest.mark.parametrize("live", [True, False])
    def test_the_paid_repeat_is_recognised_as_an_offer(self, live):
        again = _pivot(True, live, None, None, repeat=True)
        assert _HANDOFF_OFFER_RE.search(again.text), again.text

    def test_the_paid_repeat_still_names_the_team(self):
        assert "team" in _pivot(True, True, None, None, repeat=True).text.lower()


class TestFreeRepeatsKeepFreeRules:
    """Free has no in-chat channel on the second ask any more than on the first."""

    @pytest.mark.parametrize(
        ("url", "contact"), [("https://acme.com/pricing", None), (None, "https://acme.com/contact"), (None, None)]
    )
    def test_no_team_no_connect_no_form(self, url, contact):
        again = _pivot(False, False, url, contact, repeat=True)
        assert "team" not in again.text.lower()
        assert "connect" not in again.text.lower()
        assert again.suggest_handoff is False
        assert again.needs_message_card is False

    def test_the_pricing_page_is_still_handed_over(self):
        assert "https://acme.com/pricing" in _pivot(False, False, "https://acme.com/pricing", None, repeat=True).text

    def test_the_contact_page_is_still_handed_over(self):
        assert "https://acme.com/contact" in _pivot(False, False, None, "https://acme.com/contact", repeat=True).text

    @pytest.mark.parametrize("unusable", ["javascript:alert(1)", "mailto:hi@acme.com", "   ", "//acme.com/x"])
    def test_an_unusable_url_is_still_refused_on_the_repeat(self, unusable):
        """The sanitising runs before either wording is chosen, so a repeat can
        no more render "javascript:alert(1)" to a visitor than a first ask can."""
        again = _pivot(False, False, unusable, unusable, repeat=True)
        assert "javascript:" not in again.text
        assert "mailto:" not in again.text
        assert "http" not in again.text

    def test_no_company_name_still_reads_naturally(self):
        again = pricing_pivot(
            company_name=None, pricing_url=None, support_enabled=True, live_chat_enabled=True, repeat=True
        )
        assert "**None**" not in again.text
