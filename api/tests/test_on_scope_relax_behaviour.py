"""The relaxation, driven through both real pipelines.

``tests/test_on_scope_relax.py`` pins the wiring at the source level, which is
what stops one of the two hand-maintained pipeline copies from silently losing
the guard. It cannot tell you whether the visitor's answer actually changed.
This does: it runs the pipeline with a judge that says "not relevant", and
asserts that an on-scope question with chunks in hand reaches generation while
the two cases that must still be refused still are.

Reproduces the live CleanStart failure: "what does cleanstart do" retrieved
fifteen chunks and was answered with the canned "I don't have that specific
detail on hand" pivot.
"""

from __future__ import annotations

import itertools
import json

import pytest

from app.db.models import Bot, ChatMessage, Client
from app.services import rag_service as rs

PIPELINES = ("stream", "sync")

_seq = itertools.count(1)

_ON_SCOPE = "what does acme do"
_OFF_TOPIC = "what is the capital of france"


class _FakeDoc:
    """The attribute surface the context builder and the gates touch."""

    def __init__(self, doc_id: int, document_name: str, content: str) -> None:
        self.id = doc_id
        self.document_name = document_name
        self.content = content
        self.media_urls = None


_CHUNKS = [
    _FakeDoc(1, "about.md", "Acme builds verified container images for software teams."),
    _FakeDoc(2, "services.md", "We offer hardened base images and dependency governance."),
]


def _make_client(db):
    n = next(_seq)
    client = Client(
        name=f"Relax Client {n}",
        email=f"relax{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"relax-key-{n}",
    )
    db.add(client)
    db.commit()
    return client


def _make_bot(db, client, **kwargs):
    n = next(_seq)
    bot = Bot(
        client_id=client.id,
        bot_key=f"bot-relax-{n}",
        name="Relax Bot",
        company_name="Acme",
        **kwargs,
    )
    db.add(bot)
    db.commit()
    return bot


@pytest.fixture()
def _stub_outside_world(monkeypatch):
    """Everything that leaves the process. The gate verdict and the retrieval
    result are set per test, because they are what these cases are about."""

    async def _no_embedding_async(*_a, **_k):
        return None

    monkeypatch.setattr(rs, "rewrite_query", lambda _sid, q, _h: q)
    monkeypatch.setattr(rs, "_embed_query_cached", lambda *_a, **_k: None)
    monkeypatch.setattr(rs, "_embed_query_cached_async", _no_embedding_async)
    monkeypatch.setattr(rs, "RERANK_ENABLED", False)
    monkeypatch.setattr(rs, "detect_handoff_intent", lambda _q: False)
    monkeypatch.setattr(rs, "resolve_name_flow", lambda *_a, **_k: (None, None, None, False))
    monkeypatch.setattr(rs, "_should_ask_visitor_name", lambda *_a, **_k: False)
    monkeypatch.setattr(rs, "check_visitor_safety", lambda _q: (True, None))
    monkeypatch.setattr(rs, "check_generated_answer_safety", lambda *a, **k: (True, None))
    monkeypatch.setattr(rs, "route_intent", lambda *a, **k: None)
    monkeypatch.setattr(rs, "should_sample", lambda: False)
    monkeypatch.setattr(rs, "submit_background", lambda _fn, *a, **k: None)
    monkeypatch.setattr(rs, "cache_get", lambda *a, **k: None)
    monkeypatch.setattr(rs, "cache_set", lambda *a, **k: None)
    monkeypatch.setattr(rs, "cache_delete", lambda *a, **k: None)
    monkeypatch.setattr(rs, "_generate_query_paraphrases", lambda *a, **k: [])
    monkeypatch.setenv("CAG_LITE_THRESHOLD", "0")


@pytest.fixture()
def _stub_generation(monkeypatch):
    """Capture every prompt. An empty list means a canned reply short-circuited
    before the model was ever called."""
    captured: dict = {"prompts": []}

    async def _fake_stream(prompt, **_kwargs):
        captured["prompts"].append(prompt)
        yield "GENERATED ANSWER"

    def _fake_checked(prompt, *_a, **_k):
        captured["prompts"].append(prompt)
        return "GENERATED ANSWER", False

    monkeypatch.setattr(rs, "generate_response_stream", _fake_stream)
    monkeypatch.setattr(rs, "generate_response", lambda *a, **k: "GENERATED ANSWER")
    monkeypatch.setattr(rs, "generate_response_checked", _fake_checked)
    return captured


