"""The pricing answer gate driven through the REAL rag pipelines.

The gate is unconditional, so every bot below is gated by construction and the
only thing any of these fixtures vary is ``pricing_url``: the page the bot is
allowed to price from, or nothing, which routes the turn to the team.

Modelled on ``test_rag_pipeline_defects.py``: a real throwaway Postgres, with
only the outside world stubbed (LLM stream, query rewrite, embedding, relevance
gate, plan entitlements). The gate itself, retrieval scoping, the canned early
return and persistence all run unmocked.

Assertions are on RESPONSE STRUCTURE, not prose. The escalating pivot and the
neighbouring ``_no_info_pivot`` are one word apart ("connect you with them" vs
"connect you with the team"), so a string match on the copy turns into a silent
false negative the first time someone edits it. What actually distinguishes the
outcomes is the shape of the turn: which safety-net metric fired, whether the
LLM ran at all, ``sources``, ``suggest_handoff``, ``show_leave_message``,
``message_id``, and what got persisted.
"""

import json

import pytest
from sqlalchemy import text

from app.db.models import Bot, ChatMessage, ChatSession, Client, Document
from app.services import rag_service as rs

_seq = iter(range(1, 100_000))

# The gated pricing page, and a stale rate card on a DIFFERENT page. Every
# retrieval-scoping test below asserts the second one never reaches the model:
# quoting it is the exact failure this feature exists to prevent.
_PRICING_URL = "https://acme.com/pricing"
_PRICED_CHUNK = "Pricing: the Acme Pro plan starts at $49 per month per seat."
_STALE_URL = "https://acme.com/legacy-rate-card"
_STALE_CHUNK = "Pricing archive: the legacy rate card was $9 per month per seat."


def _make_client(db):
    n = next(_seq)
    client = Client(
        name=f"Gate Client {n}",
        email=f"gate{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"gate-test-key-{n}",
    )
    db.add(client)
    db.commit()
    return client


def _make_bot(db, client, **kwargs):
    n = next(_seq)
    bot = Bot(
        client_id=client.id,
        bot_key=f"bot-gate-{n}",
        name="Gate Bot",
        company_name="Acme",
        **kwargs,
    )
    db.add(bot)
    db.commit()
    return bot


def _make_document(db, bot, client, document_name, content):
    """Insert a real chunk so hybrid retrieval genuinely runs over it.

    ``search_vector`` is populated the same way ingestion does it
    (``repository.py``), because the keyword half of the hybrid search is what
    actually finds these rows: the tests stub embedding out, so vector search
    returns nothing and ts_rank does all the work.
    """
    doc = Document(
        client_id=client.id,
        bot_id=bot.id,
        document_name=document_name,
        source="crawl",
        file_hash=f"gate-hash-{next(_seq)}",
        content=content,
        source_char_count=len(content),
        embedding=[0.0] * 768,
    )
    db.add(doc)
    db.commit()
    db.execute(
        text("UPDATE documents SET search_vector = to_tsvector('english', content) WHERE id = :doc_id"),
        {"doc_id": doc.id},
    )
    db.commit()
    return doc


@pytest.fixture()
def _stub_outside_world(monkeypatch):
    """Stub everything that leaves the process, and pin the plan gate ON."""

    async def _no_embedding_async(*_a, **_k):
        return None

    monkeypatch.setattr(rs, "rewrite_query", lambda _sid, q, _h: q)
    monkeypatch.setattr(rs, "_embed_query_cached", lambda *_a, **_k: None)
    monkeypatch.setattr(rs, "_embed_query_cached_async", _no_embedding_async)
    monkeypatch.setattr(rs, "RERANK_ENABLED", False)
    monkeypatch.setattr(rs, "detect_handoff_intent", lambda _q: False)
    monkeypatch.setattr(rs, "resolve_name_flow", lambda *_a, **_k: (None, None, None, False))
    monkeypatch.setattr(rs, "_should_ask_visitor_name", lambda *_a, **_k: False)
    monkeypatch.setattr(rs.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *_a, **_k: True)


