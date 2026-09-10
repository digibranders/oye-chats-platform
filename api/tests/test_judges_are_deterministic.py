"""Every classification, judge and extractor call must be deterministic.

None of these calls set ``temperature``. Gemini 2.5 Flash defaults to 1.0, so
the relevance judge scored the same question against the same chunks
differently on different runs, and the first verdict was then cached for an
hour. A judge is a classifier: it wants temperature 0, always.
"""

from types import SimpleNamespace

from app.ingestion import enrichment
from app.services import groundedness_gate, relevance_gate


class _Chunk:
    def __init__(self, content: str) -> None:
        self.content = content
        self.document_name = "doc.md"


def _fake_completion(captured: dict):
    def completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"score": 0.9}'), finish_reason="stop")]
        )

    return completion


def test_relevance_judge_is_deterministic(monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(relevance_gate, "RELEVANCE_GATE_ENABLED", True)
    monkeypatch.setattr(relevance_gate, "cache_get", lambda key: None)
    monkeypatch.setattr(relevance_gate, "cache_set", lambda *a, **k: None)
    monkeypatch.setattr(relevance_gate.litellm, "completion", _fake_completion(captured))

    relevance_gate.check_relevance("q", [_Chunk("c")], bot_id=1)

    assert captured["temperature"] == 0


def test_groundedness_judge_is_deterministic(monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(groundedness_gate, "GROUNDEDNESS_CHECK_ENABLED", True)
    monkeypatch.setattr(groundedness_gate.litellm, "completion", _fake_completion(captured))

    groundedness_gate.check_groundedness("q", "a", [_Chunk("c")], bot_id=1)

    assert captured["temperature"] == 0


def test_enrichment_is_deterministic_bounded_and_reasoning_off(monkeypatch):
    """Enrichment was a silent no-op: gemini spent its 80-token cap thinking
    and returned ''. Same fix as the judges plus a timeout and temperature."""
    captured: dict = {}

    def completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="About X."))])

    monkeypatch.setattr(enrichment, "ENRICHMENT_MODEL", "gemini/gemini-2.5-flash")
    monkeypatch.setattr(enrichment.litellm, "completion", completion)

    out = enrichment.enrich_chunk("chunk text", "document summary")

    assert out.startswith("[Context: About X.]")
    assert captured["temperature"] == 0
    assert captured["reasoning_effort"] == "disable"
    assert captured["timeout"] > 0
