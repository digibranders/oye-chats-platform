"""merge operator_invites and seat_addon heads

Revision ID: f4a2b8e1c9d3
Revises: 8d6d4db6836a, e3c9a17f2b64
Create Date: 2026-07-13 00:00:00.000000

Empty merge revision — reconciles the two alembic heads that landed independently
on the ``steve`` and ``development`` branches:

- ``8d6d4db6836a`` — operator invites linked client_id (steve)
- ``e3c9a17f2b64`` — seat addon pending quantity (development)

No schema changes; this exists solely so ``alembic upgrade head`` has a single
target after the merge.
"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "f4a2b8e1c9d3"
down_revision: str | Sequence[str] | None = ("8d6d4db6836a", "e3c9a17f2b64")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
