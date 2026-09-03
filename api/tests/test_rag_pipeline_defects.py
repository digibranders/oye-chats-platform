"""Regression tests for verified defects in the RAG pipelines.

These drive the REAL ``rag_pipeline_stream`` / ``rag_pipeline`` against a real
throwaway Postgres (the shared ``db`` / ``pg_engine`` fixtures), stubbing only
the outside world: the LLM stream, query rewriting/embedding, the relevance
gate, Redis and the plan-entitlements lookup. Everything the defects are about
(scope gating, grounding short-circuits, persistence, caching, the
``generation_failed`` signal) runs unmocked, which is the only way these
assertions can be trusted.

Covered:
  * visitor-supplied ``cta_dimension`` must not bypass grounding or forge BANT
  * a failed LLM generation must not be cached or reported as a success
  * off-topic refusals must be persisted and must emit FINAL_METADATA
  * a mid-stream client disconnect must not lose the generated answer
  * a media-bearing bot must still get QA cache hits
"""

import json
from types import SimpleNamespace

import pytest

from app.db.models import Bot, ChatMessage, ChatSession, Client
from app.services import rag_service as rs

_seq = iter(range(1, 100_000))


def _make_client(db):
    n = next(_seq)
    client = Client(
        name=f"Defect Client {n}",
        email=f"defect{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"defect-test-key-{n}",
    )
    db.add(client)
    db.commit()
    return client


def _make_bot(db, client, **kwargs):
    n = next(_seq)
    bot = Bot(
        client_id=client.id,
        bot_key=f"bot-defect-{n}",
        name="Defect Bot",
        company_name="Acme",
        **kwargs,
    )
    db.add(bot)
    db.commit()
    return bot


def _make_session(db, bot, client, session_id, **kwargs):
    cs = ChatSession(id=session_id, bot_id=bot.id, client_id=client.id, **kwargs)
    db.add(cs)
    db.commit()
    return cs


def _messages(db, session_id, role=None):
    q = db.query(ChatMessage).filter(ChatMessage.session_id == session_id)
    if role:
        q = q.filter(ChatMessage.role == role)
    return q.order_by(ChatMessage.id).all()


class _Cache:
    """Stand-in for the Redis QA cache, so a cache write is observable."""

    def __init__(self):
        self.store: dict = {}
        self.deleted: list = []

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value, ttl=None):
        self.store[key] = value

    def delete(self, key):
        self.deleted.append(key)
        self.store.pop(key, None)


class _Doc(SimpleNamespace):
    """Minimal stand-in for a retrieved Document row."""


def _doc(content, name="kb.txt"):
    return _Doc(content=content, document_name=name, media_urls=None, id=next(_seq))


