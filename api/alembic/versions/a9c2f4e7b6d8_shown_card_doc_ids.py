"""Add shown_card_doc_ids JSONB to chat_sessions for per-source media dedupe.

The RAG pipeline emits at most one media card ([YOUTUBE_CARD:…] /
[DOWNLOAD_CARD:…]) per turn. Product requirement: also at most one media
card per SOURCE DOCUMENT per session — re-asking the same topic in a
later turn should still produce a text answer but not re-render the same
card. The LLM cannot enforce this on its own (chat history is truncated
and it does not know which cards were already rendered), so the server
tracks the document ids whose cards have been shown.

Shape: list[int] of ``documents.id``. Nullable — an empty session
carries NULL rather than ``[]`` to keep the row narrow.

Revision ID: a9c2f4e7b6d8
Revises: a4d7f2c8e5b1
Create Date: 2026-07-13
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "a9c2f4e7b6d8"
down_revision = "a4d7f2c8e5b1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column(
            "shown_card_doc_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("chat_sessions", "shown_card_doc_ids")
