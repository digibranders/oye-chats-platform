"""add media_card + media_secondary columns to chat_messages

Widget cards ([YOUTUBE_CARD:…] / [DOWNLOAD_CARD:…]) were shipped as a
transient FINAL_METADATA payload during streaming and never persisted —
so after a page refresh the widget's ``/chat/history`` fetch returned
only the sanitized text, and the video/document card silently vanished
from prior bot turns. Persisting the parsed card object (and the ≤1
opposite-type "Also available" chip) lets the widget re-hydrate cards
across sessions.

Both columns are nullable — pre-migration bot answers have no card, and
turns without a matching media asset stay null.

Revision ID: b2c4d6e8f0a1
Revises: a1e2v3ent4s5
Create Date: 2026-07-09
"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "b2c4d6e8f0a1"
down_revision = "a1e2v3ent4s5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "chat_messages",
        sa.Column("media_card", JSONB(), nullable=True),
    )
    op.add_column(
        "chat_messages",
        sa.Column("media_secondary", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_messages", "media_secondary")
    op.drop_column("chat_messages", "media_card")
