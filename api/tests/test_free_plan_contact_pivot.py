"""The Free-plan no-info pivot hands over the customer's own contact page.

``_no_info_pivot`` is the canned reply for an ON-SCOPE question the knowledge
base could not answer. On a paid plan it offers to connect the visitor with the
team. On Free there is no live queue and no leave-a-message form, so that offer
would be a promise the product cannot keep, and the Free branch used to end the
turn with "is there something else?" instead: a dead end for a visitor who asked
a real question and got nothing actionable.

The fix reuses the bot's existing Smart Links (``bots.answer_links``) as the
source of a contact page. That is deliberately NOT a paywall leak: the paid
feature is the in-chat channel (live queue, leave-a-message form, operator inbox,
notification emails), while a public page on the customer's own website is
information. It is the same reasoning that already lets the Free pricing pivot
hand over ``pricing_url``.

The end-to-end half of this file uses the harness from
``test_pricing_gate_e2e.py``: a real throwaway Postgres, real retrieval, real
persistence, with only the outside world stubbed. Both pipelines are driven
because ``rag_pipeline`` (sync) and ``rag_pipeline_stream`` (async) hold two
hand-duplicated copies of the pivot block, so a defect can live in one and not
the other.
"""

import json

import pytest

from app.db.models import Bot, ChatMessage, Client
from app.services import rag_service as rs

# ═══════════════════════════════════════════════════════════════════════════
# Unit: pulling the contact page out of Smart Links
# ═══════════════════════════════════════════════════════════════════════════

_CONTACT = "https://acme.com/contact"


@pytest.mark.parametrize(
    "keyword",
    ["contact", "Contact", "CONTACT", "contact us", "Contact Us", "CONTACT US", "contact-us", "Contact-Us"],
)
def test_contact_keyword_matches_case_insensitively(keyword):
    assert rs._contact_url_from_answer_links([{"keyword": keyword, "url": _CONTACT}]) == _CONTACT


@pytest.mark.parametrize("keyword", ["  contact  ", "\tContact Us\n", " contact-us "])
def test_contact_keyword_is_trimmed_before_comparing(keyword):
    """An admin's stray whitespace must not silently disable the handover."""
    assert rs._contact_url_from_answer_links([{"keyword": keyword, "url": _CONTACT}]) == _CONTACT


@pytest.mark.parametrize("keyword", ["pricing", "careers", "contact sales", "contacts", "support", ""])
def test_unrelated_keywords_are_ignored(keyword):
    """The match is exact (after trim + casefold), never a substring.

    ``contact sales`` routes to a sales form, not a general contact page, and
    guessing wrong here puts the wrong URL in front of every Free visitor who
    asked something the bot could not answer.
    """
    assert rs._contact_url_from_answer_links([{"keyword": keyword, "url": _CONTACT}]) is None


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "http://[::1",
        "",
        "   ",
        "not a url",
        "mailto:hi@acme.com",
        "//acme.com/contact",
        None,
        123,
    ],
)
def test_a_url_normalize_url_refuses_is_not_handed_to_a_visitor(url):
    """``normalize_url`` is the single definition of a usable link.

    ``answer_links`` is validated on write, but the column is JSONB and predates
    that validation, so a legacy or hand-edited row can hold anything. A value
    that fails here would otherwise be pasted verbatim into the visitor's reply
    and persisted to ``chat_messages.content``.
    """
    assert rs._contact_url_from_answer_links([{"keyword": "contact", "url": url}]) is None


@pytest.mark.parametrize("links", [None, [], {}, "contact", [None, 1, "x"], [{}], [{"keyword": "contact"}], [[]]])
def test_missing_or_malformed_answer_links_return_none(links):
    assert rs._contact_url_from_answer_links(links) is None


def test_first_usable_contact_match_wins():
    links = [
        {"keyword": "pricing", "url": "https://acme.com/pricing"},
        {"keyword": "Contact Us", "url": "https://acme.com/contact-us"},
        {"keyword": "contact", "url": _CONTACT},
    ]
    assert rs._contact_url_from_answer_links(links) == "https://acme.com/contact-us"


