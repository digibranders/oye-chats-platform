"""Add relevance_threshold to bots for per-bot CRAG gate tuning.

Lets each customer override the env-default relevance threshold (0.55)
without a redeploy. NULL keeps the env default. Out-of-range values are
clamped at runtime so a bad write can never disable the gate or pin it
above any achievable score.

Revision ID: a8b9c0d1e2f3
Revises: f6a7b8c9d0e1
Create Date: 2026-04-27
"""

import sqlalchemy as sa

from alembic import op

revision = "a8b9c0d1e2f3"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable Float — O(1) on Postgres, no rewrite. NULL means "use the
    # env default" so existing rows behave exactly as before until an
    # operator sets a per-bot value via the admin UI.
    op.add_column(
        "bots",
        sa.Column("relevance_threshold", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("bots", "relevance_threshold")
