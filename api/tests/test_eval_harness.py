"""Unit tests for the answer-quality eval harness (``api/eval``). No network.

Covers the parts a broken harness would otherwise hide behind a green nightly
run: the judge's verdict parsing (valid, malformed, out of range), the pass
rule and aggregation math, the golden file's validation and coverage
minimums, the conversation loop against a fake ``/chat`` (name gate, 429
back-off, offline bot, unreachable API), the report, and the CLI's
``--dry-run`` / usage paths. The judge is exercised with ``litellm.completion``
mocked, so the family-specific kwargs it sends are pinned without a key.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, date, datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from eval import run_eval
from eval.golden import (
    CATEGORIES,
    DEFAULT_FIXTURE_DIR,
    DEFAULT_GOLDEN_PATH,
    GoldenCase,
    GoldenSetError,
    coverage_shortfalls,
    load_golden_set,
    plan_summary,
)
from eval.judge import (
    GROUNDED_PASS_THRESHOLD,
    CaseResult,
    JudgeParseError,
    JudgeVerdict,
    aggregate,
    assert_verdict,
    build_judge_messages,
    case_passed,
    fact_coverage,
    judge_answer,
    meets_threshold,
    normalise_verdict,
    parse_verdict,
)
from eval.report import build_report, render_markdown, write_reports
from eval.run_eval import ChatClient, ChatReply, converse, is_name_request, run_cases, select_cases

NAME_ASK = "Hi there! Before I help you out, may I know your name so I can address you properly?"


def _case(**overrides) -> GoldenCase:
    base = {
        "id": "pricing-01",
        "category": "pricing",
        "question": "How much is the Growth plan per month in India?",
        "expected_facts": ["The Growth plan costs ₹74,999 per month in India", "Prices exclude 18% GST"],
        "forbidden_claims": ["Any other INR price"],
    }
    base.update(overrides)
    return GoldenCase.model_validate(base)


def _verdict(**overrides) -> JudgeVerdict:
    base = {"grounded": 1.0, "refusal_correct": True, "facts_covered": [], "fabricated": [], "notes": "ok"}
    base.update(overrides)
    return JudgeVerdict(**base)


def _raw(**overrides) -> str:
    base = {"grounded": 0.9, "refusal_correct": True, "facts_covered": [], "fabricated": [], "notes": "fine"}
    base.update(overrides)
    return json.dumps(base)


def _result(case_id: str, category: str, *, passed: bool, grounded: float | None = None, error: str | None = None):
    result = CaseResult(case_id=case_id, category=category, question="q")
    if grounded is not None:
        result.verdict = _verdict(grounded=grounded, refusal_correct=passed or grounded >= GROUNDED_PASS_THRESHOLD)
    result.error = error
    result.passed = passed
    return result


# ── Judge: parsing ───────────────────────────────────────────────────────────


class TestParseVerdict:
    def test_valid_json_parses(self):
        verdict = parse_verdict(_raw(grounded=0.85, facts_covered=["a"], fabricated=["b"]))
        assert verdict.grounded == pytest.approx(0.85)
        assert verdict.refusal_correct is True
        assert verdict.facts_covered == ["a"]
        assert verdict.fabricated == ["b"]
        assert verdict.notes == "fine"

    def test_code_fence_is_tolerated(self):
        assert parse_verdict(f"```json\n{_raw()}\n```").grounded == pytest.approx(0.9)

    @pytest.mark.parametrize("raw", ["", "   ", "not json", "{'grounded': 1}", '{"grounded": 0.5'])
    def test_malformed_is_rejected(self, raw):
        with pytest.raises(JudgeParseError):
            parse_verdict(raw)

    @pytest.mark.parametrize("grounded", [1.5, -0.1, 2, -1])
    def test_out_of_range_grounded_is_rejected(self, grounded):
        with pytest.raises(JudgeParseError, match="grounded"):
            parse_verdict(_raw(grounded=grounded))

    def test_boundaries_are_accepted(self):
        assert parse_verdict(_raw(grounded=0)).grounded == 0.0
        assert parse_verdict(_raw(grounded=1)).grounded == 1.0

    def test_missing_field_is_rejected(self):
        payload = json.loads(_raw())
        del payload["refusal_correct"]
        with pytest.raises(JudgeParseError, match="refusal_correct"):
            parse_verdict(json.dumps(payload))

    def test_wrong_type_is_rejected(self):
        with pytest.raises(JudgeParseError):
            parse_verdict(_raw(refusal_correct="yes please"))

    def test_unknown_key_is_rejected(self):
        payload = json.loads(_raw())
        payload["confidence"] = 0.4
        with pytest.raises(JudgeParseError, match="confidence"):
            parse_verdict(json.dumps(payload))

    def test_schema_is_strict_mode_compatible(self):
        """OpenAI/Gemini strict structured output need every field required and no extras."""
        schema = JudgeVerdict.model_json_schema()
        assert schema["additionalProperties"] is False
        assert set(schema["required"]) == {"grounded", "refusal_correct", "facts_covered", "fabricated", "notes"}


class TestNormaliseAndPassRule:
    def test_facts_covered_keeps_only_expected_facts_in_case_order(self):
        case = _case()
        verdict = _verdict(
            facts_covered=[
                "prices exclude 18% gst",
                "The Growth plan is cheap",
                "  the growth plan costs ₹74,999 per month in india ",
            ]
        )
        normalised = normalise_verdict(verdict, case)
        assert normalised.facts_covered == case.expected_facts
        assert fact_coverage(normalised, case) == pytest.approx(1.0)

    def test_coverage_is_none_without_expected_facts(self):
        case = _case(
            category="offtopic",
            question="Capital of France?",
            expected_facts=[],
            forbidden_claims=["Paris"],
            must_refuse=True,
        )
        assert fact_coverage(_verdict(), case) is None

    def test_pass_rule(self):
        assert case_passed(_verdict(grounded=0.7)) is True  # boundary is inclusive
        assert case_passed(_verdict(grounded=0.69)) is False
        assert case_passed(_verdict(grounded=1.0, refusal_correct=False)) is False
        assert case_passed(_verdict(grounded=0.5), threshold=0.5) is True


# ── Judge: the LLM call (mocked) ─────────────────────────────────────────────


def _completion(raw: str):
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content=raw))]
    return response


class TestJudgeAnswer:
    @pytest.mark.parametrize(
        ("model", "reasoning_effort"),
        [("gemini/gemini-2.5-flash", "disable"), ("openai/gpt-5.4-mini", "none"), ("openai/gpt-5-mini", "minimal")],
    )
    def test_sends_strict_schema_with_reasoning_disabled(self, model, reasoning_effort):
        case = _case()
        with patch(
            "litellm.completion", return_value=_completion(_raw(facts_covered=[case.expected_facts[0]]))
        ) as completion:
            verdict = judge_answer(case, "₹74,999 per month.", model=model, reference_text="ref")

        kwargs = completion.call_args.kwargs
        assert kwargs["model"] == model
        assert kwargs["timeout"] == 20.0
        assert kwargs["reasoning_effort"] == reasoning_effort
        assert kwargs["response_format"]["type"] == "json_schema"
        assert kwargs["response_format"]["json_schema"]["strict"] is True
        assert kwargs["response_format"]["json_schema"]["schema"] == JudgeVerdict.model_json_schema()
        assert [m["role"] for m in kwargs["messages"]] == ["system", "user"]
        assert "REFERENCE MATERIAL" in kwargs["messages"][1]["content"]
        assert verdict.facts_covered == [case.expected_facts[0]]

    def test_retries_once_then_succeeds(self):
        case = _case()
        with (
            patch("litellm.completion", side_effect=[RuntimeError("blip"), _completion(_raw())]) as completion,
            patch("eval.judge.time.sleep") as sleep,
        ):
            verdict = judge_answer(case, "answer")
        assert verdict.grounded == pytest.approx(0.9)
        assert completion.call_count == 2
        sleep.assert_called_once()

    def test_raises_after_retries_exhausted(self):
        with (
            patch("litellm.completion", side_effect=RuntimeError("down")),
            patch("eval.judge.time.sleep"),
            pytest.raises(RuntimeError, match="down"),
        ):
            judge_answer(_case(), "answer")

    def test_empty_completion_is_a_parse_error(self):
        with (
            patch("litellm.completion", return_value=_completion("")),
            patch("eval.judge.time.sleep"),
            pytest.raises(JudgeParseError, match="empty"),
        ):
            judge_answer(_case(), "answer")

    def test_prompt_carries_the_case(self):
        case = _case(
            history=["Tell me about the Growth plan."], question="And how much does it cost?", category="followup"
        )
        system, user = build_judge_messages(case, "It costs ₹74,999.")
        assert "REQUIRES A REFUSAL: no" in user["content"]
        assert "Visitor: Tell me about the Growth plan." in user["content"]
        assert "The Growth plan costs ₹74,999 per month in India" in user["content"]
        assert "Any other INR price" in user["content"]
        assert "REFERENCE MATERIAL" not in user["content"]
        assert "grounded" in system["content"] and "refusal_correct" in system["content"]


# ── Aggregation ──────────────────────────────────────────────────────────────


class TestAggregate:
    def _results(self):
        return [
            _result("pricing-01", "pricing", passed=True, grounded=1.0),
            _result("pricing-02", "pricing", passed=True, grounded=0.8),
            _result("pricing-03", "pricing", passed=False, grounded=0.3),
            _result("offtopic-01", "offtopic", passed=True, grounded=1.0),
            _result("offtopic-02", "offtopic", passed=False, error="chat: bot is offline"),
            _result("greeting-01", "greeting", passed=True, grounded=0.9),
        ]

    def test_overall_and_per_category_math(self):
        summary = aggregate(self._results())
        assert (summary.total, summary.passed, summary.failed, summary.errors) == (6, 4, 2, 1)
        assert summary.pass_rate == pytest.approx(4 / 6)
        assert summary.mean_grounded == pytest.approx((1.0 + 0.8 + 0.3 + 1.0 + 0.9) / 5)  # errored case has no verdict

        by_name = {c.category: c for c in summary.categories}
        assert [c.category for c in summary.categories] == ["greeting", "pricing", "offtopic"]  # CATEGORIES order
        assert (by_name["pricing"].total, by_name["pricing"].passed, by_name["pricing"].errors) == (3, 2, 0)
        assert by_name["pricing"].pass_rate == pytest.approx(2 / 3)
        assert by_name["pricing"].mean_grounded == pytest.approx(0.7)
        assert (by_name["offtopic"].total, by_name["offtopic"].passed, by_name["offtopic"].errors) == (2, 1, 1)
        assert by_name["offtopic"].mean_grounded == pytest.approx(1.0)

    def test_errors_count_as_failures_in_the_pass_rate(self):
        summary = aggregate([_result("a-1", "team", passed=False, error="judge: timeout")] * 2)
        assert summary.pass_rate == 0.0
        assert summary.mean_grounded is None

    def test_threshold(self):
        four_of_five = aggregate([_result(f"p-{i}", "pricing", passed=i < 4, grounded=1.0) for i in range(5)])
        assert four_of_five.pass_rate == pytest.approx(0.8)
        assert meets_threshold(four_of_five, 0.8) is True
        assert meets_threshold(four_of_five, 0.81) is False
        assert meets_threshold(aggregate([]), 0.0) is False  # an empty run never passes

    def test_serialisable(self):
        summary = aggregate(self._results())
        json.dumps(summary.to_dict())
        json.dumps([r.to_dict() for r in self._results()])


# ── Golden set ───────────────────────────────────────────────────────────────


def _numbers(text: str) -> list[str]:
    """Numeric anchors of a fact: prices, percentages, years, times, counts."""
    return re.findall(r"\d[\d,.:]*\d|\d", text)


class TestShippedGoldenSet:
    @pytest.fixture(scope="class")
    def cases(self):
        return load_golden_set(DEFAULT_GOLDEN_PATH)

    @pytest.fixture(scope="class")
    def fixture_text(self):
        files = sorted(DEFAULT_FIXTURE_DIR.glob("*.md"))
        assert 4 <= len(files) <= 6, "the fixture KB should be 4-6 markdown documents"
        return "\n".join(p.read_text(encoding="utf-8") for p in files)

    def test_size_ids_and_categories(self, cases):
        assert len(cases) >= 30
        assert len({c.id for c in cases}) == len(cases)
        assert {c.category for c in cases} <= set(CATEGORIES)
        assert all(c.id.startswith(c.category) for c in cases), "convention: id = <category>-<nn>"

    def test_meets_the_coverage_minimums(self, cases):
        assert coverage_shortfalls(cases) == []
        assert sum(1 for c in cases if c.category == "offtopic" and c.must_refuse) >= 4
        assert sum(1 for c in cases if c.category == "adversarial" and c.must_refuse) >= 3
        assert sum(1 for c in cases if c.category == "followup" and c.history) >= 2
        assert sum(1 for c in cases if c.category == "events") >= 2
        assert sum(1 for c in cases if c.category == "pricing") >= 3
        assert sum(1 for c in cases if c.category == "events" and "coming up" in c.question) >= 1
        assert sum(1 for c in cases if c.category == "company" and not c.must_refuse) >= 4

    def test_company_cases_guard_against_refusal(self, cases):
        """The September 2026 regression: the gate refused "what does Acme do".
        Every company case must be answerable and must name the refusal as a
        forbidden claim, so a polite decline can never pass on groundedness."""
        company = [c for c in cases if c.category == "company"]
        assert len(company) >= 4
        for case in company:
            assert not case.must_refuse, case.id
            assert case.expected_facts, case.id
            assert any("refuse" in claim.lower() for claim in case.forbidden_claims), case.id
        questions = " ".join(c.question.lower() for c in company)
        assert "what does acme do" in questions
        assert "what is acme analytics" in questions
        assert "your company" in questions

    def test_refusal_cases_have_forbidden_claims_and_no_facts(self, cases):
        for case in (c for c in cases if c.must_refuse):
            assert case.expected_facts == [], case.id
            assert case.forbidden_claims, case.id

    def test_expected_fact_numbers_exist_in_the_fixture(self, cases, fixture_text):
        """A fact the fixture cannot support would make the judge fail a correct bot."""
        missing = [
            (case.id, number)
            for case in cases
            if case.category not in ("greeting", "trust")
            for fact in case.expected_facts
            for number in _numbers(fact)
            if number not in fixture_text
        ]
        assert missing == []

    def test_plan_summary(self, cases):
        plan = plan_summary(cases)
        assert plan["cases"] == len(cases)
        assert plan["requests"] == sum(len(c.history) + 1 for c in cases)
        assert plan["with_history"] == sum(1 for c in cases if c.history)
        assert plan["coverage_shortfalls"] == []

    def test_upcoming_events_are_still_in_the_future(self, cases):
        """When this fails the fixture has gone stale: move its future events
        forward and update the ``events`` cases. Do not delete the test; a
        stale set silently stops testing the PAST/UPCOMING date reasoning."""
        upcoming = next(c for c in cases if c.id == "events-01")
        expected_dates = [_parse_day(m) for fact in upcoming.expected_facts for m in _DATE_RE.findall(fact)]
        forbidden_dates = [_parse_day(m) for claim in upcoming.forbidden_claims for m in _DATE_RE.findall(claim)]
        assert expected_dates and forbidden_dates
        today = date.today()
        assert all(d > today for d in expected_dates), f"stale upcoming events: {expected_dates}"
        assert all(d < today for d in forbidden_dates), f"forbidden 'upcoming' claims are not past: {forbidden_dates}"


_DATE_RE = re.compile(
    r"(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})"
)


def _parse_day(match: tuple[str, str, str]) -> date:
    return datetime.strptime(" ".join(match), "%d %B %Y").date()


class TestGoldenValidation:
    def _write(self, tmp_path: Path, lines: list[str]) -> Path:
        path = tmp_path / "golden.jsonl"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

    def test_all_problems_are_reported_together(self, tmp_path):
        good = json.dumps({"id": "team-01", "category": "team", "question": "Who?", "expected_facts": ["Priya"]})
        path = self._write(
            tmp_path,
            [
                "{not json",
                json.dumps({"id": "x-1", "category": "weather", "question": "q", "expected_facts": ["f"]}),
                json.dumps(
                    {
                        "id": "offtopic-01",
                        "category": "offtopic",
                        "question": "q",
                        "must_refuse": True,
                        "expected_facts": ["f"],
                    }
                ),
                json.dumps({"id": "team-02", "category": "team", "question": "q"}),
                json.dumps({"id": "followup-01", "category": "followup", "question": "q", "expected_facts": ["f"]}),
                json.dumps({"id": "Bad Id", "category": "team", "question": "q", "expected_facts": ["f"]}),
                json.dumps({"id": "team-03", "category": "team", "question": "q", "expected_facts": ["f"], "extra": 1}),
                good,
                good,
            ],
        )
        with pytest.raises(GoldenSetError) as excinfo:
            load_golden_set(path)
        message = str(excinfo.value)
        assert "line 1: invalid JSON" in message
        assert "line 2" in message and "category" in message
        assert "line 3" in message and "must_refuse" in message
        assert "line 4" in message and "expected fact" in message
        assert "line 5" in message and "history" in message
        assert "line 6" in message and "id" in message
        assert "line 7" in message and "extra" in message
        assert "duplicate case id: 'team-01'" in message

    def test_blank_lines_are_skipped(self, tmp_path):
        path = self._write(
            tmp_path,
            [
                "",
                json.dumps({"id": "team-01", "category": "team", "question": "Who?", "expected_facts": ["Priya"]}),
                "   ",
            ],
        )
        assert [c.id for c in load_golden_set(path)] == ["team-01"]

    def test_empty_and_missing_files(self, tmp_path):
        with pytest.raises(GoldenSetError, match="no cases"):
            load_golden_set(self._write(tmp_path, [""]))
        with pytest.raises(GoldenSetError, match="not found"):
            load_golden_set(tmp_path / "nope.jsonl")

    def test_non_object_line_is_rejected(self, tmp_path):
        with pytest.raises(GoldenSetError, match="expected a JSON object"):
            load_golden_set(self._write(tmp_path, ["[1, 2]"]))

    def test_request_count_includes_history(self):
        assert _case(history=["a", "b"], category="followup").request_count == 3


# ── Conversation loop against a fake /chat ───────────────────────────────────


class FakeChatApi:
    """In-process ``POST /chat``: asks for a name on a session's first turn, then answers the deferred question."""

    def __init__(self, *, offline: bool = False, rate_limit_first: bool = False, generation_failed: bool = False):
        self.sessions: dict[str, list[str]] = {}
        self.offline = offline
        self.rate_limit_first = rate_limit_first
        self.generation_failed = generation_failed
        self.requests = 0

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests += 1
        assert request.headers["x-bot-key"] == "bot-test"
        assert request.url.path == "/chat"
        if self.rate_limit_first and self.requests == 1:
            return httpx.Response(429, headers={"Retry-After": "7"}, json={"detail": "slow down"})
        body = json.loads(request.content)
        if self.offline:
            return httpx.Response(
                200, json={"answer": "We're away.", "status": "service_unavailable", "reason": "subscription_expired"}
            )
        turns = self.sessions.setdefault(body["session_id"], [])
        turns.append(body["question"])
        if len(turns) == 1:
            return httpx.Response(
                200, json={"answer": NAME_ASK, "sources": [], "session_id": body["session_id"], "message_id": 1}
            )
        deferred = turns[0] if len(turns) == 2 else body["question"]
        payload = {
            "answer": f"Answer to: {deferred}",
            "sources": ["pricing.md"],
            "session_id": body["session_id"],
            "message_id": 2,
        }
        if self.generation_failed:
            payload["generation_failed"] = True
        return httpx.Response(200, json=payload)


