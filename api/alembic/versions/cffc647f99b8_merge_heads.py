"""merge heads

Revision ID: cffc647f99b8
Revises: 3424f908d31a, a1b2c3d4e5fa
Create Date: 2026-06-26 17:11:22.299363

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "cffc647f99b8"
down_revision: str | Sequence[str] | None = ("3424f908d31a", "a1b2c3d4e5fa")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
