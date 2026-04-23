"""Merge migration — unify the two heads branching from c3d4e5f6a7b8.

Two independent feature branches each created a migration with
`down_revision = "c3d4e5f6a7b8"` without realising the other existed:

  - 863170bc427c (add zcal_url + meeting_provider to bots)
  - d4e5f6a7b8c9 → e5f6a7b8c9d0 (lead_viewed_at + inline_cards_shown)

Running `alembic upgrade head` with two heads present fails with
"Multiple head revisions are present". This empty merge revision
reunifies the graph so future migrations chain cleanly from a single
head.

No schema change — merges are purely topological.

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0, 863170bc427c
Create Date: 2026-04-23
"""

revision = "f6a7b8c9d0e1"
down_revision = ("e5f6a7b8c9d0", "863170bc427c")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """No-op — this migration only unifies the two heads."""
    pass


def downgrade() -> None:
    """No-op — see upgrade()."""
    pass
