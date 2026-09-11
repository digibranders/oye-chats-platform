"""A visitor who gave their name can ask for it back.

Production, 2026-09-10: "what's my name?" right after giving it got an
off-topic refusal on all four bots.
"""

import pytest

from app.services import intent_router
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import (
    _answer_text,
    _doc,
    _drive_stream,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)


def test_a_known_name_is_given_back():
    routed = intent_router.route_intent("what's my name?", "Acme", visitor_name="Eva")
    assert routed.intent == "name_recall"
    assert "You're Eva." in routed.answer


def test_an_unknown_name_is_not_invented():
    routed = intent_router.route_intent("what's my name?", "Acme", visitor_name=None)
    assert routed.answer == "I don't know your name yet. You can tell me anytime."


@pytest.mark.asyncio
async def test_the_pipeline_passes_the_visitor_name_to_the_router(db, monkeypatch):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "name-recall")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),))
    monkeypatch.setattr(rs, "route_intent", intent_router.route_intent)

    frames = await _drive_stream(bot, "what's my name?", "name-recall")

    # The harness stubs ``resolve_name_flow`` to a known visitor called
    # "Tester" (see ``_stub_pipeline``) AND stubs ``resolve_visitor_name`` the
    # same way. Before the fix, the returning-visitor welcome-back opener from
    # ``_maybe_append_name_ask`` prepended "Welcome back, Tester!" in front of
    # the router's own "You're Tester." sentence, saying the name twice in
    # adjacent sentences; the router call site now passes ``opener=False`` for
    # the ``name_recall`` intent, so the opener never fires here and "Tester"
    # appears exactly once, from the router's own canned sentence.
    answer = _answer_text(frames)
    assert answer.count("You're Tester.") == 1
    assert "Welcome back" not in answer
    assert "I don't know your name yet" not in answer
    assert cap["prompts"] == []


@pytest.mark.asyncio
async def test_a_greeting_from_a_returning_visitor_still_gets_welcomed_back(db, monkeypatch):
    """Guard against over-fixing: the ``name_recall`` opener suppression must
    not bleed into other early-return intents. A returning visitor's first
    message being a plain greeting still gets the welcome-back opener, since
    "Hey. Happy to help." never states the visitor's name."""
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "name-recall-greeting")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),))
    monkeypatch.setattr(rs, "route_intent", intent_router.route_intent)

    frames = await _drive_stream(bot, "hi", "name-recall-greeting")

    answer = _answer_text(frames)
    assert "Welcome back, Tester!" in answer


@pytest.mark.asyncio
async def test_a_rename_is_recalled_by_the_new_name(db, monkeypatch):
    """Rename then recall, driven through the real name-capture logic (not the
    ``_stub_pipeline`` canned "Tester"): an intro capture, an explicit
    mid-chat rename, then a recall must answer with the RENAMED name and,
    per the fix, without a doubled "Welcome back" opener."""
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "name-recall-rename")
    real_resolve_name_flow = rs.resolve_name_flow
    real_resolve_visitor_name = rs.resolve_visitor_name
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),))
    monkeypatch.setattr(rs, "route_intent", intent_router.route_intent)
    monkeypatch.setattr(rs, "resolve_name_flow", real_resolve_name_flow)
    monkeypatch.setattr(rs, "resolve_visitor_name", real_resolve_visitor_name)

    # Turn 1: an intro capture ("I'm Eva") on the very first message stores
    # the name immediately, without the bot asking for it first.
    await _drive_stream(bot, "I'm Eva", "name-recall-rename")

    # Turn 2: an explicit mid-chat rename overwrites the stored name.
    await _drive_stream(bot, "call me Sam", "name-recall-rename")

    # Turn 3: recall must reflect the renamed name, once, with no opener.
    frames = await _drive_stream(bot, "what's my name?", "name-recall-rename")
    answer = _answer_text(frames)
    assert "You're Sam." in answer
    assert "Welcome back" not in answer


@pytest.mark.asyncio
async def test_a_deferred_name_recall_is_answered_by_name(db, monkeypatch):
    """A visitor's first message is "what's my name?" before any name is known:
    the bot defers and asks for a name; once given, the deferred question
    replays and is answered from the name just captured (Task 3 made
    ``name_recall`` a replayed, non-social intent).

    This test un-stubs ``resolve_name_flow`` and ``resolve_visitor_name``
    (restoring the real functions after ``_stub_pipeline`` patches them away)
    so the real two-turn name capture logic runs end to end."""
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "name-recall-deferred")
    real_resolve_name_flow = rs.resolve_name_flow
    real_resolve_visitor_name = rs.resolve_visitor_name
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),))
    monkeypatch.setattr(rs, "route_intent", intent_router.route_intent)
    monkeypatch.setattr(rs, "resolve_name_flow", real_resolve_name_flow)
    monkeypatch.setattr(rs, "resolve_visitor_name", real_resolve_visitor_name)

    frames_1 = await _drive_stream(bot, "what's my name?", "name-recall-deferred")
    assert "name" in _answer_text(frames_1).lower()

    frames_2 = await _drive_stream(bot, "Eva", "name-recall-deferred")

    assert "You're Eva." in _answer_text(frames_2)
    assert cap["prompts"] == []
