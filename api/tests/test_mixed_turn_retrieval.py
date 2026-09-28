"""A turn that asks the price and something else retrieves for the something else.

Production, 2026-09-28, CleanStart (bot 4): "how does onboarding work with you,
and roughly what does it cost?" was answered with "For onboarding, I only have
that we offer a demo and a sales conversation on the pricing page". The same bot
answered "how does onboarding work with you?" from its onboarding content. The
pricing gate deferred the turn (``escalate_deferred``: generation answers it and
the price guard drops the figures), but retrieval had already run on the whole
question, and its price half pulled the pricing page to the top. The onboarding
content never reached the model.

A deferred turn now searches again for the clauses that do not ask the price and
puts what that search finds ahead of the first search's chunks.
"""

import time
import timeit

import pytest

from app.services import price_intent
from app.services import rag_service as rs
from app.services.price_intent import non_price_remainder
from app.services.pricing_gate import pricing_pivot
from tests.test_pricing_gate_pipeline import _make_document
from tests.test_rag_pipeline_defects import (
    _anonymous_visitor,
    _answer_text,
    _doc,
    _drive_stream,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)

QUESTION = "how does onboarding work with you, and roughly what does it cost?"
REMAINDER = "how does onboarding work with you"
PRICING = "Pricing: book a demo or talk to sales for deployment-model pricing."
ONBOARDING = "Onboarding: a kickoff call in week one, then a guided rollout of your first site within 30 days."

#: ``stub_pipeline`` replaces fusion with a fixed list; these tests need the real one.
_REAL_FUSION = rs.reciprocal_rank_fusion


# ── The clauses that do not ask the price ─────────────────────────────────────


@pytest.mark.parametrize(
    ("question", "remainder"),
    [
        (QUESTION, REMAINDER),
        ("whats the pricing, are you hiring, and where is your office", "are you hiring, where is your office"),
        ("is that per month, and do you offer onboarding?", "do you offer onboarding"),
        ("hw much for 3 sites plus how long does setup take", "how long does setup take"),
        ("wat r ur rates; also do u offer training", "do u offer training"),
        ("pricing kya hai aur onboarding kaise hota hai", "onboarding kaise hota hai"),
        ("what does it cost? how does onboarding work?", "how does onboarding work"),
        # "how much time" is not a price: the clause stays with the remainder.
        ("how much time does onboarding take, and what does it cost", "how much time does onboarding take"),
        # Figures with commas and decimals stay in their clause.
        ("is ₹1,20,000 your price for 4.5 sites, and do you train our staff", "do you train our staff"),
    ],
)
def test_the_remainder_keeps_only_the_clauses_that_do_not_ask_the_price(question, remainder):
    assert non_price_remainder(question) == remainder


@pytest.mark.parametrize(
    "question",
    [
        # Nothing is left once the price clause goes.
        "how much does it cost?",
        "whats the pricing, and is that per month?",
        "hi, how much is it? thanks",
        # Nothing asks the price, so the remainder would be the whole question.
        "how does onboarding work with you?",
        "a quote from your leadership, and where is your office",
        "",
        "   ",
    ],
)
def test_no_remainder_when_the_split_would_change_nothing(question):
    assert non_price_remainder(question) is None


def test_a_non_string_has_no_remainder():
    assert non_price_remainder(None) is None
    assert non_price_remainder(42) is None


@pytest.mark.parametrize(
    "question",
    [
        "how does onboarding work, " * 4000 + "and how much does it cost?",
        "and " * 20000 + "pricing",
        "," * 50000,
        "a" * 100_000 + " pricing",
    ],
)
def test_a_long_message_splits_in_linear_time(question):
    assert timeit.timeit(lambda: non_price_remainder(question), number=1) < 2.0


# ── The merge ─────────────────────────────────────────────────────────────────


