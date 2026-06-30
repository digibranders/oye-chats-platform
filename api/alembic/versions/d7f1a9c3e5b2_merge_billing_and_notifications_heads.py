"""merge heads c4d9e2f7a1b8 (billing remediation) + a1b2f9d0c4e8 (notifications)

The billing remediation chain (…→ b8e4d2f1a6c3 → c4d9e2f7a1b8) and the
notifications migration (a1b2f9d0c4e8) are independent branches off the shared
history. This empty merge unifies them so ``alembic upgrade head`` resolves a
single head. No schema change.

Revision ID: d7f1a9c3e5b2
Revises: c4d9e2f7a1b8, a1b2f9d0c4e8
Create Date: 2026-06-30 10:30:00.000000

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "d7f1a9c3e5b2"
down_revision: str | Sequence[str] | None = ("c4d9e2f7a1b8", "a1b2f9d0c4e8")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
