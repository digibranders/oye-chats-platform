"""chat_messages.is_unanswered - knowledge-gap flag

Adds ``chat_messages.is_unanswered`` - True on a bot turn that hit the
no-info pivot (could not be answered from the knowledge base: the relevance
gate fired on an on-scope question, or retrieval returned nothing). Powers
the Knowledge-gaps analytics, which pairs each flagged bot message with the
user question that preceded it.

No backfill: a historical pivot is indistinguishable from a normal answer
after the fact, so pre-existing rows correctly stay False.

Revision ID: c4a9e2f7b8d1
Revises: f2b8c4d61e93
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c4a9e2f7b8d1"
down_revision: str | Sequence[str] | None = "b3f9d1c68a24"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "chat_messages",
        sa.Column("is_unanswered", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_chat_messages_is_unanswered", "chat_messages", ["is_unanswered"])


def downgrade() -> None:
    op.drop_index("ix_chat_messages_is_unanswered", table_name="chat_messages")
    op.drop_column("chat_messages", "is_unanswered")