def _client(api: FakeChatApi, **kwargs) -> ChatClient:
    return ChatClient(
        "https://api.example.test",
        "bot-test",
        pace_s=0,
        sleep=kwargs.pop("sleep", lambda _s: None),
        transport=api.transport(),
        **kwargs,
    )


def _perfect_judge(case: GoldenCase, answer: str) -> JudgeVerdict:
    return _verdict(facts_covered=list(case.expected_facts))


class TestConversation:
    def test_name_gate_is_answered_and_the_deferred_reply_is_judged(self):
        api = FakeChatApi()
        case = _case()
        with _client(api) as client:
            reply, triggered = converse(case, client.ask, visitor_name="Eva", name_flow=True)
        assert triggered is True
        assert reply.answer == f"Answer to: {case.question}"
        assert reply.sources == ["pricing.md"]
        (turns,) = api.sessions.values()
        assert turns == [case.question, "Eva"]

    def test_history_is_replayed_in_one_session_before_the_question(self):
        api = FakeChatApi()
        case = _case(
            category="followup", history=["Tell me about the Growth plan."], question="And how much does it cost?"
        )
        with _client(api) as client:
            reply, _ = converse(case, client.ask, visitor_name="Eva", name_flow=True)
        (turns,) = api.sessions.values()
        assert turns == ["Tell me about the Growth plan.", "Eva", "And how much does it cost?"]
        assert reply.answer == "Answer to: And how much does it cost?"

    def test_name_flow_can_be_disabled(self):
        api = FakeChatApi()
        with _client(api) as client:
            reply, triggered = converse(_case(), client.ask, visitor_name="Eva", name_flow=False)
        assert triggered is False
        assert reply.answer == NAME_ASK  # the runner did not intervene

    def test_rate_limit_is_retried_after_retry_after(self):
        api = FakeChatApi(rate_limit_first=True)
        waits: list[float] = []
        with _client(api, sleep=waits.append) as client:
            reply = client.ask("hi", "s1")
        assert reply.answer == NAME_ASK
        assert 7.0 in waits

    def test_offline_bot_is_an_error_not_an_answer(self):
        api = FakeChatApi(offline=True)
        with _client(api) as client:
            results = run_cases([_case()], client.ask, _perfect_judge, grounded_threshold=0.7)
        assert results[0].error.startswith("chat: bot is offline")
        assert results[0].passed is False

    def test_generation_failure_is_an_error(self):
        api = FakeChatApi(generation_failed=True)
        with _client(api) as client:
            results = run_cases([_case()], client.ask, _perfect_judge, grounded_threshold=0.7)
        assert results[0].error.startswith("generation_failed")
        assert results[0].answer.startswith("Answer to:")

    def test_judge_exception_is_recorded_on_the_case(self):
        api = FakeChatApi()

        def broken_judge(case, answer):
            raise TimeoutError("judge took too long")

        with _client(api) as client:
            results = run_cases([_case()], client.ask, broken_judge, grounded_threshold=0.7)
        assert results[0].error == "judge: TimeoutError: judge took too long"
        assert results[0].verdict is None

    def test_unreachable_api_aborts_after_three_transport_failures(self):
        def refuse(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=request)

        cases = [_case(id=f"pricing-0{i}") for i in range(1, 6)]
        seen: list[int] = []
        with ChatClient(
            "https://down.example.test",
            "bot-test",
            pace_s=0,
            sleep=lambda _s: None,
            transport=httpx.MockTransport(refuse),
        ) as client:
            results = run_cases(
                cases, client.ask, _perfect_judge, grounded_threshold=0.7, on_result=lambda i, n, r: seen.append(i)
            )
        assert [r.error.split(":")[0] for r in results] == ["chat", "chat", "chat", "skipped", "skipped"]
        assert all(r.transport_error for r in results)
        assert seen == [1, 2, 3, 4, 5]
        assert meets_threshold(aggregate(results), 0.8) is False

    def test_full_run_passes_and_records_metadata(self):
        api = FakeChatApi()
        cases = [_case(), _case(id="pricing-02", question="Starter in USD?", expected_facts=["$299"])]
        with _client(api) as client:
            results = run_cases(cases, client.ask, _perfect_judge, grounded_threshold=0.7)
        assert all(r.passed and r.name_flow_triggered and r.coverage == 1.0 for r in results)
        assert all(r.session_id and r.latency_s is not None for r in results)
        assert meets_threshold(aggregate(results), 0.8) is True

    def test_http_error_status_is_reported(self):
        def forbidden(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={"detail": "origin_not_allowed"})

        with ChatClient(
            "https://api.example.test", "bot-test", pace_s=0, transport=httpx.MockTransport(forbidden)
        ) as client:
            results = run_cases([_case()], client.ask, _perfect_judge, grounded_threshold=0.7)
        assert "HTTP 403" in results[0].error and "origin_not_allowed" in results[0].error
        assert results[0].transport_error is False

    def test_is_name_request(self):
        assert is_name_request(NAME_ASK)
        assert is_name_request("Hi! What name should I use to address you?")
        assert not is_name_request("The Growth plan costs ₹74,999 per month.")
        assert not is_name_request(None)


