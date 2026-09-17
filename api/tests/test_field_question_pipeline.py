"""A question about the business's field is answered, not refused, when the judge finds nothing.

Production, 2026-09-17, CleanStart (hardened container images and software supply
chain security), after the name step: "whats the difference between BAS and red
teaming" got "Let's keep this about CleanStart..." with
``rag.metric name=off_topic_refusal reason=gate_fired path=stream gate_score=0.00``.
The knowledge base has no BAS or red-teaming material, so retrieval returned only
weakly related chunks, and the judge, which is never told what the business
does, found no field to match them to.

These drive the real streaming pipeline with the helpers from
``test_rag_pipeline_defects``, a relevance judge stubbed to reject the turn, and
the field-question classifier stubbed at its model call.
"""

import asyncio
import threading

import pytest

from app.services import document_request, field_question, urgent_route
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import (
    _anonymous_visitor,
    _answer_text,
    _doc,
    _drive_stream,
    _make_bot,
    _make_client,
    _make_session,
    _messages,
    _stub_pipeline,
)

PRODUCTION_QUESTION = "whats the difference between BAS and red teaming"
ESSAY = "write a 300 word essay on cyber security for my class 9 assignment"
OUTLOOK = "how do I schedule a meeting in outlook?"
SECURITY_DESCRIPTION = "Acme builds hardened container images and secures the software supply chain."
BAKERY_DESCRIPTION = "Acme is a neighbourhood bakery selling sourdough, cakes and pastries."
WEAK_CHUNK = _doc("Our images are rebuilt nightly from source with a minimal package set.")
MODEL_REPLY = (
    "Breach and attack simulation runs automated attacks continuously; red teaming is a human-led exercise. ",
    "Acme does not offer either: we build hardened container images.",
)


class _Classifier:
    """Stands in for ``field_question._classify_field_question_raw``."""

    def __init__(self, answer: bool) -> None:
        self.answer = answer
        self.calls: list[tuple[str, field_question.BusinessProfile]] = []

    def __call__(self, question: str, profile: field_question.BusinessProfile) -> bool:
        self.calls.append((question, profile))
        return self.answer


@pytest.fixture(autouse=True)
def _no_other_models(monkeypatch):
    """No test here reaches a real model or a real file catalog."""
    monkeypatch.setattr(document_request, "_classify_document_request_raw", lambda _q: "no")
    monkeypatch.setattr(urgent_route, "_classify_urgent_incident_raw", lambda _q: False)
    monkeypatch.setattr(rs, "get_bot_media_urls", lambda *_a, **_k: [])


def _classifier(monkeypatch, answer: bool) -> _Classifier:
    fake = _Classifier(answer)
    monkeypatch.setattr(field_question, "_classify_field_question_raw", fake)
    return fake


def _bot(db, session_id, description=SECURITY_DESCRIPTION, **bot_kwargs):
    client = _make_client(db)
    bot = _make_bot(db, client, company_description=description, **bot_kwargs)
    _make_session(db, bot, client, session_id)
    return bot


def _is_refusal(text: str) -> bool:
    return any(
        text.endswith(template.format(company_name="Acme"))
        for template in rs.OFF_TOPIC_REFUSAL_VARIANTS + rs.OFF_TOPIC_ESCALATION_VARIANTS
    )


@pytest.mark.asyncio
async def test_the_production_question_reaches_the_model_when_the_second_opinion_says_yes(db, monkeypatch):
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    classifier = _classifier(monkeypatch, True)
    bot = _bot(db, "field-yes", services=[{"name": "Hardened images", "url": None}])

    frames = await _drive_stream(bot, PRODUCTION_QUESTION, "field-yes")

    assert _answer_text(frames).endswith("".join(MODEL_REPLY))
    assert len(captured["prompts"]) == 1
    ((question, profile),) = classifier.calls
    assert question == PRODUCTION_QUESTION
    assert profile == field_question.BusinessProfile("Acme", SECURITY_DESCRIPTION, ("Hardened images",))
    assert _messages(db, "field-yes", role="bot")[-1].content.endswith("".join(MODEL_REPLY))


@pytest.mark.asyncio
async def test_a_field_question_let_through_is_not_counted_as_an_unhelped_turn(db, monkeypatch):
    """Two in a row would otherwise replace the second answer with the team offer."""
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=False, support=True)
    _classifier(monkeypatch, True)
    bot = _bot(db, "field-streak")

    await _drive_stream(bot, PRODUCTION_QUESTION, "field-streak")
    frames = await _drive_stream(bot, "and what is purple teaming?", "field-streak")

    assert _answer_text(frames).endswith("".join(MODEL_REPLY))
    assert len(captured["prompts"]) == 2


