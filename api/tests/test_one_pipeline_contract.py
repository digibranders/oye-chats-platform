"""``POST /chat`` answers from the same pipeline the widget uses.

There were two copies of the chat pipeline: ``rag_pipeline`` (1,676 lines) and
``rag_pipeline_stream``, about 74% byte-identical, maintained by hand, and
already drifted in a dozen places. No product surface called the synchronous
one: the widget streams, and so does the dashboard preview. Its only callers
were the eval harness and any external API user, both of which were therefore
being measured on a code path no visitor ever took.

``rag_pipeline`` is now a collector over the streaming generator. These tests
pin the collector's contract, because the route returns its dict straight to
the caller as JSON and refunds a credit based on one of its keys.
"""

from __future__ import annotations

import itertools

import pytest

from app.db.models import Bot, ChatMessage, Client
from app.services import rag_service as rs

_seq = itertools.count(1)


class _FakeDoc:
    def __init__(self, doc_id: int, document_name: str, content: str) -> None:
        self.id = doc_id
        self.document_name = document_name
        self.content = content
        self.media_urls = None


_CHUNKS = [_FakeDoc(1, "about.md", "Acme builds analytics tooling for finance teams.")]


def _make_bot(db):
    n = next(_seq)
    client = Client(
        name=f"Contract Client {n}",
        email=f"contract{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"contract-key-{n}",
    )
    db.add(client)
    db.commit()
    bot = Bot(client_id=client.id, bot_key=f"bot-contract-{n}", name="Contract Bot", company_name="Acme")
    db.add(bot)
    db.commit()
    return bot


@pytest.fixture()
def _stubbed(monkeypatch):
    async def _no_embedding_async(*_a, **_k):
        return None

    async def _fake_stream(prompt, **_kwargs):
        yield "GENERATED ANSWER"

    monkeypatch.setattr(rs, "rewrite_query", lambda _sid, q, _h: q)
    monkeypatch.setattr(rs, "_embed_query_cached", lambda *_a, **_k: None)
    monkeypatch.setattr(rs, "_embed_query_cached_async", _no_embedding_async)
    monkeypatch.setattr(rs, "RERANK_ENABLED", False)
    monkeypatch.setattr(rs, "detect_handoff_intent", lambda _q, **_kw: False)
    monkeypatch.setattr(rs, "resolve_name_flow", lambda *_a, **_k: (None, None, None, False))
    monkeypatch.setattr(rs, "_should_ask_visitor_name", lambda *_a, **_k: False)
    monkeypatch.setattr(rs, "check_visitor_safety", lambda _q: (True, None))
    monkeypatch.setattr(rs, "check_generated_answer_safety", lambda *a, **k: (True, None))
    monkeypatch.setattr(rs, "route_intent", lambda *a, **k: None)
    monkeypatch.setattr(rs, "should_sample", lambda: False)
    monkeypatch.setattr(rs, "submit_background", lambda _fn, *a, **k: None)
    monkeypatch.setattr(rs, "_enqueue_qualification", lambda *a, **k: None)
    monkeypatch.setattr(rs, "cache_get", lambda *a, **k: None)
    monkeypatch.setattr(rs, "cache_set", lambda *a, **k: None)
    monkeypatch.setattr(rs, "cache_delete", lambda *a, **k: None)
    monkeypatch.setattr(rs, "_generate_query_paraphrases", lambda *a, **k: [])
    monkeypatch.setattr(rs, "generate_response_stream", _fake_stream)
    monkeypatch.setattr(rs, "generate_response", lambda *a, **k: "GENERATED ANSWER")
    monkeypatch.setattr(rs, "check_relevance", lambda *a, **k: (True, 1.0))
    ranked = [(doc, 1.0) for doc in _CHUNKS]
    monkeypatch.setattr(rs, "search_keyword_documents", lambda *a, **k: list(ranked))
    monkeypatch.setattr(rs, "search_similar_documents", lambda *a, **k: [])
    monkeypatch.setattr(rs, "_zero_result_multi_query_fallback", lambda *a, **k: [])
    monkeypatch.setattr(rs, "CAG_LITE_THRESHOLD", 0)


