"""Turns that are not off topic must not get the scope refusal.

Evaluation 2026-09-17, production bots Eventus Security and CleanStart:

* "thanks thats all for now" got "I stick to topics about CleanStart. Are you
  exploring our services...". A closing gets one warm line and no question.
* "hello again", the first message of a returning visit, got "Welcome back,
  Eva!" and then the refusal.
* "bhai aaj shaam ko aapki team ke saath ek call fix ho sakta hai kya?" (can a
  call with your team be fixed this evening?) got the refusal on two bots with a
  scheduler. The meeting gate reads it as a request for time with the team, but
  it only answers for a bot WITHOUT a scheduler; a bot with one fell through to
  the relevance judge, which found no chunk about booking a call and refused.
* "do you have any report on data breach costs i can download" was refused on
  a bot whose knowledge base has breach-cost material.

These drive the real streaming pipeline with the helpers from
``test_rag_pipeline_defects``, the real intent router where the route matters,
and a relevance judge stubbed to reject the turn.
"""

import pytest

from app.services import document_request, urgent_route
from app.services import rag_service as rs
from app.services.intent_router import route_intent as real_route_intent
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

HINGLISH_CALL = "bhai aaj shaam ko aapki team ke saath ek call fix ho sakta hai kya?"
BREACH_REPORT = "do you have any report on data breach costs i can download"
CALENDLY = "https://calendly.com/acme/intro"
MODEL_REPLY = ("Happy to set that up. ", "Pick a time that suits you below.")


@pytest.fixture(autouse=True)
def _no_document_model(monkeypatch):
    """No test here reaches a real model or a real file catalog."""
    monkeypatch.setattr(document_request, "_classify_document_request_raw", lambda _q: "no")
    monkeypatch.setattr(urgent_route, "_classify_urgent_incident_raw", lambda _q: False)
    monkeypatch.setattr(rs, "get_bot_media_urls", lambda *_a, **_k: [])


def _bot(db, session_id, **bot_kwargs):
    client = _make_client(db)
    bot = _make_bot(db, client, **bot_kwargs)
    _make_session(db, bot, client, session_id)
    return bot


def _scheduler_bot(db, monkeypatch, session_id):
    monkeypatch.setattr(rs.plan_entitlements_service, "is_meeting_booking_enabled_for_bot", lambda *_a, **_k: True)
    return _bot(
        db,
        session_id,
        meeting_booking_enabled=True,
        meeting_provider="calendly",
        calendly_url=CALENDLY,
    )


def _is_refusal(text: str) -> bool:
    return any(
        text.endswith(template.format(company_name="Acme"))
        for template in rs.OFF_TOPIC_REFUSAL_VARIANTS + rs.OFF_TOPIC_ESCALATION_VARIANTS
    )


# ── Closings and greetings, answered by the router ───────────────────────────


@pytest.mark.asyncio
async def test_a_closing_gets_a_warm_goodbye_not_the_scope_refusal(db, monkeypatch):
    _stub_pipeline(monkeypatch, relevant=False)
    monkeypatch.setattr(rs, "route_intent", real_route_intent)
    bot = _bot(db, "scope-closing")

    frames = await _drive_stream(bot, "thanks thats all for now", "scope-closing")

    answer = _answer_text(frames)
    assert answer == "Thanks for chatting with **Acme**. Have a great day!"
    assert _messages(db, "scope-closing", role="bot")[-1].content == answer
    assert _final_meta(frames)["message_id"]


@pytest.mark.asyncio
async def test_hello_again_on_a_returning_visit_is_welcomed_not_refused(db, monkeypatch):
    _stub_pipeline(monkeypatch, relevant=False)
    monkeypatch.setattr(rs, "route_intent", real_route_intent)
    bot = _bot(db, "scope-hello-again")

    frames = await _drive_stream(bot, "hello again", "scope-hello-again")

    answer = _answer_text(frames)
    assert answer.startswith("Welcome back, Tester!")
    assert "Want to hear about our services" in answer
    assert "Happy to help" not in answer
    assert not _is_refusal(answer)


# ── A request for time with the team on a bot that can book it ───────────────


