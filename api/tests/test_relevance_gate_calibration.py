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


class TestTheJudgePromptIsBudgeted:
    """A wide bundle must not become a slow prompt.

    The judge has a 2 second timeout whose only failure mode is failing OPEN,
    so the answer goes out with no scope check at all. Under CAG-lite the
    caller hands over the whole knowledge base (up to 20 chunks), and at a full
    preview each that is a ~5,000 token prompt against that timeout.
    """

    def test_the_ranked_top_five_still_sees_whole_chunks(self):
        prompt = relevance_gate._build_gate_prompt("q", [_Chunk("x" * 2000) for _ in range(5)])
        assert prompt.count("x" * relevance_gate.GATE_CHUNK_PREVIEW_CHARS) == 5

    def test_a_wide_bundle_stays_inside_the_budget(self):
        chunks = [_Chunk("x" * 2000) for _ in range(20)]
        prompt = relevance_gate._build_gate_prompt("q", chunks, max_chunks=20)

        assert prompt.count("Chunk ") == 20, "every document must still be judged"
        # Measure the previews, not the whole prompt: the judge's own
        # instructions contain the letter too.
        shown = sum(len(line.split(": ", 1)[1]) for line in prompt.splitlines() if line.startswith("Chunk "))
        assert shown <= relevance_gate.GATE_PROMPT_CHAR_BUDGET

    def test_a_wide_bundle_still_shows_something_of_each_chunk(self):
        chunks = [_Chunk("x" * 2000) for _ in range(20)]
        prompt = relevance_gate._build_gate_prompt("q", chunks, max_chunks=20)

        assert prompt.count("x" * relevance_gate._MIN_CHUNK_PREVIEW_CHARS) == 20

    def test_a_wide_bundle_never_drops_below_the_old_preview(self):
        """Before the budget every chunk got 500 characters. Twenty chunks
        under a 6,000 budget got 300 each, so the budget silently shrank the
        judge's view below what it had before the CAG-lite widening."""
        chunks = [_Chunk("x" * 2000) for _ in range(20)]
        prompt = relevance_gate._build_gate_prompt("q", chunks, max_chunks=20)

        previews = [line.split(": ", 1)[1] for line in prompt.splitlines() if line.startswith("Chunk ")]
        assert len(previews) == 20
        assert all(len(p) >= 500 for p in previews), sorted({len(p) for p in previews})

    def test_the_groundedness_judge_keeps_the_same_floor_and_top_five(self):
        from app.services import groundedness_gate

        wide = _build_groundedness_prompt("q", "a", [_Chunk("x" * 2000) for _ in range(20)], max_chunks=20)
        previews = [line.split(": ", 1)[1] for line in wide.splitlines() if line.startswith("Chunk ")]
        assert len(previews) == 20
        assert all(len(p) >= 500 for p in previews), sorted({len(p) for p in previews})

        top5 = _build_groundedness_prompt("q", "a", [_Chunk("x" * 2000) for _ in range(5)])
        assert top5.count("x" * groundedness_gate.GROUNDEDNESS_CHUNK_PREVIEW_CHARS) == 5

    def test_an_empty_bundle_does_not_divide_by_zero(self):
        assert "Chunk " not in relevance_gate._build_gate_prompt("q", [], max_chunks=0)


class TestTheMigrationMovesEverySavedCopyOfTheOldScale:
    """The code default reaches neither of the two places a number is stored."""

    def test_it_moves_the_super_admin_runtime_knob(self):
        """``_resolve_threshold`` consults ``rag.relevance_threshold`` before
        the env default, for every bot without its own override, i.e. most of
        them. An old-scale row left in place makes the whole recalibration a
        silent no-op."""
        from pathlib import Path

        migration = (
            Path(__file__).resolve().parents[1] / "alembic" / "versions" / "b1000008recalibrate.py"
        ).read_text()
        assert "rag.relevance_threshold" in migration
        assert "pricing_config" in migration

    @staticmethod
    def _migration_module():
        """Loaded by path: ``alembic/versions`` is not an importable package."""
        import importlib.util
        from pathlib import Path

        path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "b1000008recalibrate.py"
        spec = importlib.util.spec_from_file_location("_b1000008recalibrate", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_no_preset_step_re_migrates_what_an_earlier_step_wrote(self):
        """Sequential UPDATEs: if one step's new value is a later step's old
        value, a bot is migrated twice and silently changes label."""
        module = self._migration_module()
        _EPS, _PRESETS = module._EPS, module._PRESETS

        for i, (_old, new) in enumerate(_PRESETS):
            for old_later, _new_later in _PRESETS[i + 1 :]:
                assert abs(new - old_later) > _EPS, f"{new} is re-matched by the {old_later} step"

    def test_the_presets_match_the_console(self):
        """The migration restates STRICTNESS_LEVELS in a second language."""
        from pathlib import Path

        _PRESETS = self._migration_module()._PRESETS

        config = (
            Path(__file__).resolve().parents[2]
            / "app"
            / "src"
            / "features"
            / "agents"
            / "advanced"
            / "behaviour.config.ts"
        ).read_text()
        for _old, new in _PRESETS:
            assert f"value: {new}," in config, f"the console has no preset at {new}"


def test_an_explicitly_small_preview_knob_still_wins_over_the_floor():
    """The floor guards against the BUDGET shrinking previews to stubs. An
    operator who deliberately sets a small preview is not overruled."""
    import importlib
    import os

    os.environ["GATE_CHUNK_PREVIEW_CHARS"] = "10"
    try:
        reloaded = importlib.reload(relevance_gate)
        prompt = reloaded._build_gate_prompt("q", [_Chunk("x" * 50) for _ in range(2)])
        assert "Chunk 1: " + "x" * 10 + "\n" in prompt
    finally:
        del os.environ["GATE_CHUNK_PREVIEW_CHARS"]
        importlib.reload(relevance_gate)
