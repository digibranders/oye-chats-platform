"""merge operator_bot and widget_installed_at heads

Revision ID: 597bbddd6562
Revises: b1c7e9d3f2a5, b7d1e4a92c60
Create Date: 2026-07-14 12:18:50.830833

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "597bbddd6562"
down_revision: str | Sequence[str] | None = ("b1c7e9d3f2a5", "b7d1e4a92c60")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
