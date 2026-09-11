"""Report knowledge-base chunks that look like junk for one bot. READ-ONLY.

Usage (production, as the service user, with explicit approval):
    cd /opt/oyechats/platform/api && sudo -u oyechats .venv/bin/python scripts/kb_junk_report.py --bot-id 5

Usage (local):
    uv run python scripts/kb_junk_report.py --bot-id 5

Pass --include-examples to also list placeholder text that sits inside a
code or documentation example (a CLI flag, a JSON/YAML sample, a shell
snippet); those are left out of the main report by default because they
are usually correct documentation, not a leaked placeholder.

Nothing is deleted, updated, or committed. This script only reads. Share the
report with the bot owner; removal happens through the console's own document
delete, with the owner's consent.

Never prints chunk content: a chunk can hold personal data (an email, a
phone number, a name in the middle of a sentence). Only the document id,
its name (for a crawled page this is the source URL), and the detector
reasons are printed.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field

from sqlalchemy import select

from app.db.models import Bot, Document
from app.db.session import get_session
from app.services.kb_quality import option_list_match, option_list_reason, placeholder_findings

#: Reason text for the place-name check: names a lot of places, but might be
#: a real coverage claim rather than a scraped picker, so it needs a human
#: to look before anything is removed.
PLACE_LIST_HEADER = "Many place names listed. Check whether this is a real coverage list before removing anything."
EXAMPLE_SECTION_HEADER = "placeholder text in code or documentation examples (usually correct)"


@dataclass(frozen=True)
class JunkFinding:
    """One suspicious chunk: enough to locate and judge it, never its content.

    ``reasons`` is the main-section list (a form picker, or a placeholder
    found outside any code/documentation example): review these first.
    ``place_list_reasons`` is the lower-priority "check before removing"
    section: a dense list of place names written as prose or a comma list,
    which may well be a real coverage claim. ``example_reasons`` is
    suppressed by default and only shown with ``--include-examples``: a
    placeholder value that sits inside a code or documentation example.
    """

    document_id: int
    document_name: str
    reasons: tuple[str, ...] = field(default_factory=tuple)
    place_list_reasons: tuple[str, ...] = field(default_factory=tuple)
    example_reasons: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class JunkScanResult:
    """The findings from one scan, plus how many active chunks were looked at.

    ``scanned_count`` lets the caller tell "this bot's knowledge base is
    clean" apart from "this bot id scanned nothing" (an empty or missing
    bot), which a bare empty findings list cannot.
    """

    findings: list[JunkFinding]
    scanned_count: int


def find_junk_chunks(session, bot_id: int) -> JunkScanResult:
    """Scan every active chunk of ``bot_id`` and return the suspicious ones.

    Read-only: a plain ``SELECT``, no writes, no commit. Streams rows in
    batches (``yield_per``) so a large knowledge base is never loaded into
    memory all at once.
    """
    findings: list[JunkFinding] = []
    scanned_count = 0
    stmt = (
        select(Document.id, Document.document_name, Document.content)
        .where(Document.bot_id == bot_id, Document.is_active.is_(True))
        .order_by(Document.id)
        .execution_options(yield_per=500)
    )
    for doc_id, document_name, raw_content in session.execute(stmt):
        scanned_count += 1
        content = raw_content or ""

        reasons: list[str] = []
        place_list_reasons: list[str] = []
        example_reasons: list[str] = []

        option_match = option_list_match(content)
        if option_match is not None:
            reason = option_list_reason(option_match)
            if option_match.kind == "form_options":
                reasons.append(reason)
            else:
                place_list_reasons.append(reason)

        for placeholder in placeholder_findings(content):
            label = f"placeholder ({placeholder.kind}): {placeholder.value}"
            if placeholder.in_example:
                example_reasons.append(label)
            else:
                reasons.append(label)

        if reasons or place_list_reasons or example_reasons:
            findings.append(
                JunkFinding(
                    document_id=doc_id,
                    document_name=document_name,
                    reasons=tuple(reasons),
                    place_list_reasons=tuple(place_list_reasons),
                    example_reasons=tuple(example_reasons),
                )
            )
    return JunkScanResult(findings=findings, scanned_count=scanned_count)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bot-id", type=int, required=True, help="Bot to scan.")
    parser.add_argument(
        "--include-examples",
        action="store_true",
        help="Also list placeholder text found inside a code or documentation example.",
    )
    args = parser.parse_args()

    with get_session() as session:
        bot_exists = session.execute(select(Bot.id).where(Bot.id == args.bot_id)).scalar_one_or_none()
        if bot_exists is None:
            print(f"Bot {args.bot_id} not found.")
            return 1
        result = find_junk_chunks(session, bot_id=args.bot_id)

    main_findings = [finding for finding in result.findings if finding.reasons]
    place_list_findings = [finding for finding in result.findings if finding.place_list_reasons]
    example_findings = [finding for finding in result.findings if finding.example_reasons]

    for finding in main_findings:
        print(f"chunk {finding.document_id} | {finding.document_name} | {'; '.join(finding.reasons)}")
    print(f"{len(main_findings)} suspicious of {result.scanned_count:,} active chunks for bot {args.bot_id}")

    if place_list_findings:
        print()
        print(PLACE_LIST_HEADER)
        for finding in place_list_findings:
            print(f"chunk {finding.document_id} | {finding.document_name} | {'; '.join(finding.place_list_reasons)}")

    if args.include_examples and example_findings:
        print()
        print(EXAMPLE_SECTION_HEADER)
        for finding in example_findings:
            print(f"chunk {finding.document_id} | {finding.document_name} | {'; '.join(finding.example_reasons)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
