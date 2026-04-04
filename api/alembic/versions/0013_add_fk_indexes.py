"""Add indexes on high-cardinality FK columns used in every RAG query.

documents(bot_id), chat_sessions(bot_id), chat_messages(session_id) currently
lack dedicated indexes, causing full-table scans that compound as data grows.
Each of these columns is used as a WHERE filter in every chat request.

Revision ID: 0013
Revises: 0012
Create Date: 2026-04-04
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0013"
down_revision: str = "0012"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # CONCURRENTLY avoids locking the table on live deployments.
    # Note: op.create_index does not support CONCURRENTLY directly, so we use
    # raw SQL via execute() with the IF NOT EXISTS guard for idempotency.
    op.execute("CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_documents_bot_id ON documents (bot_id)")
    op.execute("CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_chat_sessions_bot_id ON chat_sessions (bot_id)")
    op.execute("CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_chat_messages_session_id ON chat_messages (session_id)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_documents_bot_id")
    op.execute("DROP INDEX IF EXISTS ix_chat_sessions_bot_id")
    op.execute("DROP INDEX IF EXISTS ix_chat_messages_session_id")
