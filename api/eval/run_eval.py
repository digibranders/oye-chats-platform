"""Run the golden set against a live bot and grade the answers.

    cd api
    uv run python -m eval.run_eval --dry-run
    uv run python -m eval.run_eval --api-url https://api.oyechats.com --bot-key bot-xxx
    uv run python -m eval.run_eval --ingest-fixture --api-url ... --bot-key bot-xxx --api-key <X-API-Key>

Every case gets a fresh session. Its ``history`` turns are sent first, then the
question; the final reply is judged. The bot asks every new session for the
visitor's name before answering the first message (``rag_service.
resolve_name_flow``), so when the first reply is that request the runner
answers with ``--visitor-name`` and takes the bot's next reply, the deferred
answer, as the answer to that turn.

``POST /chat`` is rate-limited to 30 requests a minute per bot key and IP, so
requests are paced (``--pace``) and a 429 is retried after ``Retry-After``.
Each answered request costs the bot owner one AI-chat credit.

Exit status: 0 when the pass rate meets ``--min-pass-rate``, 1 when it does not
(or the API could not be reached), 2 for a usage or golden-file error.
"""

from __future__ import annotations

import argparse
import functools
import logging
import os
import sys
import time
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, TextIO

import httpx

from eval.golden import (
    CATEGORIES,
    DEFAULT_FIXTURE_DIR,
    DEFAULT_GOLDEN_PATH,
    GoldenCase,
    GoldenSetError,
    load_golden_set,
    plan_summary,
)
from eval.judge import DEFAULT_JUDGE_MODEL, GROUNDED_PASS_THRESHOLD, JUDGE_TIMEOUT_S
from eval.report import build_report, mask_secret, render_markdown, write_reports

if TYPE_CHECKING:
    from eval.judge import CaseResult, JudgeVerdict

logger = logging.getLogger("eval")

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2

DEFAULT_MIN_PASS_RATE = 0.8
DEFAULT_OUT_DIR = Path("eval-report")
DEFAULT_JUDGE_MODEL_ENV = "EVAL_JUDGE_MODEL"
#: ``/chat`` allows 30 requests/minute per (bot key, IP); 2.2s keeps a run
#: under that with the retry headroom a 429 needs.
DEFAULT_PACE_S = 2.2
DEFAULT_VISITOR_NAME = "Eva"
CHAT_TIMEOUT_S = 90.0
_RATE_LIMIT_RETRIES = 3
_RATE_LIMIT_DEFAULT_WAIT_S = 20.0
#: Consecutive transport failures after which the run stops asking: the API is
#: down, and 30 more timeouts would only delay the report.
_MAX_CONSECUTIVE_TRANSPORT_ERRORS = 3
INGEST_POLL_S = 5.0
DEFAULT_INGEST_TIMEOUT_S = 300.0
_FIXTURE_EXTENSIONS = (".md", ".txt", ".pdf", ".docx")
_REFERENCE_EXTENSIONS = (".md", ".txt")
_ESTIMATED_ANSWER_S = 4.0
_ESTIMATED_JUDGE_S = 3.0

#: Mirrors ``rag_service._NAME_ASK_SIGNATURES`` / ``_NAME_ASK_SIGNATURES_I18N``.
#: Copied rather than imported: importing ``rag_service`` drags the whole chat
#: stack into a CLI process. Language-agnostic on purpose, like the original.
NAME_ASK_SIGNATURES: tuple[str, ...] = (
    "what name should i use to address you",
    "may i know your name so i can address you",
    "क्या मैं आपका नाम जान सकता",
    "आपको किस नाम से संबोधित",
)


class EvalUsageError(Exception):
    """Bad invocation or unusable inputs. Exit status 2."""


class ChatApiError(Exception):
    """One ``POST /chat`` did not yield an answer.

    ``transport`` is True for connection-level failures (refused, DNS, timeout),
    the kind that means the API is unreachable rather than this case is broken.
    """

    def __init__(self, message: str, *, transport: bool = False):
        super().__init__(message)
        self.transport = transport


@dataclass
class ChatReply:
    answer: str
    session_id: str | None
    sources: list[str] = field(default_factory=list)
    generation_failed: bool = False
    latency_s: float = 0.0


