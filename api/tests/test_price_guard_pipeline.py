"""The typo'd pricing question gets the pricing escalation, not the figures.

Production, 2026-09-10: "what is th picin for SOC as a Service" is two edits from
"pricing", so the pricing gate never fired, and a bot whose pricing belongs to
the team streamed rupee figures from its knowledge base. The stream guard trips
on the first figure, and the turn must end exactly as the gate's own escalation
ends for the same bot.
"""

import asyncio
import hashlib
import re

import pytest

from app.db.models import ChatSession
from app.services import rag_service as rs
from app.services.pricing_gate import pricing_pivot, pricing_subject
from tests.test_rag_pipeline_defects import (
    _anonymous_visitor,
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

CHUNKS = ("SOC as a Service starts at ", "₹", "2,66,250 per month for small teams.")
ORDINARY_CHUNKS = ("We run 24/7 monitoring across ", "3", " regions and have since 2019.")
#: A figure whose sentence names no price: it trips only on the turn's own signal.
BARE_CHUNKS = ("SOC as a Service comes to ", "₹2,66,250", " a month for small teams.")
FINES = "what are GDPR fines?"
FINES_CHUNKS = ("GDPR fines can reach ", "€20", " million or 4% of annual turnover.")
TYPO = "what is th picin for SOC"
KB = (_doc("SOC as a Service pricing: ₹2,66,250 per month."),)


def _expected(question, *, live_chat=True, repeat=False):
    return pricing_pivot(
        company_name="Acme",
        pricing_url=None,
        support_enabled=True,
        live_chat_enabled=live_chat,
        repeat=repeat,
        subject=pricing_subject(question, "Acme", KB),
    ).text


def _cards(db, session_id):
    db.expire_all()
    return db.query(ChatSession).filter(ChatSession.id == session_id).one().inline_cards_shown or {}


@pytest.fixture()
def metrics(monkeypatch):
    seen: list[tuple[str, dict]] = []
    real = rs._safety_net_metric

    def spy(name, **tags):
        seen.append((name, tags))
        real(name, **tags)

    monkeypatch.setattr(rs, "_safety_net_metric", spy)
    return seen


def _named(metrics, name):
    return [tags for seen, tags in metrics if seen == name]


def _guarded(db, monkeypatch, session_id, *, chunks=CHUNKS, cards=None, **bot_kwargs):
    client = _make_client(db)
    bot = _make_bot(db, client, **bot_kwargs)
    _make_session(db, bot, client, session_id, inline_cards_shown=cards)
    captured = _stub_pipeline(monkeypatch, retrieved=KB, support=True, chunks=chunks)
    _anonymous_visitor(monkeypatch)
    return bot, captured


@pytest.mark.asyncio
async def test_figures_are_replaced_by_the_escalation(db, monkeypatch, metrics):
    bot, _ = _guarded(db, monkeypatch, "guard-1", live_chat_enabled=True)

    frames = await _drive_stream(bot, TYPO, "guard-1")

    expected = _expected(TYPO)
    answer = _answer_text(frames)
    meta = _final_meta(frames)
    assert "best confirmed by the team" in expected
    assert "2,66,250" not in answer
    assert answer == f"SOC as a Service starts at \n\n{expected}"
    assert meta["suggest_handoff"] is True
    assert meta["answer_override"] == expected
    assert meta["qualification_pending"] is False
    messages = _messages(db, "guard-1", role="bot")
    assert [m.content for m in messages] == [expected]
    assert messages[0].is_unanswered is True
    assert len(_named(metrics, "price_guard_tripped")) == 1
    # Counted with the gate's own escalations too.
    assert [tags["reason"] for tags in _named(metrics, "pricing_gate_escalation")] == ["price_guard"]


@pytest.mark.parametrize("live_chat", [True, False])
@pytest.mark.asyncio
async def test_a_tripped_turn_ends_exactly_like_the_gate_escalation(db, monkeypatch, live_chat):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=live_chat)
    gate_sid, guard_sid = f"mirror-gate-{live_chat}", f"mirror-guard-{live_chat}"
    _make_session(db, bot, client, gate_sid)
    _make_session(db, bot, client, guard_sid)
    _stub_pipeline(monkeypatch, retrieved=KB, support=True, chunks=CHUNKS)
    _anonymous_visitor(monkeypatch)
    spelled = "what is the pricing for SOC"

    gate_meta = _final_meta(await _drive_stream(bot, spelled, gate_sid))
    guard_meta = _final_meta(await _drive_stream(bot, TYPO, guard_sid))

    gate_msg = _messages(db, gate_sid, role="bot")[-1]
    guard_msg = _messages(db, guard_sid, role="bot")[-1]
    assert gate_msg.content == _expected(spelled, live_chat=live_chat)
    assert guard_msg.content == _expected(TYPO, live_chat=live_chat)
    assert guard_msg.is_unanswered == gate_msg.is_unanswered
    for flag in ("suggest_handoff", "show_leave_message", "qualification_pending"):
        assert bool(guard_meta.get(flag)) == bool(gate_meta.get(flag)), flag
    for card in ("cta", "show_booking", "team_connect_popup", "media_card"):
        assert guard_meta.get(card) == gate_meta.get(card) is None, card
    assert _cards(db, guard_sid) == _cards(db, gate_sid)


