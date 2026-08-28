"""``_quote_probe_hold``: stop probing once the quote is (about to be) triggerable.

The BANT probe for a turn is chosen before the current answer is scored
(extraction is async), so without this gate the bot asks one more qualifying
question in the very turn the quote card appears — the "why ask, then quote?"
wrinkle. These pin the gate's contract, which mirrors the widget runtime's
trigger in ``quotation_routes`` (only admin-chosen dimensions count; empty means
any of the four; threshold clamped to the chosen count).
"""

from types import SimpleNamespace

from app.services.qualification_service import get_framework_config
from app.services.rag_service import (
    _quote_active_or_pending,
    _quote_probe_hold,
    _should_probe_this_turn,
    build_hybrid_prompt,
)


def _bot(**catalog) -> SimpleNamespace:
    base = {
        "enabled": True,
        "currency": "INR",
        "required_categories": [],
        "threshold": 2,
        "services": [{"id": "s1", "name": "Landing page", "price_per_unit": 100, "questions": []}],
    }
    base.update(catalog)
    return SimpleNamespace(quotation_catalog=base)


def _marked(*dims) -> dict:
    """A BANT state with the given dimensions scored (marked)."""
    return {f"{d}_score": 20 for d in dims}


def _session(status=None) -> SimpleNamespace:
    """A chat_session stub with a quotation_state at the given status (or none)."""
    return SimpleNamespace(quotation_state=({"status": status} if status else None))


class TestQuoteActiveOrPending:
    """``_quote_active_or_pending`` gates the team-connect / meeting CTA: hold it
    while a quote is showing or about to fire, release it once the quote is done
    (or was never going to fire). Explicit handoff is unaffected — it rides
    ``suggest_handoff``, which the popup yields to separately."""

    def test_disabled_catalog_is_not_pending(self):
        assert (
            _quote_active_or_pending(SimpleNamespace(quotation_catalog=None), _session(), _marked("need", "budget"))
            is False
        )

    def test_below_threshold_is_not_pending(self):
        # Team offer stays available until the quote will actually fire.
        assert _quote_active_or_pending(_bot(), _session(), _marked("need")) is False

    def test_threshold_met_idle_is_pending(self):
        # Quote will fire via the widget poll → hold the team offer now.
        assert _quote_active_or_pending(_bot(), _session(None), _marked("need", "budget")) is True

    def test_threshold_met_while_selecting_is_pending(self):
        assert _quote_active_or_pending(_bot(), _session("selecting"), _marked("need", "budget")) is True

    def test_completed_quote_releases_the_team_offer(self):
        assert _quote_active_or_pending(_bot(), _session("complete"), _marked("need", "budget")) is False

    def test_skipped_quote_releases_the_team_offer(self):
        assert _quote_active_or_pending(_bot(), _session("skipped"), _marked("need", "budget")) is False

    def test_does_not_use_the_speculative_one_away_clause(self):
        # One dimension short + answering a probe holds the *probe* but must NOT
        # hold the team offer (the team CTA is valuable; only a real quote holds it).
        assert _quote_probe_hold(_bot(), _marked("need"), answers_last_probe=True) is True
        assert _quote_active_or_pending(_bot(), _session(), _marked("need")) is False


class TestDisabledOrEmpty:
    def test_no_catalog_never_holds(self):
        assert _quote_probe_hold(SimpleNamespace(quotation_catalog=None), _marked("need", "budget"), True) is False

    def test_disabled_never_holds(self):
        bot = _bot(enabled=False)
        assert _quote_probe_hold(bot, _marked("need", "budget"), True) is False

    def test_no_services_never_holds(self):
        bot = _bot(services=[])
        assert _quote_probe_hold(bot, _marked("need", "budget"), True) is False

    def test_none_bot_never_holds(self):
        assert _quote_probe_hold(None, _marked("need", "budget"), True) is False