@pytest.fixture()
def _stub_generation(monkeypatch):
    """Stub the LLM and the judges around it, and capture every prompt.

    An empty ``prompts`` list is the assertion that the gate short-circuited
    before generation: the canned pivot must never be an LLM call.
    """
    captured: dict = {"prompts": []}

    async def _fake_stream(prompt, **kwargs):
        captured["prompts"].append(prompt)
        yield "GENERATED ANSWER"

    monkeypatch.setattr(rs, "generate_response_stream", _fake_stream)
    monkeypatch.setattr(rs, "generate_response", lambda *a, **k: "GENERATED ANSWER")

    def _fake_checked(prompt, *a, **k):
        captured["prompts"].append(prompt)
        return "GENERATED ANSWER", False

    monkeypatch.setattr(rs, "generate_response_checked", _fake_checked)
    monkeypatch.setattr(rs, "check_relevance", lambda *a, **k: (True, 1.0))
    monkeypatch.setattr(rs, "check_generated_answer_safety", lambda *a, **k: (True, None))
    monkeypatch.setattr(rs, "check_visitor_safety", lambda _q: (True, None))
    monkeypatch.setattr(rs, "route_intent", lambda *a, **k: None)
    monkeypatch.setattr(rs, "should_sample", lambda: False)
    monkeypatch.setattr(rs, "submit_background", lambda _fn, *a, **k: None)
    monkeypatch.setattr(rs, "cache_get", lambda *a, **k: None)
    monkeypatch.setattr(rs, "cache_set", lambda *a, **k: None)
    monkeypatch.setattr(rs, "cache_delete", lambda *a, **k: None)
    return captured


@pytest.fixture()
def _gate_metrics(monkeypatch):
    """Capture ``pricing_gate_escalation`` firings and their ``reason``.

    This is how a test tells ``escalate_no_url`` from ``escalate_no_content``
    from "the gate never fired and some other pivot answered", without matching
    on copy.
    """
    fired: list[dict] = []
    real = rs._safety_net_metric

    def _spy(name, **fields):
        if name == "pricing_gate_escalation":
            fired.append(fields)
        return real(name, **fields)

    monkeypatch.setattr(rs, "_safety_net_metric", _spy)
    return fired


@pytest.fixture()
def _no_cag_lite(monkeypatch):
    """Force the real hybrid-retrieval path.

    CAG-lite injects the entire knowledge base when it holds 20 chunks or
    fewer, which would hand the gate every row and skip the retrieval it is
    supposed to be narrowing. Disabling it is what makes the scoping
    assertions below mean something.
    """
    monkeypatch.setenv("CAG_LITE_THRESHOLD", "0")


async def _collect(agen) -> list[str]:
    return [chunk async for chunk in agen]


def _final_meta(frames) -> dict | None:
    for frame in reversed(frames):
        if frame.startswith("\nFINAL_METADATA:"):
            return json.loads(frame.split("FINAL_METADATA:", 1)[1].strip())
    return None


def _sources(frames) -> list | None:
    for frame in frames:
        if frame.startswith("METADATA:"):
            return json.loads(frame.split("METADATA:", 1)[1].strip())["sources"]
    return None


def _answer_text(frames) -> str:
    return "".join(f for f in frames if not f.startswith(("METADATA:", "\nFINAL_METADATA:")))


def _bot_messages(db, session_id):
    return (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == session_id, ChatMessage.role == "bot")
        .order_by(ChatMessage.id)
        .all()
    )


# ── escalate_no_url ──────────────────────────────────────────────────────────
#
# This is the platform-wide behaviour change. A bot that names no pricing page
# used to pass its pricing turns straight through to the knowledge base, so a
# stale rate card sitting in it answered them. Now it escalates, and the card
# never reaches the model. Both cases below therefore put a priced chunk in the
# knowledge base: without one they would pass against a bot with an empty KB
# too, which proves nothing about the inversion.


@pytest.mark.asyncio
async def test_pricing_question_without_a_configured_url_escalates(
    db, _stub_outside_world, _stub_generation, _gate_metrics, _no_cag_lite
):
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=None)
    _make_document(db, bot, client, _STALE_URL, _STALE_CHUNK)

    frames = await _collect(
        rs.rag_pipeline_stream(bot, "how much does it cost?", session_id="gate-no-url", bot_id=bot.id)
    )
    meta = _final_meta(frames)

    assert [m["reason"] for m in _gate_metrics] == ["escalate_no_url"]
    # The gate must not have reached the LLM at all, so the stale card cannot
    # have been in front of it.
    assert _stub_generation["prompts"] == []
    assert "$9" not in _answer_text(frames)
    assert _sources(frames) == []
    assert meta is not None, "the frontend hangs forever without a FINAL_METADATA frame"
    assert meta["message_id"]
    assert meta["suggest_handoff"] is True
    assert "show_leave_message" not in meta


