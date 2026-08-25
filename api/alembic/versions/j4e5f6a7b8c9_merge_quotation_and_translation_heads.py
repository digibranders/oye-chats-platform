"""merge quotation branch with multilingual translation branch

Revision ID: j4e5f6a7b8c9
Revises: d1b4f7a2c9e6, i3d4e5f6a7b8
Create Date: 2026-08-25 13:10:00.000000

Merging ``steve`` into ``development`` brought two independent migration
chains together and left the tree with two heads, which makes
``alembic upgrade head`` fail outright:

    d1b4f7a2c9e6  translation_columns   (multilingual, Phase 4)
    i3d4e5f6a7b8  quotation_state       (quotation catalogue)

The two chains touch disjoint tables, so there is nothing to reconcile in
the schema itself. This revision only rejoins them into a single head.
Empty on purpose: a merge revision that carries DDL hides that DDL from
whichever branch is reverted.
"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "j4e5f6a7b8c9"
down_revision: str | Sequence[str] | None = ("d1b4f7a2c9e6", "i3d4e5f6a7b8")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
