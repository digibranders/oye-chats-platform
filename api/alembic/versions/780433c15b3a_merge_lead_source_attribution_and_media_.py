"""merge lead_source_attribution and media_card heads

Revision ID: 780433c15b3a
Revises: a7f3c2b1e0d9, b2c4d6e8f0a1
Create Date: 2026-07-10 14:23:19.218826

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "780433c15b3a"
down_revision: str | Sequence[str] | None = ("a7f3c2b1e0d9", "b2c4d6e8f0a1")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
