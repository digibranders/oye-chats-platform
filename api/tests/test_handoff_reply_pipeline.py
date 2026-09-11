"""The handoff turn end to end: fixed words, no model call, the right flags.

Drives the real ``rag_pipeline_stream`` against the throwaway Postgres, with the
same outside-world stubs as ``test_rag_pipeline_defects``. The pure wording is
pinned in ``test_handoff_reply.py``; these pin when the pipeline uses it, and
the ``qualification_pending`` flag the widget sizes its quote poll from.
"""

from __future__ import annotations

import pytest

from app.services import rag_service as rs
from app.services.handoff_reply import handoff_reply
from tests.test_rag_pipeline_defects import (
    _answer_text,
    _doc,
    _drive_stream,
    _final_meta,
    _make_bot,
    _make_client,
    _make_session,
    _messages,
    _stub_pipeline,
)

_AVAILABLE_FIRST = handoff_reply(team_available=True, repeat=False)


def _handoff_bot(db, monkeypatch, session_id, *, team_online=True, support=True):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, session_id)
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),), support=support)
    monkeypatch.setattr(rs, "detect_handoff_intent", lambda _q, **_kw: True)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: team_online)
    return bot, cap


class TestTheHandoffTurnUsesTheFormWording:
    @pytest.mark.asyncio
    async def test_connect_me_describes_the_form_without_calling_the_model(self, db, monkeypatch):
        bot, cap = _handoff_bot(db, monkeypatch, "handoff-1")

        frames = await _drive_stream(bot, "connect me", "handoff-1")

        answer = _answer_text(frames)
        meta = _final_meta(frames)
        assert cap["prompts"] == [], "the handoff reply is not a model call"
        assert answer.endswith(_AVAILABLE_FIRST), answer
        assert "message form" not in answer.lower()
        assert meta["suggest_handoff"] is True
        assert meta["qualification_pending"] is False
        persisted = _messages(db, "handoff-1", role="bot")
        assert [m.id for m in persisted] == [meta["message_id"]]
        assert persisted[0].content == answer
        assert persisted[0].is_unanswered is not True

    @pytest.mark.asyncio
    async def test_asking_again_points_at_the_form_already_open(self, db, monkeypatch):
        bot, cap = _handoff_bot(db, monkeypatch, "handoff-2")

        await _drive_stream(bot, "connect me", "handoff-2")
        frames = await _drive_stream(bot, "connect me", "handoff-2")

        assert _answer_text(frames).endswith(handoff_reply(team_available=True, repeat=True))
        assert _final_meta(frames)["suggest_handoff"] is True
        assert cap["prompts"] == []

    @pytest.mark.asyncio
    async def test_nobody_available_gets_the_offline_wording(self, db, monkeypatch):
        bot, _cap = _handoff_bot(db, monkeypatch, "handoff-3", team_online=False)

        frames = await _drive_stream(bot, "connect me", "handoff-3")

        assert _answer_text(frames).endswith(handoff_reply(team_available=False, repeat=False))
        assert _final_meta(frames)["suggest_handoff"] is True


class TestTheModelStillAnswersWhereTheFixedWordsDoNotFit:
    @pytest.mark.asyncio
    async def test_a_bot_without_live_chat_is_left_to_the_model(self, db, monkeypatch):
        bot, cap = _handoff_bot(db, monkeypatch, "handoff-4", support=False)

        frames = await _drive_stream(bot, "connect me", "handoff-4")

        assert len(cap["prompts"]) == 1
        assert _AVAILABLE_FIRST not in _answer_text(frames)

    @pytest.mark.asyncio
    async def test_a_non_english_conversation_keeps_the_model(self, db, monkeypatch):
        bot, cap = _handoff_bot(db, monkeypatch, "handoff-5")
        monkeypatch.setattr(rs, "_english_judges_bypassed", lambda *_a, **_k: True)

        frames = await _drive_stream(bot, "mujhe team se baat karni hai", "handoff-5")

        assert len(cap["prompts"]) == 1
        assert _AVAILABLE_FIRST not in _answer_text(frames)


class TestQualificationPendingTellsTheWidgetWhetherToWait:
    """The widget polls for a quote card for up to 4.5s after a reply, because
    lead scoring runs after the stream closes. A turn that queued no scoring has
    nothing to wait for, and on a live bot that wait sat between "connect me" and
    the form."""

    @pytest.mark.asyncio
    async def test_true_when_this_turn_queued_extraction(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client, bant_enabled=True)
        _make_session(db, bot, client, "qual-1")
        _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),), bant_enabled=True)
        enqueued: list = []
        monkeypatch.setattr(rs, "_enqueue_qualification", lambda *a, **k: enqueued.append(a))

        frames = await _drive_stream(bot, "we have a budget of around 50k for this quarter", "qual-1")

        assert len(enqueued) == 1
        assert _final_meta(frames)["qualification_pending"] is True

    @pytest.mark.asyncio
    async def test_false_when_lead_scoring_is_off(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "qual-2")
        _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),), bant_enabled=False)

        frames = await _drive_stream(bot, "what do you sell for small teams", "qual-2")

        assert _final_meta(frames)["qualification_pending"] is False
