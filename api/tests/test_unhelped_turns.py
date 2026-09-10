"""A visitor the bot cannot help is offered a person, not another brush-off.

Reported from a live bot on 2026-09-10. A visitor asked four times to buy the
company. The relevance check scored every turn 0.00: once it refused outright,
three times it stood down and the model wrote its own deflection ("I can help
with services and sales, not company acquisition.", twice, word for word). The
existing escalation only counted the fixed refusal sentences, so it never saw a
second miss, and live chat was never offered.

Two changes are pinned here. A request to buy, acquire or invest in the company
is a request for a person. And two unhelped turns in a row, counted by how the
pipeline handled them rather than by the wording, get an offer of the team.
"""

from __future__ import annotations

import pytest

from app.services import rag_service as rs
from app.services.handoff_reply import handoff_reply, unhelped_offer
from app.services.intent_service import detect_company_deal_intent, detect_handoff_intent_keywords
from tests.test_rag_pipeline_defects import (
    _answer_text,
    _doc,
    _drive_stream,
    _final_meta,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)


class TestADealForTheCompanyIsARequestForAPerson:
    @pytest.mark.parametrize(
        "message",
        [
            "i want to buy the eventus security company",
            "We would like to acquire your company",
            "can we invest in your business",
            "I'm interested in acquiring the business",
            "open to a merger with your company",
        ],
    )
    def test_the_keyword_detector_hears_it(self, message):
        assert detect_handoff_intent_keywords(message) is True

    @pytest.mark.parametrize(
        "message",
        [
            "how do I buy a SOC subscription",
            "what does the company do",
            "what is a good customer acquisition cost",
            "we want to buy a SIEM for our company",
            "pricing for managed soc",
        ],
    )
    def test_buying_a_service_is_not(self, message):
        assert detect_handoff_intent_keywords(message) is False

    @pytest.mark.parametrize(
        "message",
        [
            "still i want to buy eventus",
            "I want to acquire Eventus Security",
            "buy eventus?",
            "sell me eventus security company",
        ],
    )
    def test_buying_the_company_by_name(self, message):
        if message.startswith("sell me"):
            assert detect_company_deal_intent(message, "Eventus Security") is False
        else:
            assert detect_company_deal_intent(message, "Eventus Security") is True

    @pytest.mark.parametrize(
        "message",
        ["i want to buy eventus soc", "buy the eventus SOAR platform", "what is eventus", "buy", ""],
    )
    def test_buying_something_the_company_sells_is_not_a_deal(self, message):
        assert detect_company_deal_intent(message, "Eventus Security") is False

    def test_a_short_or_generic_first_word_is_not_used_alone(self):
        assert detect_company_deal_intent("i want to buy the", "The Hub") is False
        assert detect_company_deal_intent("i want to buy the hub", "The Hub") is True

    def test_no_company_name_falls_back_to_the_generic_phrasings(self):
        assert detect_company_deal_intent("buy eventus", None) is False
        assert detect_company_deal_intent("we want to acquire your company", None) is True


class TestTheOfferWording:
    def test_live_chat_with_the_team_available(self):
        offer = unhelped_offer(live_chat_enabled=True, team_available=True)
        assert offer.suggest_handoff is True and offer.needs_message_card is False
        assert "form below" in offer.text and "connect you" in offer.text

    def test_live_chat_with_nobody_available(self):
        offer = unhelped_offer(live_chat_enabled=True, team_available=False)
        assert offer.suggest_handoff is True
        assert "offline" in offer.text and "connect you" not in offer.text

    def test_no_live_chat_opens_the_message_card(self):
        offer = unhelped_offer(live_chat_enabled=False, team_available=False)
        assert offer.suggest_handoff is False and offer.needs_message_card is True
        assert "message form" in offer.text

    @pytest.mark.parametrize(("live", "available"), [(True, True), (True, False), (False, False)])
    def test_no_dashes(self, live, available):
        text = unhelped_offer(live_chat_enabled=live, team_available=available).text
        assert "—" not in text and "–" not in text


def _paid_bot(db, monkeypatch, sid, *, relevant=False, live_chat=True, team_online=True, support=True):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=live_chat)
    _make_session(db, bot, client, sid)
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),), relevant=relevant, support=support)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: team_online)
    return bot, cap


def _set_relevant(monkeypatch, relevant: bool):
    monkeypatch.setattr(rs, "check_relevance", lambda *a, **k: (relevant, 1.0 if relevant else 0.0))


