"""
Multi-Bot DATA Migration Script
================================
Run this ONCE after applying Alembic migrations (`alembic upgrade head`).

Usage:
    cd Backend
    python -m app.db.migrate_to_multibot          # live run
    python -m app.db.migrate_to_multibot --dry-run # preview only

What it does (DATA only — schema is handled by Alembic):
1. For each Client without a Bot, creates a default Bot copying that client's settings
2. Backfills bot_id on all documents and chat_sessions that still have NULL bot_id
3. Reports results

Prerequisites:
  - Alembic migration 7416036ea87e ("Added multiple bots") must be applied first
  - The 'bots' table must exist

This script is IDEMPOTENT — safe to run multiple times.
"""

import sys
import uuid
import logging
from sqlalchemy import text, inspect, select
from app.db.session import engine, get_session
from app.db.models import Base, Client, Bot

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
logger = logging.getLogger("multibot_migration")


def _verify_schema():
    """Verify Alembic migrations have been applied before running data migration."""
    inspector = inspect(engine)
    tables = inspector.get_table_names()

    errors = []
    if "bots" not in tables:
        errors.append("Table 'bots' does not exist")

    if "documents" in tables:
        doc_cols = [c["name"] for c in inspector.get_columns("documents")]
        if "bot_id" not in doc_cols:
            errors.append("Column 'documents.bot_id' missing")

    if "chat_sessions" in tables:
        cs_cols = [c["name"] for c in inspector.get_columns("chat_sessions")]
        if "bot_id" not in cs_cols:
            errors.append("Column 'chat_sessions.bot_id' missing")

    if "clients" in tables:
        cl_cols = [c["name"] for c in inspector.get_columns("clients")]
        if "max_bots" not in cl_cols:
            errors.append("Column 'clients.max_bots' missing")

    if errors:
        logger.error("Schema verification FAILED. Run 'alembic upgrade head' first.")
        for e in errors:
            logger.error(f"  - {e}")
        return False

    logger.info("Schema verification passed")
    return True


def _create_default_bots(dry_run=False):
    """Create a default Bot for each Client that doesn't have one yet."""
    created = []

    with get_session() as session:
        clients = session.execute(select(Client)).scalars().all()

        for client in clients:
            existing_bot = session.execute(
                select(Bot.id).where(Bot.client_id == client.id).limit(1)
            ).scalar()

            if existing_bot:
                logger.info(f"  Client {client.id} ({client.name}) -> already has bot {existing_bot}")
                continue

            # Read settings from legacy Client columns
            # Using getattr so this still works if columns are removed from the model
            bot_data = {
                "client_id": client.id,
                "bot_key": f"bot-{uuid.uuid4().hex[:12]}",
                "name": getattr(client, 'bot_name', None) or "AI Assistant",
                "system_prompt": getattr(client, 'system_prompt', None),
                "website": getattr(client, 'website', None),
                "bot_logo": getattr(client, 'bot_logo', None),
                "launcher_name": getattr(client, 'launcher_name', None) or "Have Questions?",
                "launcher_logo": getattr(client, 'launcher_logo', None),
                "primary_color": getattr(client, 'primary_color', None) or "#ba68c8",
                "background_color": getattr(client, 'background_color', None) or "#ffffff",
                "header_color": getattr(client, 'header_color', None) or "#3A0CA3",
                "recommended_colors": getattr(client, 'recommended_colors', None),
                "is_active": True,
            }

            if dry_run:
                logger.info(f"  [DRY RUN] Would create bot for client {client.id} ({client.name}): key={bot_data['bot_key']}")
                created.append(bot_data)
                continue

            new_bot = Bot(**bot_data)
            session.add(new_bot)
            session.flush()  # get the ID
            created.append({"client_id": client.id, "bot_id": new_bot.id, "bot_key": new_bot.bot_key})
            logger.info(f"  Created bot {new_bot.id} (key: {new_bot.bot_key}) for client {client.id} ({client.name})")

        if not dry_run:
            session.commit()

    return created