class TestTheCollectorReturnsWhatTheRouteNeeds:
    def test_an_answered_turn(self, db, _stubbed):
        bot = _make_bot(db)

        result = rs.rag_pipeline(bot, "what does acme do", session_id="contract-answered", bot_id=bot.id)

        assert result["answer"] == "GENERATED ANSWER"
        assert result["session_id"] == "contract-answered"
        assert isinstance(result["sources"], list)
        assert result.get("message_id") is not None

    def test_the_answer_is_persisted_exactly_once(self, db, _stubbed):
        bot = _make_bot(db)

        rs.rag_pipeline(bot, "what does acme do", session_id="contract-persist", bot_id=bot.id)

        rows = (
            db.query(ChatMessage).filter(ChatMessage.session_id == "contract-persist", ChatMessage.role == "bot").all()
        )
        assert len(rows) == 1
        assert rows[0].content == "GENERATED ANSWER"

    def test_a_canned_reply_still_carries_a_session_and_a_message_id(self, db, monkeypatch, _stubbed):
        """An early return (here, the off-topic refusal) emits its metadata
        frame and its final frame, so the collector must still find both."""
        monkeypatch.setattr(rs, "check_relevance", lambda *a, **k: (False, 0.0))
        bot = _make_bot(db)

        result = rs.rag_pipeline(bot, "what is the capital of france", session_id="contract-canned", bot_id=bot.id)

        assert result["answer"]
        assert result["answer"] != "GENERATED ANSWER"
        assert result["session_id"] == "contract-canned"
        assert result.get("message_id") is not None

    def test_the_refund_key_survives_the_collection(self, db, monkeypatch, _stubbed):
        """``POST /chat`` refunds a credit on ``generation_failed``. If the
        collector dropped the key, every failed answer would be charged."""

        async def _empty_stream(prompt, **_kwargs):
            if False:  # pragma: no cover - an empty async generator
                yield ""

        monkeypatch.setattr(rs, "generate_response_stream", _empty_stream)
        bot = _make_bot(db)

        result = rs.rag_pipeline(bot, "what does acme do", session_id="contract-failed", bot_id=bot.id)

        assert result.get("generation_failed") is True


class TestThereIsOnlyOnePipelineLeft:
    def test_the_sync_pipeline_is_a_collector_not_a_second_copy(self):
        import inspect

        source = inspect.getsource(rs.rag_pipeline)

        assert "rag_pipeline_stream" in source, "the synchronous path must drain the streaming one"
        assert len(source.splitlines()) < 80, "this is meant to be a thin collector, not a second pipeline"

    def test_the_gates_are_no_longer_duplicated(self):
        import inspect

        source = inspect.getsource(rs.rag_pipeline)

        for owned_by_the_stream in ("check_relevance", "evaluate_pricing_gate", "_relax_on_scope"):
            assert owned_by_the_stream not in source, f"{owned_by_the_stream} is still duplicated"


