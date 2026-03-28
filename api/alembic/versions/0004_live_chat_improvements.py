"""Live chat improvements: departments, multi-agent auth, offline messages, canned responses

Revision ID: 0004
Revises: 0003
Create Date: 2026-03-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. Create departments table
    op.create_table(
        "departments",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # 2. Extend agents table
    op.add_column("agents", sa.Column("hashed_password", sa.String(), nullable=True))
    op.add_column("agents", sa.Column("agent_api_key", sa.String(), nullable=True))
    op.add_column("agents", sa.Column("role", sa.String(), server_default="agent", nullable=False))
    op.add_column(
        "agents",
        sa.Column("department_id", sa.Integer(), sa.ForeignKey("departments.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column("agents", sa.Column("avatar_url", sa.String(), nullable=True))
    op.add_column("agents", sa.Column("max_concurrent_chats", sa.Integer(), server_default="5", nullable=False))
    op.add_column("agents", sa.Column("notification_preferences", JSONB(), nullable=True))
    op.create_index("ix_agents_agent_api_key", "agents", ["agent_api_key"], unique=True)

    # 3. Extend chat_sessions table
    op.add_column(
        "chat_sessions",
        sa.Column("department_id", sa.Integer(), sa.ForeignKey("departments.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column("chat_sessions", sa.Column("visitor_metadata", JSONB(), nullable=True))

    # 4. Create offline_messages table
    op.create_table(
        "offline_messages",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("bot_id", sa.Integer(), sa.ForeignKey("bots.id", ondelete="CASCADE"), nullable=False),
        sa.Column("session_id", sa.String(), sa.ForeignKey("chat_sessions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("department_id", sa.Integer(), sa.ForeignKey("departments.id", ondelete="SET NULL"), nullable=True),
        sa.Column("visitor_name", sa.String(), nullable=False),
        sa.Column("visitor_email", sa.String(), nullable=False),
        sa.Column("visitor_phone", sa.String(), nullable=True),
        sa.Column("message_body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(), server_default="new", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("replied_at", sa.DateTime(timezone=True), nullable=True),
    )

    # 5. Create canned_responses table
    op.create_table(
        "canned_responses",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("shortcut", sa.String(), nullable=True),
        sa.Column("category", sa.String(), nullable=True),
        sa.Column("created_by_agent_id", sa.Integer(), sa.ForeignKey("agents.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("canned_responses")
    op.drop_table("offline_messages")
    op.drop_column("chat_sessions", "visitor_metadata")
    op.drop_column("chat_sessions", "department_id")
    op.drop_index("ix_agents_agent_api_key", table_name="agents")
    op.drop_column("agents", "notification_preferences")
    op.drop_column("agents", "max_concurrent_chats")
    op.drop_column("agents", "avatar_url")
    op.drop_column("agents", "department_id")
    op.drop_column("agents", "role")
    op.drop_column("agents", "agent_api_key")
    op.drop_column("agents", "hashed_password")
    op.drop_table("departments")