class TestTwoUnhelpedTurnsOfferThePerson:
    @pytest.mark.asyncio
    async def test_the_second_refusal_becomes_an_offer(self, db, monkeypatch):
        bot, cap = _paid_bot(db, monkeypatch, "unhelped-1")

        await _drive_stream(bot, "what is 2 plus 2", "unhelped-1")
        frames = await _drive_stream(bot, "what is the capital of france", "unhelped-1")

        offer = unhelped_offer(live_chat_enabled=True, team_available=True)
        assert _answer_text(frames).endswith(offer.text), _answer_text(frames)
        assert _final_meta(frames)["suggest_handoff"] is True
        assert cap["prompts"] == []

    @pytest.mark.asyncio
    async def test_a_model_deflection_counts_like_a_refusal(self, db, monkeypatch):
        """The live case: the check stood down and the model wrote the brush-off."""
        bot, cap = _paid_bot(db, monkeypatch, "unhelped-2")
        monkeypatch.setattr(rs, "_question_is_clearly_on_scope", lambda *_a, **_k: True)

        await _drive_stream(bot, "does Acme take on acquisitions", "unhelped-2")
        assert len(cap["prompts"]) == 1, "precondition: the first turn reached the model"
        frames = await _drive_stream(bot, "does Acme take on acquisitions or not", "unhelped-2")

        assert len(cap["prompts"]) == 1, "the second unhelped turn is the offer, not another generation"
        assert _final_meta(frames)["suggest_handoff"] is True

    @pytest.mark.asyncio
    async def test_a_helped_turn_in_between_resets_the_count(self, db, monkeypatch):
        bot, _cap = _paid_bot(db, monkeypatch, "unhelped-3")

        await _drive_stream(bot, "what is 2 plus 2", "unhelped-3")
        _set_relevant(monkeypatch, True)
        await _drive_stream(bot, "what does Acme sell", "unhelped-3")
        _set_relevant(monkeypatch, False)
        frames = await _drive_stream(bot, "what is the capital of france", "unhelped-3")

        assert not (_final_meta(frames) or {}).get("suggest_handoff")
        assert unhelped_offer(live_chat_enabled=True, team_available=True).text not in _answer_text(frames)

    @pytest.mark.asyncio
    async def test_the_offer_is_not_repeated_on_every_miss_after_it(self, db, monkeypatch):
        bot, _cap = _paid_bot(db, monkeypatch, "unhelped-4")

        await _drive_stream(bot, "what is 2 plus 2", "unhelped-4")
        await _drive_stream(bot, "what is the capital of france", "unhelped-4")
        frames = await _drive_stream(bot, "who won the world cup", "unhelped-4")

        assert unhelped_offer(live_chat_enabled=True, team_available=True).text not in _answer_text(frames)

    @pytest.mark.asyncio
    async def test_nobody_available_gets_the_offline_offer(self, db, monkeypatch):
        bot, _cap = _paid_bot(db, monkeypatch, "unhelped-5", team_online=False)

        await _drive_stream(bot, "what is 2 plus 2", "unhelped-5")
        frames = await _drive_stream(bot, "what is the capital of france", "unhelped-5")

        assert _answer_text(frames).endswith(unhelped_offer(live_chat_enabled=True, team_available=False).text)

    @pytest.mark.asyncio
    async def test_live_chat_off_opens_the_message_card(self, db, monkeypatch):
        bot, _cap = _paid_bot(db, monkeypatch, "unhelped-6", live_chat=False)

        await _drive_stream(bot, "what is 2 plus 2", "unhelped-6")
        frames = await _drive_stream(bot, "what is the capital of france", "unhelped-6")

        meta = _final_meta(frames)
        assert _answer_text(frames).endswith(unhelped_offer(live_chat_enabled=False, team_available=False).text)
        assert meta.get("show_leave_message") is True
        assert not meta.get("suggest_handoff")

    @pytest.mark.asyncio
    async def test_a_plan_with_no_human_never_offers_one(self, db, monkeypatch):
        bot, _cap = _paid_bot(db, monkeypatch, "unhelped-7", support=False)

        await _drive_stream(bot, "what is 2 plus 2", "unhelped-7")
        frames = await _drive_stream(bot, "what is the capital of france", "unhelped-7")

        meta = _final_meta(frames) or {}
        assert not meta.get("suggest_handoff") and not meta.get("show_leave_message")
        assert "form below" not in _answer_text(frames)


class TestBuyingTheCompanyGetsThePersonOnTheFirstAsk:
    @pytest.mark.asyncio
    async def test_buy_the_company_by_name(self, db, monkeypatch):
        bot, cap = _paid_bot(db, monkeypatch, "deal-1", relevant=True)

        frames = await _drive_stream(bot, "still i want to buy acme", "deal-1")

        assert _answer_text(frames).endswith(handoff_reply(team_available=True, repeat=False))
        assert _final_meta(frames)["suggest_handoff"] is True
        assert cap["prompts"] == []
