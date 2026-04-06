"""add BANT v2 scoring schema

Revision ID: 0015_bant_v2_scoring
Revises: 0014_add_bot_message_fields
Create Date: 2026-04-06

"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0015_bant_v2_scoring"
down_revision = "0014_add_bot_message_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column("bant_need_score", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("bant_budget_score", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("bant_authority_score", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("bant_timeline_score", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("bant_score", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("bant_tier", sa.String(), nullable=False, server_default="unqualified"),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("dimensions_assessed", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("bant_last_updated", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "bant_signals",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("session_id", sa.String(), nullable=False),
        sa.Column("message_id", sa.Integer(), nullable=True),
        sa.Column("dimension", sa.String(), nullable=False),
        sa.Column("signal_text", sa.Text(), nullable=False),
        sa.Column("extracted_value", sa.Text(), nullable=True),
        sa.Column("confidence", sa.String(), nullable=False, server_default="medium"),
        sa.Column("score_before", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("score_after", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.ForeignKeyConstraint(["message_id"], ["chat_messages.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["session_id"], ["chat_sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bant_signals_session_id", "bant_signals", ["session_id"], unique=False)

    op.add_column("bots", sa.Column("bant_config", JSONB(astext_type=sa.Text()), nullable=True))

    op.execute(sa.text("UPDATE chat_sessions SET bant_need_score = 15 WHERE bant_need IS NOT NULL AND bant_need != ''"))
    op.execute(
        sa.text("UPDATE chat_sessions SET bant_budget_score = 15 WHERE bant_budget IS NOT NULL AND bant_budget != ''")
    )
    op.execute(
        sa.text(
            "UPDATE chat_sessions SET bant_authority_score = 15 WHERE bant_authority IS NOT NULL AND bant_authority != ''"
        )
    )
    op.execute(
        sa.text(
            "UPDATE chat_sessions SET bant_timeline_score = 15 WHERE bant_timeline IS NOT NULL AND bant_timeline != ''"
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE chat_sessions
            SET bant_score = bant_need_score + bant_budget_score + bant_authority_score + bant_timeline_score
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE chat_sessions
            SET dimensions_assessed =
                (CASE WHEN bant_need IS NOT NULL AND bant_need != '' THEN 1 ELSE 0 END +
                 CASE WHEN bant_budget IS NOT NULL AND bant_budget != '' THEN 1 ELSE 0 END +
                 CASE WHEN bant_authority IS NOT NULL AND bant_authority != '' THEN 1 ELSE 0 END +
                 CASE WHEN bant_timeline IS NOT NULL AND bant_timeline != '' THEN 1 ELSE 0 END)
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE chat_sessions
            SET bant_tier =
                CASE
                    WHEN bant_score >= 75 THEN 'sql'
                    WHEN bant_score >= 55 THEN 'sal'
                    WHEN bant_score >= 30 THEN 'mql'
                    ELSE 'unqualified'
                END
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE chat_sessions
            SET bant_last_updated = last_active_at
            WHERE (bant_need IS NOT NULL AND bant_need != '')
               OR (bant_budget IS NOT NULL AND bant_budget != '')
               OR (bant_authority IS NOT NULL AND bant_authority != '')
               OR (bant_timeline IS NOT NULL AND bant_timeline != '')
            """
        )
    )


def downgrade() -> None:
    op.drop_column("bots", "bant_config")

    op.drop_index("ix_bant_signals_session_id", table_name="bant_signals")
    op.drop_table("bant_signals")

    op.drop_column("chat_sessions", "bant_last_updated")
    op.drop_column("chat_sessions", "dimensions_assessed")
    op.drop_column("chat_sessions", "bant_tier")
    op.drop_column("chat_sessions", "bant_score")
    op.drop_column("chat_sessions", "bant_timeline_score")
    op.drop_column("chat_sessions", "bant_authority_score")
    op.drop_column("chat_sessions", "bant_budget_score")
    op.drop_column("chat_sessions", "bant_need_score")
