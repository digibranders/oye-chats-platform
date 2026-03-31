"""Rename agent to operator across all tables

Revision ID: 0008
Revises: 0007
Create Date: 2026-03-31
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0008"
down_revision: str = "0007"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # 1. Rename the agents table to operators
    op.rename_table("agents", "operators")

    # 2. Rename columns on the operators table
    op.alter_column("operators", "agent_api_key", new_column_name="operator_api_key")

    # 3. Rename FK columns on chat_sessions
    op.alter_column("chat_sessions", "assigned_agent_id", new_column_name="assigned_operator_id")

    # 4. Rename FK columns on canned_responses
    op.alter_column("canned_responses", "created_by_agent_id", new_column_name="created_by_operator_id")

    # 5. Rename column on bots
    op.alter_column("bots", "agent_timeout_seconds", new_column_name="operator_timeout_seconds")

    # 6. Update role values in operators table
    op.execute("UPDATE operators SET role = 'operator' WHERE role = 'agent'")

    # 7. Update message role values in chat_messages
    op.execute("UPDATE chat_messages SET role = 'operator' WHERE role = 'agent'")

    # 8. Rename index on operator_api_key (Postgres syntax)
    op.execute("ALTER INDEX IF EXISTS ix_agents_agent_api_key RENAME TO ix_operators_operator_api_key")


def downgrade() -> None:
    # Reverse index rename
    op.execute("ALTER INDEX IF EXISTS ix_operators_operator_api_key RENAME TO ix_agents_agent_api_key")

    # Reverse data updates
    op.execute("UPDATE chat_messages SET role = 'agent' WHERE role = 'operator'")
    op.execute("UPDATE operators SET role = 'agent' WHERE role = 'operator'")

    # Reverse column renames
    op.alter_column("bots", "operator_timeout_seconds", new_column_name="agent_timeout_seconds")
    op.alter_column("canned_responses", "created_by_operator_id", new_column_name="created_by_agent_id")
    op.alter_column("chat_sessions", "assigned_operator_id", new_column_name="assigned_agent_id")
    op.alter_column("operators", "operator_api_key", new_column_name="agent_api_key")

    # Rename table back
    op.rename_table("operators", "agents")