def _backfill_bot_ids(dry_run=False):
    """Assign bot_id to documents and chat_sessions that still have NULL bot_id."""

    with get_session() as session:
        # Preview counts
        orphan_docs = session.execute(
            text("SELECT COUNT(*) FROM documents WHERE bot_id IS NULL AND client_id IS NOT NULL")
        ).scalar()
        orphan_sessions = session.execute(
            text("SELECT COUNT(*) FROM chat_sessions WHERE bot_id IS NULL AND client_id IS NOT NULL")
        ).scalar()

        logger.info(f"  Documents needing backfill: {orphan_docs}")
        logger.info(f"  Chat sessions needing backfill: {orphan_sessions}")

        if dry_run:
            logger.info("  [DRY RUN] No changes made")
            return orphan_docs, orphan_sessions

        # Backfill documents
        docs_result = session.execute(text("""
            UPDATE documents d
            SET bot_id = (
                SELECT b.id FROM bots b
                WHERE b.client_id = d.client_id
                ORDER BY b.id LIMIT 1
            )
            WHERE d.bot_id IS NULL AND d.client_id IS NOT NULL
        """))
        docs_updated = docs_result.rowcount
        session.commit()

        # Backfill chat_sessions
        sessions_result = session.execute(text("""
            UPDATE chat_sessions cs
            SET bot_id = (
                SELECT b.id FROM bots b
                WHERE b.client_id = cs.client_id
                ORDER BY b.id LIMIT 1
            )
            WHERE cs.bot_id IS NULL AND cs.client_id IS NOT NULL
        """))
        sessions_updated = sessions_result.rowcount
        session.commit()

        return docs_updated, sessions_updated


def _print_summary():
    """Print final state of the database."""
    with get_session() as session:
        total_clients = session.execute(text("SELECT COUNT(*) FROM clients")).scalar()
        total_bots = session.execute(text("SELECT COUNT(*) FROM bots")).scalar()
        orphan_docs = session.execute(text("SELECT COUNT(*) FROM documents WHERE bot_id IS NULL")).scalar()
        orphan_sessions = session.execute(text("SELECT COUNT(*) FROM chat_sessions WHERE bot_id IS NULL")).scalar()
        total_docs = session.execute(text("SELECT COUNT(*) FROM documents")).scalar()
        total_sessions = session.execute(text("SELECT COUNT(*) FROM chat_sessions")).scalar()

        logger.info(f"  Clients:        {total_clients}")
        logger.info(f"  Bots:           {total_bots}")
        logger.info(f"  Documents:      {total_docs} (orphaned: {orphan_docs})")
        logger.info(f"  Chat Sessions:  {total_sessions} (orphaned: {orphan_sessions})")

        if orphan_docs == 0 and orphan_sessions == 0:
            logger.info("All data successfully migrated!")
        elif total_docs == 0 and total_sessions == 0:
            logger.info("No existing data to migrate — fresh database")
        else:
            logger.warning("Some records still have no bot_id — investigate manually")


def run_migration(dry_run=False):
    mode = "DRY RUN" if dry_run else "LIVE"
    logger.info("=" * 60)
    logger.info(f"MULTI-BOT DATA MIGRATION ({mode})")
    logger.info("=" * 60)

    # Step 0: Verify schema
    logger.info("\n[Step 0] Verifying schema...")
    if not _verify_schema():
        logger.error("Aborting. Fix schema issues first.")
        sys.exit(1)

    # Step 1: Create default bots
    logger.info("\n[Step 1] Creating default bots for clients without one...")
    created = _create_default_bots(dry_run=dry_run)
    logger.info(f"  -> {len(created)} bot(s) {'would be ' if dry_run else ''}created")

    # Step 2: Backfill bot_id
    logger.info("\n[Step 2] Backfilling bot_id on documents & chat_sessions...")
    docs, sessions = _backfill_bot_ids(dry_run=dry_run)
    logger.info(f"  -> Documents: {docs}, Chat Sessions: {sessions}")

    # Step 3: Summary
    logger.info("\n" + "=" * 60)
    logger.info("SUMMARY")
    logger.info("=" * 60)
    _print_summary()


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    run_migration(dry_run=dry)
