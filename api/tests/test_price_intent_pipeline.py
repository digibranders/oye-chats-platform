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
from app.services.price_intent import NOT_A_PRICE_QUESTION, PriceClassifierUnavailableError, PriceIntentDecision
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
#: Production, 2026-09-28, case z-g05 on CleanStart: the model said NO on these
#: words, the classifier call on the rewrite (these words plus the company name)
#: returned an empty output, and the fallback rules escalated.
AUDIT_FEE = "roughly how much does a soc 2 audit cost a company, from the auditor side?"
AUDIT_FEE_ANSWER = ("Auditor fees for a SOC 2 report typically run from $15,000 to $50,000.",)
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
        #: The phrasings the model produces no answer for.
        self.errors: dict[str, Exception] = {}
        self.delay_s = 0.0
        self.calls: list[str] = []

    def __call__(self, question: str, timeout_s: float | None = None) -> str:
        self.calls.append(question)
        if self.delay_s:
            time.sleep(self.delay_s)
        if self.error is not None:
            raise self.error
        if question in self.errors:
            raise self.errors[question]
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
    async def test_a_sentence_with_any_figure_is_dropped_and_the_escalation_follows(
        self, db, monkeypatch, classifier, metrics
    ):
        """The turn asks the price, so a figure whose own sentence names no price
        still goes. The rest of the answer stays (evaluation, 2026-09-17)."""
        classifier.answers[self.QUESTION] = "MIXED"
        chunks = ("Yes, we have an office in Mumbai. SOC comes to ", "₹2,66,250", " a month for small teams.")
        bot, _ = _team_priced_bot(db, monkeypatch, "intent-mixed-figure", chunks=chunks)

        frames = await _drive_stream(bot, self.QUESTION, "intent-mixed-figure")

        expected = pricing_pivot(
            company_name="Acme", pricing_url=None, support_enabled=True, live_chat_enabled=True
        ).text
        assert "2,66,250" not in _answer_text(frames)
        assert _answer_text(frames) == f"Yes, we have an office in Mumbai. \n\n{expected}"
        assert _messages(db, "intent-mixed-figure", role="bot")[-1].content == (
            f"Yes, we have an office in Mumbai.\n\n{expected}"
        )
        assert [tags["reason"] for tags in _named(metrics, "pricing_gate_escalation")] == ["price_guard_redacted"]

    @pytest.mark.asyncio
    async def test_a_bot_with_an_unpriced_pricing_page_is_guarded_too(self, db, monkeypatch, classifier):
        classifier.answers[self.QUESTION] = "MIXED"
        chunks = ("SOC comes to ", "₹2,66,250", " a month.")
        bot, _ = _team_priced_bot(
            db, monkeypatch, "intent-mixed-page", chunks=chunks, pricing_url="https://acme.com/pricing"
        )

        frames = await _drive_stream(bot, self.QUESTION, "intent-mixed-page")

        assert "2,66,250" not in _answer_text(frames)


def _rewritten_to(monkeypatch, rewritten):
    """Retrieval hands the gate ``rewritten`` as the turn's search query."""

    async def fake_resolve(session_id, question, history, bid, cid, company_name, embedding_profile=None):
        return rewritten, None

    monkeypatch.setattr(rs, "_resolve_search_query_and_embedding", fake_resolve)


@pytest.mark.asyncio
async def test_the_auditor_fee_question_is_answered_when_the_rewrite_call_fails(db, monkeypatch, classifier, metrics):
    """Production, 2026-09-28: the model said NO on the visitor's words, the call on
    the rewrite (the words plus the company name) returned nothing, and the
    fallback rules escalated. The rewrite adds no price word, so it is not
    decided again, and the answer the same case gave twice that day is given."""
    rewritten = f"{AUDIT_FEE} Acme"
    classifier.answers[AUDIT_FEE] = "NO"
    classifier.errors[rewritten] = PriceClassifierUnavailableError("empty output")
    bot, captured = _team_priced_bot(db, monkeypatch, "intent-audit-fee", chunks=AUDIT_FEE_ANSWER)
    _rewritten_to(monkeypatch, rewritten)

    frames = await _drive_stream(bot, AUDIT_FEE, "intent-audit-fee")

    assert classifier.calls == [AUDIT_FEE]
    assert _answer_text(frames) == "".join(AUDIT_FEE_ANSWER)
    assert len(captured["prompts"]) == 1
    assert _named(metrics, "pricing_gate_escalation") == []
    assert "pricing_escalated" not in _cards(db, "intent-audit-fee")


@pytest.mark.asyncio
async def test_a_fallback_on_a_true_rewrite_never_overrides_the_models_no(db, monkeypatch, classifier, metrics):
    """The rewrite rephrases the question, so it is decided again; the model
    produces nothing for it twice, and the fallback rules read a price question.
    The model's NO on the visitor's own words stands."""
    rewritten = "what does a SOC 2 audit cost from the auditor side"
    classifier.answers[AUDIT_FEE] = "NO"
    classifier.errors[rewritten] = PriceClassifierUnavailableError("empty output")
    bot, captured = _team_priced_bot(db, monkeypatch, "intent-audit-fee-rewrite", chunks=AUDIT_FEE_ANSWER)
    _rewritten_to(monkeypatch, rewritten)

    frames = await _drive_stream(bot, AUDIT_FEE, "intent-audit-fee-rewrite")

    assert classifier.calls == [AUDIT_FEE, rewritten, rewritten]
    assert _answer_text(frames) == "".join(AUDIT_FEE_ANSWER)
    assert len(captured["prompts"]) == 1
    assert _named(metrics, "pricing_gate_escalation") == []