@pytest.mark.asyncio
async def test_a_second_tripped_turn_uses_the_repeat_wording_and_opens_no_second_form(db, monkeypatch):
    bot, _ = _guarded(db, monkeypatch, "guard-repeat", live_chat_enabled=True)
    again = "and whats th picin for SOC again"

    await _drive_stream(bot, TYPO, "guard-repeat")
    frames = await _drive_stream(bot, again, "guard-repeat")

    expected = _expected(again, repeat=True)
    assert "still sits with the team" in expected
    assert _messages(db, "guard-repeat", role="bot")[-1].content == expected
    # "I'll connect you" in the repeat wording must not re-open the handoff form
    # through the handoff safety net.
    assert not _final_meta(frames).get("suggest_handoff")


@pytest.mark.asyncio
async def test_a_tripped_turn_is_not_cached(db, monkeypatch):
    """The repeat has no handoff and no card, so nothing else keeps it out of the cache."""
    bot, captured = _guarded(db, monkeypatch, "guard-cache", cards={"pricing_escalated": True})

    frames = await _drive_stream(bot, TYPO, "guard-cache")

    assert "2,66,250" not in _answer_text(frames)
    assert captured["cache"].store == {}


@pytest.mark.asyncio
async def test_an_ordinary_answer_with_numbers_streams_unchanged_and_is_cached(db, monkeypatch, metrics):
    bot, captured = _guarded(db, monkeypatch, "guard-ordinary", chunks=ORDINARY_CHUNKS)

    frames = await _drive_stream(bot, "where do you operate", "guard-ordinary")

    assert _answer_text(frames) == "".join(ORDINARY_CHUNKS)
    assert "answer_override" not in _final_meta(frames)
    assert _named(metrics, "price_guard_tripped") == []
    assert len(captured["cache"].store) == 1


@pytest.mark.asyncio
async def test_a_cached_figure_is_not_served_on_a_guarded_bot(db, monkeypatch):
    """An answer cached before the guard existed, or before the owner turned
    knowledge-base pricing off, would otherwise be replayed ahead of it."""
    bot, captured = _guarded(db, monkeypatch, "guard-cached-figure")
    question_hash = hashlib.sha256(rs._normalize_question_for_cache(TYPO).encode()).hexdigest()[:32]
    key = rs.qa_response_key(bot.id, question_hash, rs._cache_lang_segment(None))
    captured["cache"].store[key] = {"answer": "SOC as a Service is ₹2,66,250 per month.", "sources": []}

    frames = await _drive_stream(bot, TYPO, "guard-cached-figure")

    assert "2,66,250" not in _answer_text(frames)
    assert _messages(db, "guard-cached-figure", role="bot")[-1].content == _expected(TYPO)
    assert key not in captured["cache"].store


@pytest.mark.asyncio
async def test_a_tripped_turn_resets_the_unhelped_count(db, monkeypatch):
    """A turn the relevance gate relaxed leaves the count alone before generation;
    once the guard hands the visitor to the team, the turn was helped."""
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "guard-unhelped", inline_cards_shown={"unhelped_streak": 1})
    _stub_pipeline(monkeypatch, retrieved=KB, support=True, chunks=CHUNKS, relevant=False)
    _anonymous_visitor(monkeypatch)
    monkeypatch.setattr(rs, "_question_is_clearly_on_scope", lambda *_a, **_k: True)

    frames = await _drive_stream(bot, TYPO, "guard-unhelped")

    assert "2,66,250" not in _answer_text(frames)
    assert "unhelped_streak" not in _cards(db, "guard-unhelped")