# ── Report ───────────────────────────────────────────────────────────────────


class TestReport:
    def _run(self):
        ok = _result("pricing-01", "pricing", passed=True, grounded=1.0)
        ok.answer = "₹74,999 per month."
        bad = _result("team-02", "team", passed=False, grounded=0.3)
        bad.question = "How big is your team?"
        bad.answer = "We are 25 people."
        bad.expected_facts = ["The team is 18 people"]
        bad.verdict = _verdict(grounded=0.3, fabricated=["25 people"], notes="Team size is wrong.")
        err = _result(
            "offtopic-01", "offtopic", passed=False, error="chat: bot is offline (reason='subscription_expired')"
        )
        results = [ok, bad, err]
        summary = aggregate(results)
        config = {
            "api_url": "https://api.example.test",
            "bot_key": "bot-6a42…",
            "judge_model": "gemini/gemini-2.5-flash",
            "grounded_threshold": 0.7,
            "golden_path": "golden.jsonl",
        }
        return summary, results, config

    def test_markdown_has_table_failures_and_all_cases(self):
        summary, results, config = self._run()
        md = render_markdown(
            summary, results, config=config, min_pass_rate=0.8, passed=False, started_at=datetime.now(UTC)
        )
        assert md.startswith("# Answer-quality eval report")
        assert "**FAIL** — 1/3 cases passed (33%; threshold 80%)" in md
        assert "| pricing | 1 | 1 | 100% | 1.00 | 0 |" in md
        assert "| offtopic | 1 | 0 | 0% | n/a | 1 |" in md
        assert "## Failures (2)" in md
        assert "**Question:** How big is your team?" in md and "> We are 25 people." in md
        assert "- 25 people" in md and "- The team is 18 people" in md and "Team size is wrong." in md
        assert "**Error:** `chat: bot is offline (reason='subscription_expired')`" in md
        assert "| `pricing-01` | pricing | pass | 1.00 | true |" in md
        assert "| `offtopic-01` | offtopic | error | n/a | n/a |" in md

    def test_files_are_written(self, tmp_path):
        summary, results, config = self._run()
        started = datetime.now(UTC)
        report = build_report(
            summary, results, config=config, min_pass_rate=0.8, passed=False, started_at=started, finished_at=started
        )
        json_path, md_path = write_reports(tmp_path / "out", report, "# report\n")
        loaded = json.loads(json_path.read_text(encoding="utf-8"))
        assert loaded["passed"] is False and loaded["summary"]["total"] == 3
        assert [r["case_id"] for r in loaded["results"]] == ["pricing-01", "team-02", "offtopic-01"]
        assert loaded["results"][1]["verdict"]["fabricated"] == ["25 people"]
        assert md_path.read_text(encoding="utf-8") == "# report\n"


