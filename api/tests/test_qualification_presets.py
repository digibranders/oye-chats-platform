"""Tests for BR-04: uniform low-friction CTA defaults across every preset.

Before this, the BANT preset correctly defaulted its need/timeline pills off
(documented rationale: interrogative qualification pills hurt conversion,
matching Drift/Intercom Fin/HubSpot's own defaults), but MEDDIC, CHAMP, and
GPCTBA+C&I left several dimensions ``cta_enabled: True`` by default with no
equivalent rationale, an authoring inconsistency, not a deliberate
framework-specific choice.
"""

from app.services.qualification_service import PRESET_FRAMEWORKS


class TestPresetCtaDefaults:
    def test_every_dimension_in_every_preset_defaults_cta_disabled(self):
        offenders = []
        for framework, config in PRESET_FRAMEWORKS.items():
            for dim, dim_config in config.items():
                if not isinstance(dim_config, dict) or "options" not in dim_config:
                    continue
                if dim_config.get("cta_enabled") is not False:
                    offenders.append(f"{framework}.{dim}")
        assert offenders == []
