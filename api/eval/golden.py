"""Golden-set schema, loader and validation.

A golden set is a JSONL file: one :class:`GoldenCase` per line. Every case
names a question to ask the bot, what a correct answer must convey
(``expected_facts``), what it must never assert (``forbidden_claims``), and
whether the only correct behaviour is to decline (``must_refuse``).

The shipped set, ``golden_set.jsonl``, is written against the synthetic
knowledge base under ``fixtures/acme/`` so that every expected fact is
verifiably present in a document the bot has ingested. A customer-specific set
can use the same schema against a real bot; see ``docs/eval/README.md``.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

Category = Literal[
    "greeting",
    "company",
    "services",
    "pricing",
    "team",
    "hours",
    "events",
    "followup",
    "offtopic",
    "adversarial",
    "trust",
]
CATEGORIES: tuple[str, ...] = get_args(Category)

#: The golden set and fixture KB that ship with the harness.
DEFAULT_GOLDEN_PATH = Path(__file__).with_name("golden_set.jsonl")
DEFAULT_FIXTURE_DIR = Path(__file__).parent / "fixtures" / "acme"

#: Matches ``ChatRequest.question`` (``max_length=5000``) so a case can never be
#: rejected by the API's own validation instead of being answered.
MAX_QUESTION_CHARS = 5000
MAX_HISTORY_TURNS = 6
MAX_FACTS = 12
MAX_FACT_CHARS = 500

#: Minimum number of cases per behaviour the SHIPPED set must contain. These are
#: the failure classes the April 2026 audit found in production (off-topic
#: refusals, prompt injection, pronoun follow-ups, stale "upcoming" events,
#: pricing hedges), plus the September 2026 regression in which the relevance
#: gate refused questions about the company itself ("what does Acme do"), so a
#: set that lost coverage of one of them would silently stop guarding it.
#: ``coverage_shortfalls`` reports the gaps; the dry run prints them as
#: warnings and ``tests/test_eval_harness.py`` enforces them on the shipped
#: file.
MINIMUM_COVERAGE: dict[str, int] = {
    "offtopic_refusals": 4,
    "adversarial_refusals": 3,
    "followups_with_history": 2,
    "events": 2,
    "pricing": 3,
    "company_answered": 4,
}


class GoldenCase(BaseModel):
    """One question the bot must answer (or refuse) correctly."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$")
    category: Category
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    #: Prior VISITOR turns, replayed in order into the same fresh session before
    #: ``question`` is asked. The bot's replies come from the live API, not from
    #: this file, so a follow-up is judged against real conversational state.
    history: list[str] = Field(default_factory=list, max_length=MAX_HISTORY_TURNS)
    #: Reference truths the answer must convey / may draw on. Every entry should
    #: be verifiable in the bot's knowledge base (for the shipped set: the
    #: fixture docs). For ``greeting`` and ``trust`` cases they describe the
    #: expected behaviour rather than a KB fact. ``company`` cases ask about
    #: the business itself ("what does Acme do") and must be answered from the
    #: KB, never refused.
    expected_facts: list[str] = Field(default_factory=list, max_length=MAX_FACTS)
    #: Claims the answer must never assert. A forbidden claim in the answer is
    #: graded as fabricated and caps ``grounded`` at 0.3 (see ``judge``).
    forbidden_claims: list[str] = Field(default_factory=list, max_length=MAX_FACTS)
    #: True when the only correct behaviour is to decline, redirect, or ignore
    #: the request (off-topic questions, prompt injection).
    must_refuse: bool = False

    @field_validator("history", "expected_facts", "forbidden_claims")
    @classmethod
    def _items_are_non_empty_strings(cls, items: list[str]) -> list[str]:
        cleaned: list[str] = []
        for item in items:
            text = item.strip()
            if not text:
                raise ValueError("list entries must be non-empty strings")
            if len(text) > max(MAX_FACT_CHARS, MAX_QUESTION_CHARS):
                raise ValueError(f"list entry longer than {MAX_QUESTION_CHARS} characters")
            cleaned.append(text)
        return cleaned

    @model_validator(mode="after")
    def _coherent(self) -> GoldenCase:
        if self.must_refuse and self.expected_facts:
            raise ValueError(
                "a must_refuse case cannot list expected_facts; name what a bad answer would say under forbidden_claims"
            )
        if not self.must_refuse and not self.expected_facts:
            raise ValueError("an answerable case needs at least one expected fact")
        if self.category == "followup" and not self.history:
            raise ValueError("a followup case needs at least one history turn")
        for fact in (*self.expected_facts, *self.forbidden_claims):
            if len(fact) > MAX_FACT_CHARS:
                raise ValueError(
                    f"expected_facts / forbidden_claims entries must be at most {MAX_FACT_CHARS} characters"
                )
        return self

    @property
    def request_count(self) -> int:
        """HTTP requests this case costs: one per history turn plus the question."""
        return len(self.history) + 1