def _stub_pipeline(
    monkeypatch,
    *,
    chunks=("Our hours are 9 to 5.",),
    retrieved=(),
    relevant=True,
    bant_enabled=False,
    support=False,
    cache=None,
    llm_status=None,
):
    """Neutralise everything outside the pipeline. Returns the captured prompts."""
    captured: dict = {"prompts": [], "cta_signals": []}

    async def fake_stream(prompt, **kwargs):
        captured["prompts"].append((kwargs.get("system_prompt"), prompt))
        status = kwargs.get("status")
        if llm_status and status is not None:
            status.update(llm_status)
        for chunk in chunks:
            yield chunk

    monkeypatch.setattr(rs, "generate_response_stream", fake_stream)
    monkeypatch.setattr(rs, "generate_response", lambda *a, **k: "".join(chunks))
    monkeypatch.setattr(
        rs,
        "generate_response_checked",
        lambda *a, **k: ("".join(chunks), bool((llm_status or {}).get("failed"))),
    )

    async def fake_resolve(session_id, question, history, bid, cid, company_name):
        return question, None

    monkeypatch.setattr(rs, "_resolve_search_query_and_embedding", fake_resolve)
    monkeypatch.setattr(rs, "_vector_search", lambda *a, **k: [])
    monkeypatch.setattr(rs, "_keyword_search", lambda *a, **k: [])
    monkeypatch.setattr(rs, "_zero_result_multi_query_fallback", lambda *a, **k: [])
    monkeypatch.setattr(rs, "reciprocal_rank_fusion", lambda *a, **k: list(retrieved))
    monkeypatch.setattr(rs, "_trim_results", lambda results, top_k=15: results)
    monkeypatch.setattr(rs, "rerank", lambda q, results, top_n=None: results)
    monkeypatch.setattr(rs, "check_relevance", lambda *a, **k: (relevant, 1.0 if relevant else 0.0))
    monkeypatch.setattr(rs, "check_generated_answer_safety", lambda *a, **k: (True, None))
    monkeypatch.setattr(rs, "check_visitor_safety", lambda q: (True, None))
    monkeypatch.setattr(rs, "route_intent", lambda *a, **k: None)
    monkeypatch.setattr(rs, "detect_handoff_intent", lambda q: False)
    monkeypatch.setattr(rs, "resolve_name_flow", lambda *a, **k: (None, None, "Tester", False))
    monkeypatch.setattr(rs, "resolve_visitor_name", lambda *a, **k: "Tester")
    monkeypatch.setattr(rs, "_should_ask_visitor_name", lambda *a, **k: False)
    monkeypatch.setattr(rs, "submit_background", lambda fn, *a, **k: captured.setdefault("bg", []).append((fn, a)))
    monkeypatch.setattr(rs, "should_sample", lambda: False)
    monkeypatch.setattr(rs.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *a, **k: support)
    monkeypatch.setattr(rs.plan_entitlements_service, "is_bant_enabled_for_bot", lambda *a, **k: bant_enabled)

    cache = cache or _Cache()
    monkeypatch.setattr(rs, "cache_get", cache.get)
    monkeypatch.setattr(rs, "cache_set", cache.set)
    monkeypatch.setattr(rs, "cache_delete", cache.delete)
    captured["cache"] = cache

    _real_score = rs._score_cta_answer

    def _spy_score(cta_dimension, answer_text, framework_config):
        out = _real_score(cta_dimension, answer_text, framework_config)
        captured["cta_signals"].append((cta_dimension, out))
        return out

    monkeypatch.setattr(rs, "_score_cta_answer", _spy_score)
    return captured


async def _drive_stream(bot, question, session_id, **kwargs):
    frames = []
    async for frame in rs.rag_pipeline_stream(bot, question, session_id, bot_id=bot.id, **kwargs):
        frames.append(frame)
    return frames


def _final_meta(frames):
    for frame in reversed(frames):
        if frame.startswith("\nFINAL_METADATA:"):
            return json.loads(frame.split("FINAL_METADATA:", 1)[1].strip())
    return None


def _answer_text(frames):
    return "".join(f for f in frames if not f.startswith(("METADATA:", "\nFINAL_METADATA:")))


# ── Defect 1: cta_dimension must not bypass grounding or forge BANT ──────────

_FRAMEWORK = {
    "budget": {
        "label": "Budget",
        "options": [
            {"label": "$20K+/mo", "score": 10},
            {"label": "under $1K/mo", "score": 2},
        ],
    },
    "timeline": {
        "label": "Timeline",
        "options": [{"label": "this month", "score": 10}],
    },
}


