"""Tests for BR-01's downstream-reader fixes.

Companion to ``test_bant_framework_composite.py`` (which pins the writer side
in ``rag_service._background_bant_extraction``). These pin the readers that
previously assumed every bot runs the BANT framework: the Leads dashboard
payload (``lead_service.build_lead_response``), and the widget's public CTA
config (``bot_routes._build_public_cta_options``). Both are exercised with a
MEDDIC-framework bot/session to prove they no longer silently drop non-BANT
frameworks' real dimensions.
"""

from types import SimpleNamespace

from app.api.bot_routes import _build_public_cta_options
from app.services.lead_service import build_lead_response


def _meddic_bot(**overrides):
    base = dict(
        id=5,
        client_id=9,
        bant_config={"framework": "meddic"},
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _meddic_session(**overrides):
    base = dict(
        id="session-meddic-1",
        bot_id=5,
        client_id=9,
        location=None,
        device=None,
        bant_need=None,
        bant_timeline=None,
        bant_authority=None,
        bant_budget=None,
        bant_need_score=0,
        bant_timeline_score=0,
        bant_authority_score=0,
        bant_budget_score=0,
        bant_score=0,
        bant_tier="unqualified",
        dimension_scores={
            "economic_buyer": {"score": 17, "value": "VP of Eng, budget owner"},
            "identify_pain": {"score": 17, "value": "manual triage pain"},
            "decision_process": {"score": 17, "value": "clear stakeholders and timeline"},
        },
        dimensions_assessed=3,
        bant_last_updated=None,
        behavioral_score=0,
        page_url=None,
        referrer=None,
        utm_params=None,
        visit_count=0,
        status="bot",
        created_at=None,
        last_active_at=None,
        lead_viewed_at=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


class TestBuildLeadResponseFrameworkAware:
    def test_meddic_session_yields_nonzero_score_and_real_dimensions(self):
        bot = _meddic_bot()
        session = _meddic_session()

        payload = build_lead_response(session, None, message_count=3, bot=bot)

        # The core regression: a MEDDIC lead must not be stuck at 0/unqualified
        # just because its dimensions aren't named need/budget/authority/timeline.
        assert payload["bant_score"] > 0
        assert payload["tier"] != "unqualified"
        assert payload["dimensions_assessed"] == 3

        # The breakdown must expose MEDDIC's real dimensions, not four
        # permanently-empty BANT-named ones.
        assert "economic_buyer" in payload["bant"]
        assert payload["bant"]["economic_buyer"]["score"] == 17
        assert payload["bant"]["economic_buyer"]["value"] == "VP of Eng, budget owner"

    def test_bant_session_unchanged_shape(self):
        bot = SimpleNamespace(id=1, client_id=1, bant_config={"framework": "bant"})
        session = _meddic_session(
            dimension_scores={
                "need": {"score": 20, "value": "SSO for SOC 2"},
                "budget": {"score": 15, "value": "$5k/mo allocated"},
            },
            dimensions_assessed=2,
        )

        payload = build_lead_response(session, None, message_count=1, bot=bot)

        assert set(payload["bant"].keys()) == {"need", "budget", "authority", "timeline"}
        assert payload["bant"]["need"]["score"] == 20
        assert payload["bant"]["budget"]["score"] == 15
        assert payload["bant"]["authority"]["score"] == 0


class TestBuildPublicCtaOptionsFrameworkAware:
    def test_meddic_cta_enabled_dimension_is_exposed(self):
        bot = _meddic_bot(
            bant_config={
                "framework": "meddic",
                "economic_buyer": {"cta_enabled": True, "cta_prompt": "Who owns the budget?"},
            }
        )

        cta_options = _build_public_cta_options(bot)

        # Previously this iterated only ["need","timeline","authority","budget"]
        # and silently never surfaced MEDDIC's own CTA-enabled dimensions.
        assert "economic_buyer" in cta_options
        assert cta_options["economic_buyer"]["prompt"] == "Who owns the budget?"

    def test_bant_cta_options_unchanged(self):
        bot = SimpleNamespace(
            id=1,
            client_id=1,
            bant_config={"framework": "bant", "need": {"cta_enabled": True}},
        )

        cta_options = _build_public_cta_options(bot)

        assert "need" in cta_options
