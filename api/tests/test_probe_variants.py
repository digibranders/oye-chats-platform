"""Probe-question variant rotation: a re-asked qualification dimension must not
show the identical sentence twice, while pill options/scoring stay untouched and
custom per-bot wording is respected."""

import pytest

from app.services.qualification_service import (
    CTA_PROMPT_VARIANTS,
    PRESET_FRAMEWORKS,
    pick_probe_variant,
)


class TestVariantPoolCoverage:
    """Every stock dimension prompt has a matching variant pool, and index 0 is
    the canonical default (the picker relies on this to detect custom wording)."""

    def _dimensions(self):
        for framework, config in PRESET_FRAMEWORKS.items():
            for dim, dim_config in config.items():
                if isinstance(dim_config, dict) and dim_config.get("cta_prompt"):
                    yield framework, dim, dim_config["cta_prompt"]

    def test_every_dimension_has_variants(self):
        missing = [f"{fw}:{dim}" for fw, dim, _ in self._dimensions() if f"{fw}:{dim}" not in CTA_PROMPT_VARIANTS]
        assert missing == [], f"dimensions without a variant pool: {missing}"

    def test_index_zero_matches_default_prompt(self):
        mismatches = [
            f"{fw}:{dim}" for fw, dim, prompt in self._dimensions() if CTA_PROMPT_VARIANTS[f"{fw}:{dim}"][0] != prompt
        ]
        assert mismatches == [], f"variant[0] must equal the dimension's cta_prompt: {mismatches}"

    def test_pools_have_six_to_eight_unique_variants(self):
        for key, variants in CTA_PROMPT_VARIANTS.items():
            assert 6 <= len(variants) <= 8, f"{key} has {len(variants)} variants (want 6-8)"
            assert len(set(variants)) == len(variants), f"{key} has duplicate variants"


class TestPickProbeVariant:
    KEY = "bant:need"

    def test_returns_a_pool_variant(self):
        got = pick_probe_variant("bant", "need", "What best describes your situation?", seed=3)
        assert got in CTA_PROMPT_VARIANTS[self.KEY]

    def test_deterministic_for_same_seed(self):
        a = pick_probe_variant("bant", "need", "What best describes your situation?", seed=42)
        b = pick_probe_variant("bant", "need", "What best describes your situation?", seed=42)
        assert a == b

    def test_never_repeats_the_previous_wording(self):
        variants = CTA_PROMPT_VARIANTS[self.KEY]
        # For every possible "previous bot turn" containing a variant, the picker
        # must choose a different one across all seeds.
        for prev in variants:
            for seed in range(len(variants) * 3):
                got = pick_probe_variant(
                    "bant", "need", "What best describes your situation?", seed=seed, avoid_text=f"...{prev}"
                )
                assert got != prev, f"repeated {prev!r} at seed {seed}"

    def test_falls_back_to_base_when_no_variants(self):
        got = pick_probe_variant("bant", "unknown_dim", "Custom fallback?", seed=1)
        assert got == "Custom fallback?"

    def test_respects_custom_prompt(self):
        # base_prompt differs from the stock default → customer set it, leave it.
        got = pick_probe_variant("bant", "need", "Tell us exactly why you're here.", seed=5)
        assert got == "Tell us exactly why you're here."

    def test_unknown_framework_falls_back_to_base(self):
        got = pick_probe_variant("no_such_fw", "need", "Base prompt?", seed=2)
        assert got == "Base prompt?"

    @pytest.mark.parametrize("seed", [0, 1, 2, 3, 4, 5, 6, 7])
    def test_options_are_never_touched(self, seed):
        # Sanity: the picker only returns a string; it cannot mutate scoring.
        before = [dict(o) for o in PRESET_FRAMEWORKS["bant"]["need"]["options"]]
        pick_probe_variant("bant", "need", "What best describes your situation?", seed=seed)
        assert PRESET_FRAMEWORKS["bant"]["need"]["options"] == before


class TestRotatedProbeWrapper:
    def test_excludes_last_bot_message_variant(self):
        from app.services.rag_service import _rotated_probe

        prev = CTA_PROMPT_VARIANTS["bant:need"][0]
        history = [{"role": "bot", "content": f"Here's some info. {prev}"}]
        got = _rotated_probe({"framework": "bant"}, "need", prev, "sess-1", "i am the manager", history)
        assert got != prev
        assert got in CTA_PROMPT_VARIANTS["bant:need"]
