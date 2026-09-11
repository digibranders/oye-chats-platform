"""The pipeline gives the handoff classifier the bot's previous reply.

The stream calls the classifier from three places: the retrieval path, the
CAG-lite path for a small knowledge base, and a QA cache hit. Each must pass
the previous bot reply, and a bare "yes" to the bot's own offer must open the
form whatever the model would have said.
"""

import pytest

from app.db.models import Document
from app.db.repository import add_chat_message
from app.services import intent_service
from app.services import rag_service as rs
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

FIRST_REPLY = "We open at nine every weekday."


def _real_classifier(monkeypatch, verdict=True):
    seen: list[str | None] = []

    def raw(question, last_bot_message=None):
        seen.append(last_bot_message)
        return verdict

    monkeypatch.setattr(rs, "detect_handoff_intent", intent_service.detect_handoff_intent)
    monkeypatch.setattr(intent_service, "_detect_handoff_intent_raw", raw)
    return seen


def _seed_chunks(db, bot, client, *contents):
    for n, content in enumerate(contents):
        db.add(
            Document(
                client_id=client.id,
                bot_id=bot.id,
                document_name=f"kb-{n}.txt",
                file_hash=f"ctx-{bot.id}-{n}",
                content=content,
                embedding=[0.0] * 768,
            )
        )
    db.commit()


@pytest.mark.asyncio
async def test_a_bare_yes_with_nothing_offered_does_not_open_the_form(db, monkeypatch):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "bare-yes")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),), support=True)
    _real_classifier(monkeypatch, verdict=True)

    frames = await _drive_stream(bot, "yes", "bare-yes")

    assert not (_final_meta(frames) or {}).get("suggest_handoff")


@pytest.mark.asyncio
async def test_the_classifier_receives_the_previous_bot_reply(db, monkeypatch):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "ctx-handoff")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),), support=True, chunks=(FIRST_REPLY,))
    seen = _real_classifier(monkeypatch, verdict=False)

    await _drive_stream(bot, "tell me about your opening times", "ctx-handoff")
    await _drive_stream(bot, "and what about weekends then", "ctx-handoff")

    assert seen[-1] is not None and FIRST_REPLY in seen[-1]


@pytest.mark.asyncio
async def test_the_cag_lite_path_gives_the_classifier_the_previous_bot_reply(db, monkeypatch):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "ctx-cag")
    _seed_chunks(db, bot, client, "Acme sells widgets.", "Acme is open 9 to 5 on weekdays.")
    _stub_pipeline(monkeypatch, support=True, chunks=(FIRST_REPLY,))
    monkeypatch.setattr(rs, "CAG_LITE_THRESHOLD", 20)
    fetched: list[int | None] = []
    real_fetch = rs.get_all_documents_for_bot

    def fetch_all(session, bot_id=None, client_id=None):
        fetched.append(bot_id)
        return real_fetch(session, bot_id=bot_id, client_id=client_id)

    monkeypatch.setattr(rs, "get_all_documents_for_bot", fetch_all)
    seen = _real_classifier(monkeypatch, verdict=False)

    await _drive_stream(bot, "tell me about your opening times", "ctx-cag")
    fetched.clear()
    await _drive_stream(bot, "and what about weekends then", "ctx-cag")

    assert fetched == [bot.id], "turn 2 must take the CAG-lite path"
    assert seen[-1] is not None and FIRST_REPLY in seen[-1]


@pytest.mark.asyncio
async def test_a_cache_hit_gives_the_classifier_the_previous_bot_reply(db, monkeypatch):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "ctx-cache")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),), support=True, chunks=(FIRST_REPLY,))
    seen = _real_classifier(monkeypatch, verdict=False)

    await _drive_stream(bot, "tell me about your opening times", "ctx-cache")
    lookups: list[str] = []

    def cache_hit(cache_key, bot_id):
        lookups.append(cache_key)
        return {"answer": "We are closed on weekends.", "sources": []}

    monkeypatch.setattr(rs, "_qa_cache_lookup", cache_hit)
    frames = await _drive_stream(bot, "are you open on saturdays", "ctx-cache")

    assert lookups, "turn 2 must read the QA cache"
    assert "We are closed on weekends." in _answer_text(frames)
    assert seen[-1] is not None and FIRST_REPLY in seen[-1]


@pytest.mark.asyncio
@pytest.mark.parametrize("reply", ["yes", "sure"])
async def test_a_bare_yes_to_the_team_connect_offer_opens_the_form(db, monkeypatch, reply):
    session_id = f"yes-offer-{reply}"
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, session_id)
    add_chat_message(db, session_id, client_id=client.id, role="user", content="what does acme sell", bot_id=bot.id)
    add_chat_message(
        db,
        session_id,
        client_id=client.id,
        role="bot",
        content="Acme sells widgets.\n\nWould you like to connect with our team?",
        bot_id=bot.id,
    )
    db.commit()
    real_router = rs.route_intent
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),), support=True)
    # The real router answers "sure" as an ack; the offer must stop it doing so.
    monkeypatch.setattr(rs, "route_intent", real_router)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: True)
    seen = _real_classifier(monkeypatch, verdict=False)

    frames = await _drive_stream(bot, reply, session_id)

    assert seen == [], "the offer pattern decides a bare reply, not the model"
    assert (_final_meta(frames) or {}).get("suggest_handoff")
