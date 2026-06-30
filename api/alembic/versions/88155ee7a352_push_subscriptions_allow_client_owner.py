"""push subscriptions allow client owner

Extends ``operator_push_subscriptions`` so workspace owners (client logins)
can subscribe and receive pushes too — small teams where the owner is the
primary operator no longer need to create a separate operator account just
to get notifications.

Schema change:
  * ``operator_id`` becomes nullable
  * ``client_id`` is added (nullable FK to ``clients`` with ON DELETE CASCADE)
  * CHECK constraint enforces exactly one of (operator_id, client_id) is set

Backfill: none — the previous migration created the table empty.

Revision ID: 88155ee7a352
Revises: 10a0bf1987bb
Create Date: 2026-06-29
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "88155ee7a352"
down_revision: str | Sequence[str] | None = "10a0bf1987bb"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "operator_push_subscriptions",
        "operator_id",
        existing_type=sa.Integer(),
        nullable=True,
    )
    op.add_column(
        "operator_push_subscriptions",
        sa.Column(
            "client_id",
            sa.Integer(),
            sa.ForeignKey("clients.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_operator_push_subscriptions_client_id",
        "operator_push_subscriptions",
        ["client_id"],
    )
    op.create_check_constraint(
        "chk_push_subscription_owner_xor",
        "operator_push_subscriptions",
        # Exactly one of (operator_id, client_id) must be NOT NULL. Casting
        # the IS NULL booleans to int and summing keeps the constraint
        # readable + portable across PostgreSQL versions.
        "((operator_id IS NULL)::int + (client_id IS NULL)::int) = 1",
    )


def downgrade() -> None:
    op.drop_constraint(
        "chk_push_subscription_owner_xor",
        "operator_push_subscriptions",
        type_="check",
    )
    op.drop_index(
        "ix_operator_push_subscriptions_client_id",
        table_name="operator_push_subscriptions",
    )
    op.drop_column("operator_push_subscriptions", "client_id")
    op.alter_column(
        "operator_push_subscriptions",
        "operator_id",
        existing_type=sa.Integer(),
        nullable=False,
    )