#: ``ask(question, session_id) -> ChatReply``; ``ChatClient.ask`` or a test double.
AskFn = Callable[[str, str], ChatReply]
#: ``judge(case, answer) -> JudgeVerdict``; ``judge.judge_answer`` bound to a model, or a test double.
JudgeFn = Callable[[GoldenCase, str], "JudgeVerdict"]


def is_name_request(answer: str | None) -> bool:
    """True when ``answer`` is the bot's turn-1 "may I know your name" request."""
    low = (answer or "").casefold()
    return any(signature in low for signature in NAME_ASK_SIGNATURES)


def _env(name: str) -> str | None:
    """Environment value, with an empty string treated as unset (CI passes absent secrets as ``""``)."""
    value = os.environ.get(name)
    return value if value else None


# ── HTTP client ───────────────────────────────────────────────────────────────


def _retry_after_seconds(response: httpx.Response) -> float:
    header = response.headers.get("retry-after")
    try:
        return max(1.0, float(header)) if header else _RATE_LIMIT_DEFAULT_WAIT_S
    except ValueError:
        return _RATE_LIMIT_DEFAULT_WAIT_S


class ChatClient:
    """``POST /chat`` as the widget sends it: ``X-Bot-Key``, paced, 429-aware."""

    def __init__(
        self,
        api_url: str,
        bot_key: str,
        *,
        origin: str | None = None,
        timeout: float = CHAT_TIMEOUT_S,
        pace_s: float = DEFAULT_PACE_S,
        sleep: Callable[[float], None] = time.sleep,
        transport: httpx.BaseTransport | None = None,
    ):
        headers = {"X-Bot-Key": bot_key, "Accept": "application/json"}
        if origin:
            # A bot with ``domain_check_enabled`` and an allowlist rejects a
            # request without an allowed Origin/Referer (``auth._enforce_bot_origin``).
            headers["Origin"] = origin
        self._client = httpx.Client(base_url=api_url.rstrip("/"), headers=headers, timeout=timeout, transport=transport)
        self._pace_s = pace_s
        self._sleep = sleep
        self._last_request_at: float | None = None

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> ChatClient:
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    def _pace(self) -> None:
        if self._last_request_at is not None:
            wait = self._pace_s - (time.monotonic() - self._last_request_at)
            if wait > 0:
                self._sleep(wait)
        self._last_request_at = time.monotonic()

    def ask(self, question: str, session_id: str) -> ChatReply:
        payload = {"question": question, "session_id": session_id}
        for attempt in range(_RATE_LIMIT_RETRIES + 1):
            self._pace()
            started = time.monotonic()
            try:
                response = self._client.post("/chat", json=payload)
            except httpx.HTTPError as exc:
                raise ChatApiError(f"POST /chat failed: {type(exc).__name__}: {exc}", transport=True) from exc
            latency = time.monotonic() - started
            if response.status_code == 429 and attempt < _RATE_LIMIT_RETRIES:
                wait = _retry_after_seconds(response)
                logger.warning("rate limited by /chat; waiting %.0fs before retry %d", wait, attempt + 1)
                self._sleep(wait)
                continue
            if response.status_code >= 400:
                raise ChatApiError(f"POST /chat returned HTTP {response.status_code}: {response.text[:300]}")
            return _parse_chat_reply(response, latency)
        raise ChatApiError(f"POST /chat still rate limited after {_RATE_LIMIT_RETRIES} retries")


def _parse_chat_reply(response: httpx.Response, latency: float) -> ChatReply:
    try:
        data = response.json()
    except ValueError as exc:
        raise ChatApiError(f"POST /chat returned non-JSON body: {response.text[:200]!r}") from exc
    if not isinstance(data, dict) or "answer" not in data:
        raise ChatApiError(f"POST /chat reply has no 'answer' field: {str(data)[:200]}")
    metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    if data.get("status") == "service_unavailable" or metadata.get("service_unavailable"):
        # ``chat_routes._polite_offline_payload``: the owner's subscription is
        # not active, so no LLM ran. Not a quality signal; fail the case loudly.
        raise ChatApiError(f"bot is offline (reason={data.get('reason') or metadata.get('reason')!r})")
    return ChatReply(
        answer=str(data.get("answer") or ""),
        session_id=str(data["session_id"]) if data.get("session_id") else None,
        sources=[str(s) for s in (data.get("sources") or [])],
        generation_failed=bool(data.get("generation_failed")),
        latency_s=round(latency, 2),
    )