@pytest.mark.asyncio
async def test_a_rewrite_the_model_reads_as_pricing_still_escalates(db, monkeypatch, classifier):
    """The re-decision keeps its purpose: the model says NO on the visitor's vague
    words and PRICE on the rewrite that spells out what they ask."""
    question, rewritten = "what about the cost side of it?", "what is the price of SOC as a Service"
    classifier.answers[question] = "NO"
    classifier.answers[rewritten] = "PRICE"
    bot, _ = _team_priced_bot(db, monkeypatch, "intent-vague-follow-up", chunks=("unused",))
    _rewritten_to(monkeypatch, rewritten)

    frames = await _drive_stream(bot, question, "intent-vague-follow-up")

    assert classifier.calls == [question, rewritten]
    assert _answer_text(frames) == GENERIC


class TestTheTurnDecision:
    """``_turn_price_intent`` on its own: which phrasing is decided, and which decision wins."""

    MODEL_NO = PriceIntentDecision("no", by_fallback=False)
    RULES_NO = PriceIntentDecision("no", by_fallback=True)
    MODEL_PRICE = PriceIntentDecision("price", by_fallback=False)
    RULES_PRICE = PriceIntentDecision("price", by_fallback=True)
    REWRITTEN = "what does a SOC 2 audit cost from the auditor side"

    @pytest.fixture()
    def second(self, monkeypatch):
        """The bounded decision on the rewrite: records the phrasings it is asked about."""
        state = {"decision": self.MODEL_NO, "calls": []}

        async def fake(question):
            state["calls"].append(question)
            return state["decision"]

        monkeypatch.setattr(rs, "_detect_price_intent_bounded", fake)
        return state

    @staticmethod
    async def _raw(decision):
        async def done():
            return decision

        return asyncio.create_task(done())

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "rewritten", [AUDIT_FEE, f"{AUDIT_FEE} Acme", f"  {AUDIT_FEE.upper()}  acme "], ids=["same", "name", "case"]
    )
    async def test_a_rewrite_that_only_adds_the_company_name_is_not_decided_again(self, second, rewritten):
        second["decision"] = self.RULES_PRICE

        result = await rs._turn_price_intent(AUDIT_FEE, rewritten, await self._raw(self.MODEL_NO))

        assert result == (self.MODEL_NO, AUDIT_FEE)
        assert second["calls"] == []

    @pytest.mark.asyncio
    async def test_a_fallback_on_the_rewrite_never_overrides_the_model(self, second):
        second["decision"] = self.RULES_PRICE

        result = await rs._turn_price_intent(AUDIT_FEE, self.REWRITTEN, await self._raw(self.MODEL_NO))

        assert result == (self.MODEL_NO, AUDIT_FEE)
        assert second["calls"] == [self.REWRITTEN]

    @pytest.mark.asyncio
    async def test_a_fallback_on_the_rewrite_refines_a_fallback(self, second):
        second["decision"] = self.RULES_PRICE

        result = await rs._turn_price_intent(AUDIT_FEE, self.REWRITTEN, await self._raw(self.RULES_NO))

        assert result == (self.RULES_PRICE, self.REWRITTEN)

    @pytest.mark.asyncio
    async def test_a_fallback_on_the_rewrite_decides_when_the_raw_words_were_never_decided(self, second):
        """ "and that one?" carries no price word: the rewrite is the only decision."""
        second["decision"] = self.RULES_PRICE

        result = await rs._turn_price_intent("and that one?", self.REWRITTEN, None)

        assert result == (self.RULES_PRICE, self.REWRITTEN)
        assert second["calls"] == [self.REWRITTEN]

    @pytest.mark.asyncio
    async def test_the_model_on_the_rewrite_overrides_the_model_on_the_raw_words(self, second):
        second["decision"] = self.MODEL_PRICE

        result = await rs._turn_price_intent(AUDIT_FEE, self.REWRITTEN, await self._raw(self.MODEL_NO))

        assert result == (self.MODEL_PRICE, self.REWRITTEN)

    @pytest.mark.asyncio
    async def test_a_no_on_the_rewrite_keeps_the_raw_decision(self, second):
        second["decision"] = self.MODEL_NO

        result = await rs._turn_price_intent(AUDIT_FEE, self.REWRITTEN, await self._raw(self.MODEL_NO))

        assert result == (self.MODEL_NO, AUDIT_FEE)

    @pytest.mark.asyncio
    async def test_raw_words_the_gate_escalates_are_not_decided_again(self, second):
        result = await rs._turn_price_intent(PRICING_MODEL, self.REWRITTEN, await self._raw(self.MODEL_PRICE))

        assert result == (self.MODEL_PRICE, PRICING_MODEL)
        assert second["calls"] == []

    @pytest.mark.asyncio
    async def test_a_turn_with_no_price_word_anywhere_costs_nothing(self, second):
        result = await rs._turn_price_intent("and that one?", "where is the Acme office", None)

        assert result == (NOT_A_PRICE_QUESTION, "and that one?")
        assert second["calls"] == []


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
async def test_the_bounded_check_hands_the_retry_its_deadline(monkeypatch):
    """The retry inside ``decide_price_intent`` must fit the same ceiling the
    stream awaits, so the budget it is given is that ceiling."""
    monkeypatch.setattr(rs, "_PRICE_INTENT_TIMEOUT_S", 2.5)
    seen: list[dict] = []

    def fake_decide(question, **kwargs):
        seen.append(kwargs)
        return price_intent.NOT_A_PRICE_QUESTION

    monkeypatch.setattr(rs, "decide_price_intent", fake_decide)

    await rs._detect_price_intent_bounded(REPORTER)

    assert seen == [{"budget_s": 2.5}]


@pytest.mark.asyncio
async def test_the_bounded_check_survives_a_broken_decision(monkeypatch):
    def _broken(_question, **_kwargs):
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
