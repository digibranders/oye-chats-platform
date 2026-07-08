"""Tests for BR-01: framework-aware composite score/tier.

Before this fix, ``_background_bant_extraction`` recomputed the persisted
``bant_score``/``bant_tier`` (the fields every downstream reader — the leads
dashboard, operator console sort order, the analytics MQL/SAL/SQL funnel, and
the tier-transition email/webhook trigger — actually consumes) by summing
exactly four hardcoded columns named after BANT's own dimensions
(need/timeline/authority/budget). For any bot configured on a non-BANT
framework (MEDDIC/CHAMP/GPCTBA+C&I), those columns are never written — only
the framework-agnostic ``dimension_scores`` JSONB is — so the composite stayed
permanently 0 and the tier permanently "unqualified", even though extraction
was correctly scoring the bot's actual MEDDIC/CHAMP/GPCTBA+C&I dimensions.

These tests pin: a MEDDIC-framework session with real extracted signals ends
up with a non-zero, correctly-weighted composite score and matching tier —
computed via ``qualification_service.calculate_composite_score`` instead of
the old hardcoded four-column sum.
"""

from contextlib import contextmanager
from unittest.mock import MagicMock, patch

from app.db.models import BANTSignal, Bot, ChatSession
from app.services.qualification_service import calculate_composite_score, get_framework_config, get_tier
from app.services.rag_service import _background_bant_extraction


@contextmanager
def _session_ctx(session):
    yield session


class _FakeBot:
    id = 5
    client_id = 9
    bant_config = {"framework": "meddic"}
    email_on_qualified = False


class _FakeChatSession:
    def __init__(self):
        self.id = 1
        self.bant_tier = "unqualified"
        self.dimension_scores = {}
        self.bant_need_score = 0
        self.bant_budget_score = 0
        self.bant_authority_score = 0
        self.bant_timeline_score = 0
        self.bant_need = None
        self.bant_budget = None
        self.bant_authority = None
        self.bant_timeline = None
        self.qualification_framework = "bant"
        self.dimensions_assessed = 0
        self.bant_last_updated = None
        self.bant_score = 0


def _make_session(bot, chat_session):
    session = MagicMock()

    def fake_query(model):
        query = MagicMock()
        if model is Bot:
            query.filter.return_value.first.return_value = bot
        elif model is ChatSession:
            query.filter.return_value.first.return_value = chat_session
        else:
            query.filter.return_value.first.return_value = None
        return query

    session.query.side_effect = fake_query
    return session


