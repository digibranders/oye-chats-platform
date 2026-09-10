"""The pipeline gives the handoff classifier the bot's previous reply."""

import pytest

from app.services import intent_service
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import (
    _doc,
    _drive_stream,
    _final_meta,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)


def _real_classifier(monkeypatch, verdict=True):
    seen: list[str | None] = []

    def raw(question, last_bot_message=None):
        seen.append(last_bot_message)
        return verdict

    monkeypatch.setattr(rs, "detect_handoff_intent", intent_service.detect_handoff_intent)
    monkeypatch.setattr(intent_service, "_detect_handoff_intent_raw", raw)
    return seen


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
    _stub_pipeline(
        monkeypatch, retrieved=(_doc("Acme sells widgets."),), support=True, chunks=("Our hours are 9 to 5.",)
    )
    seen = _real_classifier(monkeypatch, verdict=False)

    await _drive_stream(bot, "tell me about your opening times", "ctx-handoff")
    await _drive_stream(bot, "and what about weekends then", "ctx-handoff")

    assert seen[-1] is not None and "Our hours are 9 to 5." in seen[-1]
