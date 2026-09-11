"""Report knowledge-base chunks that look like junk for one bot. READ-ONLY.

Usage (production, as the service user, with explicit approval):
    cd /opt/oyechats/platform/api && sudo -u oyechats .venv/bin/python scripts/kb_junk_report.py --bot-id 5

Usage (local):
    uv run python scripts/kb_junk_report.py --bot-id 5

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
from dataclasses import dataclass

from sqlalchemy import select

from app.db.models import Document
from app.db.session import get_session
from app.services.kb_quality import is_option_list, placeholder_contacts


@dataclass(frozen=True)
class JunkFinding:
    """One suspicious chunk: enough to locate and judge it, never its content."""

    document_id: int
    document_name: str
    reasons: tuple[str, ...]


def find_junk_chunks(session, bot_id: int) -> list[JunkFinding]:
    """Scan every active chunk of ``bot_id`` and return the suspicious ones.

    Read-only: a plain ``SELECT``, no writes, no commit. Streams rows in
    batches (``yield_per``) so a large knowledge base is never loaded into
    memory all at once.
    """
    findings: list[JunkFinding] = []
    stmt = (
        select(Document.id, Document.document_name, Document.content)
        .where(Document.bot_id == bot_id, Document.is_active.is_(True))
        .order_by(Document.id)
        .execution_options(yield_per=500)
    )
    for doc_id, document_name, content in session.execute(stmt):
        reasons: list[str] = []
        if is_option_list(content or ""):
            reasons.append("option list (country/state dropdown)")
        reasons.extend(f"placeholder: {value}" for value in placeholder_contacts(content or ""))
        if reasons:
            findings.append(JunkFinding(document_id=doc_id, document_name=document_name, reasons=tuple(reasons)))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bot-id", type=int, required=True, help="Bot to scan.")
    args = parser.parse_args()

    with get_session() as session:
        findings = find_junk_chunks(session, bot_id=args.bot_id)

    for finding in findings:
        print(f"chunk {finding.document_id} | {finding.document_name} | {'; '.join(finding.reasons)}")
    print(f"{len(findings)} suspicious chunk(s) for bot {args.bot_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
