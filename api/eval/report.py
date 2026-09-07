"""``report.json`` and ``report.md`` for one eval run."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from eval.judge import CaseResult, EvalSummary

_ANSWER_PREVIEW_CHARS = 700


def mask_secret(value: str | None, keep: int = 8) -> str:
    """``bot-6a427d45…``: enough to recognise the bot, never the whole key."""
    if not value:
        return "(unset)"
    return value if len(value) <= keep else f"{value[:keep]}…"


def build_report(
    summary: EvalSummary,
    results: list[CaseResult],
    *,
    config: dict,
    min_pass_rate: float,
    passed: bool,
    started_at: datetime,
    finished_at: datetime,
) -> dict:
    """The JSON document: run config, the summary, and every case in full."""
    return {
        "schema_version": 1,
        "passed": passed,
        "min_pass_rate": min_pass_rate,
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
        "duration_s": round((finished_at - started_at).total_seconds(), 1),
        "config": config,
        "summary": summary.to_dict(),
        "results": [r.to_dict() for r in results],
    }


def _pct(rate: float | None) -> str:
    return "n/a" if rate is None else f"{rate * 100:.0f}%"


def _num(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.2f}"


def _quote(text: str | None) -> str:
    if not text:
        return "> _(no answer)_"
    text = text.strip()
    if len(text) > _ANSWER_PREVIEW_CHARS:
        text = text[:_ANSWER_PREVIEW_CHARS].rstrip() + " …"
    return "\n".join(f"> {line}" if line else ">" for line in text.splitlines())


def _escape_cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def render_markdown(
    summary: EvalSummary,
    results: list[CaseResult],
    *,
    config: dict,
    min_pass_rate: float,
    passed: bool,
    started_at: datetime,
) -> str:
    """The human-readable report: verdict, per-category table, failures, all cases."""
    status = "PASS" if passed else "FAIL"
    lines = [
        "# Answer-quality eval report",
        "",
        f"**{status}** — {summary.passed}/{summary.total} cases passed "
        f"({_pct(summary.pass_rate)}; threshold {_pct(min_pass_rate)}). "
        f"Mean grounded {_num(summary.mean_grounded)}, mean fact coverage {_pct(summary.mean_coverage)}, "
        f"{summary.errors} error(s).",
        "",
        f"- Run started: {started_at.isoformat(timespec='seconds')}",
        f"- API: `{config.get('api_url', '(unset)')}` · bot `{config.get('bot_key', '(unset)')}`",
        f"- Judge: `{config.get('judge_model', '(unset)')}` · grounded threshold {config.get('grounded_threshold')}",
        f"- Golden set: `{config.get('golden_path', '(unset)')}` ({summary.total} cases)",
        "",
        "## Per category",
        "",
        "| Category | Cases | Passed | Pass rate | Mean grounded | Errors |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for cat in summary.categories:
        lines.append(
            f"| {cat.category} | {cat.total} | {cat.passed} | {_pct(cat.pass_rate)} | {_num(cat.mean_grounded)} | {cat.errors} |"
        )

    failures = [r for r in results if not r.passed]
    lines += ["", f"## Failures ({len(failures)})", ""]
    if not failures:
        lines += ["None.", ""]
    for r in failures:
        lines += [f"### `{r.case_id}` · {r.category}", ""]
        if r.history:
            lines += ["Earlier visitor turns:", *(f"- {turn}" for turn in r.history), ""]
        lines += [f"**Question:** {r.question}", "", "**Answer:**", "", _quote(r.answer), ""]
        if r.error:
            lines += [f"**Error:** `{r.error}`", ""]
        if r.verdict:
            v = r.verdict
            lines += [
                f"**Verdict:** grounded {v.grounded:.2f} · refusal_correct {str(v.refusal_correct).lower()} "
                f"· must_refuse {str(r.must_refuse).lower()} · coverage {_pct(r.coverage)}",
                "",
            ]
            if v.fabricated:
                lines += ["Fabricated / forbidden:", *(f"- {claim}" for claim in v.fabricated), ""]
            missing = [f for f in r.expected_facts if f not in v.facts_covered]
            if missing:
                lines += ["Expected facts not conveyed:", *(f"- {fact}" for fact in missing), ""]
            lines += [f"_Judge notes:_ {v.notes}", ""]

    lines += [
        "## All cases",
        "",
        "| Case | Category | Result | Grounded | Refusal ok | Coverage | Latency |",
        "|---|---|---|---:|---|---:|---:|",
    ]
    for r in results:
        result = "error" if r.error else ("pass" if r.passed else "fail")
        grounded = _num(r.verdict.grounded) if r.verdict else "n/a"
        refusal = str(r.verdict.refusal_correct).lower() if r.verdict else "n/a"
        latency = f"{r.latency_s:.1f}s" if r.latency_s is not None else "n/a"
        lines.append(
            f"| `{_escape_cell(r.case_id)}` | {r.category} | {result} | {grounded} | {refusal} | {_pct(r.coverage)} | {latency} |"
        )
    lines.append("")
    return "\n".join(lines)


def write_reports(out_dir: Path, report: dict, markdown: str) -> tuple[Path, Path]:
    """Write ``report.json`` and ``report.md`` into ``out_dir`` (created if needed)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "report.json"
    md_path = out_dir / "report.md"
    json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    md_path.write_text(markdown, encoding="utf-8")
    return json_path, md_path
