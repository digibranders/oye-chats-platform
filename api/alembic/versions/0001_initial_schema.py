"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-03-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # pgvector extension
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # clients
    op.create_table(
        "clients",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("hashed_password", sa.String(), nullable=False),
        sa.Column("api_key", sa.String(), nullable=False),
        sa.Column("is_superadmin", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("max_bots", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("system_prompt", sa.Text(), nullable=True),
        sa.Column("website", sa.String(), nullable=True),
        sa.Column("bot_name", sa.String(), nullable=True),
        sa.Column("bot_logo", sa.Text(), nullable=True),
        sa.Column("launcher_name", sa.String(), nullable=True),
        sa.Column("launcher_logo", sa.Text(), nullable=True),
        sa.Column("primary_color", sa.String(), nullable=True),
        sa.Column("background_color", sa.String(), nullable=True),
        sa.Column("header_color", sa.String(), nullable=True),
        sa.Column("recommended_colors", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_clients_email", "clients", ["email"], unique=True)
    op.create_index("ix_clients_api_key", "clients", ["api_key"], unique=True)

    # bots
    op.create_table(
        "bots",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("bot_key", sa.String(), nullable=False),
        sa.Column("name", sa.String(), server_default="AI Assistant"),
        sa.Column("system_prompt", sa.Text(), nullable=True),
        sa.Column("website", sa.String(), nullable=True),
        sa.Column("bot_logo", sa.Text(), nullable=True),
        sa.Column("launcher_name", sa.String(), server_default="Have Questions?"),
        sa.Column("launcher_logo", sa.Text(), nullable=True),
        sa.Column("primary_color", sa.String(), server_default="#ba68c8"),
        sa.Column("background_color", sa.String(), server_default="#ffffff"),
        sa.Column("header_color", sa.String(), server_default="#3A0CA3"),
        sa.Column("recommended_colors", postgresql.JSONB(), nullable=True),
        sa.Column("bant_enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("avatar_type", sa.String(), nullable=False, server_default="upload"),
        sa.Column("orb_color", sa.String(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bots_bot_key", "bots", ["bot_key"], unique=True)

    # documents
    op.create_table(
        "documents",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=True),
        sa.Column("bot_id", sa.Integer(), sa.ForeignKey("bots.id", ondelete="CASCADE"), nullable=True),
        sa.Column("document_name", sa.String(), nullable=False),
        sa.Column("file_hash", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("metadata_info", postgresql.JSONB(), nullable=True),
        sa.Column("search_vector", postgresql.TSVECTOR()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )
    # pgvector column — alembic doesn't support vector() type natively
    op.execute("ALTER TABLE documents ADD COLUMN embedding vector(384) NOT NULL")
    op.create_index("ix_documents_file_hash", "documents", ["file_hash"])
    op.create_index("ix_documents_search_vector", "documents", ["search_vector"], postgresql_using="gin")

    # chat_sessions
    op.create_table(
        "chat_sessions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=True),
        sa.Column("bot_id", sa.Integer(), sa.ForeignKey("bots.id", ondelete="CASCADE"), nullable=True),
        sa.Column("location", sa.String(), nullable=True),
        sa.Column("device", sa.String(), nullable=True),
        sa.Column("bant_need", sa.Text(), nullable=True),
        sa.Column("bant_timeline", sa.String(), nullable=True),
        sa.Column("bant_authority", sa.String(), nullable=True),
        sa.Column("bant_budget", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("last_active_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )

    # chat_messages
    op.create_table(
        "chat_messages",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("session_id", sa.String(), sa.ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("feedback", sa.Integer(), nullable=True),
        sa.Column("trace_id", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("chat_messages")
    op.drop_table("chat_sessions")
    op.drop_table("documents")
    op.drop_table("bots")
    op.drop_table("clients")
    op.execute("DROP EXTENSION IF EXISTS vector")
