"""Add lead capture, live chat, and email notification features

Revision ID: 0002
Revises: 0001
Create Date: 2026-03-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── Agents table ──
    op.create_table(
        "agents",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("is_online", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )

    # ── Lead info table ──
    op.create_table(
        "lead_info",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "session_id",
            sa.String(),
            sa.ForeignKey("chat_sessions.id", ondelete="CASCADE"),
            unique=True,
            nullable=False,
        ),
        sa.Column("bot_id", sa.Integer(), sa.ForeignKey("bots.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column("phone", sa.String(), nullable=True),
        sa.Column("company", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )

    # ── Bot table: lead form + email notification + live chat settings ──
    op.add_column("bots", sa.Column("lead_form_enabled", sa.Boolean(), server_default="false", nullable=False))
    op.add_column("bots", sa.Column("lead_form_fields", postgresql.JSONB(), nullable=True))
    op.add_column("bots", sa.Column("notification_email", sa.String(), nullable=True))
    op.add_column("bots", sa.Column("email_on_qualified", sa.Boolean(), server_default="true", nullable=False))
    op.add_column("bots", sa.Column("email_on_handoff", sa.Boolean(), server_default="true", nullable=False))
    op.add_column("bots", sa.Column("agent_timeout_seconds", sa.Integer(), server_default="120", nullable=False))

    # ── ChatSession: live chat state ──
    op.add_column("chat_sessions", sa.Column("status", sa.String(), server_default="bot", nullable=False))
    op.add_column(
        "chat_sessions",
        sa.Column("assigned_agent_id", sa.Integer(), sa.ForeignKey("agents.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column("chat_sessions", sa.Column("handoff_reason", sa.Text(), nullable=True))


def downgrade() -> None:
    # ── ChatSession columns ──
    op.drop_column("chat_sessions", "handoff_reason")
    op.drop_column("chat_sessions", "assigned_agent_id")
    op.drop_column("chat_sessions", "status")

    # ── Bot columns ──
    op.drop_column("bots", "agent_timeout_seconds")
    op.drop_column("bots", "email_on_handoff")
    op.drop_column("bots", "email_on_qualified")
    op.drop_column("bots", "notification_email")
    op.drop_column("bots", "lead_form_fields")
    op.drop_column("bots", "lead_form_enabled")

    # ── Tables ──
    op.drop_table("lead_info")
    op.drop_table("agents")