def test_an_unusable_first_match_does_not_shadow_a_usable_later_one():
    """Skipping, not aborting: a junk row must not cost the visitor a link the
    admin also configured correctly."""
    links = [
        {"keyword": "contact", "url": "javascript:alert(1)"},
        {"keyword": "contact us", "url": _CONTACT},
    ]
    assert rs._contact_url_from_answer_links(links) == _CONTACT


# ═══════════════════════════════════════════════════════════════════════════
# Unit: the pivot copy itself
# ═══════════════════════════════════════════════════════════════════════════

# Byte-for-byte what the paid branch produced before this feature existed. Any
# change to this string is a change to what every paid bot says on every
# unanswerable on-scope turn, so it is pinned rather than pattern-matched.
_PAID_TEXT = (
    "I don't have that specific detail on hand for **Acme**. Want me to connect you with the team so they can help "
    "directly?"
)
_FREE_NO_LINK_TEXT = "I don't have that specific detail on hand for **Acme**. Is there something else about **Acme** I can help you with?"


def test_paid_pivot_is_unchanged_with_a_contact_url():
    assert rs._no_info_pivot("Acme", support_enabled=True, contact_url=_CONTACT) == _PAID_TEXT


def test_paid_pivot_is_unchanged_without_a_contact_url():
    assert rs._no_info_pivot("Acme", support_enabled=True) == _PAID_TEXT
    assert rs._no_info_pivot("Acme") == _PAID_TEXT


def test_free_pivot_hands_over_the_contact_url():
    assert rs._no_info_pivot("Acme", support_enabled=False, contact_url=_CONTACT) == (
        f"I don't have that specific detail on hand for **Acme**. You can get in touch here: {_CONTACT}"
    )


def test_free_pivot_without_a_contact_url_is_unchanged():
    assert rs._no_info_pivot("Acme", support_enabled=False) == _FREE_NO_LINK_TEXT
    assert rs._no_info_pivot("Acme", support_enabled=False, contact_url=None) == _FREE_NO_LINK_TEXT


@pytest.mark.parametrize("url", ["javascript:alert(1)", "http://[::1", "", "   "])
def test_free_pivot_refuses_an_unusable_contact_url(url):
    """Defence in depth, mirroring ``pricing_gate.pricing_pivot``.

    The extractor already filters on ``normalize_url``, but the pivot is a plain
    public function whose output goes straight to a visitor, so it must not be
    able to render "You can get in touch here: javascript:alert(1)" for a caller
    that skipped the extractor.
    """
    assert rs._no_info_pivot("Acme", support_enabled=False, contact_url=url) == _FREE_NO_LINK_TEXT


def test_free_pivot_with_no_company_name_still_links():
    assert rs._no_info_pivot(None, support_enabled=False, contact_url=_CONTACT) == (
        f"I don't have that specific detail on hand for us. You can get in touch here: {_CONTACT}"
    )


# ═══════════════════════════════════════════════════════════════════════════
# End to end, both pipelines
# ═══════════════════════════════════════════════════════════════════════════

_seq = iter(range(1, 100_000))

PIPELINES = ("stream", "sync")

# On-scope (``hours`` is in ``_ON_SCOPE_HINTS_RE``) and unanswerable, because the
# bots below carry no documents at all. That pair is exactly what routes a turn
# to ``_no_info_pivot`` rather than to the off-topic refusal.
_QUESTION = "what are your business hours?"


def _make_client(db):
    n = next(_seq)
    client = Client(
        name=f"Contact Pivot Client {n}",
        email=f"contact-pivot{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"contact-pivot-key-{n}",
    )
    db.add(client)
    db.commit()
    return client


