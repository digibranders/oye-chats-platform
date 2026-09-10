"""A visitor the bot cannot help is offered a person, not another brush-off.

Reported from a live bot on 2026-09-10. A visitor asked four times to buy the
company. The relevance check scored every turn 0.00: once it refused outright,
three times it stood down and the model wrote its own deflection ("I can help
with services and sales, not company acquisition.", twice, word for word). The
existing escalation only counted the fixed refusal sentences, so it never saw a
second miss, and live chat was never offered.

Two changes are pinned here. A request to buy, acquire or invest in the company
is a request for a person. And two unhelped turns in a row, counted by how the
pipeline handled them rather than by the wording, get an offer of the team,
once per conversation. A turn counts when it is refused or pivoted; a turn the
gate relaxed reaches the model and counts neither way; a helped turn, including
a pricing escalation or a handoff reply, starts the count again.
"""

from __future__ import annotations

import pytest

from app.db.models import ChatSession
from app.services import intent_service
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
    """A match on the keyword path opens the handoff with no model call and skips
    lead scoring, so it keeps only verbs that can only mean a corporate
    transaction. Buying or investing is a deal only for the company by name or
    with a company noun and nothing after it; anything more ambiguous is left
    to the handoff classifier."""

    @pytest.mark.parametrize(
        "message",
        [
            "We would like to acquire your company",
            "I'm interested in acquiring the business",
            "open to a merger with your company",
            "we want to take over your firm outright",
            "acquisition of your company?",
        ],
    )
    def test_the_keyword_detector_hears_a_takeover(self, message):
        assert detect_handoff_intent_keywords(message) is True

    @pytest.mark.parametrize(
        "message",
        [
            "how do I buy a SOC subscription",
            "what does the company do",
            "what is a good customer acquisition cost",
            "we want to buy a SIEM for our company",
            "pricing for managed soc",
            # A plan, tier or account named after the buyer's kind of
            # organisation is something the company sells, not the company.
            "i want to buy the business plan",
            "can i buy the company plan",
            "purchase the business tier",
            "i want to buy your enterprise business plan for 20 seats",
            "buy that startup package",
            "how do i take over the organization account from my colleague",
            "buy the business pro plan",
            "purchase the business premium plan",
            "i'd like to buy the business annual plan",
            "buy the business-plan",
            "buy the business for 2 users",
            "buy the business now",
            "buy the business?",
            "buy that business tool",
            "i want to purchase the company logo design",
            "can i buy the company domain",
            "buy the business insurance",
            # Buying and investing are never decided without the model.
            "we want to buy the company outright",
            "we want to invest in your company",
        ],
    )
    def test_the_keyword_detector_leaves_purchases_alone(self, message):
        assert detect_handoff_intent_keywords(message) is False

    @pytest.mark.parametrize(
        "message",
        [
            "we want to acquire your company and what is your pricing",
            "we want to acquire your company\nand what is your pricing",
            "acquire your company culture tips",
        ],
    )
    def test_the_company_noun_must_end_the_message(self, message):
        """The tail is checked against the end of the whole message, not the end
        of a line or of the match."""
        assert detect_handoff_intent_keywords(message) is False
        assert detect_company_deal_intent(message, "Acme") is False

    @pytest.mark.parametrize(
        ("message", "company_name"),
        [
            ("our company needs to buy insurance", "Insurance Hub"),
            ("my business wants to buy coffee", "Coffee Co"),
            ("our company needs to buy freshdesk", "Freshdesk"),
            ("my company wants to purchase eventus", "Eventus Security"),
            ("we are a small business and want to buy acme", "Acme"),
            ("i want to invest in mutual funds", "Mutual Funds Direct"),
            ("how do i invest in gold", "Gold Traders"),
            ("i need to invest in real estate", "Real Estate Partners"),
            ("invest in cloud", "Cloud Storage Inc"),
            ("i want to buy web design", "Web Design Studio"),
            ("buy green tea", "Green Tea Co"),
            ("i want to buy cloud storage", "Cloud Storage Inc"),
            ("i want to buy coffee", "Coffee Co"),
            ("can i buy pizza?", "Pizza Hut"),
            ("where can i buy shoes", "Shoes Express"),
            ("how do I buy insurance", "Insurance Hub"),
            ("buy apple", "Apple Inc"),
            ("still i want to buy eventus", "Eventus Security"),
            ("buy eventus?", "Eventus Security"),
            ("i want to buy eventus security", "Eventus Security"),
            ("i want to buy eventus soc", "Eventus Security"),
            ("buy the eventus SOAR platform", "Eventus Security"),
            ("sell me eventus security company", "Eventus Security"),
            ("what is eventus", "Eventus Security"),
            ("buy the business?", "Acme"),
            ("i want to buy the business plan", "Acme"),
            ("i want to buy the", "The Hub"),
            ("i want to buy the hub", "The Hub"),
            ("buy", "Eventus Security"),
            ("", "Eventus Security"),
        ],
    )
    def test_buying_what_the_company_sells_is_not_a_deal(self, message, company_name):
        """A product that shares the company's name, or a purchase the visitor's
        own company makes, reads the same as buying the company. The handoff
        classifier sees the conversation and makes that call (Task 2)."""
        assert detect_company_deal_intent(message, company_name) is False

    @pytest.mark.parametrize(
        ("message", "company_name"),
        [
            ("i want to buy the eventus security company", "Eventus Security"),
            ("we want to buy the company outright", "Acme"),
            ("we want to invest in your company", "Acme"),
            ("can we invest in your business", "Acme"),
            ("We would like to acquire your company", "Acme"),
            ("I want to acquire Eventus Security", "Eventus Security"),
            ("i want to acquire eventus", "Eventus Security"),
            ("i want to acquire acme", "Acme"),
            ("we want to take over acme", "Acme"),
            ("i want to buy the acme business", "Acme"),
            ("i want to buy acme shares", "Acme"),
            ("buy a stake in eventus security", "Eventus Security"),
            ("buy the shares of eventus security", "Eventus Security"),
            ("i want to buy acme's shares", "Acme"),
            ("acquire the hub", "The Hub"),
            ("i want to acquire the hub", "The Hub"),
            ("i want to buy the hub business", "The Hub"),
            ("we want to acquire bank of baroda", "Bank of Baroda"),
        ],
    )
    def test_a_deal_for_the_company_itself(self, message, company_name):
        assert detect_company_deal_intent(message, company_name) is True

    def test_no_company_name_falls_back_to_the_generic_phrasings(self):
        assert detect_company_deal_intent("buy eventus", None) is False
        assert detect_company_deal_intent("we want to acquire your company", None) is True
        assert detect_company_deal_intent("we want to buy the company outright", None) is True

    def test_the_stopword_copy_matches_the_pipeline_list(self):
        """``intent_service`` keeps its own copy to avoid an import cycle."""
        assert intent_service._DEAL_NAME_STOPWORDS == rs._COMPANY_NAME_STOPWORDS


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