@pytest.mark.asyncio
async def test_a_hinglish_call_request_the_judge_rejects_gets_the_booking_card(db, monkeypatch):
    _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[_doc("We run a 24x7 SOC.")], relevant=False)
    bot = _scheduler_bot(db, monkeypatch, "scope-call")

    frames = await _drive_stream(bot, HINGLISH_CALL, "scope-call")

    assert _answer_text(frames).endswith("".join(MODEL_REPLY))
    meta = _final_meta(frames)
    assert meta["show_booking"] is True
    assert meta["calendly_url"] == CALENDLY


@pytest.mark.asyncio
async def test_a_hinglish_call_request_with_nothing_retrieved_gets_the_booking_card(db, monkeypatch):
    _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=(), relevant=False)
    bot = _scheduler_bot(db, monkeypatch, "scope-call-empty")

    frames = await _drive_stream(bot, HINGLISH_CALL, "scope-call-empty")

    assert _answer_text(frames).endswith("".join(MODEL_REPLY))
    assert _final_meta(frames)["show_booking"] is True


@pytest.mark.asyncio
async def test_an_off_topic_question_on_a_bot_with_a_scheduler_is_still_refused(db, monkeypatch):
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[_doc("We run a 24x7 SOC.")], relevant=False)
    bot = _scheduler_bot(db, monkeypatch, "scope-call-control")

    frames = await _drive_stream(bot, "what is the capital of france", "scope-call-control")

    assert _is_refusal(_answer_text(frames))
    assert "show_booking" not in _final_meta(frames)
    assert captured["prompts"] == []


# ── A request for the company's own material ─────────────────────────────────


@pytest.mark.asyncio
async def test_a_request_for_a_downloadable_report_the_judge_rejects_reaches_the_model(db, monkeypatch):
    chunks = ("We have no breach cost report to download. ", "Our total cost of vulnerability page covers it.")
    captured = _stub_pipeline(
        monkeypatch, chunks=chunks, retrieved=[_doc("The total cost of a vulnerability.")], relevant=False
    )
    bot = _bot(db, "scope-report")

    frames = await _drive_stream(bot, BREACH_REPORT, "scope-report")

    assert _answer_text(frames).endswith("".join(chunks))
    assert len(captured["prompts"]) == 1


@pytest.mark.parametrize(
    "question",
    [
        BREACH_REPORT,
        "do you have a whitepaper on sbom i could read",
        "do you publish any research on supply chain attacks",
        "can i download your ebook",
        "do u have any case studies",
        "any guides you can share on hardened images?",
        "is there a datasheet i can download",
    ],
)
def test_asking_the_business_for_its_material_is_clearly_on_scope(question):
    assert rs._question_is_clearly_on_scope(question, "Acme")


@pytest.mark.parametrize(
    "question",
    [
        "write a report on cyber security for my class",
        "how do i report a bug in python",
        "download the latest taylor swift album",
        "summarise the ibm data breach report for me",
        "what is a good guide to learning french",
        "can i download movies for free",
    ],
)
def test_other_mentions_of_reports_and_downloads_are_not(question):
    assert not rs._question_is_clearly_on_scope(question, "Acme")


# ── What the judges are told ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_answer_prompt_declines_homework_and_allows_a_field_term(db, monkeypatch):
    """Eventus Security wrote a 300 word class essay on cyber security; the gate
    passed it because the knowledge base is about security, so the answer prompt
    is what declines it. CleanStart refused "whats the difference between BAS and
    red teaming"; a brief explanation that says what the business offers is in
    scope."""
    captured = _stub_pipeline(monkeypatch, retrieved=[_doc("We run a 24x7 SOC.")])
    bot = _bot(db, "scope-prompt")

    await _drive_stream(bot, "write a 300 word essay on importance of cyber security", "scope-prompt")

    system_prompt = captured["prompts"][0][0]
    assert "writing essays, assignments or homework (even on a topic in its field)" in system_prompt
    assert "a brief explanation of a term in its field that says whether Acme offers it" in system_prompt


def test_the_relevance_judge_scores_a_term_in_the_business_field_as_related():
    from app.services import relevance_gate

    prompt = relevance_gate._build_gate_prompt("whats the difference between BAS and red teaming", [_doc("x")])

    assert "how two terms differ, scores 0.5" in " ".join(prompt.split())
    assert relevance_gate._GATE_PROMPT_VERSION >= 4