def _make_bot(db, client, **kwargs):
    n = next(_seq)
    bot = Bot(
        client_id=client.id,
        bot_key=f"bot-contact-{n}",
        name="Pivot Bot",
        company_name="Acme",
        **kwargs,
    )
    db.add(bot)
    db.commit()
    return bot


@pytest.fixture()
def _stub_outside_world(monkeypatch):
    """Stub everything that leaves the process. The plan gate is set per test."""

    async def _no_embedding_async(*_a, **_k):
        return None

    monkeypatch.setattr(rs, "rewrite_query", lambda _sid, q, _h: q)
    monkeypatch.setattr(rs, "_embed_query_cached", lambda *_a, **_k: None)
    monkeypatch.setattr(rs, "_embed_query_cached_async", _no_embedding_async)
    monkeypatch.setattr(rs, "RERANK_ENABLED", False)
    monkeypatch.setattr(rs, "detect_handoff_intent", lambda _q: False)
    monkeypatch.setattr(rs, "resolve_name_flow", lambda *_a, **_k: (None, None, None, False))
    monkeypatch.setattr(rs, "_should_ask_visitor_name", lambda *_a, **_k: False)
    monkeypatch.setattr(rs, "check_relevance", lambda *a, **k: (True, 1.0))
    monkeypatch.setattr(rs, "check_visitor_safety", lambda _q: (True, None))
    monkeypatch.setattr(rs, "check_generated_answer_safety", lambda *a, **k: (True, None))
    monkeypatch.setattr(rs, "route_intent", lambda *a, **k: None)
    monkeypatch.setattr(rs, "should_sample", lambda: False)
    monkeypatch.setattr(rs, "submit_background", lambda _fn, *a, **k: None)
    monkeypatch.setattr(rs, "cache_get", lambda *a, **k: None)
    monkeypatch.setattr(rs, "cache_set", lambda *a, **k: None)
    monkeypatch.setattr(rs, "cache_delete", lambda *a, **k: None)
    monkeypatch.setattr(rs, "_generate_query_paraphrases", lambda *a, **k: [])
    monkeypatch.setenv("CAG_LITE_THRESHOLD", "0")


@pytest.fixture()
def _stub_generation(monkeypatch):
    """Capture every prompt. An empty list is the assertion that the canned
    pivot short-circuited before generation."""
    captured: dict = {"prompts": [], "system_prompts": []}

    async def _fake_stream(prompt, **kwargs):
        captured["prompts"].append(prompt)
        captured["system_prompts"].append(kwargs.get("system_prompt") or "")
        yield "GENERATED ANSWER"

    monkeypatch.setattr(rs, "generate_response_stream", _fake_stream)
    monkeypatch.setattr(rs, "generate_response", lambda *a, **k: "GENERATED ANSWER")

    def _fake_checked(prompt, *a, **k):
        captured["prompts"].append(prompt)
        captured["system_prompts"].append(k.get("system_prompt") or "")
        return "GENERATED ANSWER", False

    monkeypatch.setattr(rs, "generate_response_checked", _fake_checked)
    return captured


async def _collect(agen) -> list[str]:
    return [chunk async for chunk in agen]


def _answer_text(frames) -> str:
    return "".join(f for f in frames if not f.startswith(("METADATA:", "\nFINAL_METADATA:")))


def _final_meta(frames) -> dict | None:
    for frame in reversed(frames):
        if frame.startswith("\nFINAL_METADATA:"):
            return json.loads(frame.split("FINAL_METADATA:", 1)[1].strip())
    return None


async def _drive(pipeline: str, bot, question: str, session_id: str) -> dict:
    if pipeline == "stream":
        frames = await _collect(rs.rag_pipeline_stream(bot, question, session_id=session_id, bot_id=bot.id))
        return {"answer": _answer_text(frames), "meta": _final_meta(frames)}
    result = rs.rag_pipeline(bot, question, session_id=session_id, bot_id=bot.id)
    return {"answer": result["answer"], "meta": result}