@pytest.mark.asyncio
async def test_the_production_question_is_refused_when_the_second_opinion_says_no(db, monkeypatch):
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    classifier = _classifier(monkeypatch, False)
    bot = _bot(db, "field-no")

    frames = await _drive_stream(bot, PRODUCTION_QUESTION, "field-no")

    assert _is_refusal(_answer_text(frames))
    assert captured["prompts"] == []
    assert len(classifier.calls) == 1


@pytest.mark.asyncio
async def test_the_production_question_is_refused_when_the_second_opinion_stalls(db, monkeypatch):
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    release = threading.Event()

    def stalled(*_args, **_kwargs):
        release.wait(5)
        return True

    monkeypatch.setattr(field_question, "_classify_field_question_raw", stalled)
    monkeypatch.setattr(field_question, "_FIELD_QUESTION_CHECK_TIMEOUT_S", 0.05)
    bot = _bot(db, "field-timeout")
    try:
        started = asyncio.get_running_loop().time()
        frames = await _drive_stream(bot, PRODUCTION_QUESTION, "field-timeout")
        elapsed = asyncio.get_running_loop().time() - started
    finally:
        release.set()

    assert _is_refusal(_answer_text(frames))
    assert captured["prompts"] == []
    assert elapsed < 3.0


@pytest.mark.asyncio
async def test_the_production_question_is_refused_when_the_model_is_down(db, monkeypatch):
    """The autouse fixture in conftest makes the model look down."""
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    bot = _bot(db, "field-down")

    frames = await _drive_stream(bot, PRODUCTION_QUESTION, "field-down")

    assert _is_refusal(_answer_text(frames))
    assert captured["prompts"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("question", [ESSAY, OUTLOOK])
async def test_an_essay_or_a_how_to_about_another_tool_is_still_refused(db, monkeypatch, question):
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    classifier = _classifier(monkeypatch, False)
    # A bot with a scheduler, so the Outlook question reaches the judge: without
    # one the meeting gate declines it first.
    monkeypatch.setattr(rs.plan_entitlements_service, "is_meeting_booking_enabled_for_bot", lambda *_a, **_k: True)
    bot = _bot(
        db,
        f"field-control-{len(question)}",
        meeting_booking_enabled=True,
        meeting_provider="calendly",
        calendly_url="https://calendly.com/acme/intro",
    )

    frames = await _drive_stream(bot, question, f"field-control-{len(question)}")

    assert _is_refusal(_answer_text(frames))
    assert captured["prompts"] == []
    assert [q for q, _p in classifier.calls] == [question]


@pytest.mark.asyncio
async def test_a_security_question_on_a_bakery_bot_is_still_refused(db, monkeypatch):
    captured = _stub_pipeline(
        monkeypatch, chunks=MODEL_REPLY, retrieved=[_doc("Our sourdough proves for 36 hours.")], relevant=False
    )
    classifier = _classifier(monkeypatch, False)
    bot = _bot(db, "field-bakery", description=BAKERY_DESCRIPTION)

    frames = await _drive_stream(bot, PRODUCTION_QUESTION, "field-bakery")

    assert _is_refusal(_answer_text(frames))
    assert captured["prompts"] == []
    ((_question, profile),) = classifier.calls
    assert profile.description == BAKERY_DESCRIPTION


@pytest.mark.asyncio
async def test_a_bot_with_no_description_or_services_is_not_asked(db, monkeypatch):
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    classifier = _classifier(monkeypatch, True)
    bot = _bot(db, "field-bare", description=None)

    frames = await _drive_stream(bot, PRODUCTION_QUESTION, "field-bare")

    assert _is_refusal(_answer_text(frames))
    assert captured["prompts"] == []
    assert classifier.calls == []


@pytest.mark.asyncio
async def test_a_relevant_turn_costs_no_second_opinion(db, monkeypatch):
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=True)
    classifier = _classifier(monkeypatch, False)
    bot = _bot(db, "field-relevant")

    await _drive_stream(bot, PRODUCTION_QUESTION, "field-relevant")

    assert len(captured["prompts"]) == 1
    assert classifier.calls == []


@pytest.mark.asyncio
async def test_an_empty_retrieval_is_not_let_through(db, monkeypatch):
    """With no chunks at all the model would answer from nothing, so the check is not asked."""
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=(), relevant=False)
    classifier = _classifier(monkeypatch, True)
    bot = _bot(db, "field-empty")

    frames = await _drive_stream(bot, PRODUCTION_QUESTION, "field-empty")

    assert captured["prompts"] == []
    assert classifier.calls == []
    assert not _answer_text(frames).endswith("".join(MODEL_REPLY))


# Production, 2026-09-17 14:25 UTC, CleanStart: the second opinion said YES
# (``gate_relaxed_field_question gate_score=0.00``), the turn reached the answer
# model, and the model replied with the prompt's scope line anyway.
SCOPE_LINE_REPLY = (
    "I'm here to help with questions about Acme. ",
    "Is there something about our services I can help with?",
)
FIELD_LINE = "THIS TURN, FIELD QUESTION:"


