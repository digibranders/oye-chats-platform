"""The prompt does not offer what the runtime cannot deliver.

Three cases where it did, all found by reading the prompt against the code that
executes its promises:

1. A bot with meeting booking switched on but no provider URL was told to emit
   a booking card. Post-processing then dropped the card, because there was
   nowhere to send the visitor, so they were told "I'll set that up" with
   nothing attached.
2. On a plan with no human channel, the no-scheduler branch told the model to
   offer the team and emit a message card, while the NO HUMAN HANDOFF section
   of the same prompt forbade exactly that. Two blocks, one prompt, opposite
   instructions.
3. The LIVE SUPPORT block promised "a team member will be with you shortly"
   whenever live chat was on. ``business_hours`` had no reader anywhere in the
   pipeline, so that promise was made at 3am, and the widget then showed the
   offline form.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.services.rag_service import build_hybrid_prompt

_CLIENT = SimpleNamespace(name="Acme")
_CONTEXT = "<<<DOCUMENT 1 | about.md>>>\nAcme builds analytics tooling.\n<<<END DOCUMENT 1>>>\n"


def _prompt(**kwargs) -> str:
    system, _user = build_hybrid_prompt(_CLIENT, "can I book a demo?", _CONTEXT, "", company_name="Acme", **kwargs)
    return system


class TestBookingIsOnlyOfferedWhenItExists:
    def test_a_configured_scheduler_gets_the_booking_card_rules(self):
        prompt = _prompt(meeting_booking_enabled=True)

        assert "[MEETING_CARD]" in prompt
        assert "MEETING BOOKING (inline card)" in prompt

    def test_no_scheduler_means_no_booking_card_rules(self):
        prompt = _prompt(meeting_booking_enabled=False)

        assert "MEETING BOOKING (inline card)" not in prompt
        assert "NEVER emit [MEETING_CARD]" in prompt or "NEVER emit {MEETING_CARD" in prompt


class TestAPlanWithNoHumanPathIsNeverContradicted:
    def test_it_is_not_told_to_offer_the_team_for_a_meeting(self):
        prompt = _prompt(meeting_booking_enabled=False, support_enabled=False, live_chat_enabled=False)

        assert "NO HUMAN HANDOFF" in prompt
        assert "offering to connect them with the team" not in prompt
        assert "I'd love to connect you with our team about a demo" not in prompt

    def test_it_is_told_neither_card_exists(self):
        prompt = _prompt(meeting_booking_enabled=False, support_enabled=False, live_chat_enabled=False)

        assert "Both are disabled" in prompt

    def test_a_paid_bot_without_a_scheduler_still_offers_the_message_form(self):
        prompt = _prompt(meeting_booking_enabled=False, support_enabled=True, live_chat_enabled=True)

        assert "[LEAVE_MESSAGE_CARD]" in prompt


class TestLiveSupportIsNotPromisedOutsideBusinessHours:
    def test_inside_hours_the_promise_stands(self):
        prompt = _prompt(live_chat_enabled=True, support_enabled=True, within_business_hours=True)

        assert "will be with them shortly" in prompt

    def test_when_no_one_can_join_the_bot_says_the_team_will_be_notified(self):
        prompt = " ".join(_prompt(live_chat_enabled=True, support_enabled=True, within_business_hours=False).split())

        assert "will be with them shortly" not in prompt
        assert "our team will be notified and will get back to them" in prompt
        assert "[LEAVE_MESSAGE_CARD]" in prompt, "the visitor still needs somewhere to go"

    def test_the_visitor_is_never_told_the_team_is_offline(self):
        """This branch also fires inside hours when no operator has a live
        presence, and an operator in another tab is brought in by the handoff
        push. "Offline" would be false to the visitor in that case, so the
        prompt neither asserts it nor lets the model say it.

        Whitespace is flattened first: the block wraps its lines, and a phrase
        split across a line break would pass a ``not in`` check while still
        reaching the model."""
        prompt = " ".join(_prompt(live_chat_enabled=True, support_enabled=True, within_business_hours=False).split())

        assert "the team is offline right now" not in prompt
        assert "not available at the moment" not in prompt
        assert "Never tell the visitor the team is offline, away or unavailable" in prompt

    def test_the_default_is_open(self):
        """An unknown or unconfigured schedule means 24/7, matching
        ``live_chat_availability_service._within_business_hours``."""
        prompt = _prompt(live_chat_enabled=True, support_enabled=True)

        assert "will be with them shortly" in prompt


class TestBothPipelinesResolveTheseBeforeBuildingThePrompt:
    """Two hand-maintained copies. A promise fixed in one and not the other is
    the file's characteristic failure."""

    def test_it_passes_the_resolved_scheduler_not_the_raw_column(self):
        """Resolved means both halves: a configured provider URL AND a plan
        that may offer booking. The column alone let a Free bot inside a paid
        workspace keep serving booking cards."""
        import inspect

        from app.services import rag_service as rs

        for fn in (rs.rag_pipeline_stream,):
            src = inspect.getsource(fn)
            assert "meeting_booking_enabled=_scheduler_ready" in src, fn.__name__
            assert "_scheduler_ready = _meeting_gate.scheduler_is_configured(bot) and (" in src, fn.__name__
            assert "is_meeting_booking_enabled_for_bot" in src, fn.__name__

    def test_each_resolves_business_hours_and_presence(self):
        """Hours are the first half. The second is whether anyone is actually
        online: ``resolve_live_chat_state`` knows ALL_OFFLINE and QUEUE_FULL,
        and inside hours with nobody online the promise is just as broken."""
        import inspect

        from app.services import rag_service as rs

        for fn in (rs.rag_pipeline_stream,):
            src = inspect.getsource(fn)
            assert "_within_hours = _within_business_hours(" in src, fn.__name__
            assert "_live_team_reachable" in src, fn.__name__
            assert "within_business_hours=_team_online" in src, fn.__name__


class TestTheMeetingGateReadsThePlan:
    """The runtime had no plan check at all here: ``meeting_gate`` and
    ``_resolve_meeting_booking`` read the bot's columns only, so a Free bot in a
    paid workspace kept serving booking cards, and a bot that lapsed to Free
    kept serving them forever."""

    def test_a_free_bot_is_denied(self, monkeypatch):
        from app.services import plan_entitlements_service as pes

        monkeypatch.setattr(pes, "get_bot_entitlements", lambda *_a, **_k: SimpleNamespace(plan_slug="free"))

        assert pes.is_meeting_booking_enabled_for_bot(1, object()) is False

    def test_a_paid_bot_is_allowed(self, monkeypatch):
        from app.services import plan_entitlements_service as pes

        monkeypatch.setattr(pes, "get_bot_entitlements", lambda *_a, **_k: SimpleNamespace(plan_slug="professional"))

        assert pes.is_meeting_booking_enabled_for_bot(1, object()) is True

    def test_a_bespoke_contract_slug_is_allowed(self, monkeypatch):
        from app.services import plan_entitlements_service as pes

        monkeypatch.setattr(pes, "get_bot_entitlements", lambda *_a, **_k: SimpleNamespace(plan_slug="enterprise-acme"))

        assert pes.is_meeting_booking_enabled_for_bot(1, object()) is True

    def test_a_resolver_failure_denies(self, monkeypatch):
        from app.services import plan_entitlements_service as pes

        def boom(*_a, **_k):
            raise RuntimeError("db is down")

        monkeypatch.setattr(pes, "get_bot_entitlements", boom)

        assert pes.is_meeting_booking_enabled_for_bot(1, object()) is False
