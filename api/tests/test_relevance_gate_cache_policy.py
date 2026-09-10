"""A wrong verdict must not be pinned, and a re-train must not serve stale ones.

The cache key was (bot, question) with a one-hour TTL and nothing invalidated
it on ingest. A low score refused every visitor who typed the same words for an
hour, which is why the same phrasing kept failing while a typo "fixed" it, and
a freshly uploaded answer stayed refused until the entry expired.

Now: the key carries a fingerprint of the bot's knowledge base, the TTL is five
minutes, and a failing verdict is never written at all.

The judge is also shown the query retrieval actually ran. It was given the raw
question while retrieval used the rewritten one, so a pronoun follow-up was
judged unresolved against chunks fetched for the resolved query.
"""

import inspect
from types import SimpleNamespace

from app.services import relevance_gate
from app.services.relevance_gate import _gate_cache_key


class _Chunk:
    def __init__(self, content: str) -> None:
        self.content = content


def _completion(score: float):
    def completion(**kwargs):
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=f'{{"score": {score}}}'), finish_reason="stop")]
        )

    return completion


def test_key_carries_the_knowledge_version():
    assert _gate_cache_key(8, None, "q", kb_version="14:900") != _gate_cache_key(8, None, "q", kb_version="15:901")
    assert _gate_cache_key(8, None, "q", kb_version="14:900") == _gate_cache_key(8, None, "q", kb_version="14:900")


def test_key_without_a_version_is_still_stable():
    """Callers that cannot compute the fingerprint (no bot, no session) still
    share one key rather than missing the cache on every turn."""
    assert _gate_cache_key(8, None, "q") == _gate_cache_key(8, None, "q")


def test_ttl_is_short():
    assert relevance_gate._GATE_TTL <= 300


def test_failing_verdicts_are_not_cached(monkeypatch):
    writes: list = []
    monkeypatch.setattr(relevance_gate, "RELEVANCE_GATE_ENABLED", True)
    monkeypatch.setattr(relevance_gate, "cache_get", lambda key: None)
    monkeypatch.setattr(relevance_gate, "cache_set", lambda key, value, ttl: writes.append((key, value)))
    monkeypatch.setattr(relevance_gate.litellm, "completion", _completion(0.1))

    ok, _score = relevance_gate.check_relevance("q", [_Chunk("c")], bot_id=1, threshold=0.3)

    assert ok is False
    assert writes == []


def test_passing_verdicts_are_cached_under_the_knowledge_version(monkeypatch):
    writes: list = []
    monkeypatch.setattr(relevance_gate, "RELEVANCE_GATE_ENABLED", True)
    monkeypatch.setattr(relevance_gate, "cache_get", lambda key: None)
    monkeypatch.setattr(relevance_gate, "cache_set", lambda key, value, ttl: writes.append((key, value, ttl)))
    monkeypatch.setattr(relevance_gate.litellm, "completion", _completion(0.9))

    relevance_gate.check_relevance("q", [_Chunk("c")], bot_id=1, threshold=0.3, kb_version="3:77")

    assert len(writes) == 1
    assert writes[0][0] == _gate_cache_key(1, None, "q", kb_version="3:77")
    assert writes[0][2] == relevance_gate._GATE_TTL


def test_a_cached_verdict_is_read_from_the_versioned_key(monkeypatch):
    seen: list = []

    def cache_get(key):
        seen.append(key)
        return {"score": 0.9}

    monkeypatch.setattr(relevance_gate, "RELEVANCE_GATE_ENABLED", True)
    monkeypatch.setattr(relevance_gate, "cache_get", cache_get)

    ok, score = relevance_gate.check_relevance("q", [_Chunk("c")], bot_id=1, threshold=0.3, kb_version="3:77")

    assert (ok, score) == (True, 0.9)
    assert seen == [_gate_cache_key(1, None, "q", kb_version="3:77")]


class TestBothPipelinesJudgeTheRewrittenQuery:
    """Two hand-maintained copies of this call exist. Pin the wiring at the
    source level, the way the CAG-lite window test does, because a unit test of
    ``check_relevance`` cannot see how the pipelines call it."""

    def test_each_gate_call_passes_the_search_query_and_the_knowledge_version(self):
        from app.services import rag_service as rs

        for fn in (rs.rag_pipeline_stream,):
            src = inspect.getsource(fn)
            call = src.index("check_relevance,") if "check_relevance," in src else src.index("check_relevance(")
            args = src[call : call + 900]
            assert "search_query" in args, f"{fn.__name__} must judge the query retrieval actually ran"
            assert "kb_version=_kb_version" in args, f"{fn.__name__} must key the verdict on knowledge state"

    def test_each_pipeline_computes_the_knowledge_version(self):
        from app.services import rag_service as rs

        for fn in (rs.rag_pipeline_stream,):
            src = inspect.getsource(fn)
            assert "knowledge_state_for_bot(" in src, fn.__name__
            assert "_kb_version = " in src, fn.__name__


class TestTheBulkFlushCanActuallyReachTheseKeys:
    """The other half of the cache contract, and it was broken.

    ``cache.gate_prefix_for_bot`` is what ``_flush_answer_caches`` (bot update,
    tone change, delete) and the ingestion pipeline delete by. It returned
    ``oyechats:gate:b{id}:`` while the key has carried a ``v{version}`` segment
    since the prompt was first versioned, so every one of those bulk deletes
    matched nothing. The two existing tests over those call sites patch this
    function with a fabricated prefix, so the mock is what hid it.
    """

    def test_a_real_key_is_reachable_from_the_prefix(self):
        from app.core.cache import gate_prefix_for_bot

        prefix = gate_prefix_for_bot(5)
        for kb in (None, "3:77", "0:0"):
            key = _gate_cache_key(5, None, "how much is pro?", kb_version=kb)
            assert key is not None
            assert key.startswith(prefix), f"{key!r} is not reachable from {prefix!r}"

    def test_the_prefix_does_not_reach_another_bot(self):
        from app.core.cache import gate_prefix_for_bot

        key = _gate_cache_key(6, None, "q", kb_version="1:1")
        assert not key.startswith(gate_prefix_for_bot(5))


class TestAnUnscopedCallIsNotCached:
    """Without a bot or a client there is no tenant to scope to, and every such
    turn would share one platform-wide bucket."""

    def test_the_key_is_none(self):
        assert _gate_cache_key(None, None, "q", kb_version="1:1") is None

    def test_nothing_is_read_or_written(self, monkeypatch):
        touched: list = []
        monkeypatch.setattr(relevance_gate, "RELEVANCE_GATE_ENABLED", True)
        monkeypatch.setattr(relevance_gate, "cache_get", lambda key: touched.append(("get", key)))
        monkeypatch.setattr(relevance_gate, "cache_set", lambda *a: touched.append(("set", a)))
        monkeypatch.setattr(relevance_gate.litellm, "completion", _completion(0.9))

        ok, _score = relevance_gate.check_relevance("q", [_Chunk("c")], threshold=0.3)

        assert ok is True
        assert touched == []