@pytest.mark.asyncio
async def test_a_bot_with_live_chat_off_gets_the_message_card(db, monkeypatch):
    bot, _ = _guarded(db, monkeypatch, "guard-card", live_chat_enabled=False)

    frames = await _drive_stream(bot, TYPO, "guard-card")

    meta = _final_meta(frames)
    expected = _expected(TYPO, live_chat=False)
    assert meta["show_leave_message"] is True
    assert not meta.get("suggest_handoff")
    assert rs.LEAVE_MESSAGE_CARD_SENTINEL not in _answer_text(frames)
    assert _messages(db, "guard-card", role="bot")[-1].content == expected
    cards = _cards(db, "guard-card")
    assert cards.get("leave_message") is True
    assert cards.get("pricing_escalated") is True


def _qualified_popup_turn(monkeypatch):
    """Make this turn the buffered qualified-lead popup turn. Returns the
    qualification jobs the turn enqueues."""
    monkeypatch.setattr(rs.plan_entitlements_service, "is_bant_enabled_for_bot", lambda *_a, **_k: True)
    monkeypatch.setattr(rs, "_count_marked_bant_dimensions", lambda *_a, **_k: 2)
    monkeypatch.setattr(
        rs,
        "_resolve_meeting_booking",
        lambda *_a, **_k: {
            "show_booking": True,
            "calendly_url": "https://calendly.com/acme/intro",
            "meeting_provider": "calendly",
        },
    )
    enqueued: list = []
    monkeypatch.setattr(rs, "_enqueue_qualification", lambda *a, **_k: enqueued.append(a))
    return enqueued


@pytest.mark.asyncio
async def test_the_popup_turn_buffers_an_ordinary_answer(db, monkeypatch):
    """Control for the test below: this setup really is the buffered popup turn."""
    bot, _ = _guarded(db, monkeypatch, "guard-popup-control", chunks=ORDINARY_CHUNKS)
    _qualified_popup_turn(monkeypatch)

    frames = await _drive_stream(bot, "where do you operate", "guard-popup-control")

    assert _final_meta(frames).get("team_connect_popup")
    assert _answer_text(frames) == "".join(ORDINARY_CHUNKS)


@pytest.mark.asyncio
async def test_a_buffered_popup_turn_emits_the_escalation_once(db, monkeypatch):
    bot, _ = _guarded(db, monkeypatch, "guard-popup")
    enqueued = _qualified_popup_turn(monkeypatch)

    frames = await _drive_stream(bot, TYPO, "guard-popup")

    expected = _expected(TYPO)
    meta = _final_meta(frames)
    assert _answer_text(frames) == expected
    assert "team_connect_popup" not in meta
    assert "show_booking" not in meta
    assert meta["suggest_handoff"] is True
    assert enqueued == []


@pytest.mark.asyncio
async def test_the_non_streaming_reply_is_the_escalation(db, monkeypatch):
    bot, _ = _guarded(db, monkeypatch, "guard-collect")

    payload = await rs.collect_rag_pipeline(bot, TYPO, session_id="guard-collect", bot_id=bot.id)

    assert payload["answer"] == _expected(TYPO)
    # The escalation is not drawn from the knowledge base; the gate's pivot returns no sources either.
    assert payload["sources"] == []


@pytest.mark.asyncio
async def test_the_non_streaming_reply_of_an_untripped_turn_keeps_its_sources(db, monkeypatch):
    """Control for the test above: this setup does return knowledge-base sources."""
    bot, _ = _guarded(db, monkeypatch, "guard-collect-sources", chunks=FINES_CHUNKS)

    payload = await rs.collect_rag_pipeline(bot, FINES, session_id="guard-collect-sources", bot_id=bot.id)

    assert payload["answer"] == "".join(FINES_CHUNKS)
    assert payload["sources"] == ["kb.txt"]


@pytest.mark.parametrize(
    ("bot_kwargs", "support"),
    [
        ({"pricing_from_knowledge_base": True}, True),
        ({"pricing_url": "https://acme.com/pricing"}, True),
        ({}, False),
    ],
    ids=["owner_opted_in", "bot_has_a_pricing_page", "plan_has_no_human"],
)
@pytest.mark.asyncio
async def test_figures_stream_where_the_guard_does_not_apply(db, monkeypatch, bot_kwargs, support):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, **bot_kwargs)
    _make_session(db, bot, client, "guard-off")
    _stub_pipeline(monkeypatch, retrieved=KB, support=support, chunks=CHUNKS)

    frames = await _drive_stream(bot, TYPO, "guard-off")

    assert "2,66,250" in _answer_text(frames)