def _persisted_bot_reply(db, session_id) -> str:
    rows = (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == session_id, ChatMessage.role == "bot")
        .order_by(ChatMessage.id)
        .all()
    )
    assert rows, "the pivot was never persisted"
    return rows[-1].content


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_free_bot_with_a_contact_smart_link_hands_it_over(
    db, monkeypatch, pipeline, _stub_outside_world, _stub_generation
):
    """The whole point of the change: a Free visitor whose question the bot
    cannot answer leaves with somewhere to go, and is still never promised a
    human inside the chat."""
    monkeypatch.setattr(rs.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *_a, **_k: False)
    client = _make_client(db)
    bot = _make_bot(
        db,
        client,
        answer_links=[
            {"keyword": "pricing", "url": "https://acme.com/pricing"},
            {"keyword": "Contact Us", "url": _CONTACT},
        ],
    )
    session_id = f"free-contact-{pipeline}"

    out = await _drive(pipeline, bot, _QUESTION, session_id)

    assert _stub_generation["prompts"] == [], "a canned pivot must never be an LLM call"
    assert _CONTACT in out["answer"]
    assert "get in touch here" in out["answer"]
    assert "connect you with the team" not in out["answer"], "a Free bot promised a channel its plan does not include"
    assert "Is there something else about" not in out["answer"], "the dead-end copy is still being used"
    assert out["meta"].get("suggest_handoff") is not True
    assert _CONTACT in _persisted_bot_reply(db, session_id)


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_free_bot_without_a_contact_smart_link_is_unchanged(
    db, monkeypatch, pipeline, _stub_outside_world, _stub_generation
):
    """No contact link configured is the untouched third row of the table: the
    old copy, with no invented URL."""
    monkeypatch.setattr(rs.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *_a, **_k: False)
    client = _make_client(db)
    bot = _make_bot(db, client, answer_links=[{"keyword": "pricing", "url": "https://acme.com/pricing"}])
    session_id = f"free-nolink-{pipeline}"

    out = await _drive(pipeline, bot, _QUESTION, session_id)

    assert _stub_generation["prompts"] == []
    assert "Is there something else about **Acme** I can help you with?" in out["answer"]
    assert "http" not in out["answer"], "a link appeared with no contact Smart Link configured"
    assert "connect you with the team" not in out["answer"]


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_free_bot_with_an_unusable_contact_url_is_unchanged(
    db, monkeypatch, pipeline, _stub_outside_world, _stub_generation
):
    """An unusable URL is no URL at all, all the way through the pipeline: the
    visitor gets the old copy rather than a pasted ``javascript:`` payload."""
    monkeypatch.setattr(rs.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *_a, **_k: False)
    client = _make_client(db)
    bot = _make_bot(db, client, answer_links=[{"keyword": "contact", "url": "javascript:alert(1)"}])
    session_id = f"free-badlink-{pipeline}"

    out = await _drive(pipeline, bot, _QUESTION, session_id)

    assert "javascript:" not in out["answer"]
    assert "javascript:" not in _persisted_bot_reply(db, session_id)
    assert "Is there something else about **Acme** I can help you with?" in out["answer"]


@pytest.mark.asyncio
@pytest.mark.parametrize("pipeline", PIPELINES)
async def test_paid_bot_is_unaffected_by_a_contact_smart_link(
    db, monkeypatch, pipeline, _stub_outside_world, _stub_generation
):
    """Regression guard on the paid branch: a paid bot that happens to have a
    contact Smart Link must still offer the team, and must not hand over the
    link instead. The paid in-chat channel exists and is the better answer."""
    monkeypatch.setattr(rs.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *_a, **_k: True)
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, answer_links=[{"keyword": "contact", "url": _CONTACT}])
    session_id = f"paid-contact-{pipeline}"

    out = await _drive(pipeline, bot, _QUESTION, session_id)

    assert "connect you with the team" in out["answer"]
    assert _CONTACT not in out["answer"], "the paid branch handed over the contact link instead of the team"
    assert "get in touch here" not in out["answer"]