# ── Running cases ─────────────────────────────────────────────────────────────


def converse(case: GoldenCase, ask: AskFn, *, visitor_name: str, name_flow: bool) -> tuple[ChatReply, bool]:
    """Play one case into a fresh session. Returns the reply to the final question and whether the name gate fired."""
    session_id = str(uuid.uuid4())
    turns = [*case.history, case.question]
    triggered = False
    reply: ChatReply | None = None
    for index, turn in enumerate(turns):
        reply = ask(turn, session_id)
        session_id = reply.session_id or session_id
        if index == 0 and name_flow and is_name_request(reply.answer):
            # The bot deferred this turn behind its name request; answering
            # with a name makes it answer the deferred question next.
            triggered = True
            reply = ask(visitor_name, session_id)
            session_id = reply.session_id or session_id
    assert reply is not None  # turns always has at least the question
    return reply, triggered


def run_case(
    case: GoldenCase,
    ask: AskFn,
    judge: JudgeFn,
    *,
    grounded_threshold: float,
    visitor_name: str = DEFAULT_VISITOR_NAME,
    name_flow: bool = True,
) -> CaseResult:
    """Converse, judge, and decide one case. Never raises for a per-case failure."""
    from eval.judge import CaseResult, case_passed, fact_coverage

    result = CaseResult.from_case(case)
    try:
        reply, result.name_flow_triggered = converse(case, ask, visitor_name=visitor_name, name_flow=name_flow)
    except ChatApiError as exc:
        result.error = f"chat: {exc}"
        result.transport_error = exc.transport
        return result

    result.answer = reply.answer
    result.sources = reply.sources
    result.session_id = reply.session_id
    result.latency_s = reply.latency_s
    if reply.generation_failed:
        result.error = "generation_failed: the API returned its canned LLM-failure message"
        return result

    try:
        verdict = judge(case, reply.answer)
    except Exception as exc:  # noqa: BLE001 - a judge failure is reported on the case, not raised
        result.error = f"judge: {type(exc).__name__}: {exc}"
        return result
    result.verdict = verdict
    result.coverage = fact_coverage(verdict, case)
    result.passed = case_passed(verdict, grounded_threshold)
    return result


def run_cases(
    cases: Iterable[GoldenCase],
    ask: AskFn,
    judge: JudgeFn,
    *,
    grounded_threshold: float,
    visitor_name: str = DEFAULT_VISITOR_NAME,
    name_flow: bool = True,
    on_result: Callable[[int, int, CaseResult], None] | None = None,
) -> list[CaseResult]:
    """Run every case in order. Stops asking after repeated transport failures."""
    from eval.judge import CaseResult

    cases = list(cases)
    results: list[CaseResult] = []
    consecutive_transport_errors = 0
    aborted = False
    for index, case in enumerate(cases, start=1):
        if aborted:
            result = CaseResult.from_case(case)
            result.error = "skipped: the API was unreachable for earlier cases"
            result.transport_error = True
        else:
            result = run_case(
                case,
                ask,
                judge,
                grounded_threshold=grounded_threshold,
                visitor_name=visitor_name,
                name_flow=name_flow,
            )
            consecutive_transport_errors = consecutive_transport_errors + 1 if result.transport_error else 0
            if consecutive_transport_errors >= _MAX_CONSECUTIVE_TRANSPORT_ERRORS:
                aborted = True
                logger.error(
                    "%d consecutive transport failures; marking the remaining cases as errors",
                    consecutive_transport_errors,
                )
        results.append(result)
        if on_result is not None:
            on_result(index, len(cases), result)
    return results


# ── Inputs ────────────────────────────────────────────────────────────────────


def _judge_key_env(model: str) -> str | None:
    if model.startswith(("gemini/", "google/")):
        return "GOOGLE_API_KEY"
    if model.startswith(("openai/", "gpt-")):
        return "OPENAI_API_KEY"
    return None


def load_reference_text(directory: Path | None) -> str | None:
    """Concatenate the ``.md`` / ``.txt`` files of a knowledge-base directory for the judge."""
    if directory is None:
        return None
    if not directory.is_dir():
        raise EvalUsageError(f"reference directory not found: {directory}")
    files = sorted(p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in _REFERENCE_EXTENSIONS)
    if not files:
        raise EvalUsageError(f"no .md/.txt files in reference directory {directory}")
    return "\n\n".join(f"## {p.name}\n\n{p.read_text(encoding='utf-8').strip()}" for p in files)


