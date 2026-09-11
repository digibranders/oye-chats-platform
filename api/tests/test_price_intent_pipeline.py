"""The turn's price decision, driven through the real chat stream.

Production, 2026-09-11, on bots that leave pricing to the team: a reporter asking
for "a quote from your leadership" got "Pricing for **Story** at **Eventus
Security** is best confirmed by the team", and "whats the share price, should i
invest" got "Pricing for **Eventus Security** is best confirmed by the team".

The gate and the price guard now act on one decision per turn
(``price_intent``), and the escalation names a service only when the owner
configured it. The gate model is a fake here; everything the decision drives
runs unmocked.
"""

import asyncio
import time

import pytest

from app.db.models import ChatSession
from app.services import price_intent, urgent_route
from app.services import rag_service as rs
from app.services.pricing_gate import pricing_pivot
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

REPORTER = (
    "hi im a reporter at a tech publication doing a story on ransomware trends in india, "
    "can i get a quote from your leadership"
)
SHARE_PRICE = "is eventus listed? whats the share price, should i invest"
PRICING_MODEL = "do u charge per endpoint, per user or per image? whats the pricing model"
#: Capitalised words the old subject recovery lifted into the reply.
KB = (_doc("Story: Data Per-User licensing for India. Our Office is hiring AI engineers. NO lock-in."),)
GENERIC = (
    "Pricing for **Acme** is best confirmed by the team so you get an accurate figure. "
    "Want me to connect you with them now?"
)


class _Classifier:
    """Stands in for the gate model behind ``price_intent.decide_price_intent``."""

    def __init__(self) -> None:
        self.answers: dict[str, str] = {}
        self.default = "PRICE"
        self.error: Exception | None = None
        self.delay_s = 0.0
        self.calls: list[str] = []

    def __call__(self, question: str) -> str:
        self.calls.append(question)
        if self.delay_s:
            time.sleep(self.delay_s)
        if self.error is not None:
            raise self.error
        return price_intent._LABELS[self.answers.get(question, self.default)]


@pytest.fixture(autouse=True)
def classifier(monkeypatch):
    """No test here reaches a real model. The reporter's "ransomware" also passes
    the urgent route's vocabulary, whose classifier says the visitor reports no
    incident."""
    fake = _Classifier()
    monkeypatch.setattr(price_intent, "_classify_price_intent_raw", fake)
    monkeypatch.setattr(urgent_route, "_classify_urgent_incident_raw", lambda _question: False)
    return fake


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


def _cards(db, session_id):
    db.expire_all()
    return db.query(ChatSession).filter(ChatSession.id == session_id).one().inline_cards_shown or {}