def _retrieval(monkeypatch, chunks):
    """Both searches return ``(doc, score)`` pairs; RRF unpacks them."""
    ranked = [(doc, 1.0 - i / 10) for i, doc in enumerate(chunks)]
    monkeypatch.setattr(rs, "search_keyword_documents", lambda *a, **k: list(ranked))
    monkeypatch.setattr(rs, "search_similar_documents", lambda *a, **k: [])
    monkeypatch.setattr(rs, "_zero_result_multi_query_fallback", lambda *a, **k: [])


def _refusing_gate(monkeypatch):
    """The judge says no. Everything in this file is about what happens next."""
    monkeypatch.setattr(rs, "check_relevance", lambda *a, **k: (False, 0.1))


async def _collect(agen) -> list[str]:
    return [chunk async for chunk in agen]


def _answer_text(frames) -> str:
    return "".join(f for f in frames if not f.startswith(("METADATA:", "\nFINAL_METADATA:")))


async def _drive(pipeline: str, bot, question: str, session_id: str) -> str:
    if pipeline == "stream":
        frames = await _collect(rs.rag_pipeline_stream(bot, question, session_id=session_id, bot_id=bot.id))
        return _answer_text(frames)
    return rs.rag_pipeline(bot, question, session_id=session_id, bot_id=bot.id)["answer"]


def _persisted_reply(db, session_id) -> str:
    rows = (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == session_id, ChatMessage.role == "bot")
        .order_by(ChatMessage.id)
        .all()
    )
    assert rows, "nothing was persisted for this turn"
    return rows[-1].content


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_on_scope_question_with_chunks_is_answered_despite_the_judge(
    db, monkeypatch, pipeline, _stub_outside_world, _stub_generation
):
    _refusing_gate(monkeypatch)
    _retrieval(monkeypatch, _CHUNKS)
    bot = _make_bot(db, _make_client(db))
    session_id = f"relax-on-scope-{pipeline}"

    answer = await _drive(pipeline, bot, _ON_SCOPE, session_id)

    assert _stub_generation["prompts"], "the on-scope question never reached generation"
    assert answer == "GENERATED ANSWER"
    assert "specific detail on hand" not in answer
    assert "specific detail on hand" not in _persisted_reply(db, session_id)


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_the_chunks_reach_the_prompt_not_just_the_generation_call(
    db, monkeypatch, pipeline, _stub_outside_world, _stub_generation
):
    """Relaxing the gate is only worth anything if the model is given the
    material the judge was unimpressed by."""
    _refusing_gate(monkeypatch)
    _retrieval(monkeypatch, _CHUNKS)
    bot = _make_bot(db, _make_client(db))

    await _drive(pipeline, bot, _ON_SCOPE, f"relax-context-{pipeline}")

    prompt = "\n".join(_stub_generation["prompts"])
    assert "verified container images" in prompt


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_an_off_topic_question_is_still_refused(db, monkeypatch, pipeline, _stub_outside_world, _stub_generation):
    """The guard reads the question, so the scope promise has to survive it."""
    _refusing_gate(monkeypatch)
    _retrieval(monkeypatch, _CHUNKS)
    bot = _make_bot(db, _make_client(db))
    session_id = f"relax-off-topic-{pipeline}"

    answer = await _drive(pipeline, bot, _OFF_TOPIC, session_id)

    assert _stub_generation["prompts"] == [], "an off-topic question reached the model"
    assert answer != "GENERATED ANSWER"
    assert _persisted_reply(db, session_id) == answer


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_an_on_scope_question_with_no_chunks_still_takes_the_pivot(
    db, monkeypatch, pipeline, _stub_outside_world, _stub_generation
):
    """The deliberate limit of the relaxation: with nothing retrieved there is
    nothing to ground an answer in, and generating there is where hallucination
    comes from."""
    _refusing_gate(monkeypatch)
    _retrieval(monkeypatch, [])
    bot = _make_bot(db, _make_client(db))
    session_id = f"relax-no-chunks-{pipeline}"

    answer = await _drive(pipeline, bot, _ON_SCOPE, session_id)

    assert _stub_generation["prompts"] == [], "an empty context reached the model"
    assert "specific detail on hand" in answer


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_a_relevant_question_is_unaffected(db, monkeypatch, pipeline, _stub_outside_world, _stub_generation):
    """Control: with the judge happy, nothing about this path changed."""
    monkeypatch.setattr(rs, "check_relevance", lambda *a, **k: (True, 1.0))
    _retrieval(monkeypatch, _CHUNKS)
    bot = _make_bot(db, _make_client(db))

    answer = await _drive(pipeline, bot, _ON_SCOPE, f"relax-relevant-{pipeline}")

    assert _stub_generation["prompts"]
    assert answer == "GENERATED ANSWER"


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_the_judge_is_asked_about_the_query_retrieval_ran(
    db, monkeypatch, pipeline, _stub_outside_world, _stub_generation
):
    """The rewritten query, not the raw question. Driven rather than asserted
    against source text, so a future refactor that keeps the string and drops
    the behaviour is caught."""
    seen: dict = {}

    def _spy(question, chunks, *_a, **kwargs):
        seen["question"] = question
        seen["kb_version"] = kwargs.get("kb_version")
        return True, 1.0

    monkeypatch.setattr(rs, "rewrite_query", lambda _sid, _q, _h: "REWRITTEN QUERY")
    monkeypatch.setattr(rs, "check_relevance", _spy)
    _retrieval(monkeypatch, _CHUNKS)
    bot = _make_bot(db, _make_client(db))

    await _drive(pipeline, bot, "and what about that one?", f"relax-rewrite-{pipeline}")

    assert seen.get("question") == "REWRITTEN QUERY"
    assert seen.get("kb_version"), "the verdict was cached without a knowledge-base fingerprint"


