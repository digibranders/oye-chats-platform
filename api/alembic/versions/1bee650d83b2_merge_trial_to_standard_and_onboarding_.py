"""merge trial-to-standard and onboarding heads

Revision ID: 1bee650d83b2
Revises: c3f8a1d6e5b2, d9e2a4c7f108
Create Date: 2026-07-15 19:14:45.346035

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "1bee650d83b2"
down_revision: str | Sequence[str] | None = ("c3f8a1d6e5b2", "d9e2a4c7f108")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
