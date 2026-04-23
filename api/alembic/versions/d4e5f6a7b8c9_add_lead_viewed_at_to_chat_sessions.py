"""Add lead_viewed_at to chat_sessions for unread-leads tracking.

Adds a nullable timestamp column used to power the sidebar "Leads" badge
and the per-row "unread" indicator on /leads. A partial index on
(bot_id) WHERE lead_viewed_at IS NULL keeps the poll-heavy stats query
cheap. The backfill marks every existing session as already-viewed so
that rolling this out does not spike the badge for busy workspaces.

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-04-23
"""

import sqlalchemy as sa

from alembic import op

revision = "d4e5f6a7b8c9"
down_revision = "c3d4e5f6a7b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Add the nullable column — O(1) on Postgres for nullable columns.
    op.add_column(
        "chat_sessions",
        sa.Column("lead_viewed_at", sa.DateTime(timezone=True), nullable=True),
    )

    # 2. Backfill existing rows to "already viewed" so the rollout does
    #    not show hundreds of unread leads on first page load.
    op.execute("UPDATE chat_sessions SET lead_viewed_at = created_at WHERE lead_viewed_at IS NULL")

    # 3. Partial index — matches the hot `COUNT(*) WHERE lead_viewed_at IS NULL`
    #    query driven by the sidebar polling `/leads/stats`.
    op.create_index(
        "ix_chat_sessions_bot_id_lead_viewed_at",
        "chat_sessions",
        ["bot_id"],
        postgresql_where=sa.text("lead_viewed_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_chat_sessions_bot_id_lead_viewed_at",
        table_name="chat_sessions",
    )
    op.drop_column("chat_sessions", "lead_viewed_at")
