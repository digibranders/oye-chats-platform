"""merge heads e7f8a9b0c1d2 + f02eb8bb0faf

Revision ID: d52e4e4c6723
Revises: e7f8a9b0c1d2, f02eb8bb0faf
Create Date: 2026-06-29 10:16:36.310120

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "d52e4e4c6723"
down_revision: str | Sequence[str] | None = ("e7f8a9b0c1d2", "f02eb8bb0faf")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
