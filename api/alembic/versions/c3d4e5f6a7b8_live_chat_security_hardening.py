"""Live chat security hardening: CHECK constraints, indexes, operator is_active flag.

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-04-15
"""

import sqlalchemy as sa

from alembic import op

revision = "c3d4e5f6a7b8"
down_revision = "b2c3d4e5f6a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. Operator is_active flag ──
    op.add_column(
        "operators",
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
    )

    # ── 2. CHECK constraints ──
    op.create_check_constraint(
        "ck_chat_sessions_status",
        "chat_sessions",
        "status IN ('bot', 'waiting', 'live', 'closed')",
    )
    op.create_check_constraint(
        "ck_chat_sessions_visitor_rating",
        "chat_sessions",
        "visitor_rating IS NULL OR (visitor_rating >= 1 AND visitor_rating <= 5)",
    )
    op.create_check_constraint(
        "ck_chat_messages_role",
        "chat_messages",
        "role IN ('user', 'bot', 'operator', 'system')",
    )
    op.create_check_constraint(
        "ck_operators_role",
        "operators",
        "role IN ('owner', 'admin', 'operator')",
    )
    op.create_check_constraint(
        "ck_offline_messages_status",
        "offline_messages",
        "status IN ('new', 'read', 'replied')",
    )

    # ── 3. Performance indexes ──
    op.create_index(
        "ix_chat_sessions_bot_id_status",
        "chat_sessions",
        ["bot_id", "status"],
    )
    op.create_index(
        "ix_chat_sessions_assigned_operator_id",
        "chat_sessions",
        ["assigned_operator_id"],
    )
    op.create_index(
        "ix_chat_messages_session_id_created_at",
        "chat_messages",
        ["session_id", "created_at"],
    )
    op.create_index(
        "ix_chat_audit_logs_session_id",
        "chat_audit_logs",
        ["session_id"],
    )
    op.create_index(
        "ix_offline_messages_bot_id_status",
        "offline_messages",
        ["bot_id", "status"],
    )


def downgrade() -> None:
    # Drop indexes
    op.drop_index("ix_offline_messages_bot_id_status", table_name="offline_messages")
    op.drop_index("ix_chat_audit_logs_session_id", table_name="chat_audit_logs")
    op.drop_index("ix_chat_messages_session_id_created_at", table_name="chat_messages")
    op.drop_index("ix_chat_sessions_assigned_operator_id", table_name="chat_sessions")
    op.drop_index("ix_chat_sessions_bot_id_status", table_name="chat_sessions")

    # Drop CHECK constraints
    op.drop_constraint("ck_offline_messages_status", "offline_messages", type_="check")
    op.drop_constraint("ck_operators_role", "operators", type_="check")
    op.drop_constraint("ck_chat_messages_role", "chat_messages", type_="check")
    op.drop_constraint("ck_chat_sessions_visitor_rating", "chat_sessions", type_="check")
    op.drop_constraint("ck_chat_sessions_status", "chat_sessions", type_="check")

    # Drop is_active column
    op.drop_column("operators", "is_active")
