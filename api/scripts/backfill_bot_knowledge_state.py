"""Repair bots whose durable "trained" counters disagree with their content.

DRY-RUN BY DEFAULT. Pass ``--execute`` to write.

Background: ``Bot.indexed_chunk_count`` drives every "is my AI trained?" surface
in the dashboard (the agent Overview health card, the Knowledge base snapshot).
It used to be written only by the crawl orchestrator's terminal callback, and
only when *that crawl* produced new chunks. Three real paths therefore left a
fully-trained bot reading "Nothing learned yet" forever:

1. **Document uploads.** They run no crawl, so nothing ever stamped the counter.
2. **Delta recrawls of an unchanged site.** SHA-256 dedup skips every page, so
   the crawl ingests zero new chunks and the stamp was skipped — even though the
   crawl correctly reported ``done`` because the bot already held content.
3. **Best-effort write failures.** The stamp is wrapped in a swallowed
   ``except``, so a transient DB error silently lost it.

Deletes had the mirror problem: removing the last source left the counter high,
so the dashboard kept claiming the AI was trained on content that was gone.

All four are fixed going forward (``repository.sync_bot_knowledge_state`` now
recomputes from the documents table after every knowledge mutation), but rows
written before the fix stay wrong until something touches them again. This
script reconciles them in one pass.

Usage:
    cd api && uv run python scripts/backfill_bot_knowledge_state.py
    cd api && uv run python scripts/backfill_bot_knowledge_state.py --execute
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.models import Bot  # noqa: E402
from app.db.repository import count_documents_for_bot  # noqa: E402
from app.db.session import get_session  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--execute", action="store_true", help="Write the corrected counters (default: dry run).")
    args = parser.parse_args()

    drifted: list[tuple[int, str, int, int]] = []
    with get_session() as session:
        bots = session.query(Bot).order_by(Bot.id).all()
        for bot in bots:
            actual = count_documents_for_bot(session, bot_id=bot.id)
            stored = bot.indexed_chunk_count or 0
            if actual == stored:
                continue
            drifted.append((bot.id, bot.name or "(unnamed)", stored, actual))
            if args.execute:
                # Mirror sync_bot_knowledge_state's timestamp rule: a bot with
                # content gets a completion stamp, one without loses it, so
                # "trained at" can never outlive the knowledge it refers to.
                from app.db.repository import sync_bot_knowledge_state

                sync_bot_knowledge_state(session, bot.id)
        if args.execute and drifted:
            session.commit()

    if not drifted:
        print(f"All {len(bots)} bots already consistent — nothing to do.")
        return 0

    verb = "Corrected" if args.execute else "Would correct"
    print(f"{verb} {len(drifted)} of {len(bots)} bots:\n")
    print(f"{'BOT':>6}  {'NAME':<32} {'STORED':>8} → {'ACTUAL':>8}")
    for bot_id, name, stored, actual in drifted:
        flag = "  ← claimed untrained" if stored == 0 and actual > 0 else ""
        print(f"{bot_id:>6}  {name[:32]:<32} {stored:>8} → {actual:>8}{flag}")
    if not args.execute:
        print("\nDry run — re-run with --execute to write these values.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
