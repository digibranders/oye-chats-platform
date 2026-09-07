"""Move bots onto the current embedding profile.

An embedding profile (``app/core/embedding_profiles.py``) records how a
vector was made. Rows that predate profiles are on the legacy one (no Gemini
task type); the current one embeds chunks as ``RETRIEVAL_DOCUMENT`` and
questions as ``RETRIEVAL_QUERY``. A bot answers from one profile at a time,
so moving it means re-embedding every chunk it owns and then flipping the bot,
which is what ``task_migrate_embedding_profile`` does, one bot at a time,
resumably, without ever ranking two vector spaces against each other.

By default this enqueues that task on the ARQ worker, where it can run for
hours against the shared embed rate limiter. ``--inline`` runs it in this
process instead (a box without a worker, or to watch one bot go through) and
prints the per-bot outcome.

Usage:
    cd api && uv run python scripts/migrate_embedding_profile.py --list        # what would run; changes nothing
    cd api && uv run python scripts/migrate_embedding_profile.py               # every bot that needs it, via the worker
    cd api && uv run python scripts/migrate_embedding_profile.py --bot-id 42   # one bot, via the worker
    cd api && uv run python scripts/migrate_embedding_profile.py --inline      # run here and print the summary

Re-running is safe: a bot already on the current profile reports
``already_current``, and a run that failed part-way resumes from the chunks
it had not yet committed.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import embedding_profile_service  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--bot-id", type=int, default=None, help="Migrate only this bot (default: every bot that needs it)."
    )
    parser.add_argument(
        "--inline", action="store_true", help="Run in this process instead of enqueueing on the worker."
    )
    parser.add_argument("--list", action="store_true", help="Print the bots that need migrating and exit.")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=embedding_profile_service.MIGRATION_BATCH,
        help="Chunks re-embedded per commit (default: %(default)s).",
    )
    args = parser.parse_args()
    if args.batch_size < 1:
        parser.error("--batch-size must be at least 1")

    if args.list:
        bot_ids = [args.bot_id] if args.bot_id is not None else embedding_profile_service.bots_needing_migration()
        print(f"{len(bot_ids)} bot(s) to migrate: {bot_ids}")
        return 0

    if args.inline:
        from app.worker.tasks import task_migrate_embedding_profile

        result = asyncio.run(task_migrate_embedding_profile({}, bot_id=args.bot_id, batch_size=args.batch_size))
        print(json.dumps(result, indent=2, default=str))
        return 0 if not result.get("failed") else 1

    from app.worker.enqueue import enqueue_sync

    job_id = enqueue_sync("task_migrate_embedding_profile", bot_id=args.bot_id, batch_size=args.batch_size)
    if job_id is None:
        print("A migration job is already queued; nothing enqueued.")
        return 0
    print(f"Enqueued task_migrate_embedding_profile (job_id={job_id}). Follow it in the worker log.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