def test_non_streaming_pipeline_escalates_a_pricing_question(
    db, _stub_outside_world, _stub_generation, _gate_metrics, _no_cag_lite
):
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=None)
    _make_document(db, bot, client, _STALE_URL, _STALE_CHUNK)

    result = rs.rag_pipeline(bot, "what is your pricing?", session_id="gate-sync", bot_id=bot.id)

    assert [m["reason"] for m in _gate_metrics] == ["escalate_no_url"]
    assert _stub_generation["prompts"] == []
    assert "$9" not in result["answer"]
    assert result["sources"] == []
    assert result["message_id"]
    assert result["suggest_handoff"] is True
    assert "show_leave_message" not in result


@pytest.mark.asyncio
async def test_free_plan_pricing_escalation_never_promises_a_human(
    db, monkeypatch, _stub_outside_world, _stub_generation, _gate_metrics
):
    """On Free there is neither a live queue nor a message form, so the reply
    must not name the team, promise a callback, or ask for a card."""
    monkeypatch.setattr(rs.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *_a, **_k: False)
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=_PRICING_URL)

    frames = await _collect(rs.rag_pipeline_stream(bot, "what is your pricing?", session_id="gate-free", bot_id=bot.id))
    answer = _answer_text(frames)
    meta = _final_meta(frames)

    # The page is configured but absent from the (empty) knowledge base.
    assert [m["reason"] for m in _gate_metrics] == ["escalate_no_content"]
    assert _stub_generation["prompts"] == []
    assert meta is not None
    assert meta["suggest_handoff"] is False
    assert "show_leave_message" not in meta
    assert rs.LEAVE_MESSAGE_CARD_SENTINEL not in answer
    # Copy assertions kept deliberately: on Free these are the contract, and
    # they are absence checks, so a copy edit cannot silently pass them.
    lowered = answer.lower()
    assert "connect you" not in lowered
    assert "message form" not in lowered
    # It still hands over the page the owner configured.
    assert _PRICING_URL in answer


# ── outcome == "answer": retrieval narrowed to the pricing page ──────────────


@pytest.mark.asyncio
async def test_priced_page_narrows_retrieval_to_that_page_alone(
    db, _stub_outside_world, _stub_generation, _gate_metrics, _no_cag_lite
):
    """The gate's whole point: the pricing page answers, and the stale rate
    card sitting in the same knowledge base never reaches the model."""
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=_PRICING_URL)
    _make_document(db, bot, client, _PRICING_URL, _PRICED_CHUNK)
    _make_document(db, bot, client, _STALE_URL, _STALE_CHUNK)

    frames = await _collect(
        rs.rag_pipeline_stream(bot, "what is your pricing?", session_id="gate-answer", bot_id=bot.id)
    )
    meta = _final_meta(frames)

    # No escalation: the gate narrowed and stood aside.
    assert _gate_metrics == []
    assert _sources(frames) == [_PRICING_URL]
    assert len(_stub_generation["prompts"]) == 1, "the narrowed turn must still reach generation"
    prompt = _stub_generation["prompts"][0]
    assert "$49 per month" in prompt
    assert "$9 per month" not in prompt, "the stale rate card leaked into a gated pricing answer"
    assert meta is not None
    assert meta["message_id"]
    assert "show_leave_message" not in meta


def test_non_streaming_priced_page_narrows_retrieval_to_that_page_alone(
    db, _stub_outside_world, _stub_generation, _gate_metrics, _no_cag_lite
):
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=_PRICING_URL)
    _make_document(db, bot, client, _PRICING_URL, _PRICED_CHUNK)
    _make_document(db, bot, client, _STALE_URL, _STALE_CHUNK)

    result = rs.rag_pipeline(bot, "what is your pricing?", session_id="gate-answer-sync", bot_id=bot.id)

    assert _gate_metrics == []
    assert result["sources"] == [_PRICING_URL]
    assert len(_stub_generation["prompts"]) == 1
    assert "$9 per month" not in _stub_generation["prompts"][0]


# ── escalate_no_content: page present, no price on it ────────────────────────


@pytest.mark.asyncio
async def test_pricing_page_present_but_carrying_no_price_escalates(
    db, _stub_outside_world, _stub_generation, _gate_metrics, _no_cag_lite
):
    """A crawl that captured only the nav, or a stub page. Answering "our
    pricing is..." from it invents a figure, so it is treated as a missing
    page and must not fall back to the rest of the knowledge base."""
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=_PRICING_URL)
    _make_document(db, bot, client, _PRICING_URL, "Pricing: plans built for teams of every size. Talk to us.")
    _make_document(db, bot, client, _STALE_URL, _STALE_CHUNK)

    frames = await _collect(
        rs.rag_pipeline_stream(bot, "what is your pricing?", session_id="gate-no-content", bot_id=bot.id)
    )
    answer = _answer_text(frames)
    meta = _final_meta(frames)

    assert [m["reason"] for m in _gate_metrics] == ["escalate_no_content"]
    assert _stub_generation["prompts"] == []
    assert _sources(frames) == []
    assert "$9" not in answer, "the stale rate card leaked into an escalating pricing turn"
    assert meta is not None
    assert meta["message_id"]
    assert meta["suggest_handoff"] is True


