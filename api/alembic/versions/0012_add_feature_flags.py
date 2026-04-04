"""Add feature_flags JSONB column to bots for per-bot widget/operator behavior toggles.

Revision ID: 0012
Revises: 0011
Create Date: 2026-04-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "0012"
down_revision: str = "0011"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "bots",
        sa.Column(
            "feature_flags",
            JSONB,
            nullable=False,
            server_default=sa.text(
                """'{"file_sharing": false, "post_chat_rating": true, "show_branding": true, "queue_position": false, "typing_preview": true, "email_transcript": false}'::jsonb"""
            ),
        ),
    )


def downgrade() -> None:
    op.drop_column("bots", "feature_flags")