class TestTheGuardsSurviveTheCollection:
    """The stream cannot recall bytes it already sent, so on a leak or a
    moderation hit it rewrites only the PERSISTED text. The collector joins
    every frame it saw, which handed ``POST /chat`` callers the leaked or
    unsafe text the old synchronous path never returned. The final frame now
    carries the persisted text whenever a guard rewrote it, and the collector
    prefers that."""

    def test_a_prompt_leak_returns_only_the_refusal(self, db, monkeypatch, _stubbed):
        leak = f"GENERATED ANSWER {rs._LEAKAGE_SENTINELS[0]} secret rules"

        async def _leaking_stream(prompt, **_kwargs):
            yield leak

        monkeypatch.setattr(rs, "generate_response_stream", _leaking_stream)
        bot = _make_bot(db)

        result = rs.rag_pipeline(bot, "what does acme do", session_id="contract-leak", bot_id=bot.id)

        row = db.query(ChatMessage).filter(ChatMessage.session_id == "contract-leak", ChatMessage.role == "bot").one()
        assert rs._LEAKAGE_SENTINELS[0] not in result["answer"]
        assert "GENERATED ANSWER" not in result["answer"]
        assert result["answer"] == row.content

    def test_a_moderation_hit_returns_only_the_refusal(self, db, monkeypatch, _stubbed):
        monkeypatch.setattr(rs, "check_generated_answer_safety", lambda *a, **k: (False, "hate"))
        bot = _make_bot(db)

        result = rs.rag_pipeline(bot, "what does acme do", session_id="contract-moderated", bot_id=bot.id)

        row = (
            db.query(ChatMessage)
            .filter(ChatMessage.session_id == "contract-moderated", ChatMessage.role == "bot")
            .one()
        )
        assert "GENERATED ANSWER" not in result["answer"]
        assert result["answer"] == row.content

    def test_an_interrupted_generation_is_a_failed_one_for_the_sync_caller(self, db, monkeypatch, _stubbed):
        """The SSE path deliberately leaves ``generation_failed`` false on a
        mid-stream drop, because the visitor already read the partial. A
        ``POST /chat`` caller read nothing yet, so a partial is a failure and
        the credit comes back."""

        async def _dropping_stream(prompt, status=None, **_kwargs):
            yield "Acme is"
            if status is not None:
                status["error"] = True
                status["failed"] = False
            yield " [Response interrupted. Please try again.]"

        monkeypatch.setattr(rs, "generate_response_stream", _dropping_stream)
        bot = _make_bot(db)

        result = rs.rag_pipeline(bot, "what does acme do", session_id="contract-interrupted", bot_id=bot.id)

        assert result.get("generation_failed") is True

    def test_a_mid_stream_exception_is_a_failed_one_for_the_sync_caller(self, db, monkeypatch, _stubbed):
        async def _exploding_stream(prompt, **_kwargs):
            yield "Acme is"
            raise RuntimeError("provider closed the socket")

        monkeypatch.setattr(rs, "generate_response_stream", _exploding_stream)
        bot = _make_bot(db)

        result = rs.rag_pipeline(bot, "what does acme do", session_id="contract-exploded", bot_id=bot.id)

        assert result.get("generation_failed") is True


class TestAskingForAPersonSkipsExtractionWhateverTheWording:
    """The extraction skip was two English regexes. The handoff OFFER falls
    through to an LLM classifier when they miss, so a visitor who asked for a
    person in Hindi, or in English the regexes did not know, was offered a
    human AND scored as a lead. The pipeline's own handoff decision is now the
    skip signal."""

    def test_a_classifier_detected_handoff_is_not_scored(self, db, monkeypatch, _stubbed):
        monkeypatch.setattr(rs, "detect_handoff_intent", lambda _q, **_kw: True)
        monkeypatch.setattr(rs.plan_entitlements_service, "is_bant_enabled_for_bot", lambda *_a, **_k: True)
        enqueued: list[tuple] = []
        monkeypatch.setattr(rs, "_enqueue_qualification", lambda *a, **k: enqueued.append(a))
        bot = _make_bot(db)
        bot.bant_enabled = True
        db.commit()

        rs.rag_pipeline(bot, "mujhe kisi insaan se baat karni hai", session_id="contract-hindi-handoff", bot_id=bot.id)

        assert enqueued == []

    def test_a_qualifying_message_is_still_scored(self, db, monkeypatch, _stubbed):
        monkeypatch.setattr(rs.plan_entitlements_service, "is_bant_enabled_for_bot", lambda *_a, **_k: True)
        enqueued: list[tuple] = []
        monkeypatch.setattr(rs, "_enqueue_qualification", lambda *a, **k: enqueued.append(a))
        bot = _make_bot(db)
        bot.bant_enabled = True
        db.commit()

        rs.rag_pipeline(
            bot, "we have a budget of around 50k for this quarter", session_id="contract-budget", bot_id=bot.id
        )

        assert len(enqueued) == 1


class TestTheRunningLoopBranchKeepsTheCallersContext:
    """When a loop is already running on the caller's thread the collector
    runs on a private thread. Submitting a bare lambda there starts from an
    empty context, so every ContextVar (Langfuse trace, request id) set by
    the caller was invisible to the pipeline on that branch."""

    @pytest.mark.asyncio
    async def test_a_contextvar_set_by_the_caller_is_visible_inside(self, monkeypatch):
        import contextvars

        marker: contextvars.ContextVar[str] = contextvars.ContextVar("contract_marker", default="unset")
        marker.set("from-the-caller")

        async def _fake_collect(_client, _question, **_kwargs):
            return {"answer": marker.get(), "session_id": "ctx", "sources": [], "message_id": 1}

        monkeypatch.setattr(rs, "collect_rag_pipeline", _fake_collect)

        result = rs.rag_pipeline(None, "q", session_id="ctx")

        assert result["answer"] == "from-the-caller"