@pytest.mark.asyncio
async def test_pricing_page_absent_from_the_knowledge_base_escalates(
    db, _stub_outside_world, _stub_generation, _gate_metrics, _no_cag_lite
):
    """Only the stale rate card is in the knowledge base. The configured page
    is not, so there is no source the bot is allowed to price from."""
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=_PRICING_URL)
    _make_document(db, bot, client, _STALE_URL, _STALE_CHUNK)

    frames = await _collect(
        rs.rag_pipeline_stream(bot, "what is your pricing?", session_id="gate-absent", bot_id=bot.id)
    )

    assert [m["reason"] for m in _gate_metrics] == ["escalate_no_content"]
    assert _stub_generation["prompts"] == []
    assert _sources(frames) == []
    assert "$9" not in _answer_text(frames)


# ── needs_message_card: paid plan, live chat turned off ──────────────────────


@pytest.mark.asyncio
async def test_paid_bot_with_live_chat_off_gets_the_card_as_metadata_not_a_sentinel(
    db, _stub_outside_world, _stub_generation, _gate_metrics
):
    """``pricing_pivot`` asks for the leave-message card whenever the plan
    allows human support but the bot turned the live queue off (a supported
    paid configuration). The card travels in FINAL_METADATA. The sentinel is a
    model-to-server token this pipeline strips, so emitting it would ship the
    literal "[LEAVE_MESSAGE_CARD]" to the visitor, persist it into history, and
    still open no form."""
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=None, live_chat_enabled=False)

    frames = await _collect(rs.rag_pipeline_stream(bot, "what is your pricing?", session_id="gate-card", bot_id=bot.id))
    answer = _answer_text(frames)
    meta = _final_meta(frames)

    assert [m["reason"] for m in _gate_metrics] == ["escalate_no_url"]
    assert meta is not None
    assert meta["show_leave_message"] is True
    assert meta["suggest_handoff"] is False, "the form and a live handoff must never compete on one turn"
    assert meta["message_id"]
    assert rs.LEAVE_MESSAGE_CARD_SENTINEL not in answer

    # The persisted message must be clean too, or the raw token is replayed
    # into the next turn's prompt as chat history.
    messages = _bot_messages(db, "gate-card")
    assert len(messages) == 1
    assert rs.LEAVE_MESSAGE_CARD_SENTINEL not in messages[0].content
    assert messages[0].content == answer

    # Marked shown, so the card is not re-offered on every pricing turn.
    db.expire_all()
    chat_session = db.query(ChatSession).filter(ChatSession.id == "gate-card").one()
    assert (chat_session.inline_cards_shown or {}).get("leave_message") is True


def test_non_streaming_paid_bot_with_live_chat_off_sets_show_leave_message(
    db, _stub_outside_world, _stub_generation, _gate_metrics
):
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=None, live_chat_enabled=False)

    result = rs.rag_pipeline(bot, "what is your pricing?", session_id="gate-card-sync", bot_id=bot.id)

    assert [m["reason"] for m in _gate_metrics] == ["escalate_no_url"]
    assert result["show_leave_message"] is True
    assert result["suggest_handoff"] is False
    assert result["message_id"]
    assert rs.LEAVE_MESSAGE_CARD_SENTINEL not in result["answer"]

    messages = _bot_messages(db, "gate-card-sync")
    assert len(messages) == 1
    assert rs.LEAVE_MESSAGE_CARD_SENTINEL not in messages[0].content

    db.expire_all()
    chat_session = db.query(ChatSession).filter(ChatSession.id == "gate-card-sync").one()
    assert (chat_session.inline_cards_shown or {}).get("leave_message") is True


# ── the gate must stand down on everything else ──────────────────────────────


