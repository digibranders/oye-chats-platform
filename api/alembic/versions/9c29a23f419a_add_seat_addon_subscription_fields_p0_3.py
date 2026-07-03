"""add seat_addon subscription fields (P0-3)

Revision ID: 9c29a23f419a
Revises: e8c4a6b2d9f1
Create Date: 2026-07-03 14:03:10.222470

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9c29a23f419a"
down_revision: str | Sequence[str] | None = "e8c4a6b2d9f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("subscriptions", sa.Column("seat_addon_subscription_id", sa.String(), nullable=True))
    op.add_column("subscriptions", sa.Column("seat_addon_quantity", sa.Integer(), server_default="0", nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("subscriptions", "seat_addon_quantity")
    op.drop_column("subscriptions", "seat_addon_subscription_id")
