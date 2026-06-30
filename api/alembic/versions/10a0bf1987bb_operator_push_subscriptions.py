"""operator push subscriptions

Creates ``operator_push_subscriptions`` — one row per browser/device an
operator has granted Web Push permission on. Used to fan out push
notifications when a visitor enters the live-chat queue and no operator has
an active WebSocket connection on the admin dashboard.

Revision ID: 10a0bf1987bb
Revises: d52e4e4c6723
Create Date: 2026-06-29
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "10a0bf1987bb"
down_revision: str | Sequence[str] | None = "d52e4e4c6723"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "operator_push_subscriptions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "operator_id",
            sa.Integer(),
            sa.ForeignKey("operators.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.String(), nullable=False),
        sa.Column("auth", sa.String(), nullable=False),
        sa.Column("user_agent", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("endpoint", name="uq_operator_push_endpoint"),
    )
    op.create_index(
        "ix_operator_push_subscriptions_operator_id",
        "operator_push_subscriptions",
        ["operator_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_operator_push_subscriptions_operator_id",
        table_name="operator_push_subscriptions",
    )
    op.drop_table("operator_push_subscriptions")