def test_the_remainder_leads_and_the_first_search_fills_the_rest():
    original = [_doc(f"first {i}") for i in range(6)]
    found = [_doc(f"found {i}") for i in range(6)]

    merged, added = rs._merge_mixed_turn_chunks(original, found, top_k=6, pinned=[])

    assert merged == found[:3] + original[:3]
    assert added == 3


def test_the_merge_dedupes_by_chunk_id_and_counts_only_new_chunks():
    shared = _doc("shared")
    original = [shared, _doc("first")]
    found = [shared, _doc("found")]

    merged, added = rs._merge_mixed_turn_chunks(original, found, top_k=10, pinned=[])

    assert [doc.content for doc in merged] == ["shared", "found", "first"]
    assert added == 1


def test_the_merge_fills_a_short_first_search_from_the_rest_of_the_remainder():
    original = [_doc("first")]
    found = [_doc(f"found {i}") for i in range(4)]

    merged, added = rs._merge_mixed_turn_chunks(original, found, top_k=4, pinned=[])

    assert merged == found[:2] + original + found[2:3]
    assert added == 3


def test_the_merge_keeps_the_pinned_company_facts_first():
    contact = _doc("Contact: hello@acme.com")
    original = [contact, *(_doc(f"first {i}") for i in range(3))]
    found = [_doc(f"found {i}") for i in range(3)]

    merged, _ = rs._merge_mixed_turn_chunks(original, found, top_k=4, pinned=[contact])

    assert merged[0] is contact
    assert len(merged) == 4


# ── The pipeline ──────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def classifier(monkeypatch):
    """The gate model: MIXED for the production question, the fallback rules otherwise."""
    answers = {QUESTION: "mixed", "how much does it cost?": "price"}
    monkeypatch.setattr(
        price_intent,
        "_classify_price_intent_raw",
        lambda question: answers.get(question) or price_intent.fallback_price_intent(question),
    )


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


