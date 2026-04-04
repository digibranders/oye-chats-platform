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
    # Standard (non-CONCURRENT) index creation — safe inside Alembic's transaction.
    # CONCURRENTLY would avoid table locks but cannot run inside a transaction block,
    # which Alembic always uses. For a one-time migration these locks are negligible.
    op.create_index("ix_documents_bot_id", "documents", ["bot_id"], if_not_exists=True)
    op.create_index("ix_chat_sessions_bot_id", "chat_sessions", ["bot_id"], if_not_exists=True)
    op.create_index("ix_chat_messages_session_id", "chat_messages", ["session_id"], if_not_exists=True)


def downgrade() -> None:
    op.drop_index("ix_documents_bot_id", table_name="documents", if_exists=True)
    op.drop_index("ix_chat_sessions_bot_id", table_name="chat_sessions", if_exists=True)
    op.drop_index("ix_chat_messages_session_id", table_name="chat_messages", if_exists=True)