def select_cases(
    cases: list[GoldenCase],
    *,
    categories: list[str] | None = None,
    case_ids: list[str] | None = None,
    limit: int | None = None,
) -> list[GoldenCase]:
    selected = cases
    if categories:
        wanted = set(categories)
        selected = [c for c in selected if c.category in wanted]
    if case_ids:
        wanted_ids = set(case_ids)
        unknown = wanted_ids - {c.id for c in cases}
        if unknown:
            raise EvalUsageError(f"unknown case id(s): {', '.join(sorted(unknown))}")
        selected = [c for c in selected if c.id in wanted_ids]
    if limit is not None:
        selected = selected[:limit]
    if not selected:
        raise EvalUsageError("the filters selected no cases")
    return selected


def _resolve_reference_dir(args: argparse.Namespace) -> Path | None:
    if args.no_reference:
        return None
    if args.reference_dir is not None:
        return Path(args.reference_dir)
    # The shipped set is written against the shipped fixture; give the judge
    # the fixture so a true KB fact outside ``expected_facts`` is not marked
    # fabricated. A custom set is judged against its own expected facts only.
    return DEFAULT_FIXTURE_DIR if Path(args.golden).resolve() == DEFAULT_GOLDEN_PATH.resolve() else None


def _require(value: str | None, flag: str, env_name: str) -> str:
    if not value:
        raise EvalUsageError(f"{flag} is required (or set {env_name})")
    return value


# ── Commands ──────────────────────────────────────────────────────────────────


def print_plan(cases: list[GoldenCase], args: argparse.Namespace, out: TextIO | None = None) -> None:
    """Print what a run would do. ``out`` defaults to the CURRENT ``sys.stdout``,
    resolved per call rather than bound as a default argument: a default is
    evaluated once at import, which would pin the interpreter's original stream
    and make the plan bypass any later redirection (a capturing test harness,
    a caller using ``contextlib.redirect_stdout``, a wrapper writing to a file)."""
    out = out if out is not None else sys.stdout
    plan = plan_summary(cases)
    judge_model = args.judge_model
    key_env = _judge_key_env(judge_model)
    key_state = "n/a" if key_env is None else f"{key_env} {'set' if _env(key_env) else 'NOT set'}"
    # Every session costs one more request than its turns: the bot answers
    # the first message with its name request, and the runner answers that.
    total_requests = plan["requests"] + plan["cases"]
    estimate_s = total_requests * (args.pace + _ESTIMATED_ANSWER_S) + plan["cases"] * _ESTIMATED_JUDGE_S
    reference_dir = _resolve_reference_dir(args)
    lines = [
        f"Golden set: {Path(args.golden).resolve()}",
        f"  {plan['cases']} cases, {plan['requests']} chat requests (+{plan['cases']} for the name gate, one per session), "
        f"{plan['must_refuse']} must refuse, {plan['with_history']} with history",
        "  per category: " + ", ".join(f"{k} {v}" for k, v in plan["per_category"].items()),
        "  coverage: "
        + ("meets the shipped minimums" if not plan["coverage_shortfalls"] else "; ".join(plan["coverage_shortfalls"])),
        f"Target: {args.api_url or '(unset)'} · bot {mask_secret(args.bot_key)}"
        + (f" · Origin {args.origin}" if args.origin else ""),
        f"Judge: {judge_model} ({key_state}) · timeout {args.judge_timeout:.0f}s · "
        f"reference material {'from ' + str(reference_dir) if reference_dir else 'none'}",
        f"Pass rule: grounded >= {args.grounded_threshold} and refusal correct; run passes at >= {args.min_pass_rate:.0%}",
        f"Estimated duration: ~{estimate_s / 60:.0f} min at {args.pace}s pacing",
        f"Report: {Path(args.out).resolve()}",
    ]
    if args.dry_run:
        lines.append("Dry run: no request was made.")
    print("\n".join(lines), file=out)


