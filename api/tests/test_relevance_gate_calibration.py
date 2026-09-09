"""The gate refuses only what no chunk bears on.

The judge's own rubric defines 0.5 as "related enough to help". A pass mark of
0.55 sat above that, so a judge following its rubric failed the gate on every
broad company question ("what does cleanstart do" scored at the anchor and was
refused 3 of 3 times on the live bot). The gate exists to refuse "what's the
weather", not to grade retrieval, so it fires only at the "no chunk bears on
it" end of the scale.

The judge also saw 500 characters of each chunk while generation saw 1,000, so
an answer in the back half of a chunk was invisible to the judge and visible
to the model, and the judge's verdict won.
"""

import importlib

from app.services import relevance_gate, runtime_config
from app.services.groundedness_gate import _build_groundedness_prompt


class _Chunk:
    def __init__(self, content: str) -> None:
        self.content = content


def test_default_threshold_sits_below_the_related_anchor(monkeypatch):
    """The CODE default, read with the env var removed: a developer's
    ``api/.env`` and the deploy both set this key, so asserting the imported
    constant would only measure the machine the suite happens to run on."""
    monkeypatch.delenv("RELEVANCE_THRESHOLD", raising=False)
    try:
        assert importlib.reload(relevance_gate).RELEVANCE_THRESHOLD == 0.3
    finally:
        importlib.reload(relevance_gate)
    assert runtime_config.get_relevance_threshold.__defaults__ == (0.3,)


def test_the_deploy_writes_the_same_default():
    """The production env file hardcodes this key, so the code default alone
    would never reach a deployed bot."""
    from pathlib import Path

    deploy = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "deploy-api.yml"
    assert '"RELEVANCE_THRESHOLD=0.3"' in deploy.read_text()


def test_judge_sees_a_whole_default_chunk():
    assert relevance_gate.GATE_CHUNK_PREVIEW_CHARS >= 1000
    prompt = relevance_gate._build_gate_prompt("q", [_Chunk("a" * 600 + "PRICE-TABLE" + "b" * 300)])
    assert "PRICE-TABLE" in prompt


def test_prompt_version_bumped_so_old_verdicts_expire():
    assert relevance_gate._GATE_PROMPT_VERSION >= 3


def test_groundedness_judge_widens_under_cag_lite():
    """Same alphabetical-slice bug the relevance judge had: under CAG-lite the
    chunk list is the whole knowledge base in filename order, so the first
    five are arbitrary and a correct answer read as fabricated."""
    chunks = [_Chunk(f"chunk-{i}") for i in range(12)]
    assert "chunk-11" not in _build_groundedness_prompt("q", "a", chunks)
    assert "chunk-11" in _build_groundedness_prompt("q", "a", chunks, max_chunks=12)
