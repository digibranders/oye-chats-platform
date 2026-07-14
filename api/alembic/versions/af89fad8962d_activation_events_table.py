"""activation_events table

Revision ID: af89fad8962d
Revises: 4740e07b2f0b
Create Date: 2026-07-14 14:48:46.318460

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "af89fad8962d"
down_revision: str | Sequence[str] | None = "4740e07b2f0b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "activation_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("client_id", sa.Integer(), nullable=False),
        sa.Column("bot_id", sa.Integer(), nullable=True),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("event_data", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["bot_id"], ["bots.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_activation_events_client_id"), "activation_events", ["client_id"])
    op.create_index(op.f("ix_activation_events_event_type"), "activation_events", ["event_type"])
    op.create_index(op.f("ix_activation_events_created_at"), "activation_events", ["created_at"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_activation_events_created_at"), table_name="activation_events")
    op.drop_index(op.f("ix_activation_events_event_type"), table_name="activation_events")
    op.drop_index(op.f("ix_activation_events_client_id"), table_name="activation_events")
    op.drop_table("activation_events")