@pytest.fixture()
def metrics(monkeypatch):
    seen: list[tuple[str, dict]] = []
    real = rs._safety_net_metric

    def spy(name, **tags):
        seen.append((name, tags))
        real(name, **tags)

    monkeypatch.setattr(rs, "_safety_net_metric", spy)
    return seen


@pytest.mark.asyncio
async def test_a_relaxed_turn_tells_the_model_to_explain_the_concept(db, monkeypatch):
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    _classifier(monkeypatch, True)
    bot = _bot(db, "field-line")

    await _drive_stream(bot, PRODUCTION_QUESTION, "field-line")

    ((system, user),) = captured["prompts"]
    assert FIELD_LINE in user
    assert FIELD_LINE not in system
    assert "whether Acme offers it" in user


@pytest.mark.asyncio
async def test_a_relevant_turn_gets_no_field_question_line(db, monkeypatch):
    captured = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=True)
    _classifier(monkeypatch, True)
    bot = _bot(db, "field-no-line")

    await _drive_stream(bot, PRODUCTION_QUESTION, "field-no-line")

    ((_system, user),) = captured["prompts"]
    assert FIELD_LINE not in user


@pytest.mark.asyncio
async def test_a_relaxed_turn_is_not_written_to_the_answer_cache(db, monkeypatch):
    """The relax rests on a classifier's answer, so a cache hit must not skip it."""
    relaxed = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    # No by-name opener, which would keep the turn out of the cache on its own.
    _anonymous_visitor(monkeypatch)
    _classifier(monkeypatch, True)
    await _drive_stream(_bot(db, "field-cache-relaxed"), PRODUCTION_QUESTION, "field-cache-relaxed")

    assert relaxed["cache"].store == {}

    # The same turn judged relevant is cached, so the skip above is the relax's.
    relevant = _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=True)
    _anonymous_visitor(monkeypatch)
    await _drive_stream(_bot(db, "field-cache-relevant"), PRODUCTION_QUESTION, "field-cache-relevant")

    assert [value["answer"] for value in relevant["cache"].store.values()] == ["".join(MODEL_REPLY)]


@pytest.mark.asyncio
async def test_a_scope_refusal_after_the_relax_is_counted_and_not_retried(db, monkeypatch, metrics):
    captured = _stub_pipeline(monkeypatch, chunks=SCOPE_LINE_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    _anonymous_visitor(monkeypatch)
    _classifier(monkeypatch, True)
    bot = _bot(db, "field-refused")

    frames = await _drive_stream(bot, PRODUCTION_QUESTION, "field-refused")

    assert len(captured["prompts"]) == 1
    assert _answer_text(frames).endswith("Is there something about our services I can help with?")
    refused = [tags for name, tags in metrics if name == "field_question_answer_refused"]
    assert len(refused) == 1
    assert refused[0]["bot_id"] == bot.id


@pytest.mark.asyncio
async def test_a_scope_refusal_after_an_opener_is_counted(db, monkeypatch, metrics):
    """The stubbed visitor is greeted back by name, so the reply opens with "Welcome back, Tester!"."""
    _stub_pipeline(monkeypatch, chunks=SCOPE_LINE_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    _classifier(monkeypatch, True)
    bot = _bot(db, "field-refused-opener")

    frames = await _drive_stream(bot, PRODUCTION_QUESTION, "field-refused-opener")

    assert _answer_text(frames).startswith("Welcome back, Tester!")
    assert [name for name, _ in metrics if name == "field_question_answer_refused"] == ["field_question_answer_refused"]


@pytest.mark.asyncio
async def test_an_answer_after_the_relax_is_not_counted_as_refused(db, monkeypatch, metrics):
    _stub_pipeline(monkeypatch, chunks=MODEL_REPLY, retrieved=[WEAK_CHUNK], relevant=False)
    _classifier(monkeypatch, True)
    bot = _bot(db, "field-answered")

    await _drive_stream(bot, PRODUCTION_QUESTION, "field-answered")

    assert [name for name, _ in metrics if name == "field_question_answer_refused"] == []


@pytest.mark.asyncio
async def test_a_scope_line_on_a_relevant_turn_is_not_counted(db, monkeypatch, metrics):
    _stub_pipeline(monkeypatch, chunks=SCOPE_LINE_REPLY, retrieved=[WEAK_CHUNK], relevant=True)
    bot = _bot(db, "field-relevant-refused")

    await _drive_stream(bot, PRODUCTION_QUESTION, "field-relevant-refused")

    assert [name for name, _ in metrics if name == "field_question_answer_refused"] == []