class TestForgedCtaDimension:
    """``cta_dimension`` is free text on the public /chat body. It used to be
    believed on bare truthiness, which let a crafted request skip the
    empty-context hard refusal (the product's grounding guarantee) and award
    itself full rubric points on any dimension."""

    @pytest.mark.asyncio
    async def test_forged_cta_cannot_skip_the_empty_context_refusal(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-forge-1")
        cap = _stub_pipeline(monkeypatch, retrieved=(), chunks=("SHOULD NEVER BE GENERATED",))

        frames = await _drive_stream(bot, "what is the capital of france", "sess-forge-1", cta_dimension="budget")

        # No LLM generation at all: the turn must stop at the refusal.
        assert cap["prompts"] == []
        assert "SHOULD NEVER BE GENERATED" not in _answer_text(frames)

    @pytest.mark.asyncio
    async def test_genuine_cta_still_bypasses_the_refusal(self, db, monkeypatch):
        """The legitimate flow: the bot probed ``budget`` last turn, so the
        session records it and the pill answer must still reach generation."""
        client = _make_client(db)
        bot = _make_bot(db, client, bant_enabled=True)
        _make_session(db, bot, client, "sess-forge-2", last_probed_dimension="budget")
        cap = _stub_pipeline(monkeypatch, retrieved=(), bant_enabled=True, chunks=("Got it, thanks!",))

        await _drive_stream(bot, "$20K+/mo", "sess-forge-2", cta_dimension="budget")

        assert len(cap["prompts"]) == 1, "a real CTA pill answer must still reach generation"

    @pytest.mark.asyncio
    async def test_forged_cta_is_not_scored_against_the_rubric(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client, bant_enabled=True)
        _make_session(db, bot, client, "sess-forge-3")
        monkeypatch.setattr(rs, "get_framework_config", lambda bot: _FRAMEWORK)
        cap = _stub_pipeline(
            monkeypatch,
            retrieved=(_doc("Acme sells widgets."),),
            bant_enabled=True,
            chunks=("Thanks!",),
        )

        await _drive_stream(bot, "$20K+/mo", "sess-forge-3", cta_dimension="budget")

        assert cap["cta_signals"], "the scorer must still be reached"
        for passed_dimension, signal in cap["cta_signals"]:
            assert passed_dimension is None
            assert signal is None, "a forged pill tap must not award rubric points"

    @pytest.mark.asyncio
    async def test_genuine_cta_is_scored_against_the_rubric(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client, bant_enabled=True)
        _make_session(db, bot, client, "sess-forge-4", last_probed_dimension="budget")
        monkeypatch.setattr(rs, "get_framework_config", lambda bot: _FRAMEWORK)
        cap = _stub_pipeline(
            monkeypatch,
            retrieved=(_doc("Acme sells widgets."),),
            bant_enabled=True,
            chunks=("Thanks!",),
        )

        await _drive_stream(bot, "$20K+/mo", "sess-forge-4", cta_dimension="budget")

        scored = [s for _dim, s in cap["cta_signals"] if s is not None]
        assert scored and scored[0]["dimension"] == "budget"
        assert scored[0]["score"] == 10

    @pytest.mark.asyncio
    async def test_cross_dimension_forgery_is_rejected(self, db, monkeypatch):
        """The bot probed ``budget``; the visitor claims to be answering
        ``timeline`` to collect a second dimension's points in one turn."""
        client = _make_client(db)
        bot = _make_bot(db, client, bant_enabled=True)
        _make_session(db, bot, client, "sess-forge-5", last_probed_dimension="budget")
        monkeypatch.setattr(rs, "get_framework_config", lambda bot: _FRAMEWORK)
        cap = _stub_pipeline(
            monkeypatch,
            retrieved=(_doc("Acme sells widgets."),),
            bant_enabled=True,
            chunks=("Thanks!",),
        )

        await _drive_stream(bot, "this month", "sess-forge-5", cta_dimension="timeline")

        assert all(signal is None for _dim, signal in cap["cta_signals"])

    def test_nonstream_forged_cta_cannot_skip_the_empty_context_refusal(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-forge-6")
        cap = _stub_pipeline(monkeypatch, retrieved=(), chunks=("SHOULD NEVER BE GENERATED",))

        result = rs.rag_pipeline(
            bot, "what is the capital of france", "sess-forge-6", bot_id=bot.id, cta_dimension="budget"
        )

        assert cap["prompts"] == []
        assert "SHOULD NEVER BE GENERATED" not in result["answer"]


# ── Defect 2: a failed generation must not be billed, cached or persisted ────


class TestFailedGenerationIsNotBilledOrCached:
    """Every failure branch of ``generate_response_stream`` yields an error
    STRING, so ``chunk_count`` counted it as a real answer: the outage got
    cached for QA_RESPONSE_TTL and ``generation_failed`` came back False, so
    the route never refunded the credit."""

    @pytest.mark.asyncio
    async def test_total_failure_reports_generation_failed(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-fail-1")
        _stub_pipeline(
            monkeypatch,
            retrieved=(_doc("Acme opens at 9."),),
            chunks=(" [I encountered an error. Please try again.]",),
            llm_status={"error": True, "failed": True},
        )

        frames = await _drive_stream(bot, "when do you open", "sess-fail-1")

        assert _final_meta(frames)["generation_failed"] is True

    @pytest.mark.asyncio
    async def test_total_failure_is_not_written_to_the_qa_cache(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-fail-2")
        cap = _stub_pipeline(
            monkeypatch,
            retrieved=(_doc("Acme opens at 9."),),
            chunks=(" [I encountered an error. Please try again.]",),
            llm_status={"error": True, "failed": True},
        )

        await _drive_stream(bot, "when do you open", "sess-fail-2")

        assert cap["cache"].store == {}, "an LLM outage must never be cached and replayed for an hour"

    @pytest.mark.asyncio
    async def test_mid_stream_failure_is_not_cached_but_is_not_refunded(self, db, monkeypatch):
        """Partial content reached the visitor: don't poison the cache with the
        truncated answer, but don't over-refund a partly delivered turn."""
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-fail-3")
        cap = _stub_pipeline(
            monkeypatch,
            retrieved=(_doc("Acme opens at 9."),),
            chunks=("We open at ", " [Response interrupted. Please try again.]"),
            llm_status={"error": True, "failed": False},
        )

        frames = await _drive_stream(bot, "when do you open", "sess-fail-3")

        assert cap["cache"].store == {}
        assert _final_meta(frames)["generation_failed"] is False

    @pytest.mark.asyncio
    async def test_successful_generation_is_still_cached_and_not_flagged(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-fail-4")
        cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme opens at 9."),), chunks=("We open at 9.",))

        frames = await _drive_stream(bot, "when do you open", "sess-fail-4")

        assert len(cap["cache"].store) == 1
        assert _final_meta(frames)["generation_failed"] is False


# ── Defect 3: off-topic refusals must be persisted + emit FINAL_METADATA ─────


class TestRefusalIsPersisted:
    """The graceful "no info" pivot persisted its reply, committed and emitted
    FINAL_METADATA; the sibling off-topic refusal did none of the three. The
    admin transcript showed a visitor question with no bot reply, the
    ``is_unanswered`` analytics marker was lost for exactly the turns that
    need it, and the widget rendered feedback buttons wired to a message_id
    that was never issued."""

    @pytest.mark.asyncio
    async def test_gate_fired_refusal_is_persisted_with_final_metadata(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-refuse-1")
        _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),), relevant=False)

        frames = await _drive_stream(bot, "what is 2 plus 2", "sess-refuse-1")

        meta = _final_meta(frames)
        assert meta is not None, "the widget hangs / feedback 404s without a terminal frame"
        assert isinstance(meta["message_id"], int)

        bot_msgs = _messages(db, "sess-refuse-1", role="bot")
        assert len(bot_msgs) == 1
        assert bot_msgs[0].id == meta["message_id"]
        assert bot_msgs[0].is_unanswered is True

    @pytest.mark.asyncio
    async def test_empty_retrieval_refusal_is_persisted_with_final_metadata(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-refuse-2")
        _stub_pipeline(monkeypatch, retrieved=())

        frames = await _drive_stream(bot, "what is 2 plus 2", "sess-refuse-2")

        meta = _final_meta(frames)
        assert meta is not None
        bot_msgs = _messages(db, "sess-refuse-2", role="bot")
        assert len(bot_msgs) == 1
        assert bot_msgs[0].id == meta["message_id"]
        assert bot_msgs[0].is_unanswered is True

    def test_nonstream_gate_fired_refusal_is_persisted(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-refuse-3")
        _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),), relevant=False)

        result = rs.rag_pipeline(bot, "what is 2 plus 2", "sess-refuse-3", bot_id=bot.id)

        bot_msgs = _messages(db, "sess-refuse-3", role="bot")
        assert len(bot_msgs) == 1
        assert result["message_id"] == bot_msgs[0].id
        assert bot_msgs[0].is_unanswered is True
        assert bot_msgs[0].content == result["answer"]

    def test_nonstream_empty_retrieval_refusal_is_persisted(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-refuse-4")
        _stub_pipeline(monkeypatch, retrieved=())

        result = rs.rag_pipeline(bot, "what is 2 plus 2", "sess-refuse-4", bot_id=bot.id)

        bot_msgs = _messages(db, "sess-refuse-4", role="bot")
        assert len(bot_msgs) == 1
        assert result["message_id"] == bot_msgs[0].id
        assert bot_msgs[0].is_unanswered is True


# ── Defect 6: a mid-stream disconnect must not lose the answer ───────────────


class TestDisconnectMidStream:
    """``GeneratorExit`` is a BaseException, so the pipeline's ``except
    Exception`` never saw a visitor closing the tab: the whole turn unwound
    through ``with get_session()`` and rolled back, losing text the visitor
    had already been shown."""

    @pytest.mark.asyncio
    async def test_partial_answer_survives_a_client_disconnect(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-drop-1")
        _stub_pipeline(
            monkeypatch,
            retrieved=(_doc("Acme opens at 9."),),
            chunks=("We open at 9", " and close at 5.", " Anything else?"),
        )

        agen = rs.rag_pipeline_stream(bot, "when do you open", "sess-drop-1", bot_id=bot.id)
        seen = []
        async for frame in agen:
            seen.append(frame)
            if "We open at 9" in frame:
                break  # visitor closes the tab
        await agen.aclose()

        bot_msgs = _messages(db, "sess-drop-1", role="bot")
        assert len(bot_msgs) == 1, "the text already shown to the visitor must be in the transcript"
        assert "We open at 9" in bot_msgs[0].content

    @pytest.mark.asyncio
    async def test_visitor_question_still_persisted_on_disconnect(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-drop-2")
        _stub_pipeline(monkeypatch, retrieved=(_doc("Acme opens at 9."),), chunks=("We open at 9",))

        agen = rs.rag_pipeline_stream(bot, "when do you open", "sess-drop-2", bot_id=bot.id)
        async for frame in agen:
            if "We open at 9" in frame:
                break
        await agen.aclose()

        assert [m.content for m in _messages(db, "sess-drop-2", role="user")] == ["when do you open"]


# ── Defect 9: a media-bearing bot must still get QA cache hits ───────────────


class TestMediaBotQaCache:
    """A bot with any media URL in its KB deleted its cache entry on every hit
    AND skipped every cache write, so the QA cache was permanently dead for it:
    every turn paid for a full generation."""

    @pytest.mark.asyncio
    async def test_cardless_answer_is_cached_for_a_media_bearing_bot(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-media-1")
        cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme opens at 9."),), chunks=("We open at 9.",))
        monkeypatch.setattr(
            rs,
            "get_bot_media_urls",
            lambda *a, **k: [{"youtube": [{"video_id": "abc12345678"}], "files": []}],
        )

        await _drive_stream(bot, "when do you open", "sess-media-1")

        assert len(cap["cache"].store) == 1, "a card-less answer is safe to cache even for a media bot"

    @pytest.mark.asyncio
    async def test_cache_hit_is_served_instead_of_being_deleted(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-media-2")
        cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme opens at 9."),), chunks=("SHOULD NOT REGENERATE",))
        monkeypatch.setattr(
            rs,
            "get_bot_media_urls",
            lambda *a, **k: [{"youtube": [{"video_id": "abc12345678"}], "files": []}],
        )
        key = rs.qa_response_key(bot.id, rs.hashlib.sha256(b"when do you open").hexdigest()[:32], None)
        cap["cache"].store[key] = {"answer": "We open at 9.", "sources": ["kb.txt"]}

        frames = await _drive_stream(bot, "when do you open", "sess-media-2")

        assert "We open at 9." in _answer_text(frames)
        assert cap["prompts"] == [], "a cache hit must not fall through to a full generation"
        assert cap["cache"].deleted == []

    @pytest.mark.asyncio
    async def test_card_bearing_turn_is_still_not_cached(self, db, monkeypatch):
        """The narrowed rule still refuses to freeze a media card in the cache."""
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-media-3")
        cap = _stub_pipeline(
            monkeypatch,
            retrieved=(_doc("Watch the tour."),),
            chunks=("Here is the tour. [YOUTUBE_CARD:abc12345678]",),
        )
        monkeypatch.setattr(
            rs,
            "get_bot_media_urls",
            lambda *a, **k: [{"youtube": [{"video_id": "abc12345678"}], "files": []}],
        )

        await _drive_stream(bot, "show me the tour", "sess-media-3")

        assert cap["cache"].store == {}


# ── Defect R3/R5: cancellation, and blocking calls on the event loop ─────────


class TestStreamCancellationAndOffloading:
    """Two async-only defects in ``rag_pipeline_stream``.

    R3: Starlette cancels the streaming task when the client goes away, which
    arrives as ``CancelledError``, not ``GeneratorExit``. Only the latter was
    caught, so a dropped SSE connection still lost the generated answer, the
    exact data loss ``TestDisconnectMidStream`` above was written to prevent.

    R5: output-side moderation (a sync HTTP call, up to 10s) and the FlashRank
    reranker ran inline on the event loop, stalling every other stream on the
    worker for their duration.
    """

    @pytest.mark.asyncio
    async def test_partial_answer_survives_task_cancellation(self, db, monkeypatch):
        import asyncio

        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-cancel-1")
        _stub_pipeline(monkeypatch, retrieved=(_doc("Acme opens at 9."),))

        async def stalling_stream(prompt, **kwargs):
            yield "We open at 9"
            await asyncio.sleep(3600)  # upstream keeps the turn open
            yield " and close at 5."  # pragma: no cover - never reached

        monkeypatch.setattr(rs, "generate_response_stream", stalling_stream)

        shown = asyncio.Event()

        async def consume():
            async for frame in rs.rag_pipeline_stream(bot, "when do you open", "sess-cancel-1", bot_id=bot.id):
                if "We open at 9" in frame:
                    shown.set()

        task = asyncio.create_task(consume())
        await asyncio.wait_for(shown.wait(), timeout=10)
        # Cancel while the pipeline is parked inside the LLM stream: this is
        # what Starlette does to the response task when the client disconnects.
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        bot_msgs = _messages(db, "sess-cancel-1", role="bot")
        assert len(bot_msgs) == 1, "text already shown to the visitor must survive cancellation"
        assert "We open at 9" in bot_msgs[0].content

    @pytest.mark.asyncio
    async def test_rerank_and_answer_safety_run_off_the_event_loop(self, db, monkeypatch):
        import asyncio

        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-offload-1")
        _stub_pipeline(monkeypatch, retrieved=(_doc("Acme opens at 9."),))

        called: dict[str, bool] = {}

        def _assert_off_loop(name):
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                called[name] = True
                return
            raise AssertionError(f"{name} ran on the event loop")

        def fake_rerank(query, results, top_n=None):
            _assert_off_loop("rerank")
            return results

        def fake_safety(*args, **kwargs):
            _assert_off_loop("check_generated_answer_safety")
            return True, None

        monkeypatch.setattr(rs, "RERANK_ENABLED", True)
        monkeypatch.setattr(rs, "_lang_is_non_english", lambda language: False)
        monkeypatch.setattr(rs, "rerank", fake_rerank)
        monkeypatch.setattr(rs, "check_generated_answer_safety", fake_safety)

        await _drive_stream(bot, "when do you open", "sess-offload-1")

        assert called.get("rerank"), "the reranker must be exercised by this test"
        assert called.get("check_generated_answer_safety"), "answer moderation must be exercised by this test"