class TestBackgroundBantExtractionFrameworkAware:
    def test_meddic_signals_produce_nonzero_framework_weighted_composite(self):
        bot = _FakeBot()
        chat_session = _FakeChatSession()
        session = _make_session(bot, chat_session)

        signals = [
            {
                "dimension": "economic_buyer",
                "score": 17,
                "confidence": "high",
                "signal_text": "I'm the VP of Eng and I own this budget.",
                "extracted_value": "VP of Eng, budget owner",
            },
            {
                "dimension": "identify_pain",
                "score": 12,
                "confidence": "medium",
                "signal_text": "We're losing hours a week to manual triage.",
                "extracted_value": "manual triage pain",
            },
        ]

        config = get_framework_config(bot)
        expected_dimension_scores = {
            "economic_buyer": {"score": 17, "value": "VP of Eng, budget owner"},
            "identify_pain": {"score": 12, "value": "manual triage pain"},
        }
        expected_score = calculate_composite_score(expected_dimension_scores, config)
        expected_tier = get_tier(expected_score, thresholds=config.get("thresholds"))

        with (
            patch("app.services.rag_service.get_session", return_value=_session_ctx(session)),
            patch("app.services.rag_service.extract_qualification_signals", return_value=signals),
        ):
            _background_bant_extraction(
                session_id=1,
                cid=9,
                bid=5,
                history_context="",
                question="I'm the VP of Eng, we're losing hours a week to manual triage.",
                answer="Got it — tell me more.",
                current_bant={},
                bot_id=5,
                bant_config=None,
                message_id=None,
            )

        # The core regression: composite must be nonzero and match the
        # framework-weighted calculation, not the old always-0 four-column sum.
        assert chat_session.bant_score > 0
        assert chat_session.bant_score == expected_score
        assert chat_session.bant_tier == expected_tier

        # MEDDIC dimensions never map to the legacy BANT columns — confirms
        # those columns are correctly bypassed, not silently reused.
        assert chat_session.bant_need_score == 0
        assert chat_session.bant_budget_score == 0
        assert chat_session.bant_authority_score == 0
        assert chat_session.bant_timeline_score == 0

    def test_bant_framework_composite_still_correct(self):
        """Same wiring, default BANT framework — composite must still work
        for the framework this all originally shipped for."""
        bot = _FakeBot()
        bot.bant_config = {"framework": "bant"}
        chat_session = _FakeChatSession()
        session = _make_session(bot, chat_session)

        signals = [
            {
                "dimension": "need",
                "score": 20,
                "confidence": "high",
                "signal_text": "We need SSO for SOC 2 compliance.",
                "extracted_value": "SSO for SOC 2",
            },
            {
                "dimension": "budget",
                "score": 15,
                "confidence": "high",
                "signal_text": "We have about 5k a month allocated.",
                "extracted_value": "$5k/mo allocated",
            },
        ]

        config = get_framework_config(bot)
        expected_dimension_scores = {
            "need": {"score": 20, "value": "SSO for SOC 2"},
            "budget": {"score": 15, "value": "$5k/mo allocated"},
        }
        expected_score = calculate_composite_score(expected_dimension_scores, config)
        expected_tier = get_tier(expected_score, thresholds=config.get("thresholds"))

        with (
            patch("app.services.rag_service.get_session", return_value=_session_ctx(session)),
            patch("app.services.rag_service.extract_qualification_signals", return_value=signals),
        ):
            _background_bant_extraction(
                session_id=1,
                cid=9,
                bid=5,
                history_context="",
                question="We need SSO for SOC 2, and have about 5k a month allocated.",
                answer="Got it — tell me more.",
                current_bant={},
                bot_id=5,
                bant_config=None,
                message_id=None,
            )

        assert chat_session.bant_score == expected_score
        assert chat_session.bant_tier == expected_tier
        # BANT dimensions DO map to the legacy columns — back-compat preserved.
        assert chat_session.bant_need_score == 20
        assert chat_session.bant_budget_score == 15


class TestBackgroundBantExtractionCtaSignal:
    """BR-02: a deterministic ``cta_signal`` bypasses LLM extraction entirely
    and is tagged with ``source="cta_click"`` in the audit log."""

    def test_cta_signal_skips_llm_extraction_and_tags_source(self):
        bot = _FakeBot()
        bot.bant_config = {"framework": "bant"}
        chat_session = _FakeChatSession()
        session = _make_session(bot, chat_session)

        cta_signal = {
            "dimension": "budget",
            "score": 25,
            "confidence": "high",
            "signal_text": "$20K+/mo",
            "extracted_value": "$20K+/mo",
        }

        with (
            patch("app.services.rag_service.get_session", return_value=_session_ctx(session)),
            patch("app.services.rag_service.extract_qualification_signals") as mock_extract,
        ):
            _background_bant_extraction(
                session_id=1,
                cid=9,
                bid=5,
                history_context="",
                question="$20K+/mo",
                answer="Great, thanks for sharing.",
                current_bant={},
                bot_id=5,
                bant_config=None,
                message_id=None,
                cta_signal=cta_signal,
            )

        # No LLM round-trip for a CTA-origin answer.
        mock_extract.assert_not_called()
        assert chat_session.bant_budget_score == 25

        added_signals = [call.args[0] for call in session.add.call_args_list if isinstance(call.args[0], BANTSignal)]
        assert len(added_signals) == 1
        assert added_signals[0].source == "cta_click"