class TestThresholdReached:
    def test_at_threshold_holds(self):
        # 2 of any-4 marked, threshold 2 → already qualified → hold.
        assert _quote_probe_hold(_bot(), _marked("need", "budget"), False) is True

    def test_above_threshold_holds(self):
        assert _quote_probe_hold(_bot(), _marked("need", "budget", "timeline"), False) is True

    def test_below_threshold_without_answer_does_not_hold(self):
        # 1 of 4, threshold 2, and not answering a probe → keep probing.
        assert _quote_probe_hold(_bot(), _marked("need"), False) is False


class TestOneAwayAnsweringProbe:
    def test_one_short_and_answering_probe_holds(self):
        # 1 marked, threshold 2, message answers the last probe → the answer
        # will most likely complete the threshold → hold.
        assert _quote_probe_hold(_bot(), _marked("need"), True) is True

    def test_one_short_not_answering_probe_does_not_hold(self):
        assert _quote_probe_hold(_bot(), _marked("need"), False) is False

    def test_zero_marked_answering_probe_does_not_hold(self):
        # 0 marked, threshold 2 → still two away; one answer can't cross it.
        assert _quote_probe_hold(_bot(), {}, True) is False


class TestRequiredCategories:
    def test_only_chosen_dimensions_count(self):
        # Require Budget + Timeline. Need + Authority marked must NOT satisfy it.
        bot = _bot(required_categories=["budget", "timeline"], threshold=2)
        assert _quote_probe_hold(bot, _marked("need", "authority"), False) is False
        assert _quote_probe_hold(bot, _marked("budget", "timeline"), False) is True

    def test_threshold_clamped_to_chosen_count(self):
        # Require only Budget but set threshold 4 → clamped to 1 → one mark holds.
        bot = _bot(required_categories=["budget"], threshold=4)
        assert _quote_probe_hold(bot, _marked("budget"), False) is True

    def test_text_value_marks_a_dimension(self):
        # A stored text value (no numeric score) still counts as marked.
        bot = _bot()
        state = {"need": "Wants a redesign", "budget": "₹50k"}
        assert _quote_probe_hold(bot, state, False) is True


class TestPromptWiring:
    """End-to-end wiring: the hold decision must actually remove the qualifying
    question from the built prompt, exactly as the two rag_service call sites do
    (``_probe_ok = _should_probe_this_turn(...) and not _quote_probe_hold(...)``).
    """

    # An engaged history (one substantive prior user turn) so
    # ``_should_probe_this_turn`` returns True — the ONLY variable between the
    # two tests below is whether the quote gate is reached.
    _HISTORY = [
        {"role": "user", "content": "I need a new marketing website for my company"},
        {"role": "assistant", "content": "Absolutely, we can help with that."},
        {"role": "user", "content": "when can we go live?"},
    ]

    def _prompt(self, *, bant_state, quote_gate_reached):
        bot = _bot() if quote_gate_reached else _bot(enabled=False)
        # Reproduce the call-site expression verbatim.
        quote_hold = _quote_probe_hold(bot, bant_state, answers_last_probe=False)
        probe_ok = _should_probe_this_turn("when can we go live?", self._HISTORY) and not quote_hold
        system, user = build_hybrid_prompt(
            None,
            "when can we go live?",
            "context",
            "earlier conversation history",  # non-empty → has_prior_turns branch
            bant_state=bant_state,
            bant_enabled=True,
            bant_config=get_framework_config(None),
            company_name="Acme",
            bot_name="Acme Bot",
            probe_ok=probe_ok,
            quote_imminent=quote_hold,
        )
        return system + "\n" + user

    def test_quote_gate_reached_suppresses_every_question(self):
        # 2 dimensions marked, quote enabled (threshold 2) → hold + quote_imminent
        # → the firm "ask NO question at all" directive is emitted.
        prompt = self._prompt(bant_state=_marked("need", "budget"), quote_gate_reached=True)
        assert "Do NOT ask ANY question this turn" in prompt
        assert "a quote will be offered" in prompt.lower()

    def test_quote_disabled_keeps_probing(self):
        # Same BANT state, but quotation disabled → the bot still probes the
        # next open dimension (no premature hold, no quote-imminent directive).
        prompt = self._prompt(bant_state=_marked("need", "budget"), quote_gate_reached=False)
        assert "Do NOT ask ANY question this turn" not in prompt
