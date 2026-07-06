"""add index on chat_sessions.client_id (concurrently)

Audit F27: analytics queries filter chat_sessions by client_id (when bot_id is
absent) with no index → sequential scans that worsen as the table grows.

Audit F29 lesson applied: build the index with CREATE INDEX CONCURRENTLY OUTSIDE
a transaction so it doesn't take an ACCESS EXCLUSIVE lock on a large, hot table
for the duration of the build. This requires an autocommit block (CONCURRENTLY
cannot run inside a transaction) and IF NOT EXISTS so a re-run (or a table that
already got the index via create_all in a fresh env) is a no-op.

Revision ID: f4a1c2d3e5b7
Revises: c1e7a9d3f2b4
Create Date: 2026-07-06
"""

from alembic import op

revision = "f4a1c2d3e5b7"
down_revision = "c1e7a9d3f2b4"
branch_labels = None
depends_on = None

INDEX_NAME = "ix_chat_sessions_client_id"


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {INDEX_NAME} ON chat_sessions (client_id)")


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX_NAME}")
