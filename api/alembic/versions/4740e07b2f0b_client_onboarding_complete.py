"""client onboarding_complete

Revision ID: 4740e07b2f0b
Revises: 597bbddd6562
Create Date: 2026-07-14 14:20:35.013562

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "4740e07b2f0b"
down_revision: str | Sequence[str] | None = "597bbddd6562"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "clients",
        sa.Column(
            "onboarding_complete",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("clients", "onboarding_complete")