def _team_priced_turn(db, monkeypatch, session_id, *, answer, delay=0.0):
    """A bot whose pricing goes to the team, and a knowledge base whose keyword
    search finds the pricing page for the whole question and the onboarding page
    for the onboarding clause alone. Returns the bot, the captured prompts and
    every query searched."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, session_id)
    captured = _stub_pipeline(monkeypatch, support=True, chunks=answer)
    _anonymous_visitor(monkeypatch)
    pricing = _doc(PRICING, name="https://cleanstart.example/pricing")
    onboarding = _doc(ONBOARDING, name="https://cleanstart.example/onboarding")
    searched: list[str] = []

    def keyword_search(cid, bid, query, k=15):
        searched.append(query)
        if query == REMAINDER:
            time.sleep(delay)
            return [(onboarding, 1.0)]
        return [(pricing, 1.0)]

    monkeypatch.setattr(rs, "_keyword_search", keyword_search)
    monkeypatch.setattr(rs, "reciprocal_rank_fusion", _REAL_FUSION)
    captured["searched"] = searched
    return bot, captured


def _prompt(captured):
    system_prompt, prompt = captured["prompts"][-1]
    return f"{system_prompt}\n{prompt}"


def _escalation():
    return pricing_pivot(
        company_name="Acme", pricing_url=None, support_enabled=True, live_chat_enabled=True, repeat=False
    ).text


@pytest.mark.asyncio
async def test_a_deferred_turn_reads_the_content_for_its_other_question(db, monkeypatch, metrics):
    answer = ("Plans start at ₹49,000 a month. ", "We start with a kickoff call in week one.")
    bot, captured = _team_priced_turn(db, monkeypatch, "mixed-onboarding", answer=answer)

    frames = await _drive_stream(bot, QUESTION, "mixed-onboarding")

    assert captured["searched"] == [QUESTION, REMAINDER]
    prompt = _prompt(captured)
    assert ONBOARDING in prompt
    # The first search's chunks stay, behind the remainder's.
    assert PRICING in prompt
    assert prompt.index(ONBOARDING) < prompt.index(PRICING)
    assert len(_named(metrics, "pricing_gate_deferred")) == 1
    assert [tags["added"] for tags in _named(metrics, "mixed_turn_retrieval")] == [1]
    # The price guard still drops the figure and adds the escalation after the rest.
    assert _answer_text(frames) == f"We start with a kickoff call in week one.\n\n{_escalation()}"
    assert "49,000" not in "".join(frames)
    assert len(_named(metrics, "price_guard_redacted")) == 1


@pytest.mark.asyncio
async def test_a_stalled_second_search_keeps_the_first_searchs_chunks(db, monkeypatch, metrics):
    monkeypatch.setattr(rs, "_MIXED_TURN_RETRIEVAL_TIMEOUT_S", 0.05)
    answer = ("Our team will walk you through onboarding.",)
    bot, captured = _team_priced_turn(db, monkeypatch, "mixed-stalled", answer=answer, delay=0.5)

    frames = await _drive_stream(bot, QUESTION, "mixed-stalled")

    prompt = _prompt(captured)
    assert PRICING in prompt
    assert ONBOARDING not in prompt
    assert _named(metrics, "mixed_turn_retrieval") == []
    assert len(_named(metrics, "mixed_turn_retrieval_timeout")) == 1
    assert _answer_text(frames) == "Our team will walk you through onboarding."


@pytest.mark.asyncio
async def test_a_failed_second_search_keeps_the_first_searchs_chunks(db, monkeypatch, metrics):
    answer = ("Our team will walk you through onboarding.",)
    bot, captured = _team_priced_turn(db, monkeypatch, "mixed-failed", answer=answer)

    async def broken_embedding(*_a, **_k):
        raise RuntimeError("embedding store down")

    monkeypatch.setattr(rs, "_embed_query_cached_async", broken_embedding)

    frames = await _drive_stream(bot, QUESTION, "mixed-failed")

    prompt = _prompt(captured)
    assert PRICING in prompt
    assert ONBOARDING not in prompt
    assert _named(metrics, "mixed_turn_retrieval") == []
    assert _answer_text(frames) == "Our team will walk you through onboarding."


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "question",
    [
        # Asks no price.
        REMAINDER + "?",
        # Asks only the price: escalated before generation.
        "how much does it cost?",
        # A price word in another sense, beside another question.
        "a quote from your leadership, and where is your office",
    ],
)
async def test_a_turn_that_is_not_deferred_searches_once(db, monkeypatch, metrics, question):
    bot, captured = _team_priced_turn(db, monkeypatch, "not-mixed", answer=("Hello.",))

    await _drive_stream(bot, question, "not-mixed")

    assert captured["searched"] == [question]
    assert _named(metrics, "pricing_gate_deferred") == []
    assert _named(metrics, "mixed_turn_retrieval") == []


@pytest.mark.asyncio
async def test_a_small_knowledge_base_already_holds_every_chunk(db, monkeypatch, metrics):
    """CAG-lite hands the model the whole knowledge base, so there is nothing to search for."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "mixed-cag")
    _make_document(db, bot, client, "https://cleanstart.example/pricing", PRICING)
    _make_document(db, bot, client, "https://cleanstart.example/onboarding", ONBOARDING)
    captured = _stub_pipeline(monkeypatch, support=True, chunks=("We start with a kickoff call.",))
    _anonymous_visitor(monkeypatch)
    searched: list[str] = []
    monkeypatch.setattr(rs, "_keyword_search", lambda cid, bid, query, k=15: searched.append(query) or [])

    await _drive_stream(bot, QUESTION, "mixed-cag")

    assert searched == []
    prompt = _prompt(captured)
    assert ONBOARDING in prompt and PRICING in prompt
    assert len(_named(metrics, "pricing_gate_deferred")) == 1
    assert _named(metrics, "mixed_turn_retrieval") == []


def test_the_deadline_is_below_the_classifier_ceiling():
    """The second search sits ahead of the first token, like the classifiers, and gets less time than they do."""
    assert 0 < rs._MIXED_TURN_RETRIEVAL_TIMEOUT_S < rs._PRICE_INTENT_TIMEOUT_S
