"""add behavioral scoring fields and visitor_events table

Revision ID: 0016_behavioral_scoring
Revises: 0015_bant_v2_scoring
Create Date: 2026-04-06

"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0016_behavioral_scoring"
down_revision = "0015_bant_v2_scoring"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── New columns on chat_sessions for behavioral tracking ──
    op.add_column(
        "chat_sessions",
        sa.Column("behavioral_score", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("page_url", sa.String(), nullable=True),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("referrer", sa.String(), nullable=True),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("utm_params", JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("visit_count", sa.Integer(), nullable=False, server_default="1"),
    )

    # ── Add source column to bant_signals for CTA click tracking ──
    op.add_column(
        "bant_signals",
        sa.Column("source", sa.String(), nullable=False, server_default="llm"),
    )

    # ── Create visitor_events table ──
    op.create_table(
        "visitor_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("session_id", sa.String(), nullable=False),
        sa.Column("bot_id", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("event_data", JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.ForeignKeyConstraint(["session_id"], ["chat_sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["bot_id"], ["bots.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_visitor_events_session_id", "visitor_events", ["session_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_visitor_events_session_id", table_name="visitor_events")
    op.drop_table("visitor_events")
    op.drop_column("bant_signals", "source")
    op.drop_column("chat_sessions", "visit_count")
    op.drop_column("chat_sessions", "utm_params")
    op.drop_column("chat_sessions", "referrer")
    op.drop_column("chat_sessions", "page_url")
    op.drop_column("chat_sessions", "behavioral_score")