def _stored_cards(db, session_id: str) -> dict:
    db.expire_all()
    return db.query(ChatSession).filter(ChatSession.id == session_id).one().inline_cards_shown or {}


_OFFER_TEXT = unhelped_offer(live_chat_enabled=True, team_available=True).text


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
    async def test_relaxed_turns_are_answered_not_replaced_by_the_offer(self, db, monkeypatch):
        """A turn the judge rejected but the gate relaxed reaches the model, and
        the model often answers it well. It is not counted as unhelped, so a
        second one in a row is answered too."""
        bot, cap = _paid_bot(db, monkeypatch, "unhelped-2")
        monkeypatch.setattr(rs, "_question_is_clearly_on_scope", lambda *_a, **_k: True)

        first = await _drive_stream(bot, "what does Acme do", "unhelped-2")
        second = await _drive_stream(bot, "who are Acme's customers", "unhelped-2")

        assert len(cap["prompts"]) == 2, "both relaxed turns reach generation"
        for frames in (first, second):
            assert _OFFER_TEXT not in _answer_text(frames)
            assert not (_final_meta(frames) or {}).get("suggest_handoff")

    @pytest.mark.asyncio
    async def test_a_relaxed_turn_between_refusals_is_neutral(self, db, monkeypatch):
        bot, cap = _paid_bot(db, monkeypatch, "unhelped-2b")
        strict_on_scope = rs._question_is_clearly_on_scope

        await _drive_stream(bot, "what is 2 plus 2", "unhelped-2b")
        monkeypatch.setattr(rs, "_question_is_clearly_on_scope", lambda *_a, **_k: True)
        await _drive_stream(bot, "what does Acme do", "unhelped-2b")
        assert len(cap["prompts"]) == 1, "precondition: the relaxed turn reached the model"
        monkeypatch.setattr(rs, "_question_is_clearly_on_scope", strict_on_scope)
        frames = await _drive_stream(bot, "what is the capital of france", "unhelped-2b")

        assert _answer_text(frames).endswith(_OFFER_TEXT), _answer_text(frames)
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
        misses = [
            "what is 2 plus 2",
            "what is the capital of france",
            "who won the world cup",
            "how tall is mount everest",
            "what is the speed of light",
        ]

        replies = [_answer_text(await _drive_stream(bot, message, "unhelped-4")) for message in misses]

        assert sum(reply.count(_OFFER_TEXT) for reply in replies) == 1, replies
        # The offer fires on the second miss; the stored count never needs more.
        assert _stored_cards(db, "unhelped-4")["unhelped_streak"] == 2

    @pytest.mark.asyncio
    async def test_asking_for_a_person_in_between_resets_the_count(self, db, monkeypatch):
        bot, _cap = _paid_bot(db, monkeypatch, "unhelped-4b")
        monkeypatch.setattr(rs, "detect_handoff_intent", lambda _q, **_kw: _q == "I want to talk to a human")

        await _drive_stream(bot, "what is 2 plus 2", "unhelped-4b")
        handoff = await _drive_stream(bot, "I want to talk to a human", "unhelped-4b")
        assert _answer_text(handoff).endswith(handoff_reply(team_available=True, repeat=False))
        assert "unhelped_streak" not in _stored_cards(db, "unhelped-4b")
        frames = await _drive_stream(bot, "what is the capital of france", "unhelped-4b")

        assert _OFFER_TEXT not in _answer_text(frames)

    @pytest.mark.asyncio
    async def test_a_pricing_escalation_in_between_resets_the_count(self, db, monkeypatch):
        bot, cap = _paid_bot(db, monkeypatch, "unhelped-4c")

        await _drive_stream(bot, "what is 2 plus 2", "unhelped-4c")
        await _drive_stream(bot, "how much does it cost?", "unhelped-4c")
        cards = _stored_cards(db, "unhelped-4c")
        assert cards.get("pricing_escalated") is True, "precondition: the second turn was the pricing escalation"
        assert "unhelped_streak" not in cards
        frames = await _drive_stream(bot, "what is the capital of france", "unhelped-4c")

        assert _OFFER_TEXT not in _answer_text(frames)
        assert cap["prompts"] == []

    @pytest.mark.asyncio
    async def test_an_answer_from_the_qa_cache_resets_the_count(self, db, monkeypatch):
        bot, cap = _paid_bot(db, monkeypatch, "unhelped-4d")
        cached_question = "when do you open"
        key = rs.qa_response_key(
            bot.id, rs.hashlib.sha256(rs._normalize_question_for_cache(cached_question).encode()).hexdigest()[:32], None
        )
        cap["cache"].store[key] = {"answer": "We open at 9.", "sources": ["kb.txt"]}

        await _drive_stream(bot, "what is 2 plus 2", "unhelped-4d")
        assert _stored_cards(db, "unhelped-4d").get("unhelped_streak") == 1, "precondition: the refusal counted"
        hit = await _drive_stream(bot, cached_question, "unhelped-4d")
        assert "We open at 9." in _answer_text(hit), "precondition: the second turn was served from the cache"
        assert "unhelped_streak" not in _stored_cards(db, "unhelped-4d")
        frames = await _drive_stream(bot, "what is the capital of france", "unhelped-4d")

        assert _OFFER_TEXT not in _answer_text(frames)
        assert not (_final_meta(frames) or {}).get("suggest_handoff")
        assert cap["prompts"] == []

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

        frames = await _drive_stream(bot, "i want to acquire acme", "deal-1")

        assert _answer_text(frames).endswith(handoff_reply(team_available=True, repeat=False))
        assert _final_meta(frames)["suggest_handoff"] is True
        assert cap["prompts"] == []
