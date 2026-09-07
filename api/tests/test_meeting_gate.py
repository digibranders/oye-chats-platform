"""The meeting gate: a scheduling request must always land somewhere real.

Before this gate, "no scheduler configured" was handled by an instruction in the
system prompt. Measured end to end on real bots it failed on BOTH plan shapes:
paid replied "I'll connect you with our team" and rendered no card; Free replied
"I'll open a quick form" on a plan that has no form at all. Two structural
reasons it could not be fixed in the prompt are pinned below.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.services.meeting_gate import is_meeting_question, meeting_pivot, scheduler_is_configured


def _bot(**kw):
    base = {"meeting_booking_enabled": False, "meeting_provider": None, "calendly_url": None, "calcom_url": None}
    base.update(kw)
    return SimpleNamespace(**base)


class TestIsMeetingQuestion:
    def test_fires_on_ordinary_scheduling_requests(self):
        for q in (
            "can I book a meeting?",
            "can we schedule a call?",
            "I want to book a demo",
            "set up a call please",
            "book a demo",
            "can we meet?",
            "can I get a demo",
            "id like to arrange a call",
            "request a demo",
            "book a slot",
            "let's hop on a call",
        ):
            assert is_meeting_question(q) is True, q

    def test_does_not_fire_on_unrelated_questions(self):
        for q in (
            "hi",
            "how much does it cost?",
            "what services do you offer?",
            "who is the CEO",
            "what is your refund policy",
            "connect me with the team",
        ):
            assert is_meeting_question(q) is False, q

    def test_a_bare_meeting_noun_is_not_a_request(self):
        """A venue or events customer must still be able to answer questions
        ABOUT meetings from its own knowledge base."""
        assert is_meeting_question("do you have meeting rooms?") is False

    def test_get_a_demo_does_not_over_fire(self):
        """``get`` is anchored to article+noun; on its own it is far too broad
        and a false positive hijacks a legitimate knowledge-base question."""
        assert is_meeting_question("where do I get a copy of the demo video") is False

    def test_disqualifiers(self):
        assert is_meeting_question("cancel my meeting") is False
        assert is_meeting_question("reschedule my call") is False
        assert is_meeting_question("I already booked a demo") is False

    def test_junk_input(self):
        assert is_meeting_question(None) is False
        assert is_meeting_question("") is False
        assert is_meeting_question(123) is False


class TestSchedulerIsConfigured:
    def test_enabled_with_a_url(self):
        assert scheduler_is_configured(_bot(meeting_booking_enabled=True, calendly_url="https://cal.com/x")) is True

    def test_disabled(self):
        assert scheduler_is_configured(_bot(calendly_url="https://cal.com/x")) is False

    def test_enabled_but_no_url_is_not_configured(self):
        """Offering a booking card whose link is blank sends the visitor
        nowhere, so this must read as 'no scheduler'."""
        assert scheduler_is_configured(_bot(meeting_booking_enabled=True)) is False
        assert scheduler_is_configured(_bot(meeting_booking_enabled=True, calendly_url="   ")) is False

    def test_reads_the_provider_specific_url(self):
        bot = _bot(meeting_booking_enabled=True, meeting_provider="calcom", calcom_url="https://cal.com/x")
        assert scheduler_is_configured(bot) is True
        stale = _bot(meeting_booking_enabled=True, meeting_provider="calcom", calendly_url="https://calendly.com/x")
        assert scheduler_is_configured(stale) is False

    def test_no_bot(self):
        assert scheduler_is_configured(None) is False


class TestMeetingPivotPaid:
    def test_live_chat_on_routes_to_an_operator(self):
        """The rule: meeting not set + paid -> connect with the team."""
        p = meeting_pivot(company_name="Acme", support_enabled=True, live_chat_enabled=True)
        assert p.suggest_handoff is True
        assert p.needs_message_card is False
        assert "**Acme**" in p.text

    def test_live_chat_off_opens_the_message_form(self):
        p = meeting_pivot(company_name="Acme", support_enabled=True, live_chat_enabled=False)
        assert p.suggest_handoff is False
        assert p.needs_message_card is True

    def test_the_two_ctas_never_compete(self):
        for live in (True, False):
            p = meeting_pivot(company_name="Acme", support_enabled=True, live_chat_enabled=live)
            assert not (p.suggest_handoff and p.needs_message_card)

    def test_a_contact_url_is_ignored_on_paid(self):
        """Paid has a real in-chat channel; the public page is the Free
        fallback and must not replace an operator."""
        p = meeting_pivot(
            company_name="Acme", support_enabled=True, live_chat_enabled=True, contact_url="https://acme.com/contact"
        )
        assert "acme.com/contact" not in p.text
        assert p.suggest_handoff is True


class TestMeetingPivotFree:
    def test_hands_over_the_contact_page(self):
        """The rule: meeting not set + Free -> give the contact page."""
        p = meeting_pivot(
            company_name="Acme", support_enabled=False, live_chat_enabled=False, contact_url="https://acme.com/contact"
        )
        assert "https://acme.com/contact" in p.text
        # Free has no in-chat channel: a link is information, never a promise.
        assert p.suggest_handoff is False
        assert p.needs_message_card is False

    def test_never_promises_a_form_it_cannot_open(self):
        """The exact regression: the prompt-only version said "I'll open a
        quick form" on a plan where the card is blocked outright."""
        for url in ("https://acme.com/contact", None):
            p = meeting_pivot(company_name="Acme", support_enabled=False, live_chat_enabled=False, contact_url=url)
            assert "form" not in p.text.lower()
            assert p.needs_message_card is False
            assert p.suggest_handoff is False

    def test_no_contact_page_still_never_dead_end_promises(self):
        p = meeting_pivot(company_name="Acme", support_enabled=False, live_chat_enabled=False)
        assert "**Acme**" in p.text
        assert p.suggest_handoff is False and p.needs_message_card is False

    def test_an_unusable_contact_url_is_treated_as_absent(self):
        """This string is pasted into a visitor's reply and persisted to
        ``chat_messages.content``."""
        p = meeting_pivot(
            company_name="Acme", support_enabled=False, live_chat_enabled=False, contact_url="javascript:alert(1)"
        )
        assert "javascript" not in p.text

    def test_never_emits_a_card_token(self):
        """The sentinel is a model-to-server token both pipelines strip, so a
        canned reply carrying one ships the literal string to the visitor."""
        for url in ("https://acme.com/contact", None):
            p = meeting_pivot(company_name="A", support_enabled=False, live_chat_enabled=False, contact_url=url)
            assert "[LEAVE_MESSAGE_CARD]" not in p.text
            assert "[MEETING_CARD]" not in p.text