def _team_priced_bot(db, monkeypatch, session_id, *, chunks, **bot_kwargs):
    """A paid bot with live chat, no pricing page and knowledge-base pricing off: the production setup."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, **bot_kwargs)
    _make_session(db, bot, client, session_id)
    captured = _stub_pipeline(monkeypatch, retrieved=KB, support=True, chunks=chunks)
    _anonymous_visitor(monkeypatch)
    return bot, captured


@pytest.mark.parametrize(
    ("question", "chunks"),
    [
        (REPORTER, ("Thanks for reaching out. Our press team can arrange a comment from leadership.",)),
        (SHARE_PRICE, ("Acme is a privately held company and is not listed on any exchange.",)),
        ("whats the share price", ("Acme is privately held.",)),
    ],
    ids=["reporter_quote", "share_price", "bare_share_price"],
)
@pytest.mark.asyncio
async def test_a_price_word_in_another_sense_is_answered_not_escalated(
    db, monkeypatch, classifier, metrics, question, chunks
):
    session_id = f"intent-other-sense-{len(question)}"
    classifier.answers[question] = "NO"
    bot, captured = _team_priced_bot(db, monkeypatch, session_id, chunks=chunks)

    frames = await _drive_stream(bot, question, session_id)

    answer = "".join(chunks)
    assert _answer_text(frames) == answer
    assert "best confirmed by the team" not in _answer_text(frames)
    assert classifier.calls == [question]
    assert len(captured["prompts"]) == 1
    assert _named(metrics, "pricing_gate_escalation") == []
    assert [m.content for m in _messages(db, session_id, role="bot")] == [answer]
    assert "pricing_escalated" not in _cards(db, session_id)


@pytest.mark.parametrize("label", ["PRICE", "MIXED"])
@pytest.mark.parametrize(
    ("question", "chunks"),
    [
        ("what plans do you have", ("We offer Starter, Growth and Enterprise plans.",)),
        ("what is the interest rate on a home loan", ("Home loan interest rates are listed on our loans page.",)),
    ],
    ids=["saas_plans", "bank_interest_rate"],
)
@pytest.mark.asyncio
async def test_the_classifier_never_escalates_a_question_the_wording_rule_answered(
    db, monkeypatch, classifier, metrics, label, question, chunks
):
    """The classifier counts plans, packages and rates as price questions. Before
    it these were answered from the knowledge base, and they still are."""
    session_id = f"intent-no-widening-{label}-{len(question)}"
    classifier.answers[question] = label
    bot, captured = _team_priced_bot(db, monkeypatch, session_id, chunks=chunks)

    frames = await _drive_stream(bot, question, session_id)

    answer = "".join(chunks)
    assert classifier.calls == [question]
    assert _answer_text(frames) == answer
    assert len(captured["prompts"]) == 1
    assert _named(metrics, "pricing_gate_escalation") == []
    assert _named(metrics, "pricing_gate_deferred") == []
    assert [m.content for m in _messages(db, session_id, role="bot")] == [answer]
    assert "pricing_escalated" not in _cards(db, session_id)


@pytest.mark.asyncio
async def test_a_figure_for_a_plan_question_trips_the_guard_during_a_classifier_timeout(
    db, monkeypatch, classifier, metrics
):
    """The fallback rules do not read plan words as a price question; the price
    guard always did, so a timeout must not let a figure through."""
    monkeypatch.setattr(rs, "_PRICE_INTENT_TIMEOUT_S", 0.05)
    classifier.delay_s = 0.5
    chunks = ("Growth comes to ", "₹2,66,250", " a month for small teams.")
    bot, _ = _team_priced_bot(db, monkeypatch, "intent-plans-timeout", chunks=chunks)

    frames = await _drive_stream(bot, "what plans do you have", "intent-plans-timeout")

    assert "2,66,250" not in _answer_text(frames)
    assert [tags["reason"] for tags in _named(metrics, "pricing_gate_escalation")] == ["price_guard"]


@pytest.mark.asyncio
async def test_a_plan_follow_up_is_escalated_on_a_rewrite_the_wording_rule_reads(db, monkeypatch, classifier):
    """The raw words ask about a plan and pass only the classifier; the rewrite
    names the price, as the gate always read it."""
    question, rewritten = "what plans do you have", "what is the price of your enterprise plan"
    bot, _ = _team_priced_bot(db, monkeypatch, "intent-plan-follow-up", chunks=("unused",))

    async def fake_resolve(session_id, question, history, bid, cid, company_name, embedding_profile=None):
        return rewritten, None

    monkeypatch.setattr(rs, "_resolve_search_query_and_embedding", fake_resolve)

    frames = await _drive_stream(bot, question, "intent-plan-follow-up")

    assert classifier.calls == [question, rewritten]
    assert _answer_text(frames) == GENERIC


@pytest.mark.asyncio
async def test_when_the_model_fails_the_rules_still_answer_the_reporter(db, monkeypatch, classifier, metrics):
    classifier.error = RuntimeError("provider down")
    chunks = ("Our press team can arrange a comment from leadership.",)
    bot, _ = _team_priced_bot(db, monkeypatch, "intent-reporter-fallback", chunks=chunks)

    frames = await _drive_stream(bot, REPORTER, "intent-reporter-fallback")

    assert _answer_text(frames) == "".join(chunks)
    assert _named(metrics, "pricing_gate_escalation") == []


@pytest.mark.asyncio
async def test_a_price_question_is_escalated_without_an_arbitrary_word_in_the_reply(db, monkeypatch, classifier):
    """ "Pricing for **Per-User** at **Eventus Security**": the knowledge base
    capitalised "Per-User", and the question said "per user"."""
    bot, captured = _team_priced_bot(db, monkeypatch, "intent-pricing-model", chunks=("unused",))

    frames = await _drive_stream(bot, PRICING_MODEL, "intent-pricing-model")

    assert _answer_text(frames) == GENERIC
    assert captured["prompts"] == []
    assert _final_meta(frames)["suggest_handoff"] is True
    assert [m.content for m in _messages(db, "intent-pricing-model", role="bot")] == [GENERIC]


@pytest.mark.asyncio
async def test_a_configured_service_the_visitor_names_is_in_the_reply(db, monkeypatch, classifier):
    bot, _ = _team_priced_bot(
        db,
        monkeypatch,
        "intent-configured-service",
        chunks=("unused",),
        services=[{"name": "SOC as a Service", "url": None}, "Red Teaming"],
    )

    frames = await _drive_stream(bot, "what is the pricing for soc as a service?", "intent-configured-service")

    assert _answer_text(frames) == (
        "Pricing for **SOC as a Service** at **Acme** is best confirmed by the team so you get an accurate figure. "
        "Want me to connect you with them now?"
    )


@pytest.mark.asyncio
async def test_a_message_without_a_price_word_costs_no_classifier_call(db, monkeypatch, classifier):
    chunks = ("We operate across three regions.",)
    bot, _ = _team_priced_bot(db, monkeypatch, "intent-no-price-word", chunks=chunks)

    frames = await _drive_stream(bot, "where do you operate", "intent-no-price-word")

    assert _answer_text(frames) == "".join(chunks)
    assert classifier.calls == []


class TestAPriceQuestionThatAsksMore:
    QUESTION = "what's your pricing for SOC? also, do you have an office in Mumbai?"

    @pytest.mark.asyncio
    async def test_the_other_part_is_answered_instead_of_short_circuited(self, db, monkeypatch, classifier, metrics):
        classifier.answers[self.QUESTION] = "MIXED"
        chunks = ("Yes, we have an office in Mumbai. ", "For SOC pricing, our team can help.")
        bot, captured = _team_priced_bot(db, monkeypatch, "intent-mixed", chunks=chunks)

        frames = await _drive_stream(bot, self.QUESTION, "intent-mixed")

        assert _answer_text(frames) == "".join(chunks)
        assert len(captured["prompts"]) == 1
        assert len(_named(metrics, "pricing_gate_deferred")) == 1
        assert _named(metrics, "pricing_gate_escalation") == []

    @pytest.mark.asyncio
    async def test_any_figure_in_the_answer_is_replaced_by_the_escalation(self, db, monkeypatch, classifier, metrics):
        """The turn asks the price, so the guard trips even on a figure whose own
        sentence names no price."""
        classifier.answers[self.QUESTION] = "MIXED"
        chunks = ("Yes, we have an office in Mumbai. SOC comes to ", "₹2,66,250", " a month for small teams.")
        bot, _ = _team_priced_bot(db, monkeypatch, "intent-mixed-figure", chunks=chunks)

        frames = await _drive_stream(bot, self.QUESTION, "intent-mixed-figure")

        expected = pricing_pivot(
            company_name="Acme", pricing_url=None, support_enabled=True, live_chat_enabled=True
        ).text
        assert "2,66,250" not in _answer_text(frames)
        assert _answer_text(frames) == f"Yes, we have an office in Mumbai. SOC comes to \n\n{expected}"
        assert _messages(db, "intent-mixed-figure", role="bot")[-1].content == expected
        assert [tags["reason"] for tags in _named(metrics, "pricing_gate_escalation")] == ["price_guard"]

    @pytest.mark.asyncio
    async def test_a_bot_with_an_unpriced_pricing_page_is_guarded_too(self, db, monkeypatch, classifier):
        classifier.answers[self.QUESTION] = "MIXED"
        chunks = ("SOC comes to ", "₹2,66,250", " a month.")
        bot, _ = _team_priced_bot(
            db, monkeypatch, "intent-mixed-page", chunks=chunks, pricing_url="https://acme.com/pricing"
        )

        frames = await _drive_stream(bot, self.QUESTION, "intent-mixed-page")

        assert "2,66,250" not in _answer_text(frames)


@pytest.mark.asyncio
async def test_a_follow_up_is_decided_on_its_rewrite(db, monkeypatch, classifier):
    """ "and that one?" carries no price word; its rewrite does, and escalates."""
    rewritten = "what is the pricing of SOC as a Service"
    bot, _ = _team_priced_bot(db, monkeypatch, "intent-follow-up", chunks=("unused",))

    async def fake_resolve(session_id, question, history, bid, cid, company_name, embedding_profile=None):
        return rewritten, None

    monkeypatch.setattr(rs, "_resolve_search_query_and_embedding", fake_resolve)

    frames = await _drive_stream(bot, "and that one?", "intent-follow-up")

    assert classifier.calls == [rewritten]
    assert _answer_text(frames) == GENERIC


@pytest.mark.asyncio
async def test_the_bounded_check_uses_the_fallback_rules_on_a_timeout(monkeypatch, classifier):
    monkeypatch.setattr(rs, "_PRICE_INTENT_TIMEOUT_S", 0.05)
    classifier.default, classifier.delay_s = "PRICE", 0.5

    decision = await rs._detect_price_intent_bounded(REPORTER)

    assert decision == price_intent.PriceIntentDecision("no", by_fallback=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", ["PRICE", "MIXED", "NO"])
async def test_the_bounded_check_takes_the_classifier_answer_in_time(monkeypatch, classifier, answer):
    monkeypatch.setattr(rs, "_PRICE_INTENT_TIMEOUT_S", 1.0)
    classifier.default = answer

    decision = await rs._detect_price_intent_bounded(REPORTER)

    assert decision == price_intent.PriceIntentDecision(price_intent._LABELS[answer], by_fallback=False)


@pytest.mark.asyncio
async def test_the_bounded_check_survives_a_broken_decision(monkeypatch):
    def _broken(_question):
        raise RuntimeError("worker thread failed")

    monkeypatch.setattr(rs, "decide_price_intent", _broken)

    decision = await rs._detect_price_intent_bounded("what are your fees?")

    assert decision == price_intent.PriceIntentDecision("price", by_fallback=True)


@pytest.mark.asyncio
async def test_a_classifier_nobody_awaited_is_cancelled_when_the_visitor_leaves(db, monkeypatch, classifier):
    classifier.delay_s = 0.3
    bot, _ = _team_priced_bot(db, monkeypatch, "intent-cancelled", chunks=("unused",))
    started = asyncio.Event()
    real = rs._detect_price_intent_bounded
    tasks: list[asyncio.Task] = []

    async def spy(question):
        tasks.append(asyncio.current_task())
        started.set()
        return await real(question)

    monkeypatch.setattr(rs, "_detect_price_intent_bounded", spy)

    async def never_returning_resolve(*_a, **_k):
        await asyncio.sleep(3600)

    monkeypatch.setattr(rs, "_resolve_search_query_and_embedding", never_returning_resolve)

    consumer = asyncio.create_task(_drive_stream(bot, PRICING_MODEL, "intent-cancelled"))
    await asyncio.wait_for(started.wait(), timeout=10)
    consumer.cancel()
    with pytest.raises(asyncio.CancelledError):
        await consumer
    await asyncio.wait(tasks, timeout=5)

    assert len(tasks) == 1
    assert tasks[0].cancelled()