@pytest.mark.asyncio
async def test_non_pricing_question_is_untouched_by_the_gate(
    db, _stub_outside_world, _stub_generation, _gate_metrics, _no_cag_lite
):
    """An unconditional gate still only owns pricing turns. Non-vacuous: with a
    real knowledge base behind it, this asserts the turn actually reached
    generation with its retrieved chunk. A version that ran against an EMPTY
    knowledge base and only checked that a phrase was absent would pass with the
    gate entirely removed AND with the gate wrongly escalating."""
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=_PRICING_URL)
    _make_document(db, bot, client, "https://acme.com/about", "Founder: Acme was founded by Dana Reyes in 2019.")
    _make_document(db, bot, client, _STALE_URL, _STALE_CHUNK)

    frames = await _collect(rs.rag_pipeline_stream(bot, "who is the founder?", session_id="gate-other", bot_id=bot.id))

    assert _gate_metrics == [], "the gate must not fire on a non-pricing question"
    assert len(_stub_generation["prompts"]) == 1, "the turn must reach generation, not a pivot"
    assert "Dana Reyes" in _stub_generation["prompts"][0]
    # Retrieval was NOT narrowed to the pricing page.
    assert "https://acme.com/about" in (_sources(frames) or [])
    assert _answer_text(frames) == "GENERATED ANSWER"


@pytest.mark.asyncio
async def test_a_pricing_idiom_does_not_escalate(
    db, _stub_outside_world, _stub_generation, _gate_metrics, _no_cag_lite
):
    """ "how much time" carries a price token but is not a request for prices.

    A false positive now costs more than it used to: it escalates a question the
    knowledge base could have answered, on every bot on the platform rather than
    on the ones that opted in."""
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=_PRICING_URL)
    _make_document(
        db,
        bot,
        client,
        "https://acme.com/onboarding",
        "Onboarding: how much time does it take? About two weeks end to end.",
    )

    frames = await _collect(
        rs.rag_pipeline_stream(bot, "how much time does onboarding take?", session_id="gate-idiom", bot_id=bot.id)
    )

    assert _gate_metrics == []
    assert len(_stub_generation["prompts"]) == 1
    assert _answer_text(frames) == "GENERATED ANSWER"


# ── the rewritten query carries the intent on a pronoun follow-up ────────────


@pytest.mark.asyncio
async def test_a_pronoun_followup_rewritten_into_a_pricing_question_still_gates(
    db, monkeypatch, _stub_outside_world, _stub_generation, _gate_metrics, _no_cag_lite
):
    """ "do you have plans?" then "and that one?" carries no price token of its
    own. Gating on the raw question alone stands the gate down and lets the
    unrestricted knowledge base quote the stale rate card, which is the exact
    failure the feature exists to prevent."""
    monkeypatch.setattr(rs, "rewrite_query", lambda _sid, _q, _h: "what is the pricing for the Pro plan?")
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=_PRICING_URL)
    _make_document(db, bot, client, _STALE_URL, _STALE_CHUNK)

    frames = await _collect(rs.rag_pipeline_stream(bot, "and that one?", session_id="gate-followup", bot_id=bot.id))

    assert [m["reason"] for m in _gate_metrics] == ["escalate_no_content"]
    assert _stub_generation["prompts"] == []
    assert "$9" not in _answer_text(frames)


def test_non_streaming_pronoun_followup_rewritten_into_a_pricing_question_still_gates(
    db, monkeypatch, _stub_outside_world, _stub_generation, _gate_metrics, _no_cag_lite
):
    monkeypatch.setattr(rs, "rewrite_query", lambda _sid, _q, _h: "what is the pricing for the Pro plan?")
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=_PRICING_URL)
    _make_document(db, bot, client, _STALE_URL, _STALE_CHUNK)

    result = rs.rag_pipeline(bot, "and that one?", session_id="gate-followup-sync", bot_id=bot.id)

    assert [m["reason"] for m in _gate_metrics] == ["escalate_no_content"]
    assert _stub_generation["prompts"] == []
    assert "$9" not in result["answer"]


@pytest.mark.asyncio
async def test_a_rewrite_that_loses_the_price_token_still_gates_on_the_raw_question(
    db, monkeypatch, _stub_outside_world, _stub_generation, _gate_metrics, _no_cag_lite
):
    """The reverse direction: the raw question is the one carrying the intent,
    so a rewrite that drops the price token must not stand the gate down."""
    monkeypatch.setattr(rs, "rewrite_query", lambda _sid, _q, _h: "Acme Pro plan details")
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_url=_PRICING_URL)
    _make_document(db, bot, client, _STALE_URL, _STALE_CHUNK)

    frames = await _collect(
        rs.rag_pipeline_stream(bot, "how much does the Pro plan cost?", session_id="gate-rewrite-loss", bot_id=bot.id)
    )

    assert [m["reason"] for m in _gate_metrics] == ["escalate_no_content"]
    assert _stub_generation["prompts"] == []
    assert "$9" not in _answer_text(frames)