def test_the_metadata_frame_shape_is_unchanged():
    """Guard against the relaxation changing what the widget parses."""
    frame = rs._stream_metadata("sess", [])
    assert frame.startswith("METADATA:")
    json.loads(frame.split("METADATA:", 1)[1].strip())


# ── The pricing opt-out, driven the same way ─────────────────────────────────

_PRICED_CHUNK = _FakeDoc(9, "about.md", "Our Pro plan costs $49 per month, billed annually.")
_PRICING_QUESTION = "how much does the pro plan cost?"


def _paid_plan(monkeypatch):
    """A plan with a human path, so the gate actually engages.

    Without this the bot is Free with no pricing page and no contact link,
    which is the documented ``no_support_path_standdown``: the gate stands down
    rather than dead-ending a visitor it has nowhere to escalate to. That is
    correct behaviour and it would quietly make the control case below pass for
    the wrong reason.
    """
    monkeypatch.setattr(rs.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *_a, **_k: True)


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_an_opted_out_bot_answers_pricing_from_its_documents(
    db, monkeypatch, pipeline, _stub_outside_world, _stub_generation
):
    """The bot has no pricing page, and its price lives in an ordinary
    document. That is the customer this setting exists for."""
    _paid_plan(monkeypatch)
    monkeypatch.setattr(rs, "check_relevance", lambda *a, **k: (True, 1.0))
    _retrieval(monkeypatch, [_PRICED_CHUNK])
    bot = _make_bot(db, _make_client(db), pricing_url=None, pricing_from_knowledge_base=True)

    answer = await _drive(pipeline, bot, _PRICING_QUESTION, f"optout-on-{pipeline}")

    assert _stub_generation["prompts"], "the opted-out bot escalated instead of answering"
    assert answer == "GENERATED ANSWER"
    assert "$49 per month" in "\n".join(_stub_generation["prompts"])


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_the_same_bot_with_the_default_still_escalates(
    db, monkeypatch, pipeline, _stub_outside_world, _stub_generation
):
    """Control, and the more important half: every bot that never touches the
    setting is gated exactly as it was."""
    _paid_plan(monkeypatch)
    monkeypatch.setattr(rs, "check_relevance", lambda *a, **k: (True, 1.0))
    _retrieval(monkeypatch, [_PRICED_CHUNK])
    bot = _make_bot(db, _make_client(db), pricing_url=None)
    session_id = f"optout-off-{pipeline}"

    answer = await _drive(pipeline, bot, _PRICING_QUESTION, session_id)

    assert _stub_generation["prompts"] == [], "a gated bot let the knowledge base answer a pricing question"
    assert "$49" not in answer
    assert "$49" not in _persisted_reply(db, session_id)


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_an_opted_out_bot_with_nothing_retrieved_does_not_invent_a_price(
    db, monkeypatch, pipeline, _stub_outside_world, _stub_generation
):
    """Opting out removes the gate, not the grounding: with no chunks the
    empty-context pivot still owns the turn."""
    _paid_plan(monkeypatch)
    monkeypatch.setattr(rs, "check_relevance", lambda *a, **k: (True, 1.0))
    _retrieval(monkeypatch, [])
    bot = _make_bot(db, _make_client(db), pricing_url=None, pricing_from_knowledge_base=True)

    answer = await _drive(pipeline, bot, _PRICING_QUESTION, f"optout-empty-{pipeline}")

    assert _stub_generation["prompts"] == []
    assert "$" not in answer
