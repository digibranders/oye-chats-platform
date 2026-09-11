"""The pricing gate and the price guard act on the turn's one price decision.

Production, 2026-09-11: the gate decided from the question's wording alone, so a
reporter's "a quote from your leadership" and "whats the share price" were
escalated as pricing questions. The turn's decision (``price_intent``) is now
passed in, and the gate no longer reads the wording itself when it has one.

A message that asks the price and something else is not short-circuited: an
escalation the gate would have given is deferred to generation, with the price
guard watching every figure (``escalate_deferred``).
"""

from types import SimpleNamespace

import pytest

from app.services.price_guard import price_guard_applies
from app.services.pricing_gate import evaluate_pricing_gate

_PRICING_URL = "https://acme.com/pricing"


def _chunk(content, document_name):
    return SimpleNamespace(content=content, document_name=document_name)


_PRICED_PAGE = _chunk("The Pro plan starts at $49 per month per seat.", _PRICING_URL)
_UNPRICED_PAGE = _chunk("Talk to us about what you need.", _PRICING_URL)
_ELSEWHERE = _chunk("Our office is in Mumbai.", "https://acme.com/about")


def _gate(**overrides):
    kwargs = dict(
        question="what is your pricing?",
        quote_active=False,
        pricing_url=None,
        chunks=[_ELSEWHERE],
        support_enabled=True,
        contact_url=None,
        answer_from_knowledge_base=False,
    )
    kwargs.update(overrides)
    return evaluate_pricing_gate(**kwargs)


class TestTheDecisionReplacesTheWording:
    def test_a_price_word_in_another_sense_is_not_escalated(self):
        decision = _gate(question="can i get a quote from your leadership", asks_price=False)

        assert (decision.fired, decision.outcome, decision.chunks) == (False, "not_pricing", [_ELSEWHERE])

    def test_a_price_question_without_a_price_word_is_escalated(self):
        decision = _gate(question="what is th picin for SOC", asks_price=True)

        assert (decision.fired, decision.outcome, decision.chunks) == (True, "escalate_no_url", [])

    def test_without_a_decision_the_wording_still_decides(self):
        assert _gate(question="what is your pricing?").outcome == "escalate_no_url"
        assert _gate(question="where is your office?").outcome == "not_pricing"


class TestAPriceQuestionThatAsksMoreIsNotShortCircuited:
    @pytest.mark.parametrize(
        ("pricing_url", "chunks"),
        [(None, [_ELSEWHERE]), (_PRICING_URL, [_ELSEWHERE]), (_PRICING_URL, [_UNPRICED_PAGE, _ELSEWHERE])],
        ids=["no_pricing_page", "page_not_retrieved", "page_without_prices"],
    )
    def test_an_escalation_is_deferred_with_every_chunk_kept(self, pricing_url, chunks):
        decision = _gate(pricing_url=pricing_url, chunks=chunks, asks_price=True, asks_more=True)

        assert (decision.fired, decision.outcome, decision.chunks) == (False, "escalate_deferred", chunks)

    def test_a_free_bot_that_would_hand_over_its_contact_page_defers_too(self):
        decision = _gate(support_enabled=False, contact_url="https://acme.com/contact", asks_price=True, asks_more=True)

        assert decision.outcome == "escalate_deferred"

    def test_a_priced_page_still_narrows_the_context(self):
        decision = _gate(pricing_url=_PRICING_URL, chunks=[_PRICED_PAGE, _ELSEWHERE], asks_price=True, asks_more=True)

        assert (decision.fired, decision.outcome, decision.chunks) == (True, "answer", [_PRICED_PAGE])

    @pytest.mark.parametrize(
        ("overrides", "outcome"),
        [
            ({"quote_active": True}, "quote_standdown"),
            ({"answer_from_knowledge_base": True}, "owner_optout"),
            ({"support_enabled": False}, "no_support_path_standdown"),
        ],
        ids=["quote_in_flight", "owner_opted_out", "free_with_nothing"],
    )
    def test_the_standdowns_are_unchanged(self, overrides, outcome):
        assert _gate(asks_price=True, asks_more=True, **overrides).outcome == outcome

    def test_asking_more_without_asking_the_price_is_not_pricing(self):
        assert _gate(question="what is your pricing?", asks_price=False, asks_more=True).outcome == "not_pricing"


class TestTheGuardWatchesADeferredEscalation:
    @pytest.mark.parametrize(
        ("pricing_url", "support_enabled"),
        [(None, True), (_PRICING_URL, True), (None, False)],
        ids=["paid_no_page", "paid_page_without_prices", "free_contact_page"],
    )
    def test_the_guard_applies(self, pricing_url, support_enabled):
        assert price_guard_applies(
            gate_outcome="escalate_deferred",
            pricing_url=pricing_url,
            answer_from_knowledge_base=False,
            support_enabled=support_enabled,
            judges_bypassed=False,
        )

    @pytest.mark.parametrize(
        "overrides", [{"answer_from_knowledge_base": True}, {"judges_bypassed": True}], ids=["opted_out", "non_english"]
    )
    def test_the_guard_stays_off_where_the_gate_never_runs(self, overrides):
        kwargs = dict(
            gate_outcome="escalate_deferred",
            pricing_url=None,
            answer_from_knowledge_base=False,
            support_enabled=True,
            judges_bypassed=False,
        )
        kwargs.update(overrides)

        assert price_guard_applies(**kwargs) is False
