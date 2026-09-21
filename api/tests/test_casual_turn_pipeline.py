"""Casual turns are answered warmly, never with the gap line or the scope refusal.

Production, 2026-09-18, Eventus Security and CleanStart, both bots, each turn
taken after the name step:

* "nice website btw, very clean design" got "I don't have that detail here.
  Want me to loop in the **Eventus Security** team on this?"
* "hey hows ur day going" got "I'm focused on questions about CleanStart."
* "my name is arjun" and "actually my name is not eva, its priya. typo earlier"
  got "Thanks, Arjun!" and then the off-topic line in the same reply.

These drive the real streaming pipeline with the helpers from
``test_rag_pipeline_defects``, the relevance judge stubbed to reject the turn
(gate_score 0.00, as in production), and the intent router and the name flow
left unstubbed, so the assertions are about the pipeline and not about a stub.
"""

import pytest

from app.services import document_request, intent_router, urgent_route
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import (
    _answer_text,
    _doc,
    _drive_stream,
    _make_bot,
    _make_client,
    _make_session,
    _messages,
    _stub_pipeline,
)

#: Captured before any test can monkeypatch the module attributes.
_REAL_ROUTE_INTENT = rs.route_intent
_REAL_RESOLVE_NAME_FLOW = rs.resolve_name_flow

COMPLIMENT = "nice website btw, very clean design"
PLEASANTRY = "hey hows ur day going"
NAME_GIVEN = "my name is arjun"
NAME_CORRECTED = "actually my name is not eva, its priya. typo earlier"
WEAK_CHUNK = _doc("Our images are rebuilt nightly from source with a minimal package set.")
MODEL_REPLY = ("Our SOC runs around the clock.",)
#: Em dash and en dash: banned in every string a visitor can read.
_DASHES = {chr(0x2014), chr(0x2013)}


@pytest.fixture(autouse=True)
def _no_other_models(monkeypatch):
    """No test here reaches a real model or a real file catalog."""
    monkeypatch.setattr(document_request, "_classify_document_request_raw", lambda _q: "no")
    monkeypatch.setattr(urgent_route, "_classify_urgent_incident_raw", lambda _q: False)
    monkeypatch.setattr(rs, "get_bot_media_urls", lambda *_a, **_k: [])


def _bot(db, session_id):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, session_id)
    return bot


def _real_router(monkeypatch):
    monkeypatch.setattr(rs, "route_intent", _REAL_ROUTE_INTENT)


def _real_name_flow(monkeypatch):
    monkeypatch.setattr(rs, "resolve_name_flow", _REAL_RESOLVE_NAME_FLOW)
    monkeypatch.setattr(rs, "resolve_visitor_name", lambda *a, **k: None)


def _is_refusal(text: str) -> bool:
    return any(
        template.format(company_name="Acme") in text
        for template in rs.OFF_TOPIC_REFUSAL_VARIANTS + rs.OFF_TOPIC_ESCALATION_VARIANTS
    )


def _is_gap_line(text: str) -> bool:
    return "I don't have that detail here" in text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("question", "intent"),
    [(COMPLIMENT, "compliment"), (PLEASANTRY, "how_are_you")],
)
async def test_a_casual_turn_is_answered_by_the_router_not_the_gate(db, monkeypatch, question, intent):
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    _real_router(monkeypatch)
    monkeypatch.setattr(rs, "resolve_visitor_name", lambda *a, **k: None)
    session_id = f"casual-{intent}"
    bot = _bot(db, session_id)

    answer = _answer_text(await _drive_stream(bot, question, session_id))

    assert answer == intent_router.route_intent(question, "Acme").answer
    assert not _is_refusal(answer) and not _is_gap_line(answer)
    assert captured["prompts"] == [], "a canned casual reply must not cost a model call"
    assert _messages(db, session_id, role="bot")[-1].content == answer


@pytest.mark.asyncio
async def test_a_question_that_opens_with_praise_still_reaches_retrieval(db, monkeypatch):
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=True)
    _real_router(monkeypatch)
    monkeypatch.setattr(rs, "resolve_visitor_name", lambda *a, **k: None)
    bot = _bot(db, "casual-question")

    answer = _answer_text(await _drive_stream(bot, "nice website, what does your SOC service cost?", "casual-question"))

    assert answer.endswith("".join(MODEL_REPLY))
    assert len(captured["prompts"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("first", "second", "expected_opening"),
    [
        (NAME_GIVEN, None, "Nice to meet you, Arjun!"),
        ("Eva", NAME_CORRECTED, "Thanks for correcting that, Priya."),
    ],
)
async def test_a_name_turn_ends_after_the_acknowledgement(db, monkeypatch, first, second, expected_opening):
    """No scope line after "Thanks, Arjun!": the turn stops at the acknowledgement."""
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    _real_router(monkeypatch)
    _real_name_flow(monkeypatch)
    session_id = f"casual-name-{'correction' if second else 'capture'}"
    bot = _bot(db, session_id)

    ask = _answer_text(await _drive_stream(bot, "hii", session_id))
    assert ask == rs._NAME_REQUEST_MESSAGE

    answer = _answer_text(await _drive_stream(bot, first, session_id))
    if second is not None:
        answer = _answer_text(await _drive_stream(bot, second, session_id))

    assert answer.startswith(expected_opening), answer
    assert not _is_refusal(answer) and not _is_gap_line(answer)
    assert captured["prompts"] == [], "a name turn must not cost a model call"
    assert not _DASHES & set(answer)


def test_the_correction_wording_is_in_the_house_voice():
    reply = rs._name_correction_message("Priya", "Acme")
    assert reply == "Thanks for correcting that, Priya. What can I help you with at **Acme**?"
    assert reply.count("?") == 1
    assert not _DASHES & set(reply)
    assert "at us" not in rs._name_correction_message("Priya", None)


@pytest.mark.asyncio
async def test_a_name_turn_that_also_asks_something_still_reaches_retrieval(db, monkeypatch):
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=True)
    _real_router(monkeypatch)
    _real_name_flow(monkeypatch)
    bot = _bot(db, "casual-name-question")

    await _drive_stream(bot, "hii", "casual-name-question")
    answer = _answer_text(
        await _drive_stream(bot, "im arjun, what does your SOC service cost?", "casual-name-question")
    )

    assert answer.endswith("".join(MODEL_REPLY))
    assert len(captured["prompts"]) == 1
