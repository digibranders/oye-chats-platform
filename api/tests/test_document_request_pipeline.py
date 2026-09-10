"""A document request returns a download card without calling the model.

``test_document_request.py`` pins which requests count and which files match.
These pin where the streaming pipeline answers one: ahead of the QA cache, the
relevance gate and generation, behind an explicit request for a person, and
never for a conversation the English judges stand down for.
"""

import pytest

from app.db.models import ChatSession
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import (
    _answer_text,
    _doc,
    _drive_stream,
    _final_meta,
    _make_bot,
    _make_client,
    _make_session,
    _messages,
    _stub_pipeline,
)

RED = "https://acme.com/files/Red-Teaming.pdf"
RED_CASE = "https://acme.com/files/Red-Teaming-Case-Study.pdf"
CATALOG = [{"files": [{"url": RED, "name": "Red-Teaming.pdf"}]}]


def _bot(db, session_id, **session_kwargs):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, session_id, **session_kwargs)
    return bot


def _cards(db, session_id):
    db.expire_all()
    return db.query(ChatSession).filter(ChatSession.id == session_id).one().inline_cards_shown or {}


def _catalog(monkeypatch, catalog):
    monkeypatch.setattr(rs, "get_bot_media_urls", lambda *_a, **_k: catalog)


@pytest.mark.asyncio
async def test_a_named_datasheet_comes_back_as_a_card(db, monkeypatch):
    bot = _bot(db, "docs-1", inline_cards_shown={"unhelped_streak": 1})
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), support=True)
    _catalog(monkeypatch, CATALOG)

    frames = await _drive_stream(bot, "can you send me the red teaming datasheet?", "docs-1")

    meta = _final_meta(frames)
    assert meta["media_card"] == {"type": "download", "url": RED, "name": "Red-Teaming.pdf"}
    assert "media_secondary" not in meta
    assert meta["qualification_pending"] is False
    answer = _answer_text(frames)
    assert "**Red Teaming** is ready to download below." in answer
    assert "email" not in answer.lower()
    assert cap["prompts"] == []
    bot_msg = _messages(db, "docs-1", role="bot")[-1]
    assert bot_msg.id == meta["message_id"]
    assert bot_msg.is_unanswered is False
    cards = _cards(db, "docs-1")
    assert cards.get(f"media:{RED}") is True
    # Documents were offered, so the unhelped run ends.
    assert "unhelped_streak" not in cards


@pytest.mark.asyncio
async def test_a_second_matching_file_rides_as_the_chip(db, monkeypatch):
    bot = _bot(db, "docs-2")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),))
    _catalog(
        monkeypatch,
        [
            {"files": [{"url": RED_CASE, "name": "Red-Teaming-Case-Study.pdf"}]},
            {"files": [{"url": RED, "name": "Red-Teaming.pdf"}]},
        ],
    )

    frames = await _drive_stream(bot, "share the red teaming datasheets please", "docs-2")

    meta = _final_meta(frames)
    assert meta["media_card"]["url"] == RED_CASE
    assert meta["media_secondary"] == [{"type": "download", "url": RED, "name": "Red-Teaming.pdf"}]
    assert "**Red Teaming Case Study** and **Red Teaming** are ready to download below." in _answer_text(frames)


@pytest.mark.asyncio
async def test_a_cached_answer_does_not_hide_the_route(db, monkeypatch):
    bot = _bot(db, "docs-3")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),))
    _catalog(monkeypatch, CATALOG)
    lookups = []

    def cache_hit(cache_key, bot_id):
        lookups.append(cache_key)
        return {"answer": "That specific detail sits with the team.", "sources": []}

    monkeypatch.setattr(rs, "_qa_cache_lookup", cache_hit)

    frames = await _drive_stream(bot, "can you send me the red teaming datasheet?", "docs-3")

    assert lookups == []
    assert _final_meta(frames)["media_card"]["url"] == RED
    assert "sits with the team" not in _answer_text(frames)


@pytest.mark.asyncio
async def test_no_file_on_a_plan_with_a_human_offers_the_team_in_words(db, monkeypatch):
    bot = _bot(db, "docs-4", inline_cards_shown={"unhelped_streak": 1})
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), support=True)
    _catalog(monkeypatch, CATALOG)

    frames = await _drive_stream(bot, "email me the kubernetes hardening datasheet", "docs-4")

    meta = _final_meta(frames)
    assert "connect you with the team" in _answer_text(frames)
    assert cap["prompts"] == []
    # An offer in words, not a form: no card, no handoff, no message card.
    assert "media_card" not in meta
    assert "suggest_handoff" not in meta
    assert "show_leave_message" not in meta
    assert _messages(db, "docs-4", role="bot")[-1].is_unanswered is True
    cards = _cards(db, "docs-4")
    assert cards.get("unhelped_streak") == 1
    assert "handoff_offered" not in cards
    assert "leave_message" not in cards


@pytest.mark.asyncio
async def test_a_yes_to_the_no_file_offer_opens_the_handoff(db, monkeypatch):
    bot = _bot(db, "docs-5")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), support=True)
    _catalog(monkeypatch, [])

    await _drive_stream(bot, "can you send me your brochure?", "docs-5")
    frames = await _drive_stream(bot, "yes", "docs-5")

    assert _final_meta(frames)["suggest_handoff"] is True


@pytest.mark.asyncio
async def test_a_request_the_relevance_gate_rejects_still_gets_the_file(db, monkeypatch):
    bot = _bot(db, "docs-6")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), relevant=False)
    _catalog(monkeypatch, CATALOG)

    frames = await _drive_stream(bot, "do you have a red teaming datasheet", "docs-6")

    assert _final_meta(frames)["media_card"]["url"] == RED
    assert cap["prompts"] == []


@pytest.mark.asyncio
async def test_a_non_english_conversation_keeps_the_model(db, monkeypatch):
    bot = _bot(db, "docs-7")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), chunks=("Generated.",))
    _catalog(monkeypatch, CATALOG)
    monkeypatch.setattr(rs, "_english_judges_bypassed", lambda *_a, **_k: True)

    frames = await _drive_stream(bot, "can you send me your brochure?", "docs-7")

    assert len(cap["prompts"]) == 1
    assert "download below" not in _answer_text(frames)


@pytest.mark.asyncio
async def test_an_explicit_request_for_a_person_goes_to_the_handoff(db, monkeypatch):
    bot = _bot(db, "docs-8")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), support=True)
    _catalog(monkeypatch, CATALOG)
    # The real classifier treats a keyword match as authoritative.
    monkeypatch.setattr(rs, "detect_handoff_intent", lambda q, **_k: rs.detect_handoff_intent_keywords(q))

    frames = await _drive_stream(bot, "I want to talk to a human and get the brochure", "docs-8")

    meta = _final_meta(frames)
    assert meta["suggest_handoff"] is True
    assert "media_card" not in meta
    assert "form below" in _answer_text(frames)
    assert cap["prompts"] == []


@pytest.mark.asyncio
async def test_a_question_about_making_brochures_reaches_the_model(db, monkeypatch):
    bot = _bot(db, "docs-9")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme designs brochures."),), chunks=("We do.",))
    _catalog(monkeypatch, CATALOG)

    frames = await _drive_stream(bot, "do you design brochures?", "docs-9")

    assert len(cap["prompts"]) == 1
    assert "download below" not in _answer_text(frames)