# ── CLI ──────────────────────────────────────────────────────────────────────


@pytest.fixture()
def clean_env(monkeypatch):
    for name in (
        "EVAL_API_URL",
        "EVAL_BOT_KEY",
        "EVAL_API_KEY",
        "EVAL_ORIGIN",
        "EVAL_JUDGE_MODEL",
        "GITHUB_STEP_SUMMARY",
    ):
        monkeypatch.delenv(name, raising=False)


class TestCli:
    def test_dry_run_validates_and_prints_the_plan(self, clean_env, capsys):
        assert run_eval.main(["--dry-run"]) == 0
        out = capsys.readouterr().out
        assert "40 cases" in out and "43 chat requests" in out
        assert "coverage: meets the shipped minimums" in out
        assert "Judge: gemini/gemini-2.5-flash" in out
        assert "Dry run: no request was made." in out

    def test_dry_run_with_filters(self, clean_env, capsys):
        assert run_eval.main(["--dry-run", "--category", "pricing", "--limit", "2"]) == 0
        assert "2 cases" in capsys.readouterr().out

    def test_dry_run_rejects_a_broken_golden_file(self, clean_env, tmp_path, capsys):
        bad = tmp_path / "bad.jsonl"
        bad.write_text('{"id": "x"}\n', encoding="utf-8")
        assert run_eval.main(["--dry-run", "--golden", str(bad)]) == 2
        assert "error:" in capsys.readouterr().err

    def test_unknown_case_id_is_a_usage_error(self, clean_env, capsys):
        assert run_eval.main(["--dry-run", "--case-id", "nope-99"]) == 2
        assert "unknown case id" in capsys.readouterr().err

    def test_live_run_needs_a_target(self, clean_env, capsys):
        assert run_eval.main(["--bot-key", "bot-x"]) == 2
        assert "--api-url is required" in capsys.readouterr().err
        assert run_eval.main(["--api-url", "https://api.example.test"]) == 2
        assert "--bot-key is required" in capsys.readouterr().err

    def test_live_run_needs_the_judge_key(self, clean_env, monkeypatch, capsys):
        monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
        assert run_eval.main(["--api-url", "https://api.example.test", "--bot-key", "bot-x"]) == 2
        assert "GOOGLE_API_KEY" in capsys.readouterr().err

    def test_ingest_fixture_prints_commands_without_an_api_key(self, clean_env, capsys):
        assert (
            run_eval.main(["--ingest-fixture", "--api-url", "https://api.example.test/", "--bot-key", "bot-abc"]) == 0
        )
        out = capsys.readouterr().out
        assert 'curl -sS "https://api.example.test/bots"' in out
        assert 'POST "https://api.example.test/ingest?bot_id=$BOT_ID"' in out
        for path in sorted(DEFAULT_FIXTURE_DIR.glob("*.md")):
            assert f'-F "files=@{path}"' in out
        assert "nothing was uploaded" in out

    def test_ingest_fixture_needs_a_target(self, clean_env, capsys):
        assert run_eval.main(["--ingest-fixture"]) == 2
        assert "--api-url is required" in capsys.readouterr().err

    def test_bad_threshold_values_are_rejected(self, clean_env):
        with pytest.raises(SystemExit) as excinfo:
            run_eval.main(["--dry-run", "--min-pass-rate", "1.5"])
        assert excinfo.value.code == 2

    def test_module_is_runnable_from_api_dir(self):
        """``python -m eval.run_eval`` must work with the CWD on sys.path, without packaging changes."""
        import subprocess
        import sys

        api_dir = Path(__file__).resolve().parents[1]
        completed = subprocess.run(
            [sys.executable, "-m", "eval.run_eval", "--dry-run", "--limit", "1"],
            cwd=api_dir,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        assert completed.returncode == 0, completed.stderr
        assert "1 cases" in completed.stdout


class TestSelectCases:
    def test_filters_compose(self):
        cases = load_golden_set(DEFAULT_GOLDEN_PATH)
        selected = select_cases(cases, categories=["pricing", "events"], limit=3)
        assert len(selected) == 3 and {c.category for c in selected} <= {"pricing", "events"}
        assert [c.id for c in select_cases(cases, case_ids=["team-01"])] == ["team-01"]

    def test_empty_selection_is_an_error(self):
        with pytest.raises(run_eval.EvalUsageError, match="no cases"):
            select_cases(load_golden_set(DEFAULT_GOLDEN_PATH), categories=["pricing"], limit=0)

    def test_chat_reply_defaults(self):
        reply = ChatReply(answer="a", session_id=None)
        assert reply.sources == [] and reply.generation_failed is False


class TestTheJudgeDoesNotSample:
    """A judge that samples is not a measurement.

    The eval judge ran at the provider default, 1.0 for Gemini, so it graded
    the same answer differently between runs. Against one deployed build, a
    byte-identical canned reply scored 1.00 and then 0.00, and a cached answer
    scored 1.00 and then 0.67 against a 0.70 pass threshold. Two cases moved on
    nothing but the dice, which is five points of a forty-case run.

    ``relevance_gate`` and ``groundedness_gate`` both pin temperature already,
    after the same symptom. The eval, the thing that is meant to tell us
    whether those work, was the last judge on the platform still sampling.
    """

    def test_it_asks_for_temperature_zero(self):
        case = _case()
        with patch("litellm.completion", return_value=_completion(_raw())) as completion:
            judge_answer(case, "an answer", model="gemini/gemini-2.5-flash")

        assert completion.call_args.kwargs["temperature"] == 0

    @pytest.mark.parametrize("model", ["openai/gpt-5-mini", "openai/gpt-5", "gpt-5-codex", "openai/gpt-5.4-mini"])
    def test_it_omits_temperature_where_the_model_rejects_it(self, model):
        """The gpt-5 family accepts only temperature=1 and errors on anything
        else, so asking for 0 there fails the call outright rather than making
        it deterministic."""
        case = _case()
        with patch("litellm.completion", return_value=_completion(_raw())) as completion:
            judge_answer(case, "an answer", model=model)

        assert "temperature" not in completion.call_args.kwargs

    @pytest.mark.parametrize(
        "model", ["gemini/gemini-2.5-flash", "gemini/gemini-2.0-flash", "anthropic/claude-sonnet-5"]
    )
    def test_every_other_model_still_gets_it(self, model):
        case = _case()
        with patch("litellm.completion", return_value=_completion(_raw())) as completion:
            judge_answer(case, "an answer", model=model)

        assert completion.call_args.kwargs["temperature"] == 0


class TestADeterministicCaseIsAssertedNotJudged:
    """Three trust cases were structurally unpassable.

    ``intent_router`` answers "are you a human", "who made you" and "is this
    conversation recorded" with fixed strings and no retrieval, because an LLM
    gate once classified "hi" as off-topic. Asking a model how well a constant
    is grounded in a knowledge base that never mentions it is the wrong
    instrument: the reply says it is built on the OyeChats platform, which the
    reference facts assert and the company's documents never mention, so the
    judge could justify either grade.
    """

    @staticmethod
    def _deterministic_case():
        return GoldenCase(
            id="trust-02",
            category="trust",
            question="Who made you?",
            expected_facts=["The assistant is built on the OyeChats platform and customised for Acme"],
            must_contain=["built on the OyeChats platform"],
        )

    def test_a_matching_answer_passes_without_a_judge_call(self):
        case = self._deterministic_case()
        verdict = assert_verdict(case, "I'm built on the OyeChats platform, customised for Acme. Anything else?")

        assert verdict.grounded == 1.0
        assert verdict.refusal_correct is True
        assert verdict.facts_covered == case.expected_facts
        assert case_passed(verdict) is True

    def test_a_changed_reply_fails_and_says_what_is_missing(self):
        """The point of asserting: editing the canned identity reply should go
        red, not be quietly forgiven by a lenient grader."""
        case = self._deterministic_case()
        verdict = assert_verdict(case, "I was made by Google. Anything else?")

        assert verdict.grounded == 0.0
        assert verdict.refusal_correct is False
        assert "built on the OyeChats platform" in verdict.notes
        assert case_passed(verdict) is False

    def test_matching_survives_rewrapping_but_not_rewording(self):
        case = self._deterministic_case()
        assert assert_verdict(case, "I'm   built on\nthe OyeChats   platform.").grounded == 1.0
        assert assert_verdict(case, "I'M BUILT ON THE OYECHATS PLATFORM.").grounded == 1.0
        assert assert_verdict(case, "I'm built on the OyeChat platform.").grounded == 0.0

    def test_a_case_without_must_contain_is_still_judged(self):
        assert self._deterministic_case().is_deterministic is True
        assert _case().is_deterministic is False


class TestTheShippedSetAssertsTheRouterReplies:
    """A guard on the fix. If someone drops ``must_contain`` from these three,
    they go back to being graded on how well a constant is grounded."""

    def test_the_three_router_answered_cases_are_deterministic(self):
        from eval.golden import DEFAULT_GOLDEN_PATH, load_golden_set

        by_id = {c.id: c for c in load_golden_set(DEFAULT_GOLDEN_PATH)}
        for case_id in ("trust-01", "trust-02", "trust-03"):
            assert by_id[case_id].is_deterministic, f"{case_id} is answered by intent_router and must be asserted"

    def test_nothing_else_is(self):
        """Deterministic scoring is for replies the platform writes verbatim.
        A generated answer asserted on substrings would be brittle and would
        stop measuring the thing the eval exists to measure."""
        from eval.golden import DEFAULT_GOLDEN_PATH, load_golden_set

        deterministic = {c.id for c in load_golden_set(DEFAULT_GOLDEN_PATH) if c.is_deterministic}
        assert deterministic == {"trust-01", "trust-02", "trust-03"}