def _write_step_summary(markdown: str) -> None:
    """Surface the report in the GitHub Actions job summary when running there."""
    path = _env("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(markdown + "\n")
    except OSError as exc:  # pragma: no cover - never fail a run over the summary
        logger.warning("could not write GITHUB_STEP_SUMMARY: %s", exc)


def run_live(cases: list[GoldenCase], args: argparse.Namespace) -> int:
    api_url = _require(args.api_url, "--api-url", "EVAL_API_URL")
    bot_key = _require(args.bot_key, "--bot-key", "EVAL_BOT_KEY")
    key_env = _judge_key_env(args.judge_model)
    if key_env and not _env(key_env):
        raise EvalUsageError(f"judge model {args.judge_model} needs {key_env} in the environment")
    reference_text = load_reference_text(_resolve_reference_dir(args))

    # Imported here, not at module top: litellm is slow to import and only the
    # live run needs it; ``--dry-run`` and ``--ingest-fixture`` never do.
    import litellm

    from eval.judge import aggregate, judge_answer, meets_threshold

    # Same posture as ``app/main.py``: a provider that does not know a kwarg
    # (``reasoning_effort`` on a non-reasoning judge) drops it instead of failing.
    litellm.drop_params = True
    litellm.suppress_debug_info = True

    judge = functools.partial(
        judge_answer, model=args.judge_model, timeout=args.judge_timeout, reference_text=reference_text
    )

    def _progress(index: int, total: int, result) -> None:
        if result.error:
            outcome = f"ERROR {result.error}"
        else:
            outcome = (
                f"{'PASS' if result.passed else 'FAIL'} grounded={result.verdict.grounded:.2f} "
                f"refusal_ok={str(result.verdict.refusal_correct).lower()} {result.latency_s or 0:.1f}s"
            )
        logger.info("[%d/%d] %-16s %s", index, total, result.case_id, outcome)

    started_at = datetime.now(UTC)
    with ChatClient(api_url, bot_key, origin=args.origin, pace_s=args.pace) as client:
        results = run_cases(
            cases,
            client.ask,
            judge,
            grounded_threshold=args.grounded_threshold,
            visitor_name=args.visitor_name,
            name_flow=not args.no_name_flow,
            on_result=_progress,
        )
    finished_at = datetime.now(UTC)

    summary = aggregate(results)
    passed = meets_threshold(summary, args.min_pass_rate)
    config = {
        "api_url": api_url,
        "bot_key": mask_secret(bot_key),
        "origin": args.origin,
        "golden_path": str(Path(args.golden).resolve()),
        "judge_model": args.judge_model,
        "judge_timeout_s": args.judge_timeout,
        "grounded_threshold": args.grounded_threshold,
        "reference_dir": str(_resolve_reference_dir(args)) if reference_text else None,
        "visitor_name": args.visitor_name,
        "name_flow": not args.no_name_flow,
        "pace_s": args.pace,
        "filters": {"categories": args.category, "case_ids": args.case_id, "limit": args.limit},
    }
    report = build_report(
        summary,
        results,
        config=config,
        min_pass_rate=args.min_pass_rate,
        passed=passed,
        started_at=started_at,
        finished_at=finished_at,
    )
    markdown = render_markdown(
        summary, results, config=config, min_pass_rate=args.min_pass_rate, passed=passed, started_at=started_at
    )
    json_path, md_path = write_reports(Path(args.out), report, markdown)
    _write_step_summary(markdown)

    print(
        f"{'PASS' if passed else 'FAIL'}: {summary.passed}/{summary.total} cases passed "
        f"({summary.pass_rate:.0%}, threshold {args.min_pass_rate:.0%}), {summary.errors} error(s)."
    )
    for cat in summary.categories:
        print(f"  {cat.category:<12} {cat.passed}/{cat.total} ({cat.pass_rate:.0%})")
    print(f"Report: {md_path} and {json_path}")
    return EXIT_OK if passed else EXIT_FAILED


def fixture_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        raise EvalUsageError(f"fixture directory not found: {directory}")
    files = sorted(p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in _FIXTURE_EXTENSIONS)
    if not files:
        raise EvalUsageError(f"no ingestible files ({', '.join(_FIXTURE_EXTENSIONS)}) in {directory}")
    return files


def manual_ingest_commands(api_url: str, bot_key: str, files: list[Path]) -> str:
    """The curl equivalent of ``--ingest-fixture --api-key``, for people who would rather look first."""
    api = api_url.rstrip("/")
    file_flags = " \\\n    ".join(f'-F "files=@{p}"' for p in files)
    return f"""# 1. Find the numeric id of bot {bot_key} (the upload API takes an id, not the key):
curl -sS "{api}/bots" -H "X-API-Key: $EVAL_API_KEY" \\
  | python3 -c 'import json,sys; print([b["id"] for b in json.load(sys.stdin) if b["bot_key"]=="{bot_key}"][0])'

# 2. Upload the fixture documents (costs the workspace document-upload credits):
curl -sS -X POST "{api}/ingest?bot_id=$BOT_ID" -H "X-API-Key: $EVAL_API_KEY" \\
    {file_flags}

# 3. Wait until every file is listed (ingestion runs on the worker):
curl -sS "{api}/documents?bot_id=$BOT_ID" -H "X-API-Key: $EVAL_API_KEY"
"""


def ingest_fixture(args: argparse.Namespace) -> int:
    api_url = _require(args.api_url, "--api-url", "EVAL_API_URL")
    bot_key = _require(args.bot_key, "--bot-key", "EVAL_BOT_KEY")
    files = fixture_files(Path(args.fixture_dir))
    if not args.api_key:
        print(manual_ingest_commands(api_url, bot_key, files))
        print("No --api-key / EVAL_API_KEY given, so nothing was uploaded. Run the commands above, or pass the key.")
        return EXIT_OK

    headers = {"X-API-Key": args.api_key, "Accept": "application/json"}
    with httpx.Client(base_url=api_url.rstrip("/"), headers=headers, timeout=180.0) as client:
        bots = client.get("/bots")
        if bots.status_code >= 400:
            raise EvalUsageError(f"GET /bots returned HTTP {bots.status_code}: {bots.text[:300]}")
        bot_id = next((b["id"] for b in bots.json() if b.get("bot_key") == bot_key), None)
        if bot_id is None:
            raise EvalUsageError(f"bot {bot_key} is not in the workspace this X-API-Key belongs to")

        upload = [("files", (p.name, p.read_bytes(), "application/octet-stream")) for p in files]
        response = client.post("/ingest", params={"bot_id": bot_id}, files=upload)
        if response.status_code >= 400:
            print(f"POST /ingest returned HTTP {response.status_code}: {response.text[:500]}", file=sys.stderr)
            return EXIT_FAILED
        body = response.json()
        print(
            f"Uploaded {len(body.get('files_uploaded', []))} file(s) to bot {bot_id}: "
            f"{body.get('message')} (credits charged: {body.get('credits_charged')}, job: {body.get('job_id') or 'in-process'})"
        )

        wanted = {p.name for p in files}
        deadline = time.monotonic() + args.ingest_timeout
        while True:
            listing = client.get("/documents", params={"bot_id": bot_id})
            names = {Path(str(d.get("name", ""))).name for d in listing.json()} if listing.status_code < 400 else set()
            missing = sorted(wanted - names)
            if not missing:
                print(f"All {len(wanted)} fixture documents are ingested; the bot is ready for the eval.")
                return EXIT_OK
            if time.monotonic() >= deadline:
                print(
                    f"Timed out after {args.ingest_timeout:.0f}s; still missing: {', '.join(missing)}", file=sys.stderr
                )
                return EXIT_FAILED
            print(f"  waiting for ingestion: {len(missing)} file(s) pending …")
            time.sleep(INGEST_POLL_S)


# ── CLI ───────────────────────────────────────────────────────────────────────


def _unit_interval(text: str) -> float:
    try:
        value = float(text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"not a number: {text!r}") from exc
    if not 0.0 <= value <= 1.0:
        raise argparse.ArgumentTypeError(f"must be between 0 and 1, got {value}")
    return value


def _positive(text: str) -> float:
    try:
        value = float(text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"not a number: {text!r}") from exc
    if value <= 0:
        raise argparse.ArgumentTypeError(f"must be positive, got {value}")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m eval.run_eval",
        description="Answer-quality eval: ask a live bot the golden questions and grade the answers.",
    )
    target = parser.add_argument_group("target bot")
    target.add_argument(
        "--api-url", default=_env("EVAL_API_URL"), help="API base URL, e.g. https://api.oyechats.com [EVAL_API_URL]"
    )
    target.add_argument(
        "--bot-key", default=_env("EVAL_BOT_KEY"), help="public widget key of the bot under test [EVAL_BOT_KEY]"
    )
    target.add_argument(
        "--origin", default=_env("EVAL_ORIGIN"), help="Origin header, for a bot with domain enforcement [EVAL_ORIGIN]"
    )
    target.add_argument(
        "--pace",
        type=_positive,
        default=DEFAULT_PACE_S,
        help=f"seconds between chat requests (default {DEFAULT_PACE_S})",
    )
    target.add_argument(
        "--visitor-name", default=DEFAULT_VISITOR_NAME, help="name given when the bot asks for one (default Eva)"
    )
    target.add_argument("--no-name-flow", action="store_true", help="never answer the bot's name request")

    selection = parser.add_argument_group("golden set")
    selection.add_argument(
        "--golden", default=str(DEFAULT_GOLDEN_PATH), help="JSONL golden file (default: the shipped set)"
    )
    selection.add_argument("--category", action="append", choices=CATEGORIES, help="only these categories (repeatable)")
    selection.add_argument("--case-id", action="append", help="only these case ids (repeatable)")
    selection.add_argument("--limit", type=int, help="only the first N selected cases")

    grading = parser.add_argument_group("grading")
    grading.add_argument(
        "--judge-model",
        default=_env(DEFAULT_JUDGE_MODEL_ENV) or DEFAULT_JUDGE_MODEL,
        help=f"LiteLLM judge model (default {DEFAULT_JUDGE_MODEL}) [{DEFAULT_JUDGE_MODEL_ENV}]",
    )
    grading.add_argument(
        "--judge-timeout",
        type=_positive,
        default=JUDGE_TIMEOUT_S,
        help=f"seconds per judge call (default {JUDGE_TIMEOUT_S:.0f})",
    )
    grading.add_argument(
        "--grounded-threshold",
        type=_unit_interval,
        default=GROUNDED_PASS_THRESHOLD,
        help=f"a case passes at grounded >= this (default {GROUNDED_PASS_THRESHOLD})",
    )
    grading.add_argument(
        "--min-pass-rate",
        type=_unit_interval,
        default=DEFAULT_MIN_PASS_RATE,
        help=f"the run passes at this share of cases (default {DEFAULT_MIN_PASS_RATE})",
    )
    grading.add_argument(
        "--reference-dir",
        help="knowledge-base directory shown to the judge (default: the fixture, for the shipped set)",
    )
    grading.add_argument("--no-reference", action="store_true", help="judge against expected_facts only")

    output = parser.add_argument_group("output")
    output.add_argument(
        "--out",
        default=str(DEFAULT_OUT_DIR),
        help=f"directory for report.json and report.md (default {DEFAULT_OUT_DIR})",
    )
    output.add_argument("-v", "--verbose", action="store_true", help="debug logging")

    modes = parser.add_argument_group("modes")
    modes.add_argument("--dry-run", action="store_true", help="validate the golden file and print the plan; no network")
    modes.add_argument(
        "--ingest-fixture",
        action="store_true",
        help="load the fixture KB into the bot (needs --api-key) or print the commands",
    )
    modes.add_argument(
        "--api-key", default=_env("EVAL_API_KEY"), help="workspace X-API-Key, for --ingest-fixture [EVAL_API_KEY]"
    )
    modes.add_argument(
        "--fixture-dir", default=str(DEFAULT_FIXTURE_DIR), help="documents to upload with --ingest-fixture"
    )
    modes.add_argument(
        "--ingest-timeout", type=_positive, default=DEFAULT_INGEST_TIMEOUT_S, help="seconds to wait for ingestion"
    )
    return parser


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
        force=True,
    )
    for noisy in ("httpx", "httpcore", "LiteLLM", "litellm"):
        logging.getLogger(noisy).setLevel(logging.DEBUG if verbose else logging.WARNING)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)
    try:
        if args.ingest_fixture:
            return ingest_fixture(args)
        try:
            cases = select_cases(
                load_golden_set(args.golden), categories=args.category, case_ids=args.case_id, limit=args.limit
            )
        except GoldenSetError as exc:
            raise EvalUsageError(str(exc)) from exc
        print_plan(cases, args)
        if args.dry_run:
            return EXIT_OK
        return run_live(cases, args)
    except EvalUsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
