"""merge chat_session probe branch with pending_checkout branch

Revision ID: e8bf7678526d
Revises: f1a7c3d94e28, c2e8b41f07d9
Create Date: 2026-08-18 14:47:57.767010

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "e8bf7678526d"
down_revision: str | Sequence[str] | None = ("f1a7c3d94e28", "c2e8b41f07d9")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
