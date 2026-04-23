"""Add inline_cards_shown JSONB to chat_sessions for per-session card dedupe.

The RAG pipeline emits at most one `[LEAVE_MESSAGE_CARD]` per session (so the
visitor is not asked repeatedly to open a form they already saw). The LLM
cannot reliably enforce "at most once per conversation" on its own — it sees
truncated chat history and may re-emit. This column gives the server an
authoritative per-session record of which inline cards have already been
shown, enabling deterministic suppression.

Shape: {"leave_message": true, "meeting": true}. Kept narrow on purpose so
additional cards in the future slot in without another migration.

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-04-23
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "e5f6a7b8c9d0"
down_revision = "d4e5f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column(
            "inline_cards_shown",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("chat_sessions", "inline_cards_shown")
