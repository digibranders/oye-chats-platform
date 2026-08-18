"""Tests for BR-03: audited operator override/reset of a qualification dimension.

The automated extraction path never downgrades a dimension's score and
budget/authority never decay. Deliberately, so a weak follow-up can't erase
a strong earlier signal. But combined with no manual correction path, a
single false-positive extraction (or an adversarial "we have a $50k/month
budget approved") permanently misclassified a lead with no remedy short of
direct database editing. ``override_qualification_dimension`` gives operators
an audited way to correct or reset (score=0) a dimension without weakening
the never-downgrade guarantee on the automated path.
"""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.api.operator_routes import QualificationOverrideRequest, override_qualification_dimension
from app.db.models import BANTSignal


@contextmanager
def _session_ctx(session):
    yield session


def _fake_db_session(chat_session, bot):
    session = MagicMock()

    def fake_execute(stmt):
        sql = str(stmt)
        result = MagicMock()
        if "chat_sessions" in sql:
            result.scalar_one_or_none.return_value = chat_session
        elif "bots" in sql:
            result.scalar_one_or_none.return_value = bot
        else:
            result.scalar_one_or_none.return_value = None
        return result

    session.execute.side_effect = fake_execute
    return session


def _client_auth(client_id=9):
    return {"type": "client", "client_id": client_id, "operator_id": None}


def _meddic_chat_session():
    return SimpleNamespace(
        id="session-1",
        bot_id=5,
        dimension_scores={"economic_buyer": {"score": 8, "value": "influencer identified"}},
        bant_need_score=0,
        bant_budget_score=0,
        bant_authority_score=0,
        bant_timeline_score=0,
        bant_need=None,
        bant_budget=None,
        bant_authority=None,
        bant_timeline=None,
        bant_score=0,
        bant_tier="unqualified",
        dimensions_assessed=1,
        bant_last_updated=None,
    )


def _meddic_bot(client_id=9):
    return SimpleNamespace(id=5, client_id=client_id, bant_config={"framework": "meddic"})


class TestOverrideQualificationDimension:
    def test_operator_corrects_a_dimension_score(self):
        chat_session = _meddic_chat_session()
        bot = _meddic_bot()
        session = _fake_db_session(chat_session, bot)

        with patch("app.api.operator_routes.get_session", return_value=_session_ctx(session)):
            result = override_qualification_dimension(
                "session-1",
                QualificationOverrideRequest(dimension="economic_buyer", score=17),
                auth=_client_auth(),
            )

        assert result["score_before"] == 8
        assert result["score_after"] == 17
        assert chat_session.dimension_scores["economic_buyer"]["score"] == 17
        # Value is preserved on a non-zero correction, not wiped.
        assert chat_session.dimension_scores["economic_buyer"]["value"] == "influencer identified"
        assert chat_session.bant_score > 0
        assert result["bant_score"] == chat_session.bant_score
        assert result["bant_tier"] == chat_session.bant_tier

        added = [c.args[0] for c in session.add.call_args_list if isinstance(c.args[0], BANTSignal)]
        assert len(added) == 1
        assert added[0].source == "operator_override"
        assert added[0].score_before == 8
        assert added[0].score_after == 17
        session.commit.assert_called_once()

    def test_reset_to_zero_clears_value(self):
        chat_session = _meddic_chat_session()
        bot = _meddic_bot()
        session = _fake_db_session(chat_session, bot)

        with patch("app.api.operator_routes.get_session", return_value=_session_ctx(session)):
            override_qualification_dimension(
                "session-1",
                QualificationOverrideRequest(dimension="economic_buyer", score=0),
                auth=_client_auth(),
            )

        assert chat_session.dimension_scores["economic_buyer"]["score"] == 0
        assert chat_session.dimension_scores["economic_buyer"]["value"] is None

    def test_legacy_bant_columns_updated_for_bant_framework(self):
        chat_session = _meddic_chat_session()
        chat_session.dimension_scores = {"budget": {"score": 10, "value": "Under $1K/mo"}}
        bot = SimpleNamespace(id=5, client_id=9, bant_config={"framework": "bant"})
        session = _fake_db_session(chat_session, bot)

        with patch("app.api.operator_routes.get_session", return_value=_session_ctx(session)):
            override_qualification_dimension(
                "session-1",
                QualificationOverrideRequest(dimension="budget", score=25),
                auth=_client_auth(),
            )

        assert chat_session.bant_budget_score == 25

    def test_unknown_dimension_rejected(self):
        chat_session = _meddic_chat_session()
        bot = _meddic_bot()
        session = _fake_db_session(chat_session, bot)

        with (
            patch("app.api.operator_routes.get_session", return_value=_session_ctx(session)),
            pytest.raises(HTTPException) as exc_info,
        ):
            override_qualification_dimension(
                "session-1",
                QualificationOverrideRequest(dimension="not_a_real_dimension", score=10),
                auth=_client_auth(),
            )
        assert exc_info.value.status_code == 400

    def test_score_above_dimension_max_rejected(self):
        """The handler still enforces the PER-DIMENSION ceiling.

        ``score=60`` is a legal rubric value (the schema allows 0-100) but sits
        above this dimension's configured max, so only the handler can catch
        it, which is the check this test exists for. The absolute 0-100 bound
        is exercised separately below.
        """
        chat_session = _meddic_chat_session()
        bot = _meddic_bot()
        session = _fake_db_session(chat_session, bot)

        with (
            patch("app.api.operator_routes.get_session", return_value=_session_ctx(session)),
            pytest.raises(HTTPException) as exc_info,
        ):
            override_qualification_dimension(
                "session-1",
                QualificationOverrideRequest(dimension="economic_buyer", score=60),
                auth=_client_auth(),
            )
        assert exc_info.value.status_code == 400

    def test_score_outside_the_rubric_range_is_refused_by_the_schema(self):
        """Scores are a 0-100 rubric value, and the composite tier maths
        assumes it. An out-of-range score never reaches the handler."""
        from pydantic import ValidationError

        for bad in (999, -1, 101):
            with pytest.raises(ValidationError):
                QualificationOverrideRequest(dimension="economic_buyer", score=bad)

    def test_cross_client_access_denied(self):
        chat_session = _meddic_chat_session()
        bot = _meddic_bot(client_id=999)  # different client owns this bot
        session = _fake_db_session(chat_session, bot)

        with (
            patch("app.api.operator_routes.get_session", return_value=_session_ctx(session)),
            pytest.raises(HTTPException) as exc_info,
        ):
            override_qualification_dimension(
                "session-1",
                QualificationOverrideRequest(dimension="economic_buyer", score=17),
                auth=_client_auth(client_id=9),
            )
        assert exc_info.value.status_code == 403

    def test_session_not_found(self):
        session = _fake_db_session(None, None)

        with (
            patch("app.api.operator_routes.get_session", return_value=_session_ctx(session)),
            pytest.raises(HTTPException) as exc_info,
        ):
            override_qualification_dimension(
                "missing-session",
                QualificationOverrideRequest(dimension="economic_buyer", score=17),
                auth=_client_auth(),
            )
        assert exc_info.value.status_code == 404