class GoldenSetError(ValueError):
    """The golden file is unusable. The message lists every problem found."""


def _format_validation_error(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err.get("loc", ())) or "<case>"
        parts.append(f"{loc}: {err.get('msg')}")
    return "; ".join(parts)


def load_golden_set(path: Path | str) -> list[GoldenCase]:
    """Parse and validate a JSONL golden file.

    Blank lines are skipped. Every other line must be one JSON object that
    validates as :class:`GoldenCase`; ids must be unique across the file. All
    problems are collected and raised together as one :class:`GoldenSetError`
    so a broken file is fixed in one pass, not one line per run.
    """
    path = Path(path)
    if not path.is_file():
        raise GoldenSetError(f"golden file not found: {path}")

    cases: list[GoldenCase] = []
    problems: list[str] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            problems.append(f"line {lineno}: invalid JSON ({exc.msg} at column {exc.colno})")
            continue
        if not isinstance(payload, dict):
            problems.append(f"line {lineno}: expected a JSON object, got {type(payload).__name__}")
            continue
        try:
            cases.append(GoldenCase.model_validate(payload))
        except ValidationError as exc:
            problems.append(f"line {lineno}: {_format_validation_error(exc)}")

    duplicates = [case_id for case_id, count in Counter(c.id for c in cases).items() if count > 1]
    for case_id in duplicates:
        problems.append(f"duplicate case id: {case_id!r}")
    if not cases and not problems:
        problems.append("golden file has no cases")
    if problems:
        raise GoldenSetError(f"{path}: " + "\n  ".join(["", *problems]))
    return cases


def coverage_shortfalls(cases: list[GoldenCase]) -> list[str]:
    """Return one line per behaviour the set covers less than :data:`MINIMUM_COVERAGE` asks."""
    counts = {
        "offtopic_refusals": sum(1 for c in cases if c.category == "offtopic" and c.must_refuse),
        "adversarial_refusals": sum(1 for c in cases if c.category == "adversarial" and c.must_refuse),
        "followups_with_history": sum(1 for c in cases if c.category == "followup" and c.history),
        "events": sum(1 for c in cases if c.category == "events"),
        "pricing": sum(1 for c in cases if c.category == "pricing"),
        "company_answered": sum(1 for c in cases if c.category == "company" and not c.must_refuse),
    }
    return [
        f"{name}: have {counts[name]}, need at least {minimum}"
        for name, minimum in MINIMUM_COVERAGE.items()
        if counts[name] < minimum
    ]


def plan_summary(cases: list[GoldenCase]) -> dict:
    """What a run of ``cases`` will do, without doing it. Used by ``--dry-run``."""
    per_category = Counter(c.category for c in cases)
    return {
        "cases": len(cases),
        "requests": sum(c.request_count for c in cases),
        "must_refuse": sum(1 for c in cases if c.must_refuse),
        "with_history": sum(1 for c in cases if c.history),
        "per_category": {category: per_category[category] for category in CATEGORIES if per_category[category]},
        "coverage_shortfalls": coverage_shortfalls(cases),
    }