@pytest.mark.asyncio
async def test_a_disconnect_while_a_figure_is_held_keeps_it_out_of_the_transcript(db, monkeypatch):
    """ "50 lakh" at the end of a chunk is held until the next chunk decides it. A
    visitor who leaves in between saw only the text before it, and the partial
    answer saved on disconnect must hold no more than that."""
    bot, _ = _guarded(db, monkeypatch, "guard-cancel")

    async def stalling_stream(prompt, **kwargs):
        yield "Budget about 50 lakh"
        await asyncio.sleep(3600)  # the visitor leaves while the model is still streaming
        yield " for this."  # pragma: no cover - never reached

    monkeypatch.setattr(rs, "generate_response_stream", stalling_stream)
    frames: list[str] = []
    shown = asyncio.Event()

    async def consume():
        async for frame in rs.rag_pipeline_stream(bot, TYPO, "guard-cancel", bot_id=bot.id):
            frames.append(frame)
            if "Budget about" in frame:
                shown.set()

    task = asyncio.create_task(consume())
    await asyncio.wait_for(shown.wait(), timeout=10)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert "lakh" not in _answer_text(frames)
    assert [m.content for m in _messages(db, "guard-cancel", role="bot")] == ["Budget about"]


@pytest.mark.asyncio
async def test_a_typod_pricing_question_trips_on_a_figure_whose_sentence_names_no_price(db, monkeypatch):
    bot, _ = _guarded(db, monkeypatch, "guard-bare", chunks=BARE_CHUNKS)

    frames = await _drive_stream(bot, TYPO, "guard-bare")

    assert "2,66,250" not in _answer_text(frames)
    assert _final_meta(frames)["answer_override"] == _expected(TYPO)
    assert _messages(db, "guard-bare", role="bot")[-1].content == _expected(TYPO)


@pytest.mark.asyncio
async def test_an_answer_about_fines_streams_unchanged_on_a_guarded_bot(db, monkeypatch, metrics):
    """Review, 2026-09-11: a security bot's answer about GDPR fines was replaced by
    "Pricing for X is best confirmed by the team" and saved as unanswered."""
    bot, _ = _guarded(db, monkeypatch, "guard-fines", chunks=FINES_CHUNKS)

    frames = await _drive_stream(bot, FINES, "guard-fines")

    answer = "".join(FINES_CHUNKS)
    meta = _final_meta(frames)
    assert _answer_text(frames) == answer
    assert "answer_override" not in meta
    assert not meta.get("suggest_handoff")
    messages = _messages(db, "guard-fines", role="bot")
    assert [m.content for m in messages] == [answer]
    assert messages[0].is_unanswered is False
    assert _named(metrics, "price_guard_tripped") == []
    assert "pricing_escalated" not in _cards(db, "guard-fines")


@pytest.mark.parametrize("escalated", [True, False])
@pytest.mark.asyncio
async def test_after_an_escalation_a_figure_trips_without_a_price_word(db, monkeypatch, escalated):
    """A follow-up on a session already escalated on pricing is a pricing turn,
    whatever its words. The same turn on a fresh session is not."""
    session_id = f"guard-after-escalation-{escalated}"
    chunks = ("For 50 people it comes to ", "₹4,10,000", ".")
    bot, _ = _guarded(
        db, monkeypatch, session_id, chunks=chunks, cards={"pricing_escalated": True} if escalated else None
    )
    question = "and for 50 people?"

    frames = await _drive_stream(bot, question, session_id)

    last = _messages(db, session_id, role="bot")[-1].content
    if escalated:
        assert "4,10,000" not in _answer_text(frames)
        assert last == _expected(question, repeat=True)
    else:
        assert _answer_text(frames) == "".join(chunks)
        assert last == "".join(chunks)


