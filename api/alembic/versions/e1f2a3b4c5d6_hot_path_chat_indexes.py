"""Add hot-path composite indexes on chat_messages + chat_sessions

Confirmed on production via EXPLAIN and re-measured on a seeded 1.1M-row copy:
the two hottest chat queries sequentially scan their tables because their
primary access columns are unindexed.

  * chat_messages: filtered/sorted by (session_id, created_at DESC) on EVERY
    chat turn (history load) and by every per-session analytics join. Only
    ix_chat_messages_is_unanswered existed. Measured: 20.6ms seq scan -> 0.035ms
    index scan at 1.1M rows (588x).
  * chat_sessions: the dashboard/analytics owner filter is bot_id first
    (_session_owner_filter), sorted created_at DESC. Only ix_chat_sessions_client_id
    existed. Measured: 5.8ms parallel seq scan -> 0.57ms index scan (10x).

Both are pure-additive read optimisations — no data change, no behaviour change.

CREATE INDEX CONCURRENTLY so the build does not take an ACCESS EXCLUSIVE lock on
these hot, append-heavy tables (a plain CREATE INDEX would block all writes for
the duration on a large prod table). CONCURRENTLY cannot run inside a
transaction, so this migration disables the per-migration transaction via
op.get_context().autocommit_block() and uses IF NOT EXISTS for idempotency /
safe co-existence with any index created out-of-band during the audit.

Revision ID: e1f2a3b4c5d6
Revises: d5b1c8e2f394
Create Date: 2026-08-14
"""

from collections.abc import Sequence

from alembic import op

revision: str = "e1f2a3b4c5d6"
down_revision: str | Sequence[str] | None = "d5b1c8e2f394"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # CONCURRENTLY must run outside a transaction block.
    with op.get_context().autocommit_block():
        op.execute(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_chat_messages_session_id_created "
            "ON chat_messages (session_id, created_at DESC)"
        )
        op.execute(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_chat_sessions_bot_id_created "
            "ON chat_sessions (bot_id, created_at DESC)"
        )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_chat_sessions_bot_id_created")
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_chat_messages_session_id_created")
