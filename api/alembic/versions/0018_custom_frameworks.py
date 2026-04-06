"""add custom qualification framework fields

Revision ID: 0018_custom_frameworks
Revises: 0017_webhook_system
Create Date: 2026-04-06

"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0018_custom_frameworks"
down_revision = "0017_webhook_system"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("chat_sessions", sa.Column("dimension_scores", JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column(
        "chat_sessions",
        sa.Column("qualification_framework", sa.String(), nullable=False, server_default="bant"),
    )

    op.execute(
        sa.text(
            """
            UPDATE chat_sessions
            SET dimension_scores = jsonb_build_object(
                'need', jsonb_build_object('score', bant_need_score, 'value', COALESCE(bant_need, '')),
                'budget', jsonb_build_object('score', bant_budget_score, 'value', COALESCE(bant_budget, '')),
                'authority', jsonb_build_object('score', bant_authority_score, 'value', COALESCE(bant_authority, '')),
                'timeline', jsonb_build_object('score', bant_timeline_score, 'value', COALESCE(bant_timeline, ''))
            )
            WHERE bant_score > 0
            """
        )
    )


def downgrade() -> None:
    op.drop_column("chat_sessions", "qualification_framework")
    op.drop_column("chat_sessions", "dimension_scores")