@pytest.mark.asyncio
async def test_a_trip_after_a_name_opener_follows_it_without_a_blank_line(db, monkeypatch):
    """The model streamed nothing before the figure, so the escalation follows the
    by-name opener with no separator of its own (the opener already ends its
    paragraph), and the widget, the transcript and the override agree."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "guard-opener")
    _stub_pipeline(monkeypatch, retrieved=KB, support=True, chunks=("₹2,66,250 per month for SOC.",))

    frames = await _drive_stream(bot, TYPO, "guard-opener")

    expected = _expected(TYPO)
    answer = _answer_text(frames)
    opener = next(f for f in frames if not f.startswith(("METADATA:", "\nFINAL_METADATA:")))
    assert opener.strip() == "Welcome back, Tester!"
    assert answer == opener + expected
    assert _final_meta(frames)["answer_override"] == answer
    assert _messages(db, "guard-opener", role="bot")[-1].content == answer


@pytest.mark.parametrize(
    ("question", "streamed", "shown"),
    [
        (TYPO, "Budget about 50 lakh", "Budget about"),
        (FINES, "GDPR fines can reach €20 million", "GDPR fines can reach"),
    ],
    ids=["held_figure", "held_sentence"],
)
@pytest.mark.asyncio
async def test_a_stream_error_while_text_is_held_keeps_it_out_of_the_transcript(
    db, monkeypatch, question, streamed, shown
):
    """The saved partial answer holds no more than the visitor saw, as on a disconnect."""
    session_id = f"guard-error-{shown[:6]}"
    bot, _ = _guarded(db, monkeypatch, session_id)

    async def failing_stream(prompt, **kwargs):
        yield streamed
        raise RuntimeError("provider connection dropped")

    monkeypatch.setattr(rs, "generate_response_stream", failing_stream)

    frames = await _drive_stream(bot, question, session_id)

    answer = _answer_text(frames)
    assert answer.startswith(shown)
    assert streamed not in answer
    assert _final_meta(frames)["generation_interrupted"] is True
    assert [m.content.strip() for m in _messages(db, session_id, role="bot")] == [shown]


@pytest.mark.parametrize("escalated", [False, True])
@pytest.mark.asyncio
async def test_a_cached_answer_about_fines_is_served_unless_the_session_escalated(db, monkeypatch, escalated):
    session_id = f"guard-cached-fines-{escalated}"
    bot, captured = _guarded(
        db, monkeypatch, session_id, chunks=FINES_CHUNKS, cards={"pricing_escalated": True} if escalated else None
    )
    question_hash = hashlib.sha256(rs._normalize_question_for_cache(FINES).encode()).hexdigest()[:32]
    key = rs.qa_response_key(bot.id, question_hash, rs._cache_lang_segment(None))
    cached = "GDPR fines can reach €20 million, which the regulator decides."
    captured["cache"].store[key] = {"answer": cached, "sources": []}

    frames = await _drive_stream(bot, FINES, session_id)

    if escalated:
        assert key in captured["cache"].deleted
        assert "€20 million" not in _answer_text(frames)
    else:
        assert key not in captured["cache"].deleted
        assert _answer_text(frames) == cached


#: A card or CTA sentinel, as the widget's ``stripAllSentinels`` knows them.
_SENTINEL_RE = re.compile(r"\[(?:LEAVE_MESSAGE_CARD|MEETING_CARD|(?:YOUTUBE_CARD|DOWNLOAD_CARD|CTA_Q|CTA):[^\]\n]*)\]")


@pytest.mark.parametrize("source", ["prompt_leak", "output_moderation", "price_guard"])
@pytest.mark.asyncio
async def test_an_answer_override_carries_no_sentinel(db, monkeypatch, source):
    """The widget shows ``answer_override`` as sent, without stripping sentinels
    (widget/src/lib/answerOverride.js), so every replacement must arrive clean."""
    session_id = f"guard-sentinel-{source}"
    question, chunks = {
        "prompt_leak": ("where do you operate", ("We cover 3 regions [CTA:budget] ", "<<<DOCUMENT 1>>>")),
        "output_moderation": ("where do you operate", ("We cover 3 regions. [MEETING_CARD]",)),
        "price_guard": (TYPO, ("[LEAVE_MESSAGE_CARD] SOC as a Service starts at ", "₹2,66,250 per month.")),
    }[source]
    bot, _ = _guarded(db, monkeypatch, session_id, chunks=chunks, live_chat_enabled=False)
    if source == "output_moderation":
        monkeypatch.setattr(rs, "check_generated_answer_safety", lambda *a, **k: (False, "harassment"))

    frames = await _drive_stream(bot, question, session_id)

    override = _final_meta(frames)["answer_override"]
    assert override == _messages(db, session_id, role="bot")[-1].content
    assert override.strip()
    assert not _SENTINEL_RE.search(override), override
